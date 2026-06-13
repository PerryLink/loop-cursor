/**
 * RuleGenerator (M2) —— 动态生成 12 个 phase 的 .cursor/rules/ .mdc rule 文件
 *
 * 职责：
 * 1. 根据当前 phase 生成对应的 .mdc rule 文件（包含 frontmatter + globs + Markdown 内容）
 * 2. 生成全局护栏 rule（loop-cursor-global.mdc，alwaysApply: true）
 * 3. 清理非当前 phase 的过期 rule 文件
 * 4. 提供 Phase -> globs -> content 的完整映射表（12 phase + global）
 * 5. 支持批量生成所有 rule 文件（初次初始化或 --regenerate-rules 场景）
 *
 * 12 个 phase 清单：
 * init / part_1_1 / part_1_2 / part_1_3 / part_2_1 / part_2_2
 * part_2_3 / part_2_4 / part_2_5 / part_2_6 / part_2_7 / part_2_8
 *
 * 文件命名约定：
 * - Phase rule:  .cursor/rules/loop-cursor-phase-{phase-slug}.mdc
 * - Global rule: .cursor/rules/loop-cursor-global.mdc
 *
 * 运行上下文：在每次 agent.send() 前由 SDK 引擎（非 agent）写入文件系统。
 * agent 仅读取这些 rule 文件——SDK 引擎负责写入。
 *
 * @module rules-generator
 * @version 0.2.0 (M2)
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Phase ID —— 与 state.json 的 progress.phase 字段一致
 * 共 12 个可生成 rule 的 phase + 4 个终端 phase（不生成 rule）
 */
export type PhaseId =
  | "init"
  | "part_1_1" | "part_1_2" | "part_1_3"
  | "part_2_1" | "part_2_2" | "part_2_3" | "part_2_4"
  | "part_2_5" | "part_2_6" | "part_2_7" | "part_2_8"
  | "routing" | "complete" | "paused" | "failed";

/**
 * .mdc 文件的 frontmatter 元数据结构
 * Cursor IDE 解析这些字段来决定 rule 的适用范围和行为
 */
export interface MdcFrontmatter {
  /** rule 描述（显示在 Cursor IDE 的 rules 面板） */
  description: string;
  /** glob 模式数组——限定 agent 的 Read/Write/Edit 操作范围 */
  globs: string[];
  /** 是否在所有 phase 自动生效（全局 rule 为 true，phase rule 为 false） */
  alwaysApply: boolean;
}

/**
 * 单个 phase 的 rule 模板定义
 */
export interface PhaseRuleTemplate {
  /** phase ID */
  phase: PhaseId;
  /** slug——用于文件名（将 phase ID 中的下划线转为连字符） */
  slug: string;
  /** frontmatter 元数据 */
  frontmatter: MdcFrontmatter;
  /** content 生成函数——接收 artifacts 根路径，返回完整 Markdown 内容 */
  contentFn: (artifactsRoot: string) => string;
}

/**
 * RuleGenerator 配置
 */
export interface RuleGeneratorConfig {
  /** .cursor/rules/ 目录的绝对路径 */
  rulesDir: string;
  /** artifacts/ 目录的相对路径（用于在 rule content 中引用） */
  artifactsRoot: string;
}

// ============================================================================
// Phase -> globs 映射表（12 个 phase）
// ============================================================================

/**
 * Phase 到 globs 的映射表
 *
 * globs 设计原则：
 * - 空数组 = 不对文件作用域施加限制（init / 终端阶段）
 * - Part 1 阶段（设计气泡）仅需读写 .md 文件和 artifacts 目录
 * - Part 2 阶段根据子 phase 不同逐步扩大文件作用域
 * - 只读 phase（part_2_3/part_2_7/part_2_8）不开放 src/ globs
 */
const PHASE_TO_GLOBS: Record<PhaseId, string[]> = {
  init: [],
  part_1_1: ["*.md", ".cursor/loop-cursor/artifacts/**"],
  part_1_2: ["*.md", ".cursor/loop-cursor/artifacts/**"],
  part_1_3: ["*.md", ".cursor/loop-cursor/artifacts/**"],
  part_2_1: [".cursor/loop-cursor/artifacts/**", "*.md"],
  part_2_2: ["src/**", "tests/**", ".cursor/loop-cursor/artifacts/**"],
  part_2_3: [".cursor/loop-cursor/artifacts/**"],
  part_2_4: [".cursor/loop-cursor/artifacts/**", "*.md"],
  part_2_5: ["tests/**", ".cursor/loop-cursor/artifacts/**"],
  part_2_6: ["tests/**", "src/**", ".cursor/loop-cursor/artifacts/**"],
  part_2_7: [".cursor/loop-cursor/artifacts/**"],
  part_2_8: [".cursor/loop-cursor/artifacts/**"],
  routing: [],
  complete: [],
  paused: [],
  failed: [],
};

// ============================================================================
// Phase -> 描述映射表
// ============================================================================

/** 每个 phase 的 frontmatter description（显示在 Cursor 规则面板） */
const PHASE_DESCRIPTIONS: Record<PhaseId, string> = {
  init: "loop-cursor phase=init — 代码库探索与状态初始化",
  part_1_1: "loop-cursor phase=part_1_1 — 需求澄清（设计气泡）",
  part_1_2: "loop-cursor phase=part_1_2 — 方向研究（设计气泡）",
  part_1_3: "loop-cursor phase=part_1_3 — 方案形成（设计气泡）",
  part_2_1: "loop-cursor phase=part_2_1 — 方案 → 计划 + 任务分解",
  part_2_2: "loop-cursor phase=part_2_2 — 实施编码",
  part_2_3: "loop-cursor phase=part_2_3 — Code Review",
  part_2_4: "loop-cursor phase=part_2_4 — E2E 测试策略",
  part_2_5: "loop-cursor phase=part_2_5 — 测试规划",
  part_2_6: "loop-cursor phase=part_2_6 — 执行测试",
  part_2_7: "loop-cursor phase=part_2_7 — 审计与验证",
  part_2_8: "loop-cursor phase=part_2_8 — 硬验证闸门",
  routing: "loop-cursor phase=routing — 引擎内部路由（不触发 agent）",
  complete: "loop-cursor phase=complete — 任务完成",
  paused: "loop-cursor phase=paused — 任务暂停，等待用户输入",
  failed: "loop-cursor phase=failed — 任务失败",
};

// ============================================================================
// phase ID -> slug 转换
// ============================================================================

/** 将 phase ID 中的下划线转为连字符，用于文件名 */
function phaseToSlug(phase: PhaseId): string {
  return phase.replace(/_/g, "-");
}

// ============================================================================
// 各 phase 的 rule content 模板（12 个 phase）
// ============================================================================

/**
 * init phase：代码库探索与初始化
 * 生成 01-init.mdc 规则文件内容
 */
function buildInitRule(artifactsRoot: string): string {
  return `# Phase: init — 代码库探索与初始化

## 角色
你是 loop-cursor 的初始化 agent。你的任务是探索代码库、理解项目上下文并初始化状态。

## 目标
1. 使用 Bash 工具探索当前目录结构（ls、find、git log 等）
2. 识别项目类型、语言、框架和构建系统
3. 将发现结果以结构化摘要形式报告
4. 如果 state.json 不存在，通过 Bash 创建初始状态文件
5. 创建 git worktree 用于隔离实施

## 允许的操作
- 读取项目中任意文件
- 执行只读 Bash 命令（ls、find、cat、git status、git log、node --version 等）
- 创建 .cursor/loop-cursor/state.json（仅当不存在时）
- 创建 git worktree：git worktree add .cursor/loop-cursor/worktrees/impl-$(date +%s)

## 禁止的操作
- 不得修改 .cursor/loop-cursor/ 以外的文件
- 不得删除文件
- 不得执行 git push、git commit、git merge
- 不得安装依赖
- 不得创建 PR

## 停止条件
- 已探索代码库 AND
- 输出 <<<LOOP_STATE>>> block，phase 设为 "part_1_1" AND
- summary 字段包含探索发现

## 上下文
- 用户需求：从 .cursor/loop-cursor/state.json → config.user_request 读取
- Artifacts 根目录：${artifactsRoot}
`;
}

/**
 * init phase 的简化版（用于轻量初始化）
 */
function buildInitRuleLight(artifactsRoot: string): string {
  return `# Phase: init (light) — 最小化初始化

## 目标
快速初始化 loop-cursor 项目，建立基本目录结构。

## 产出
- .cursor/loop-cursor/ 目录结构
- 初始 state.json
- 如果任务简单，可直接路由到 part_2_2 跳过设计阶段

## 操作限制
- 仅创建目录和初始文件
- 不得修改源代码
- 不得提交或推送
- 输出 <<<LOOP_STATE>>> block

## Artifacts 根目录：${artifactsRoot}
`;
}

/**
 * Part 1 设计气泡：part_1_1 / part_1_2 / part_1_3
 * 三个子 phase 共享设计气泡框架，各自有独立的 objectives
 */
function buildDesignBubbleRule(
  phase: PhaseId,
  artifactsRoot: string,
): string {
  // 子 phase 特定的目标
  const objectives: Record<string, string> = {
    part_1_1: `## 子阶段目标：需求澄清 (part_1_1)
1. 从 state.json → config.user_request 读取用户需求
2. 提出澄清性问题，消除需求歧义
3. 识别至少 3 个潜在模糊点（编码、格式、边界条件、范围、NFR）
4. 为每个模糊点提出合理假设并记录
5. 产出 ${artifactsRoot}/01-requirements.md —— 结构化需求文档
   - 问题陈述
   - 功能需求（编号、可测试）
   - 非功能需求（性能、安全、UX）
   - 显式排除的范围
   - 已做的假设及理由
6. 自检：是否仍有未解决的模糊点？如有，在此 agent.send() 内迭代`,

    part_1_2: `## 子阶段目标：方向研究 (part_1_2)
1. 读取 ${artifactsRoot}/01-requirements.md
2. 识别至少 2 个可行的技术方向/方案
3. 对每个方向评估：
   - 技术可行性（需具体证据）
   - 性能特征
   - 依赖引入量（是否需要新库）
   - 维护负担
   - 与现有代码库模式的对齐程度
4. 产出 ${artifactsRoot}/02-direction.md —— 方向推荐文档
   - 每个方向描述含优劣和风险
   - 明确的推荐及理由
   - 已识别的权衡取舍
5. 自检：推荐方向是否明显优于其他？如不明显，在此 agent.send() 内迭代`,

    part_1_3: `## 子阶段目标：方案形成 (part_1_3)
1. 读取 ${artifactsRoot}/01-requirements.md 和 ${artifactsRoot}/02-direction.md
2. 综合形成具体可执行的解决方案
3. 产出 ${artifactsRoot}/03-solution.md —— 完整方案文档：
   - 架构概览（文本/Mermaid 图示）
   - 数据流：输入 → 处理 → 输出
   - 组件/模块划分及职责
   - API/接口定义（如适用）
   - 错误处理策略
   - 测试策略概述
   - 实施顺序/阶段
   - 任何未确定性以 "ASSUMPTION: ..." 显式标注
4. 自检：开发者能否在不提问的情况下实施此方案？
   如果不能，在此 agent.send() 内迭代`,
  };

  return `# Phase: ${phase} — 设计气泡（Design Bubble）

## 角色
你是 loop-cursor 的设计阶段 agent，运行在单次 agent.send() 调用中（"设计气泡"）。
此调用内上下文连续——你可以在子阶段之间迭代而不会丢失信息。

## 设计气泡规则
- 你在此单次 agent.send() 中内部迭代：part_1_1 → part_1_2 → part_1_3
- 允许回溯：如果 1.2 发现 1.1 的需求有误，返回修改 1.1
- 必须产出全部三份 artifact 文件后方可完成：
  - ${artifactsRoot}/01-requirements.md
  - ${artifactsRoot}/02-direction.md
  - ${artifactsRoot}/03-solution.md
- 如果达到 max_part1_rounds（默认 5）仍未收敛，将剩余不确定性标记为 ASSUMPTION 并继续输出

${objectives[phase] ?? ""}

## 允许的操作
- 读取 .md 文件和 ${artifactsRoot}/ 下的 artifact
- 写入 ${artifactsRoot}/ 下的 .md 文件
- 读取源代码文件以了解上下文
- 执行只读 Bash 命令进行探索

## 禁止的操作
- 不得修改源代码（src/、lib/ 等）
- 不得安装依赖
- 不得执行 git push、git commit、git merge
- 不得删除 artifacts/ 之外的文件
- 不得在 ${artifactsRoot}/ 之外创建文件（context-summary.md 除外）

## 停止条件（三子阶段全部完成后）
- ${artifactsRoot}/01-requirements.md 存在且非空（>200 字符）
- ${artifactsRoot}/02-direction.md 存在且评估了至少 2 个方向
- ${artifactsRoot}/03-solution.md 存在且可执行
- 输出 <<<LOOP_STATE>>> block，phase 设为 "part_2_1"

## 上下文
- 用户需求：state.json → config.user_request
- 历史上下文：${artifactsRoot}/context-summary.md（如存在）
- Artifacts 根目录：${artifactsRoot}
`;
}

/**
 * part_2_1：方案 → 计划 + 任务分解
 */
function buildPart21Rule(artifactsRoot: string): string {
  return `# Phase: part_2_1 — 方案 → 计划 + 任务

## 角色
你是 loop-cursor 的计划 agent。你的任务是将解决方案分解为包含离散可验证任务的可执行计划。

## 目标
1. 读取 ${artifactsRoot}/03-solution.md —— 完整方案文档
2. 将方案分解为有序实施计划
3. 产出 ${artifactsRoot}/04-implementation-plan.md：
   - 含依赖关系的实施阶段
   - 每个阶段：构建目标、预期文件、验收标准
   - 风险项及缓解措施
   - 每个阶段的预估工作量（T-shirt sizes: S/M/L/XL）
4. 产出 ${artifactsRoot}/05-task-list.json —— 结构化任务清单：
   格式见下方 JSON schema
5. 任务要求：原子、可验证、依赖有序、文件作用域明确

### 05-task-list.json 格式
\`\`\`json
{
  "tasks": [{
    "id": "T001",
    "phase": "implementation",
    "title": "简短任务描述",
    "files_to_create": ["path/to/file.ts"],
    "files_to_modify": [],
    "dependencies": [],
    "acceptance_criteria": ["具体的可验证条件"],
    "status": "pending",
    "effort": "S"
  }],
  "metadata": {
    "total_tasks": 0,
    "generated_at": "ISO timestamp",
    "solution_ref": "03-solution.md"
  }
}
\`\`\`

## 停止条件
- ${artifactsRoot}/04-implementation-plan.md 存在且覆盖所有方案组件
- ${artifactsRoot}/05-task-list.json 存在且为 JSON 格式，至少 1 个任务
- 输出 <<<LOOP_STATE>>> block，phase 设为 "part_2_2"
`;
}

/**
 * part_2_2：实施编码
 */
function buildPart22Rule(artifactsRoot: string): string {
  return `# Phase: part_2_2 — 实施编码

## 角色
你是 loop-cursor 的实施 agent。按 05-task-list.json 中的顺序执行任务。

## 目标
1. 读取 ${artifactsRoot}/05-task-list.json —— 有序任务清单
2. 读取 ${artifactsRoot}/04-implementation-plan.md —— 实施计划
3. 读取 ${artifactsRoot}/03-solution.md —— 方案参考
4. 按依赖顺序执行任务：
   a. 对每个 pending 任务，创建/修改指定文件
   b. 每完成一个任务，验证验收标准
   c. 更新 05-task-list.json 中的任务状态
   d. 任务失败则记录原因并继续下一个独立任务
5. 全部完成后生成 ${artifactsRoot}/05b-implementation-diff.patch：git diff > ...
6. 如果 state.json 中设置了 repair_context，仅修复指定问题

## 允许的操作
- 读写 src/ 和 tests/ 下的文件
- 执行构建和测试命令（Bash）
- 执行 git add / git diff（但不得 git commit 或 git push）

## 禁止的操作
- 不得 merge commit（git merge）
- 不得创建 PR
- 不得 push 到远端
- 不得修改 state.json
- 不得修改 hooks/ 和 rules/ 下的文件

## 停止条件
- 全部任务状态为 completed（或 failed 且已记录原因）
- ${artifactsRoot}/05b-implementation-diff.patch 已生成
- 输出 <<<LOOP_STATE>>> block，phase 设为 "part_2_3"
`;
}

/**
 * part_2_3：Code Review（只读）
 */
function buildPart23Rule(artifactsRoot: string): string {
  return `# Phase: part_2_3 — Code Review（只读）

## 角色
你是 loop-cursor 的 code review agent。对实施代码进行全面的质量审查。

## 目标
1. 读取 ${artifactsRoot}/05b-implementation-diff.patch
2. 审查以下维度：
   a. 正确性：代码是否正确实现方案设计
   b. 完整性：全部任务是否真的完成
   c. 代码质量：命名、结构、错误处理、边界条件、DRY
   d. 安全性：输入验证、注入风险、密钥处理
   e. 性能：明显瓶颈、不必要分配
   f. 可维护性：注释、复杂度、耦合度
3. 产出 ${artifactsRoot}/06-code-review.md：
   - 总体评估
   - 发现清单（severity P0/P1/P2，file:line，fix suggestion）
   - 通过的文件和需改进的文件
   - 判定：APPROVED / CHANGES_REQUESTED

## 允许的操作
- 读取 src/ 和 tests/ 下所有文件
- 读取 ${artifactsRoot}/ 下所有 artifact
- 执行 git diff/git show（只读）
- 写入 ${artifactsRoot}/06-code-review.md

## 禁止的操作
- 不得修改源代码（这是审查，不是修复）
- 不得修改测试
- 不得 git push、git commit、git merge

## 停止条件
- ${artifactsRoot}/06-code-review.md 存在且包含明确审查结论
- 输出 <<<LOOP_STATE>>> block，phase 设为 "part_2_4"
`;
}

/**
 * part_2_4：E2E 测试策略
 */
function buildPart24Rule(artifactsRoot: string): string {
  return `# Phase: part_2_4 — E2E 测试策略

## 角色
你是 loop-cursor 的测试策略师。研究和定义端到端测试方法。

## 目标
1. 读取 ${artifactsRoot}/03-solution.md 了解需要测试的内容
2. 确定测试金字塔：
   - 单元测试范围和覆盖率目标
   - 集成测试范围
   - E2E 测试范围（完整用户旅程）
3. 产出 ${artifactsRoot}/07-test-plan.md（初始策略部分）：
   - 测试框架推荐
   - Mock/Stub 策略
   - 测试数据策略
   - 覆盖率目标

## 允许的操作
- 读取 src/ 下源代码
- 读取 ${artifactsRoot}/ 下 artifact
- 写入 ${artifactsRoot}/07-test-plan.md

## 禁止的操作
- 不得修改源代码
- 不得创建测试文件（这是策略阶段）

## 停止条件
- ${artifactsRoot}/07-test-plan.md 存在且包含完整测试策略
- 输出 <<<LOOP_STATE>>> block，phase 设为 "part_2_5"
`;
}

/**
 * part_2_5：测试规划
 */
function buildPart25Rule(artifactsRoot: string): string {
  return `# Phase: part_2_5 — 测试规划

## 角色
你是 loop-cursor 的测试规划师。将测试策略转化为具体可执行的测试计划。

## 目标
1. 读取 ${artifactsRoot}/07-test-plan.md —— 测试策略
2. 设计具体测试用例：
   - 单元测试：每个函数/方法一个，覆盖 happy path + 边界 + 错误路径
   - 集成测试：组件交互场景
   - E2E 测试：完整用户旅程场景
3. 追加到 ${artifactsRoot}/07-test-plan.md：
   - 详细测试用例列表（ID、描述、输入、期望输出、测试类型）
   - 测试文件映射
   - 执行顺序和依赖
   - Mock/Stub 规格

## 允许的操作
- 读取 src/ 和 tests/ 下文件
- 读取/追加 ${artifactsRoot}/07-test-plan.md

## 禁止的操作
- 不得修改源代码
- 不得创建测试代码（这是规划，不是写测试）

## 停止条件
- ${artifactsRoot}/07-test-plan.md 包含详细测试用例规范
- 输出 <<<LOOP_STATE>>> block，phase 设为 "part_2_6"
`;
}

/**
 * part_2_6：执行测试
 */
function buildPart26Rule(artifactsRoot: string): string {
  return `# Phase: part_2_6 — 执行测试

## 角色
你是 loop-cursor 的测试执行 agent。根据测试计划编写并运行测试。

## 目标
1. 读取 ${artifactsRoot}/07-test-plan.md —— 待实现的测试用例
2. 按测试计划在 tests/ 下编写测试文件
3. 执行全部测试并记录结果
4. 产出 ${artifactsRoot}/08-test-results.json：
   - summary: total/passed/failed/skipped/duration/coverage
   - test_runs: 每个测试的详细结果
5. 测试失败则诊断根因——测试bug/实施bug/环境问题

## 允许的操作
- 写入/编辑 tests/ 下所有文件
- 读取 src/ 下文件（理解，不修改）
- 执行测试命令（Bash）
- 写入 ${artifactsRoot}/08-test-results.json

## 禁止的操作
- 不得修改 src/ 下源代码
- 不得 git push、git commit、git merge

## 停止条件
- 测试文件已创建并执行
- ${artifactsRoot}/08-test-results.json 存在
- 输出 <<<LOOP_STATE>>> block，phase 设为 "part_2_7"
`;
}

/**
 * part_2_7：审计与验证（只读）
 */
function buildPart27Rule(artifactsRoot: string): string {
  return `# Phase: part_2_7 — 审计与验证（只读）

## 角色
你是 loop-cursor 的审计 agent。系统性验证全部 artifact 并识别任何遗留缺口。

## 目标
1. 审计所有 artifact 的完整性和一致性
2. 交叉引用：
   - 03-solution.md ↔ 04-implementation-plan.md ↔ 05-task-list.json
   - 05-task-list.json ↔ 源代码文件
   - 06-code-review.md 中的发现是否已解决
   - 08-test-results.json 是否覆盖关键路径
3. 产出 ${artifactsRoot}/09-issue-list.json —— 结构化问题清单

## 允许的操作
- 读取 src/、tests/ 和 ${artifactsRoot}/ 下全部文件
- 写入 ${artifactsRoot}/09-issue-list.json
- 执行只读验证命令

## 禁止的操作
- 不得修改任何文件（查找问题，不修复）

## 停止条件
- ${artifactsRoot}/09-issue-list.json 存在
- 所有 P0 问题已解决（无新的 P0 发现）
- 输出 <<<LOOP_STATE>>> block，phase 设为 "part_2_8"
`;
}

/**
 * part_2_8：硬验证闸门（只读）
 */
function buildPart28Rule(artifactsRoot: string): string {
  return `# Phase: part_2_8 — 硬验证闸门（只读，最后关卡）

## 角色
你是 loop-cursor 的最终验证 agent。这是声明完成前的最后一道闸门。
你必须提供无可辩驳的证据证明任务已完成。

## 目标
1. 验证交付物：
   - 最终输出是否符合用户原始需求？端到端运行并捕获输出作为证据
2. 验证质量：
   - 重新运行全部测试——确认 100% 通过
   - 运行 lint/静态分析（如配置）
   - 确认无回归
3. 验证 artifact 链条完整性
4. 产出 ${artifactsRoot}/10-verification.md：
   - 验证检查清单（每项 PASS/FAIL + 证据）
   - 测试重新运行输出
   - 应用输出
   - 最终判定：READY_FOR_COMPLETION / NEEDS_FIX

## 允许的操作
- 读取 src/、tests/ 和 ${artifactsRoot}/ 下全部文件
- 执行验证（运行应用、运行测试、lint 等）
- 写入 ${artifactsRoot}/10-verification.md

## 禁止的操作
- 不得修改源代码
- 不得修改测试
- 不得修改 artifact（这是读取并验证，不是修复）

## 停止条件
- ${artifactsRoot}/10-verification.md 存在且全部检查项已验证
- 输出 <<<LOOP_STATE>>> block，phase 设为 "routing"

## 关键
如果任何验证项失败，你必须在 LOOP_STATE block 中将其报告为 issue。
不要自行修复——routing 引擎将决定是回退还是终止。
`;
}

/**
 * 全局护栏 rule（alwaysApply: true，在所有 phase 生效）
 */
function buildGlobalRule(): string {
  return `# loop-cursor 全局护栏 —— 始终活跃

## 不可变规则（不得绕过、不得协商）

1. 不得直接修改 .cursor/loop-cursor/state.json
   （状态更新由 loop-cursor SDK 引擎处理）
2. 不得修改 .cursor/loop-cursor/hooks/ 下的文件
   （Hook 脚本已编译且不可变）
3. 不得修改 .cursor/rules/loop-cursor-*.mdc 文件
   （Rule 文件由 loop-cursor SDK 引擎生成）
4. 不得创建 PR 或 merge（loop-cursor 管理 git 工作流）
   可使用 git add 和 git diff，但不得 git commit、git merge 或 gh pr create
5. 不得 push 到任何远程仓库
6. 每个 phase 完成后必须追加 context-summary.md
7. 每轮 agent 响应末尾必须输出 <<<LOOP_STATE>>> block
   格式：JSON 对象，含 phase、issues（p0/p1/p2 数组）和 summary 字段

## Phase 感知行为

检查当前 phase：.cursor/loop-cursor/state.json → progress.phase
应用对应的 phase rule 文件（.cursor/rules/loop-cursor-phase-*.mdc）

## 安全覆盖

- 灾难性命令（rm -rf /、mkfs、dd to /dev、DROP TABLE、force push main/master）
  由 hooks.json beforeShellExecution 在 OS 层硬拦截——不可绕过
- 路径保护：.cursor/loop-cursor/state.json、hooks/、rules/ 由 hooks.json
  preToolUse 匹配器在文件系统层保护

## 输出格式要求

每个响应必须以 <<<LOOP_STATE>>> block 结尾：

\`\`\`
<<<LOOP_STATE>>>
{
  "phase": "<current_or_next_phase>",
  "issues": {
    "p0": [{"id":"...", "title":"...", "file":"..."}],
    "p1": [],
    "p2": []
  },
  "summary": "<one-sentence summary of what was accomplished this turn>"
}
<<<END_LOOP_STATE>>>
\`\`\`

此 block 是强制性的——SDK 引擎解析它以驱动状态转换。
没有它，引擎无法确定下一 phase。
`;
}


// ============================================================================
// Phase -> content 生成函数的映射表
// ============================================================================

/** Content builder 函数签名 */
type ContentBuilder = (artifactsRoot: string) => string;

/** Phase 到 content 生成函数的映射 */
const PHASE_CONTENT_BUILDERS: Record<PhaseId, ContentBuilder> = {
  init: (root) => buildInitRule(root),
  part_1_1: (root) => buildDesignBubbleRule("part_1_1", root),
  part_1_2: (root) => buildDesignBubbleRule("part_1_2", root),
  part_1_3: (root) => buildDesignBubbleRule("part_1_3", root),
  part_2_1: (root) => buildPart21Rule(root),
  part_2_2: (root) => buildPart22Rule(root),
  part_2_3: (root) => buildPart23Rule(root),
  part_2_4: (root) => buildPart24Rule(root),
  part_2_5: (root) => buildPart25Rule(root),
  part_2_6: (root) => buildPart26Rule(root),
  part_2_7: (root) => buildPart27Rule(root),
  part_2_8: (root) => buildPart28Rule(root),
  routing: (_root) => "",
  complete: (_root) => "",
  paused: (_root) => "",
  failed: (_root) => "",
};

/** 需要生成 rule 文件的 phase 列表（12 个） */
const GENERATABLE_PHASES: PhaseId[] = [
  "init",
  "part_1_1", "part_1_2", "part_1_3",
  "part_2_1", "part_2_2", "part_2_3", "part_2_4",
  "part_2_5", "part_2_6", "part_2_7", "part_2_8",
];

// ============================================================================
// RuleGenerator 主类
// ============================================================================

export class RuleGenerator {
  private readonly config: Required<RuleGeneratorConfig>;
  private static readonly RULE_PREFIX = "loop-cursor-phase-";
  private static readonly GLOBAL_RULE = "loop-cursor-global";

  constructor(config: RuleGeneratorConfig) {
    this.config = {
      rulesDir: config.rulesDir,
      artifactsRoot: config.artifactsRoot,
    };
  }

  // ========================================================================
  // 公开 API
  // ========================================================================

  generate(phase: PhaseId): string {
    const rulePath = this.getRulePath(phase);
    const content = this.buildRuleContent(phase);
    this.ensureRulesDir();
    writeFileSync(rulePath, content, "utf-8");
    return rulePath;
  }

  generateGlobal(): string {
    const rulePath = join(
      this.config.rulesDir,
      RuleGenerator.GLOBAL_RULE + ".mdc",
    );
    const frontmatter: MdcFrontmatter = {
      description: "loop-cursor global guardrails — ALWAYS ACTIVE",
      globs: [],
      alwaysApply: true,
    };
    const content = buildGlobalRule();
    const fullContent = this.assembleRuleFile(frontmatter, content);
    this.ensureRulesDir();
    writeFileSync(rulePath, fullContent, "utf-8");
    return rulePath;
  }

  cleanup(currentPhase: PhaseId): string[] {
    if (!existsSync(this.config.rulesDir)) return [];

    const currentRuleName = RuleGenerator.RULE_PREFIX + phaseToSlug(currentPhase) + ".mdc";
    const globalRuleName = RuleGenerator.GLOBAL_RULE + ".mdc";
    const deleted: string[] = [];

    for (const entry of readdirSync(this.config.rulesDir)) {
      if (
        !entry.startsWith(RuleGenerator.RULE_PREFIX) &&
        entry !== globalRuleName
      ) continue;
      if (entry === currentRuleName) continue;
      if (entry === globalRuleName) continue;
      try { unlinkSync(join(this.config.rulesDir, entry)); deleted.push(entry); }
      catch { /* 文件可能已被外部删除 */ }
    }
    return deleted;
  }

  generateAll(): string[] {
    const generated: string[] = [];
    for (const phase of GENERATABLE_PHASES) {
      generated.push(this.generate(phase));
    }
    generated.push(this.generateGlobal());
    return generated;
  }

  getRulePath(phase: PhaseId): string {
    return join(
      this.config.rulesDir,
      RuleGenerator.RULE_PREFIX + phaseToSlug(phase) + ".mdc",
    );
  }

  getGlobalRulePath(): string {
    return join(this.config.rulesDir, RuleGenerator.GLOBAL_RULE + ".mdc");
  }

  getGlobsForPhase(phase: PhaseId): string[] {
    return PHASE_TO_GLOBS[phase] ?? [];
  }

  getDescriptionForPhase(phase: PhaseId): string {
    return PHASE_DESCRIPTIONS[phase] ?? "loop-cursor phase=" + phase;
  }

  listGeneratablePhases(): PhaseId[] {
    return [...GENERATABLE_PHASES];
  }

  ensureRulesDir(): void {
    if (!existsSync(this.config.rulesDir)) {
      mkdirSync(this.config.rulesDir, { recursive: true });
    }
  }

  hasRule(phase: PhaseId): boolean {
    return existsSync(this.getRulePath(phase));
  }

  hasGlobalRule(): boolean {
    return existsSync(this.getGlobalRulePath());
  }

  // ========================================================================
  // 内部方法
  // ========================================================================

  private buildRuleContent(phase: PhaseId): string {
    const fm = this.buildFrontmatter(phase);
    const builder = PHASE_CONTENT_BUILDERS[phase];
    const content = builder
      ? builder(this.config.artifactsRoot)
      : "# Phase: " + phase + "\n\n终端阶段，无需 rule 内容。\n";
    return this.assembleRuleFile(fm, content);
  }

  private buildFrontmatter(phase: PhaseId): MdcFrontmatter {
    return {
      description: PHASE_DESCRIPTIONS[phase] ?? "loop-cursor phase=" + phase,
      globs: PHASE_TO_GLOBS[phase] ?? [],
      alwaysApply: false,
    };
  }

  private serializeFrontmatter(fm: MdcFrontmatter): string {
    const lines: string[] = ["---"];
    const desc = fm.description.replace(/"/g, '\"');
    lines.push('description: "' + desc + '"');
    if (fm.globs.length > 0) {
      lines.push("globs:");
      for (const g of fm.globs) {
        lines.push('  - "' + g + '"');
      }
    } else {
      lines.push("globs: []");
    }
    lines.push("alwaysApply: " + fm.alwaysApply);
    lines.push("---");
    return lines.join("\n");
  }

  private assembleRuleFile(fm: MdcFrontmatter, content: string): string {
    return this.serializeFrontmatter(fm) + "\n\n" + content.trim() + "\n";
  }
}

// ============================================================================
// 便捷工厂函数
// ============================================================================

export function createRuleGenerator(
  projectRoot?: string,
  artifactsRoot?: string,
): RuleGenerator {
  const base = projectRoot ?? process.cwd();
  return new RuleGenerator({
    rulesDir: join(base, ".cursor", "rules"),
    artifactsRoot: artifactsRoot ?? ".cursor/loop-cursor/artifacts",
  });
}

// ============================================================================
// 导出映射表
// ============================================================================

export {
  PHASE_TO_GLOBS,
  PHASE_DESCRIPTIONS,
  PHASE_CONTENT_BUILDERS,
  GENERATABLE_PHASES,
  buildGlobalRule,
};
