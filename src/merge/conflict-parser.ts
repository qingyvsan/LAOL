import type { ConflictBlock } from "../data/models";

/**
 * Conflict Parser — parses git conflict markers into structured data.
 *
 * Input: a file content string with git conflict markers:
 *   <<<<<<< ours
 *   ... our code ...
 *   =======
 *   ... their code ...
 *   >>>>>>> theirs
 *
 * Output: array of ConflictBlock with extracted ranges.
 */

const OURS_MARKER = /^<{7} .+$/m;
const SEPARATOR = /^={7}$/m;
const THEIRS_MARKER = /^>{7} .+$/m;

export function parseConflictBlocks(fileContent: string): ConflictBlock[] {
  const lines = fileContent.split("\n");
  const blocks: ConflictBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    // Look for the start of a conflict block
    if (OURS_MARKER.test(lines[i])) {
      const oursStart = i + 1;
      const oursLines: string[] = [];
      const theirsLines: string[] = [];
      const baseLines: string[] = [];

      i++;

      // Collect "ours" lines until separator
      while (i < lines.length && !SEPARATOR.test(lines[i])) {
        oursLines.push(lines[i]);
        i++;
      }

      if (i >= lines.length) break;
      i++; // skip separator

      // Collect "theirs" lines until end marker
      while (i < lines.length && !THEIRS_MARKER.test(lines[i])) {
        theirsLines.push(lines[i]);
        i++;
      }

      if (i >= lines.length) break;
      i++; // skip end marker

      blocks.push({
        ours: oursLines.join("\n"),
        theirs: theirsLines.join("\n"),
        base: "", // git merge-file doesn't provide base in diff3 by default
        oursRange: [oursStart, oursStart + oursLines.length],
        theirsRange: [oursStart + oursLines.length + 1, oursStart + oursLines.length + 1 + theirsLines.length],
      });
    } else {
      i++;
    }
  }

  return blocks;
}

/**
 * Rebuild a file from resolved conflict blocks.
 * Takes the original file content and applies resolutions.
 */
export function rebuildFile(originalContent: string, resolutions: Map<number, string>): string {
  const lines = originalContent.split("\n");
  const output: string[] = [];

  let i = 0;
  let blockIndex = 0;

  while (i < lines.length) {
    if (OURS_MARKER.test(lines[i])) {
      // This is a conflict block — use resolution if available
      const resolution = resolutions.get(blockIndex);
      if (resolution !== undefined) {
        output.push(resolution);
        blockIndex++;
      }

      // Skip to end of conflict block
      while (i < lines.length && !THEIRS_MARKER.test(lines[i])) {
        i++;
      }
      i++; // skip end marker
    } else {
      output.push(lines[i]);
      i++;
    }
  }

  return output.join("\n");
}

/**
 * Check if a file has any unresolved conflict markers.
 */
export function hasConflictMarkers(content: string): boolean {
  return OURS_MARKER.test(content) || THEIRS_MARKER.test(content);
}
