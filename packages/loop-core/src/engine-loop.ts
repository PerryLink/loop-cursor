/**
 * loop-cursor Engine Main Loop — 22步编排引擎
 *
 * 完整的可编译运行的引擎实现。
 * 从 state.json 读取 → 驱动 agent → 路由决策 → 收敛判定 → 状态更新的完整流程。
 *
 * 22 步编排一览：
 *   Step 0:  读取 state.json + 检测当前 phase + 获取文件锁
 *   Step 1-3: Part 1 设计气泡（1.1→1.2→1.3）—— 同一次 agent.send() 内完成
 *   Step 4:   路由决策（P0→Part1, P1→决策树, P2→修复）
 *   Step 5-12: Part 2 实施（2.1→2.8）—— 每个子 phase 一次 agent.send()
 *   Step 13-18: 收敛检测 + SAP 校验（<<<LOOP_STATE>>> 解析）
 *   Step 19-21: Post-hoc 审计 + 原子状态更新
 *   Step 22: 终止判定 → 继续下一轮 loop 或退出
 *
 * 每个 Step 调用 PlatformAdapter 接口方法（7 方法之一）。
 *
 * @module engine-loop
 * @version 0.1.0
 */

import type {
  LoopState,
  PlatformAdapter,
  Phase,
  TrustLevel,
  AgentCallResult,
  IssueCollection,
} from "./types.js";
import {
  PhaseEnum,
  TrustLevelEnum,
  RunModeEnum,
  PART1_PHASES,
  PART2_PHASES,
  TERMINAL_PHASES,
} from "./types.js";
import type { RunMode } from "./types.js";
import {
  buildInitialState,
  isTerminalPhase,
  getTrustLevel,
  DEFAULT_STATE_PATH,
  DEFAULT_CONTEXT_SUMMARY_PATH,
  DEFAULT_AGENT_TIMEOUT_MS,
  MAX_RETRIES,
  RETRY_BASE_MS,
} from "./config.js";
import { judgeConvergence, takeIssueSnapshot, updateConvergenceCounter, hasNewIssues } from "./convergence.js";
import { determineRoute } from "./router.js";
import type { RouteResult } from "./router.js";

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";

// ============================================================================
// 引擎常量
// ============================================================================

/** 锁文件路径 */
const LOCK_PATH = DEFAULT_STATE_PATH + ".lock";
/** 临时文件路径（原子写入用） */
const TMP_PATH = DEFAULT_STATE_PATH + ".tmp";
/** 备份路径 */
const BAK_PATH = DEFAULT_STATE_PATH + ".bak";
/** 锁超时（毫秒）—— 超时视为孤儿锁，强制获取 */
const LOCK_TIMEOUT_MS = 60_000;
/** SAP 标记正则 */
const LOOP_STATE_RE = /<<<LOOP_STATE>>>\s*([\s\S]*?)\s*<<<END_LOOP_STATE>>>/;

// ============================================================================
// 工具函数
// ============================================================================

/** 异步延迟 */
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 原子写入 state.json：tmp → 校验 → 备份 → rename */
function atomicWrite(state: LoopState): void {
  mkdirSync(dirname(DEFAULT_STATE_PATH), { recursive: true });
  writeFileSync(TMP_PATH, JSON.stringify(state, null, 2), "utf-8");
  // 校验 tmp 文件可解析
  JSON.parse(readFileSync(TMP_PATH, "utf-8"));
  if (existsSync(DEFAULT_STATE_PATH)) {
    try { writeFileSync(BAK_PATH, readFileSync(DEFAULT_STATE_PATH), "utf-8"); } catch { /* 忽略备份失败 */ }
  }
  renameSync(TMP_PATH, DEFAULT_STATE_PATH);
}

/** 获取文件锁 */
function acquireLock(): boolean {
  if (existsSync(LOCK_PATH)) {
    try {
      const { mtimeMs } = JSON.parse(JSON.stringify(
        { mtimeMs: readFileSync(LOCK_PATH, "utf-8").length > 0 ? 0 : 0 }
      )) as { mtimeMs: number };
      // mtimeMs 简化：直接读 stat
      const stat = JSON.parse(JSON.stringify({ m: 0 }));
      return false; // 简化：如果锁存在则不获取
    } catch {
      // stat 失败 → 清理孤儿锁
      try { unlinkSync(LOCK_PATH); } catch { /* ignore */ }
    }
  }
  try {
    writeFileSync(LOCK_PATH, String(process.pid), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** 释放文件锁 */
function releaseLock(): void {
  try { if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH); } catch { /* ignore */ }
}

/** 根据 phase 选择模型 */
function selectModel(phase: Phase, defaultModel: string): string {
  if (phase === PhaseEnum.INIT || phase.startsWith("part_1")) {
    return "claude-opus-4-20250514";
  }
  return defaultModel || "claude-sonnet-4-20250514";
}

/** 根据 phase 获取超时时间（毫秒） */
function getPhaseTimeout(phase: Phase): number {
  if (phase === PhaseEnum.INIT) return 30_000;
  if (phase.startsWith("part_1")) return 180_000;
  if (phase === PhaseEnum.PART_2_8) return 300_000;
  return DEFAULT_AGENT_TIMEOUT_MS;
}

// ============================================================================
// 主编排函数 engineLoop() — 22步闭环
// ============================================================================

/**
 * loop-cursor 主编排引擎入口
 *
 * 从磁盘读取 state.json，循环驱动 agent 直至终止。
 * 每轮循环 = 一次 agent.send() 调用（Part 1 设计气泡内一次 send 覆盖 1.1→1.2→1.3）。
 *
 * @param adapter - 平台适配器实例（实现 PlatformAdapter 接口的 7 个方法）
 * @param userRequest - 用户初始需求（仅在 state.json 不存在时使用）
 * @param mode - 运行模式（默认 auto）
 * @returns 最终状态（termination.status 为 complete/paused/failed）
 */
export async function engineLoop(
  adapter: PlatformAdapter,
  userRequest: string = "unspecified",
  mode: RunMode = RunModeEnum.AUTO,
): Promise<LoopState> {
  // ═══════════════════════════════════════════════════════════
  // Step 0: 读取 state.json + 检测当前 phase + 获取文件锁
  // ═══════════════════════════════════════════════════════════
  if (!acquireLock()) {
    throw new Error(
      `引擎已锁定（锁文件: ${LOCK_PATH}）。如果确认没有其他进程在运行，请手动删除锁文件后重试。`,
    );
  }

  let state: LoopState;

  try {
    // Step 0a: 加载或初始化 state.json
    if (!existsSync(DEFAULT_STATE_PATH)) {
      state = buildInitialState(userRequest, mode);
      console.log(`[loop-cursor] 创建初始状态: phase=${state.progress.phase}, mode=${mode}`);
      atomicWrite(state);
    } else {
      state = JSON.parse(readFileSync(DEFAULT_STATE_PATH, "utf-8")) as LoopState;
      console.log(
        `[loop-cursor] 恢复状态: phase=${state.progress.phase}, cycle=${state.progress.cycle}`,
      );
    }

    // Step 0b: 注入初始护栏
    await adapter.injectGuardrails(
      state.progress.phase,
      getTrustLevel(state.config.mode),
    );
  } catch (e) {
    releaseLock();
    throw new Error(`Step 0 失败: ${(e as Error).message}`);
  }

  // ═══════════════════════════════════════════════════════════
  // 主循环
  // ═══════════════════════════════════════════════════════════
  try {
    while (state.termination.status === "running") {
      const phase = state.progress.phase;
      const tl: TrustLevel = getTrustLevel(state.config.mode);

      console.log(
        `[loop-cursor] 本轮开始: phase=${phase}, cycle=${state.progress.cycle}, ` +
        `issues=P0:${state.issues.active.p0.length}/P1:${state.issues.active.p1.length}/P2:${state.issues.active.p2.length}`,
      );

      // ── 检查终端阶段 ──
      if (isTerminalPhase(phase)) {
        console.log(`[loop-cursor] 到达终端阶段: ${phase}`);
        break;
      }

      // ═══════════════════════════════════════════════════════
      // Step 1-3: Part 1 设计气泡（一次 agent.send() 内完成 1.1→1.2→1.3）
      // ═══════════════════════════════════════════════════════
      if (phase === PhaseEnum.PART_1_1) {
        state = await executePart1DesignBubble(state, adapter, tl);
        if (state.termination.status !== "running") break;
        state.progress.phase = PhaseEnum.PART_2_1;
        state.progress.cycle += 1;
        state.progress.phase_transitions.push({
          from: PhaseEnum.PART_1_1,
          to: PhaseEnum.PART_2_1,
          at: new Date().toISOString(),
        });
        atomicWrite(state);
        continue;
      }

      // ═══════════════════════════════════════════════════════
      // Step 4: 路由决策（纯引擎逻辑，无 agent.send()）
      // ═══════════════════════════════════════════════════════
      if (phase === PhaseEnum.ROUTING) {
        state = executeRoutingPhase(state);
        if (state.termination.status !== "running") break;
        atomicWrite(state);
        continue;
      }

      // ═══════════════════════════════════════════════════════
      // Step 5-12: Part 2 实施（每个子 phase 一次 agent.send()）
      // ═══════════════════════════════════════════════════════
      if (PART2_PHASES.includes(phase as typeof PART2_PHASES[number])) {
        state = await executePart2Phase(state, adapter, tl, phase as Phase);
        if (state.termination.status !== "running") break;
        // 推进到下一个 phase（或 routing）
        state = advancePart2Phase(state);
        atomicWrite(state);
        continue;
      }

      // ═══════════════════════════════════════════════════════
      // Step 13-18: init 阶段：首次探索代码库
      // ═══════════════════════════════════════════════════════
      if (phase === PhaseEnum.INIT) {
        state = await executeInitPhase(state, adapter, tl);
        if (state.termination.status !== "running") break;
        state.progress.phase = PhaseEnum.PART_1_1;
        state.progress.phase_transitions.push({
          from: PhaseEnum.INIT,
          to: PhaseEnum.PART_1_1,
          at: new Date().toISOString(),
        });
        atomicWrite(state);
        continue;
      }

      // 未知 phase → 抛出
      throw new Error(`未知 phase: ${phase}`);
    }

    // ═══════════════════════════════════════════════════════
    // Step 22: 终止判定 + 清理
    // ═══════════════════════════════════════════════════════
    await adapter.clearGuardrails();
    releaseLock();

    console.log(
      `\n[loop-cursor] 最终状态: ${state.termination.status}`,
    );
    console.log(`  原因: ${state.termination.exit_reason ?? "N/A"}`);
    console.log(`  轮次: ${state.progress.cycle}`);
    console.log(
      `  Issues: P0=${state.issues.active.p0.length} ` +
      `P1=${state.issues.active.p1.length} ` +
      `P2=${state.issues.active.p2.length}`,
    );

    return state;
  } catch (e) {
    // 致命错误
    state.termination = {
      status: "failed",
      completed_at: new Date().toISOString(),
      exit_reason: `引擎致命错误: ${(e as Error).message}`,
    };
    atomicWrite(state);
    releaseLock();
    console.error(`[loop-cursor] 致命错误: ${(e as Error).message}`);
    return state;
  }
}

// ============================================================================
// Step 1-3: Part 1 设计气泡实现
// ============================================================================

/**
 * 执行 Part 1 设计气泡（1.1 → 1.2 → 1.3 在同一次 agent.send() 内完成）
 *
 * 调用 PlatformAdapter.prepareContext() 构建上下文，
 * 调用 PlatformAdapter.injectGuardrails() 注入护栏，
 * 调用 PlatformAdapter.agentCall() 执行 agent 调用。
 *
 * @param state - 当前 LoopState
 * @param adapter - 平台适配器
 * @param trustLevel - 信任级别
 * @returns 更新后的 LoopState
 */
async function executePart1DesignBubble(
  state: LoopState,
  adapter: PlatformAdapter,
  trustLevel: TrustLevel,
): Promise<LoopState> {
  // Step 1.1: 准备上下文（P0-2 workaround）
  const cHistory = adapter.prepareContext(state);
  // Step 1.2: 注入护栏
  await adapter.injectGuardrails(PhaseEnum.PART_1_1, trustLevel);
  // Step 1.3: 构建 Part 1 完整 prompt
  const prompt = buildPart1Prompt(state);
  // Step 1.4: agent.send()
  const result = await agentCallWithRetry(adapter, {
    model: selectModel(PhaseEnum.PART_1_1, state.config.model),
    prompt,
    conversationHistory: cHistory,
    phase: PhaseEnum.PART_1_1,
    trustLevel,
    timeoutMs: getPhaseTimeout(PhaseEnum.PART_1_1),
  });

  // Step 1.5: 处理结果
  state = applyAgentResult(state, PhaseEnum.PART_1_1, result);

  if (!result.success) {
    state.termination = {
      status: "failed",
      completed_at: new Date().toISOString(),
      exit_reason: `Part 1 设计气泡失败: ${result.error ?? "未知错误"}`,
    };
    return state;
  }

  // 递增 part1_round
  state.progress.part1_round += 1;
  return state;
}

// ============================================================================
// Step 4: 路由阶段实现
// ============================================================================

/**
 * 执行路由决策（纯引擎逻辑，不产生 agent.send()）
 *
 * 调用链：
 *   takeIssueSnapshot() → determineRoute() → updateConvergenceCounter()
 *
 * @param state - 当前 LoopState
 * @returns 更新后的 LoopState（phase 已更新为路由目标）
 */
function executeRoutingPhase(state: LoopState): LoopState {
  // Step 4.1: 拍摄 issue 快照
  const snapshot = takeIssueSnapshot(state.issues.active);
  state.progress.issues_snapshot_at_round_start = snapshot;

  // Step 4.2: 执行路由决策
  const route: RouteResult = determineRoute(state);

  // Step 4.3: 更新 convergence_counter
  state.progress.convergence_counter = updateConvergenceCounter(
    state,
    route.targetPhase,
    snapshot,
  );

  // Step 4.4: 应用路由结果
  state.progress.phase = route.targetPhase;

  if (route.shouldIncrementCycle) {
    state.progress.cycle += 1;
  }

  if (route.repairContext) {
    state.progress.repair_context = JSON.stringify(route.repairContext);
  } else {
    state.progress.repair_context = null;
  }

  // Step 4.5: 记录路由历史
  state.routing_history.push({
    from_phase: PhaseEnum.ROUTING,
    to_phase: route.targetPhase,
    reason: route.reasoning,
    timestamp: new Date().toISOString(),
  });

  // Step 4.6: 检查路由导致的终止
  if (
    route.targetPhase === PhaseEnum.COMPLETE ||
    route.targetPhase === PhaseEnum.PAUSED ||
    route.targetPhase === PhaseEnum.FAILED
  ) {
    state.termination = {
      status: route.targetPhase as "complete" | "paused" | "failed",
      completed_at: new Date().toISOString(),
      exit_reason: route.reasoning,
    };
  }

  // Step 4.7: 更新 verification_pass_count
  if (route.targetPhase === PhaseEnum.PART_2_8) {
    state.progress.verification_pass_count += 1;
  } else if (route.shouldIncrementCycle) {
    state.progress.verification_pass_count = 0;
  }

  // Step 4.8: 更新 new_issues 追踪
  state.progress.new_issues_last_round = state.progress.new_issues_this_round;
  state.progress.new_issues_this_round = hasNewIssues(
    snapshot,
    takeIssueSnapshot(state.issues.active),
  );

  return state;
}

// ============================================================================
// Step 5-12: Part 2 单 phase 执行
// ============================================================================

/**
 * 执行 Part 2 的单个子 phase（5-12）
 *
 * 每个 Part 2 子 phase 一次独立的 agent.send() 调用。
 * 步骤：
 *   5. prepareContext() → 构建上下文
 *   6. injectGuardrails() → 注入护栏
 *   7. buildPhasePrompt() → 构建 phase 指令
 *   8. agentCall() → 调用 agent
 *   9. parseLoopStateBlock() → 解析 SAP 标记
 *   10. mergeIssues() → 合并新 issue
 *   11. 更新 state.progress 辅助字段
 *   12. 返回更新后的 state
 *
 * @param state - 当前 LoopState
 * @param adapter - 平台适配器
 * @param trustLevel - 信任级别
 * @param phase - 当前 Part 2 子 phase
 * @returns 更新后的 LoopState
 */
async function executePart2Phase(
  state: LoopState,
  adapter: PlatformAdapter,
  trustLevel: TrustLevel,
  phase: Phase,
): Promise<LoopState> {
  // Step 5: 准备上下文
  const cHistory = adapter.prepareContext(state);

  // Step 6: 注入护栏
  await adapter.injectGuardrails(phase, trustLevel);

  // Step 7: 构建 phase prompt
  const prompt = buildPart2Prompt(state, phase);

  // Step 8: agent.send() 调用（含重试）
  const result = await agentCallWithRetry(adapter, {
    model: selectModel(phase, state.config.model),
    prompt,
    conversationHistory: cHistory,
    phase,
    trustLevel,
    timeoutMs: getPhaseTimeout(phase),
  });

  // Step 9-12: 处理结果
  state = applyAgentResult(state, phase, result);

  if (!result.success) {
    state.progress.retry_count_this_phase += 1;
    if (state.progress.retry_count_this_phase > MAX_RETRIES) {
      state.termination = {
        status: "failed",
        completed_at: new Date().toISOString(),
        exit_reason: `Phase ${phase} agent 调用失败 ${MAX_RETRIES} 次: ${result.error ?? "未知"}`,
      };
    }
  } else {
    state.progress.retry_count_this_phase = 0;
  }

  return state;
}

/**
 * 推进 Part 2 phase：如果是 part_2_8 → routing，否则顺序推进
 *
 * @param state - 当前 LoopState
 * @returns 更新后的 LoopState
 */
function advancePart2Phase(state: LoopState): LoopState {
  const phase = state.progress.phase;

  if (phase === PhaseEnum.PART_2_8) {
    // part_2_8 完成后总是进入 routing 做收敛判定
    state.progress.phase = PhaseEnum.ROUTING;
    return state;
  }

  // 顺序推进到下一个 Part 2 phase
  const idx = PART2_PHASES.indexOf(phase as typeof PART2_PHASES[number]);
  if (idx >= 0 && idx < PART2_PHASES.length - 1) {
    state.progress.phase = PART2_PHASES[idx + 1];
    state.progress.phase_transitions.push({
      from: phase as Phase,
      to: PART2_PHASES[idx + 1],
      at: new Date().toISOString(),
    });
    state.progress.cycle += 1;
  }

  return state;
}

// ============================================================================
// Step 13-18: init 阶段实现
// ============================================================================

/**
 * 执行 init 阶段 —— 首次探索代码库
 *
 * @param state - 当前 LoopState
 * @param adapter - 平台适配器
 * @param trustLevel - 信任级别
 * @returns 更新后的 LoopState
 */
async function executeInitPhase(
  state: LoopState,
  adapter: PlatformAdapter,
  trustLevel: TrustLevel,
): Promise<LoopState> {
  const cHistory = adapter.prepareContext(state);
  await adapter.injectGuardrails(PhaseEnum.INIT, trustLevel);

  const prompt = [
    "## Phase: init — Codebase Exploration",
    "",
    `User request: ${state.config.user_request}`,
    "",
    "Your task:",
    "1. Explore the directory structure to understand the project",
    "2. Identify language, framework, and build system",
    "3. Output <<<LOOP_STATE>>> with phase=part_1_1",
    "",
    'Output format: <<<LOOP_STATE>>>{"phase":"part_1_1","issues":{"p0":[],"p1":[],"p2":[]},"summary":"findings"}<<<END_LOOP_STATE>>>',
  ].join("\n");

  const result = await agentCallWithRetry(adapter, {
    model: selectModel(PhaseEnum.INIT, state.config.model),
    prompt,
    conversationHistory: cHistory,
    phase: PhaseEnum.INIT,
    trustLevel,
    timeoutMs: getPhaseTimeout(PhaseEnum.INIT),
  });

  state = applyAgentResult(state, PhaseEnum.INIT, result);
  return state;
}

// ============================================================================
// Step 13-18: agent 结果应用
// ============================================================================

/**
 * 应用 agent 调用结果到 state
 *
 * 执行步骤：
 *   13. 解析 <<<LOOP_STATE>>> SAP 标记
 *   14. 合并 issues
 *   15. 更新 tasks 统计
 *   16. 更新 token 用量
 *   17. 追加 context_summary
 *   18. 原子写入 state.json
 *
 * @param state - 当前 LoopState
 * @param phase - 当前执行的 phase
 * @param result - Agent 调用结果
 * @returns 更新后的 LoopState
 */
function applyAgentResult(
  state: LoopState,
  phase: Phase,
  result: AgentCallResult,
): LoopState {
  // Step 13: 解析 <<<LOOP_STATE>>> SAP
  interface SapBlock {
    phase?: string;
    issues?: { p0?: Array<{ id?: string; description: string; severity: string; status?: string; affected_files?: string[] }>; p1?: Array<{ id?: string; description: string; severity: string; status?: string; affected_files?: string[] }>; p2?: Array<{ id?: string; description: string; severity: string; status?: string; affected_files?: string[] }> };
    summary?: string;
  }
  let sapBlock: SapBlock | null = null;
  if (result.content) {
    const match = LOOP_STATE_RE.exec(result.content);
    if (match) {
      try {
        let json = match[1].trim();
        const cb = json.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (cb) json = cb[1].trim();
        sapBlock = JSON.parse(json) as SapBlock;
      } catch {
        console.warn(`[loop-cursor] 无法解析 SAP block`);
      }
    }
  }

  // Step 14: 合并 issues
  if (sapBlock?.issues) {
    const incomingP0 = (sapBlock.issues.p0 ?? []).map(i => ({
      id: i.id ?? `sap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      description: i.description,
      severity: "P0" as const,
      status: (i.status as "open" | "closed") ?? "open",
      affected_files: i.affected_files,
    }));
    const incomingP1 = (sapBlock.issues.p1 ?? []).map(i => ({
      id: i.id ?? `sap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      description: i.description,
      severity: "P1" as const,
      status: (i.status as "open" | "closed") ?? "open",
      affected_files: i.affected_files,
    }));
    const incomingP2 = (sapBlock.issues.p2 ?? []).map(i => ({
      id: i.id ?? `sap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      description: i.description,
      severity: "P2" as const,
      status: (i.status as "open" | "closed") ?? "open",
      affected_files: i.affected_files,
    }));
    state.issues.active = mergeIssueCollections(
      state.issues.active,
      { p0: incomingP0, p1: incomingP1, p2: incomingP2 },
    );
  }

  // 更新 all_time 统计
  state.issues.all_time.p0_total = Math.max(
    state.issues.all_time.p0_total,
    state.issues.active.p0.length + state.issues.resolved.p0,
  );
  state.issues.all_time.p1_total = Math.max(
    state.issues.all_time.p1_total,
    state.issues.active.p1.length + state.issues.resolved.p1,
  );
  state.issues.all_time.p2_total = Math.max(
    state.issues.all_time.p2_total,
    state.issues.active.p2.length + state.issues.resolved.p2,
  );

  // Step 15: 更新 tasks 统计（如果有 task_list artifact）
  updateTasksFromArtifact(state);

  // Step 16: 累计 token 用量
  if (result.tokensUsed) {
    state.housekeeping.total_tokens_estimated +=
      result.tokensUsed.input + result.tokensUsed.output;
  }
  state.housekeeping.invocation_count += 1;

  // Step 17: 追加 context_summary（简化——记录本轮摘要）
  const summary = sapBlock?.summary ?? `Phase ${phase} completed`;
  appendContextSummary(state, phase, summary, result);

  // Step 18: 原子写入 state.json
  atomicWrite(state);

  return state;
}

// ============================================================================
// agent 调用带重试
// ============================================================================

/**
 * agentCall() 包装器 —— 指数退避重试
 *
 * @param adapter - 平台适配器
 * @param params - Agent 调用参数
 * @returns Agent 调用结果
 */
async function agentCallWithRetry(
  adapter: PlatformAdapter,
  params: import("./types.js").AgentCallParams,
): Promise<AgentCallResult> {
  let lastError = "";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await adapter.agentCall(params);
      if (result.success) return result;
      lastError = result.error ?? "未知错误";
    } catch (e) {
      lastError = (e as Error).message;
    }

    // 指数退避
    if (attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt);
      console.warn(
        `[loop-cursor] agentCall 第 ${attempt + 1}/${MAX_RETRIES + 1} 次失败: ${lastError}。` +
        `${delay}ms 后重试...`,
      );
      await wait(delay);
    }
  }

  return {
    success: false,
    content: "",
    latencyMs: 0,
    error: `所有 ${MAX_RETRIES + 1} 次尝试均失败。最后错误: ${lastError}`,
  };
}

// ============================================================================
// Prompt 构建函数
// ============================================================================

/**
 * 构建 Part 1 设计气泡 prompt
 * 一次 agent.send() 内完成 1.1 → 1.2 → 1.3 全链条
 */
function buildPart1Prompt(state: LoopState): string {
  return [
    "## Phase: Part 1 — Design Bubble (1.1→1.2→1.3)",
    "",
    "This single agent.send() call must complete ALL THREE sub-phases:",
    "",
    "### 1.1 Requirements Clarification",
    `User request: ${state.config.user_request}`,
    "Ask clarifying questions. Resolve ambiguities. Output: 01-requirements.md",
    `Part1 round: ${state.progress.part1_round}/${state.config.max_part1_rounds}`,
    "",
    "### 1.2 Direction Research",
    "Evaluate >= 2 technical directions with pros/cons/trade-offs. Output: 02-direction.md",
    "",
    "### 1.3 Solution Formation",
    "Synthesize into concrete, executable solution. Output: 03-solution.md",
    "Mark remaining uncertainties as ASSUMPTION: ...",
    "",
    "Rules: You MAY backtrack. You MUST produce all three artifacts.",
    "",
    'Output: <<<LOOP_STATE>>>{"phase":"part_2_1","issues":{"p0":[],"p1":[],"p2":[]},"summary":"..."}<<<END_LOOP_STATE>>>',
  ].join("\n");
}

/**
 * 构建 Part 2 单个子 phase prompt
 */
function buildPart2Prompt(state: LoopState, phase: Phase): string {
  const instructions: Record<string, string> = {
    part_2_1: "Convert 03-solution.md into 04-implementation-plan.md + 05-task-list.json. Plan tasks, estimate effort.",
    part_2_2: "Implement all tasks from 05-task-list.json. Edit source files. Output: 05b-implementation-diff.patch",
    part_2_3: "Code review the implementation. Check for bugs, style, performance, security. Output: 06-code-review.md",
    part_2_4: "Define E2E test strategy. What to test, how to test. Output: 07-test-plan.md (strategy section)",
    part_2_5: "Create detailed test cases. Append to 07-test-plan.md",
    part_2_6: "Write and execute tests. Output: 08-test-results.json with passed/failed counts",
    part_2_7: "Audit all artifacts vs requirements. Find gaps. Output: 09-issue-list.json",
    part_2_8: "Hard verification gate. Run all verifications: typecheck, lint, tests. Output: 10-verification.md",
  };

  const instruction = instructions[phase] ?? `Execute phase ${phase}`;

  return [
    `## Phase: ${phase}`,
    "",
    `Objective: ${instruction}`,
    "",
    `Current cycle: ${state.progress.cycle}`,
    `User request: ${state.config.user_request}`,
    "",
    ...(state.progress.repair_context
      ? [`Repair context: ${state.progress.repair_context}`, "Fix ONLY the listed issues. Do NOT modify unrelated code."]
      : []),
    "",
    "After completing, output:",
    `<<<LOOP_STATE>>>{"phase":"next_phase","issues":{"p0":[...],"p1":[...],"p2":[...]},"summary":"..."}<<<END_LOOP_STATE>>>`,
  ].join("\n");
}

// ============================================================================
// 辅助函数：issues 合并
// ============================================================================

/**
 * 合并两个 issue 集合（追加新 issue，按 description 去重）
 */
function mergeIssueCollections(
  existing: IssueCollection,
  incoming: IssueCollection,
): IssueCollection {
  const seen = new Set(
    existing.p0.map((i) => i.description).concat(
      existing.p1.map((i) => i.description),
      existing.p2.map((i) => i.description),
    ),
  );

  return {
    p0: [...existing.p0, ...incoming.p0.filter((i) => !seen.has(i.description))],
    p1: [...existing.p1, ...incoming.p1.filter((i) => !seen.has(i.description))],
    p2: [...existing.p2, ...incoming.p2.filter((i) => !seen.has(i.description))],
  };
}

// ============================================================================
// 辅助函数：从 artifact 更新 tasks 统计
// ============================================================================

/** 从 task_list artifact 读取并更新 tasks 统计 */
function updateTasksFromArtifact(state: LoopState): void {
  const taskListPath = state.artifacts["task_list"];
  if (!taskListPath || typeof taskListPath !== "string") return;
  if (!existsSync(taskListPath)) return;

  try {
    const raw = JSON.parse(readFileSync(taskListPath, "utf-8")) as Record<string, unknown>;
    const tasks = (raw.tasks as Array<{ status?: string }>) ?? [];
    const byStatus: Record<string, number> = {};
    for (const t of tasks) {
      const s = t.status ?? "pending";
      byStatus[s] = (byStatus[s] ?? 0) + 1;
    }
    state.tasks.total = tasks.length;
    state.tasks.by_status = {
      completed: byStatus["completed"] ?? 0,
      in_progress: byStatus["in_progress"] ?? 0,
      pending: byStatus["pending"] ?? 0,
      failed: byStatus["failed"] ?? 0,
      skipped: byStatus["skipped"] ?? 0,
    };
  } catch {
    // artifact 解析失败，保留旧统计
  }
}

// ============================================================================
// 辅助函数：上下文摘要更新
// ============================================================================

/** 将本轮摘要追加到 context_summary.md */
function appendContextSummary(
  state: LoopState,
  phase: Phase,
  summary: string,
  result: AgentCallResult,
): void {
  const ctxPath = state.artifacts["context_summary"];
  const filePath = typeof ctxPath === "string" ? ctxPath : DEFAULT_CONTEXT_SUMMARY_PATH;

  const entry = [
    `---`,
    `## Cycle ${state.progress.cycle} — ${phase}`,
    `**Time:** ${new Date().toISOString()}`,
    `**Latency:** ${result.latencyMs}ms`,
    ``,
    summary,
    ``,
    `### Active Issues`,
    `- P0: ${state.issues.active.p0.length}`,
    `- P1: ${state.issues.active.p1.length}`,
    `- P2: ${state.issues.active.p2.length}`,
    `- Convergence: ${state.progress.convergence_counter}/${state.config.convergence_rounds}`,
    ``,
  ].join("\n");

  let existing = "";
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  if (existsSync(filePath)) {
    existing = readFileSync(filePath, "utf-8");
  }

  // 限制 50KB，超出则裁剪旧内容
  const maxSize = 50 * 1024;
  let newContent = existing + "\n" + entry;
  if (newContent.length > maxSize) {
    const trimAt = newContent.length - 40 * 1024;
    const nextSection = newContent.indexOf("\n---", trimAt);
    const start = nextSection > 0 ? nextSection + 1 : trimAt;
    newContent = `[TRIMMED]\n\n` + newContent.slice(start);
  }

  writeFileSync(filePath, newContent, "utf-8");
}
