import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { TaskStore } from "../task/task-store";

describe("TaskStore — atomic CRUD", () => {
  let tmpDir: string;
  let store: TaskStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-test-"));
    fs.mkdirSync(path.join(tmpDir, ".multiagent", "tasks"), { recursive: true });
    store = new TaskStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a task with valid data", () => {
    const task = store.createTask({
      description: "Fix login bug",
      target_files: ["src/auth.ts"],
    });

    expect(task.id).toBeDefined();
    expect(task.status).toBe("pending");
    expect(task.version).toBe(1);
    expect(task.description).toBe("Fix login bug");
    expect(task.target_files).toEqual(["src/auth.ts"]);
  });

  it("reads a task by ID", () => {
    const created = store.createTask({
      description: "Fix login bug",
      target_files: ["src/auth.ts"],
    });

    const read = store.getTask(created.id);
    expect(read).not.toBeNull();
    expect(read!.description).toBe("Fix login bug");
  });

  it("returns null for non-existent task", () => {
    const task = store.getTask("non-existent-id");
    expect(task).toBeNull();
  });

  it("updates task with optimistic concurrency", () => {
    const created = store.createTask({
      description: "Fix login bug",
      target_files: ["src/auth.ts"],
    });

    const updated = store.updateTask(created.id, () => ({
      status: "in_progress",
      assigned_agent: "agent-1",
    }));

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("in_progress");
    expect(updated!.assigned_agent).toBe("agent-1");
    expect(updated!.version).toBe(2);
  });

  it("rejects update if task not found", () => {
    const result = store.updateTask("nonexistent", () => ({ status: "done" }));
    expect(result).toBeNull();
  });

  it("lists tasks filtered by status", () => {
    store.createTask({ description: "Task A", target_files: ["a.ts"] });
    store.createTask({ description: "Task B", target_files: ["b.ts"] });

    const all = store.listTasks();
    expect(all).toHaveLength(2);

    const pending = store.listTasks({ status: "pending" });
    expect(pending).toHaveLength(2);
  });

  it("deletes a task", () => {
    const created = store.createTask({
      description: "Temp task",
      target_files: ["x.ts"],
    });

    const deleted = store.deleteTask(created.id);
    expect(deleted).toBe(true);
    expect(store.getTask(created.id)).toBeNull();
  });

  it("counts tasks by status", () => {
    store.createTask({ description: "Task 1", target_files: ["a.ts"] });
    store.createTask({ description: "Task 2", target_files: ["b.ts"] });

    const count = store.countByStatus("pending");
    expect(count).toBe(2);

    const doneCount = store.countByStatus("done");
    expect(doneCount).toBe(0);
  });

  it("handles task with dependency", () => {
    const dep = store.createTask({
      description: "Dependency task",
      target_files: ["dep.ts"],
    });

    const child = store.createTask({
      description: "Child task",
      target_files: ["child.ts"],
      dependency: dep.id,
    });

    expect(child.dependency).toBe(dep.id);
  });

  it("persists task to disk and re-reads correctly", () => {
    const created = store.createTask({
      description: "Persistent task",
      target_files: ["p.ts"],
    });

    // Create a new store instance (simulating restart)
    const store2 = new TaskStore(tmpDir);
    const read = store2.getTask(created.id);

    expect(read).not.toBeNull();
    expect(read!.description).toBe("Persistent task");
    expect(read!.status).toBe("pending");
  });
});
