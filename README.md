# loop-cursor — Goal-Driven Autonomous Dev Loop for Cursor IDE / Cursor IDE 全自主开发循环引擎

> 设定一个目标，Cursor 自动完成设计 -> 实施 -> 测试 -> 验证的全闭环。

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](https://github.com/PerryLink/loop-cursor)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

[English](#english) | [中文](#中文)

---

## English

**This project is an alternative to manually triggering each phase in Cursor Composer/Chat, but specifically optimized for autonomous end-to-end development loops using the @cursor/sdk (v1.0.12) with Node.js >= 22.**

### Features

- Full 11-phase autonomous workflow — from brainstorming to hard verification gate
- @cursor/sdk integration — `agent.send()` loop with context injection and SAP block parsing
- Dynamic rule generation — auto-generates `.cursor/rules/*.mdc` per phase with glob scope constraints
- Dynamic hook generation — auto-generates `hooks.json` for `beforeShellExecution` + `preToolUse`
- P0/P1/P2 severity routing — automatic fallback with design-level vs. implementation-level decision tree
- 7 safety gates — content safety (G1), plan confirmation (G2), dependency install (G3), dangerous ops (G4), file mutation (G5), completion declaration (G6), state protection (G7)
- Node.js >= 22 runtime — Bun HTTP/2 bug (NGHTTP2_FRAME_SIZE_ERROR) bypassed via Node.js for core SDK path

### Quick Start

```bash
# Prerequisites: Node.js >= 22, Cursor IDE installed
git clone https://github.com/PerryLink/loop-cursor.git
cd loop-cursor
npm install

# Run the CLI
cd packages/cli
npx tsx src/index.ts --goal "Build a REST API for a todo app"

# Or via Bun CLI wrapper (spawns Node.js child process)
bun run --bun packages/cli/src/index.ts --goal "Add dark mode support"
```

Requirements: Node.js >= 22, Cursor IDE with Agent mode enabled.

### Prerequisites

- **Node.js >= 22** (required) -- The core engine runs on Node.js 22+. Verify with `node --version`.
- **Bun >= 1.1.0** (optional) -- Only needed if using the Bun CLI wrapper to spawn the Node.js child process.
- **Git** -- Required for cloning the repository and for worktree support.
- **jq** (optional) -- Useful for inspecting `state.json` and `hooks.json` files.
- **Cursor IDE** -- Must be installed with Agent mode enabled. The `@cursor/sdk` (v1.0.12) must be accessible.
- **CURSOR_API_KEY** -- Set as an environment variable for SDK authentication.

### Installation

#### 1. Clone the repository

```bash
git clone https://github.com/PerryLink/loop-cursor.git
cd loop-cursor
```

#### 2. Install dependencies

```bash
# Install core engine dependencies
cd packages/loop-core
npm install

# Install Cursor SDK adapter dependencies
cd ../adapter-cursor-sdk
npm install

# Install CLI dependencies
cd ../cli
npm install

# Return to project root
cd ../..
```

#### 3. Build (type-check only -- no compilation required)

```bash
# From the project root
npx tsc -b packages/loop-core packages/adapter-cursor-sdk packages/cli
```

The project uses `tsx` for execution, so no compilation step is needed for running. Type-checking via `tsc --noEmit` is sufficient to validate all source files.

#### 4. Verify the installation

```bash
# Check SDK compatibility (5 checks: Node version, SDK load, version match, API key, response format)
cd packages/adapter-cursor-sdk
npx tsx src/sdk-check.ts

# Run a minimal probe to verify the engine works
npx tsx src/probe.ts
```

### Configuration

#### Project configuration file

Create `.cursor/loop-cursor/config.json` in your project root:

```json
{
  "mode": "auto",
  "max_cycles": 5,
  "max_part1_rounds": 5,
  "convergence_rounds": 2,
  "route_repeat_max": 3,
  "user_request": "Build a REST API for a todo app",
  "model": "claude-sonnet-4-20250514",
  "sdk_version": "1.0.12"
}
```

#### Configuration options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mode` | `"safe"` \| `"auto"` \| `"unsafe"` \| `"interactive"` | `"auto"` | Run mode: `safe` pauses at every gate, `auto` skips non-critical gates, `unsafe` only blocks catastrophic ops, `interactive` prompts at decision points |
| `max_cycles` | `number` | `5` | Maximum agent.send() cycles before forced termination |
| `max_part1_rounds` | `number` | `5` | Maximum internal rounds within the Part 1 design bubble |
| `convergence_rounds` | `number` | `2` | Number of consecutive clean rounds required for convergence |
| `route_repeat_max` | `number` | `3` | Maximum times the same route can repeat before escalation |
| `model` | `string` | `"claude-sonnet-4-20250514"` | Default model for Part 2 implementation phases |

#### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LOOP_CURSOR_MODE` | Override run mode | Config file value |
| `LOOP_CURSOR_MODEL` | Override model | Config file value |
| `LOOP_CURSOR_MAX_CYCLES` | Override max cycles | Config file value |
| `CURSOR_API_KEY` | SDK authentication key | Required |

#### Runtime artifacts

The engine creates the following files during execution:

- `.cursor/loop-cursor/state.json` -- Current state machine state (persisted after each phase)
- `.cursor/loop-cursor/artifacts/context-summary.md` -- Cross-turn conversation history for context bridging
- `.cursor/loop-cursor/.lock` -- File lock to prevent concurrent engine instances
- `.cursor/loop-cursor/.compat-check` -- Cached SDK compatibility check result (24h TTL)
- `.cursor/rules/loop-cursor-phase-{phase}.mdc` -- Dynamic per-phase Cursor rules
- `.cursor/rules/loop-cursor-global.mdc` -- Global always-apply rule
- `.cursor/hooks.json` -- Dynamic beforeShellExecution + preToolUse hooks

### Usage

#### CLI commands

```bash
# Start a new loop with a goal
cd packages/cli
npx tsx src/index.ts --goal "Build a REST API for a todo app"

# Start with a specific run mode
npx tsx src/index.ts --goal "Add dark mode support" --mode safe

# Start with a specific model
npx tsx src/index.ts --goal "Refactor the auth module" --model claude-opus-4-20250514

# Resume from an existing state file
npx tsx src/index.ts --state-file .cursor/loop-cursor/state.json

# Set max cycles
npx tsx src/index.ts --goal "Implement user registration" --max-cycles 10
```

#### CLI flags

| Flag | Description | Default |
|------|-------------|---------|
| `--goal <string>` | The development goal / user request | Required |
| `--mode <safe|auto|unsafe|interactive>` | Run mode | `auto` |
| `--model <model-id>` | Model to use for implementation phases | `claude-sonnet-4-20250514` |
| `--max-cycles <number>` | Maximum engine cycles | `5` |
| `--state-file <path>` | Path to state.json for resuming | `.cursor/loop-cursor/state.json` |

#### Via Bun CLI wrapper

```bash
# The Bun wrapper spawns a Node.js child process internally
bun run --bun packages/cli/src/index.ts --goal "Add dark mode support"
```

### Project Structure

```
loop-cursor/
├── .github/
│   └── workflows/
│       └── ci.yml                    # CI pipeline (lint, test, build, audit)
├── packages/
│   ├── loop-core/                    # Core engine (shared types, config, convergence, router, state machine)
│   │   └── src/
│   │       ├── types.ts              # Shared type system (LoopState, PlatformAdapter, enums, etc.)
│   │       ├── config.ts             # Configuration management (defaults, merging, validation)
│   │       ├── engine-loop.ts        # 22-step orchestration engine (main loop)
│   │       ├── router.ts             # Routing engine (P0/P1/P2 routing decisions)
│   │       ├── convergence.ts        # Convergence engine (convergence detection, counter updates)
│   │       ├── issue-classifier.ts   # Issue classifier (P0/P1/P2 severity determination)
│   │       ├── state-machine.ts      # File-based state machine (state.json read/write/atomic)
│   │       ├── schema.ts             # JSON Schema validation for state files
│   │       ├── sap-parser.ts         # SAP block parser (<<<LOOP_STATE>>> extraction)
│   │       ├── gate-content-safety.ts # Content safety gate (G1)
│   │       ├── worktree.ts           # Git worktree management
│   │       ├── platform-adapter.ts   # PlatformAdapter interface definition
│   │       └── index.ts              # Core package entry point
│   ├── adapter-cursor-sdk/           # Cursor SDK platform adapter
│   │   └── src/
│   │       ├── adapter.ts            # CursorPlatformAdapter (7-method implementation)
│   │       ├── rules-generator.ts    # Dynamic .cursor/rules/*.mdc generator
│   │       ├── hooks-generator.ts    # Dynamic hooks.json generator
│   │       ├── context-injector.ts   # Cross-turn context bridge (P0-2 workaround)
│   │       ├── sdk-check.ts          # SDK compatibility check (5 checks)
│   │       ├── probe.ts              # Feasibility probes (3 probes + verdict matrix)
│   │       ├── rule-generator.ts     # Individual rule file generator
│   │       └── index.ts              # Adapter package entry point
│   └── cli/                          # CLI entry point (argument parsing, child process spawning)
│       └── src/
│           └── index.ts              # CLI main entry
├── tests/                            # Test suite
│   ├── test-engine-loop.test.ts      # Engine loop integration tests
│   ├── test-issue-classifier.test.ts # Issue classifier unit tests
│   ├── test-state-machine.test.ts    # State machine unit tests
│   ├── test-router.test.ts           # Router unit tests
│   ├── test-convergence.test.ts      # Convergence engine unit tests
│   └── test-adapter.test.ts          # Adapter unit tests
├── examples/                         # Example projects
│   ├── example-1-basic/
│   ├── example-2-multi-phase/
│   └── example-3-worktree/
├── tsconfig.json                     # Root TypeScript configuration
├── package.json                      # Monorepo root package
├── README.md                         # This file
└── LICENSE                           # Apache License 2.0
```

### Troubleshooting

#### "Engine is locked" error

If the engine exits unexpectedly, the lock file may remain. Delete it manually:

```bash
rm .cursor/loop-cursor/.lock
```

#### "NGHTTP2_FRAME_SIZE_ERROR" with Bun

This is a known Bun HTTP/2 bug. Do not use `bun` to run the core engine directly. Use the CLI wrapper (`bun run --bun packages/cli/src/index.ts`) which spawns a Node.js child process. Alternatively, run directly with Node.js:

```bash
npx tsx packages/cli/src/index.ts --goal "your goal"
```

#### "Cannot find module @cursor/sdk"

Ensure the `@cursor/sdk` package is installed in `packages/adapter-cursor-sdk`:

```bash
cd packages/adapter-cursor-sdk
npm install
```

Verify the SDK version matches the expected `1.0.12`:

```bash
node -e "const pkg = require('@cursor/sdk/package.json'); console.log(pkg.version)"
```

#### "CURSOR_API_KEY not set"

Set your Cursor API key as an environment variable:

```bash
export CURSOR_API_KEY="your-api-key-here"
```

On Windows (PowerShell):
```powershell
$env:CURSOR_API_KEY = "your-api-key-here"
```

#### Agent calls failing repeatedly

1. Check your API key validity at the Cursor dashboard.
2. Verify network connectivity -- the SDK communicates over gRPC.
3. Check rate limits -- the engine retries up to 3 times with exponential backoff.
4. Run the SDK compatibility check: `npx tsx packages/adapter-cursor-sdk/src/sdk-check.ts`

#### State file corruption

If `state.json` becomes corrupted, a backup is automatically created at `.cursor/loop-cursor/state.json.bak` before each write. To restore:

```bash
cp .cursor/loop-cursor/state.json.bak .cursor/loop-cursor/state.json
```

#### Tests fail with module resolution errors

Ensure all workspace dependencies are installed:

```bash
# From project root
cd packages/loop-core && npm install && cd ../..
cd packages/adapter-cursor-sdk && npm install && cd ../..
cd packages/cli && npm install && cd ../..
```

#### Node.js version too old

The project requires Node.js >= 22. Check your version:

```bash
node --version  # Should be v22.x.x or later
```

### FAQ

#### Q: Why does this require Node.js >= 22 instead of Bun?

A: A critical bug was discovered: Bun's HTTP/2 implementation (versions 1.1.x through 1.2.x) has an `NGHTTP2_FRAME_SIZE_ERROR` that causes `agent.send()` to silently disconnect on large gRPC streaming responses. The core SDK engine runs entirely on Node.js >= 22. Bun is used only for the CLI wrapper layer (argument parsing + spawning the Node.js child process).

#### Q: What are the `.cursor/rules/*.mdc` files generated at runtime?

A: These are Cursor's rule files that constrain the agent's behavior per phase. Each phase gets its own rule file with a `globs` scope — e.g., the "implementation" phase rule scopes the agent to `src/**/*.ts` files only, while the "testing" phase rule scopes it to `tests/**/*.test.ts`. Rules are generated dynamically from templates based on the current `state.json`.

#### Q: How does loop-cursor handle session disconnects or IDE restarts?

A: All state is persisted to `state.json` after each phase transition. If the IDE restarts or the session disconnects, restart with the same `--state-file` and the loop picks up from the last completed phase. The `context_summary.md` artifact preserves conversation history for re-injection.

### Related Projects

- [loop-superpowers](https://github.com/PerryLink/loop-superpowers) — Skill mini-loops for Claude Code
- [loop-opencode](https://github.com/PerryLink/loop-opencode) — closed-loop driver for OpenCode CLI
- [loop-codex](https://github.com/PerryLink/loop-codex) — JSON-RPC+CDP driver for Codex Desktop

### License

Apache License 2.0 — see [LICENSE](./LICENSE) for full text.

Copyright 2026 Perry Link

---

## 中文

**本项目替代了在 Cursor Composer/Chat 中手动触发每个阶段的流程，专为基于 @cursor/sdk (v1.0.12) 和 Node.js >= 22 的全自主端到端开发循环优化。**

### 功能特性

- 完整的 11 阶段全自主工作流 — 从头脑风暴到硬验证门禁
- @cursor/sdk 集成 — `agent.send()` 循环，带上下文注入和 SAP 块解析
- 动态规则生成 — 每阶段自动生成 `.cursor/rules/*.mdc`，含 glob 范围约束
- 动态钩子生成 — 自动生成 `hooks.json`（beforeShellExecution + preToolUse）
- P0/P1/P2 严重级别路由 — 自动回退，含设计级 vs 实现级决策树
- 7 安全门禁 — 内容安全(G1)、计划确认(G2)、依赖安装(G3)、危险操作(G4)、文件变更(G5)、完成声明(G6)、状态保护(G7)
- Node.js >= 22 运行时 — 核心 SDK 路径通过 Node.js 绕过 Bun HTTP/2 的 NGHTTP2_FRAME_SIZE_ERROR 缺陷

### 快速开始

```bash
# 前置条件：Node.js >= 22，已安装 Cursor IDE
git clone https://github.com/PerryLink/loop-cursor.git
cd loop-cursor
npm install

# 运行 CLI
cd packages/cli
npx tsx src/index.ts --goal "为 todo 应用构建 REST API"

# 或通过 Bun CLI 包装器（内部启动 Node.js 子进程）
bun run --bun packages/cli/src/index.ts --goal "添加深色模式支持"
```

系统要求：Node.js >= 22，Cursor IDE 需启用 Agent 模式。

### 前置条件

- **Node.js >= 22**（必需）-- 核心引擎运行在 Node.js 22+ 上。使用 `node --version` 验证。
- **Bun >= 1.1.0**（可选）-- 仅在使用 Bun CLI 包装器启动 Node.js 子进程时需要。
- **Git** -- 克隆仓库和 worktree 支持所需。
- **jq**（可选）-- 用于检查 `state.json` 和 `hooks.json` 文件。
- **Cursor IDE** -- 必须安装并启用 Agent 模式。`@cursor/sdk` (v1.0.12) 必须可访问。
- **CURSOR_API_KEY** -- 设置为环境变量用于 SDK 认证。

### 安装

#### 1. 克隆仓库

```bash
git clone https://github.com/PerryLink/loop-cursor.git
cd loop-cursor
```

#### 2. 安装依赖

```bash
# 安装核心引擎依赖
cd packages/loop-core
npm install

# 安装 Cursor SDK 适配器依赖
cd ../adapter-cursor-sdk
npm install

# 安装 CLI 依赖
cd ../cli
npm install

# 返回项目根目录
cd ../..
```

#### 3. 构建（仅类型检查 -- 无需编译）

```bash
# 从项目根目录执行
npx tsc -b packages/loop-core packages/adapter-cursor-sdk packages/cli
```

本项目使用 `tsx` 运行，因此无需编译步骤。通过 `tsc --noEmit` 进行类型检查即可验证所有源文件。

#### 4. 验证安装

```bash
# 检查 SDK 兼容性（5 项检查：Node 版本、SDK 加载、版本匹配、API 密钥、响应格式）
cd packages/adapter-cursor-sdk
npx tsx src/sdk-check.ts

# 运行最小探测以验证引擎工作正常
npx tsx src/probe.ts
```

### 配置

#### 项目配置文件

在项目根目录创建 `.cursor/loop-cursor/config.json`：

```json
{
  "mode": "auto",
  "max_cycles": 5,
  "max_part1_rounds": 5,
  "convergence_rounds": 2,
  "route_repeat_max": 3,
  "user_request": "为 todo 应用构建 REST API",
  "model": "claude-sonnet-4-20250514",
  "sdk_version": "1.0.12"
}
```

#### 配置选项

| 选项 | 类型 | 默认值 | 描述 |
|--------|------|---------|-------------|
| `mode` | `"safe"` \| `"auto"` \| `"unsafe"` \| `"interactive"` | `"auto"` | 运行模式：`safe` 在每个门禁暂停，`auto` 跳过非关键门禁，`unsafe` 仅阻止灾难性操作，`interactive` 在决策点提示 |
| `max_cycles` | `number` | `5` | agent.send() 强制终止前的最大循环次数 |
| `max_part1_rounds` | `number` | `5` | Part 1 设计阶段内的最大内部轮次 |
| `convergence_rounds` | `number` | `2` | 收敛所需的连续成功轮次数 |
| `route_repeat_max` | `number` | `3` | 同一路由在升级前可重复的最大次数 |
| `model` | `string` | `"claude-sonnet-4-20250514"` | Part 2 实现阶段使用的默认模型 |

#### 环境变量

| 变量 | 描述 | 默认值 |
|----------|-------------|---------|
| `LOOP_CURSOR_MODE` | 覆盖运行模式 | 配置文件值 |
| `LOOP_CURSOR_MODEL` | 覆盖模型 | 配置文件值 |
| `LOOP_CURSOR_MAX_CYCLES` | 覆盖最大循环数 | 配置文件值 |
| `CURSOR_API_KEY` | SDK 认证密钥 | 必需 |

#### 运行时生成文件

引擎在执行期间会创建以下文件：

- `.cursor/loop-cursor/state.json` -- 当前状态机状态（每个阶段完成后持久化）
- `.cursor/loop-cursor/artifacts/context-summary.md` -- 跨轮次对话历史，用于上下文桥接
- `.cursor/loop-cursor/.lock` -- 文件锁，防止并发引擎实例
- `.cursor/loop-cursor/.compat-check` -- 缓存的 SDK 兼容性检查结果（24 小时 TTL）
- `.cursor/rules/loop-cursor-phase-{phase}.mdc` -- 动态每阶段 Cursor 规则
- `.cursor/rules/loop-cursor-global.mdc` -- 全局始终应用规则
- `.cursor/hooks.json` -- 动态 beforeShellExecution + preToolUse 钩子

### 使用方法

#### CLI 命令

```bash
# 使用目标启动新循环
cd packages/cli
npx tsx src/index.ts --goal "为 todo 应用构建 REST API"

# 使用指定运行模式启动
npx tsx src/index.ts --goal "添加深色模式支持" --mode safe

# 使用指定模型启动
npx tsx src/index.ts --goal "重构认证模块" --model claude-opus-4-20250514

# 从现有状态文件恢复
npx tsx src/index.ts --state-file .cursor/loop-cursor/state.json

# 设置最大循环次数
npx tsx src/index.ts --goal "实现用户注册" --max-cycles 10
```

#### CLI 参数

| 参数 | 描述 | 默认值 |
|------|-------------|---------|
| `--goal <string>` | 开发目标 / 用户需求 | 必需 |
| `--mode <safe|auto|unsafe|interactive>` | 运行模式 | `auto` |
| `--model <model-id>` | 实现阶段使用的模型 | `claude-sonnet-4-20250514` |
| `--max-cycles <number>` | 最大引擎循环次数 | `5` |
| `--state-file <path>` | 用于恢复的 state.json 路径 | `.cursor/loop-cursor/state.json` |

#### 通过 Bun CLI 包装器

```bash
# Bun 包装器内部启动 Node.js 子进程
bun run --bun packages/cli/src/index.ts --goal "添加深色模式支持"
```

### 项目结构

```
loop-cursor/
├── .github/
│   └── workflows/
│       └── ci.yml                    # CI 流水线（lint、test、build、audit）
├── packages/
│   ├── loop-core/                    # 核心引擎（共享类型、配置、收敛、路由、状态机）
│   │   └── src/
│   │       ├── types.ts              # 共享类型系统（LoopState、PlatformAdapter、枚举等）
│   │       ├── config.ts             # 配置管理（默认值、合并、验证）
│   │       ├── engine-loop.ts        # 22 步编排引擎（主循环）
│   │       ├── router.ts             # 路由引擎（P0/P1/P2 路由决策）
│   │       ├── convergence.ts        # 收敛引擎（收敛检测、计数器更新）
│   │       ├── issue-classifier.ts   # 问题分类器（P0/P1/P2 严重级别判定）
│   │       ├── state-machine.ts      # 基于文件的状态机（state.json 读写/原子操作）
│   │       ├── schema.ts             # 状态文件 JSON Schema 验证
│   │       ├── sap-parser.ts         # SAP 块解析器（<<<LOOP_STATE>>> 提取）
│   │       ├── gate-content-safety.ts # 内容安全门禁（G1）
│   │       ├── worktree.ts           # Git worktree 管理
│   │       ├── platform-adapter.ts   # PlatformAdapter 接口定义
│   │       └── index.ts              # 核心包入口
│   ├── adapter-cursor-sdk/           # Cursor SDK 平台适配器
│   │   └── src/
│   │       ├── adapter.ts            # CursorPlatformAdapter（7 方法实现）
│   │       ├── rules-generator.ts    # 动态 .cursor/rules/*.mdc 生成器
│   │       ├── hooks-generator.ts    # 动态 hooks.json 生成器
│   │       ├── context-injector.ts   # 跨轮次上下文桥接（P0-2 变通方案）
│   │       ├── sdk-check.ts          # SDK 兼容性检查（5 项检查）
│   │       ├── probe.ts              # 可行性探测（3 项探测 + 判定矩阵）
│   │       ├── rule-generator.ts     # 单个规则文件生成器
│   │       └── index.ts              # 适配器包入口
│   └── cli/                          # CLI 入口（参数解析、子进程启动）
│       └── src/
│           └── index.ts              # CLI 主入口
├── tests/                            # 测试套件
│   ├── test-engine-loop.test.ts      # 引擎循环集成测试
│   ├── test-issue-classifier.test.ts # 问题分类器单元测试
│   ├── test-state-machine.test.ts    # 状态机单元测试
│   ├── test-router.test.ts           # 路由单元测试
│   ├── test-convergence.test.ts      # 收敛引擎单元测试
│   └── test-adapter.test.ts          # 适配器单元测试
├── examples/                         # 示例项目
│   ├── example-1-basic/
│   ├── example-2-multi-phase/
│   └── example-3-worktree/
├── tsconfig.json                     # 根 TypeScript 配置
├── package.json                      # Monorepo 根包配置
├── README.md                         # 本文件
└── LICENSE                           # Apache License 2.0
```

### 故障排除

#### "Engine is locked" 错误

如果引擎异常退出，锁文件可能残留。手动删除：

```bash
rm .cursor/loop-cursor/.lock
```

#### 使用 Bun 时出现 "NGHTTP2_FRAME_SIZE_ERROR"

这是已知的 Bun HTTP/2 缺陷。不要直接用 `bun` 运行核心引擎。使用 CLI 包装器（`bun run --bun packages/cli/src/index.ts`），它会在内部启动 Node.js 子进程。或者直接用 Node.js 运行：

```bash
npx tsx packages/cli/src/index.ts --goal "你的目标"
```

#### "Cannot find module @cursor/sdk"

确保 `@cursor/sdk` 包已安装在 `packages/adapter-cursor-sdk` 中：

```bash
cd packages/adapter-cursor-sdk
npm install
```

验证 SDK 版本是否与期望的 `1.0.12` 匹配：

```bash
node -e "const pkg = require('@cursor/sdk/package.json'); console.log(pkg.version)"
```

#### "CURSOR_API_KEY not set"

将 Cursor API 密钥设置为环境变量：

```bash
export CURSOR_API_KEY="your-api-key-here"
```

Windows（PowerShell）：
```powershell
$env:CURSOR_API_KEY = "your-api-key-here"
```

#### Agent 调用反复失败

1. 在 Cursor 仪表板检查 API 密钥有效性。
2. 验证网络连接 -- SDK 通过 gRPC 通信。
3. 检查速率限制 -- 引擎最多重试 3 次，使用指数退避。
4. 运行 SDK 兼容性检查：`npx tsx packages/adapter-cursor-sdk/src/sdk-check.ts`

#### 状态文件损坏

如果 `state.json` 损坏，每次写入前会自动在 `.cursor/loop-cursor/state.json.bak` 创建备份。恢复方法：

```bash
cp .cursor/loop-cursor/state.json.bak .cursor/loop-cursor/state.json
```

#### 测试因模块解析错误失败

确保所有工作空间依赖已安装：

```bash
# 从项目根目录执行
cd packages/loop-core && npm install && cd ../..
cd packages/adapter-cursor-sdk && npm install && cd ../..
cd packages/cli && npm install && cd ../..
```

#### Node.js 版本过旧

本项目要求 Node.js >= 22。检查你的版本：

```bash
node --version  # 应为 v22.x.x 或更高
```

### 常见问题

#### Q: 为什么需要 Node.js >= 22 而不是 Bun？

A: 发现了一个严重缺陷：Bun 的 HTTP/2 实现（版本 1.1.x 到 1.2.x）存在 `NGHTTP2_FRAME_SIZE_ERROR`，导致 `agent.send()` 在大型 gRPC 流式响应时静默断开。核心 SDK 引擎完全在 Node.js >= 22 上运行。Bun 仅用于 CLI 包装层（参数解析 + 启动 Node.js 子进程）。

#### Q: 运行时生成的 `.cursor/rules/*.mdc` 文件是什么？

A: 这些是 Cursor 的规则文件，用于约束每个阶段中 agent 的行为。每个阶段都有自己的规则文件，带有 `globs` 范围 — 例如，"implementation" 阶段规则将 agent 限制为仅 `src/**/*.ts` 文件，而 "testing" 阶段规则将其限制为 `tests/**/*.test.ts`。规则根据当前 `state.json` 从模板动态生成。

#### Q: loop-cursor 如何处理会话断开或 IDE 重启？

A: 所有状态在每次阶段转换后持久化到 `state.json`。如果 IDE 重启或会话断开，使用相同的 `--state-file` 重新启动，循环将从上次完成的阶段继续。`context_summary.md` 文件保留了对话历史以用于重新注入。

### 相关项目

- [loop-superpowers](https://github.com/PerryLink/loop-superpowers) — Claude Code 技能迷你循环
- [loop-opencode](https://github.com/PerryLink/loop-opencode) — OpenCode CLI 闭环驱动器
- [loop-codex](https://github.com/PerryLink/loop-codex) — Codex Desktop 的 JSON-RPC+CDP 驱动器

### 许可证

Apache License 2.0 — 详见 [LICENSE](./LICENSE)。

Copyright 2026 Perry Link
