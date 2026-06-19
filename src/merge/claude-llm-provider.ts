import { execSync } from "node:child_process";
import type { LLMProvider } from "./llm-merge";

const SHELL = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";

/**
 * ClaudeLLMProvider — calls `claude -p` for LLM semantic merge.
 *
 * Uses the same Claude CLI invocation pattern as ClaudeCodeExecutor
 * (non-interactive mode), producing a merged code block from the
 * three-way conflict prompt.
 */
export class ClaudeLLMProvider implements LLMProvider {
  private model: string;
  private timeoutMs: number;

  constructor(params?: { model?: string; timeoutMs?: number }) {
    this.model = params?.model ?? "claude-sonnet-4-6";
    this.timeoutMs = params?.timeoutMs ?? 60_000;
  }

  async call(prompt: string): Promise<string> {
    try {
      return execSync(
        `claude -p --model "${this.model}" --output-format text --no-show-model-card`,
        {
          input: prompt,
          stdio: "pipe",
          timeout: this.timeoutMs,
          maxBuffer: 100 * 1024, // 100 KB
          shell: SHELL,
          encoding: "utf-8",
          env: { ...process.env, NO_COLOR: "1" },
        }
      ).trim();
    } catch (err: unknown) {
      // If the subprocess fails, return the marker so the merge pipeline
      // treats it as unresolvable and surfaces it for human intervention.
      const maybeExecErr = err as { stderr?: unknown };
      const stderr =
        err instanceof Error && typeof maybeExecErr.stderr === "string"
          ? maybeExecErr.stderr
          : "";
      if (stderr) {
        console.error(`[ClaudeLLMProvider] claude -p failed: ${stderr.slice(0, 500)}`);
      }
      return "<<<UNRESOLVABLE>>>";
    }
  }
}
