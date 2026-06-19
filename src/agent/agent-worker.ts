import * as path from "node:path";
import { execSync } from "node:child_process";
import { TaskStore } from "../task/task-store";
import { LockManager } from "../lock/lock-manager";
import { LeaseManager } from "../lock/lease-manager";
import { WorktreePool } from "../worktree/pool";
import { Heartbeat } from "./heartbeat";
import { Checkpoint, RebaseConflictError } from "./checkpoint";
import { Perception } from "./perception";
import { SocketClient } from "../events/socket-client";
import { RegistryManager } from "../registry/registry-manager";
import { loadConfig } from "../config";
import type { Task, LaolConfig } from "../data/models";

/**
 * Agent Worker — manages the full lifecycle of a single task execution.
 *
 * Sequence:
 *   1. Load task
 *   2. Start heartbeat
 *   3. Start perception watcher
 *   4. Acquire worktree from pool
 *   5. Check for semantic warnings → inject into context
 *   6. Execute work loop (checkpoint → perceive → LLM call → repeat)
 *   7. Commit changes
 *   8. Push branch
 *   9. Release locks
 *   10. Release worktree
 *   11. Update task status
 *   12. Stop heartbeat
 *   13. Notify scheduler
 *
 * The agent worker sets up the environment and manages state transitions.
 * The actual LLM interaction happens via external CLI (Claude Code).
 */

export class AgentWorker {
  private repoRoot: string;
  private agentId: string;
  private config: LaolConfig;

  // Dependencies
  private taskStore: TaskStore;
  private lockManager: LockManager;
  private leaseManager: LeaseManager;
  private worktreePool: WorktreePool;
  private socketClient: SocketClient;
  private registryManager: RegistryManager;

  // Per-task state
  private currentTask: Task | null = null;
  private heartbeat: Heartbeat;
  private checkpoint: Checkpoint | null = null;
  private perception: Perception | null = null;

  // Getter for heartbeat to access current lock files
  private activeLockFiles: string[] = [];

  constructor(
    repoRoot: string,
    agentId: string,
    taskStore: TaskStore,
    lockManager: LockManager,
    leaseManager: LeaseManager,
    worktreePool: WorktreePool,
    socketClient: SocketClient,
    registryManager: RegistryManager
  ) {
    this.repoRoot = repoRoot;
    this.agentId = agentId;
    this.config = loadConfig(repoRoot);

    this.taskStore = taskStore;
    this.lockManager = lockManager;
    this.leaseManager = leaseManager;
    this.worktreePool = worktreePool;
    this.socketClient = socketClient;
    this.registryManager = registryManager;

    this.heartbeat = new Heartbeat(lockManager, leaseManager, agentId);
  }

  /**
   * Execute a task assigned to this agent.
   *
   * This method sets up the full environment, then the actual AI work
   * happens in the provided executor callback (which spawns Claude Code
   * or another LLM tool).
   *
   * @param task - The task to execute
   * @param executor - Callback that performs the actual AI code modifications.
   *   Receives the worktree path and should return void or throw on failure.
   */
  async executeTask(
    task: Task,
    executor: (worktreePath: string, task: Task, contextHints: string[]) => Promise<void>
  ): Promise<void> {
    this.currentTask = task;
    const taskId = task.id;

    try {
      // 1. Validate task state
      if (task.status !== "in_progress") {
        throw new Error(`Task ${taskId} is not in_progress (current: ${task.status})`);
      }

      // 2. Start heartbeat
      this.activeLockFiles = task.target_files.map((f) => f); // copy
      this.heartbeat.start(() => this.activeLockFiles);

      // 3. Start perception
      this.perception = new Perception(this.repoRoot, taskId, task.target_files);
      this.perception.start();

      // 4. Acquire worktree
      console.log(`[agent ${this.agentId}] Acquiring worktree for task ${taskId.slice(0, 8)}...`);
      const handle = this.worktreePool.acquire(taskId);

      // 5. Setup checkpoint
      this.checkpoint = new Checkpoint(
        handle.path,
        taskId,
        "main",
        this.config.agent.checkpoint_min_interval_ms
      );

      // 6. Collect context hints
      const contextHints: string[] = [];

      // Check warnings
      const warnings = this.perception.checkWarnings();
      if (warnings) {
        contextHints.push(`[SEMANTIC WARNINGS]\n${warnings}`);
      }

      // Check perception context
      const ctxSummary = this.perception.getContextSummary();
      if (ctxSummary) {
        contextHints.push(ctxSummary);
      }

      // 7. Pre-work checkpoint
      try {
        const result = this.checkpoint.checkAndRebase();
        if (result.updated && result.message) {
          contextHints.push(`[CHECKPOINT] ${result.message}`);
        }
      } catch (err) {
        if (err instanceof RebaseConflictError) {
          this.failTask(taskId, err.message);
          return;
        }
        throw err;
      }

      // 8. Execute the actual AI work
      console.log(`[agent ${this.agentId}] Starting work on task ${taskId.slice(0, 8)}`);
      await executor(handle.path, task, contextHints);

      // 9. Commit changes
      this.commitChanges(handle.path, task);

      // 10. Push branch
      this.pushBranch(handle.path, task);

      // 11. Update registry for modified files
      for (const file of task.target_files) {
        this.registryManager.updateEntry(
          file,
          this.agentId,
          path.join(handle.path, file)
        );
      }

      // 12. Complete task
      this.completeTask(taskId);

    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[agent ${this.agentId}] Task ${taskId.slice(0, 8)} failed: ${reason}`);
      this.failTask(taskId, reason);
    } finally {
      // Cleanup regardless of outcome
      this.cleanup(taskId);
    }
  }

  // ---- Lifecycle ----

  private commitChanges(worktreePath: string, task: Task): void {
    try {
      execSync("git add -A", {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: 10_000,
      });

      // Check if there's anything to commit
      const status = execSync("git status --porcelain", {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: 5000,
      }).toString().trim();

      if (!status) {
        console.log(`[agent ${this.agentId}] No changes to commit`);
        return;
      }

      execSync(`git commit -m "Task: ${task.description.slice(0, 72)}"`, {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: 10_000,
      });

      console.log(`[agent ${this.agentId}] Changes committed`);
    } catch (err) {
      console.warn(`[agent ${this.agentId}] Commit warning: ${err}`);
    }
  }

  private pushBranch(worktreePath: string, task: Task): void {
    try {
      const branch = `agent/${task.id}`;
      execSync(`git push origin ${branch}`, {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: 30_000,
      });
      console.log(`[agent ${this.agentId}] Branch pushed: ${branch}`);
    } catch (err) {
      console.warn(`[agent ${this.agentId}] Push warning (will merge locally): ${err}`);
    }
  }

  private completeTask(taskId: string): void {
    // Release locks
    for (const file of this.activeLockFiles) {
      this.lockManager.release(file);
    }

    // Update task status
    this.taskStore.updateTask(taskId, () => ({
      status: "done",
      updated_at: Date.now(),
    }));

    // Notify scheduler
    this.socketClient.notifyTaskDone(taskId);
    console.log(`[agent ${this.agentId}] Task ${taskId.slice(0, 8)} DONE`);
  }

  private failTask(taskId: string, reason: string): void {
    // Release locks
    for (const file of this.activeLockFiles) {
      this.lockManager.release(file);
    }

    // Update task status
    this.taskStore.updateTask(taskId, () => ({
      status: "failed",
      metadata: { failure_reason: reason },
    }));

    // Notify scheduler
    this.socketClient.notifyTaskFailed(taskId, reason);
  }

  private cleanup(taskId: string): void {
    // Stop heartbeat
    this.heartbeat.stop();

    // Stop perception
    if (this.perception) {
      this.perception.stop();
      this.perception = null;
    }

    // Release worktree
    this.worktreePool.release(taskId);

    this.activeLockFiles = [];
    this.currentTask = null;
    this.checkpoint = null;
  }
}
