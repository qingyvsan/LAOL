import * as fs from "node:fs";
import * as path from "node:path";
import { WalRecordSchema } from "../data/schemas";
import type { WalRecord } from "../data/models";

const MAX_SEGMENT_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_SEGMENT_RECORDS = 1000;

/**
 * Write-Ahead Log for crash recovery.
 *
 * All state mutations are logged before execution.
 * On restart, uncommitted entries are reconciled.
 *
 * Format: JSONL (one JSON object per line), fsync after each write.
 * Segments: wal_0001.log, wal_0002.log, rotated at size/record limits.
 */

export class WalManager {
  private walDir: string;
  private currentSegmentPath: string | null = null;
  private currentFd: number | null = null;
  private recordCount = 0;
  private segmentSeq = 0;

  constructor(repoRoot: string) {
    this.walDir = path.join(repoRoot, ".multiagent", "wal");
    this.ensureDir();
  }

  // ---- Public API ----

  /**
   * Write a WAL record and fsync to disk.
   */
  write(record: Omit<WalRecord, "ts"> & { op: WalRecord["op"] }): void {
    const fullRecord: WalRecord = {
      ...record,
      ts: Date.now(),
    } as WalRecord;

    // Validate
    WalRecordSchema.parse(fullRecord);

    this.rotateIfNeeded();

    const line = JSON.stringify(fullRecord) + "\n";
    fs.writeSync(this.currentFd!, line);
    fs.fsyncSync(this.currentFd!);

    this.recordCount++;
  }

  /**
   * Execute a state change safely:
   * 1. Write WAL intent record
   * 2. Execute the callback
   * 3. Write WAL commit record
   *
   * If the process crashes between steps 1 and 3,
   * the recovery() method will reconcile the state.
   */
  safeStateChange(
    op: WalRecord["op"],
    data: Record<string, unknown>,
    callback: () => void
  ): void {
    this.write({ op, ...data });
    try {
      callback();
      this.write({ op: "commit", task: data.task as string });
    } catch (err) {
      this.write({
        op: "fail",
        task: data.task as string,
        reason: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Recover state after a crash.
   * Scans all WAL segments, finds uncommitted entries,
   * and returns them for the caller to reconcile.
   */
  recover(): WalRecord[] {
    const records = this.readAllSegments();

    // Find all "assign" / "acquire_lock" / "release_lock" entries
    // that don't have a matching "commit" or "fail" entry
    const committed = new Set<number>();
    const pending: WalRecord[] = [];

    // First pass: collect committed timestamps
    for (const rec of records) {
      if (rec.op === "commit" || rec.op === "fail") {
        // Find the corresponding original record
        // We match by task ID for task ops, or by file for lock ops
        if (rec.task) {
          // Mark all earlier records for this task as committed
          committed.add(rec.task as unknown as number);
        }
      }
    }

    // Second pass: find uncommitted entries
    // Actually, let's use a simpler approach: track by the record's own ts
    // A "commit" with a task field commits the most recent non-commit entry for that task
    const taskCommitMap = new Map<string, boolean>();
    const fileCommitMap = new Map<string, boolean>();

    for (const rec of records) {
      if (rec.op === "commit") {
        if (rec.task) taskCommitMap.set(rec.task, true);
      } else if (rec.op === "fail") {
        if (rec.task) taskCommitMap.set(rec.task, true); // also "resolved"
      }
    }

    for (const rec of records) {
      if (rec.op === "commit" || rec.op === "fail") continue;

      const key = rec.task ?? rec.file;
      if (key && !taskCommitMap.has(key) && !fileCommitMap.has(key)) {
        pending.push(rec);
        // Mark so we don't re-process it (only include first uncommitted per entity)
        if (rec.task) taskCommitMap.set(rec.task, true);
        if (rec.file) fileCommitMap.set(rec.file, true);
      }
    }

    if (pending.length > 0) {
      console.log(`[wal] Found ${pending.length} uncommitted records to reconcile`);
    }

    return pending;
  }

  /**
   * Write a checkpoint, indicating all previous WAL entries are committed.
   * This allows old segments to be cleaned up.
   */
  checkpoint(): void {
    this.write({ op: "commit", task: "__checkpoint__" });
    this.cleanupOldSegments();
  }

  /**
   * Close the current WAL segment.
   */
  close(): void {
    if (this.currentFd !== null) {
      fs.closeSync(this.currentFd);
      this.currentFd = null;
    }
  }

  // ---- Internal helpers ----

  private ensureDir(): void {
    if (!fs.existsSync(this.walDir)) {
      fs.mkdirSync(this.walDir, { recursive: true });
    }
  }

  private rotateIfNeeded(): void {
    if (this.currentFd !== null && this.recordCount < MAX_SEGMENT_RECORDS) {
      // Check file size
      try {
        const stat = fs.fstatSync(this.currentFd);
        if (stat.size < MAX_SEGMENT_SIZE) return;
      } catch {
        // fd might be stale, reopen
      }
    }

    // Close old segment
    if (this.currentFd !== null) {
      fs.closeSync(this.currentFd);
    }

    // Create new segment
    this.segmentSeq++;
    const segName = `wal_${String(this.segmentSeq).padStart(4, "0")}.log`;
    this.currentSegmentPath = path.join(this.walDir, segName);
    this.currentFd = fs.openSync(this.currentSegmentPath, "a");
    this.recordCount = 0;
  }

  private readAllSegments(): WalRecord[] {
    this.ensureDir();

    const files = fs
      .readdirSync(this.walDir)
      .filter((f) => f.startsWith("wal_") && f.endsWith(".log"))
      .sort(); // chronological order

    const records: WalRecord[] = [];

    for (const file of files) {
      const content = fs.readFileSync(path.join(this.walDir, file), "utf-8");
      const lines = content.trim().split("\n");

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = WalRecordSchema.parse(JSON.parse(line));
          records.push(parsed as WalRecord);
        } catch {
          // Skip corrupted lines
        }
      }
    }

    return records;
  }

  private cleanupOldSegments(): void {
    // Keep only the last 5 segments
    this.ensureDir();
    const files = fs
      .readdirSync(this.walDir)
      .filter((f) => f.startsWith("wal_") && f.endsWith(".log"))
      .sort();

    if (files.length <= 5) return;

    const toDelete = files.slice(0, files.length - 5);
    for (const file of toDelete) {
      fs.unlinkSync(path.join(this.walDir, file));
    }
  }
}
