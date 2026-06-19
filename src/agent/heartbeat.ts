import { LockManager } from "../lock/lock-manager";
import { LeaseManager } from "../lock/lease-manager";
import type { Lock } from "../data/models";

/**
 * Heartbeat — periodic lock renewal to keep leases alive.
 *
 * Runs on a configurable interval, renewing all locks held
 * by the agent. The interval adapts to the lock phase:
 *   - initial phase: shorter interval (~25s for 60s TTL)
 *   - stable phase: longer interval (~60s for 180s TTL)
 */

export class Heartbeat {
  private lockManager: LockManager;
  private leaseManager: LeaseManager;
  private agentId: string;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  // Callbacks
  private onRenew: ((file: string, lock: Lock) => void) | null = null;
  private onError: ((file: string, err: Error) => void) | null = null;

  constructor(
    lockManager: LockManager,
    leaseManager: LeaseManager,
    agentId: string
  ) {
    this.lockManager = lockManager;
    this.leaseManager = leaseManager;
    this.agentId = agentId;
  }

  /**
   * Register a callback invoked after each successful renewal.
   */
  setOnRenew(cb: (file: string, lock: Lock) => void): void {
    this.onRenew = cb;
  }

  /**
   * Register a callback invoked on renewal failure.
   */
  setOnError(cb: (file: string, err: Error) => void): void {
    this.onError = cb;
  }

  /**
   * Start periodic heartbeat.
   * @param lockFiles - the lock files to renew (may change over time)
   */
  start(getLockFiles: () => string[]): void {
    if (this.running) return;
    this.running = true;

    const tick = () => {
      if (!this.running) return;

      const files = getLockFiles();
      for (const file of files) {
        try {
          const renewed = this.leaseManager.renewLease(file, this.agentId);
          if (renewed && this.onRenew) {
            this.onRenew(file, renewed);
          }
        } catch (err) {
          if (this.onError) {
            this.onError(file, err instanceof Error ? err : new Error(String(err)));
          }
        }
      }

      // Schedule next tick
      // Use the shortest interval among all currently held locks
      const interval = this.computeInterval(files);
      this.timer = setTimeout(tick, interval);
    };

    // Start immediately with a tick
    tick();
  }

  /**
   * Stop the heartbeat.
   */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Compute the heartbeat interval based on current locks.
   * Uses the shortest appropriate interval among all locks.
   */
  private computeInterval(files: string[]): number {
    let minInterval = this.leaseManager.INITIAL_HEARTBEAT_MS;

    for (const file of files) {
      const lock = this.lockManager.getLock(file);
      if (lock) {
        const interval = this.leaseManager.getHeartbeatInterval(lock);
        if (interval < minInterval) {
          minInterval = interval;
        }
      }
    }

    return minInterval;
  }

  /**
   * Get all lock files currently held by this agent.
   */
  getHeldLocks(): string[] {
    const locks = this.lockManager.listLocks({ holder: this.agentId });
    return locks.map((l) => l.file);
  }
}
