/**
 * convergence 单元测试
 *
 * 测试收敛引擎的完整功能：
 * - 标准收敛判定（所有 issue 关闭 + counter 达标）
 * - 等效收敛判定（连续 verification 通过）
 * - convergence_counter 更新（reset/increment/keep）
 * - issue 快照（拍摄和对比）
 * - 已解决问题计数
 * - 边界情况
 *
 * @module test-convergence
 */

import {
  judgeConvergence,
  updateConvergenceCounter,
  takeIssueSnapshot,
  hasNewIssues,
  countResolved,
} from "../packages/loop-core/src/convergence.js";
import type {
  ConvergenceResult,
  IssueSnapshot,
} from "../packages/loop-core/src/convergence.js";
import type { LoopState, Issue, IssueCollection, ResolvedIssueCount } from "../packages/loop-core/src/types.js";
import { PhaseEnum } from "../packages/loop-core/src/types.js";
import { buildInitialState } from "../packages/loop-core/src/config.js";

// ============================================================================
// 辅助函数
// ============================================================================

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

function makeState(overrides?: Partial<LoopState>): LoopState {
  const base = buildInitialState("test goal", "auto");
  if (overrides) {
    return JSON.parse(JSON.stringify({ ...base, ...overrides }));
  }
  return base;
}

function makeEmptyIssueCollection(): IssueCollection {
  return { p0: [], p1: [], p2: [] };
}

// ============================================================================
// 测试套件
// ============================================================================

async function runTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function describe(name: string, fn: () => void): void {
    console.log(`\n${name}`);
    fn();
  }

  async function it(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
      passed++;
      console.log(`  PASS: ${name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL: ${name}`);
      console.log(`    ${(e as Error).message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Scenario 1: Standard convergence
  // ═══════════════════════════════════════════════════════════════

  describe("标准收敛判定（所有 issue 关闭 + counter 达标）", () => {
    it("所有 issue 关闭 + counter >= threshold 应判定为标准收敛", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 4,
          convergence_counter: 3,
          part1_round: 1,
          new_issues_this_round: false,
          new_issues_last_round: false,
          issues_snapshot_at_round_start: { p0: 0, p1: 0, p2: 0 },
          retry_count_this_phase: 0,
          verification_pass_count: 0,
          implementation_engine: null,
          repair_context: null,
          phase_transitions: [],
        },
        config: {
          mode: "auto",
          max_cycles: 5,
          max_part1_rounds: 5,
          convergence_rounds: 2,
          route_repeat_max: 3,
          user_request: "test",
          model: "claude-sonnet-4-20250514",
          sdk_version: "1.0.12",
        },
        issues: {
          active: { p0: [], p1: [], p2: [] },
          resolved: { p0: 0, p1: 0, p2: 0 },
          all_time: { p0_total: 0, p1_total: 0, p2_total: 0 },
        },
      });

      const result = judgeConvergence(state);
      assert(result.converged === true, "应判定为已收敛");
      assert(result.type === "standard", "收敛类型应为 standard");
      assert(result.newConvergenceCounter === 3, "counter 应保持不变");
    });

    it("counter 未达标不应收敛", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 2,
          convergence_counter: 1,
          part1_round: 1,
          new_issues_this_round: false,
          new_issues_last_round: false,
          issues_snapshot_at_round_start: { p0: 0, p1: 0, p2: 0 },
          retry_count_this_phase: 0,
          verification_pass_count: 0,
          implementation_engine: null,
          repair_context: null,
          phase_transitions: [],
        },
        config: {
          mode: "auto",
          max_cycles: 5,
          max_part1_rounds: 5,
          convergence_rounds: 3,
          route_repeat_max: 3,
          user_request: "test",
          model: "claude-sonnet-4-20250514",
          sdk_version: "1.0.12",
        },
        issues: {
          active: { p0: [], p1: [], p2: [] },
          resolved: { p0: 0, p1: 0, p2: 0 },
          all_time: { p0_total: 0, p1_total: 0, p2_total: 0 },
        },
      });

      const result = judgeConvergence(state);
      assert(result.converged === false, "counter 未达标不应收敛");
      assert(result.type === "none", "收敛类型应为 none");
    });

    it("仍有活跃 issue 不应收敛", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 5,
          convergence_counter: 5,
          part1_round: 1,
          new_issues_this_round: true,
          new_issues_last_round: false,
          issues_snapshot_at_round_start: { p0: 0, p1: 0, p2: 0 },
          retry_count_this_phase: 0,
          verification_pass_count: 0,
          implementation_engine: null,
          repair_context: null,
          phase_transitions: [],
        },
        config: {
          mode: "auto",
          max_cycles: 5,
          max_part1_rounds: 5,
          convergence_rounds: 2,
          route_repeat_max: 3,
          user_request: "test",
          model: "claude-sonnet-4-20250514",
          sdk_version: "1.0.12",
        },
        issues: {
          active: {
            p0: [],
            p1: [{
              id: "p1-active",
              description: "Still open P1 issue",
              severity: "P1",
              status: "open",
            }],
            p2: [],
          },
          resolved: { p0: 0, p1: 0, p2: 0 },
          all_time: { p0_total: 0, p1_total: 1, p2_total: 0 },
        },
      });

      const result = judgeConvergence(state);
      assert(result.converged === false, "有活跃 issue 不应收敛");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 2: Equivalent convergence
  // ═══════════════════════════════════════════════════════════════

  describe("等效收敛判定（连续 verification 通过）", () => {
    it("verification_pass_count >= rounds 且无 issue 应等效收敛", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 4,
          convergence_counter: 0,
          part1_round: 1,
          new_issues_this_round: false,
          new_issues_last_round: false,
          issues_snapshot_at_round_start: { p0: 0, p1: 0, p2: 0 },
          retry_count_this_phase: 0,
          verification_pass_count: 3,
          implementation_engine: null,
          repair_context: null,
          phase_transitions: [],
        },
        config: {
          mode: "auto",
          max_cycles: 5,
          max_part1_rounds: 5,
          convergence_rounds: 2,
          route_repeat_max: 3,
          user_request: "test",
          model: "claude-sonnet-4-20250514",
          sdk_version: "1.0.12",
        },
        issues: {
          active: { p0: [], p1: [], p2: [] },
          resolved: { p0: 0, p1: 0, p2: 0 },
          all_time: { p0_total: 0, p1_total: 0, p2_total: 0 },
        },
      });

      const result = judgeConvergence(state);
      assert(result.converged === true, "应等效收敛");
      assert(result.type === "equivalent", "收敛类型应为 equivalent");
    });

    it("verification_pass_count 不足不应等效收敛", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 3,
          convergence_counter: 0,
          part1_round: 1,
          new_issues_this_round: false,
          new_issues_last_round: false,
          issues_snapshot_at_round_start: { p0: 0, p1: 0, p2: 0 },
          retry_count_this_phase: 0,
          verification_pass_count: 1,
          implementation_engine: null,
          repair_context: null,
          phase_transitions: [],
        },
        config: {
          mode: "auto",
          max_cycles: 5,
          max_part1_rounds: 5,
          convergence_rounds: 3,
          route_repeat_max: 3,
          user_request: "test",
          model: "claude-sonnet-4-20250514",
          sdk_version: "1.0.12",
        },
        issues: {
          active: { p0: [], p1: [], p2: [] },
          resolved: { p0: 0, p1: 0, p2: 0 },
          all_time: { p0_total: 0, p1_total: 0, p2_total: 0 },
        },
      });

      const result = judgeConvergence(state);
      assert(result.converged === false, "verification 不足不应收敛");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 3: Convergence counter updates
  // ═══════════════════════════════════════════════════════════════

  describe("convergence_counter 更新规则", () => {
    it("路由到 Part 1 应 reset counter 为 0", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 2,
          convergence_counter: 5,
          part1_round: 1,
          new_issues_this_round: false,
          new_issues_last_round: false,
          issues_snapshot_at_round_start: { p0: 0, p1: 0, p2: 0 },
          retry_count_this_phase: 0,
          verification_pass_count: 0,
          implementation_engine: null,
          repair_context: null,
          phase_transitions: [],
        },
        issues: {
          active: { p0: [], p1: [], p2: [] },
          resolved: { p0: 0, p1: 0, p2: 0 },
          all_time: { p0_total: 0, p1_total: 0, p2_total: 0 },
        },
      });

      const snapshot: IssueSnapshot = { p0: 0, p1: 0, p2: 0 };
      const newCounter = updateConvergenceCounter(state, PhaseEnum.PART_1_1, snapshot);
      assert(newCounter === 0, "路由到 Part 1 应 reset counter");
    });

    it("新 P1 发现应 reset counter", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 2,
          convergence_counter: 3,
          part1_round: 1,
          new_issues_this_round: false,
          new_issues_last_round: false,
          issues_snapshot_at_round_start: { p0: 0, p1: 0, p2: 0 },
          retry_count_this_phase: 0,
          verification_pass_count: 0,
          implementation_engine: null,
          repair_context: null,
          phase_transitions: [],
        },
        issues: {
          active: {
            p0: [],
            p1: [{
              id: "p1-new",
              description: "New P1 issue discovered",
              severity: "P1",
              status: "open",
            }],
            p2: [],
          },
          resolved: { p0: 0, p1: 0, p2: 0 },
          all_time: { p0_total: 0, p1_total: 1, p2_total: 0 },
        },
      });

      const snapshot: IssueSnapshot = { p0: 0, p1: 0, p2: 0 };
      const newCounter = updateConvergenceCounter(state, PhaseEnum.PART_2_2, snapshot);
      assert(newCounter === 0, "新 P1 应 reset counter");
    });

    it("新 P2 发现应 reset counter", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 2,
          convergence_counter: 2,
          part1_round: 1,
          new_issues_this_round: false,
          new_issues_last_round: false,
          issues_snapshot_at_round_start: { p0: 0, p1: 0, p2: 0 },
          retry_count_this_phase: 0,
          verification_pass_count: 0,
          implementation_engine: null,
          repair_context: null,
          phase_transitions: [],
        },
        issues: {
          active: {
            p0: [],
            p1: [],
            p2: [{
              id: "p2-new",
              description: "New P2 issue found",
              severity: "P2",
              status: "open",
            }],
          },
          resolved: { p0: 0, p1: 0, p2: 0 },
          all_time: { p0_total: 0, p1_total: 0, p2_total: 1 },
        },
      });

      const snapshot: IssueSnapshot = { p0: 0, p1: 0, p2: 0 };
      const newCounter = updateConvergenceCounter(state, PhaseEnum.PART_2_2, snapshot);
      assert(newCounter === 0, "新 P2 应 reset counter");
    });

    it("无新问题 + 全部关闭应 +1", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 2,
          convergence_counter: 1,
          part1_round: 1,
          new_issues_this_round: false,
          new_issues_last_round: false,
          issues_snapshot_at_round_start: { p0: 0, p1: 0, p2: 0 },
          retry_count_this_phase: 0,
          verification_pass_count: 0,
          implementation_engine: null,
          repair_context: null,
          phase_transitions: [],
        },
        issues: {
          active: { p0: [], p1: [], p2: [] },
          resolved: { p0: 0, p1: 0, p2: 0 },
          all_time: { p0_total: 0, p1_total: 0, p2_total: 0 },
        },
      });

      const snapshot: IssueSnapshot = { p0: 0, p1: 0, p2: 0 };
      const newCounter = updateConvergenceCounter(state, PhaseEnum.PART_2_8, snapshot);
      assert(newCounter === 2, "无新问题 + 全部关闭应 +1");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 4: Issue snapshots
  // ═══════════════════════════════════════════════════════════════

  describe("Issue 快照与对比", () => {
    it("takeIssueSnapshot 应正确计数各等级 issue", () => {
      const collection: IssueCollection = {
        p0: [
          { id: "p0-1", description: "P0-a", severity: "P0", status: "open" },
          { id: "p0-2", description: "P0-b", severity: "P0", status: "open" },
        ],
        p1: [
          { id: "p1-1", description: "P1-a", severity: "P1", status: "open" },
        ],
        p2: [],
      };

      const snapshot = takeIssueSnapshot(collection);
      assert(snapshot.p0 === 2, "P0 应为 2");
      assert(snapshot.p1 === 1, "P1 应为 1");
      assert(snapshot.p2 === 0, "P2 应为 0");
    });

    it("空 issue 集合的快照应全为 0", () => {
      const snapshot = takeIssueSnapshot(makeEmptyIssueCollection());
      assert(snapshot.p0 === 0, "P0 应为 0");
      assert(snapshot.p1 === 0, "P1 应为 0");
      assert(snapshot.p2 === 0, "P2 应为 0");
    });

    it("hasNewIssues 在 issue 增加时返回 true", () => {
      const before: IssueSnapshot = { p0: 0, p1: 1, p2: 0 };
      const after: IssueSnapshot = { p0: 0, p1: 2, p2: 0 };
      assert(hasNewIssues(before, after) === true, "P1 增加应检测到新 issue");
    });

    it("hasNewIssues 在 issue 数目不变时返回 false", () => {
      const before: IssueSnapshot = { p0: 1, p1: 1, p2: 0 };
      const after: IssueSnapshot = { p0: 1, p1: 1, p2: 0 };
      assert(hasNewIssues(before, after) === false, "数目不变不应检测到新 issue");
    });

    it("hasNewIssues 在 issue 减少时返回 false", () => {
      const before: IssueSnapshot = { p0: 0, p1: 3, p2: 1 };
      const after: IssueSnapshot = { p0: 0, p1: 1, p2: 0 };
      assert(hasNewIssues(before, after) === false, "issue 减少不应检测到新 issue");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 5: Resolved issue counting
  // ═══════════════════════════════════════════════════════════════

  describe("已解决 issue 计数", () => {
    it("countResolved 应正确计算已解决数", () => {
      const allTime = { p0_total: 5, p1_total: 3, p2_total: 2 };
      const active: IssueCollection = {
        p0: [{ id: "p0-1", description: "a", severity: "P0" }],
        p1: [],
        p2: [{ id: "p2-1", description: "b", severity: "P2" }],
      };
      const prevResolved: ResolvedIssueCount = { p0: 2, p1: 2, p2: 0 };

      const result = countResolved(allTime, active, prevResolved);
      assert(result.p0 === 4, "P0 已解决 = total 5 - active 1 = 4 (max with prev 2 → 4)");
      assert(result.p1 === 3, "P1 已解决 = total 3 - active 0 = 3");
      assert(result.p2 === 1, "P2 已解决 = total 2 - active 1 = 1");
    });

    it("countResolved 已解决数不会超过 all_time_total", () => {
      const allTime = { p0_total: 2, p1_total: 1, p2_total: 1 };
      const active: IssueCollection = {
        p0: [],
        p1: [],
        p2: [],
      };
      const prevResolved: ResolvedIssueCount = { p0: 1, p1: 0, p2: 0 };

      const result = countResolved(allTime, active, prevResolved);
      assert(result.p0 === 2, "应正确计算，不超过 total");
      assert(result.p1 === 1, "应正确计算");
      assert(result.p2 === 1, "应正确计算");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 6: Edge cases
  // ═══════════════════════════════════════════════════════════════

  describe("边界情况", () => {
    it("convergence_counter 为 0 时正常判定", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 1,
          convergence_counter: 0,
          part1_round: 0,
          new_issues_this_round: false,
          new_issues_last_round: false,
          issues_snapshot_at_round_start: { p0: 0, p1: 0, p2: 0 },
          retry_count_this_phase: 0,
          verification_pass_count: 0,
          implementation_engine: null,
          repair_context: null,
          phase_transitions: [],
        },
        config: {
          mode: "auto",
          max_cycles: 5,
          max_part1_rounds: 5,
          convergence_rounds: 2,
          route_repeat_max: 3,
          user_request: "test",
          model: "claude-sonnet-4-20250514",
          sdk_version: "1.0.12",
        },
        issues: {
          active: { p0: [], p1: [], p2: [] },
          resolved: { p0: 0, p1: 0, p2: 0 },
          all_time: { p0_total: 0, p1_total: 0, p2_total: 0 },
        },
      });

      const result = judgeConvergence(state);
      assert(result.converged === false, "counter 为 0 不应收敛");
      assert(result.type === "none", "type 应为 none");
    });

    it("P0 增量应触发 reset（即使路由目标是 part_2_2）", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 2,
          convergence_counter: 3,
          part1_round: 1,
          new_issues_this_round: false,
          new_issues_last_round: false,
          issues_snapshot_at_round_start: { p0: 0, p1: 0, p2: 0 },
          retry_count_this_phase: 0,
          verification_pass_count: 0,
          implementation_engine: null,
          repair_context: null,
          phase_transitions: [],
        },
        issues: {
          active: {
            p0: [{ id: "p0-s", description: "Sudden P0", severity: "P0" }],
            p1: [],
            p2: [],
          },
          resolved: { p0: 0, p1: 0, p2: 0 },
          all_time: { p0_total: 1, p1_total: 0, p2_total: 0 },
        },
      });

      // 注意：P0 出现时实际路由会先取 Part 1 路径（在 determineRoute 中），
      // 但 updateConvergenceCounter 的 P0 重置也是由 Part 1 路由触发的
      const snapshot: IssueSnapshot = { p0: 0, p1: 0, p2: 0 };
      const counter = updateConvergenceCounter(state, PhaseEnum.PART_1_1, snapshot);
      assert(counter === 0, "路由 Part 1 应 reset counter");
    });

    it("有 open issue 且 counter >= rounds 仍不应收敛", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 4,
          convergence_counter: 5,
          part1_round: 1,
          new_issues_this_round: false,
          new_issues_last_round: false,
          issues_snapshot_at_round_start: { p0: 0, p1: 0, p2: 0 },
          retry_count_this_phase: 0,
          verification_pass_count: 3,
          implementation_engine: null,
          repair_context: null,
          phase_transitions: [],
        },
        config: {
          mode: "auto",
          max_cycles: 5,
          max_part1_rounds: 5,
          convergence_rounds: 2,
          route_repeat_max: 3,
          user_request: "test",
          model: "claude-sonnet-4-20250514",
          sdk_version: "1.0.12",
        },
        issues: {
          active: {
            p0: [],
            p1: [],
            p2: [{
              id: "p2-open",
              description: "Minor issue still open",
              severity: "P2",
              status: "open",
            }],
          },
          resolved: { p0: 0, p1: 0, p2: 0 },
          all_time: { p0_total: 0, p1_total: 0, p2_total: 1 },
        },
      });

      const result = judgeConvergence(state);
      assert(result.converged === false, "有活跃 issue 不能收敛");
    });
  });

  // ============================================================================
  // 汇总
  // ============================================================================
  console.log(`\n===== 测试结果 =====`);
  console.log(`通过: ${passed}`);
  console.log(`失败: ${failed}`);
  if (failed > 0) {
    console.error(`${failed} 个测试失败！`);
    process.exitCode = 1;
  } else {
    console.log("全部通过！");
  }
}

runTests().catch(console.error);
