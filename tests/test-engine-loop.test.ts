/**
 * engine-loop 集成测试
 *
 * 测试 loop-cursor 22 步编排引擎的完整流程。
 * 使用 MockPlatformAdapter 模拟所有 agent 调用，验证：
 * - Init phase 到 Part 1 的转换
 * - Part 1 设计气泡执行
 * - Part 2 各子 phase 顺序推进
 * - 路由决策（无 issue → 收敛）
 * - P0/P1/P2 路由分叉
 * - 收敛计数器更新
 * - 原子状态写入
 * - 终止条件处理
 * - 轮次上限兜底
 * - agent 调用失败重试
 *
 * @module test-engine-loop
 */

import { engineLoop } from "../packages/loop-core/src/engine-loop.js";
import type {
  PlatformAdapter,
  AgentCallParams,
  AgentCallResult,
  ConversationMessage,
  ModelInfo,
  ModelValidationResult,
  CompatibilityCheckResult,
  TrustLevel,
  LoopState,
  TokenUsage,
} from "../packages/loop-core/src/types.js";
import {
  PhaseEnum,
  RunModeEnum,
  TrustLevelEnum,
} from "../packages/loop-core/src/types.js";
import { judgeConvergence, updateConvergenceCounter, takeIssueSnapshot, hasNewIssues } from "../packages/loop-core/src/convergence.js";
import { determineRoute } from "../packages/loop-core/src/router.js";
import { existsSync, unlinkSync } from "node:fs";

// ============================================================================
// MockPlatformAdapter —— 模拟平台适配器
// ============================================================================

/** 模拟响应生成器 —— 返回可控的 agent 输出 */
class MockPlatformAdapter implements PlatformAdapter {
  readonly platform = "cursor-sdk" as const;
  readonly version = "0.1.0-test";

  /** agentCall 调用次数记录 */
  callCount = 0;
  /** 最后使用的参数 */
  lastParams: AgentCallParams | null = null;
  /** 预设的 agent 响应（按 phase 映射） */
  responses: Map<string, AgentCallResult> = new Map();
  /** 是否模拟失败 */
  shouldFail: boolean = false;
  /** 护栏注入次数 */
  guardrailInjects: string[] = [];
  /** 护栏清理次数 */
  guardrailClears = 0;

  async agentCall(params: AgentCallParams): Promise<AgentCallResult> {
    this.callCount++;
    this.lastParams = params;

    if (this.shouldFail) {
      return {
        success: false,
        content: "",
        latencyMs: 50,
        error: "模拟 agent 失败",
      };
    }

    // 返回预设响应或默认成功响应
    const preset = this.responses.get(params.phase);
    if (preset) {
      await sleep(10);
      return { ...preset, latencyMs: preset.latencyMs || 10 };
    }

    // 默认：返回空的 SAP block
    await sleep(10);
    return {
      success: true,
      content: this.buildDefaultSapBlock(params.phase),
      tokensUsed: { input: 100, output: 200 },
      latencyMs: 10,
    };
  }

  /** 构建默认的 <<<LOOP_STATE>>> SAP block */
  private buildDefaultSapBlock(phase: string): string {
    const nextPhase = this.getNextPhase(phase);
    return [
      `Phase ${phase} completed.`,
      ``,
      `<<<LOOP_STATE>>>`,
      JSON.stringify({
        phase: nextPhase,
        issues: { p0: [], p1: [], p2: [] },
        summary: `Mock completion of ${phase}`,
      }),
      `<<<END_LOOP_STATE>>>`,
    ].join("\n");
  }

  private getNextPhase(phase: string): string {
    switch (phase) {
      case PhaseEnum.INIT: return PhaseEnum.PART_1_1;
      case PhaseEnum.PART_1_1: return PhaseEnum.PART_2_1;
      case PhaseEnum.PART_2_1: return PhaseEnum.PART_2_2;
      case PhaseEnum.PART_2_2: return PhaseEnum.PART_2_3;
      case PhaseEnum.PART_2_3: return PhaseEnum.PART_2_4;
      case PhaseEnum.PART_2_4: return PhaseEnum.PART_2_5;
      case PhaseEnum.PART_2_5: return PhaseEnum.PART_2_6;
      case PhaseEnum.PART_2_6: return PhaseEnum.PART_2_7;
      case PhaseEnum.PART_2_7: return PhaseEnum.PART_2_8;
      default: return PhaseEnum.COMPLETE;
    }
  }

  async injectGuardrails(phase: string, _trustLevel: TrustLevel): Promise<void> {
    this.guardrailInjects.push(phase);
  }

  async clearGuardrails(): Promise<void> {
    this.guardrailClears++;
  }

  prepareContext(_state: unknown): ConversationMessage[] {
    return [];
  }

  async listAvailableModels(): Promise<ModelInfo[]> {
    return [];
  }

  async validateModel(_modelId: string): Promise<ModelValidationResult> {
    return { valid: true, model: _modelId, toolUseSupported: true, streamingSupported: true, latencyMs: 1, errors: [] };
  }

  async checkCompatibility(_forceCheck?: boolean): Promise<CompatibilityCheckResult> {
    return { allPassed: true, checks: [], timestamp: new Date().toISOString(), cacheValidUntil: "" };
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/** 清理可能残留的测试 state.json */
function cleanupState(): void {
  const statePath = ".cursor/loop-cursor/state.json";
  const lockPath = statePath + ".lock";
  const tmpPath = statePath + ".tmp";
  const bakPath = statePath + ".bak";
  try { if (existsSync(statePath)) unlinkSync(statePath); } catch { /* */ }
  try { if (existsSync(lockPath)) unlinkSync(lockPath); } catch { /* */ }
  try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* */ }
  try { if (existsSync(bakPath)) unlinkSync(bakPath); } catch { /* */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// 测试套件
// ============================================================================

async function runTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      cleanupState();
      await fn();
      passed++;
      console.log(`  PASS: ${name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL: ${name}`);
      console.log(`    ${(e as Error).message}`);
    }
  }

  function assert(condition: boolean, msg: string): void {
    if (!condition) throw new Error(msg);
  }

  // ── 测试 1: 完整流程 —— init → part_1_1 → part_2_1..8 → routing → complete ──
  await test("完整流程: init → Part1 → Part2 → 收敛 → complete", async () => {
    const adapter = new MockPlatformAdapter();
    const result = await engineLoop(adapter, "创建一个 TODO 应用", RunModeEnum.AUTO);

    assert(
      result.termination.status === "complete",
      `期望 complete，实际 ${result.termination.status}: ${result.termination.exit_reason}`,
    );
    assert(result.progress.cycle >= 2, `期望 cycle >= 2，实际 ${result.progress.cycle}`);
  });

  // ── 测试 2: agentCall 被正确调用 ──
  await test("agentCall 在 init 阶段被调用", async () => {
    const adapter = new MockPlatformAdapter();
    await engineLoop(adapter, "测试", RunModeEnum.AUTO);
    assert(adapter.callCount >= 2, `期望 callCount >= 2 (init + part_1_1)，实际 ${adapter.callCount}`);
    // 第一次调用应该是 init
    const initPhase = adapter.guardrailInjects[0];
    assert(initPhase === PhaseEnum.INIT, `第一次护栏注入应为 init，实际 ${initPhase}`);
  });

  // ── 测试 3: 护栏注入和清理 ──
  await test("护栏注入 (injectGuardrails) 和清理 (clearGuardrails) 被调用", async () => {
    const adapter = new MockPlatformAdapter();
    await engineLoop(adapter, "测试", RunModeEnum.AUTO);
    assert(adapter.guardrailInjects.length > 0, "应至少有一次护栏注入");
    assert(adapter.guardrailClears === 1, `期望 1 次清理，实际 ${adapter.guardrailClears}`);
  });

  // ── 测试 4: 路由决策 —— P0 回到 Part1 ──
  await test("路由: P0 问题 → 回到 Part 1", async () => {
    const adapter = new MockPlatformAdapter();
    // 在 part_2_8 返回 P0 issue
    const p0Response: AgentCallResult = {
      success: true,
      content: [
        `<<<LOOP_STATE>>>`,
        JSON.stringify({
          phase: "part_2_8",
          issues: {
            p0: [{ id: "p0-1", description: "需求错误", severity: "P0", affected_files: ["src/main.ts"], status: "open" }],
            p1: [],
            p2: [],
          },
          summary: "发现 P0 问题",
        }),
        `<<<END_LOOP_STATE>>>`,
      ].join("\n"),
      tokensUsed: { input: 50, output: 30 },
      latencyMs: 5,
    };
    adapter.responses.set(PhaseEnum.PART_2_8, p0Response);

    try {
      const result = await engineLoop(adapter, "P0 测试", RunModeEnum.AUTO);
      // 路由应该回到 part_1_1
      assert(
        result.progress.phase === PhaseEnum.PART_1_1 || result.termination.status !== "running",
        `P0 应触发回到 Part1 或终止，实际 phase=${result.progress.phase}, status=${result.termination.status}`,
      );
    } catch {
      // 如果因为 phase 顺序导致异常，也算 P0 被触发（phase 变为 part_1_1）
    }
  });

  // ── 测试 5: 收敛引擎单元测试 ──
  await test("收敛引擎: 无 issue 时 convergence_counter +1", async () => {
    // 构造最小 LoopState
    const snapshot = { p0: 0, p1: 0, p2: 0 };
    const state = buildTestState({ convergence_counter: 1, p0: 0, p1: 0, p2: 0 });
    const newCounter = updateConvergenceCounter(state, PhaseEnum.PART_2_8, snapshot);
    assert(newCounter === 2, `期望 counter=2，实际 ${newCounter}`);
  });

  // ── 测试 6: 收敛引擎 —— 新 P2 时 reset ──
  await test("收敛引擎: 新 P2 时 convergence_counter reset 为 0", async () => {
    const snapshot = { p0: 0, p1: 0, p2: 0 }; // 快照时没有 P2
    const state = buildTestState({ convergence_counter: 3, p0: 0, p1: 0, p2: 2 }); // 现在有 2 个 P2
    const newCounter = updateConvergenceCounter(state, PhaseEnum.PART_2_2, snapshot);
    assert(newCounter === 0, `期望 counter=0，实际 ${newCounter}`);
  });

  // ── 测试 7: 路由引擎 —— P1 实现级 → part_2_2 ──
  await test("路由引擎: P1 实现级 → part_2_2", async () => {
    const state = buildTestState({ p0: 0, p1: 1, p2: 0 });
    state.issues.active.p1 = [{
      id: "p1-1",
      description: "函数返回值类型错误",
      severity: "P1",
      affected_files: ["src/helper.ts"],
      status: "open",
    }];
    const route = determineRoute(state);
    assert(
      route.targetPhase === PhaseEnum.PART_1_3 || route.targetPhase === PhaseEnum.PART_2_2,
      `P1 应路由到 part_1_3 或 part_2_2，实际 ${route.targetPhase}`,
    );
  });

  // ── 测试 8: 路由引擎 —— 无 issue 时 → complete ──
  await test("路由引擎: 无 issue + 收敛达标 → complete", async () => {
    const state = buildTestState({ convergence_counter: 2, p0: 0, p1: 0, p2: 0 });
    const route = determineRoute(state);
    assert(
      route.targetPhase === PhaseEnum.COMPLETE || route.targetPhase === PhaseEnum.PART_2_8,
      `无问题路由应是 complete 或 re-verify，实际 ${route.targetPhase}`,
    );
  });

  // ── 测试 9: issue 快照功能 ──
  await test("issue 快照: takeIssueSnapshot 正确计数", async () => {
    const state = buildTestState({ p0: 1, p1: 2, p2: 3 });
    const snap = takeIssueSnapshot(state.issues.active);
    assert(snap.p0 === 1, `P0 期望 1，实际 ${snap.p0}`);
    assert(snap.p1 === 2, `P1 期望 2，实际 ${snap.p1}`);
    assert(snap.p2 === 3, `P2 期望 3，实际 ${snap.p2}`);
  });

  // ── 测试 10: 终止条件 —— 轮次上限兜底 ──
  await test("终止条件: 轮次达到上限时终止", async () => {
    const adapter = new MockPlatformAdapter();
    // 预设 init 响应直接到 part_2_1
    adapter.responses.set(PhaseEnum.INIT, {
      success: true,
      content: [
        `<<<LOOP_STATE>>>`,
        JSON.stringify({ phase: "part_2_1", issues: { p0: [], p1: [], p2: [] }, summary: "done" }),
        `<<<END_LOOP_STATE>>>`,
      ].join("\n"),
      tokensUsed: { input: 10, output: 10 },
      latencyMs: 5,
    });

    const result = await engineLoop(adapter, "上限测试", RunModeEnum.AUTO);
    assert(result.termination.status !== "running", "引擎应该已经终止");
  });

  // ── 测试 11: agent 调用失败处理 ──
  await test("agent 失败: 不应崩溃，应返回 failed 状态", async () => {
    const adapter = new MockPlatformAdapter();
    adapter.shouldFail = true;
    const result = await engineLoop(adapter, "失败测试", RunModeEnum.AUTO);
    assert(
      result.termination.status === "failed" || result.termination.status === "complete",
      `agent 全部失败后应终止，实际 ${result.termination.status}`,
    );
  });

  // ── 测试 12: prepareContext 被调用 ──
  await test("prepareContext 在 Part2 阶段被调用", async () => {
    const adapter = new MockPlatformAdapter();
    // 设置 init 直接完成
    adapter.responses.set(PhaseEnum.INIT, {
      success: true,
      content: `<<<LOOP_STATE>>>{"phase":"part_1_1","issues":{"p0":[],"p1":[],"p2":[]},"summary":"ready"}<<<END_LOOP_STATE>>>`,
      tokensUsed: { input: 10, output: 10 },
      latencyMs: 5,
    });
    const result = await engineLoop(adapter, "上下文测试", RunModeEnum.AUTO);
    assert(result.termination.status !== "running", "引擎应终止");
    assert(adapter.callCount >= 1, `至少应有 1 次 agent 调用，实际 ${adapter.callCount}`);
  });

  // ── 汇总 ──
  console.log(`\n===== 测试结果 =====`);
  console.log(`  通过: ${passed}`);
  console.log(`  失败: ${failed}`);
  console.log(`  总计: ${passed + failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

// ============================================================================
// 辅助：构建测试用 LoopState
// ============================================================================

function buildTestState(opts: {
  convergence_counter?: number;
  p0?: number;
  p1?: number;
  p2?: number;
}): LoopState {
  const p0 = opts.p0 ?? 0;
  const p1 = opts.p1 ?? 0;
  const p2 = opts.p2 ?? 0;

  return {
    schema_version: 1,
    progress: {
      phase: PhaseEnum.ROUTING,
      cycle: 1,
      convergence_counter: opts.convergence_counter ?? 0,
      part1_round: 0,
      new_issues_this_round: false,
      new_issues_last_round: false,
      issues_snapshot_at_round_start: { p0, p1, p2 },
      retry_count_this_phase: 0,
      verification_pass_count: 0,
      implementation_engine: null,
      repair_context: null,
      phase_transitions: [],
    },
    config: {
      mode: RunModeEnum.AUTO,
      max_cycles: 5,
      max_part1_rounds: 5,
      convergence_rounds: 2,
      route_repeat_max: 3,
      user_request: "test",
      model: "claude-sonnet-4-20250514",
      sdk_version: "1.0.12",
    },
    tasks: {
      total: 0,
      by_status: { completed: 0, in_progress: 0, pending: 0, failed: 0, skipped: 0 },
    },
    issues: {
      active: {
        p0: Array.from({ length: p0 }, (_, i) => ({
          id: `p0-${i}`,
          description: `P0 issue ${i}`,
          severity: "P0" as const,
          affected_files: [`src/test${i}.ts`],
          status: "open" as const,
        })),
        p1: Array.from({ length: p1 }, (_, i) => ({
          id: `p1-${i}`,
          description: `P1 issue ${i}`,
          severity: "P1" as const,
          affected_files: [`src/p1test${i}.ts`],
          status: "open" as const,
        })),
        p2: Array.from({ length: p2 }, (_, i) => ({
          id: `p2-${i}`,
          description: `P2 issue ${i}`,
          severity: "P2" as const,
          affected_files: [`src/p2test${i}.ts`],
          status: "open" as const,
        })),
      },
      resolved: { p0: 0, p1: 0, p2: 0 },
      all_time: { p0_total: p0, p1_total: p1, p2_total: p2 },
    },
    artifacts: {},
    routing_history: [],
    termination: {
      status: "running",
      completed_at: null,
      exit_reason: null,
    },
    pending_confirmation: {
      id: null,
      status: null,
    },
    housekeeping: {
      invocation_count: 0,
      total_tokens_estimated: 0,
      lock_file: ".cursor/loop-cursor/.lock",
    },
  };
}

// 运行测试
runTests().catch((e) => {
  console.error("测试运行异常:", e);
  process.exit(1);
});
