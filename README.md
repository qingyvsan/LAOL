# LAOL — Multi-Agent Collaborative Coding System

> **Zero databases. Zero message queues.** File-system-level atomic locks. Git worktree isolation. AI-powered semantic merge. Agents auto-discover files at runtime.

LAOL lets multiple Claude Code AI agents safely modify the same codebase **in parallel**. Agents dynamically discover which files to edit — no need to pre-declare targets. The scheduler handles lock acquisition on-demand, so agents can expand their scope mid-task without conflicts.

## Architecture

```
                           ┌──────────────────────┐
                           │   .multiagent/        │
                           │   ├── tasks/          │  ← User drops task JSON
                           │   ├── locks/          │  ← Atomic file locks
                           │   ├── staging/        │  ← Two-phase commit
                           │   ├── wal/            │  ← Crash recovery log
                           │   ├── warnings/       │  ← Semantic conflict alerts
                           │   └── config.json     │
                           └──────┬───────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │     Scheduler (TCP:9123)   │
                    │  ┌───────────────────────┐ │
                    │  │ Conflict Checker      │ │
                    │  │ Circuit Breaker       │ │
                    │  │ Health Monitor        │ │
                    │  │ Event Bus             │ │
                    │  └───────────────────────┘ │
                    └──────┬─────────┬───────────┘
                           │         │
              ┌────────────┘         └────────────┐
              ▼                                   ▼
    ┌──────────────────┐               ┌──────────────────┐
    │  Agent A          │               │  Agent B          │
    │  ┌──────────────┐ │               │  ┌──────────────┐ │
    │  │ Worktree A   │ │               │  │ Worktree B   │ │
    │  │ (isolated)   │ │               │  │ (isolated)   │ │
    │  │ claude -p ... │ │               │  │ claude -p ... │ │
    │  └──────────────┘ │               │  └──────────────┘ │
    └──────────────────┘               └──────────────────┘
              │                                   │
              └──────────┬────────────────────────┘
                         ▼
              ┌──────────────────────┐
              │   Semantic Merge     │
              │  L1: Auto (no conflict)  │
              │  L2: AST (diff functions)│
              │  L3: LLM (same function) │
              │  └── Sandbox CI check    │
              └──────────────────────┘
                         │
                         ▼
                    main branch
```

## How It Prevents Conflicts

| Mechanism | What it does |
|-----------|-------------|
| **Two-Phase Commit Lock** | All target files locked atomically via `staging/` → `locks/` rename. If any file is taken, the entire batch rolls back — no partial lock sets. |
| **Dynamic Lock Expansion** | Agents request locks on-demand during execution via TCP. Discovered a new dependency mid-task? Request a lock — granted or denied in real time. |
| **Conflict Pre-Check** | Before assigning a task, the scheduler checks whether any target file is already locked. Blocked tasks stay `pending`. |
| **Auto-Discovery** | No `--files`? No problem. Agents explore the codebase, identify target files, request locks, then proceed — all automatically. |
| **Graded TTL Leases** | New locks: 60s TTL. After 2 successful renewals: 180s TTL. If an agent crashes, locks auto-expire within 90s (not 300s). |
| **Semantic Warnings** | When Agent A modifies a module's exports, Agent B gets a context hint before editing that module. |
| **Agent Circuit Breaker** | 2 consecutive failures → degraded (simple tasks only). 5 → quarantined (no tasks). Prevents broken agents from burning API costs. |

## Key Design Decisions

- **File system is the database** — `rename(2)` provides atomicity on NTFS (Windows) and ext4/xfs (Linux). No SQLite, no Redis.
- **TCP localhost instead of Unix sockets** — cross-platform (Windows, Linux, macOS) with zero platform branches.
- **Optimistic concurrency for tasks** (version numbers), **pessimistic locking for files** (exclusive leases).
- **Claude Code CLI as subprocess** — agents spawn `claude -p` in isolated Git worktrees. LAOL manages the lifecycle; Claude does the coding.

## Installation

```bash
git clone <this-repo>
cd LAOL
npm install
npm run build
```

**Prerequisite:** [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) must be installed and available on your `PATH`.

## Quick Start

### 1. Initialize a project

```bash
cd /path/to/your-codebase
laol init
```

This creates `.multiagent/` with all required directories and default config.

### 2. Start the scheduler

```bash
laol scheduler start
# LAOL Scheduler
#   Repo:  /path/to/your-codebase
#   Port:  9123
#   Pool:  4 worktrees
# Scheduler is running. Press Ctrl+C to stop.
```

### 3. Start one or more agents

```bash
# Terminal 2
laol agent start --id agent-001

# Terminal 3 (optional — parallel agent)
laol agent start --id agent-002
```

### 4. Create a task

```bash
# With pre-declared files:
laol task add --description "Refactor the auth module to use async/await" \
              --files "src/auth.ts" "src/auth.test.ts"

# Or let the agent discover files automatically:
laol task add --description "Fix all TypeScript errors in the project"

# Task created: 3f7a9b2c-...
#   Status: pending
#   Files: src/auth.ts, src/auth.test.ts  (or "auto-discover")
```

### 5. Watch it work

```bash
laol status
# ┌──────────┬────────┐
# │ Pending  │ 0      │
# │ In Prog  │ 1      │
# │ Done     │ 0      │
# │ Failed   │ 0      │
# │ Locks    │ 2      │
# └──────────┴────────┘
```

The agent receives the task, acquires locks, spawns Claude Code in an isolated worktree, commits changes, and pushes the branch.

## CLI Reference

### `laol init`

Initialize `.multiagent/` in the current repository.

### `laol task`

| Command | Description |
|---------|-------------|
| `laol task add --description "..." [--files <paths...>]` | Create a task (files optional — agents auto-discover) |
| `laol task list [--status pending\|done\|failed] [--agent <id>]` | List tasks |
| `laol task show <task-id>` | Show task details |
| `laol task cancel <task-id>` | Cancel a pending task |

### `laol scheduler`

| Command | Description |
|---------|-------------|
| `laol scheduler start [--port 9123] [--pool-size 4]` | Start the scheduler |

### `laol agent`

| Command | Description |
|---------|-------------|
| `laol agent start --id <agent-id> [--port 9123] [--host 127.0.0.1]` | Start an agent |

### `laol locks`

| Command | Description |
|---------|-------------|
| `laol locks list` | List active file locks |
| `laol locks force-release <file>` | Force-release a lock |

### `laol config`

| Command | Description |
|---------|-------------|
| `laol config show` | Display current configuration |
| `laol config set <key> <value>` | Set a config value (e.g. `scheduler.port 9124`) |

### `laol status`

Show system overview: task counts, lock count, pool usage.

## Configuration

`.multiagent/config.json` (created by `laol init`):

```jsonc
{
  "scheduler": {
    "port": 9123,           // TCP port for agent connections
    "pool_size": 4          // Pre-warmed worktree count
  },
  "merge_checks": [          // Pre-merge CI validation
    { "name": "type-check", "cmd": "npx tsc --noEmit", "timeout": 60 },
    { "name": "lint",       "cmd": "npx eslint src/ --max-warnings 0", "timeout": 30 }
  ],
  "merge_driver": "ai-merge",
  "merge_driver_config": {
    "same_function_strategy": "always_llm",  // Same-function conflicts → LLM merge
    "cache_size": 100,
    "cache_ttl": 300,
    "quorum_enabled": false                   // Enable dual-model quorum merge
  },
  "llm": {
    "provider": "claude",
    "api_key_env": "ANTHROPIC_API_KEY",
    "model": "claude-sonnet-4-6",
    "secondary_model": "claude-haiku-4-5"     // Optional, for quorum mode
  },
  "agent": {
    "heartbeat_interval_ms": 25000,
    "checkpoint_min_interval_ms": 30000,
    "perception_check_interval_ms": 15000
  },
  "locks": {
    "initial_ttl_ms": 60000,   // New lock TTL (60s)
    "stable_ttl_ms": 180000,   // Stable lock TTL (180s)
    "stable_threshold": 2,     // Renewals before stable
    "probe_timeout_ms": 45000  // Max idle before ping probe
  },
  "claude_executor": {
    "binary_path": "claude",
    "timeout_seconds": 300,    // Max execution time per task
    "max_budget_usd": 5,       // API cost limit per task
    "allowed_tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    "effort": "high",          // low | medium | high | max
    "skip_permissions": true   // Skip interactive permission prompts
  }
}
```

## Task Lifecycle (End to End)

```
User drops task JSON → tasks/
    │
    ▼
chokidar fires "task_created" event
    │
    ▼
Scheduler.runAssignmentLoop()
    ├── ConflictChecker.canAssign(task)
    │   ├── Are any target files locked? → Block
    │   ├── Is the dependency task done? → If not, skip
    │   └── Check registry for semantic warnings → Inject hints
    │
    ├── CircuitBreaker.canAcceptTask(agent, complexity)
    │   ├── normal    → any task
    │   ├── degraded  → simple tasks only (≤2 files)
    │   └── quarantined → no tasks
    │
    ├── LockManager.acquire(task_id, agent_id, files)
    │   ├── Write staging/{task_id}.intent
    │   ├── For each file: write Lock data, renameSync → locks/{file}.lock
    │   └── On any failure: rollback all prior locks
    │
    ├── TaskStore.updateTask(task_id, status: "in_progress")
    │
    └── SocketServer → notify agent: { event: "task_assigned", task_id }
            │
            ▼
AgentRunner.handleTaskAssigned(msg)
    │
    └── AgentWorker.executeTask(task, executor)
        ├── Heartbeat.start()           # Renews locks every 25s
        ├── Perception.start()          # Watches warnings/ directory
        ├── WorktreePool.acquire()      # Grab pre-warmed worktree
        ├── Checkpoint.checkAndRebase() # Fetch latest main, rebase if needed
        │
        ├── ClaudeCodeExecutor.execute(worktreePath, task, hints)
        │   └── spawn("claude", ["-p", prompt, "--output-format", "text", ...])
        │       ├── Claude reads target files
        │       ├── Claude makes edits
        │       └── Claude exits 0 → success
        │
        ├── git add -A && git commit
        ├── git push origin agent/{task_id}
        ├── LockManager.releaseAll()
        ├── TaskStore.updateTask(task_id, status: "done")
        ├── SocketClient.notifyTaskDone(task_id)
        └── WorktreePool.release()      # Return worktree to pool
```

## Development

```bash
npm install
npm run build       # TypeScript → dist/
npm test            # Vitest (197 tests, 16 files)
npm run dev         # Watch mode
```

### Project Structure

```
src/
├── data/            # TypeScript types + Zod schemas
├── task/            # Task JSON CRUD + chokidar watcher
├── lock/            # Two-phase commit locks + TTL leases + symbol resolver
├── scheduler/       # Event-driven scheduler + conflict checker + circuit breaker + health monitor
├── agent/           # Agent worker + heartbeat + checkpoint + perception + Claude executor
├── worktree/        # Git worktree pool
├── merge/           # 3-level merge: L1 auto / L2 AST / L3 LLM + sandbox validator
├── events/          # EventBus (internal) + TCP socket server/client (cross-platform IPC)
├── wal/             # Write-ahead log for crash recovery
├── registry/        # Semantic change registry (module export tracking)
├── cli/             # Commander-based CLI (7 command groups)
└── __tests__/       # 16 test files, 197 tests
```

## License

MIT
