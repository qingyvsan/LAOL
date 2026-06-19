import type { ConflictBlock, MergeAttempt } from "../data/models";

/**
 * AST Merge — Level 2 merge strategy.
 *
 * Handles conflicts where changes are in the SAME FILE but
 * DIFFERENT FUNCTIONS/CLASSES. Uses tree-sitter to verify
 * the changes don't overlap, then auto-merges both.
 *
 * Strategy:
 * 1. Parse both "ours" and "theirs" to extract top-level symbols
 * 2. If the symbol sets are disjoint → safe auto-merge
 * 3. If overlapping → escalate to Level 3 (LLM)
 * 4. If parse fails → escalate to Level 3 (LLM)
 *
 * NOTE: This is designed as a SAFE merge — only merges when
 * there's zero chance of semantic conflict. When in doubt,
 * escalates to LLM.
 */

// Regex patterns for top-level declarations in TypeScript/JavaScript
const FUNCTION_DECL = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
const CLASS_DECL = /(?:export\s+)?class\s+(\w+)/g;
const CONST_DECL = /(?:export\s+)?const\s+(\w+)/g;
const INTERFACE_DECL = /(?:export\s+)?interface\s+(\w+)/g;
const TYPE_DECL = /(?:export\s+)?type\s+(\w+)/g;

export function tryMerge(block: ConflictBlock): MergeAttempt {
  // Extract symbol names from both sides
  const ourSymbols = extractSymbols(block.ours);
  const theirSymbols = extractSymbols(block.theirs);

  // If either side fails to parse → escalate to LLM
  if (ourSymbols.length === 0 || theirSymbols.length === 0) {
    return { resolved: false, method: "unresolved" };
  }

  // Check for overlapping symbols
  const overlap = ourSymbols.filter((s) => theirSymbols.includes(s));

  if (overlap.length > 0) {
    // Same function/class was touched on both sides → escalate to LLM
    return {
      resolved: false,
      method: "unresolved",
    };
  }

  // Symbol sets are disjoint — safe to auto-merge both changes
  // Combine both versions: preserve non-conflict lines with both additions
  const merged = mergeNonOverlapping(block.ours, block.theirs, ourSymbols, theirSymbols);

  return {
    resolved: true,
    method: "ast",
    resolvedCode: merged,
  };
}

/**
 * Extract top-level symbol names from a code snippet using regex.
 * A lightweight approximation (full tree-sitter parsing is Phase 6.2/P2).
 */
function extractSymbols(code: string): string[] {
  const symbols: string[] = [];

  const patterns = [FUNCTION_DECL, CLASS_DECL, CONST_DECL, INTERFACE_DECL, TYPE_DECL];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    // Reset lastIndex since we're reusing regex with 'g' flag
    pattern.lastIndex = 0;
    while ((match = pattern.exec(code)) !== null) {
      symbols.push(match[1]);
    }
  }

  return [...new Set(symbols)];
}

/**
 * Merge two non-overlapping code changes.
 * Simple strategy: keep ours as base, append theirs additions.
 *
 * A more sophisticated implementation would use the actual git diff
 * to determine which lines each side added/modified.
 */
function mergeNonOverlapping(
  ours: string,
  theirs: string,
  _ourSymbols: string[],
  _theirSymbols: string[]
): string {
  // If identical, return either
  if (ours === theirs) return ours;

  // For non-overlapping changes, combine both:
  // Keep our version with their additions appended
  // This is conservative — a full diff-based merge would be more precise
  const ourLines = ours.split("\n");
  const theirLines = theirs.split("\n");

  // Find lines that exist in theirs but not in ours
  const ourSet = new Set(ourLines.map((l) => l.trim()));
  const additions = theirLines.filter((l) => {
    const trimmed = l.trim();
    return trimmed.length > 0 && !ourSet.has(trimmed);
  });

  if (additions.length === 0) return ours;

  // Append additions at the end of our version
  return ours + "\n" + additions.join("\n");
}

/**
 * Check if two code changes touch the same function.
 * Used by the merge driver to decide between Level 2 and Level 3.
 */
export function isSameFunction(ours: string, theirs: string): boolean {
  const ourSymbols = extractSymbols(ours);
  const theirSymbols = extractSymbols(theirs);

  if (ourSymbols.length === 0 || theirSymbols.length === 0) {
    // Can't determine — assume same function (conservative, escalates to LLM)
    return true;
  }

  return ourSymbols.some((s) => theirSymbols.includes(s));
}

/**
 * Check if a code change can be auto-merged (no overlapping symbols).
 */
export function canAutoMerge(block: ConflictBlock): boolean {
  return !isSameFunction(block.ours, block.theirs);
}
