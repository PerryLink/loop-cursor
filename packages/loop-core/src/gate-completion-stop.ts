/**
 * G6 完成停止钩子 — gateCompletionStop
 *
 * 在 Agent 声明任务"已完成"时进行事后校验，防止 Agent 谎报完成。
 *
 * 校验规则：
 * 1. Issue 已关闭 — 若 LoopState 中存在活跃 issue，则判定为未完成。
 * 2. 产物文件存在 — 检查 artifacts 中标记为 expected 的文件是否存在。
 * 3. 测试全部通过 — 若 test_results artifact 中有失败，则未完成。
 *
 * @module gate-completion-stop
 * @version 0.1.0
 */

import type { LoopState } from "./types.js";
import { existsSync, readFileSync } from "node:fs";

/** 完成声明校验结果 */
export interface CompletionGateResult {
  /** 是否全部通过 */
  pass: boolean;
  /** 缺失/未满足的校验项清单 */
  missingRequirements: string[];
}

/**
 * G6 完成停止钩子
 *
 * 检查 LoopState 中是否有未关闭的 issue、
 * 预期 artifact 文件是否存在、测试是否全部通过。
 *
 * @param state - 当前 LoopState 快照
 * @param expectedArtifacts - 预期应存在的 artifact key 列表（如 ["task_list", "verification"]）
 * @returns CompletionGateResult
 */
export function gateCompletionStop(
  state: LoopState,
  expectedArtifacts: string[] = [],
): CompletionGateResult {
  const missing: string[] = [];

  // 1. 检查活跃 issue 是否全部关闭
  const openP0 = state.issues.active.p0.filter(
    (issue) => issue.status !== "closed",
  );
  const openP1 = state.issues.active.p1.filter(
    (issue) => issue.status !== "closed",
  );
  const openP2 = state.issues.active.p2.filter(
    (issue) => issue.status !== "closed",
  );
  const totalOpen = openP0.length + openP1.length + openP2.length;
  if (totalOpen > 0) {
    const titles = [...openP0, ...openP1, ...openP2]
      .map((i) => i.id ?? i.description ?? "unnamed")
      .join(", ");
    missing.push(`存在 ${totalOpen} 个未关闭的 Issue: [${titles}]`);
  }

  // 2. 检查预期 artifact 文件是否存在
  for (const key of expectedArtifacts) {
    const path = state.artifacts[key];
    if (typeof path === "string" && !existsSync(path)) {
      missing.push(`预期产物文件不存在: ${path}`);
    }
  }

  // 3. 检查测试结果 artifact
  const testPath = state.artifacts["test_results"];
  if (typeof testPath === "string" && existsSync(testPath)) {
    try {
      const raw = JSON.parse(readFileSync(testPath, "utf-8")) as Record<string, unknown>;
      if (
        typeof raw.summary === "object" &&
        raw.summary !== null
      ) {
        const s = raw.summary as Record<string, unknown>;
        if (typeof s.failed === "number" && s.failed > 0) {
          missing.push(`存在 ${s.failed} 个失败测试`);
        }
      }
      const results = raw.results as Array<{ status?: string }> | undefined;
      if (Array.isArray(results)) {
        const failedCount = results.filter(
          (r) => r.status === "fail" || r.status === "failed" || r.status === "error",
        ).length;
        if (failedCount > 0) {
          missing.push(`存在 ${failedCount} 个失败的测试用例`);
        }
      }
    } catch {
      // 测试结果文件格式异常
    }
  }

  return {
    pass: missing.length === 0,
    missingRequirements: missing,
  };
}
