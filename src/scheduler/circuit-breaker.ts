import type { AgentState, AgentCondition } from "../data/models";

/**
 * Circuit Breaker — prevents failed agents from consuming resources.
 *
 * Per-agent tracking:
 *   - 2 consecutive failures → "degraded" (simple tasks only, ≤2 files)
 *   - 5 consecutive failures → "quarantined" (no tasks at all)
 *   - 1 success → reset to "normal"
 *
 * Per-task tracking:
 *   - 3 consecutive failures (by any agent) → "stuck" (notify user)
 */

export class CircuitBreaker {
  private agents = new Map<string, AgentState>();
  private tasks = new Map<string, TaskFailureState>();

  // Thresholds
  readonly FAIL_THRESHOLD_DEGRADE = 2;
  readonly FAIL_THRESHOLD_QUARANTINE = 5;
  readonly TASK_FAIL_THRESHOLD = 3;

  // Complexity threshold for degraded agents
  readonly MAX_FILES_DEGRADED = 2;

  // ---- Public API ----

  /**
   * Record a successful task completion by an agent.
   * Resets the agent's failure count to 0 and state to "normal".
   */
  onTaskSuccess(agentId: string, taskId: string): void {
    const agent = this.getOrCreateAgent(agentId);
    agent.failures = 0;
    agent.state = "normal";
    agent.last_failure_reason = null;
    agent.last_success_at = Date.now();

    // Reset task failure count on success
    this.tasks.delete(taskId);
  }

  /**
   * Record a task failure.
   * Increments both agent-level and task-level counters.
   */
  onTaskFailure(agentId: string, taskId: string, reason: string): {
    agentState: AgentCondition;
    taskStuck: boolean;
  } {
    // Agent tracking
    const agent = this.getOrCreateAgent(agentId);
    agent.failures++;
    agent.last_failure_reason = reason;

    if (agent.failures >= this.FAIL_THRESHOLD_QUARANTINE) {
      agent.state = "quarantined";
      console.log(`[breaker] Agent "${agentId}" QUARANTINED (${agent.failures} consecutive failures)`);
    } else if (agent.failures >= this.FAIL_THRESHOLD_DEGRADE) {
      agent.state = "degraded";
      console.log(`[breaker] Agent "${agentId}" DEGRADED (${agent.failures} consecutive failures)`);
    }

    // Task tracking
    const taskState = this.getOrCreateTask(taskId);
    taskState.failures++;
    taskState.lastAgent = agentId;
    taskState.lastReason = reason;

    const taskStuck = taskState.failures >= this.TASK_FAIL_THRESHOLD;
    if (taskStuck) {
      taskState.stuck = true;
      console.log(`[breaker] Task "${taskId}" STUCK (${taskState.failures} failures)`);
    }

    return {
      agentState: agent.state,
      taskStuck,
    };
  }

  /**
   * Check if an agent can accept a task of the given complexity.
   * Complexity is measured by number of target files.
   */
  canAcceptTask(agentId: string, complexity: number): { can: boolean; reason?: string } {
    const agent = this.agents.get(agentId);

    if (!agent) {
      // New agent — no history, can accept
      return { can: true };
    }

    if (agent.state === "quarantined") {
      return {
        can: false,
        reason: `Agent "${agentId}" is quarantined after ${agent.failures} consecutive failures. Last reason: ${agent.last_failure_reason}`,
      };
    }

    if (agent.state === "degraded" && complexity > this.MAX_FILES_DEGRADED) {
      return {
        can: false,
        reason: `Agent "${agentId}" is degraded — only tasks with ≤${this.MAX_FILES_DEGRADED} files allowed. This task has ${complexity} files.`,
      };
    }

    return { can: true };
  }

  /**
   * Get an agent's current state.
   */
  getAgentState(agentId: string): AgentState | null {
    return this.agents.get(agentId) ?? null;
  }

  /**
   * Get all registered agents.
   */
  getAllAgents(): AgentState[] {
    return Array.from(this.agents.values());
  }

  /**
   * Check if a task is stuck.
   */
  isTaskStuck(taskId: string): boolean {
    const ts = this.tasks.get(taskId);
    return ts?.stuck ?? false;
  }

  /**
   * Remove an agent (e.g. on disconnection).
   */
  removeAgent(agentId: string): void {
    this.agents.delete(agentId);
  }

  /**
   * Reset all state (for testing).
   */
  reset(): void {
    this.agents.clear();
    this.tasks.clear();
  }

  // ---- Internal ----

  private getOrCreateAgent(agentId: string): AgentState {
    if (!this.agents.has(agentId)) {
      this.agents.set(agentId, {
        agent_id: agentId,
        failures: 0,
        state: "normal",
        last_failure_reason: null,
        last_success_at: null,
      });
    }
    return this.agents.get(agentId)!;
  }

  private getOrCreateTask(taskId: string): TaskFailureState {
    if (!this.tasks.has(taskId)) {
      this.tasks.set(taskId, {
        taskId,
        failures: 0,
        lastAgent: null,
        lastReason: null,
        stuck: false,
      });
    }
    return this.tasks.get(taskId)!;
  }
}

// ---- Internal state ----

interface TaskFailureState {
  taskId: string;
  failures: number;
  lastAgent: string | null;
  lastReason: string | null;
  stuck: boolean;
}
