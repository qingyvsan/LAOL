import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { parseConflictBlocks, rebuildFile, hasConflictMarkers } from "./conflict-parser";
import { tryMerge as astTryMerge, isSameFunction } from "./ast-merge";
import { resolve as llmResolve } from "./llm-merge";
import type { LLMProvider } from "./llm-merge";
import { SandboxValidator } from "./sandbox-validator";
import type { ConflictBlock, MergeAttempt, ValidationResult, MergeCheck } from "../data/models";

/**
 * Merge Driver — three-level semantic merge pipeline.
 *
 * Orchestrates the complete merge flow:
 *
 *   Level 1: No git conflicts → auto-merge (pass through)
 *   Level 2: Different functions touched → AST-verified auto-merge
 *   Level 3: Same function touched → LLM semantic merge
 *
 * Post-merge: Sandbox CI validation before pushing to main.
 */

export class MergeDriver {
  private worktreePath: string;
  private llmProvider: LLMProvider;
  private quorumProvider: LLMProvider | null;
  private sandboxValidator: SandboxValidator;
  private mergeChecks: MergeCheck[];

  constructor(params: {
    worktreePath: string;
    llmProvider: LLMProvider;
    quorumProvider?: LLMProvider;
    mergeChecks?: MergeCheck[];
  }) {
    this.worktreePath = params.worktreePath;
    this.llmProvider = params.llmProvider;
    this.quorumProvider = params.quorumProvider ?? null;
    this.sandboxValidator = new SandboxValidator();
    this.mergeChecks = params.mergeChecks ?? [];
  }

  /**
   * Merge an agent's branch into the base branch.
   *
   * @param baseBranch - Target branch (e.g. "main")
   * @param agentBranch - Agent's branch (e.g. "agent/uuid")
   * @returns Merge result with details about each conflict's resolution
   */
  async merge(
    baseBranch: string,
    agentBranch: string
  ): Promise<MergeResult> {
    const resolutions: BlockResolution[] = [];

    // 1. Fetch latest
    try {
      execSync(`git fetch origin ${baseBranch}`, {
        cwd: this.worktreePath,
        stdio: "pipe",
        timeout: 15_000,
      });
    } catch {
      // Use local branch
    }

    // 2. Checkout base branch and merge agent branch
    try {
      execSync(`git checkout ${baseBranch}`, {
        cwd: this.worktreePath,
        stdio: "pipe",
        timeout: 10_000,
      });
    } catch {
      execSync(`git checkout -b ${baseBranch}`, {
        cwd: this.worktreePath,
        stdio: "pipe",
        timeout: 10_000,
      });
    }

    // 3. Attempt git merge
    let mergeSucceeded = false;
    try {
      execSync(`git merge --no-ff ${agentBranch}`, {
        cwd: this.worktreePath,
        stdio: "pipe",
        timeout: 15_000,
      });
      mergeSucceeded = true;
    } catch {
      // Merge had conflicts — we'll resolve them
    }

    // 4. If no conflicts, done
    if (mergeSucceeded) {
      // Still run sandbox validation
      const validation = this.sandboxValidator.validate(this.worktreePath, this.mergeChecks);
      return {
        success: validation.passed,
        method: "auto",
        resolutions: [],
        validation,
      };
    }

    // 5. Find conflicted files
    const conflictedFiles = this.getConflictedFiles();

    // 6. Resolve each conflicted file
    for (const file of conflictedFiles) {
      const filePath = path.join(this.worktreePath, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const blocks = parseConflictBlocks(content);

      const fileResolutions = new Map<number, string>();

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        let resolution: MergeAttempt;

        // Level 2: Different functions → AST auto-merge
        if (!isSameFunction(block.ours, block.theirs)) {
          resolution = astTryMerge(block);
        } else {
          // Level 3: Same function → LLM semantic merge
          resolution = await llmResolve(block, this.llmProvider, {
            quorum: this.quorumProvider !== null,
            secondaryProvider: this.quorumProvider ?? undefined,
          });
        }

        if (resolution.resolved && resolution.resolvedCode) {
          fileResolutions.set(i, resolution.resolvedCode);
        }

        resolutions.push({
          file,
          blockIndex: i,
          method: resolution.method,
          resolved: resolution.resolved,
          quorumDiff: resolution.quorumDiff,
        });
      }

      // Write resolved file
      if (fileResolutions.size > 0) {
        const resolvedContent = rebuildFile(content, fileResolutions);
        fs.writeFileSync(filePath, resolvedContent, "utf-8");
      }
    }

    // 7. Stage resolved files
    try {
      execSync("git add -A", {
        cwd: this.worktreePath,
        stdio: "pipe",
        timeout: 10_000,
      });
    } catch {
      // Continue
    }

    // 8. Check for remaining conflict markers
    const stillConflicted = conflictedFiles.some((f) => {
      const filePath = path.join(this.worktreePath, f);
      return fs.existsSync(filePath) && hasConflictMarkers(fs.readFileSync(filePath, "utf-8"));
    });

    if (stillConflicted) {
      return {
        success: false,
        method: "llm",
        resolutions,
        validation: {
          passed: false,
          message: "Unresolved conflicts remain after LLM merge — human intervention required",
        },
        error: "Some conflicts could not be resolved by the LLM. Manual merge required.",
      };
    }

    // 9. Run sandbox validation
    const validation = this.sandboxValidator.validate(this.worktreePath, this.mergeChecks);

    if (!validation.passed) {
      // Revert the merge
      try {
        execSync("git merge --abort", {
          cwd: this.worktreePath,
          stdio: "pipe",
          timeout: 10_000,
        });
      } catch {
        // Can't abort — leave for manual cleanup
      }

      return {
        success: false,
        method: "llm",
        resolutions,
        validation,
        error: validation.message,
      };
    }

    // 10. Complete the merge
    try {
      execSync('git commit -m "Merge: AI semantic merge of agent branch"', {
        cwd: this.worktreePath,
        stdio: "pipe",
        timeout: 10_000,
      });
    } catch {
      // May already have committed
    }

    return {
      success: true,
      method: "llm",
      resolutions,
      validation,
    };
  }

  /**
   * Get list of files with merge conflicts in the worktree.
   */
  private getConflictedFiles(): string[] {
    try {
      const output = execSync("git diff --name-only --diff-filter=U", {
        cwd: this.worktreePath,
        stdio: "pipe",
        timeout: 5000,
      }).toString("utf-8").trim();

      return output ? output.split("\n") : [];
    } catch {
      return [];
    }
  }
}

// ---- Result types ----

export interface BlockResolution {
  file: string;
  blockIndex: number;
  method: "auto" | "ast" | "llm" | "unresolved";
  resolved: boolean;
  quorumDiff?: string;
}

export interface MergeResult {
  success: boolean;
  method: "auto" | "llm";
  resolutions: BlockResolution[];
  validation: ValidationResult;
  error?: string;
}
