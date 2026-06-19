import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { v4 as uuidv4 } from "uuid";
import { SandboxValidator } from "../merge/sandbox-validator";
import { tryMerge, isSameFunction, canAutoMerge } from "../merge/ast-merge";
import { resolve, clearCache, type LLMProvider } from "../merge/llm-merge";
import { parseConflictBlocks, rebuildFile } from "../merge/conflict-parser";
import type { ConflictBlock, MergeCheck } from "../data/models";

const tid = () => uuidv4();

/**
 * Merge Pipeline Tests
 *
 * Covers the full three-level merge pipeline:
 * - Level 1: Conflict parsing + auto-resolution
 * - Level 2: AST-verified merge (different functions in same file)
 * - Level 3: LLM semantic merge (same function)
 * - Sandbox CI validation (pre-merge gate)
 */
describe("SandboxValidator", () => {
  let tmpDir: string;
  let validator: SandboxValidator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-sbox-"));
    validator = new SandboxValidator();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns passed when no checks configured", () => {
    const result = validator.validate(tmpDir, []);
    expect(result.passed).toBe(true);
    expect(result.message).toContain("No checks");
  });

  it("passes when command succeeds", () => {
    const checks: MergeCheck[] = [
      { name: "node-test", cmd: "node -e \"process.exit(0)\"", timeout: 5 },
    ];
    const result = validator.validate(tmpDir, checks);
    expect(result.passed).toBe(true);
  });

  it("fails when command fails", () => {
    // Use a cross-platform "exit 1" via node
    const checks: MergeCheck[] = [
      { name: "fail-test", cmd: "node -e \"process.exit(1)\"", timeout: 5 },
    ];
    const result = validator.validate(tmpDir, checks);
    expect(result.passed).toBe(false);
    expect(result.failed_check).toBe("fail-test");
  });

  it("fails with diagnostic info", () => {
    const checks: MergeCheck[] = [
      { name: "bad-cmd", cmd: "node -e \"process.exit(42)\"", timeout: 5 },
    ];
    const result = validator.validate(tmpDir, checks);
    expect(result.passed).toBe(false);
    expect(result.failed_check).toBe("bad-cmd");
  });

  it("runs multiple checks and stops at first failure", () => {
    const checks: MergeCheck[] = [
      { name: "first", cmd: "node -e \"process.exit(0)\"", timeout: 5 },
      { name: "second", cmd: "node -e \"process.exit(1)\"", timeout: 5 },
      { name: "third", cmd: "node -e \"process.exit(0)\"", timeout: 5 },
    ];
    const result = validator.validate(tmpDir, checks);
    expect(result.passed).toBe(false);
    expect(result.failed_check).toBe("second");
  });

  it("all checks pass in sequence", () => {
    const checks: MergeCheck[] = [
      { name: "a", cmd: "node -e \"console.log('a')\"", timeout: 5 },
      { name: "b", cmd: "node -e \"console.log('b')\"", timeout: 5 },
    ];
    const result = validator.validate(tmpDir, checks);
    expect(result.passed).toBe(true);
    expect(result.message).toContain("All 2 checks passed");
  });
});

describe("AST Merge — Level 2", () => {
  it("detects same function on both sides", () => {
    expect(isSameFunction("function login() {}", "function login() {}")).toBe(true);
    expect(isSameFunction("function login() { return 'a'; }", "function login() { return 'b'; }")).toBe(true);
  });

  it("detects different functions on each side", () => {
    expect(isSameFunction("function login() {}", "function logout() {}")).toBe(false);
    expect(isSameFunction("function login() { return 1; }", "function signup() { return 2; }")).toBe(false);
  });

  it("conservatively returns true when no symbols found", () => {
    // Can't parse → assume same function (safe, escalates to LLM)
    expect(isSameFunction("var x = 1;", "var y = 2;")).toBe(true);
    expect(isSameFunction("// just a comment", "// another comment")).toBe(true);
  });

  it("canAutoMerge returns true for different functions", () => {
    const block: ConflictBlock = {
      ours: "function login() { return 'new'; }",
      theirs: "function logout() { return 'updated'; }",
      base: "",
      oursRange: [1, 3],
      theirsRange: [1, 3],
    };
    expect(canAutoMerge(block)).toBe(true);
  });

  it("canAutoMerge returns false for same function", () => {
    const block: ConflictBlock = {
      ours: "function login() { return 'new'; }",
      theirs: "function login() { return 'updated'; }",
      base: "",
      oursRange: [1, 3],
      theirsRange: [1, 3],
    };
    expect(canAutoMerge(block)).toBe(false);
  });

  it("tryMerge resolves non-overlapping changes", () => {
    const block: ConflictBlock = {
      ours: "function login() { return 'new'; }",
      theirs: "function logout() { return 'added'; }",
      base: "",
      oursRange: [1, 2],
      theirsRange: [1, 2],
    };
    const result = tryMerge(block);
    expect(result.resolved).toBe(true);
    expect(result.method).toBe("ast");
    expect(result.resolvedCode).toBeDefined();
  });

  it("tryMerge escalates overlapping changes to LLM", () => {
    const block: ConflictBlock = {
      ours: "function login() { return 'new'; }",
      theirs: "function login() { return 'updated'; }",
      base: "",
      oursRange: [1, 2],
      theirsRange: [1, 2],
    };
    const result = tryMerge(block);
    expect(result.resolved).toBe(false);
    expect(result.method).toBe("unresolved");
  });

  it("tryMerge escalates when no symbols found", () => {
    const block: ConflictBlock = {
      ours: "var x = 1;",
      theirs: "var y = 2;",
      base: "",
      oursRange: [1, 1],
      theirsRange: [1, 1],
    };
    const result = tryMerge(block);
    expect(result.resolved).toBe(false);
    expect(result.method).toBe("unresolved");
  });

  it("tryMerge handles identical code", () => {
    const block: ConflictBlock = {
      ours: "function foo() { return 1; }",
      theirs: "function foo() { return 1; }",
      base: "",
      oursRange: [1, 1],
      theirsRange: [1, 1],
    };
    // Same function name → escalated to LLM (conservative)
    const result = tryMerge(block);
    expect(result.method).toBe("unresolved");
  });
});

describe("LLM Merge — Level 3", () => {
  beforeEach(() => {
    clearCache();
  });

  it("resolves with LLM provider", async () => {
    const provider: LLMProvider = {
      call: async () => "function login() { return 'merged-version'; }",
    };

    const block: ConflictBlock = {
      ours: "function login() { return 'a'; }",
      theirs: "function login() { return 'b'; }",
      base: "function login() { return 'base'; }",
      oursRange: [1, 1],
      theirsRange: [1, 1],
    };

    const result = await resolve(block, provider);
    expect(result.resolved).toBe(true);
    expect(result.method).toBe("llm");
    expect(result.resolvedCode).toContain("merged-version");
  });

  it("returns unresolved for UNRESOLVABLE marker", async () => {
    const provider: LLMProvider = {
      call: async () => "<<<UNRESOLVABLE>>>",
    };

    const block: ConflictBlock = {
      ours: "function a() {}",
      theirs: "function b() {}",
      base: "",
      oursRange: [1, 1],
      theirsRange: [1, 1],
    };

    const result = await resolve(block, provider);
    expect(result.resolved).toBe(false);
    expect(result.method).toBe("unresolved");
  });

  it("strips markdown code fences from response", async () => {
    const provider: LLMProvider = {
      call: async () => "```typescript\nfunction foo() { return 42; }\n```",
    };

    const block: ConflictBlock = {
      ours: "ours",
      theirs: "theirs",
      base: "base",
      oursRange: [1, 1],
      theirsRange: [1, 1],
    };

    const result = await resolve(block, provider);
    expect(result.resolved).toBe(true);
    expect(result.resolvedCode).toBe("function foo() { return 42; }");
  });

  it("caches results for identical blocks", async () => {
    const mockCall = vi.fn().mockResolvedValue("function merged() {}");
    const provider: LLMProvider = { call: mockCall };

    const block: ConflictBlock = {
      ours: "ours",
      theirs: "theirs",
      base: "base",
      oursRange: [1, 1],
      theirsRange: [1, 1],
    };

    // First call
    const r1 = await resolve(block, provider);
    expect(r1.resolved).toBe(true);
    expect(mockCall).toHaveBeenCalledTimes(1);

    // Second call — should hit cache
    const r2 = await resolve(block, provider);
    expect(r2.resolved).toBe(true);
    expect(mockCall).toHaveBeenCalledTimes(1); // still 1 — cached
  });

  it("quorum mode calls secondary provider", async () => {
    const primary: LLMProvider = {
      call: async () => "function foo() { return 1; }",
    };
    const secondary: LLMProvider = {
      call: async () => "function foo() { return 1; }",
    };

    const block: ConflictBlock = {
      ours: "a",
      theirs: "b",
      base: "",
      oursRange: [1, 1],
      theirsRange: [1, 1],
    };

    clearCache(); // Ensure fresh cache for this test
    const result = await resolve(block, primary, {
      quorum: true,
      secondaryProvider: secondary,
    });
    expect(result.resolved).toBe(true);
    expect(result.method).toBe("llm");
    // No quorumDiff since results match
    expect(result.quorumDiff).toBeUndefined();
  });

  it("quorum mode adds diff note when results differ", async () => {
    const primary: LLMProvider = {
      call: async () => "function foo() { return 'primary'; }",
    };
    const secondary: LLMProvider = {
      call: async () => "function foo() { return 'secondary_alt'; }",
    };

    const block: ConflictBlock = {
      ours: "a",
      theirs: "b",
      base: "",
      oursRange: [1, 1],
      theirsRange: [1, 1],
    };

    clearCache();
    const result = await resolve(block, primary, {
      quorum: true,
      secondaryProvider: secondary,
    });
    expect(result.resolved).toBe(true);
    expect(result.quorumDiff).toBeDefined();
    expect(result.quorumDiff).toContain("QUORUM DIFF");
  });
});

describe("Merge Pipeline Integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-mpipe-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("full pipeline: parse → AST merge → rebuild", () => {
    const content = [
      "// Top of file",
      "<<<<<<< ours",
      "function login() { return 'new'; }",
      "=======",
      "function logout() { return 'added'; }",
      ">>>>>>> theirs",
      "// Bottom of file",
    ].join("\n");

    // Parse
    const blocks = parseConflictBlocks(content);
    expect(blocks).toHaveLength(1);

    // Different functions → AST merge should work
    const mergeResult = tryMerge(blocks[0]);
    expect(mergeResult.resolved).toBe(true);
    expect(mergeResult.method).toBe("ast");

    // Rebuild
    const resolutions = new Map<number, string>();
    resolutions.set(0, mergeResult.resolvedCode!);
    const rebuilt = rebuildFile(content, resolutions);

    // Verify result
    expect(rebuilt).not.toContain("<<<<<<<");
    expect(rebuilt).not.toContain(">>>>>>>");
    expect(rebuilt).toContain("login");
    expect(rebuilt).toContain("logout");
  });

  it("pipeline: same function → AST escalates → LLM resolves", async () => {
    const content = [
      "<<<<<<< ours",
      "function login() { return 'new_version'; }",
      "=======",
      "function login() { return 'old_version'; }",
      ">>>>>>> theirs",
    ].join("\n");

    const blocks = parseConflictBlocks(content);
    expect(blocks).toHaveLength(1);

    // Same function → AST won't resolve
    const astResult = tryMerge(blocks[0]);
    expect(astResult.resolved).toBe(false);

    // Escalate to LLM
    const provider: LLMProvider = {
      call: async () => "function login() { return 'llm_merged'; }",
    };
    clearCache();
    const llmResult = await resolve(blocks[0], provider);
    expect(llmResult.resolved).toBe(true);
    expect(llmResult.method).toBe("llm");

    // Rebuild
    const resolutions = new Map<number, string>();
    resolutions.set(0, llmResult.resolvedCode!);
    const rebuilt = rebuildFile(content, resolutions);
    expect(rebuilt).toContain("llm_merged");
    expect(rebuilt).not.toContain("<<<<<<<");
  });

  it("pipeline: sandbox validation after merge", () => {
    // Validate with a simple always-passing check
    const validator = new SandboxValidator();
    const checks: MergeCheck[] = [
      { name: "always-pass", cmd: "node -e \"process.exit(0)\"", timeout: 5 },
    ];

    const result = validator.validate(tmpDir, checks);
    expect(result.passed).toBe(true);
  });
});
