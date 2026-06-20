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

  // Callback invoked when health monitor wants to ping an agent.
  // The scheduler wires this to socketServer.pingAgent().
  private onPingRequest: ((agentId: string) => void) | null = null;

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
   * Register a callback that sends a ping to an agent.
   * Called when the health monitor detects an overdue heartbeat and wants
   * to probe whether the agent is still alive.
   */
  setOnPingRequest(cb: (agentId: string) => void): void {
    this.onPingRequest = cb;
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
      // Ping was sent but no response — check if timed out
      const pingAge = Date.now() - lastPing;
      if (pingAge >= this.PING_RESPONSE_TIMEOUT_MS) {
        // Agent is unresponsive — delegate cleanup to scheduler
        console.log(
          `[health] Agent "${lock.holder}" unresponsive (${Math.round(pingAge / 1000)}s since ping), ` +
          `marking as lost`
        );
        this.pendingPings.delete(lock.holder);
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

    // Send the actual ping via the registered callback
    if (this.onPingRequest) {
      this.onPingRequest(lock.holder);
    }
  }

  /**
   * Check for pings that have timed out and weren't caught by the
   * per-lock overdue check (e.g. agent's locks were all force-released
   * in a previous cycle but the ping tracking still has the agent).
   */
  private checkPendingPings(): void {
    const now = Date.now();

    for (const [agentId, pingTime] of this.pendingPings) {
      if (now - pingTime >= this.PING_RESPONSE_TIMEOUT_MS) {
        console.log(
          `[health] Agent "${agentId}" unresponsive to ping (${Math.round((now - pingTime) / 1000)}s), ` +
          `marking as lost`
        );
        this.pendingPings.delete(agentId);
        this.eventBus.emit("heartbeat_lost", agentId);
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
