import { describe, it, expect } from "vitest";
import {
  parseConflictBlocks,
  rebuildFile,
  hasConflictMarkers,
} from "../merge/conflict-parser";

describe("Conflict Parser", () => {
  it("parses a single conflict block", () => {
    const content = [
      "function unchanged() { return 1; }",
      "<<<<<<< ours",
      "function login() { return 'new'; }",
      "=======",
      "function login() { return 'old'; }",
      ">>>>>>> theirs",
      "function after() {}",
    ].join("\n");

    const blocks = parseConflictBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].ours).toContain("return 'new'");
    expect(blocks[0].theirs).toContain("return 'old'");
  });

  it("parses multiple conflict blocks", () => {
    const content = [
      "<<<<<<< ours",
      "const a = 1;",
      "=======",
      "const a = 2;",
      ">>>>>>> theirs",
      "middle code",
      "<<<<<<< ours",
      "const b = 3;",
      "=======",
      "const b = 4;",
      ">>>>>>> theirs",
    ].join("\n");

    const blocks = parseConflictBlocks(content);
    expect(blocks).toHaveLength(2);
  });

  it("returns empty array for clean content", () => {
    const blocks = parseConflictBlocks("clean code without conflicts");
    expect(blocks).toHaveLength(0);
  });

  it("rebuilds file from resolutions", () => {
    const content = [
      "line 1",
      "<<<<<<< ours",
      "ours line",
      "=======",
      "theirs line",
      ">>>>>>> theirs",
      "line 3",
    ].join("\n");

    const resolutions = new Map<number, string>();
    resolutions.set(0, "resolved line");

    const rebuilt = rebuildFile(content, resolutions);
    expect(rebuilt).toContain("line 1");
    expect(rebuilt).toContain("resolved line");
    expect(rebuilt).toContain("line 3");
    expect(rebuilt).not.toContain("<<<<<<<");
    expect(rebuilt).not.toContain(">>>>>>>");
  });

  it("detects unresolved conflict markers", () => {
    expect(hasConflictMarkers("<<<<<<< ours\ncode\n=======\n>>>>>>> theirs")).toBe(true);
    expect(hasConflictMarkers("clean code")).toBe(false);
  });
});

describe("AST Merge", () => {
  it("identifies same-function changes", async () => {
    const { isSameFunction } = await import("../merge/ast-merge");

    const ours = "function login() { return 'new'; }";
    const theirs = "function login() { return 'updated'; }";
    expect(isSameFunction(ours, theirs)).toBe(true);
  });

  it("identifies different-function changes", async () => {
    const { isSameFunction } = await import("../merge/ast-merge");

    const ours = "function login() { return 'new'; }";
    const theirs = "function logout() { return 'updated'; }";
    expect(isSameFunction(ours, theirs)).toBe(false);
  });
});
