import * as net from "node:net";
import { EventEmitter } from "node:events";
import type { SocketMessage } from "./socket-server";

/**
 * Socket Client — used by Agent workers to connect to the scheduler.
 *
 * Features:
 * - Auto-reconnect with exponential backoff
 * - JSON-line protocol
 * - Non-blocking event-driven receive
 */

export class SocketClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private host: string;
  private port: number;
  private agentId: string;
  private buffer = "";
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;

  constructor(agentId: string, port: number, host = "127.0.0.1") {
    super();
    this.agentId = agentId;
    this.port = port;
    this.host = host;
  }

  /**
   * Connect to the scheduler's TCP server.
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();

      const onError = (err: Error) => {
        reject(err);
      };

      this.socket.once("connect", () => {
        this.socket!.removeListener("error", onError);
        this.reconnectAttempts = 0;

        // Register with the scheduler
        this.send({ type: "register", agent_id: this.agentId });

        this.emit("connected");
        resolve();
      });

      this.socket.once("error", onError);

      this.socket.on("data", (data: Buffer) => {
        this.buffer += data.toString("utf-8");
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg: SocketMessage = JSON.parse(line);
            this.emit("message", msg);
            this.emit(msg.type, msg);
          } catch {
            // Ignore malformed messages
          }
        }
      });

      this.socket.on("close", () => {
        this.emit("disconnected");
        this.socket = null;

        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      this.socket.on("error", () => {
        // 'close' will fire after 'error', handling reconnection there
      });

      this.socket.connect(this.port, this.host);
    });
  }

  /**
   * Send a message to the scheduler.
   */
  send(message: SocketMessage): boolean {
    if (!this.socket || this.socket.destroyed) {
      return false;
    }

    try {
      this.socket.write(JSON.stringify(message) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send a heartbeat message with current lock list.
   */
  sendHeartbeat(locks: string[]): boolean {
    return this.send({
      type: "heartbeat",
      agent_id: this.agentId,
      locks,
    });
  }

  /**
   * Notify the scheduler that a task is done.
   */
  notifyTaskDone(taskId: string): boolean {
    return this.send({
      type: "task_done",
      agent_id: this.agentId,
      task_id: taskId,
    });
  }

  /**
   * Notify the scheduler that a task has failed.
   */
  notifyTaskFailed(taskId: string, reason: string): boolean {
    return this.send({
      type: "task_failed",
      agent_id: this.agentId,
      task_id: taskId,
      reason,
    });
  }

  /**
   * Disconnect from the scheduler.
   */
  disconnect(): void {
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  /**
   * Check if the client is currently connected.
   */
  get isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  // ---- Internal ----

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    // Exponential backoff: 1s, 2s, 4s, 8s, ..., max 30s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        // Will schedule another reconnect via 'close' event
      }
    }, delay);
  }
}
