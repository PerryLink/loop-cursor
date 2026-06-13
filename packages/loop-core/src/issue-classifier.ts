/**
 * loop-cursor 问题分类器 (Issue Classifier)
 *
 * 负责对 agent 报告的问题进行严重度判定和优先级排序。
 *
 * 功能：
 * - P0 检测：致命设计问题（需求/架构/方案层面错误）
 * - P1 决策树：5 设计条件 + 4 否定条件，区分设计级和实现级
 * - P2 检测：实施层面问题（边界 case、UI 瑕疵、性能微调）
 * - 优先级排序：P0 > P1(设计级) > P1(实现级) > P2
 * - 去重和合并
 *
 * 设计原则：
 * - P0 = 方案/需求层面动摇，必须回到 Part 1 重新设计
 * - P1 = 核心功能缺失/安全漏洞，需判定设计级还是实现级
 * - P2 = 次要问题，可在 Part 2 内修复
 *
 * @module issue-classifier
 * @version 0.1.0
 */

import type { Issue, IssueCollection } from "./types.js";

// ============================================================================
// 分类结果类型
// ============================================================================

/** 分类结果 */
export interface ClassificationResult {
  /** 分类后的 issue 集合（按 P0/P1/P2 分组） */
  collection: IssueCollection;
  /** 分类统计摘要 */
  summary: ClassificationSummary;
}

/** 分类统计摘要 */
export interface ClassificationSummary {
  /** 总 issue 数 */
  total: number;
  /** 各严重度计数 */
  p0Count: number;
  p1Count: number;
  p2Count: number;
  /** P1 中判定为设计级的数量 */
  p1DesignLevel: number;
  /** P1 中判定为实现级的数量 */
  p1ImplementLevel: number;
}

// ============================================================================
// P0 检测关键词
// ============================================================================

/**
 * P0 检测关键词列表
 *
 * 当描述中包含以下任一模式时，立即判定为 P0。
 * P0 表示需求/方案/架构层面的根本性错误。
 */
const P0_PATTERNS: RegExp[] = [
  /需求\s*(错误|变更|矛盾|冲突|不明确)/,
  /requirement\s*(error|change|conflict|ambiguous)/i,
  /architecture\s*(flaw|error|broken|wrong|invalid)/i,
  /设计\s*(错误|缺陷|不可行|矛盾)/,
  /design\s*(flaw|error|broken|wrong|invalid|impossible)/i,
  /方案\s*(不可行|错误|推翻|废弃)/,
  /core\s*assumption\s*(wrong|invalid|broken)/i,
  /breaking\s*change\s*(required|needed|must)/i,
  /完全\s*(错误|不可行|重新设计)/,
  /fundamental\s*(flaw|error|mistake)/i,
  /从零\s*(重写|重构)/,
  /schema\s*(incompatible|breaking)/i,
  /数据模型\s*(错误|不兼容|不可逆)/,
  /API\s*(breaking|incompatible|deprecated\s*and\s*removed)/i,
  /security\s*(breach|vulnerability|exploit)\s*(critical|severe)/i,
  /安全\s*(漏洞|泄露)\s*(严重|致命)/,
];

// ============================================================================
// P1 设计条件（5 条）
// ============================================================================

/**
 * P1 设计级判定条件（5 条）
 *
 * 满足 ≥ 3 条 → 判定为设计级 P1 → 路由到 part_1_3
 * 满足 < 3 条 → 判定为实现级 P1 → 路由到 part_2_2
 */

/** 条件 1：根因在方案层（描述中含特定关键词） */
const P1_DESIGN_CONDITION_1_PATTERNS = [
  /architecture/i, /design/i, /interface/i,
  /data\s*flow/i, /protocol/i, /contract/i,
  /schema\s*(change|migration|incompatible)/i,
  /架构/, /设计模式/, /接口设计/, /数据流/,
];

/** 条件 2：跨模块影响（≥ 3 个不同的一级目录/模块） */
const P1_CROSS_MODULE_THRESHOLD = 3;

/** 条件 3：同根因复发（与路由历史中已有问题语义相似） */
const P1_DESIGN_CONDITION_3_PATTERNS = [
  /recurring/i, /again/i, /reappear/i,
  /再次/, /重现/, /复发/, /依然(存在|未解决)/,
];

/** 条件 4：阻塞性（修复前无法继续执行 ≥ 2 个其他 pending task） */
const P1_BLOCKING_THRESHOLD = 2;

/** 条件 5：安全根基漏洞 */
const P1_SECURITY_PATTERNS = [
  /auth(entication|orization)?\s*(bypass|flaw|broken)/i,
  /security\s*(vulnerability|hole|flaw)/i,
  /encrypt(ion)?\s*(broken|weak|missing)/i,
  /session\s*(hijack|fixation|steal)/i,
  /permiss(ion)?\s*(escalation|bypass|missing)/i,
  /token\s*(steal|leak|forge|replay)/i,
  /credential\s*(leak|expos|steal|hardcode)/i,
  /认证/, /授权/, /加密/, /权限提升/,
  /CVE-\d{4}-\d{4,}/i,
];

// ============================================================================
// P1 否定条件（4 条）
// ============================================================================

/**
 * P1 否定条件（4 条）
 *
 * 当以下条件中任意一条满足且未被设计条件覆盖时，
 * 即使设计条件得分不足 3 分，也可能仍判定为实现级而非设计级。
 *
 * 否定条件不会将设计级降为实现级——它们只在设计条件不满足时
 * 作为"非设计级"的辅助证据。
 */

/** 否定条件 1：修复范围 ≤ 1 个文件 */
function isSingleFileFix(issue: Issue): boolean {
  return (issue.affected_files ?? []).length <= 1;
}

/** 否定条件 2：修复为纯实现细节（类型错误、空值检查、边界条件等） */
const IMPLEMENTATION_ONLY_PATTERNS = [
  /type\s*error/i, /null\s*pointer/i, /undefined\s*is\s*not/i,
  /off[-_ ]by[-_ ]one/i, /boundary\s*check/i,
  /missing\s*(null|undefined)\s*check/i,
  /类型错误/, /空指针/, /未定义/,
  /变量\s*未\s*(定义|声明)/, /参数\s*(遗漏|缺失)/,
];

/** 否定条件 3：已有明确的补丁/修复代码（非设计讨论） */
function hasConcreteFix(issue: Issue): boolean {
  const desc = (issue.description ?? "").toLowerCase();
  return (
    desc.includes("patch") ||
    desc.includes("fix:") ||
    desc.includes("补丁") ||
    desc.includes("修复方案:") ||
    desc.includes("diff")
  );
}

/** 否定条件 4：问题仅影响测试/文档/构建脚本（非核心业务逻辑） */
const NON_CORE_PATHS = [
  /^tests?\//, /^docs?\//, /^\.github\//,
  /^scripts?\//, /\.test\./, /\.spec\./,
];

// ============================================================================
// P2 检测关键词
// ============================================================================

/** P2 特征模式——次要/边缘问题 */
const P2_PATTERNS: RegExp[] = [
  /edge\s*case/i, /boundary\s*condition/i,
  /UI\s*(glitch|bug|issue|瑕疵)/i,
  /minor\s*(issue|bug|fix)/i,
  /typo/i, /spelling/i,
  /性能\s*(微调|优化|改进)/,
  /accessibility\s*(minor|warning)/i,
  /错误\s*(提示|文案|措辞)/,
  /TODO/i, /FIXME/i,
  /code\s*style/i, /formatting/i,
  /deprecation\s*warning/i,
  /import\s*优化/,
];

// ============================================================================
// 主分类函数
// ============================================================================

/**
 * 对一批 issue 进行严重度分类
 *
 * 分类规则（优先级降序）：
 * 1. P0 检测：匹配 P0 关键词 → P0
 * 2. P1 判定：匹配安全/设计关键词或跨模块影响 → P1，进一步分设计级/实现级
 * 3. P2 检测：匹配 P2 关键词 → P2
 * 4. 默认：未匹配任何模式 → P2（保守策略，避免遗漏）
 *
 * @param issues - 待分类的 issue 列表
 * @returns 分类结果
 */
export function classifyIssues(issues: Issue[]): ClassificationResult {
  const p0: Issue[] = [];
  const p1: Issue[] = [];
  const p2: Issue[] = [];

  for (const issue of issues) {
    const severity = determineSeverity(issue);

    const classified: Issue = {
      ...issue,
      severity,
      status: issue.status ?? "open",
    };

    switch (severity) {
      case "P0":
        p0.push(classified);
        break;
      case "P1":
        p1.push(classified);
        break;
      case "P2":
        p2.push(classified);
        break;
    }
  }

  // P1 设计级/实现级计数
  const p1DesignCount = p1.filter((i) =>
    isP1DesignLevel(i),
  ).length;

  return {
    collection: { p0, p1, p2 },
    summary: {
      total: issues.length,
      p0Count: p0.length,
      p1Count: p1.length,
      p2Count: p2.length,
      p1DesignLevel: p1DesignCount,
      p1ImplementLevel: p1.length - p1DesignCount,
    },
  };
}

/**
 * 判定单个 issue 的严重度
 *
 * @param issue - 待判定的 issue
 * @returns "P0" | "P1" | "P2"
 */
export function determineSeverity(issue: Issue): "P0" | "P1" | "P2" {
  // 如果已有明确分类，直接返回
  if (issue.severity === "P0" || issue.severity === "P1" || issue.severity === "P2") {
    return issue.severity;
  }

  const desc = issue.description ?? "";
  const files = issue.affected_files ?? [];

  // 规则 1：P0 检测
  if (isP0(desc, files)) {
    return "P0";
  }

  // 规则 2：P1 检测
  if (isP1(desc, files)) {
    return "P1";
  }

  // 规则 3：P2 检测
  if (isP2(desc, files)) {
    return "P2";
  }

  // 默认：保守策略——归为 P2（防止遗漏）
  return "P2";
}

// ============================================================================
// P0 检测器
// ============================================================================

/**
 * 检测 issue 是否为 P0 级问题
 *
 * P0 定义：需求/方案/架构层面的根本性错误。
 * 一旦发现 P0，必须回到 Part 1 设计气泡。
 *
 * @param description - 问题描述
 * @param affectedFiles - 受影响文件列表
 * @returns 是否为 P0
 */
export function isP0(description: string, affectedFiles?: string[]): boolean {
  if (!description || description.trim().length === 0) return false;

  const desc = description.toLowerCase();

  // 直接匹配 P0 模式
  for (const pattern of P0_PATTERNS) {
    if (pattern.test(desc)) {
      return true;
    }
  }

  // 辅助判断：影响文件跨核心模块（使用前两级路径识别模块）
  if (affectedFiles && affectedFiles.length >= 4) {
    const modules = new Set(
      affectedFiles
        .map((f) => f.replace(/\\/g, "/").replace(/\/$/, ""))
        .filter((f) => !f.startsWith("test") && !f.startsWith("doc"))
        .map((f) => {
          const parts = f.split("/");
          // 取前两级路径作为模块标识（如 src/api, src/db）
          return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
        }),
    );
    if (modules.size >= 4) {
      // 跨 4 个以上模块的改动——可能涉及架构级问题
      const highImpactFiles = affectedFiles.filter(
        (f) =>
          f.includes("schema") ||
          f.includes("migration") ||
          f.includes("interface") ||
          f.includes("config") ||
          f.includes("api/route"),
      );
      if (highImpactFiles.length >= 2) {
        return true;
      }
    }
  }

  return false;
}

// ============================================================================
// P1 检测器 + 决策树
// ============================================================================

/**
 * 检测 issue 是否为 P1 级问题
 *
 * P1 定义：核心功能缺失/安全漏洞/跨模块影响。
 * 需要进一步判定设计级还是实现级。
 *
 * @param description - 问题描述
 * @param affectedFiles - 受影响文件列表
 * @returns 是否为 P1
 */
export function isP1(description: string, affectedFiles?: string[]): boolean {
  if (!description || description.trim().length === 0) return false;

  const desc = description.toLowerCase();

  // 安全相关关键词
  if (P1_SECURITY_PATTERNS.some((p) => p.test(desc))) {
    return true;
  }

  // 跨模块影响（≥ 3 个模块，使用前两级路径识别模块）
  if (affectedFiles && affectedFiles.length >= 3) {
    const modules = new Set(
      affectedFiles
        .map((f) => f.replace(/\\/g, "/").replace(/\/$/, ""))
        .map((f) => {
          const parts = f.split("/");
          return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
        }),
    );
    if (modules.size >= P1_CROSS_MODULE_THRESHOLD) {
      return true;
    }
  }

  // 核心功能缺失
  if (
    /\b(core|critical|essential|breaking|严重|核心|关键|阻断)\b/i.test(desc) &&
    /\b(function|feature|capability|功能|特性)\b/i.test(desc) &&
    /\b(missing|broken|failed|lost|缺失|损坏|失败)\b/i.test(desc)
  ) {
    return true;
  }

  // 数据一致性
  if (
    /data\s*(corrupt|loss|inconsist|race|竞态|数据)|数据\s*(损坏|丢失|不一致|竞争)/i.test(
      desc,
    )
  ) {
    return true;
  }

  return false;
}

/**
 * P1 设计级 vs 实现级决策树
 *
 * 5 条设计条件，每条计 1 分，累计 ≥ 3 分判定为设计级。
 * 4 条否定条件作为辅助参考（不减少分数，仅当设计条件全不满足时判定为实现级）。
 *
 * @param issue - 待判定的 P1 issue
 * @returns true 表示设计级，false 表示实现级
 */
export function isP1DesignLevel(issue: Issue): boolean {
  if (issue.severity !== "P1") return false;

  const desc = (issue.description ?? "").toLowerCase();
  const files = issue.affected_files ?? [];
  let designScore = 0;
  let negateScore = 0;

  // ── 5 条设计条件 ──

  // 条件 1：根因在方案层
  if (P1_DESIGN_CONDITION_1_PATTERNS.some((p) => p.test(desc))) {
    designScore += 1;
  }

  // 条件 2：跨模块影响（≥ 3 个模块，使用前两级路径识别）
  const modules = new Set(
    files.map((f) => f.replace(/\\/g, "/").replace(/\/$/, "")).map((f) => {
      const parts = f.split("/");
      return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    }),
  );
  if (modules.size >= P1_CROSS_MODULE_THRESHOLD) {
    designScore += 1;
  }

  // 条件 3：复发模式
  if (P1_DESIGN_CONDITION_3_PATTERNS.some((p) => p.test(desc))) {
    designScore += 1;
  }

  // 条件 4：阻塞性（影响 ≥ 2 个文件或跨模块）
  if (files.length >= P1_BLOCKING_THRESHOLD) {
    designScore += 1;
  }

  // 条件 5：安全根基漏洞
  if (P1_SECURITY_PATTERNS.some((p) => p.test(desc))) {
    designScore += 1;
  }

  // ── 4 条否定条件（判定为实现级辅助） ──

  // 否定条件 1：单文件修复
  if (isSingleFileFix(issue)) {
    negateScore += 1;
  }

  // 否定条件 2：纯实现细节
  if (IMPLEMENTATION_ONLY_PATTERNS.some((p) => p.test(desc))) {
    negateScore += 1;
  }

  // 否定条件 3：已有具体修复代码
  if (hasConcreteFix(issue)) {
    negateScore += 1;
  }

  // 否定条件 4：仅影响非核心路径
  if (files.length > 0 && files.every((f) => NON_CORE_PATHS.some((p) => p.test(f)))) {
    negateScore += 1;
  }

  // 判定：设计条件 ≥ 3 → 设计级
  // 如设计条件不满足但否定条件 ≥ 3 → 实现级（强实现信号）
  // 否则保守判定为实现级（默认）
  if (designScore >= 3) {
    return true;
  }

  // 设计条件 2 分 且 否定条件 ≤ 1 → 模糊地带，偏向设计级
  if (designScore === 2 && negateScore <= 1) {
    return true;
  }

  return false;
}

// ============================================================================
// P2 检测器
// ============================================================================

/**
 * 检测 issue 是否为 P2 级问题
 *
 * P2 定义：边界 case、UI 瑕疵、次要优化建议。
 * 可以在 Part 2 实施阶段并行或串行修复。
 *
 * @param description - 问题描述
 * @param affectedFiles - 受影响文件列表
 * @returns 是否为 P2
 */
export function isP2(description: string, affectedFiles?: string[]): boolean {
  if (!description || description.trim().length === 0) return false;

  const desc = description.toLowerCase();
  const files = affectedFiles ?? [];

  // 匹配 P2 特征
  for (const pattern of P2_PATTERNS) {
    if (pattern.test(desc)) {
      return true;
    }
  }

  // 仅影响测试/文档文件
  if (
    files.length > 0 &&
    files.every((f) => {
      const n = f.replace(/\\/g, "/");
      return n.startsWith("tests/") || n.startsWith("docs/") || n.endsWith(".md");
    })
  ) {
    return true;
  }

  // 纯格式/注释问题
  if (
    /\b(whitespace|indent|comment|formatting|换行|缩进|注释|格式)\b/i.test(desc)
  ) {
    return true;
  }

  return false;
}

// ============================================================================
// 优先级排序
// ============================================================================

/**
 * 对 issue 集合进行优先级排序
 *
 * 排序优先级：P0 > P1(设计级) > P1(实现级) > P2
 * 同级内按 affected_files 数量降序（影响面大的优先）
 *
 * @param collection - 待排序的 issue 集合
 * @returns 排序后的 issue 数组
 */
export function sortByPriority(collection: IssueCollection): Issue[] {
  const allIssues: Array<Issue & { _priorityScore: number }> = [];

  for (const p0 of collection.p0) {
    allIssues.push({
      ...p0,
      _priorityScore: 1000 + (p0.affected_files?.length ?? 0),
    });
  }

  for (const p1 of collection.p1) {
    const isDesign = isP1DesignLevel(p1);
    allIssues.push({
      ...p1,
      _priorityScore: (isDesign ? 700 : 500) + (p1.affected_files?.length ?? 0),
    });
  }

  for (const p2 of collection.p2) {
    allIssues.push({
      ...p2,
      _priorityScore: 100 + (p2.affected_files?.length ?? 0),
    });
  }

  // 按优先级分数降序排列
  allIssues.sort((a, b) => b._priorityScore - a._priorityScore);

  // 移除内部排序字段后返回
  return allIssues.map(({ _priorityScore, ...issue }) => issue);
}

/**
 * 获取最高优先级 issue 的严重度
 *
 * @param collection - issue 集合
 * @returns 最高优先级严重度，无 issue 时返回 "none"
 */
export function getTopPriority(collection: IssueCollection): "P0" | "P1" | "P2" | "none" {
  if (collection.p0.length > 0) return "P0";
  if (collection.p1.length > 0) return "P1";
  if (collection.p2.length > 0) return "P2";
  return "none";
}

/**
 * 按严重度分离 issue（输入扁平列表，输出分组集合）
 *
 * @param issues - 扁平 issue 列表
 * @returns 分组的 IssueCollection
 */
export function separateBySeverity(issues: Issue[]): IssueCollection {
  const result: IssueCollection = { p0: [], p1: [], p2: [] };

  for (const issue of issues) {
    const severity = issue.severity;
    if (severity === "P0") result.p0.push(issue);
    else if (severity === "P1") result.p1.push(issue);
    else result.p2.push(issue);
  }

  return result;
}

/**
 * 输出分类统计的格式化报告
 *
 * @param summary - 分类摘要
 * @returns 格式化的统计字符串
 */
export function formatClassificationReport(summary: ClassificationSummary): string {
  const lines: string[] = [
    "=== Issue 分类报告 ===",
    `总计: ${summary.total} 个问题`,
    `  P0: ${summary.p0Count} (致命设计问题)`,
    `  P1: ${summary.p1Count} (设计级 ${summary.p1DesignLevel}, 实现级 ${summary.p1ImplementLevel})`,
    `  P2: ${summary.p2Count} (次要问题)`,
  ];

  if (summary.p0Count > 0) {
    lines.push("");
    lines.push("优先处理 P0（需回到设计气泡）");
  } else if (summary.p1DesignLevel > 0) {
    lines.push("");
    lines.push("优先处理 P1 设计级（需方案修订）");
  }

  return lines.join("\n");
}
