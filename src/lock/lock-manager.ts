import * as fs from "node:fs";
import * as path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { LockSchema } from "../data/schemas";
import type { Lock, AcquireResult } from "../data/models";

/**
 * Atomic Lock Manager — Two-Phase Commit via rename(2) atomicity.
 *
 * Phase 1: Write intent file to staging/{task_id}.intent
 * Phase 2: Atomically rename staging/{task_id}.intent → locks/{sanitized}.lock
 *          If rename fails (EEXIST/EPERM on Windows), rollback all locks.
 *
 * File path sanitization: "src/auth.ts" → "src#auth.ts" for flat lock filenames.
 * Symbol-level keys: "src/auth.ts#login" — the '#' separates file from symbol.
 */

export class LockManager {
  private locksDir: string;
  private stagingDir: string;

  constructor(repoRoot: string) {
    this.locksDir = path.join(repoRoot, ".multiagent", "locks");
    this.stagingDir = path.join(repoRoot, ".multiagent", "staging");
    this.ensureDirs();
  }

  // ---- Public API ----

  /**
   * Atomically acquire locks for all target files.
   *
   * If any acquire fails, ALL previously acquired locks in this batch
   * are rolled back, guaranteeing no partial lock sets.
   */
  acquire(taskId: string, agentId: string, targetFiles: string[], ttlMs = 60_000): AcquireResult {
    const now = Date.now();

    // Deduplicate files
    const files = [...new Set(targetFiles)];

    if (files.length === 0) {
      return { success: false, reason: "No target files specified" };
    }

    // Phase 1: Write intent file to staging/ (temporary placeholder)
    const intentPath = path.join(this.stagingDir, `${taskId}.intent`);
    const placeholderData = { phase: "intent", task_id: taskId, agent_id: agentId };

    try {
      fs.writeFileSync(intentPath, JSON.stringify(placeholderData, null, 2), "utf-8");
    } catch (err) {
      return { success: false, reason: `Failed to write intent file: ${err}` };
    }

    const acquiredLocks: Lock[] = [];
    let intentConsumed = false;

    // Phase 2: For each file, atomically write lock files
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const lockPath = this.lockPath(file);

      // Check if already locked
      if (fs.existsSync(lockPath)) {
        this.rollback(acquiredLocks, intentPath, intentConsumed);
        return {
          success: false,
          reason: `File "${file}" is already locked`,
        };
      }

      // Build proper Lock data
      const lock: Lock = {
        file,
        holder: agentId,
        task_id: taskId,
        expires_at: now + ttlMs,
        phase: "initial",
        last_heartbeat: now,
        renew_count: 0,
        created_at: now,
      };
      LockSchema.parse(lock);

      try {
        if (!intentConsumed) {
          // First file: write Lock data into the intent file, then atomically rename it to lock path
          // This reuses the intent file for the rename, providing atomic creation on NTFS
          fs.writeFileSync(intentPath, JSON.stringify(lock, null, 2), "utf-8");
          fs.renameSync(intentPath, lockPath);
          intentConsumed = true;
        } else {
          // Subsequent files: write individual lock files with atomic temp→rename
          this.atomicWriteLock(lockPath, lock);
        }
      } catch (err) {
        this.rollback(acquiredLocks, intentPath, intentConsumed);
        return {
          success: false,
          reason: `Failed to acquire lock for "${file}": ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      acquiredLocks.push(lock);
    }

    // If intent file wasn't consumed (somehow), clean it up
    if (!intentConsumed && fs.existsSync(intentPath)) {
      try { fs.unlinkSync(intentPath); } catch { /* best effort */ }
    }

    return { success: true, locks: acquiredLocks };
  }

  /**
   * Release a single lock by file path.
   */
  release(file: string): boolean {
    const lockPath = this.lockPath(file);
    if (!fs.existsSync(lockPath)) return false;
    fs.unlinkSync(lockPath);
    return true;
  }

  /**
   * Release all locks held by a specific agent (e.g. on agent death).
   */
  releaseAllForAgent(agentId: string): string[] {
    const released: string[] = [];
    const locks = this.listLocks({ holder: agentId });

    for (const lock of locks) {
      if (this.release(lock.file)) {
        released.push(lock.file);
      }
    }

    return released;
  }

  /**
   * Renew a lock — updates expires_at and heartbeat.
   * Returns the updated lock, or null if the lock doesn't exist.
   */
  renew(file: string, agentId: string, newExpiry: number, newPhase?: import("../data/models").LockPhase): Lock | null {
    const lockPath = this.lockPath(file);
    const current = this.readLockFile(lockPath);

    if (!current) return null;
    if (current.holder !== agentId) return null;

    const updated: Lock = {
      ...current,
      expires_at: newExpiry,
      last_heartbeat: Date.now(),
      renew_count: current.renew_count + 1,
      phase: newPhase ?? current.phase,
    };

    LockSchema.parse(updated);
    this.atomicWriteLock(lockPath, updated);

    // Re-read after write to close the TOCTOU window: if the lock was
    // force-released between our initial read and the atomic write, the
    // write would have resurrected the lock file. Verify the file on disk
    // still matches what we just wrote before returning success.
    const verify = this.readLockFile(lockPath);
    if (!verify || verify.holder !== agentId) {
      // Lock was released underneath us — try to clean up the resurrection
      try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
      return null;
    }

    return updated;
  }

  /**
   * Check if a specific file (or symbol) is locked.
   */
  isLocked(file: string): boolean {
    return fs.existsSync(this.lockPath(file));
  }

  /**
   * Get a lock by file path. Returns null if not locked.
   */
  getLock(file: string): Lock | null {
    return this.readLockFile(this.lockPath(file));
  }

  /**
   * List all active locks, optionally filtered.
   */
  listLocks(filter?: { holder?: string; taskId?: string }): Lock[] {
    this.ensureDirs();
    const lockFiles = fs.readdirSync(this.locksDir).filter((f) => f.endsWith(".lock"));

    const locks: Lock[] = [];
    for (const lf of lockFiles) {
      const lock = this.readLockFile(path.join(this.locksDir, lf));
      if (!lock) continue;

      if (filter?.holder && lock.holder !== filter.holder) continue;
      if (filter?.taskId && lock.task_id !== filter.taskId) continue;

      locks.push(lock);
    }

    return locks;
  }

  /**
   * Check if any of the given files is locked.
   * Returns the first conflict found, or null if all are free.
   */
  findConflict(files: string[]): { file: string; holder: string } | null {
    for (const file of files) {
      const lock = this.getLock(file);
      if (lock) {
        return { file, holder: lock.holder };
      }
    }
    return null;
  }

  /**
   * Force-release a lock (recovery tool — use with caution).
   */
  forceRelease(file: string): boolean {
    return this.release(file);
  }

  // ---- Internal helpers ----

  private lockPath(file: string): string {
    // Sanitize path separators for flat filename.
    // "src/auth.ts" → "src#auth.ts"
    // "src/auth.ts#login" → "src#auth.ts#login" (symbol-level)
    //
    // Edge case: filenames can legally contain '#' on Unix, which would
    // collide with our symbol-level delimiter. We detect the delimiter by
    // checking whether the part after the last '#' is a valid identifier
    // (no dots, no path separators) — that indicates a SymbolResolver key.
    // Literal '#' in filenames are escaped as '##'.
    const lastHashIdx = file.lastIndexOf("#");
    if (lastHashIdx > 0) {
      const afterHash = file.slice(lastHashIdx + 1);
      // Symbol delimiter: after-hash is a simple identifier (no / \ .)
      const isSymbolKey =
        afterHash.length > 0 &&
        !afterHash.includes("/") &&
        !afterHash.includes("\\") &&
        !afterHash.includes(".");
      if (isSymbolKey) {
        const filePart = file
          .slice(0, lastHashIdx)
          .replace(/#/g, "##")
          .replace(/[/\\]/g, "#");
        return path.join(this.locksDir, `${filePart}#${afterHash}.lock`);
      }
    }
    // Plain file path — escape any literal '#' then replace path separators
    const sanitized = file.replace(/#/g, "##").replace(/[/\\]/g, "#");
    return path.join(this.locksDir, `${sanitized}.lock`);
  }

  private ensureDirs(): void {
    if (!fs.existsSync(this.locksDir)) {
      fs.mkdirSync(this.locksDir, { recursive: true });
    }
    if (!fs.existsSync(this.stagingDir)) {
      fs.mkdirSync(this.stagingDir, { recursive: true });
    }
  }

  /**
   * Atomic write: temp file + rename (same as task store).
   */
  private atomicWriteLock(lockPath: string, lock: Lock): void {
    const tmpPath = lockPath + ".tmp." + uuidv4().slice(0, 8);
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(lock, null, 2), "utf-8");
      fs.renameSync(tmpPath, lockPath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }

  /**
   * Read and validate a lock file. Returns null on any error.
   */
  private readLockFile(lockPath: string): Lock | null {
    if (!fs.existsSync(lockPath)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      return LockSchema.parse(raw) as Lock;
    } catch {
      return null;
    }
  }

  /**
   * Rollback: delete all already-acquired lock files and the intent file.
   */
  private rollback(
    acquiredLocks: Lock[],
    intentPath: string,
    intentConsumed: boolean
  ): void {
    for (const lock of acquiredLocks) {
      const lockPath = this.lockPath(lock.file);
      try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
    }

    if (!intentConsumed) {
      try { fs.unlinkSync(intentPath); } catch { /* best effort */ }
    }
  }
}
