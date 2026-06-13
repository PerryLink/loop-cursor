/**
 * state-machine 单元测试
 *
 * 测试文件状态机的完整功能：
 * - state.json 加载/保存
 * - 原子写入（tmp -> rename）
 * - Default-FAIL 合约（termination.status 初始 "running"）
 * - Phase 转换和回滚
 * - 锁的获取/释放
 * - 备份和恢复
 * - 健康检查
 * - 清理和重置
 *
 * @module test-state-machine
 */

import {
  loadState,
  saveState,
  atomicWrite,
  acquireLock,
  releaseLock,
  checkLock,
  transitionPhase,
  isTerminalPhase,
  rollbackPhase,
  restoreFromBackup,
  createNamedBackup,
  healthCheck,
  purgeStateFiles,
  getTransitionSummary,
  batchUpdate,
  tryLoadState,
} from "../packages/loop-core/src/state-machine.js";
import { validateState, ensureDefaultFailContract, validateGateState,
  isSchemaVersionCompatible, formatValidationErrors,
  STATE_JSON_SCHEMA, GATE_STATE_JSON_SCHEMA, CURRENT_SCHEMA_VERSION } from "../packages/loop-core/src/schema.js";
import { buildInitialState, DEFAULT_STATE_PATH } from "../packages/loop-core/src/config.js";
import { PhaseEnum, RunModeEnum, TERMINAL_PHASES } from "../packages/loop-core/src/types.js";
import type { LoopState, Phase } from "../packages/loop-core/src/types.js";
import { existsSync, unlinkSync, readFileSync } from "node:fs";

// ============================================================================
// 辅助函数
// ============================================================================

/** 清理测试环境 */
function cleanup(): void {
  const paths = [
    DEFAULT_STATE_PATH,
    DEFAULT_STATE_PATH + ".lock",
    DEFAULT_STATE_PATH + ".tmp",
    DEFAULT_STATE_PATH + ".bak",
  ];
  for (const p of paths) {
    try { if (existsSync(p)) unlinkSync(p); } catch { /* */ }
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

// ============================================================================
// 测试入口
// ============================================================================

async function runTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      cleanup();
      await fn();
      passed++;
      console.log(`  PASS: ${name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL: ${name}`);
      console.log(`    ${(e as Error).message}`);
    }
  }

  // ── 测试 1: 初始状态构建 ──
  await test("构建初始 LoopState 并通过 Schema 验证", async () => {
    const state = buildInitialState("测试需求", RunModeEnum.AUTO);
    assert(state.schema_version === CURRENT_SCHEMA_VERSION,
      `schema_version 应为 ${CURRENT_SCHEMA_VERSION}`);
    assert(state.termination.status === "running", "termination.status 初始应为 running");
    assert(state.progress.phase === PhaseEnum.INIT, "初始 phase 应为 init");

    const validation = validateState(state);
    assert(validation.valid, `Schema 验证失败: ${validation.errors.join("; ")}`);
  });

  // ── 测试 2: Default-FAIL 合约 ──
  await test("Default-FAIL 合约：缺失 termination 时自动修复", async () => {
    const state = buildInitialState("测试", RunModeEnum.AUTO);
    // 模拟数据损坏：删除 termination
    (state as Record<string, unknown>).termination = undefined;
    const fixed = ensureDefaultFailContract(state);
    assert(fixed.termination.status === "running", "修复后应为 running");
    assert(fixed.termination.completed_at === null, "completed_at 应为 null");
    assert(fixed.termination.exit_reason === null, "exit_reason 应为 null");
  });

  // ── 测试 3: 原子写入 ──
  await test("原子写入 state.json 并验证持久化", async () => {
    const state = buildInitialState("原子写入测试", RunModeEnum.AUTO);
    saveState(state);
    assert(existsSync(DEFAULT_STATE_PATH), "state.json 应该存在");

    // 验证内容
    const loaded = loadState();
    assert(loaded !== null, "加载不应返回 null");
    assert(loaded!.config.user_request === "原子写入测试", "内容应一致");
  });

  // ── 测试 4: 锁机制 ──
  await test("获取和释放文件锁", async () => {
    const locked = acquireLock();
    assert(locked, "应该能获取锁");

    // 双重获取应失败
    const doubleLock = acquireLock();
    assert(!doubleLock, "已持锁时不应再次获取");

    // 释放后应能重新获取
    releaseLock();
    const reLock = acquireLock();
    assert(reLock, "释放后应能重新获取");
    releaseLock();
  });

  // ── 测试 5: 锁状态检查 ──
  await test("检查锁状态", async () => {
    const beforeCheck = checkLock();
    assert(!beforeCheck.locked, "锁初始应为未锁定");

    acquireLock();
    const afterCheck = checkLock();
    assert(afterCheck.locked, "锁应为已锁定状态");
    assert(afterCheck.pid === String(process.pid), "PID 应匹配");

    releaseLock();
  });

  // ── 测试 6: Phase 转换 ──
  await test("Phase 转换并记录历史", async () => {
    const state = buildInitialState("Phase 测试", RunModeEnum.AUTO);
    transitionPhase(state, PhaseEnum.PART_1_1, "init 完成");

    assert(state.progress.phase === PhaseEnum.PART_1_1, "phase 应为 part_1_1");
    assert(state.progress.phase_transitions.length === 1, "应有 1 条转换记录");
    assert(
      state.progress.phase_transitions[0].from === PhaseEnum.INIT,
      "转换来源应为 init",
    );
    assert(
      state.progress.phase_transitions[0].to === PhaseEnum.PART_1_1,
      "转换目标应为 part_1_1",
    );
    assert(state.routing_history.length === 1, "应有 1 条路由记录");
  });

  // ── 测试 7: 终止阶段检测 ──
  await test("检测终端阶段", async () => {
    assert(isTerminalPhase(PhaseEnum.COMPLETE), "complete 应为终端");
    assert(isTerminalPhase(PhaseEnum.PAUSED), "paused 应为终端");
    assert(isTerminalPhase(PhaseEnum.FAILED), "failed 应为终端");
    assert(!isTerminalPhase(PhaseEnum.PART_1_1), "part_1_1 不应为终端");
    assert(!isTerminalPhase(PhaseEnum.PART_2_8), "part_2_8 不应为终端");
    assert(!isTerminalPhase(PhaseEnum.INIT), "init 不应为终端");
  });

  // ── 测试 8: Phase 转换到终止阶段 ──
  await test("Phase 转换到终止阶段时更新 termination", async () => {
    const state = buildInitialState("终止测试", RunModeEnum.AUTO);
    transitionPhase(state, PhaseEnum.COMPLETE, "目标达成");

    assert(state.progress.phase === PhaseEnum.COMPLETE, "phase 应为 complete");
    assert(state.termination.status === "complete", "termination.status 应为 complete");
    assert(state.termination.completed_at !== null, "completed_at 不应为 null");
    assert(state.termination.exit_reason === "目标达成", "exit_reason 应匹配");
  });

  // ── 测试 9: Phase 回滚 ──
  await test("Phase 回滚到上一个阶段", async () => {
    const state = buildInitialState("回滚测试", RunModeEnum.AUTO);
    transitionPhase(state, PhaseEnum.PART_1_1, "step 1");
    transitionPhase(state, PhaseEnum.PART_2_1, "step 2");

    const rolled = rollbackPhase(state);
    assert(rolled, "回滚应成功");
    assert(state.progress.phase === PhaseEnum.PART_1_1,
      `回滚后 phase 应为 part_1_1，实际 ${state.progress.phase}`);
  });

  // ── 测试 10: 转换历史摘要 ──
  await test("获取 Phase 转换历史摘要", async () => {
    const state = buildInitialState("摘要测试", RunModeEnum.AUTO);
    transitionPhase(state, PhaseEnum.PART_1_1, "step 1");
    transitionPhase(state, PhaseEnum.PART_1_2, "step 2");
    transitionPhase(state, PhaseEnum.PART_1_3, "step 3");

    const summary = getTransitionSummary(state);
    assert(summary.includes("init"), "摘要应包含 init");
    assert(summary.includes("part_1_3"), "摘要应包含 part_1_3");
    assert(summary.includes("->"), "摘要应包含箭头");
  });

  // ── 测试 11: 备份和恢复 ──
  await test("备份和恢复 state.json", async () => {
    const state = buildInitialState("备份测试", RunModeEnum.AUTO);
    state.progress.cycle = 42; // 标记特征值
    // 第一次写入（创建 state.json）
    saveState(state);
    // 修改并再次写入（此时 state.json 已存在，会触发备份）
    state.progress.cycle = 99;
    saveState(state);

    // 验证备份文件存在（第二次 saveState 时触发备份）
    assert(existsSync(DEFAULT_STATE_PATH + ".bak"), "备份文件应存在");

    // 删除原文件
    unlinkSync(DEFAULT_STATE_PATH);

    // 从备份恢复
    const restored = restoreFromBackup();
    assert(restored !== null, "恢复不应返回 null");
    // 备份保存的是第一次写入的内容（cycle=42）
    assert(restored!.progress.cycle === 42, `恢复的 cycle 应为 42，实际 ${restored!.progress.cycle}`);
  });

  // ── 测试 12: 命名备份 ──
  await test("创建命名备份快照", async () => {
    const state = buildInitialState("命名备份", RunModeEnum.AUTO);
    saveState(state);

    const backupPath = createNamedBackup("before-migration");
    assert(backupPath !== null, "备份路径不应为 null");
    assert(backupPath!.includes("before-migration"), "备份路径应包含标签");

    // 清理
    try { if (existsSync(backupPath!)) unlinkSync(backupPath!); } catch { /* */ }
  });

  // ── 测试 13: 批量更新 ──
  await test("批量更新：多操作合并为一次写入", async () => {
    const state = buildInitialState("批量更新", RunModeEnum.AUTO);
    saveState(state);

    const loaded = loadState()!;
    batchUpdate(loaded, (s) => {
      s.progress.cycle = 10;
      s.progress.phase = PhaseEnum.PART_2_1;
      s.progress.convergence_counter = 5;
    });

    const reloaded = loadState()!;
    assert(reloaded.progress.cycle === 10, "cycle 应更新");
    assert(reloaded.progress.phase === PhaseEnum.PART_2_1, "phase 应更新");
    assert(reloaded.progress.convergence_counter === 5, "convergence_counter 应更新");
  });

  // ── 测试 14: Schema 验证 —— 缺失字段 ──
  await test("Schema 验证检测缺失字段", async () => {
    const badState = { schema_version: 1 };
    const result = validateState(badState);
    assert(!result.valid, "应验证失败");
    assert(result.errors.length > 0, "应有错误信息");
  });

  // ── 测试 15: Schema 验证 —— 无效 phase ──
  await test("Schema 验证检测无效 phase", async () => {
    const state = buildInitialState("测试", RunModeEnum.AUTO);
    (state.progress as Record<string, unknown>).phase = "invalid_phase_xyz";
    const result = validateState(state);
    assert(!result.valid, "应验证失败");
    assert(result.errors.some((e) => e.includes("phase")), "错误应包含 phase");
  });

  // ── 测试 16: GateState Schema 验证 ──
  await test("GateState Schema 验证", async () => {
    const validGate = {
      gate_id: "G1-content-safety",
      phase: "part_2_2",
      enabled: true,
      results: {
        pass: true,
        blocks: [],
        reason: "所有检查通过",
        checked_at: new Date().toISOString(),
      },
    };
    const result = validateGateState(validGate);
    assert(result.valid, `有效 GateState 应通过验证: ${result.errors.join("; ")}`);

    const invalidGate = { gate_id: "", phase: "invalid", enabled: "yes" };
    const result2 = validateGateState(invalidGate);
    assert(!result2.valid, "无效 GateState 应验证失败");
  });

  // ── 测试 17: Schema 版本兼容性 ──
  await test("Schema 版本兼容性检查", async () => {
    assert(isSchemaVersionCompatible(1), "版本 1 应兼容");
    assert(!isSchemaVersionCompatible(0), "版本 0 应不兼容");
    assert(!isSchemaVersionCompatible(2), "版本 2 应不兼容");
  });

  // ── 测试 18: 验证错误格式化 ──
  await test("验证错误格式化输出", async () => {
    const result = { valid: false, errors: ["err1", "err2"], warnings: ["warn1"] };
    const formatted = formatValidationErrors(result);
    assert(formatted.includes("[ERROR]"), "应包含 [ERROR] 标签");
    assert(formatted.includes("[WARN]"), "应包含 [WARN] 标签");
    assert(formatted.includes("err1"), "应包含错误信息");
  });

  // ── 测试 19: 健康检查 ──
  await test("健康检查报告", async () => {
    const state = buildInitialState("健康检查", RunModeEnum.AUTO);
    saveState(state);
    releaseLock();

    const result = healthCheck();
    assert(result.stateExists, "state.json 应存在");
    assert(result.stateValid, "state.json 应有效");
    assert(result.healthy, "整体应健康");
  });

  // ── 测试 20: 清理所有状态文件 ──
  await test("清理所有状态文件", async () => {
    const state = buildInitialState("清理测试", RunModeEnum.AUTO);
    saveState(state);
    acquireLock();

    const removed = purgeStateFiles();
    assert(removed.length > 0, "应有文件被删除");
    assert(!existsSync(DEFAULT_STATE_PATH), "state.json 应被删除");
    assert(!existsSync(DEFAULT_STATE_PATH + ".lock"), "锁文件应被删除");
  });

  // ── 测试 21: tryLoadState 不存在时返回 null ──
  await test("tryLoadState: state.json 不存在时返回 null 而非异常", async () => {
    const result = tryLoadState();
    assert(result === null, "文件不存在时应返回 null");
  });

  // ── 测试 22: 加载时 Schema 验证 ──
  await test("loadState: Schema 验证不通过时抛出异常", async () => {
    // 写入损坏的 JSON（缺少必需字段）
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(DEFAULT_STATE_PATH), { recursive: true });
    writeFileSync(DEFAULT_STATE_PATH,
      '{"schema_version":1,"progress":{"phase":"init"}}', "utf-8");

    let threw = false;
    try {
      loadState();
    } catch (e) {
      threw = true;
      assert((e as Error).message.includes("Schema"), "错误应提及 Schema");
    }
    assert(threw, "应抛出异常");
  });

  // ── 汇总 ──
  console.log(`\n===== 测试结果 =====`);
  console.log(`  通过: ${passed}`);
  console.log(`  失败: ${failed}`);
  console.log(`  总计: ${passed + failed}`);

  if (failed > 0) process.exit(1);
}

runTests().catch((e) => {
  console.error("测试运行异常:", e);
  process.exit(1);
});
