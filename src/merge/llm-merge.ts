import * as crypto from "node:crypto";
import type { ConflictBlock, MergeAttempt } from "../data/models";

/**
 * LLM Merge — Level 3 semantic merge for same-function conflicts.
 *
 * When two agents change the SAME function, we delegate to an LLM
 * for semantic analysis. The LLM understands the intent behind
 * both changes and produces a merged result.
 *
 * Strategy (per v3.0 optimization 5):
 *   - Same function conflict → ALWAYS use LLM (no heuristics first)
 *   - If LLM can't resolve → return UNRESOLVABLE marker → human intervention
 *   - Optional Quorum mode (P3): call two different models, compare results
 */

// LRU result cache
interface CacheEntry {
  result: MergeAttempt;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const DEFAULT_CACHE_SIZE = 100;
const DEFAULT_CACHE_TTL_MS = 300_000; // 5 minutes

let maxCacheSize = DEFAULT_CACHE_SIZE;
let cacheTtlMs = DEFAULT_CACHE_TTL_MS;

/**
 * Resolve a same-function conflict using LLM semantic analysis.
 *
 * @param block - The conflict block to resolve
 * @param provider - LLM provider function (abstracted for testability)
 * @param options - Merge options
 */
export async function resolve(
  block: ConflictBlock,
  provider: LLMProvider,
  options?: {
    quorum?: boolean;
    secondaryProvider?: LLMProvider;
    cacheSize?: number;
    cacheTtl?: number;
  }
): Promise<MergeAttempt> {
  // Update cache settings
  if (options?.cacheSize) maxCacheSize = options.cacheSize;
  if (options?.cacheTtl) cacheTtlMs = options.cacheTtl;

  // Check cache
  const cacheKey = computeCacheKey(block);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < cacheTtlMs) {
    return cached.result;
  }

  // Build the merge prompt
  const prompt = buildMergePrompt(block);

  // Primary LLM call
  const primaryResult = await provider.call(prompt);
  const resolution = parseLLMResponse(primaryResult);

  // Quorum mode: call a second model and compare
  if (options?.quorum && options?.secondaryProvider) {
    const secondaryResult = await options.secondaryProvider.call(prompt);
    const secondaryResolution = parseLLMResponse(secondaryResult);

    if (!resolution.startsWith("<<<UNRESOLVABLE>>>") &&
        !secondaryResolution.startsWith("<<<UNRESOLVABLE>>>")) {
      const normalizedPrimary = normalize(resolution);
      const normalizedSecondary = normalize(secondaryResolution);

      if (normalizedPrimary !== normalizedSecondary) {
        // Quorum mismatch — use primary result but include diff note
        const attempt: MergeAttempt = {
          resolved: true,
          method: "llm",
          resolvedCode: resolution,
          quorumDiff: generateDiffNote(resolution, secondaryResolution),
        };
        cache.set(cacheKey, { result: attempt, timestamp: Date.now() });
        evictCache();
        return attempt;
      }
    }
  }

  // Handle unresolvable
  if (resolution.startsWith("<<<UNRESOLVABLE>>>")) {
    return { resolved: false, method: "unresolved" };
  }

  const attempt: MergeAttempt = {
    resolved: true,
    method: "llm",
    resolvedCode: resolution,
  };

  // Cache the result
  cache.set(cacheKey, { result: attempt, timestamp: Date.now() });
  evictCache();

  return attempt;
}

/**
 * LLM provider interface — to be implemented by API callers.
 */
export interface LLMProvider {
  call(prompt: string): Promise<string>;
}

/**
 * Build the merge prompt for the LLM.
 */
function buildMergePrompt(block: ConflictBlock): string {
  return [
    "You are a code merge expert. The following conflict occurs within the SAME FUNCTION.",
    "Your task is to understand both modifications and produce a merged result.",
    "",
    "=== BASE (original code, before either modification) ===",
    block.base || "(base version not available)",
    "",
    "=== OURS (our modification) ===",
    block.ours,
    "",
    "=== THEIRS (their modification) ===",
    block.theirs,
    "",
    "Rules:",
    "1. Understand the INTENT behind both changes",
    "2. If both changes are functionally independent: MERGE both into the final code",
    "3. If the changes are logically contradictory: keep the MORE CORRECT/SAFER version",
    "4. If you truly cannot decide which is correct: output EXACTLY <<<UNRESOLVABLE>>>",
    "",
    "IMPORTANT: Output ONLY the resolved code. No explanations, no markdown fences.",
    "The output will be written directly into the source file.",
  ].join("\n");
}

/**
 * Parse the LLM's response, extracting the code.
 */
function parseLLMResponse(response: string): string {
  const trimmed = response.trim();

  // Check for unresolvable marker
  if (trimmed.includes("<<<UNRESOLVABLE>>>")) {
    return "<<<UNRESOLVABLE>>>";
  }

  // Strip markdown code fences if present
  if (trimmed.startsWith("```")) {
    const lines = trimmed.split("\n");
    // Remove first line (```language) and last line (```)
    if (lines.length >= 3) {
      return lines.slice(1, -1).join("\n").trim();
    }
  }

  return trimmed;
}

/**
 * Normalize code for comparison (strip whitespace, normalize indentation).
 */
function normalize(code: string): string {
  return code
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Generate a human-readable diff note when quorum results differ.
 */
function generateDiffNote(primary: string, secondary: string): string {
  const primaryLines = primary.split("\n");
  const secondaryLines = secondary.split("\n");

  let diffNote = "[QUORUM DIFF] Primary and secondary models produced different results:\n";
  diffNote += `Primary (${primaryLines.length} lines) vs Secondary (${secondaryLines.length} lines)\n`;

  // Simple line-by-line comparison
  const maxLen = Math.max(primaryLines.length, secondaryLines.length);
  let differences = 0;
  for (let i = 0; i < maxLen; i++) {
    if (primaryLines[i]?.trim() !== secondaryLines[i]?.trim()) {
      differences++;
    }
  }
  diffNote += `${differences} lines differ. Primary result used. Review recommended.`;

  return diffNote;
}

/**
 * Compute a cache key from a conflict block.
 */
function computeCacheKey(block: ConflictBlock): string {
  const combined = block.base + "|||" + block.ours + "|||" + block.theirs;
  return crypto.createHash("sha256").update(combined).digest("hex").slice(0, 16);
}

/**
 * Evict oldest entries when cache exceeds max size.
 */
function evictCache(): void {
  if (cache.size <= maxCacheSize) return;

  const entries = Array.from(cache.entries()).sort(
    (a, b) => a[1].timestamp - b[1].timestamp
  );

  const toDelete = entries.slice(0, entries.length - maxCacheSize);
  for (const [key] of toDelete) {
    cache.delete(key);
  }
}

/**
 * Clear the merge cache (for testing).
 */
export function clearCache(): void {
  cache.clear();
}
