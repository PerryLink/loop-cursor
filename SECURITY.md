# Security Policy / 安全策略

**loop-cursor** takes security seriously. This document outlines the project's security
policies, supported versions, and procedures for reporting vulnerabilities.

**loop-cursor** 高度重视安全。本文档概述了项目的安全策略、受支持版本以及漏洞报告流程。

---

Copyright (c) 2026 Perry Link (GitHub: PerryLink, novelnexusai@outlook.com).
Licensed under the Apache License, Version 2.0.

---

## Table of Contents / 目录

- [Supported Versions / 受支持的版本](#supported-versions--受支持的版本)
- [Reporting a Vulnerability / 报告安全漏洞](#reporting-a-vulnerability--报告安全漏洞)
- [Security Model: Cursor SDK / 安全模型：Cursor SDK](#security-model-cursor-sdk--安全模型cursor-sdk)
- [Dependency Security / 依赖安全](#dependency-security--依赖安全)
- [Disclosure Policy / 披露政策](#disclosure-policy--披露政策)
- [Security Best Practices / 安全最佳实践](#security-best-practices--安全最佳实践)
- [Acknowledgments / 致谢](#acknowledgments--致谢)

---

## Supported Versions / 受支持的版本

Only the latest release receives security patches. Older versions are not supported.

仅最新版本会收到安全补丁更新，旧版本不受支持。

| Version  | Supported          |
|----------|--------------------|
| 0.1.x    | :white_check_mark: |
| < 0.1.0  | :x:                |

---

## Reporting a Vulnerability / 报告安全漏洞

### If You Discover a Vulnerability / 如果您发现安全漏洞

**Please do NOT open a public GitHub issue.** Instead, report vulnerabilities
privately via email:

**请不要在 GitHub 上公开提交 Issue。** 请通过以下邮箱私下报告安全漏洞：

> **Email:** novelnexusai@outlook.com
>
> **Subject:** [SECURITY] Brief description of the issue / 安全问题简述

### What to Include / 报告应包含的内容

1. A detailed description of the vulnerability / 漏洞的详细描述
2. Steps to reproduce / 复现步骤
3. Affected versions / 受影响版本
4. Potential impact / 潜在影响
5. Any suggested fixes (optional) / 修复建议（可选）

### Response Process / 响应流程

1. **Acknowledgment within 48 hours** — You will receive an initial response
   acknowledging receipt of your report.
2. **Triage within 5 business days** — We will assess the severity and scope.
3. **Fix development** — A fix will be developed in a private branch.
4. **Coordinated disclosure** — We will coordinate a public disclosure date
   with you once the fix is ready and deployed.

We follow the [principle of coordinated vulnerability disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure).

---

1. **48 小时内确认** — 您将收到确认收到报告的回复。
2. **5 个工作日内分类** — 我们将评估严重程度和影响范围。
3. **开发修复** — 修复将在私有分支中开发。
4. **协调披露** — 修复就绪并部署后，我们将与您协调公开披露日期。

我们遵循[协调漏洞披露原则](https://zh.wikipedia.org/wiki/负责任的漏洞披露)。

---

## Security Model: Cursor SDK / 安全模型：Cursor SDK

### Overview / 概述

loop-cursor integrates with the Cursor SDK via `@loop-cursor/adapter-cursor-sdk`.
This adapter acts as a bridge between the loop-cursor orchestration engine and
the Cursor AI coding assistant.

loop-cursor 通过 `@loop-cursor/adapter-cursor-sdk` 与 Cursor SDK 集成。此适配器
作为 loop-cursor 编排引擎与 Cursor AI 编程助手之间的桥梁。

### Guardrails / 安全护栏

The adapter enforces **7 safety gates** on every agent action:

该适配器对每个 agent 操作强制执行 **7 个安全闸门**：

| Gate | Name / 名称 | Function / 功能 |
|------|-------------|-----------------|
| G1   | Content Safety / 内容安全 | Validates agent output for malicious or harmful content / 验证 agent 输出是否包含恶意或有害内容 |
| G2   | Plan Confirmation / 计划确认 | Requires user approval before executing plans / 执行计划前需要用户确认 |
| G3   | Dependency Install / 依赖安装 | Audits npm/pip dependencies before installation / 安装前审计 npm/pip 依赖 |
| G4   | Dangerous Ops / 危险操作 | Blocks or confirms dangerous operations (`rm -rf`, `chmod 777`, etc.) / 阻止或确认危险操作 |
| G5   | File Mutation / 文件变更 | Tracks and validates all file modifications / 跟踪并验证所有文件修改 |
| G6   | Completion Declaration / 完成声明 | Validates that a task is genuinely complete / 验证任务是否真正完成 |
| G7   | State Protection / 状态保护 | Prevents corruption of the internal state machine / 防止内部状态机损坏 |

### SAP Block Parsing / SAP 块解析

The engine parses `<<<LOOP_STATE>>>` blocks from agent responses to extract
structured state data. Malformed SAP blocks are rejected at parse time.

引擎从 agent 响应中解析 `<<<LOOP_STATE>>>` 块以提取结构化状态数据。格式错误的
SAP 块在解析时会被拒绝。

### Model Management / 模型管理

All AI model interactions go through the platform adapter, which enforces
model availability checks and version compatibility. No direct model API
calls are made outside the adapter.

所有 AI 模型交互都通过平台适配器进行，适配器强制执行模型可用性检查和版本兼容性。
适配器外部不进行直接的模型 API 调用。

---

## Dependency Security / 依赖安全

### Audit Process / 审计流程

Dependencies are audited on every CI run using `npm audit --audit-level=high`.
The CI pipeline fails if high or critical severity vulnerabilities are detected.

每次 CI 运行都会使用 `npm audit --audit-level=high` 审计依赖项。如果检测到高危或
严重漏洞，CI 管道将失败。

### Dependency Policy / 依赖策略

- Direct dependencies are pinned to exact versions / 直接依赖固定到精确版本
- Transitive dependency updates are reviewed before merging / 合并前审查传递依赖更新
- Critical dependencies (`@cursor/sdk`) are monitored for security advisories / 监控关键依赖的安全公告
- No external CDN or runtime-downloaded scripts / 不使用外部CDN或运行时下载的脚本

### Known Issues / 已知问题

There are currently no known unpatched vulnerabilities in the project's
dependency tree.

目前项目依赖树中没有已知的未修补漏洞。

---

## Disclosure Policy / 披露政策

### Timeline / 时间线

1. **Day 0**: Vulnerability reported / 收到漏洞报告
2. **Day 0-2**: Initial triage and acknowledgment / 初步分类并确认
3. **Day 2-10**: Fix development and testing / 开发并测试修复
4. **Day 10-30**: Coordinated public disclosure / 协调公开披露

### Severity Classification / 严重程度分类

| Severity / 严重程度 | Example / 示例 | Disclosure Window / 披露窗口 |
|---------------------|----------------|-----------------------------|
| **Critical** | Remote code execution, auth bypass / 远程代码执行、认证绕过 | 30 days / 天 |
| **High** | Data exposure, privilege escalation / 数据泄露、权限提升 | 60 days / 天 |
| **Medium** | DoS, information leak / 拒绝服务、信息泄露 | 90 days / 天 |
| **Low** | Minor configuration issues / 轻微配置问题 | Next release / 下个版本 |

If a fix is ready earlier than the disclosure window, we will publish it immediately.
We will not withhold security fixes.

如果修复在披露窗口之前就绪，我们会立即发布，不会扣留安全修复。

---

## Security Best Practices / 安全最佳实践

For users and contributors of loop-cursor:

### For Users / 用户须知

1. Always run the latest version / 始终运行最新版本
2. Review plan confirmations before approving / 在批准前审查计划确认
3. Do not share state files (`.loop-cursor/state.json`) — they may contain
   sensitive project context / 不要共享状态文件，它们可能包含敏感的项目上下文
4. Use `sdk:check` to verify SDK integrity after updates / 更新后使用 `sdk:check`
   验证 SDK 完整性

### For Contributors / 贡献者须知

1. Never commit secrets, API keys, or tokens / 不要提交密钥、API 密钥或令牌
2. All new code must pass through safety gates in test / 所有新代码必须在测试中通过安全闸门
3. Run `npm run security-audit` before submitting PRs / 提交 PR 前运行安全审计
4. Sign your commits / 签署您的提交

---

## Acknowledgments / 致谢

We thank all security researchers who responsibly disclose vulnerabilities.
Contributors who report valid security issues will be acknowledged here (with permission).

我们感谢所有负责任地披露漏洞的安全研究人员。报告有效安全问题的贡献者将在此处致谢（经许可）。

---

Copyright 2026 Perry Link, novelnexusai@outlook.com, GitHub PerryLink.
Licensed under Apache License 2.0.
