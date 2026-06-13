/**
 * loop-cursor 路由引擎 (Routing Engine)
 *
 * 根据 issues 的严重程度（P0/P1/P2）决定下一 phase 的路由目标。
 * 路由决策是纯引擎逻辑 —— 不产生 agent.send() 调用。
 *
 * 路由规则：
 * - P0 问题：回到 Part 1 设计气泡（方案层面动摇）
 * - P1 问题：设计级 → part_1_3 方案修订；实现级 → part_2_2 定向修复
 * - P2 问题：part_2_2 修复（可并行复数的独立 P2）
 * - 无问题：继续评估收敛状态（递增计数器或进入重验证）
 *
 * @module router
 * @version 0.1.0
 */

import type { LoopState, Issue, Phase } from "./types.js";
import { PhaseEnum } from "./types.js";

// ============================================================================
// 路由结果类型
// ============================================================================

/** 路由决策结果 */
export interface RouteResult {
  /** 路由动作标签 */
  action: string;
  /** 路由目标 phase */
  targetPhase: Phase;
  /** 决策理由 */
  reasoning: string;
  /** 是否需要递增 cycle 计数器 */
  shouldIncrementCycle: boolean;
  /** 修复上下文（P1/P2 修复时附带） */
  repairContext: RepairContext | null;
}

/** 修复上下文 —— 告诉 agent 只修什么、不动什么 */
export interface RepairContext {
  /** 待修复 issue 列表 */
  targetIssues: Issue[];
  /** 允许修改的文件列表 */
  affectedFiles: string[];
  /** 修复原因 */
  reason: string;
  /** 修复阶段 */
  repairPhase: Phase;
}

// ============================================================================
// 主路由函数
// ============================================================================

/**
 * 执行一次路由决策
 *
 * 检查当前 LoopState 中活跃的 issues，根据 P0/P1/P2 分级决定路由目标。
 *
 * 决策树：
 * ```
 *   有 P0? ──是──> part_1_1 (回到设计气泡)
 *     │否
 *   有 P1? ──是──> 设计级? ──是──> part_1_3 (方案修订)
 *     │                     │否
 *     │                     └──> part_2_2 (实现修复)
 *     │否
 *   有 P2? ──是──> part_2_2 (串行或并行修复)
 *     │否
 *   (无 issue)
 *     ├── convergence_counter >= threshold → complete
 *     ├── verification_pass_count < threshold → part_2_8 (重验证)
 *     └── 否则 → complete (等效收敛)
 * ```
 *
 * @param state - 当前 LoopState
 * @returns 路由决策结果
 */
export function determineRoute(state: LoopState): RouteResult {
  const { issues, progress, config } = state;

  const hasP0 = issues.active.p0.length > 0;
  const hasP1 = issues.active.p1.length > 0;
  const hasP2 = issues.active.p2.length > 0;

  // ── 无问题：进入收敛判定 ──
  if (!hasP0 && !hasP1 && !hasP2) {
    return routeNoIssues(state);
  }

  // ── P0：回到 Part 1 设计气泡 ──
  if (hasP0) {
    const p0Titles = issues.active.p0.map((i) => i.description).join(", ");
    return {
      action: "route_to_part1",
      targetPhase: PhaseEnum.PART_1_1,
      reasoning: `检测到 ${issues.active.p0.length} 个 P0 问题: ${p0Titles}。回到需求澄清阶段。`,
      shouldIncrementCycle: true,
      repairContext: null,
    };
  }

  // ── P1：设计级 vs 实现级决策树 ──
  if (hasP1) {
    return routeP1Issues(state);
  }

  // ── P2：实现层修复 ──
  if (hasP2) {
    return routeP2Issues(state);
  }

  // 兜底（理论上不会到这里）
  return {
    action: "fallback_complete",
    targetPhase: PhaseEnum.COMPLETE,
    reasoning: "无问题且收敛判定通过。",
    shouldIncrementCycle: false,
    repairContext: null,
  };
}

// ============================================================================
// 无问题时的收敛路由
// ============================================================================

/**
 * 当无活跃 issue 时，判定是收敛完成还是需要重验证
 *
 * @param state - 当前 LoopState
 * @returns 路由结果
 */
function routeNoIssues(state: LoopState): RouteResult {
  const { progress, config } = state;

  // 收敛计数器达标 → 完成
  if (progress.convergence_counter >= config.convergence_rounds) {
    return {
      action: "converge",
      targetPhase: PhaseEnum.COMPLETE,
      reasoning: `收敛达成：连续 ${progress.convergence_counter} 轮无新问题（阈值 ${config.convergence_rounds}）`,
      shouldIncrementCycle: false,
      repairContext: null,
    };
  }

  // verification_pass_count 不足 → 重新验证以积累置信度
  if (progress.verification_pass_count < config.convergence_rounds) {
    return {
      action: "reverify",
      targetPhase: PhaseEnum.PART_2_8,
      reasoning: `无新问题，但验证通过次数不足（${progress.verification_pass_count + 1}/${config.convergence_rounds}）。重新执行硬验证闸门。`,
      shouldIncrementCycle: false,
      repairContext: null,
    };
  }

  // verification_pass_count >= convergence_rounds → 等效收敛
  return {
    action: "converge_equivalent",
    targetPhase: PhaseEnum.COMPLETE,
    reasoning: `等效收敛：连续 ${progress.verification_pass_count} 次验证通过，无新发现。`,
    shouldIncrementCycle: false,
    repairContext: null,
  };
}

// ============================================================================
// P1 路由：设计级 vs 实现级决策树
// ============================================================================

/**
 * P1 问题 —— 设计级 vs 实现级决策树
 *
 * 判定条件（5 条，满足 ≥ 3 条判定为设计级）：
 *   1. 根因在方案层（description 含 architecture/design/interface/data flow）
 *   2. 修复需改动 ≥ 3 个模块且涉及跨模块接口变更
 *   3. 该 P1 与 routing_history 中已修复问题语义相似（同根因复发）
 *   4. 修复该 P1 之前无法继续执行 ≥ 2 个其他 pending task（阻塞性）
 *   5. P1 为安全漏洞且涉及认证/授权/加密根基
 *
 * @param state - 当前 LoopState
 * @returns 路由结果
 */
function routeP1Issues(state: LoopState): RouteResult {
  const { issues } = state;
  const isDesignLevel = classifyP1AsDesignLevel(state, issues.active.p1);

  if (isDesignLevel) {
    return {
      action: "route_to_design_fix",
      targetPhase: PhaseEnum.PART_1_3,
      reasoning: `P1 问题判定为设计级（${issues.active.p1.length} 个）：根因在架构/接口设计。路由到方案修订阶段。`,
      shouldIncrementCycle: true,
      repairContext: null,
    };
  }

  // 实现级 P1：定向修复
  return {
    action: "route_to_implement_fix",
    targetPhase: PhaseEnum.PART_2_2,
    reasoning: `P1 问题判定为实现级（${issues.active.p1.length} 个）：修复范围已定位。路由到实现修复阶段。`,
    shouldIncrementCycle: true,
    repairContext: {
      targetIssues: issues.active.p1,
      affectedFiles: issues.active.p1.flatMap((i) => i.affected_files ?? []),
      reason: "P1 实现级修复",
      repairPhase: PhaseEnum.PART_2_2,
    },
  };
}

// ============================================================================
// P2 路由：独立问题可并行修复
// ============================================================================

/**
 * P2 问题路由
 *
 * P2 通常为边界 case / UI 瑕疵，路由到 part_2_2 实现修复。
 * 如果多个 P2 彼此独立（文件不重叠），可以并行修复。
 *
 * @param state - 当前 LoopState
 * @returns 路由结果
 */
function routeP2Issues(state: LoopState): RouteResult {
  const { issues } = state;
  const canParallel =
    issues.active.p2.length >= 2 &&
    areIssuesIndependent(issues.active.p2);

  return {
    action: canParallel ? "route_to_parallel_fix" : "route_to_serial_fix",
    targetPhase: PhaseEnum.PART_2_2,
    reasoning: `检测到 ${issues.active.p2.length} 个 P2 问题: ${canParallel ? "可并行修复" : "串行修复"}`,
    shouldIncrementCycle: true,
    repairContext: {
      targetIssues: issues.active.p2,
      affectedFiles: issues.active.p2.flatMap((i) => i.affected_files ?? []),
      reason: "P2 次要修复",
      repairPhase: PhaseEnum.PART_2_2,
    },
  };
}

// ============================================================================
// P1 设计级 vs 实现级分类器
// ============================================================================

/**
 * P1 设计级 vs 实现级决策树评分
 *
 * 5 条判定条件，每条计 1 分，累计 ≥ 3 分判定为设计级问题。
 *
 * @param state - 当前 LoopState（用于检查路由历史中的复发模式）
 * @param p1Issues - 当前活跃的 P1 issue 列表
 * @returns true 表示设计级，false 表示实现级
 */
function classifyP1AsDesignLevel(
  state: LoopState,
  p1Issues: Issue[],
): boolean {
  let score = 0;

  for (const issue of p1Issues) {
    const desc = (issue.description ?? "").toLowerCase();
    const title = (issue.description ?? "").toLowerCase();
    const files = issue.affected_files ?? [];

    // 条件 1：根因在方案层
    if (
      desc.includes("architecture") ||
      desc.includes("design") ||
      desc.includes("interface") ||
      desc.includes("data flow")
    ) {
      score += 1;
    }

    // 条件 2：跨模块影响（≥ 3 个不同的一级目录/模块）
    const modules = new Set(files.map((f) => f.split("/")[0]));
    if (modules.size >= 3) {
      score += 1;
    }

    // 条件 3：同根因复发（检查路由历史中是否有相似问题）
    const similarInHistory = state.routing_history.some(
      (r) =>
        typeof r.reason === "string" &&
        title.length > 10 &&
        r.reason.includes(title.substring(0, 20)),
    );
    if (similarInHistory) {
      score += 1;
    }

    // 条件 4：阻塞多个任务（影响文件 ≥ 2 个）
    if (files.length >= 2) {
      score += 1;
    }

    // 条件 5：安全根基漏洞
    if (
      title.includes("auth") ||
      title.includes("security") ||
      title.includes("encrypt") ||
      title.includes("session") ||
      title.includes("permiss") ||
      title.includes("token") ||
      title.includes("credential")
    ) {
      score += 1;
    }
  }

  // 阈值：≥ 3 条满足 → 设计级
  return score >= 3;
}

// ============================================================================
// issues 独立性判断
// ============================================================================

/**
 * 判断多个 issues 是否彼此独立（可用于并行修复）
 *
 * 独立条件：所有 issues 的 affected_files 没有重叠。
 *
 * @param issues - 待判断的 issue 列表
 * @returns true 表示全部独立（可并行），false 表示存在交叉（需串行）
 */
function areIssuesIndependent(issues: Issue[]): boolean {
  const allFiles = issues.flatMap((i) => i.affected_files ?? []);
  const uniqueFiles = new Set(allFiles);
  // 如果有重叠文件，总文件数会小于各 issue 文件数之和
  return allFiles.length === uniqueFiles.size;
}
