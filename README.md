# loop-cursor

*A [**Loop Engineering**](https://github.com/PerryLink/loop-everything) autonomous coding loop engine — turn goals into production code.*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![npm](https://img.shields.io/badge/npm-install-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Cursor SDK](https://img.shields.io/badge/%40cursor%2Fsdk-v1.0.12-6C4DFF)]()
[![CI](https://img.shields.io/github/actions/workflow/status/PerryLink/loop-cursor/ci.yml?branch=main)](https://github.com/PerryLink/loop-cursor/actions)

> Set a goal. loop-cursor autonomously completes the full cycle: Design -> Implementation -> Test -> Verification.

**loop-cursor** is a 3-package TypeScript monorepo wrapping the Cursor SDK (`@cursor/sdk` v1.0.12, Node.js >= 22) into a fully automated development engine. It provides a 22-step engine loop (909 lines), 7 safety gates, a 27-model registry, 13 rule templates (`.mdc.tmpl`), and a context injector — an alternative to manual Cursor IDE usage, optimized for autonomous coding with structured safety enforcement.

## Features

- **22-Step Engine Loop** — 909-line orchestration engine (`engine-loop.ts`) that drives the Design -> Implementation -> Test -> Verification cycle autonomously
- **7 Safety Gates** — G1 content safety, G2 plan confirmation, G3 dependency install, G4 dangerous ops, G5 file mutation, G6 completion declaration, G7 state protection
- **27-Model Registry** — Curated model catalog with capability levels, token limits, and pricing; model recommendation and validation API
- **13 Rule Templates** — `.mdc.tmpl` files for dynamic per-phase Cursor rule generation with glob scope constraints
- **Context Injector** — Cross-turn conversation history bridge with 50KB trimming for context continuity across agent calls
- **P0/P1/P2 Severity Routing** — Automatic fallback with design-level vs. implementation-level decision tree
- **Dynamic Hook Generation** — Auto-generated `hooks.json` for `beforeShellExecution` + `preToolUse`
- **File-Driven State Machine** — Atomic writes, crash-safe lock protocol, resume-from-state support

## Quick Start

```bash
# Prerequisites: Node.js >= 22
git clone https://github.com/PerryLink/loop-cursor.git
cd loop-cursor
npm install

# Run the CLI
npx loop-cursor --goal "Build a REST API for a todo app"
```

Requirements: Node.js >= 22, Cursor IDE with Agent mode enabled, `CURSOR_API_KEY` environment variable.

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/PerryLink/loop-cursor.git
cd loop-cursor
```

### 2. Install dependencies

```bash
npm install
```

### 3. Verify the installation

```bash
# SDK compatibility check (5 checks: Node version, SDK load, version match, API key, response format)
npx tsx packages/adapter-cursor-sdk/src/sdk-check.ts

# Minimal probe to verify the engine works
npx tsx packages/adapter-cursor-sdk/src/probe.ts
```

## Configuration

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

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mode` | `"safe"` \| `"auto"` \| `"unsafe"` \| `"interactive"` | `"auto"` | Run mode: `safe` pauses at every gate, `auto` skips non-critical gates, `unsafe` only blocks catastrophic ops |
| `max_cycles` | `number` | `5` | Maximum `agent.send()` cycles before forced termination |
| `model` | `string` | `"claude-sonnet-4-20250514"` | Default model for implementation phases |

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CURSOR_API_KEY` | SDK authentication key | Required |
| `LOOP_CURSOR_MODE` | Override run mode | Config file value |
| `LOOP_CURSOR_MODEL` | Override model | Config file value |
| `LOOP_CURSOR_MAX_CYCLES` | Override max cycles | Config file value |

## Usage

```bash
# Start a new loop with a goal
npx loop-cursor --goal "Build a REST API for a todo app"

# Start with a specific run mode
npx loop-cursor --goal "Add dark mode support" --mode safe

# Resume from an existing state file
npx loop-cursor --state-file .cursor/loop-cursor/state.json
```

| Flag | Description | Default |
|------|-------------|---------|
| `--goal <string>` | The development goal | Required |
| `--mode <safe\|auto\|unsafe\|interactive>` | Run mode | `auto` |
| `--model <model-id>` | Model for implementation phases | `claude-sonnet-4-20250514` |
| `--max-cycles <number>` | Maximum engine cycles | `5` |
| `--state-file <path>` | Path to state.json for resuming | `.cursor/loop-cursor/state.json` |

## Project Structure

```
loop-cursor/
├── packages/
│   ├── loop-core/                     # Core engine
│   │   └── src/
│   │       ├── engine-loop.ts         # 22-step orchestration engine (909 lines)
│   │       ├── model-registry.ts      # 27-model registry with capability & pricing
│   │       ├── router.ts              # P0/P1/P2 routing engine
│   │       ├── convergence.ts         # Convergence detection engine
│   │       ├── state-machine.ts       # File-driven state machine
│   │       ├── sap-parser.ts          # <<<LOOP_STATE>>> block parser
│   │       ├── gate-*.ts              # 7 safety gate modules (G1-G7)
│   │       └── ...
│   ├── adapter-cursor-sdk/            # Cursor SDK platform adapter
│   │   └── src/
│   │       ├── adapter.ts             # 7-method PlatformAdapter implementation
│   │       ├── context-injector.ts    # Cross-turn context bridge
│   │       ├── rules-generator.ts     # Dynamic .mdc rule generator
│   │       ├── hooks-generator.ts     # Dynamic hooks.json generator
│   │       ├── rules-templates/       # 13 .mdc.tmpl template files
│   │       └── ...
│   └── cli/                           # CLI entry point
├── tests/                             # 9 test suites
├── tsconfig.json
├── package.json
└── LICENSE
```

## Troubleshooting

### "Engine is locked" error

Delete the lock file manually:
```bash
rm .cursor/loop-cursor/.lock
```

### "NGHTTP2_FRAME_SIZE_ERROR" with Bun

Known Bun HTTP/2 bug. Run via the CLI which spawns a Node.js child process, or use Node.js directly:
```bash
npx tsx packages/cli/src/index.ts --goal "your goal"
```

### "Cannot find module @cursor/sdk"

```bash
cd packages/adapter-cursor-sdk
npm install
```

### "CURSOR_API_KEY not set"

```bash
export CURSOR_API_KEY="your-api-key-here"
```

### State file corruption

A backup is automatically created at `.cursor/loop-cursor/state.json.bak` before each write:
```bash
cp .cursor/loop-cursor/state.json.bak .cursor/loop-cursor/state.json
```

## FAQ

### Q: Why Node.js >= 22 instead of Bun?
A: Bun's HTTP/2 implementation has an `NGHTTP2_FRAME_SIZE_ERROR` bug that causes `agent.send()` to silently disconnect on large gRPC streaming responses. The core engine runs on Node.js >= 22. Bun is used only for the CLI wrapper layer.

### Q: How does loop-cursor handle session disconnects or IDE restarts?
A: All state is persisted to `state.json` after each phase transition. Restart with `--state-file` and the loop resumes from the last completed phase. The context-summary.md artifact preserves conversation history for re-injection.

---

## 中文文档

**loop-cursor** 是一个 3-package TypeScript monorepo，封装 Cursor SDK (`@cursor/sdk` v1.0.12, Node.js >= 22) 为全自动开发引擎。设定一个目标，Cursor 自动完成设计 -> 实施 -> 测试 -> 验证的全闭环。

定位：手动使用 Cursor IDE 的替代方案，以 22 步引擎循环和 7 安全门禁为自主编码优化。

### 核心特性

- **22 步引擎循环** — 909 行编排引擎 (`engine-loop.ts`)，自主驱动设计->实施->测试->验证全闭环
- **7 安全门禁** — 内容安全(G1)、计划确认(G2)、依赖安装(G3)、危险操作(G4)、文件变更(G5)、完成声明(G6)、状态保护(G7)
- **27 模型注册表** — 含能力级别、token 限制和定价信息；模型推荐与验证 API
- **13 规则模板** — `.mdc.tmpl` 文件，用于动态生成 per-phase Cursor 规则，含 glob 范围约束
- **上下文注入器** — 跨轮次对话历史桥接，50KB 裁剪，保证 agent 调用间的上下文连续性
- **P0/P1/P2 严重级别路由** — 自动回退，设计级 vs 实现级决策树
- **动态钩子生成** — 自动生成 `hooks.json`（beforeShellExecution + preToolUse）
- **文件驱动状态机** — 原子写入、崩溃安全锁协议、断点续跑

### 快速开始

```bash
# 前置条件: Node.js >= 22
git clone https://github.com/PerryLink/loop-cursor.git
cd loop-cursor
npm install

# 运行 CLI
npx loop-cursor --goal "为 todo 应用构建 REST API"
```

运行要求：Node.js >= 22、Cursor IDE（Agent 模式已启用）、`CURSOR_API_KEY` 环境变量。

### 安装

```bash
git clone https://github.com/PerryLink/loop-cursor.git
cd loop-cursor
npm install
```

### 使用

```bash
# 启动新 loop
npx loop-cursor --goal "Build a REST API for a todo app"

# 指定运行模式
npx loop-cursor --goal "添加暗色模式" --mode safe

# 断点续跑
npx loop-cursor --state-file .cursor/loop-cursor/state.json
```

### 项目结构

```
loop-cursor/
├── packages/
│   ├── loop-core/                     # 核心引擎
│   │   └── src/
│   │       ├── engine-loop.ts         # 22步编排引擎 (909行)
│   │       ├── model-registry.ts      # 27模型注册表
│   │       ├── router.ts              # P0/P1/P2 路由引擎
│   │       ├── convergence.ts         # 收敛检测引擎
│   │       ├── state-machine.ts       # 文件驱动状态机
│   │       ├── sap-parser.ts          # <<<LOOP_STATE>>> 块解析器
│   │       ├── gate-*.ts              # 7 安全门禁模块 (G1-G7)
│   │       └── ...
│   ├── adapter-cursor-sdk/            # Cursor SDK 平台适配器
│   │   └── src/
│   │       ├── adapter.ts             # 7方法 PlatformAdapter 实现
│   │       ├── context-injector.ts    # 跨轮次上下文桥接
│   │       ├── rules-generator.ts     # 动态 .mdc 规则生成器
│   │       ├── hooks-generator.ts     # 动态 hooks.json 生成器
│   │       ├── rules-templates/       # 13 .mdc.tmpl 模板文件
│   │       └── ...
│   └── cli/                           # CLI 入口
├── tests/                             # 9 测试套件
├── tsconfig.json
├── package.json
└── LICENSE
```

### 常见问题

**Q: 为什么需要 Node.js >= 22 而非 Bun？**
A: Bun 的 HTTP/2 实现在大 gRPC 流式响应中存在 `NGHTTP2_FRAME_SIZE_ERROR` bug，会导致 `agent.send()` 静默断开。核心引擎运行在 Node.js >= 22 上，Bun 仅用于 CLI 包装层。

**Q: loop-cursor 如何处理会话断开或 IDE 重启？**
A: 所有状态在每次 phase 转换后持久化到 `state.json`。使用 `--state-file` 重启即可从最后完成的 phase 继续。`context-summary.md` 保留对话历史以供重新注入。

---

## Related Projects

| # | Project | Description |
|:--:|------|------|
| ⭐ | **[loop-everything](https://github.com/PerryLink/loop-everything)** | Ecosystem hub & meta-repository |
| 1 | [loop-aider](https://github.com/PerryLink/loop-aider) | 11-phase state machine, 10-point PhaseGuard, atomic write |
| 2 | [loop-superpowers](https://github.com/PerryLink/loop-superpowers) | 7-skill autonomous mini-loop, Phase Contract DSL |
| 3 | [loop-ollama](https://github.com/PerryLink/loop-ollama) | ReAct loop, 3-tier fault tolerance, fully local/air-gapped |
| 4 | [loop-hermes](https://github.com/PerryLink/loop-hermes) | 24 modules, 6 gates, provider fallback, parallel delegation |
| 5 | [loop-antigravity](https://github.com/PerryLink/loop-antigravity) | Circuit breaker, multimodal handler, billing tracker |
| 6 | [loop-codex](https://github.com/PerryLink/loop-codex) | CDP+JSON-RPC dual-channel, CDPGuard L0/L1/L2 |
| 7 | [loop-copilot](https://github.com/PerryLink/loop-copilot) | Think-Act-Observe, watchdog, session hooks |
| 8 | [loop-opencode](https://github.com/PerryLink/loop-opencode) | 8 safety gates, 3-layer architecture |
| 9 | [loop-openclaw](https://github.com/PerryLink/loop-openclaw) | 15 Jinja2 templates, dual-engine rendering, 3 topologies |
| 10 | [loop-deepseek](https://github.com/PerryLink/loop-deepseek) | ReAct loop, reasoning_content caching (40-60% token savings) |
| 📋 | [loop-claudecode](https://github.com/PerryLink/loop-claudecode) | Reference implementation, G1/G2/G3 OS-level gates |

## License

Apache License 2.0 — see [LICENSE](./LICENSE) for full text.

Copyright 2026 Perry Link
