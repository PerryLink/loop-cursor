/**
 * G2 方案确认闸门 — Part 2.1 用户确认拦截
 * L1/interactive 模式：暂停等待确认 | L2/L3：自动放行
 * @module gate-plan-confirmation
 */

import type { LoopState } from "./types.js";

// ============================================================================
// 类型
// ============================================================================

/** 闸门通用返回结果 */
export interface GateResult {
  pass: boolean;
  blocks: string[];
  reason?: string;
}

/** G2 闸门专用结果 */
export interface PlanGateResult extends GateResult {
  message: string;
  requiresConfirmation: boolean;
}

// ============================================================================
// 导出函数
// ============================================================================

/**
 * G2 方案确认闸门
 * 在 Part 2.1 + safe/interactive 模式下拦截，要求用户确认方案。
 * @param state - 当前 LoopState
 * @param mode - 运行模式 (safe|auto|unsafe|interactive)
 * @returns PlanGateResult
 */
export function gatePlanConfirmation(
  state: LoopState,
  mode: string,
): PlanGateResult {
  if (!state?.progress) {
    return { pass: true, blocks: [], message: "状态无效", requiresConfirmation: false };
  }

  const phase = state.progress.phase;
  if (phase !== "part_2_1") {
    return {
      pass: true, blocks: [],
      message: `当前 ${phase}，不触发确认`,
      requiresConfirmation: false,
    };
  }

  // L3: 全部放行
  if (mode === "unsafe") {
    return {
      pass: true, blocks: [],
      message: "[L3] 方案确认自动通过",
      requiresConfirmation: false,
    };
  }

  // L2: 自动确认
  if (mode === "auto") {
    return {
      pass: true, blocks: [],
      message: "[L2] 方案确认自动通过，开始实施",
      requiresConfirmation: false,
    };
  }

  // L1 / interactive: 拦截，需用户确认
  if (mode === "safe" || mode === "interactive") {
    const req = state.config?.user_request ?? "(未指定)";
    const total = state.tasks?.total ?? 0;
    const pending = state.tasks?.by_status?.pending ?? 0;
    const msg = [
      "【方案确认】Agent 已完成方案设计，请确认后开始实施：",
      `需求：${req}`,
      `任务：${total} 个（待执行 ${pending} 个）`,
      "回复「确认」开始实施，或「修改」调整方案。",
    ].join("\n");

    return {
      pass: false,
      blocks: ["方案确认闸门"],
      reason: "安全模式下 Part 2.1 方案须经用户确认",
      message: msg,
      requiresConfirmation: true,
    };
  }

  // 未知模式：保守拦截
  return {
    pass: false, blocks: ["未知模式"],
    reason: `未识别模式 "${mode}"`,
    message: `运行模式 "${mode}" 未识别，请确认`,
    requiresConfirmation: true,
  };
}
