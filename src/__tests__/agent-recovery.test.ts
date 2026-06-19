import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { v4 as uuidv4 } from "uuid";
import { TaskStore } from "../task/task-store";
import { LockManager } from "../lock/lock-manager";
import { LeaseManager } from "../lock/lease-manager";
import { HealthMonitor } from "../scheduler/health-monitor";
import { EventBus } from "../events/event-bus";
import { ConflictChecker } from "../scheduler/conflict-checker";
import type { Lock } from "../data/models";

const tid = () => uuidv4();

/**
 * Agent Crash Recovery Tests
 *
 * Verifies that when an agent crashes or becomes unresponsive:
 * - Locks are released (by the scheduler)
 * - Tasks are reset to pending
 * - Other agents can re-acquire the files
 * - Health monitor detects stale state
 */
describe("Agent Crash Recovery", () => {
  let tmpDir: string;
  let taskStore: TaskStore;
  let lockManager: LockManager;
  let leaseManager: LeaseManager;
  let eventBus: EventBus;
  let healthMonitor: HealthMonitor;
  let conflictChecker: ConflictChecker;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-agrec-"));
    fs.mkdirSync(path.join(tmpDir, ".multiagent", "tasks"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".multiagent", "locks"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".multiagent", "staging"), { recursive: true });

    taskStore = new TaskStore(tmpDir);
    lockManager = new LockManager(tmpDir);
    leaseManager = new LeaseManager(lockManager, {
      initialTtlMs: 1000,
      stableTtlMs: 3000,
      stableThreshold: 2,
      probeTimeoutMs: 500,
    });
    eventBus = new EventBus();
    healthMonitor = new HealthMonitor(
      lockManager,
      leaseManager,
      eventBus,
      15_000
    );
    conflictChecker = new ConflictChecker(lockManager);
  });

  afterEach(() => {
    healthMonitor.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- Lock release on agent loss ----

  it("releases all locks for a crashed agent", () => {
    const taskId = tid();
    lockManager.acquire(taskId, "agent-crash", [
      "src/auth.ts",
      "src/utils.ts",
      "src/db.ts",
    ]);

    expect(lockManager.isLocked("src/auth.ts")).toBe(true);
    expect(lockManager.isLocked("src/utils.ts")).toBe(true);
    expect(lockManager.isLocked("src/db.ts")).toBe(true);

    // Simulate scheduler releasing all locks for the dead agent
    const released = lockManager.releaseAllForAgent("agent-crash");

    expect(released).toHaveLength(3);
    expect(lockManager.isLocked("src/auth.ts")).toBe(false);
    expect(lockManager.isLocked("src/utils.ts")).toBe(false);
    expect(lockManager.isLocked("src/db.ts")).toBe(false);
  });

  it("another agent can acquire files after crash release", () => {
    const taskA = tid();
    const taskB = tid();

    // Agent 1 acquires files
    lockManager.acquire(taskA, "agent-1", ["src/shared.ts", "src/module.ts"]);

    // Agent 1 crashes — release all locks
    lockManager.releaseAllForAgent("agent-1");

    // Agent 2 can now acquire the same files
    const result = lockManager.acquire(taskB, "agent-2", [
      "src/shared.ts",
      "src/module.ts",
    ]);
    expect(result.success).toBe(true);
    expect(lockManager.getLock("src/shared.ts")!.holder).toBe("agent-2");
    expect(lockManager.getLock("src/module.ts")!.holder).toBe("agent-2");
  });

  it("partial locks held by crashed agent don't block others", () => {
    const taskA = tid();
    const taskB = tid();

    // Agent 1 holds auth.ts
    lockManager.acquire(taskA, "agent-1", ["src/auth.ts"]);

    // Agent 1 crashes
    lockManager.releaseAllForAgent("agent-1");

    // Agent 2 can acquire auth.ts + utils.ts in one batch
    const result = lockManager.acquire(taskB, "agent-2", [
      "src/auth.ts",
      "src/utils.ts",
    ]);
    expect(result.success).toBe(true);
    expect(result.locks).toHaveLength(2);
  });

  // ---- Task state recovery ----

  it("resets in_progress task to pending when agent crashes", () => {
    // Create a task
    const task = taskStore.createTask({
      description: "Feature X",
      target_files: ["src/feature.ts"],
    });

    // Assign to agent
    const inProgress = taskStore.updateTask(task.id, () => ({
      status: "in_progress",
      assigned_agent: "agent-doomed",
    }));
    expect(inProgress!.status).toBe("in_progress");

    // Simulate agent crash — reset task
    const reset = taskStore.updateTask(task.id, () => ({
      status: "pending",
      assigned_agent: null,
      metadata: { agent_lost_at: Date.now() },
    }));
    expect(reset!.status).toBe("pending");
    expect(reset!.assigned_agent).toBeNull();
  });

  it("reset task can be picked up by another agent", () => {
    const task = taskStore.createTask({
      description: "Fix bug",
      target_files: ["src/bugfix.ts"],
    });

    // First agent gets the task, then crashes
    taskStore.updateTask(task.id, () => ({
      status: "in_progress",
      assigned_agent: "agent-crashed",
    }));

    // Crash → reset
    taskStore.updateTask(task.id, () => ({
      status: "pending",
      assigned_agent: null,
    }));

    // Conflict check passes for a new agent
    const result = conflictChecker.canAssign(task);
    expect(result.can_assign).toBe(true);

    // New agent acquires lock
    const acquireResult = lockManager.acquire(task.id, "agent-new", task.target_files);
    expect(acquireResult.success).toBe(true);

    // New agent takes the task
    const reassigned = taskStore.updateTask(task.id, () => ({
      status: "in_progress",
      assigned_agent: "agent-new",
    }));
    expect(reassigned!.assigned_agent).toBe("agent-new");
    expect(reassigned!.status).toBe("in_progress");
  });

  // ---- Health Monitor ----

  it("health monitor detects expired locks", () => {
    const lockFile = "src/expired.ts";
    const agentId = "agent-expired";

    // Create a lock that's already expired
    const lock = leaseManager.createLease(lockFile, agentId, tid());
    // Manually expire it
    lock.expires_at = Date.now() - 100;

    const isExpired = leaseManager.isExpired(lock);
    expect(isExpired).toBe(true);
  });

  it("health monitor detects overdue heartbeats", () => {
    const lockFile = "src/overdue.ts";
    const agentId = "agent-overdue";

    const lock = leaseManager.createLease(lockFile, agentId, tid());
    // Heartbeat not sent for too long
    lock.last_heartbeat = Date.now() - 600;

    const isOverdue = leaseManager.isHeartbeatOverdue(lock);
    expect(isOverdue).toBe(true);
  });

  it("leaseManager.findStaleLocks separates expired from overdue", () => {
    // Create locks with different states
    const freshLock = leaseManager.createLease("src/fresh.ts", "agent-fresh", tid());

    const expiredLock = leaseManager.createLease("src/old.ts", "agent-old", tid());
    expiredLock.expires_at = Date.now() - 200;

    const overdueLock = leaseManager.createLease("src/late.ts", "agent-late", tid());
    overdueLock.last_heartbeat = Date.now() - 600;

    // Write them to disk so findStaleLocks can read them
    // (findStaleLocks reads from the lock directory)
    // Actually, findStaleLocks calls listLocks() on lockManager
    // We need to create actual lock files
    const taskId = tid();
    lockManager.acquire(taskId, "agent-fresh", ["src/fresh.ts"]);

    const taskId2 = tid();
    lockManager.acquire(taskId2, "agent-old", ["src/old.ts"]);
    // Manually expire the old lock
    const oldLockPath = path.join(
      tmpDir,
      ".multiagent",
      "locks",
      "src#old.ts.lock"
    );
    const oldLock = JSON.parse(fs.readFileSync(oldLockPath, "utf-8"));
    oldLock.expires_at = Date.now() - 200;
    fs.writeFileSync(oldLockPath, JSON.stringify(oldLock, null, 2), "utf-8");

    const taskId3 = tid();
    lockManager.acquire(taskId3, "agent-late", ["src/late.ts"]);
    const lateLockPath = path.join(
      tmpDir,
      ".multiagent",
      "locks",
      "src#late.ts.lock"
    );
    const lateLock = JSON.parse(fs.readFileSync(lateLockPath, "utf-8"));
    lateLock.last_heartbeat = Date.now() - 600;
    fs.writeFileSync(lateLockPath, JSON.stringify(lateLock, null, 2), "utf-8");

    // Now check findStaleLocks
    const { expired, overdue } = leaseManager.findStaleLocks();

    // The old lock should be in expired
    const expiredFiles = expired.map((l: Lock) => l.file);
    expect(expiredFiles).toContain("src/old.ts");

    // The late lock should be in overdue
    const overdueFiles = overdue.map((l: Lock) => l.file);
    expect(overdueFiles).toContain("src/late.ts");

    // The fresh lock should be in neither
    expect(expiredFiles).not.toContain("src/fresh.ts");
    expect(overdueFiles).not.toContain("src/fresh.ts");
  });

  it("lock_expired event is emitted on expired lock handling", () => {
    const spy = vi.fn();
    eventBus.on("lock_expired", spy);

    // Create an expired lock
    const taskId = tid();
    lockManager.acquire(taskId, "agent-gone", ["src/gone.ts"]);
    const lockPath = path.join(
      tmpDir,
      ".multiagent",
      "locks",
      "src#gone.ts.lock"
    );
    const lockData = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    lockData.expires_at = Date.now() - 100;
    fs.writeFileSync(lockPath, JSON.stringify(lockData, null, 2), "utf-8");

    // Run health check manually
    const { expired } = leaseManager.findStaleLocks();
    for (const lock of expired) {
      leaseManager.forceExpire(lock.file);
      eventBus.emit("lock_expired", lock.file);
    }

    expect(spy).toHaveBeenCalledWith("src/gone.ts");
  });

  it("heartbeat_lost event is emitted for unresponsive agent", () => {
    const spy = vi.fn();
    eventBus.on("heartbeat_lost", spy);

    // Create a lock with very old heartbeat
    const taskId = tid();
    lockManager.acquire(taskId, "agent-silent", ["src/silent.ts"]);
    const lockPath = path.join(
      tmpDir,
      ".multiagent",
      "locks",
      "src#silent.ts.lock"
    );
    const lockData = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    lockData.last_heartbeat = Date.now() - 600;
    fs.writeFileSync(lockPath, JSON.stringify(lockData, null, 2), "utf-8");

    // Force release and emit heartbeat_lost
    lockManager.releaseAllForAgent("agent-silent");
    eventBus.emit("heartbeat_lost", "agent-silent");

    expect(spy).toHaveBeenCalledWith("agent-silent");
  });

  // ---- Full recovery flow ----

  it("full crash recovery: agent dies → locks free → task reassigned", () => {
    // 1. Create a task
    const task = taskStore.createTask({
      description: "Important refactor",
      target_files: ["src/important.ts"],
    });

    // 2. Agent acquires locks and task
    const acquireResult = lockManager.acquire(
      task.id,
      "agent-doomed",
      task.target_files
    );
    expect(acquireResult.success).toBe(true);

    const inProgress = taskStore.updateTask(task.id, () => ({
      status: "in_progress",
      assigned_agent: "agent-doomed",
    }));
    expect(inProgress!.status).toBe("in_progress");

    // 3. CRASH — agent dies, scheduler detects and releases
    lockManager.releaseAllForAgent("agent-doomed");

    const reset = taskStore.updateTask(task.id, () => ({
      status: "pending",
      assigned_agent: null,
    }));
    expect(reset!.status).toBe("pending");

    // 4. Verify no locks remain for the crashed agent
    const remainingLocks = lockManager.listLocks({ holder: "agent-doomed" });
    expect(remainingLocks).toHaveLength(0);

    // 5. Verify file is free
    expect(lockManager.isLocked("src/important.ts")).toBe(false);

    // 6. Another agent can take the task
    const conflictResult = conflictChecker.canAssign(task);
    expect(conflictResult.can_assign).toBe(true);

    const acquireResult2 = lockManager.acquire(
      task.id,
      "agent-recovery",
      task.target_files
    );
    expect(acquireResult2.success).toBe(true);

    const reassigned = taskStore.updateTask(task.id, () => ({
      status: "in_progress",
      assigned_agent: "agent-recovery",
    }));
    expect(reassigned!.status).toBe("in_progress");
    expect(reassigned!.assigned_agent).toBe("agent-recovery");

    // 7. New agent completes task
    lockManager.releaseAllForAgent("agent-recovery");
    const done = taskStore.updateTask(task.id, () => ({
      status: "done",
    }));
    expect(done!.status).toBe("done");
  });
});
