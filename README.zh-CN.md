# LAOL — 多智能体协作编程系统

> **零数据库。零消息队列。** 文件系统级原子锁。Git Worktree 隔离。AI 语义合并。智能体运行时自动发现目标文件。

LAOL 让多个 Claude Code AI 智能体**并行**安全地修改同一代码库。智能体可动态发现需要编辑的文件——无需预先声明。调度器按需分配锁，智能体可在任务中途扩展修改范围而不会产生冲突。

## 架构

```
                           ┌──────────────────────┐
                           │   .multiagent/        │
                           │   ├── tasks/          │  ← 用户投放任务 JSON
                           │   ├── locks/          │  ← 原子文件锁
                           │   ├── staging/        │  ← 两阶段提交
                           │   ├── wal/            │  ← 崩溃恢复日志
                           │   ├── warnings/       │  ← 语义冲突告警
                           │   └── config.json     │
                           └──────┬───────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │     调度器 (TCP:9123)       │
                    │  ┌───────────────────────┐ │
                    │  │ 冲突检测器             │ │
                    │  │ 熔断器                 │ │
                    │  │ 健康监控               │ │
                    │  │ 事件总线               │ │
                    │  └───────────────────────┘ │
                    └──────┬─────────┬───────────┘
                           │         │
              ┌────────────┘         └────────────┐
              ▼                                   ▼
    ┌──────────────────┐               ┌──────────────────┐
    │  智能体 A         │               │  智能体 B         │
    │  ┌──────────────┐ │               │  ┌──────────────┐ │
    │  │ Worktree A   │ │               │  │ Worktree B   │ │
    │  │ (隔离环境)    │ │               │  │ (隔离环境)    │ │
    │  │ claude -p ... │ │               │  │ claude -p ... │ │
    │  └──────────────┘ │               │  └──────────────┘ │
    └──────────────────┘               └──────────────────┘
              │                                   │
              └──────────┬────────────────────────┘
                         ▼
              ┌──────────────────────┐
              │     语义合并          │
              │  L1: 自动（无冲突）    │
              │  L2: AST（不同函数）   │
              │  L3: LLM（同一函数）   │
              │  └── 沙箱 CI 检查     │
              └──────────────────────┘
                         │
                         ▼
                      main 分支
```

## 如何防止冲突

| 机制 | 说明 |
|------|------|
| **两阶段提交锁** | 通过 `staging/` → `locks/` 的重命名操作，原子性地锁定所有目标文件。如有任一文件被占用，整个批次回滚——不会出现部分锁定的情况。 |
| **动态锁扩展** | 智能体执行期间可通过 TCP 实时请求额外文件锁。中途发现新依赖？请求锁——实时批准或拒绝。 |
| **冲突预检** | 分配任务前，调度器检查是否已有目标文件被锁定。被阻塞的任务保持 `pending` 状态。 |
| **自动发现** | 不指定 `--files`？没问题。智能体先探索代码库，确定目标文件，请求锁，再执行修改——全自动完成。 |
| **分级 TTL 租约** | 新锁：60 秒 TTL。成功续约 2 次后：180 秒 TTL。若智能体崩溃，锁最多 90 秒内自动过期（非 300 秒）。 |
| **语义警告** | 当智能体 A 修改某模块的导出接口时，智能体 B 在编辑该模块前会收到上下文提示。 |
| **智能体熔断器** | 2 次连续失败 → 降级（仅接受简单任务）。5 次 → 隔离（不再接受任务）。防止故障智能体持续消耗 API 费用。 |

## 核心设计决策

- **文件系统即数据库** — `rename(2)` 在 NTFS（Windows）和 ext4/xfs（Linux）上均提供原子性。无需 SQLite、无需 Redis。
- **TCP localhost 代替 Unix socket** — 跨平台（Windows、Linux、macOS），零平台分支代码。
- **任务采用乐观并发**（版本号），**文件采用悲观锁**（独占租约）。
- **Claude Code CLI 作为子进程** — 智能体在隔离的 Git Worktree 中启动 `claude -p`。LAOL 管理生命周期；Claude 负责编码。

## 安装

```bash
git clone <this-repo>
cd LAOL
npm install
npm run build
```

**前置条件：** 必须安装 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 并在 `PATH` 中可用。

## 快速开始

### 1. 初始化项目

```bash
cd /path/to/your-codebase
laol init
```

此命令创建 `.multiagent/` 目录，包含所有必需的子目录和默认配置。

### 2. 启动调度器

```bash
laol scheduler start
# LAOL 调度器
#   仓库:  /path/to/your-codebase
#   端口:  9123
#   池大小: 4 个 worktree
# 调度器运行中。按 Ctrl+C 停止。
```

### 3. 启动一个或多个智能体

```bash
# 终端 2
laol agent start --id agent-001

# 终端 3（可选——并行智能体）
laol agent start --id agent-002
```

### 4. 创建任务

```bash
# 预先指定文件：
laol task add --description "将 auth 模块重构为 async/await" \
              --files "src/auth.ts" "src/auth.test.ts"

# 或让智能体自动发现文件：
laol task add --description "修复项目中所有 TypeScript 错误"

# 任务已创建: 3f7a9b2c-...
#   状态: pending
#   文件: src/auth.ts, src/auth.test.ts  (或 "自动发现")
```

### 5. 观察运行

```bash
laol status
# ┌──────────┬────────┐
# │ 待处理    │ 0      │
# │ 进行中    │ 1      │
# │ 已完成    │ 0      │
# │ 失败      │ 0      │
# │ 锁        │ 2      │
# └──────────┴────────┘
```

智能体接收任务、获取锁、在隔离的 Worktree 中启动 Claude Code、提交变更并推送分支。

## CLI 参考

### `laol init`

在当前仓库中初始化 `.multiagent/`。

### `laol task`

| 命令 | 说明 |
|------|------|
| `laol task add --description "..." [--files <路径...>]` | 创建任务（文件可选——智能体自动发现） |
| `laol task list [--status pending\|done\|failed] [--agent <id>]` | 列出任务 |
| `laol task show <任务ID>` | 查看任务详情 |
| `laol task cancel <任务ID>` | 取消待处理任务 |

### `laol scheduler`

| 命令 | 说明 |
|------|------|
| `laol scheduler start [--port 9123] [--pool-size 4]` | 启动调度器 |

### `laol agent`

| 命令 | 说明 |
|------|------|
| `laol agent start --id <智能体ID> [--port 9123] [--host 127.0.0.1]` | 启动智能体 |

### `laol locks`

| 命令 | 说明 |
|------|------|
| `laol locks list` | 列出当前文件锁 |
| `laol locks force-release <文件>` | 强制释放某个文件锁 |

### `laol config`

| 命令 | 说明 |
|------|------|
| `laol config show` | 显示当前配置 |
| `laol config set <键> <值>` | 设置配置项（如 `scheduler.port 9124`） |

### `laol status`

显示系统概览：任务数量、锁数量、池使用情况。

## 配置

`.multiagent/config.json`（由 `laol init` 创建）：

```jsonc
{
  "scheduler": {
    "port": 9123,           // 调度器 TCP 端口
    "pool_size": 4          // 预热的 Worktree 数量
  },
  "merge_checks": [          // 合并前 CI 验证
    { "name": "type-check", "cmd": "npx tsc --noEmit", "timeout": 60 },
    { "name": "lint",       "cmd": "npx eslint src/ --max-warnings 0", "timeout": 30 }
  ],
  "merge_driver": "ai-merge",
  "merge_driver_config": {
    "same_function_strategy": "always_llm",  // 同函数冲突 → LLM 合并
    "cache_size": 100,
    "cache_ttl": 300,
    "quorum_enabled": false                   // 启用双模 Quorum 合并
  },
  "llm": {
    "provider": "claude",
    "api_key_env": "ANTHROPIC_API_KEY",
    "model": "claude-sonnet-4-6",
    "secondary_model": "claude-haiku-4-5"     // 可选，用于 Quorum 模式
  },
  "agent": {
    "heartbeat_interval_ms": 25000,
    "checkpoint_min_interval_ms": 30000,
    "perception_check_interval_ms": 15000
  },
  "locks": {
    "initial_ttl_ms": 60000,   // 新锁 TTL（60 秒）
    "stable_ttl_ms": 180000,   // 稳定锁 TTL（180 秒）
    "stable_threshold": 2,     // 达到稳定态所需的续约次数
    "probe_timeout_ms": 45000  // 最大空闲时间，超时发送 ping 探活
  },
  "claude_executor": {
    "binary_path": "claude",
    "timeout_seconds": 300,    // 单任务最大执行时间
    "max_budget_usd": 5,       // 单任务 API 费用上限
    "allowed_tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    "effort": "high",          // low | medium | high | max
    "skip_permissions": true   // 跳过交互式权限确认
  }
}
```

## 任务生命周期（端到端）

```
用户投放任务 JSON → tasks/
    │
    ▼
chokidar 触发 "task_created" 事件
    │
    ▼
调度器.runAssignmentLoop()
    ├── 冲突检测器.canAssign(任务)
    │   ├── 是否有目标文件被锁定？ → 阻塞
    │   ├── 依赖任务是否已完成？ → 未完成则跳过
    │   └── 检查注册表中的语义警告 → 注入提示
    │
    ├── 熔断器.canAcceptTask(智能体, 复杂度)
    │   ├── normal    → 任意任务
    │   ├── degraded  → 仅简单任务（≤2 个文件）
    │   └── quarantined → 不分配任务
    │
    ├── 锁管理器.acquire(任务ID, 智能体ID, 文件列表)
    │   ├── 写入 staging/{任务ID}.intent
    │   ├── 对每个文件：写入锁数据，renameSync → locks/{文件}.lock
    │   └── 任何失败：回滚所有已创建的锁
    │
    ├── 任务存储.updateTask(任务ID, status: "in_progress")
    │
    └── SocketServer → 通知智能体: { event: "task_assigned", task_id }
            │
            ▼
AgentRunner.handleTaskAssigned(消息)
    │
    └── AgentWorker.executeTask(任务, 执行器)
        ├── Heartbeat.start()           # 每 25 秒续约锁
        ├── Perception.start()          # 监控 warnings/ 目录
        ├── WorktreePool.acquire()      # 获取预热的 Worktree
        ├── Checkpoint.checkAndRebase() # 拉取最新 main，必要时 rebase
        │
        ├── ClaudeCodeExecutor.execute(worktree路径, 任务, 提示)
        │   └── spawn("claude", ["-p", 提示词, "--output-format", "text", ...])
        │       ├── Claude 读取目标文件
        │       ├── Claude 进行编辑
        │       └── Claude 退出码 0 → 成功
        │
        ├── git add -A && git commit
        ├── git push origin agent/{任务ID}
        ├── LockManager.releaseAll()
        ├── TaskStore.updateTask(任务ID, status: "done")
        ├── SocketClient.notifyTaskDone(任务ID)
        └── WorktreePool.release()      # 归还 Worktree 到池中
```

## 开发

```bash
npm install
npm run build       # TypeScript → dist/
npm test            # Vitest（197 个测试，16 个文件）
npm run dev         # 监视模式
```

### 项目结构

```
src/
├── data/            # TypeScript 类型 + Zod 校验
├── task/            # 任务 JSON 增删改查 + chokidar 监控
├── lock/            # 两阶段提交锁 + TTL 租约 + 符号解析器
├── scheduler/       # 事件驱动调度器 + 冲突检测器 + 熔断器 + 健康监控
├── agent/           # 智能体工作器 + 心跳 + 检查点 + 感知 + Claude 执行器
├── worktree/        # Git Worktree 池
├── merge/           # 三级合并：L1 自动 / L2 AST / L3 LLM + 沙箱验证
├── events/          # EventBus（内部）+ TCP Socket 服务端/客户端（跨平台 IPC）
├── wal/             # 预写日志，用于崩溃恢复
├── registry/        # 语义变更注册表（模块导出追踪）
├── cli/             # 基于 Commander 的 CLI（7 个命令组）
└── __tests__/       # 16 个测试文件，197 个测试
```

## 开源协议

MIT
