import { EventEmitter } from "node:events";
import type { LaolEvents } from "../data/models";

/**
 * Type-safe EventBus wrapping Node's EventEmitter.
 *
 * Usage:
 *   const bus = new EventBus();
 *   bus.on("task_created", (task) => { ... });
 *   bus.emit("task_created", task);
 */

type EventHandler<T extends unknown[]> = (...args: T) => void;

export class EventBus {
  private emitter = new EventEmitter();

  // Increase max listeners — we may have many agents + watchers
  constructor() {
    this.emitter.setMaxListeners(64);
  }

  /** Register an event listener. */
  on<E extends keyof LaolEvents>(
    event: E,
    handler: EventHandler<LaolEvents[E]>
  ): this {
    this.emitter.on(event as string, handler as (...args: unknown[]) => void);
    return this;
  }

  /** Register a one-shot event listener. */
  once<E extends keyof LaolEvents>(
    event: E,
    handler: EventHandler<LaolEvents[E]>
  ): this {
    this.emitter.once(event as string, handler as (...args: unknown[]) => void);
    return this;
  }

  /** Remove an event listener. */
  off<E extends keyof LaolEvents>(
    event: E,
    handler: EventHandler<LaolEvents[E]>
  ): this {
    this.emitter.off(event as string, handler as (...args: unknown[]) => void);
    return this;
  }

  /** Emit an event. */
  emit<E extends keyof LaolEvents>(
    event: E,
    ...args: LaolEvents[E]
  ): boolean {
    return this.emitter.emit(event as string, ...args);
  }

  /** Remove all listeners for an event, or all listeners entirely. */
  removeAllListeners(event?: keyof LaolEvents): this {
    this.emitter.removeAllListeners(event as string);
    return this;
  }

  /** Get the count of listeners for an event. */
  listenerCount(event: keyof LaolEvents): number {
    return this.emitter.listenerCount(event as string);
  }

  /** Return array of event names with active listeners. */
  eventNames(): (keyof LaolEvents)[] {
    return this.emitter.eventNames() as (keyof LaolEvents)[];
  }
}
