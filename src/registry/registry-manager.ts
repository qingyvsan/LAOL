import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { RegistryDataSchema } from "../data/schemas";
import type { RegistryData, RegistryEntry } from "../data/models";

/**
 * Registry Manager — semantic change tracking.
 *
 * Maintains .multiagent/registry.json, which records per-module
 * export signatures and modification history. This enables the
 * scheduler to detect semantically-coupled conflicts (e.g.,
 * Agent A changed an export that Agent B depends on).
 */

export class RegistryManager {
  private registryPath: string;
  private warningsDir: string;

  constructor(repoRoot: string) {
    this.registryPath = path.join(repoRoot, ".multiagent", "registry.json");
    this.warningsDir = path.join(repoRoot, ".multiagent", "warnings");
  }

  /**
   * Update the registry entry for a file after modification.
   * Computes the file's content hash and records the agent.
   */
  updateEntry(
    filePath: string,
    agentId: string,
    absoluteFilePath?: string
  ): void {
    const registry = this.loadRegistry();

    // Compute hash
    const hash = absoluteFilePath
      ? this.computeFileHash(absoluteFilePath)
      : `modified-${Date.now()}`; // fallback if no absolute path

    // Extract the module root (directory) as the key
    const moduleKey = path.dirname(filePath) + "/" + path.basename(filePath, path.extname(filePath));

    registry[filePath] = {
      exports: [], // Will be populated by symbol resolver (Phase 6.2)
      hash,
      modified_by: agentId,
      updated_at: Date.now(),
    };

    this.saveRegistry(registry);
  }

  /**
   * Get recently changed entries within a module directory.
   * Returns entries updated within the given time window (ms).
   */
  getRecentChanges(moduleDir: string, timeWindowMs = 300_000): RegistryEntry[] {
    const registry = this.loadRegistry();
    const now = Date.now();
    const results: RegistryEntry[] = [];

    for (const [filePath, entry] of Object.entries(registry)) {
      if (path.dirname(filePath).startsWith(moduleDir)) {
        if (now - entry.updated_at <= timeWindowMs) {
          results.push(entry);
        }
      }
    }

    return results;
  }

  /**
   * Get the registry entry for a specific file.
   */
  getEntry(filePath: string): RegistryEntry | null {
    const registry = this.loadRegistry();
    return registry[filePath] ?? null;
  }

  /**
   * Check if a module has recent changes that a dependent task should know about.
   * Returns true and generates a warning file if changes are found.
   */
  checkAndWarn(
    taskId: string,
    targetFiles: string[],
    timeWindowMs = 300_000
  ): string | null {
    const warnings: string[] = [];

    for (const file of targetFiles) {
      const moduleDir = path.dirname(file);
      const recent = this.getRecentChanges(moduleDir, timeWindowMs);

      if (recent.length > 0) {
        for (const entry of recent) {
          warnings.push(
            `Module "${moduleDir}" was modified by agent "${entry.modified_by}" ` +
            `at ${new Date(entry.updated_at).toISOString()}. ` +
            `Check exports for breaking changes before proceeding.`
          );
        }
      }
    }

    if (warnings.length === 0) return null;

    // Deduplicate warnings
    const unique = [...new Set(warnings)];

    // Write warnings file
    this.writeWarning(taskId, unique);

    return unique.join("\n");
  }

  /**
   * Write a warning markdown file for a task.
   */
  writeWarning(taskId: string, warnings: string[]): void {
    if (!fs.existsSync(this.warningsDir)) {
      fs.mkdirSync(this.warningsDir, { recursive: true });
    }

    const content = [
      `# Semantic Warnings for Task ${taskId}`,
      "",
      "The following modules have been recently modified by other agents.",
      "Review these changes before proceeding to avoid logical conflicts.",
      "",
      ...warnings.map((w) => `- ${w}`),
    ].join("\n");

    fs.writeFileSync(
      path.join(this.warningsDir, `${taskId}.md`),
      content,
      "utf-8"
    );
  }

  /**
   * Delete the warning file for a task (after it's been consumed).
   */
  clearWarning(taskId: string): void {
    const warningPath = path.join(this.warningsDir, `${taskId}.md`);
    if (fs.existsSync(warningPath)) {
      fs.unlinkSync(warningPath);
    }
  }

  /**
   * Clear all registry data (for testing/reset).
   */
  clear(): void {
    this.saveRegistry({});
  }

  // ---- Internal ----

  private loadRegistry(): RegistryData {
    if (!fs.existsSync(this.registryPath)) {
      return {};
    }

    try {
      const raw = JSON.parse(fs.readFileSync(this.registryPath, "utf-8"));
      return RegistryDataSchema.parse(raw) as RegistryData;
    } catch {
      return {};
    }
  }

  private saveRegistry(data: RegistryData): void {
    const dir = path.dirname(this.registryPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(this.registryPath, JSON.stringify(data, null, 2), "utf-8");
  }

  private computeFileHash(filePath: string): string {
    if (!fs.existsSync(filePath)) return "file-not-found";

    try {
      const content = fs.readFileSync(filePath);
      return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
    } catch {
      return "hash-error";
    }
  }
}
