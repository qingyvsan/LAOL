import * as fs from "node:fs";
import * as path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { TaskSchema } from "../data/schemas";
import type { Task, TaskStatus } from "../data/models";

/**
 * Atomic CRUD operations for task JSON files stored in tasks/ directory.
 *
 * Atomicity guarantee: all writes go to a temp file first,
 * then fs.renameSync (atomic on same volume) to the final path.
 */

export class TaskStore {
  private tasksDir: string;

  constructor(repoRoot: string) {
    this.tasksDir = path.join(repoRoot, ".multiagent", "tasks");
    this.ensureDir();
  }

  // ---- Public API ----

  /**
   * Validate target file paths for path traversal and system file access.
   * Throws on invalid paths; returns silently on valid ones.
   */
  static validateTargetFiles(files: string[]): void {
    for (const file of files) {
      if (path.isAbsolute(file)) {
        throw new Error(`Invalid target file "${file}": absolute paths are not allowed`);
      }
      if (file.includes("..")) {
        throw new Error(`Invalid target file "${file}": path traversal (..) is not allowed`);
      }
      if (file.startsWith(".multiagent") || file.startsWith(".multiagent/")) {
        throw new Error(`Invalid target file "${file}": cannot target LAOL system directory`);
      }
    }
  }

  /**
   * Create a new task and write it atomically to tasks/task_{uuid}.json.
   */
  createTask(params: {
    description: string;
    target_files: string[];
    dependency?: string | null;
  }): Task {
    // Validate target files before creating task
    TaskStore.validateTargetFiles(params.target_files);

    const now = Date.now();
    const taskId = uuidv4();

    // Check for self-dependency (can happen with manually constructed JSON)
    if (params.dependency === taskId) {
      throw new Error("A task cannot depend on itself");
    }

    // Check for dependency cycles in existing tasks
    if (params.dependency) {
      this.checkDependencyCycle(params.dependency);
    }

    const task: Task = {
      id: taskId,
      status: "pending",
      description: params.description,
      target_files: params.target_files,
      assigned_agent: null,
      created_at: now,
      updated_at: now,
      dependency: params.dependency ?? null,
      metadata: {},
      version: 1,
    };

    // Validate before writing
    TaskSchema.parse(task);

    const filePath = this.taskPath(task.id);
    this.atomicWrite(filePath, task);

    return task;
  }

  /**
   * Read a single task by ID. Returns null if not found or invalid.
   */
  getTask(taskId: string): Task | null {
    const filePath = this.taskPath(taskId);
    return this.readValidated(filePath);
  }

  /**
   * Update a task with optimistic concurrency control.
   *
   * The patchFn receives the current task and returns the updates.
   * If another process modified the task since we read it (version mismatch),
   * the update is rejected and null is returned.
   */
  updateTask(
    taskId: string,
    patchFn: (task: Task) => Partial<Task>
  ): Task | null {
    const filePath = this.taskPath(taskId);

    // Read current state
    const current = this.readValidated(filePath);
    if (!current) return null;

    const expectedVersion = current.version;

    // Apply user's patch
    const patch = patchFn(current);
    const updated: Task = {
      ...current,
      ...patch,
      id: current.id, // immutable
      created_at: current.created_at, // immutable
      updated_at: Date.now(),
      version: expectedVersion + 1,
      metadata: {
        ...current.metadata,
        ...(patch.metadata as Record<string, unknown> | undefined),
      },
    };

    // Validate result
    TaskSchema.parse(updated);

    // Optimistic write: re-read and compare version
    // (In single-scheduler env this is near-certain, but guards against manual edits)
    const reRead = this.readRaw(filePath);
    if (reRead && reRead.version !== expectedVersion) {
      return null; // version conflict
    }

    this.atomicWrite(filePath, updated);
    return updated;
  }

  /**
   * List all tasks, optionally filtered by status.
   */
  listTasks(filter?: { status?: TaskStatus; assigned_agent?: string }): Task[] {
    this.ensureDir();
    const files = fs.readdirSync(this.tasksDir).filter((f) => f.endsWith(".json"));

    const tasks: Task[] = [];
    for (const file of files) {
      const task = this.readValidated(path.join(this.tasksDir, file));
      if (!task) continue;

      if (filter?.status && task.status !== filter.status) continue;
      if (filter?.assigned_agent && task.assigned_agent !== filter.assigned_agent) continue;

      tasks.push(task);
    }

    // Sort by creation time, oldest first
    tasks.sort((a, b) => a.created_at - b.created_at);
    return tasks;
  }

  /**
   * Delete a task JSON file.
   */
  deleteTask(taskId: string): boolean {
    const filePath = this.taskPath(taskId);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  /**
   * Find all tasks that depend on the given task ID.
   */
  findDependents(taskId: string): Task[] {
    return this.listTasks().filter((t) => t.dependency === taskId);
  }

  /**
   * Walk the dependency chain upward from a task to detect cycles.
   * Throws if a cycle is detected or the chain exceeds a safe depth.
   */
  private checkDependencyCycle(startDepId: string): void {
    const visited = new Set<string>();
    let current = startDepId;
    const maxDepth = 20;

    for (let depth = 0; depth < maxDepth; depth++) {
      if (visited.has(current)) {
        throw new Error(
          `Dependency cycle detected: task "${current}" appears twice in the dependency chain`
        );
      }
      visited.add(current);

      const depTask = this.getTask(current);
      if (!depTask || !depTask.dependency) break;

      current = depTask.dependency;
    }
  }

  /**
   * Count tasks by status.
   */
  countByStatus(status: TaskStatus): number {
    return this.listTasks({ status }).length;
  }

  // ---- Internal helpers ----

  private taskPath(taskId: string): string {
    return path.join(this.tasksDir, `task_${taskId}.json`);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.tasksDir)) {
      fs.mkdirSync(this.tasksDir, { recursive: true });
    }
  }

  /**
   * Atomically write JSON to a file: write to .tmp then rename.
   */
  private atomicWrite(filePath: string, data: unknown): void {
    const tmpPath = filePath + ".tmp." + uuidv4().slice(0, 8);
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      // Clean up temp file on failure
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }

  /**
   * Read and validate a task file. Returns null on any error.
   */
  private readValidated(filePath: string): Task | null {
    const raw = this.readRaw(filePath);
    if (!raw) return null;

    try {
      return TaskSchema.parse(raw) as Task;
    } catch {
      return null; // corrupted file
    }
  }

  /**
   * Read raw JSON from a task file. Returns null if not found.
   */
  private readRaw(filePath: string): { version: number; [key: string]: unknown } | null {
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      return null;
    }
  }
}
