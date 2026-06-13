/**
 * loop-cursor SAP Block 解析器 (SAP Parser)
 *
 * 负责从 agent 响应中提取和解析 <<<LOOP_STATE>>> 自感知协议标记块。
 *
 * 功能：
 * - <<<LOOP_STATE>>> ... <<<END_LOOP_STATE>>> 标记提取
 * - 内容验证：JSON 解析、必需字段检查
 * - 交叉校验：与 state.json 的 phase/issue/task 一致性对比
 * - Markdown code block 内 JSON 提取
 *
 * SAP 协议格式：
 * ```
 * <<<LOOP_STATE>>>
 * {
 *   "phase": "part_2_1",
 *   "issues": { "p0": [...], "p1": [...], "p2": [...] },
 *   "summary": "本轮完成了方案转换",
 *   "tasks": { "total": 5, "completed": 3 }
 * }
 * <<<END_LOOP_STATE>>>
 * ```
 *
 * @module sap-parser
 * @version 0.1.0
 */

import type { Issue, IssueCollection, LoopState } from "./types.js";

// ============================================================================
// 正则模式
// ============================================================================

/**
 * 主 SAP 标记正则
 * 匹配 <<<LOOP_STATE>>> ... <<<END_LOOP_STATE>>> 之间的内容
 */
const LOOP_STATE_RE = /<<<LOOP_STATE>>>\s*([\s\S]*?)\s*<<<END_LOOP_STATE>>>/;

/**
 * Markdown code block 正则（用于从 fenced code block 中提取 JSON）
 * 匹配 ```json ... ``` 或 ``` ... ```
 */
const CODE_BLOCK_RE = /```(?:json)?\s*([\s\S]*?)\s*```/;

/**
 * 后备 SAP 标记正则——无结束标记时的贪婪匹配
 * 用于容错：agent 忘记写 END tag 时仍尝试提取
 */
const LOOSE_SAP_RE = /<<<LOOP_STATE>>>\s*([\s\S]{1,5000}?)(?:<<<END_LOOP_STATE>>>|\s*$)/;

// ============================================================================
// SAP Block 类型
// ============================================================================

/**
 * 解析后的 SAP Block 数据结构
 */
export interface SapBlock {
  /** agent 声明的目标 phase */
  phase?: string;
  /** agent 报告的 issue 集合 */
  issues?: {
    p0?: SapIssueItem[];
    p1?: SapIssueItem[];
    p2?: SapIssueItem[];
  };
  /** 本轮工作摘要 */
  summary?: string;
  /** 任务状态（可选） */
  tasks?: {
    total?: number;
    completed?: number;
    in_progress?: number;
    pending?: number;
    failed?: number;
  };
  /** agent 报告的产出物引用 */
  artifacts?: Record<string, string>;
  /** 额外元数据（允许 agent 携带自定义字段） */
  [key: string]: unknown;
}

/**
 * SAP Block 中的单个 issue 项
 */
export interface SapIssueItem {
  id?: string;
  description: string;
  severity?: string;
  status?: string;
  affected_files?: string[];
}

// ============================================================================
// 解析结果
// ============================================================================

/** SAP 解析结果 */
export interface SapParseResult {
  /** 是否成功提取 SAP block */
  found: boolean;
  /** 解析后的 SAP block 数据（解析成功时） */
  block: SapBlock | null;
  /** 原始匹配文本（调试用） */
  raw: string | null;
  /** 解析错误列表 */
  errors: string[];
  /** 验证警告列表 */
  warnings: string[];
}

// ============================================================================
// 主解析函数
// ============================================================================

/**
 * 从 agent 响应文本中提取 SAP block
 *
 * 解析流程：
 * 1. 用正则匹配 <<<LOOP_STATE>>> ... <<<END_LOOP_STATE>>>
 * 2. 检查内容是否被 markdown code fence 包裹
 * 3. JSON 解析
 * 4. 基础结构验证
 * 5. 如果严格模式失败，尝试宽松模式
 *
 * @param content - agent 响应的完整文本
 * @param strict - 是否严格模式（默认 true：必须有 END tag）
 * @returns SAP 解析结果
 */
export function parseSapBlock(content: string, strict = true): SapParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!content || content.trim().length === 0) {
    return { found: false, block: null, raw: null,
      errors: ["agent 响应内容为空"], warnings: [] };
  }

  // 步骤 1：正则匹配
  const match = strict
    ? LOOP_STATE_RE.exec(content)
    : LOOSE_SAP_RE.exec(content);

  if (!match) {
    return {
      found: false,
      block: null,
      raw: null,
      errors: ["未找到 <<<LOOP_STATE>>> 标记"],
      warnings: [],
    };
  }

  const raw = match[1].trim();

  // 步骤 2：检查并提取 markdown code block 中的 JSON
  let jsonStr = raw;
  const cbMatch = CODE_BLOCK_RE.exec(raw);
  if (cbMatch) {
    jsonStr = cbMatch[1].trim();
  }

  // 步骤 3：JSON 解析
  let parsed: SapBlock;
  try {
    parsed = JSON.parse(jsonStr) as SapBlock;
  } catch (e) {
    // 尝试修复常见 JSON 错误：尾逗号、单引号
    try {
      const fixed = jsonStr
        .replace(/,\s*}/g, "}")
        .replace(/,\s*]/g, "]");
      parsed = JSON.parse(fixed) as SapBlock;
      warnings.push("JSON 格式有小瑕疵，已自动修复（尾逗号）");
    } catch {
      return {
        found: true,
        block: null,
        raw,
        errors: [`SAP block JSON 解析失败: ${(e as Error).message}`],
        warnings,
      };
    }
  }

  // 步骤 4：结构验证
  const sapResult = validateSapBlock(parsed);
  if (sapResult.errors.length > 0) {
    errors.push(...sapResult.errors);
  }
  if (sapResult.warnings.length > 0) {
    warnings.push(...sapResult.warnings);
  }

  return {
    found: true,
    block: parsed,
    raw,
    errors,
    warnings,
  };
}

/**
 * 快速检测 agent 响应中是否包含 SAP block
 *
 * 不做完整解析，仅检查标记是否存在。
 *
 * @param content - agent 响应文本
 * @returns 是否包含 SAP 标记
 */
export function hasSapBlock(content: string): boolean {
  return LOOP_STATE_RE.test(content);
}

// ============================================================================
// SAP Block 验证
// ============================================================================

/** 验证结果 */
interface SapValidationResult {
  errors: string[];
  warnings: string[];
}

/**
 * 验证 SAP block 的基本结构完整性
 *
 * 检查项：
 * - phase 字段是否存在且为有效值
 * - issues 结构是否正确
 * - summary 字段是否存在
 *
 * @param block - 解析后的 SAP block
 * @returns 验证结果
 */
function validateSapBlock(block: SapBlock): SapValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // phase 字段检查
  if (!block.phase) {
    errors.push("SAP block 缺少 phase 字段");
  } else if (typeof block.phase !== "string") {
    errors.push(`SAP block phase 类型错误: ${typeof block.phase}`);
  }

  // issues 结构检查
  if (block.issues) {
    if (typeof block.issues !== "object") {
      errors.push("SAP block issues 不是对象");
    } else {
      // 检查各严重度数组
      const severityLevels = ["p0", "p1", "p2"] as const;
      for (const level of severityLevels) {
        const arr = block.issues[level];
        if (arr !== undefined && !Array.isArray(arr)) {
          errors.push(`SAP block issues.${level} 不是数组`);
        }
      }
    }
  }

  // summary 字段（可选但建议有）
  if (block.summary === undefined) {
    warnings.push("SAP block 缺少 summary 字段（建议提供）");
  }

  return { errors, warnings };
}

// ============================================================================
// 交叉校验
// ============================================================================

/** 交叉校验结果 */
export interface CrossValidationResult {
  /** 一致性是否通过 */
  consistent: boolean;
  /** 差异项列表 */
  discrepancies: string[];
  /** SAP block 是否通过验证 */
  sapValid: boolean;
}

/**
 * 将 SAP block 与 LoopState 进行交叉校验
 *
 * 检查 SAP block 报告的 phase/issues/tasks 是否与 state.json 一致。
 * 用于检测 agent 是否与引擎状态机脱节。
 *
 * 校验项：
 * - phase 一致性：SAP 报告的 phase 是否与 state.progress.phase 可衔接
 * - issue 一致性：SAP 报告的 issue 是否与 state.issues 无矛盾
 * - 数据合理性：数值是否在合法范围内
 *
 * @param sapBlock - 解析后的 SAP block
 * @param state - 当前的 LoopState
 * @returns 交叉校验结果
 */
export function crossValidate(
  sapBlock: SapBlock,
  state: LoopState,
): CrossValidationResult {
  const discrepancies: string[] = [];
  let sapValid = true;

  // 校验 1：phase 是否存在
  if (!sapBlock.phase) {
    discrepancies.push("SAP block 未报告 phase");
    sapValid = false;
  }

  // 校验 2：issue 数据类型检查
  if (sapBlock.issues) {
    const severityLevels = ["p0", "p1", "p2"] as const;
    for (const level of severityLevels) {
      const arr = sapBlock.issues[level];
      if (arr && !Array.isArray(arr)) {
        discrepancies.push(`SAP issues.${level} 类型错误（期望数组）`);
        sapValid = false;
      }
    }
  }

  // 校验 3：SAP issues 与 state issues 对比
  // SAP block 中的新 issue 不应与 state 中已有的 issue 重复
  if (sapBlock.issues && sapValid) {
    const stateDescriptions = new Set([
      ...state.issues.active.p0.map((i) => i.description),
      ...state.issues.active.p1.map((i) => i.description),
      ...state.issues.active.p2.map((i) => i.description),
    ]);

    for (const level of ["p0", "p1", "p2"] as const) {
      const sapIssues = (sapBlock.issues[level] ?? []) as SapIssueItem[];
      for (const si of sapIssues) {
        if (stateDescriptions.has(si.description)) {
          discrepancies.push(
            `SAP ${level.toUpperCase()} issue "${si.description}" 与 state 中的已有 issue 重复`,
          );
        }
      }
    }
  }

  // 校验 4：tasks 数值合理性
  if (sapBlock.tasks) {
    if (
      typeof sapBlock.tasks.total === "number" &&
      sapBlock.tasks.total < 0
    ) {
      discrepancies.push("SAP tasks.total 为负数");
    }
    if (
      typeof sapBlock.tasks.completed === "number" &&
      typeof sapBlock.tasks.total === "number" &&
      sapBlock.tasks.completed > sapBlock.tasks.total
    ) {
      discrepancies.push("SAP tasks.completed > tasks.total（不合逻辑）");
    }
  }

  return {
    consistent: discrepancies.length === 0 && sapValid,
    discrepancies,
    sapValid,
  };
}

// ============================================================================
// Issue 提取与转换
// ============================================================================

/**
 * 从 SAP block 中提取 issue 为标准化 Issue 列表
 *
 * 为缺失 id 的 issue 自动生成唯一标识。
 *
 * @param sapBlock - 解析后的 SAP block
 * @returns 标准化的 IssueCollection
 */
export function extractIssuesFromSap(sapBlock: SapBlock): IssueCollection {
  const result: IssueCollection = { p0: [], p1: [], p2: [] };

  const normalize = (
    items: SapIssueItem[] | undefined,
    severity: "P0" | "P1" | "P2",
  ): Issue[] => {
    if (!items || !Array.isArray(items)) return [];
    return items.map((item) => ({
      id:
        item.id ??
        `sap-${severity.toLowerCase()}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`,
      description: item.description ?? "未描述",
      severity,
      status: (item.status as "open" | "closed") ?? "open",
      affected_files: item.affected_files ?? [],
    }));
  };

  result.p0 = normalize(sapBlock.issues?.p0, "P0");
  result.p1 = normalize(sapBlock.issues?.p1, "P1");
  result.p2 = normalize(sapBlock.issues?.p2, "P2");

  return result;
}

/**
 * 从 SAP block 中提取 agent 报告的任务状态
 *
 * @param sapBlock - 解析后的 SAP block
 * @returns 任务状态计数对象，无数据时返回 null
 */
export function extractTasksFromSap(sapBlock: SapBlock): {
  total: number;
  completed: number;
  in_progress: number;
  pending: number;
  failed: number;
} | null {
  if (!sapBlock.tasks) return null;

  return {
    total: sapBlock.tasks.total ?? 0,
    completed: sapBlock.tasks.completed ?? 0,
    in_progress: sapBlock.tasks.in_progress ?? 0,
    pending: sapBlock.tasks.pending ?? 0,
    failed: sapBlock.tasks.failed ?? 0,
  };
}

/**
 * 构建标准 SAP block JSON 字符串
 *
 * 用于生成符合协议的 SAP block 文本（如日志输出或手工构建）。
 *
 * @param phase - 目标 phase
 * @param summary - 本轮摘要
 * @param issues - issue 集合（可选）
 * @returns 完整的 SAP block 文本
 */
export function buildSapBlock(
  phase: string,
  summary: string,
  issues?: IssueCollection,
): string {
  const block: SapBlock = {
    phase,
    summary,
  };

  if (issues) {
    block.issues = {
      p0: issues.p0.map(formatIssueForSap),
      p1: issues.p1.map(formatIssueForSap),
      p2: issues.p2.map(formatIssueForSap),
    };
  }

  const json = JSON.stringify(block, null, 2);
  return `<<<LOOP_STATE>>>\n${json}\n<<<END_LOOP_STATE>>>`;
}

/**
 * 格式化单个 issue 为 SAP 简练格式
 */
function formatIssueForSap(issue: Issue): SapIssueItem {
  return {
    id: issue.id,
    description: issue.description,
    severity: issue.severity,
    status: issue.status ?? "open",
    affected_files: issue.affected_files,
  };
}

// ============================================================================
// 多 SAP Block 支持
// ============================================================================

/**
 * 从 agent 响应中提取所有 SAP block（支持多 block 场景）
 *
 * 某些 agent 可能在一轮响应中输出多个 SAP block
 * （如复述指令 + 实际报告）。返回所有匹配项。
 *
 * @param content - agent 响应文本
 * @returns 所有 SAP block 的解析结果数组
 */
export function parseAllSapBlocks(content: string): SapParseResult[] {
  const results: SapParseResult[] = [];

  // 使用全局正则捕获所有 SAP block
  const globalRe =
    /<<<LOOP_STATE>>>\s*([\s\S]*?)\s*<<<END_LOOP_STATE>>>/g;
  let match: RegExpExecArray | null;

  while ((match = globalRe.exec(content)) !== null) {
    const raw = match[1].trim();
    let jsonStr = raw;
    const cbMatch = CODE_BLOCK_RE.exec(raw);
    if (cbMatch) jsonStr = cbMatch[1].trim();

    try {
      const parsed = JSON.parse(jsonStr) as SapBlock;
      results.push({
        found: true,
        block: parsed,
        raw,
        errors: [],
        warnings: [],
      });
    } catch {
      results.push({
        found: true,
        block: null,
        raw,
        errors: ["JSON 解析失败"],
        warnings: [],
      });
    }
  }

  return results;
}
