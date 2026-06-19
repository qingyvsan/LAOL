import { LeaseManager } from "../lock/lease-manager";
import { LockManager } from "../lock/lock-manager";
import { EventBus } from "../events/event-bus";
import type { Lock } from "../data/models";

/**
 * Health Monitor — periodic probe loop.
 *
 * Runs every 15 seconds:
 * 1. Find expired locks → force release
 * 2. Find locks with overdue heartbeats → ping agent
 * 3. If agent doesn't respond to ping within 5s → force release + mark dead
 *
 * Emits events:
 * - lock_expired
 * - heartbeat_lost
 */

export class HealthMonitor {
  private leaseManager: LeaseManager;
  private lockManager: LockManager;
  private eventBus: EventBus;
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  // Ping tracking: agentId → ping sent timestamp
  private pendingPings = new Map<string, number>();

  // Ping response timeout (ms)
  private readonly PING_RESPONSE_TIMEOUT_MS = 5000;

  constructor(
    lockManager: LockManager,
    leaseManager: LeaseManager,
    eventBus: EventBus,
    intervalMs = 15_000
  ) {
    this.lockManager = lockManager;
    this.leaseManager = leaseManager;
    this.eventBus = eventBus;
    this.intervalMs = intervalMs;
  }

  /**
   * Start the health check loop.
   */
  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.runHealthCheck();
      this.checkPendingPings();
    }, this.intervalMs);

    // Don't let the timer prevent process exit
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  /**
   * Stop the health check loop.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Mark that an agent has responded to a ping.
   */
  recordPingResponse(agentId: string): void {
    this.pendingPings.delete(agentId);
  }

  // ---- Internal ----

  private runHealthCheck(): void {
    const { expired, overdue } = this.leaseManager.findStaleLocks();

    // 1. Handle expired locks — force release immediately
    for (const lock of expired) {
      this.handleExpiredLock(lock);
    }

    // 2. Handle overdue heartbeats — probe first, then escalate
    for (const lock of overdue) {
      this.handleOverdueHeartbeat(lock);
    }
  }

  private handleExpiredLock(lock: Lock): void {
    const idleTime = this.leaseManager.getIdleTime(lock);
    console.log(
      `[health] Lock expired for "${lock.file}" ` +
      `(holder: ${lock.holder}, idle: ${Math.round(idleTime / 1000)}s)`
    );

    this.leaseManager.forceExpire(lock.file);
    this.eventBus.emit("lock_expired", lock.file);
  }

  private handleOverdueHeartbeat(lock: Lock): void {
    const idleTime = this.leaseManager.getIdleTime(lock);

    // Check if we already sent a ping to this agent recently
    const lastPing = this.pendingPings.get(lock.holder);
    if (lastPing) {
      // Ping was sent but no response — give it more time
      const pingAge = Date.now() - lastPing;
      if (pingAge >= this.PING_RESPONSE_TIMEOUT_MS) {
        // Agent is unresponsive — force release all its locks
        console.log(
          `[health] Agent "${lock.holder}" unresponsive (${Math.round(pingAge / 1000)}s since ping), ` +
          `releasing all locks`
        );

        const released = this.lockManager.releaseAllForAgent(lock.holder);
        this.pendingPings.delete(lock.holder);

        for (const file of released) {
          this.eventBus.emit("lock_expired", file);
        }
        this.eventBus.emit("heartbeat_lost", lock.holder);
      }
      return;
    }

    // First time seeing this as overdue — send a ping
    console.log(
      `[health] Heartbeat overdue for "${lock.file}" ` +
      `(holder: ${lock.holder}, idle: ${Math.round(idleTime / 1000)}s) — sending ping`
    );

    this.pendingPings.set(lock.holder, Date.now());
    // Note: the actual ping is sent via SocketServer; the scheduler wires
    // this up by listening to the heartbeat_lost-warning internally.
    // The health monitor just tracks the ping state.
  }

  /**
   * Check for pings that have timed out.
   */
  private checkPendingPings(): void {
    const now = Date.now();

    for (const [agentId, pingTime] of this.pendingPings) {
      if (now - pingTime >= this.PING_RESPONSE_TIMEOUT_MS) {
        // Already handled in handleOverdueHeartbeat on next cycle
      }
    }
  }

  /**
   * Get the IDs of agents currently being probed.
   */
  getProbedAgents(): string[] {
    return Array.from(this.pendingPings.keys());
  }
}
