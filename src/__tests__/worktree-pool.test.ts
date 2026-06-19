import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { v4 as uuidv4 } from "uuid";
import { WorktreePool } from "../worktree/pool";

const tid = () => uuidv4();

/**
 * Worktree Pool Tests
 *
 * Tests the worktree pre-creation and reuse mechanism.
 * Requires git to be installed. Creates a temporary bare repo.
 */
describe("WorktreePool", () => {
  let tmpDir: string;
  let repoDir: string;
  let bareDir: string;
  let pool: WorktreePool;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-wtp-"));
    bareDir = path.join(tmpDir, "bare.git");
    repoDir = path.join(tmpDir, "repo");

    // Create a bare repo as "remote"
    fs.mkdirSync(bareDir, { recursive: true });
    execSync("git init --bare --initial-branch=main", { cwd: bareDir, stdio: "pipe", timeout: 10_000 });

    // Clone from bare to create working repo with origin remote
    execSync(`git clone "${bareDir}" repo`, { cwd: tmpDir, stdio: "pipe", timeout: 10_000 });
    execSync("git config user.email test@test.com", { cwd: repoDir, stdio: "pipe", timeout: 5000 });
    execSync("git config user.name Test", { cwd: repoDir, stdio: "pipe", timeout: 5000 });

    // Create initial commit and push to origin main
    const testFile = path.join(repoDir, "README.md");
    fs.writeFileSync(testFile, "# Test Repo", "utf-8");
    execSync("git checkout -b main", { cwd: repoDir, stdio: "pipe", timeout: 5000 });
    execSync("git add -A", { cwd: repoDir, stdio: "pipe", timeout: 5000 });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: "pipe", timeout: 5000 });
    execSync("git push -u origin main", { cwd: repoDir, stdio: "pipe", timeout: 10_000 });

    // Create .multiagent directory
    fs.mkdirSync(path.join(repoDir, ".multiagent", "worktrees"), { recursive: true });

    pool = new WorktreePool(repoDir, 3);
  });

  afterEach(() => {
    try {
      pool.shutdown();
    } catch {
      // Ignore shutdown errors in cleanup
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializes the pool with the configured number of worktrees", () => {
    pool.initialize();
    const stats = pool.stats();

    expect(stats.total).toBeGreaterThanOrEqual(2); // at least 2 (may reuse existing)
    expect(stats.available).toBeGreaterThanOrEqual(2);
    expect(stats.inUse).toBe(0);
  });

  it("acquire returns a worktree path and marks it in use", () => {
    pool.initialize();
    const taskId = tid();

    const handle = pool.acquire(taskId);
    expect(handle.path).toBeDefined();
    expect(handle.branch).toBe(`agent/${taskId}`);
    expect(fs.existsSync(handle.path)).toBe(true);

    const stats = pool.stats();
    expect(stats.inUse).toBe(1);
    expect(stats.available).toBe(stats.total - 1);
  });

  it("release returns worktree to available pool", () => {
    pool.initialize();
    const taskId = tid();

    const handle = pool.acquire(taskId);
    const statsBefore = pool.stats();

    pool.release(taskId);
    const statsAfter = pool.stats();

    expect(statsAfter.inUse).toBe(statsBefore.inUse - 1);
    expect(statsAfter.available).toBe(statsBefore.available + 1);
    expect(statsAfter.total).toBe(statsBefore.total);

    // Worktree should still exist
    expect(fs.existsSync(handle.path)).toBe(true);
  });

  it("released worktree can be re-acquired", () => {
    pool.initialize();
    const taskA = tid();
    const taskB = tid();

    const handle1 = pool.acquire(taskA);
    const path1 = handle1.path;

    pool.release(taskA);

    const handle2 = pool.acquire(taskB);
    // May or may not get the same path (depends on pool order)
    expect(pool.stats().inUse).toBe(1);
  });

  it("acquire multiple tasks consumes multiple worktrees", () => {
    pool.initialize();
    const initialStats = pool.stats();

    const taskA = tid();
    const taskB = tid();

    pool.acquire(taskA);
    pool.acquire(taskB);

    const stats = pool.stats();
    expect(stats.inUse).toBe(2);
    expect(stats.available).toBe(initialStats.total - 2);
  });

  it("getWorktree returns path for in-use task", () => {
    pool.initialize();
    const taskId = tid();

    const handle = pool.acquire(taskId);
    const found = pool.getWorktree(taskId);

    expect(found).toBe(handle.path);
  });

  it("getWorktree returns null for unknown task", () => {
    pool.initialize();
    expect(pool.getWorktree("nonexistent")).toBeNull();
  });

  it("stats shows correct counts", () => {
    pool.initialize();

    const stats = pool.stats();
    expect(stats.available).toBeGreaterThanOrEqual(0);
    expect(stats.inUse).toBe(0);
    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(stats.total).toBe(stats.available + stats.inUse);
  });

  it("shutdown cleans all worktrees", () => {
    pool.initialize();

    // Acquire at least one
    const taskId = tid();
    pool.acquire(taskId);

    const worktreeDir = path.join(repoDir, ".multiagent", "worktrees");
    const beforeDirs = fs.readdirSync(worktreeDir).filter((d) => {
      return fs.statSync(path.join(worktreeDir, d)).isDirectory();
    });
    expect(beforeDirs.length).toBeGreaterThan(0);

    pool.shutdown();

    const stats = pool.stats();
    expect(stats.total).toBe(0);
    expect(stats.available).toBe(0);
    expect(stats.inUse).toBe(0);
  });

  it("re-acquire after release works correctly", () => {
    pool.initialize();
    const taskA = tid();
    const taskB = tid();

    // Acquire, release, re-acquire
    const h1 = pool.acquire(taskA);
    pool.release(taskA);
    const h2 = pool.acquire(taskB);

    expect(h2.path).toBeDefined();
    expect(h2.branch).toBe(`agent/${taskB}`);

    pool.release(taskB);
  });
});
