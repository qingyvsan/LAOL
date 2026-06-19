import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { v4 as uuidv4 } from "uuid";
import { TaskStore } from "../task/task-store";
import { LockManager } from "../lock/lock-manager";
import { LeaseManager } from "../lock/lease-manager";
import { ConflictChecker } from "../scheduler/conflict-checker";
import { CircuitBreaker } from "../scheduler/circuit-breaker";

const tid = () => uuidv4();

/**
 * Scheduler integration test — verifies the full task assignment
 * pipeline (conflict check → lock → circuit breaker) works correctly.
 */
describe("Scheduler Pipeline Integration", () => {
  let tmpDir: string;
  let taskStore: TaskStore;
  let lockManager: LockManager;
  let leaseManager: LeaseManager;
  let conflictChecker: ConflictChecker;
  let circuitBreaker: CircuitBreaker;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-int-"));
    fs.mkdirSync(path.join(tmpDir, ".multiagent", "tasks"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".multiagent", "locks"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".multiagent", "staging"), { recursive: true });

    taskStore = new TaskStore(tmpDir);
    lockManager = new LockManager(tmpDir);
    leaseManager = new LeaseManager(lockManager);
    conflictChecker = new ConflictChecker(lockManager);
    circuitBreaker = new CircuitBreaker();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("full task lifecycle: create → assign → acquire locks → complete → release", () => {
    // 1. Create a task
    const task = taskStore.createTask({
      description: "Refactor auth module",
      target_files: ["src/auth.ts", "src/validator.ts"],
    });
    expect(task.status).toBe("pending");

    // 2. Conflict check — should pass (no other locks)
    const result = conflictChecker.canAssign(task);
    expect(result.can_assign).toBe(true);

    // 3. Circuit breaker — should allow
    const cbResult = circuitBreaker.canAcceptTask("agent-1", task.target_files.length);
    expect(cbResult.can).toBe(true);

    // 4. Acquire locks
    const acquireResult = lockManager.acquire(task.id, "agent-1", task.target_files);
    expect(acquireResult.success).toBe(true);
    expect(acquireResult.locks).toHaveLength(2);

    // 5. Update task to in_progress
    const inProgress = taskStore.updateTask(task.id, () => ({
      status: "in_progress",
      assigned_agent: "agent-1",
    }));
    expect(inProgress).not.toBeNull();
    expect(inProgress!.status).toBe("in_progress");

    // 6. Complete: release locks and mark done
    for (const f of task.target_files) {
      lockManager.release(f);
    }

    const done = taskStore.updateTask(task.id, () => ({
      status: "done",
    }));
    expect(done!.status).toBe("done");

    // 7. Verify final state
    expect(lockManager.isLocked("src/auth.ts")).toBe(false);
    expect(lockManager.isLocked("src/validator.ts")).toBe(false);
  });

  it("conflict checker blocks assignment when files are locked", () => {
    const taskA = taskStore.createTask({
      description: "Task A",
      target_files: ["src/shared.ts"],
    });
    const taskB = taskStore.createTask({
      description: "Task B",
      target_files: ["src/shared.ts"],
    });

    // Lock file for task A
    lockManager.acquire(taskA.id, "agent-1", taskA.target_files);

    // Task B should be blocked
    const result = conflictChecker.canAssign(taskB);
    expect(result.can_assign).toBe(false);
    expect(result.reason).toContain("locked");
  });

  it("circuit breaker + lock manager work together", () => {
    const task = taskStore.createTask({
      description: "Complex refactor",
      target_files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
    });

    // Simulate agent failing twice
    circuitBreaker.onTaskFailure("agent-1", "prev-1", "error");
    circuitBreaker.onTaskFailure("agent-1", "prev-2", "error");

    // Degraded agent can't take 5-file task
    const cbResult = circuitBreaker.canAcceptTask("agent-1", task.target_files.length);
    expect(cbResult.can).toBe(false);

    // But a fresh agent can
    const cbResult2 = circuitBreaker.canAcceptTask("agent-2", task.target_files.length);
    expect(cbResult2.can).toBe(true);
  });

  it("two agents can work on different files in parallel", () => {
    const taskA = taskStore.createTask({
      description: "Fix auth",
      target_files: ["src/auth.ts"],
    });
    const taskB = taskStore.createTask({
      description: "Fix database",
      target_files: ["src/db.ts"],
    });

    // Both should pass conflict check
    expect(conflictChecker.canAssign(taskA).can_assign).toBe(true);
    expect(conflictChecker.canAssign(taskB).can_assign).toBe(true);

    // Both should acquire locks
    expect(lockManager.acquire(taskA.id, "agent-1", taskA.target_files).success).toBe(true);
    expect(lockManager.acquire(taskB.id, "agent-2", taskB.target_files).success).toBe(true);

    // Verify both are locked
    expect(lockManager.isLocked("src/auth.ts")).toBe(true);
    expect(lockManager.isLocked("src/db.ts")).toBe(true);
    expect(lockManager.getLock("src/auth.ts")!.holder).toBe("agent-1");
    expect(lockManager.getLock("src/db.ts")!.holder).toBe("agent-2");
  });

  it("task with resolved dependency can be assigned", () => {
    // Create a dependency task and complete it
    const dep = taskStore.createTask({
      description: "Dependency",
      target_files: ["src/dep.ts"],
    });

    taskStore.updateTask(dep.id, () => ({ status: "done" }));

    const child = taskStore.createTask({
      description: "Child task",
      target_files: ["src/child.ts"],
      dependency: dep.id,
    });

    // Dependency is done, so child should be assignable
    const result = conflictChecker.canAssign(child);
    expect(result.can_assign).toBe(true);
  });
});
