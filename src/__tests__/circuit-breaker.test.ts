import { describe, it, expect, beforeEach } from "vitest";
import { CircuitBreaker } from "../scheduler/circuit-breaker";

describe("CircuitBreaker — agent isolation", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker();
  });

  it("starts agents in normal state", () => {
    const state = breaker.getAgentState("agent-1");
    expect(state).toBeNull(); // not registered until first success/failure

    breaker.onTaskSuccess("agent-1", "task-1");
    const state2 = breaker.getAgentState("agent-1");
    expect(state2).not.toBeNull();
    expect(state2!.state).toBe("normal");
    expect(state2!.failures).toBe(0);
  });

  it("degrades agent after 2 failures", () => {
    breaker.onTaskFailure("agent-1", "task-1", "error 1");
    const state1 = breaker.getAgentState("agent-1");
    expect(state1!.state).toBe("normal");
    expect(state1!.failures).toBe(1);

    breaker.onTaskFailure("agent-1", "task-2", "error 2");
    const state2 = breaker.getAgentState("agent-1");
    expect(state2!.state).toBe("degraded");
    expect(state2!.failures).toBe(2);
  });

  it("quarantines agent after 5 failures", () => {
    for (let i = 0; i < 5; i++) {
      breaker.onTaskFailure("agent-1", `task-${i}`, `error ${i}`);
    }

    const state = breaker.getAgentState("agent-1");
    expect(state!.state).toBe("quarantined");
    expect(state!.failures).toBe(5);
  });

  it("resets agent to normal on success", () => {
    // First, fail twice to degrade
    breaker.onTaskFailure("agent-1", "task-1", "error 1");
    breaker.onTaskFailure("agent-1", "task-2", "error 2");
    expect(breaker.getAgentState("agent-1")!.state).toBe("degraded");

    // Then succeed
    breaker.onTaskSuccess("agent-1", "task-3");
    expect(breaker.getAgentState("agent-1")!.state).toBe("normal");
    expect(breaker.getAgentState("agent-1")!.failures).toBe(0);
  });

  it("restricts degraded agents from complex tasks", () => {
    breaker.onTaskFailure("agent-1", "task-1", "err");
    breaker.onTaskFailure("agent-1", "task-2", "err");

    // Simple task (≤2 files) — allowed
    const simple = breaker.canAcceptTask("agent-1", 2);
    expect(simple.can).toBe(true);

    // Complex task (>2 files) — denied
    const complex = breaker.canAcceptTask("agent-1", 5);
    expect(complex.can).toBe(false);
    expect(complex.reason).toContain("degraded");
  });

  it("denies all tasks to quarantined agents", () => {
    for (let i = 0; i < 5; i++) {
      breaker.onTaskFailure("agent-1", `task-${i}`, `error ${i}`);
    }

    const result = breaker.canAcceptTask("agent-1", 1);
    expect(result.can).toBe(false);
    expect(result.reason).toContain("quarantined");
  });

  it("tracks task stuck after 3 failures", () => {
    breaker.onTaskFailure("agent-1", "task-1", "err 1");
    breaker.onTaskFailure("agent-2", "task-1", "err 2");
    const result = breaker.onTaskFailure("agent-3", "task-1", "err 3");

    expect(result.taskStuck).toBe(true);
    expect(breaker.isTaskStuck("task-1")).toBe(true);
  });

  it("can list all registered agents", () => {
    breaker.onTaskSuccess("agent-A", "t1");
    breaker.onTaskSuccess("agent-B", "t2");

    const all = breaker.getAllAgents();
    expect(all).toHaveLength(2);
    expect(all.map((a) => a.agent_id).sort()).toEqual(["agent-A", "agent-B"]);
  });
});
