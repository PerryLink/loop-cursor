/**
 * router 单元测试
 *
 * 测试路由引擎的完整决策树：
 * - P0 路由（回到设计气泡）
 * - P1 路由（设计级 vs 实现级决策树）
 * - P2 路由（串行 vs 并行修复）
 * - 无 issue 收敛路由（标准/等效收敛）
 * - issues 独立性判断
 * - 边界情况（空状态、混合 issue 等）
 *
 * @module test-router
 */

import { determineRoute } from "../packages/loop-core/src/router.js";
import type { RouteResult, RepairContext } from "../packages/loop-core/src/router.js";
import { PhaseEnum } from "../packages/loop-core/src/types.js";
import type { LoopState, Issue } from "../packages/loop-core/src/types.js";
import { buildInitialState } from "../packages/loop-core/src/config.js";

// ============================================================================
// 辅助函数
// ============================================================================

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

function makeIssue(overrides: Partial<Issue> & { description: string }): Issue {
  return {
    id: overrides.id ?? `test-${Math.random().toString(36).slice(2, 8)}`,
    description: overrides.description,
    severity: overrides.severity ?? "P2",
    affected_files: overrides.affected_files ?? [],
    status: overrides.status ?? "open",
  };
}

function makeState(
  overrides?: Partial<LoopState>,
): LoopState {
  const base = buildInitialState("test goal", "auto");
  if (overrides) {
    return JSON.parse(JSON.stringify({ ...base, ...overrides }));
  }
  return base;
}

// ============================================================================
// 测试套件（使用 describe/it 模式）
// ============================================================================

async function runTests(): Promise<void> {
  let passed = 0;
  let failed = 0;
  let currentDescribe = "";

  function describe(name: string, fn: () => void): void {
    currentDescribe = name;
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
  // Scenario 1: P0 routing
  // ═══════════════════════════════════════════════════════════════

  describe("P0 路由决策", () => {
    it("P0 问题应路由回 Part 1 设计气泡", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 2,
          convergence_counter: 0,
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
        issues: {
          active: {
            p0: [makeIssue({ description: "需求错误：需要推翻重新设计", severity: "P0" })],
            p1: [],
            p2: [],
          },
          resolved: { p0: 0, p1: 0, p2: 0 },
          all_time: { p0_total: 1, p1_total: 0, p2_total: 0 },
        },
      });

      const result = determineRoute(state);
      assert(result.targetPhase === PhaseEnum.PART_1_1, "P0 应路由到 part_1_1");
      assert(result.action === "route_to_part1", "action 应为 route_to_part1");
      assert(result.shouldIncrementCycle === true, "应递增 cycle");
      assert(result.repairContext === null, "P0 不需要 repairContext");
    });

    it("多个 P0 问题应一起路由回设计气泡", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 3,
          convergence_counter: 0,
          part1_round: 2,
          new_issues_this_round: true,
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
            p0: [
              makeIssue({ description: "架构错误：数据层设计有根本缺陷", severity: "P0" }),
              makeIssue({ description: "方案不可行：API 无法支持并发需求", severity: "P0" }),
            ],
            p1: [],
            p2: [],
          },
          resolved: { p0: 0, p1: 0, p2: 0 },
          all_time: { p0_total: 2, p1_total: 0, p2_total: 0 },
        },
      });

      const result = determineRoute(state);
      assert(result.targetPhase === PhaseEnum.PART_1_1, "多 P0 也应路由到 part_1_1");
      assert(result.reasoning.includes("2"), "reasoning 应包含 P0 数量");
    });

    it("P0 优先于 P1 和 P2（混合 issue 场景）", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 4,
          convergence_counter: 1,
          part1_round: 2,
          new_issues_this_round: true,
          new_issues_last_round: false,
          issues_snapshot_at_round_start: { p0: 0, p1: 0, p2: 0 },
          retry_count_this_phase: 0,
          verification_pass_count: 1,
          implementation_engine: null,
          repair_context: null,
          phase_transitions: [],
        },
        issues: {
          active: {
            p0: [makeIssue({ description: "需求矛盾：需要推翻重来", severity: "P0" })],
            p1: [makeIssue({ description: "安全漏洞：认证绕过", severity: "P1" })],
            p2: [makeIssue({ description: "UI 样式错误", severity: "P2" })],
          },
          resolved: { p0: 0, p1: 0, p2: 0 },
          all_time: { p0_total: 1, p1_total: 1, p2_total: 1 },
        },
      });

      const result = determineRoute(state);
      assert(result.targetPhase === PhaseEnum.PART_1_1, "有 P0 时必须优先路由到 part_1_1");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 2: P1 routing
  // ═══════════════════════════════════════════════════════════════

  describe("P1 路由决策（设计级 vs 实现级）", () => {
    it("设计级 P1 应路由到 part_1_3 方案修订", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 2,
          convergence_counter: 0,
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
        issues: {
          active: {
            p0: [],
            p1: [makeIssue({
              description: "Architecture and interface design flaw: data flow broken",
              severity: "P1",
              affected_files: ["api/routes.ts", "db/schema.ts", "types/index.ts", "config/app.ts"],
            })],
            p2: [],
          },
          resolved: { p0: 0, p1: 0, p2: 0 },
          all_time: { p0_total: 0, p1_total: 1, p2_total: 0 },
        },
        routing_history: [
          {
            from_phase: PhaseEnum.PART_2_8,
            to_phase: PhaseEnum.ROUTING,
            reason: "architecture design flaw: data flow broken",
            timestamp: new Date().toISOString(),
          },
        ],
      });

      const result = determineRoute(state);
      assert(result.targetPhase === PhaseEnum.PART_1_3, "设计级 P1 应路由到 part_1_3");
      assert(result.action === "route_to_design_fix", "action 应为 route_to_design_fix");
    });

    it("实现级 P1 应路由到 part_2_2 实现修复", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 2,
          convergence_counter: 0,
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
        issues: {
          active: {
            p0: [],
            p1: [makeIssue({
              description: "Fix null pointer check in auth module",
              severity: "P1",
              affected_files: ["src/auth.ts"],
            })],
            p2: [],
          },
          resolved: { p0: 0, p1: 0, p2: 0 },
          all_time: { p0_total: 0, p1_total: 1, p2_total: 0 },
        },
      });

      const result = determineRoute(state);
      assert(result.targetPhase === PhaseEnum.PART_2_2, "实现级 P1 应路由到 part_2_2");
      assert(result.action === "route_to_implement_fix", "action 应为 route_to_implement_fix");
      assert(result.repairContext !== null, "实现级修复应有 repairContext");
      assert(result.repairContext!.repairPhase === PhaseEnum.PART_2_2, "repairPhase 应为 part_2_2");
    });

    it("安全漏洞 P1 + 跨模块应判定为设计级", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 2,
          convergence_counter: 0,
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
        issues: {
          active: {
            p0: [],
            p1: [makeIssue({
              description: "Architecture security vulnerability: authentication bypass via session hijack and token leakage",
              severity: "P1",
              affected_files: ["auth/", "session/", "api/", "db/"],
            })],
            p2: [],
          },
          resolved: { p0: 0, p1: 0, p2: 0 },
          all_time: { p0_total: 0, p1_total: 1, p2_total: 0 },
        },
      });

      const result = determineRoute(state);
      // architecture + 4 modules + auth/session/token keywords + 4 files = 4+ points -> design level
      assert(result.targetPhase === PhaseEnum.PART_1_3, "安全+跨模块应为设计级");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 3: P2 routing
  // ═══════════════════════════════════════════════════════════════

  describe("P2 路由决策", () => {
    it("P2 问题应路由到 part_2_2 串行修复", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 2,
          convergence_counter: 0,
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
        issues: {
          active: {
            p0: [],
            p1: [],
            p2: [makeIssue({
              description: "UI glitch on mobile view",
              severity: "P2",
              affected_files: ["src/ui/MobileView.tsx"],
            })],
          },
          resolved: { p0: 0, p1: 0, p2: 0 },
          all_time: { p0_total: 0, p1_total: 0, p2_total: 1 },
        },
      });

      const result = determineRoute(state);
      assert(result.targetPhase === PhaseEnum.PART_2_2, "P2 应路由到 part_2_2");
      assert(result.shouldIncrementCycle === true, "应递增 cycle");
      assert(result.repairContext !== null, "应有 repairContext");
    });

    it("独立 P2 问题应标记为可并行修复", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 3,
          convergence_counter: 0,
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
        issues: {
          active: {
            p0: [],
            p1: [],
            p2: [
              makeIssue({
                description: "Fix typo in README",
                severity: "P2",
                affected_files: ["README.md"],
              }),
              makeIssue({
                description: "Code style issue in Button",
                severity: "P2",
                affected_files: ["src/ui/Button.tsx"],
              }),
            ],
          },
          resolved: { p0: 0, p1: 0, p2: 0 },
          all_time: { p0_total: 0, p1_total: 0, p2_total: 2 },
        },
      });

      const result = determineRoute(state);
      assert(result.targetPhase === PhaseEnum.PART_2_2, "P2 应路由到 part_2_2");
      assert(result.action === "route_to_parallel_fix", "独立文件应为并行修复");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 4: No issues (convergence)
  // ═══════════════════════════════════════════════════════════════

  describe("无 issue 时收敛路由", () => {
    it("convergence_counter 达标应判定为 complete", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 5,
          convergence_counter: 2,
          part1_round: 1,
          new_issues_this_round: false,
          new_issues_last_round: false,
          issues_snapshot_at_round_start: { p0: 0, p1: 0, p2: 0 },
          retry_count_this_phase: 0,
          verification_pass_count: 2,
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

      const result = determineRoute(state);
      assert(result.targetPhase === PhaseEnum.COMPLETE, "收敛达标应为 complete");
      assert(result.action === "converge", "action 应为 converge");
    });

    it("verification_pass_count 不足应路由到 part_2_8 重验证", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 3,
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

      const result = determineRoute(state);
      assert(result.targetPhase === PhaseEnum.PART_2_8, "验证不足应路由到 part_2_8");
      assert(result.action === "reverify", "action 应为 reverify");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 5: Repair context structure
  // ═══════════════════════════════════════════════════════════════

  describe("RepairContext 结构验证", () => {
    it("P1 实现级修复的 repairContext 应包含正确的 targetIssues", () => {
      const p1Issue = makeIssue({
        description: "Core function is missing: payment processing broken",
        severity: "P1",
        affected_files: ["src/payment.ts", "src/order.ts"],
      });

      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 2,
          convergence_counter: 0,
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
        issues: {
          active: {
            p0: [],
            p1: [p1Issue],
            p2: [],
          },
          resolved: { p0: 0, p1: 0, p2: 0 },
          all_time: { p0_total: 0, p1_total: 1, p2_total: 0 },
        },
      });

      const result = determineRoute(state);
      assert(result.repairContext !== null, "应有 repairContext");
      assert(result.repairContext!.targetIssues.length === 1, "应包含 1 个 issue");
      assert(result.repairContext!.targetIssues[0].description === p1Issue.description, "description 匹配");
      assert(result.repairContext!.affectedFiles.includes("src/payment.ts"), "应包含 payment 文件");
      assert(result.repairContext!.affectedFiles.includes("src/order.ts"), "应包含 order 文件");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 6: Edge cases
  // ═══════════════════════════════════════════════════════════════

  describe("边界情况", () => {
    it("空 issue 集合应触发收敛判定", () => {
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
          verification_pass_count: 2,
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

      const result = determineRoute(state);
      assert(result.targetPhase === PhaseEnum.COMPLETE, "空 issue + 达标 counter 应为 complete");
    });

    it("高 verification_pass_count 触发等效收敛", () => {
      const state = makeState({
        progress: {
          phase: PhaseEnum.ROUTING,
          cycle: 5,
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

      const result = determineRoute(state);
      assert(result.targetPhase === PhaseEnum.COMPLETE, "高 verification 应为等效收敛 complete");
      assert(result.action === "converge_equivalent", "action 应为 converge_equivalent");
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
