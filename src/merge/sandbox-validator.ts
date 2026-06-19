import { execSync } from "node:child_process";
import * as process from "node:process";
import type { MergeCheck, ValidationResult } from "../data/models";

const SHELL = process.platform === "win32"
  ? process.env.ComSpec ?? "cmd.exe"
  : process.env.SHELL ?? "/bin/sh";

/**
 * Sandbox Validator — pre-merge CI gate.
 *
 * Before pushing merged code to main, run configured validation
 * checks (type-check, lint, test, build) in the worktree.
 *
 * Any failure → merge is rejected with diagnostic output.
 */

export class SandboxValidator {
  /**
   * Run all configured merge checks against a worktree.
   *
   * @param worktreePath - Path to the worktree with merged code
   * @param checks - Array of checks from config.json
   * @returns ValidationResult with pass/fail and diagnostic info
   */
  validate(worktreePath: string, checks: MergeCheck[]): ValidationResult {
    if (checks.length === 0) {
      return { passed: true, message: "No checks configured" };
    }

    for (const check of checks) {
      console.log(`[validator] Running: ${check.name} (${check.cmd})`);

      try {
        const result = execSync(check.cmd, {
          cwd: worktreePath,
          stdio: "pipe",
          timeout: check.timeout * 1000,
          shell: SHELL,
          encoding: "utf-8",
        }).toString();

        // Check passed
        console.log(`[validator] ✓ ${check.name} passed`);
      } catch (err) {
        const stderr = (err as { stderr?: Buffer })?.stderr?.toString("utf-8") ?? "";
        const stdout = (err as { stdout?: Buffer })?.stdout?.toString("utf-8") ?? "";
        const message = (err as { message?: string })?.message ?? "Unknown error";

        console.log(`[validator] ✗ ${check.name} FAILED`);

        return {
          passed: false,
          failed_check: check.name,
          stdout: stdout.slice(0, 2000),
          stderr: stderr.slice(0, 2000),
          message: [
            `[MERGE REJECTED] Merge result failed "${check.name}" check.`,
            "",
            `Command: ${check.cmd}`,
            "",
            "Error:",
            message,
            "",
            stderr ? `Stderr:\n${stderr.slice(0, 1000)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        };
      }
    }

    return {
      passed: true,
      message: `All ${checks.length} checks passed`,
    };
  }

  /**
   * Run a single check and return the result.
   */
  runCheck(worktreePath: string, check: MergeCheck): {
    passed: boolean;
    stdout: string;
    stderr: string;
  } {
    try {
      const stdout = execSync(check.cmd, {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: check.timeout * 1000,
        shell: SHELL,
        encoding: "utf-8",
      }).toString();

      return { passed: true, stdout, stderr: "" };
    } catch (err) {
      const stderr = (err as { stderr?: Buffer })?.stderr?.toString("utf-8") ?? "";
      const stdout = (err as { stdout?: Buffer })?.stdout?.toString("utf-8") ?? "";

      return { passed: false, stdout, stderr };
    }
  }
}
