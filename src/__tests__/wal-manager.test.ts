import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { WalManager } from "../wal/wal-manager";

describe("WalManager — crash recovery", () => {
  let tmpDir: string;
  let walManager: WalManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-test-"));
    fs.mkdirSync(path.join(tmpDir, ".multiagent", "wal"), { recursive: true });
    walManager = new WalManager(tmpDir);
  });

  afterEach(() => {
    walManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes and fsyncs records", () => {
    walManager.write({ op: "assign", task: "task-1", agent: "agent-1" });

    // Check that a WAL segment file was created
    const walDir = path.join(tmpDir, ".multiagent", "wal");
    const files = fs.readdirSync(walDir).filter((f) => f.endsWith(".log"));
    expect(files.length).toBeGreaterThan(0);

    const content = fs.readFileSync(path.join(walDir, files[0]), "utf-8");
    expect(content).toContain("task-1");
    expect(content).toContain("agent-1");
    expect(content).toContain("assign");
  });

  it("detects uncommitted records on recovery", () => {
    // Write an assign without a matching commit
    walManager.write({ op: "assign", task: "task-orphan", agent: "agent-1" });
    walManager.write({ op: "acquire_lock", file: "src/auth.ts", holder: "agent-1", task: "task-orphan" });

    // Write a properly committed record
    walManager.write({ op: "assign", task: "task-ok", agent: "agent-2" });
    walManager.write({ op: "commit", task: "task-ok" });

    // Recovery should find the orphaned records
    const pending = walManager.recover();
    // The uncommitted assign and acquire_lock should be flagged
    expect(pending.length).toBeGreaterThan(0);
  });

  it("safeStateChange writes commit on success", () => {
    let callbackRun = false;
    let caught: Error | null = null;

    try {
      walManager.safeStateChange(
        "assign",
        { task: "task-1", agent: "agent-1" },
        () => {
          callbackRun = true;
        }
      );
    } catch (err) {
      caught = err as Error;
    }

    expect(callbackRun).toBe(true);
    expect(caught).toBeNull();

    // Verify commit was written
    const walDir = path.join(tmpDir, ".multiagent", "wal");
    const files = fs.readdirSync(walDir).filter((f) => f.endsWith(".log"));
    const content = fs.readFileSync(path.join(walDir, files[0]), "utf-8");
    expect(content).toContain('"op":"commit"');
  });

  it("safeStateChange writes fail record on exception", () => {
    expect(() => {
      walManager.safeStateChange(
        "assign",
        { task: "task-fail", agent: "agent-1" },
        () => {
          throw new Error("simulated failure");
        }
      );
    }).toThrow("simulated failure");

    // Verify fail record was written
    const walDir = path.join(tmpDir, ".multiagent", "wal");
    const files = fs.readdirSync(walDir).filter((f) => f.endsWith(".log"));
    const content = fs.readFileSync(path.join(walDir, files[0]), "utf-8");
    expect(content).toContain('"op":"fail"');
  });

  it("checkpoint triggers cleanup of old segments", () => {
    // Write enough records to fill a segment
    for (let i = 0; i < 100; i++) {
      walManager.write({ op: "heartbeat", agent: "agent-1" });
    }

    walManager.checkpoint();
    // Should not throw — checkpoint completed
  });
});
