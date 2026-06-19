import { LockManager } from "./lock-manager";
import { LockSchema } from "../data/schemas";
import type { Lock, LockPhase } from "../data/models";

/**
 * Lease Manager — Graded TTL with active health probing.
 *
 * Constants (from v3.0 optimization 6):
 *   INITIAL_TTL        = 60s  — short leash on new/untrusted agents
 *   STABLE_TTL         = 180s — long lease for proven agents
 *   STABLE_THRESHOLD   = 2    — renewals before upgrading to stable
 *   PROBE_TIMEOUT      = 45s  — no heartbeat → agent is suspect
 *
 * Heartbeat intervals:
 *   Initial phase: 25s (must renew frequently)
 *   Stable phase:  60s (reduced overhead)
 */

export class LeaseManager {
  private lockManager: LockManager;

  // Configurable constants
  readonly INITIAL_TTL_MS: number;
  readonly STABLE_TTL_MS: number;
  readonly STABLE_THRESHOLD: number;
  readonly PROBE_TIMEOUT_MS: number;

  readonly INITIAL_HEARTBEAT_MS: number;
  readonly STABLE_HEARTBEAT_MS: number;

  constructor(lockManager: LockManager, config?: {
    initialTtlMs?: number;
    stableTtlMs?: number;
    stableThreshold?: number;
    probeTimeoutMs?: number;
  }) {
    this.lockManager = lockManager;

    this.INITIAL_TTL_MS = config?.initialTtlMs ?? 60_000;
    this.STABLE_TTL_MS = config?.stableTtlMs ?? 180_000;
    this.STABLE_THRESHOLD = config?.stableThreshold ?? 2;
    this.PROBE_TIMEOUT_MS = config?.probeTimeoutMs ?? 45_000;

    // Heartbeat intervals: slightly less than half the TTL for safety margin
    this.INITIAL_HEARTBEAT_MS = Math.floor(this.INITIAL_TTL_MS / 2.4);
    this.STABLE_HEARTBEAT_MS = Math.floor(this.STABLE_TTL_MS / 3);
  }

  // ---- Public API ----

  /**
   * Calculate the appropriate TTL for a lock based on its current phase.
   */
  getTtl(lock: Lock): number {
    return lock.phase === "stable" ? this.STABLE_TTL_MS : this.INITIAL_TTL_MS;
  }

  /**
   * Get the heartbeat interval for a lock based on its current phase.
   */
  getHeartbeatInterval(lock: Lock): number {
    return lock.phase === "stable" ? this.STABLE_HEARTBEAT_MS : this.INITIAL_HEARTBEAT_MS;
  }

  /**
   * Create a new lease (initial phase, short TTL).
   */
  createLease(file: string, holder: string, taskId: string): Lock {
    const now = Date.now();
    return {
      file,
      holder,
      task_id: taskId,
      expires_at: now + this.INITIAL_TTL_MS,
      phase: "initial",
      last_heartbeat: now,
      renew_count: 0,
      created_at: now,
    };
  }

  /**
   * Renew a lease — refreshes expires_at and handles phase upgrade.
   *
   * After STABLE_THRESHOLD successful renewals, the lock upgrades
   * from "initial" to "stable", doubling the TTL.
   */
  renewLease(file: string, agentId: string): Lock | null {
    const current = this.lockManager.getLock(file);
    if (!current || current.holder !== agentId) return null;

    const nextRenewCount = current.renew_count + 1;
    const newPhase: LockPhase =
      nextRenewCount >= this.STABLE_THRESHOLD ? "stable" : "initial";
    const newTtl = newPhase === "stable" ? this.STABLE_TTL_MS : this.INITIAL_TTL_MS;
    const now = Date.now();

    const updated = this.lockManager.renew(file, agentId, now + newTtl);

    if (updated && newPhase !== current.phase) {
      // Phase transition happened — write the updated phase
      updated.phase = newPhase;
      LockSchema.parse(updated);
      // The lock manager wrote via renew already, but we need to update phase.
      // Read, update phase, write back atomically.
      // (Minor: this is a second write, but phase transitions are rare — only twice per lock)
      return this.lockManager.renew(file, agentId, now + newTtl);
    }

    return updated;
  }

  /**
   * Check if a lock has expired.
   */
  isExpired(lock: Lock): boolean {
    return Date.now() >= lock.expires_at;
  }

  /**
   * Check if a lock's holder is potentially dead.
   * "Dead" = no heartbeat within PROBE_TIMEOUT_MS.
   */
  isHeartbeatOverdue(lock: Lock): boolean {
    const idleTime = Date.now() - lock.last_heartbeat;
    return idleTime >= this.PROBE_TIMEOUT_MS;
  }

  /**
   * Get the idle time (ms since last heartbeat) for a lock.
   */
  getIdleTime(lock: Lock): number {
    return Date.now() - lock.last_heartbeat;
  }

  /**
   * Time remaining until expiry, in milliseconds.
   */
  timeUntilExpiry(lock: Lock): number {
    return Math.max(0, lock.expires_at - Date.now());
  }

  /**
   * Scan all locks and return those that are either expired
   * or whose holder hasn't heartbeated recently enough.
   */
  findStaleLocks(): { expired: Lock[]; overdue: Lock[] } {
    const allLocks = this.lockManager.listLocks();
    const expired: Lock[] = [];
    const overdue: Lock[] = [];

    for (const lock of allLocks) {
      if (this.isExpired(lock)) {
        expired.push(lock);
      } else if (this.isHeartbeatOverdue(lock)) {
        overdue.push(lock);
      }
    }

    return { expired, overdue };
  }

  /**
   * Force-release an expired lock (called by health monitor).
   */
  forceExpire(file: string): boolean {
    return this.lockManager.forceRelease(file);
  }
}
