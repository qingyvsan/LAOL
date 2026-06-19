import chalk from "chalk";
import type { Task, Lock, AgentState } from "../data/models";

/**
 * Format task list as a colored table.
 */
export function formatTaskTable(tasks: Task[]): string {
  if (tasks.length === 0) {
    return chalk.dim("  (no tasks)");
  }

  const rows = tasks.map((t) => {
    const status = formatStatus(t.status);
    const id = chalk.dim(t.id.slice(0, 8));
    const desc = t.description.slice(0, 50) + (t.description.length > 50 ? "..." : "");
    const agent = t.assigned_agent ? chalk.cyan(t.assigned_agent) : chalk.dim("-");
    const files = chalk.yellow(t.target_files.join(", ").slice(0, 40));
    return `  ${id}  ${status}  ${desc.padEnd(52)}  ${agent.padEnd(12)}  ${files}`;
  });

  const header = `  ${chalk.bold("ID".padEnd(9))}${chalk.bold("STATUS".padEnd(16))}${chalk.bold("DESCRIPTION".padEnd(55))}${chalk.bold("AGENT".padEnd(14))}${chalk.bold("FILES")}`;

  return [header, ...rows].join("\n");
}

/**
 * Format lock list as a table.
 */
export function formatLockTable(locks: Lock[]): string {
  if (locks.length === 0) {
    return chalk.dim("  (no active locks)");
  }

  const rows = locks.map((l) => {
    const file = chalk.yellow(l.file.slice(0, 45));
    const holder = chalk.cyan(l.holder);
    const phase = l.phase === "stable" ? chalk.green("stable") : chalk.yellow("initial");
    const remaining = Math.max(0, Math.round((l.expires_at - Date.now()) / 1000));
    const ttl = `${remaining}s`;
    return `  ${file.padEnd(48)}  ${holder.padEnd(14)}  ${phase.padEnd(16)}  ${ttl}`;
  });

  const header = `  ${chalk.bold("FILE".padEnd(50))}${chalk.bold("HOLDER".padEnd(16))}${chalk.bold("PHASE".padEnd(18))}${chalk.bold("TTL")}`;

  return [header, ...rows].join("\n");
}

/**
 * Format agent states as a table.
 */
export function formatAgentTable(agents: AgentState[]): string {
  if (agents.length === 0) {
    return chalk.dim("  (no agents registered)");
  }

  const rows = agents.map((a) => {
    const id = chalk.cyan(a.agent_id);
    const state = formatAgentState(a.state);
    const failures = a.failures > 0 ? chalk.red(String(a.failures)) : chalk.green("0");
    return `  ${id.padEnd(16)}  ${state.padEnd(22)}  failures: ${failures}`;
  });

  return rows.join("\n");
}

/**
 * Format system-wide status overview.
 */
export function formatStatusOverview(params: {
  tasks: { total: number; pending: number; in_progress: number; done: number; failed: number };
  locks: number;
  agents: number;
  worktreePool: { available: number; in_use: number };
}): string {
  const lines: string[] = [];
  lines.push(chalk.bold("\n=== LAOL System Status ==="));
  lines.push("");
  lines.push(chalk.bold("Tasks:"));
  lines.push(`  Total: ${params.tasks.total}  |  ${chalk.yellow("Pending:")} ${params.tasks.pending}  |  ${chalk.blue("In Progress:")} ${params.tasks.in_progress}  |  ${chalk.green("Done:")} ${params.tasks.done}  |  ${chalk.red("Failed:")} ${params.tasks.failed}`);
  lines.push("");
  lines.push(chalk.bold("Resources:"));
  lines.push(`  Active Locks: ${params.locks}  |  Connected Agents: ${params.agents}`);
  lines.push(`  Worktree Pool: ${chalk.green(params.worktreePool.available)} available / ${chalk.blue(params.worktreePool.in_use)} in use`);
  lines.push("");
  return lines.join("\n");
}

// ---- Helpers ----

function formatStatus(status: string): string {
  switch (status) {
    case "pending":
      return chalk.yellow("pending".padEnd(14));
    case "in_progress":
      return chalk.blue("in_progress".padEnd(14));
    case "done":
      return chalk.green("done".padEnd(14));
    case "failed":
      return chalk.red("failed".padEnd(14));
    case "stuck":
      return chalk.magenta("stuck".padEnd(14));
    case "blocked_by_rebase":
      return chalk.redBright("blocked".padEnd(14));
    default:
      return chalk.dim(status.padEnd(14));
  }
}

function formatAgentState(state: string): string {
  switch (state) {
    case "normal":
      return chalk.green("normal");
    case "degraded":
      return chalk.yellow("degraded");
    case "quarantined":
      return chalk.red("quarantined");
    default:
      return chalk.dim(state);
  }
}
