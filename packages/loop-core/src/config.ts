/**
 * loop-cursor 配置管理 (Configuration Management)
 *
 * 负责加载、验证和合并工作流配置。
 * 配置来源优先级（高到低）：
 * 1. 命令行参数（--safe/--unsafe/--model/--max-cycles）
 * 2. 环境变量（LOOP_CURSOR_MODE / LOOP_CURSOR_MODEL / LOOP_CURSOR_MAX_CYCLES）
 * 3. 项目配置文件（.cursor/loop-cursor/config.json）
 * 4. 硬编码默认值
 *
 * @module config
 * @version 0.1.0
 */

import type {
  WorkflowConfig,
  RunMode,
  TrustLevel,
  LoopState,
  ProgressState,
} from "./types.js";
import {
  PhaseEnum,
  RunModeEnum,
  TrustLevelEnum,
} from "./types.js";

// ============================================================================
// 默认配置常量
// ============================================================================

/** SDK 精确版本 pin */
export const EXPECTED_SDK_VERSION = "1.0.12";

/** 默认模型（Part 2 实施首选） */
export const DEFAULT_MODEL = "claude-sonnet-4-20250514";

/** Part 1 设计阶段推荐模型 */
export const DESIGN_MODEL = "claude-opus-4-20250514";

/** 默认最大轮次 */
export const DEFAULT_MAX_CYCLES = 5;

/** Part 1 设计气泡最大内部轮次 */
export const DEFAULT_MAX_PART1_ROUNDS = 5;

/** 收敛所需轮次 */
export const DEFAULT_CONVERGENCE_ROUNDS = 2;

/** 路由重复最大次数 */
export const DEFAULT_ROUTE_REPEAT_MAX = 3;

/** 默认运行模式 */
export const DEFAULT_MODE: RunMode = RunModeEnum.AUTO;

/** 默认信任级别（映射自 RunMode） */
export const MODE_TO_TRUST_LEVEL: Record<RunMode, TrustLevel> = {
  [RunModeEnum.SAFE]: TrustLevelEnum.SAFE,
  [RunModeEnum.AUTO]: TrustLevelEnum.AUTO,
  [RunModeEnum.UNSAFE]: TrustLevelEnum.UNSAFE,
  [RunModeEnum.INTERACTIVE]: TrustLevelEnum.SAFE,
};

/** 状态文件目录（相对于项目根目录） */
export const DEFAULT_STATE_DIR = ".cursor/loop-cursor";

/** 状态文件路径 */
export const DEFAULT_STATE_PATH = ".cursor/loop-cursor/state.json";

/** 上下文摘要文件路径 */
export const DEFAULT_CONTEXT_SUMMARY_PATH =
  ".cursor/loop-cursor/artifacts/context-summary.md";

/** 兼容性检查缓存文件路径 */
export const COMPAT_CHECK_CACHE_FILE = ".cursor/loop-cursor/.compat-check";

/** 兼容性检查缓存有效期（24 小时） */
export const COMPAT_CHECK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** agent.send() 默认超时（毫秒） */
export const DEFAULT_AGENT_TIMEOUT_MS = 120_000;

/** 最大重试次数 */
export const MAX_RETRIES = 3;

/** 重试基础等待时间（毫秒） */
export const RETRY_BASE_MS = 1_000;

// ============================================================================
// 默认工作流配置
// ============================================================================

/**
 * 获取默认工作流配置
 *
 * @returns 默认 WorkflowConfig 对象
 */
export function getDefaultConfig(): WorkflowConfig {
  return {
    mode: DEFAULT_MODE,
    max_cycles: DEFAULT_MAX_CYCLES,
    max_part1_rounds: DEFAULT_MAX_PART1_ROUNDS,
    convergence_rounds: DEFAULT_CONVERGENCE_ROUNDS,
    route_repeat_max: DEFAULT_ROUTE_REPEAT_MAX,
    user_request: "",
    model: DEFAULT_MODEL,
    sdk_version: EXPECTED_SDK_VERSION,
  };
}

// ============================================================================
// 默认初始状态
// ============================================================================

/**
 * 构建初始 LoopState
 *
 * 用于 state.json 不存在时创建初始状态文件。
 *
 * @param userRequest - 用户目标描述
 * @param mode - 运行模式
 * @param model - 模型 ID（可选，默认 claude-sonnet-4-20250514）
 * @returns 初始 LoopState 对象
 */
export function buildInitialState(
  userRequest: string,
  mode: RunMode = DEFAULT_MODE,
  model: string = DEFAULT_MODEL,
): LoopState {
  return {
    schema_version: 1,
    progress: {
      phase: PhaseEnum.INIT,
      cycle: 1,
      convergence_counter: 0,
      part1_round: 0,
      new_issues_this_round: false,
      new_issues_last_round: true,
      issues_snapshot_at_round_start: { p0: 0, p1: 0, p2: 0 },
      retry_count_this_phase: 0,
      verification_pass_count: 0,
      implementation_engine: null,
      repair_context: null,
      phase_transitions: [],
    },
    config: {
      mode,
      max_cycles: DEFAULT_MAX_CYCLES,
      max_part1_rounds: DEFAULT_MAX_PART1_ROUNDS,
      convergence_rounds: DEFAULT_CONVERGENCE_ROUNDS,
      route_repeat_max: DEFAULT_ROUTE_REPEAT_MAX,
      user_request: userRequest,
      model,
      sdk_version: EXPECTED_SDK_VERSION,
    },
    tasks: {
      total: 0,
      by_status: {
        completed: 0,
        in_progress: 0,
        pending: 0,
        failed: 0,
        skipped: 0,
      },
    },
    issues: {
      active: { p0: [], p1: [], p2: [] },
      resolved: { p0: 0, p1: 0, p2: 0 },
      all_time: { p0_total: 0, p1_total: 0, p2_total: 0 },
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
      invocation_count: 1,
      total_tokens_estimated: 0,
      lock_file: ".cursor/loop-cursor/.lock",
    },
  };
}

// ============================================================================
// 配置合并工具
// ============================================================================

/**
 * 合并用户提供的部分配置到默认配置
 *
 * @param overrides - 用户提供的配置覆盖项
 * @returns 合并后的完整 WorkflowConfig
 */
export function mergeConfig(
  overrides: Partial<WorkflowConfig>,
): WorkflowConfig {
  return { ...getDefaultConfig(), ...overrides };
}

/**
 * 检查是否为终端阶段（引擎应退出）
 *
 * @param phase - 当前阶段
 * @returns 是否为终端阶段
 */
export function isTerminalPhase(phase: string): boolean {
  return (
    phase === PhaseEnum.COMPLETE ||
    phase === PhaseEnum.PAUSED ||
    phase === PhaseEnum.FAILED
  );
}

/**
 * 检查当前阶段是否需要调用 agent.send()
 *
 * @param phase - 当前阶段
 * @returns 是否需要 agent 调用
 */
export function isAgentSendPhase(phase: string): boolean {
  const noSendPhases: string[] = [
    PhaseEnum.ROUTING,
    PhaseEnum.COMPLETE,
    PhaseEnum.PAUSED,
    PhaseEnum.FAILED,
  ];
  return !noSendPhases.includes(phase);
}

/**
 * 根据运行模式获取对应的信任级别
 *
 * @param mode - 运行模式
 * @returns 对应的信任级别
 */
export function getTrustLevel(mode: RunMode): TrustLevel {
  return MODE_TO_TRUST_LEVEL[mode] ?? TrustLevelEnum.AUTO;
}
