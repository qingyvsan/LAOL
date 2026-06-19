import * as fs from "node:fs";
import * as path from "node:path";
import { watch, FSWatcher } from "chokidar";
import type { Lock } from "../data/models";

/**
 * Perception — the agent's "eyes and ears" on the rest of the system.
 *
 * Two mechanisms:
 * 1. Passive (chokidar on locks/): detects new/removed locks in the
 *    same module directory as the agent's target files.
 *
 * 2. Active (warnings file): before each LLM call, checks if
 *    .multiagent/warnings/{taskId}.md exists. If yes, reads it and
 *    returns the content for injection into the system prompt.
 *    The warning file is deleted after consumption.
 */

export interface PerceptionWarning {
  message: string;
  severity: "info" | "warning" | "critical";
}

export class Perception {
  private repoRoot: string;
  private taskId: string;
  private targetFiles: string[];
  private watcher: FSWatcher | null = null;

  // Callbacks
  private onWarning: ((warning: PerceptionWarning) => void) | null = null;

  constructor(
    repoRoot: string,
    taskId: string,
    targetFiles: string[]
  ) {
    this.repoRoot = repoRoot;
    this.taskId = taskId;
    this.targetFiles = targetFiles;
  }

  /**
   * Register a callback for perception warnings.
   */
  setOnWarning(cb: (warning: PerceptionWarning) => void): void {
    this.onWarning = cb;
  }

  /**
   * Start watching the locks/ directory for relevant changes.
   */
  start(): FSWatcher {
    if (this.watcher) return this.watcher;

    const locksDir = path.join(this.repoRoot, ".multiagent", "locks");

    this.watcher = watch(locksDir, {
      ignored: /(^|[\/\\])\../,
      persistent: true,
      ignoreInitial: true,
    });

    // Get the set of module directories our target files are in
    const ourModules = new Set(
      this.targetFiles.map((f) => path.dirname(f))
    );

    this.watcher.on("add", (lockPath: string) => {
      const lockName = path.basename(lockPath, ".lock");
      // Desanitize: "src#auth.ts" → "src/auth.ts"
      const filePath = lockName.replace(/#/g, "/");

      // Check if this lock is for a file in one of our modules
      const lockModule = path.dirname(filePath);

      if (ourModules.has(lockModule) && !this.targetFiles.includes(filePath)) {
        // A file in our module directory is being modified by someone else
        if (this.onWarning) {
          this.onWarning({
            message: `Another agent is now modifying "${filePath}" in your module directory "${lockModule}". Watch for conflicts.`,
            severity: "warning",
          });
        }
      }
    });

    this.watcher.on("error", (err: Error) => {
      console.error(`[perception] Watch error: ${err.message}`);
    });

    return this.watcher;
  }

  /**
   * Stop watching.
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Check for and consume the semantic warning file for this task.
   * Called before each LLM call. Returns the warning content if any,
   * and deletes the file after reading (single consumption).
   */
  checkWarnings(): string | null {
    const warningPath = path.join(
      this.repoRoot,
      ".multiagent",
      "warnings",
      `${this.taskId}.md`
    );

    if (!fs.existsSync(warningPath)) return null;

    try {
      const content = fs.readFileSync(warningPath, "utf-8");
      // Consume the warning (delete after reading)
      fs.unlinkSync(warningPath);
      return content;
    } catch {
      return null;
    }
  }

  /**
   * Get the current lock landscape for context injection.
   * Returns a human-readable summary of active locks in relevant modules.
   */
  getContextSummary(): string {
    const locksDir = path.join(this.repoRoot, ".multiagent", "locks");

    if (!fs.existsSync(locksDir)) return "";

    const ourModules = new Set(
      this.targetFiles.map((f) => path.dirname(f))
    );

    const relevantLocks: { file: string; holder: string }[] = [];

    try {
      const lockFiles = fs.readdirSync(locksDir).filter((f) => f.endsWith(".lock"));

      for (const lf of lockFiles) {
        const desanitized = lf.replace(".lock", "").replace(/#/g, "/");
        const lockModule = path.dirname(desanitized);

        if (ourModules.has(lockModule)) {
          try {
            const raw = JSON.parse(
              fs.readFileSync(path.join(locksDir, lf), "utf-8")
            );
            relevantLocks.push({
              file: raw.file ?? desanitized,
              holder: raw.holder ?? "unknown",
            });
          } catch {
            // Skip malformed lock files
          }
        }
      }
    } catch {
      // Can't read locks
    }

    if (relevantLocks.length === 0) return "";

    const lines = relevantLocks.map(
      (l) => `  - ${l.file} (held by ${l.holder})`
    );

    return `\n[LAOL Perception] Active locks in your modules:\n${lines.join("\n")}\n`;
  }
}
