/**
 * loop-cursor 收敛引擎 (Convergence Engine)
 *
 * 收敛引擎负责判定工作流是否已达到稳定状态。
 * 两套收敛判定路径：
 * 1. 标准收敛：所有 issue 关闭 + convergence_counter >= convergence_rounds
 * 2. 等效收敛：连续 verification_pass_count >= convergence_rounds 且无新发现
 *
 * convergence_counter 操作规则（按优先级降序）：
 *   1. 不在 routing 步骤 → 不更新
 *   2. 路由目标指向 Part 1 → reset = 0
 *   3. 本轮发现新 P1 → reset = 0
 *   4. 本轮发现新 P2 → reset = 0
 *   5. 无新问题 + 所有关闭 → +1
 *
 * @module convergence
 * @version 0.1.0
 */

import type { LoopState, IssueCollection, ResolvedIssueCount } from "./types.js";

// ============================================================================
// 收敛判定结果类型
// ============================================================================

/** 收敛检查结果 */
export interface ConvergenceResult {
  /** 是否已收敛（可终止） */
  converged: boolean;
  /** 收敛类型 */
  type: "standard" | "equivalent" | "none";
  /** 判定原因 */
  reason: string;
  /** 更新后的 convergence_counter */
  newConvergenceCounter: number;
  /** 更新后的 verification_pass_count */
  newVerificationPassCount: number;
}

/** convergence_counter 操作类型 */
export type CounterAction = "reset" | "increment" | "keep";

// ============================================================================
// 收敛状态快照（用于对比本轮前后变化）
// ============================================================================

/** 轮次开始时的 issue 快照 */
export interface IssueSnapshot {
  p0: number;
  p1: number;
  p2: number;
}

// ============================================================================
// 主收敛判定函数
// ============================================================================

/**
 * 判定当前工作流是否已收敛
 *
 * 调用时机：在 routing 步骤或 part_2_8（硬验证闸门）完成后。
 * 如果所有活跃 issue 已关闭且收敛计数器达到阈值，判定为标准收敛。
 * 如果连续多轮验证无新发现，判定为等效收敛。
 *
 * @param state - 当前 LoopState
 * @returns 收敛判定结果（含更新后的计数器值）
 */
export function judgeConvergence(state: LoopState): ConvergenceResult {
  const { progress, config, issues } = state;
  const counter = progress.convergence_counter;
  const rounds = config.convergence_rounds;

  // 检查是否所有活跃 issue 已关闭
  const allResolved =
    issues.active.p0.length === 0 &&
    issues.active.p1.length === 0 &&
    issues.active.p2.length === 0;

  // 路径 1：标准收敛 —— 所有 issue 解决 + 计数器达标
  if (allResolved && counter >= rounds) {
    return {
      converged: true,
      type: "standard",
      reason: `标准收敛达成：所有 issue 已解决，连续 ${counter} 轮无新问题（阈值 ${rounds}）`,
      newConvergenceCounter: counter,
      newVerificationPassCount: progress.verification_pass_count,
    };
  }

  // 路径 2：等效收敛 —— 连续验证通过
  if (allResolved && progress.verification_pass_count >= rounds) {
    return {
      converged: true,
      type: "equivalent",
      reason: `等效收敛达成：连续 ${progress.verification_pass_count} 次验证通过，无新发现（阈值 ${rounds}）`,
      newConvergenceCounter: counter,
      newVerificationPassCount: progress.verification_pass_count,
    };
  }

  // 未收敛
  return {
    converged: false,
    type: "none",
    reason: allResolved
      ? `所有 issue 已解决，但收敛计数器 ${counter}/${rounds} 未达标，需继续验证`
      : `仍有活跃 issue: P0=${issues.active.p0.length}, P1=${issues.active.p1.length}, P2=${issues.active.p2.length}`,
    newConvergenceCounter: counter,
    newVerificationPassCount: progress.verification_pass_count,
  };
}

// ============================================================================
// convergence_counter 操作函数
// ============================================================================

/**
 * 根据路由目标计算新的 convergence_counter 值
 *
 * convergence_counter 操作表（按优先级降序）：
 * ┌──────┬──────────────────────────┬──────────┬──────────────────────┐
 * │ 优先级 │ 条件                     │ 动作      │ 理由                 │
 * ├──────┼──────────────────────────┼──────────┼──────────────────────┤
 * │  1   │ 不在 routing 步骤        │ 不更新    │ 非 routing 不评估收敛 │
 * │  2   │ 路由目标指向 Part 1      │ reset→0  │ 方案层面动摇          │
 * │  3   │ 本轮发现新 P1            │ reset→0  │ 核心路径仍有未知缺口  │
 * │  4   │ 本轮发现新 P2            │ reset→0  │ 仍在暴露新问题        │
 * │  5   │ 无新问题 + 所有关闭       │ +1       │ 方案已稳定            │
 * └──────┴──────────────────────────┴──────────┴──────────────────────┘
 *
 * @param state - 当前 LoopState
 * @param targetPhase - 路由目标 phase
 * @param snapshotBefore - 路由开始前的 issue 快照
 * @returns 更新后的 convergence_counter 值
 */
export function updateConvergenceCounter(
  state: LoopState,
  targetPhase: string,
  snapshotBefore: IssueSnapshot,
): number {
  const { convergence_counter: counter } = state.progress;
  const { active: iss } = state.issues;

  // 优先级 2：路由到 Part 1 → reset 为 0（方案动摇）
  if (
    targetPhase === "part_1_1" ||
    targetPhase === "part_1_2" ||
    targetPhase === "part_1_3"
  ) {
    return 0;
  }

  // 优先级 3：本轮新发现 P1（与快照对比）
  const p1Delta = iss.p1.length - (snapshotBefore?.p1 ?? 0);
  if (p1Delta > 0) {
    return 0;
  }

  // 优先级 4：本轮新发现 P2（与快照对比）
  const p2Delta = iss.p2.length - (snapshotBefore?.p2 ?? 0);
  if (p2Delta > 0) {
    return 0;
  }

  // 优先级 5：无新问题 + 所有 issue 已关闭 → +1
  const hasOpenIssues =
    iss.p0.length > 0 || iss.p1.length > 0 || iss.p2.length > 0;
  if (!hasOpenIssues) {
    return counter + 1;
  }

  // 默认：保持当前值不变
  return counter;
}

// ============================================================================
// 快照与对比工具
// ============================================================================

/**
 * 拍摄当前 issue 状态快照
 *
 * 在 routing 开始时调用，记录此刻的 P0/P1/P2 数量，
 * 用于后续对比是否发现新问题。
 *
 * @param issues - 当前活跃 issue 集合
 * @returns 各严重级 issue 数量快照
 */
export function takeIssueSnapshot(issues: IssueCollection): IssueSnapshot {
  return {
    p0: issues.p0.length,
    p1: issues.p1.length,
    p2: issues.p2.length,
  };
}

/**
 * 对比两轮 issue 快照，检查是否有新问题
 *
 * @param before - 上轮快照
 * @param after - 本轮快照
 * @returns 是否有新问题
 */
export function hasNewIssues(
  before: IssueSnapshot,
  after: IssueSnapshot,
): boolean {
  return after.p0 > before.p0 || after.p1 > before.p1 || after.p2 > before.p2;
}

// ============================================================================
// 已解决问题累加计算
// ============================================================================

/**
 * 统计本轮已解决的 issue 数量（对比快照）
 *
 * 计算逻辑：历史已解决数 + 本轮关闭数，
 * 但需确保 sum <= all_time_total（避免统计错误）。
 *
 * @param allTime - 历史总计
 * @param active - 当前活跃
 * @param previousResolved - 上轮已解决计数
 * @returns 本轮更新后的已解决计数
 */
export function countResolved(
  allTime: { p0_total: number; p1_total: number; p2_total: number },
  active: IssueCollection,
  previousResolved: ResolvedIssueCount,
): ResolvedIssueCount {
  return {
    p0: Math.max(
      previousResolved.p0,
      allTime.p0_total - active.p0.length,
    ),
    p1: Math.max(
      previousResolved.p1,
      allTime.p1_total - active.p1.length,
    ),
    p2: Math.max(
      previousResolved.p2,
      allTime.p2_total - active.p2.length,
    ),
  };
}
