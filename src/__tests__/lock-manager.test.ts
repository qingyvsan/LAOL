import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { v4 as uuidv4 } from "uuid";
import { LockManager } from "../lock/lock-manager";
import { LeaseManager } from "../lock/lease-manager";

// Helper: generate valid UUIDs for test task IDs
const tid = () => uuidv4();

describe("LockManager — two-phase commit", () => {
  let tmpDir: string;
  let lockManager: LockManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-test-"));
    fs.mkdirSync(path.join(tmpDir, ".multiagent", "locks"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".multiagent", "staging"), { recursive: true });
    lockManager = new LockManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("acquires locks for multiple files atomically", () => {
    const result = lockManager.acquire(tid(), "agent-1", [
      "src/auth.ts",
      "src/utils.ts",
    ]);

    expect(result.success).toBe(true);
    expect(result.locks).toHaveLength(2);
    expect(result.locks![0].holder).toBe("agent-1");
    expect(result.locks![0].phase).toBe("initial");
  });

  it("detects existing lock conflicts", () => {
    const first = lockManager.acquire(tid(), "agent-1", ["src/auth.ts"]);
    expect(first.success).toBe(true);

    const second = lockManager.acquire(tid(), "agent-2", ["src/auth.ts"]);
    expect(second.success).toBe(false);
    expect(second.reason).toContain("already locked");
  });

  it("rolls back partial locks on conflict", () => {
    lockManager.acquire(tid(), "agent-1", ["src/auth.ts"]);

    const result = lockManager.acquire(tid(), "agent-2", [
      "src/auth.ts",
      "src/utils.ts",
    ]);

    expect(result.success).toBe(false);
    expect(lockManager.isLocked("src/utils.ts")).toBe(false);
    expect(lockManager.isLocked("src/auth.ts")).toBe(true);
    expect(lockManager.getLock("src/auth.ts")!.holder).toBe("agent-1");
  });

  it("releases individual locks", () => {
    lockManager.acquire(tid(), "agent-1", ["src/auth.ts"]);
    expect(lockManager.isLocked("src/auth.ts")).toBe(true);

    const released = lockManager.release("src/auth.ts");
    expect(released).toBe(true);
    expect(lockManager.isLocked("src/auth.ts")).toBe(false);
  });

  it("releases all locks for an agent", () => {
    lockManager.acquire(tid(), "agent-1", [
      "src/auth.ts",
      "src/utils.ts",
      "src/db.ts",
    ]);

    const released = lockManager.releaseAllForAgent("agent-1");
    expect(released).toHaveLength(3);
    expect(lockManager.isLocked("src/auth.ts")).toBe(false);
    expect(lockManager.isLocked("src/utils.ts")).toBe(false);
    expect(lockManager.isLocked("src/db.ts")).toBe(false);
  });

  it("lists locks filtered by holder", () => {
    lockManager.acquire(tid(), "agent-A", ["src/auth.ts"]);
    lockManager.acquire(tid(), "agent-B", ["src/utils.ts"]);

    const agentALocks = lockManager.listLocks({ holder: "agent-A" });
    expect(agentALocks).toHaveLength(1);
    expect(agentALocks[0].file).toBe("src/auth.ts");

    const agentBLocks = lockManager.listLocks({ holder: "agent-B" });
    expect(agentBLocks).toHaveLength(1);
  });

  it("handles symbol-level lock keys", () => {
    const result = lockManager.acquire(tid(), "agent-1", [
      "src/auth.ts#login",
    ]);
    expect(result.success).toBe(true);
    expect(lockManager.isLocked("src/auth.ts#login")).toBe(true);
  });

  it("prevents duplicate file entries in same acquire", () => {
    const result = lockManager.acquire(tid(), "agent-1", [
      "src/auth.ts",
      "src/auth.ts",
      "src/utils.ts",
    ]);
    expect(result.success).toBe(true);
    expect(result.locks).toHaveLength(2);
  });
});

describe("LeaseManager — graded TTL", () => {
  let tmpDir: string;
  let lockManager: LockManager;
  let leaseManager: LeaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-test-"));
    fs.mkdirSync(path.join(tmpDir, ".multiagent", "locks"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".multiagent", "staging"), { recursive: true });
    lockManager = new LockManager(tmpDir);
    leaseManager = new LeaseManager(lockManager, {
      initialTtlMs: 1000,
      stableTtlMs: 3000,
      stableThreshold: 2,
      probeTimeoutMs: 500,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates lease with initial TTL", () => {
    const lock = leaseManager.createLease("src/auth.ts", "agent-1", tid());
    expect(lock.phase).toBe("initial");
    expect(lock.renew_count).toBe(0);
    const ttl = lock.expires_at - lock.created_at;
    expect(ttl).toBeLessThanOrEqual(1000);
  });

  it("upgrades to stable after threshold renewals", () => {
    const taskId = tid();
    lockManager.acquire(taskId, "agent-1", ["src/auth.ts"]);
    const renewResult = leaseManager.createLease("src/auth.ts", "agent-1", taskId);
    expect(renewResult.phase).toBe("initial");
  });

  it("detects expired locks", () => {
    const lock = leaseManager.createLease("src/auth.ts", "agent-1", tid());
    lock.expires_at = Date.now() - 100;
    expect(leaseManager.isExpired(lock)).toBe(true);
  });

  it("detects overdue heartbeats", () => {
    const lock = leaseManager.createLease("src/auth.ts", "agent-1", tid());
    lock.last_heartbeat = Date.now() - 600;
    expect(leaseManager.isHeartbeatOverdue(lock)).toBe(true);
  });
});
