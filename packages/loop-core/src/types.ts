/**
 * loop-cursor 共享类型系统 (Shared Type System)
 *
 * 定义所有跨模块共享的核心类型、接口和枚举。
 * 包括：
 * - 工作流阶段枚举 (PhaseEnum)
 * - 信任级别 (TrustLevel)
 * - 完整状态对象 (LoopState)
 * - 平台适配器接口 (PlatformAdapter，含 7 方法签名)
 * - Agent 调用参数/结果类型
 * - 模型信息/验证结果类型
 * - 兼容性检查结果类型
 *
 * @module types
 * @version 0.1.0
 */

// ============================================================================
// 一、枚举类型 (Enums)
// ============================================================================

/**
 * 工作流阶段枚举
 *
 * Part 1（设计气泡）：1.1 -> 1.2 -> 1.3 在同一次 agent.send() 内完成
 * Part 2（顺序执行）：每个子 phase 一次独立的 agent.send()
 * routing/complete/paused/failed：引擎内部状态，不触发 agent.send()
 */
export const PhaseEnum = {
  /** 初始化：探索代码库，建立基线 */
  INIT: "init",
  /** Part 1.1：需求澄清 */
  PART_1_1: "part_1_1",
  /** Part 1.2：方向研究 */
  PART_1_2: "part_1_2",
  /** Part 1.3：方案形成 */
  PART_1_3: "part_1_3",
  /** Part 2.1：方案 -> Plan + Tasks */
  PART_2_1: "part_2_1",
  /** Part 2.2：实施编码 */
  PART_2_2: "part_2_2",
  /** Part 2.3：Code Review */
  PART_2_3: "part_2_3",
  /** Part 2.4：测试策略 */
  PART_2_4: "part_2_4",
  /** Part 2.5：测试规划 */
  PART_2_5: "part_2_5",
  /** Part 2.6：执行测试 */
  PART_2_6: "part_2_6",
  /** Part 2.7：验证查漏 */
  PART_2_7: "part_2_7",
  /** Part 2.8：硬验证闸门 */
  PART_2_8: "part_2_8",
  /** 引擎内部路由判定 */
  ROUTING: "routing",
  /** 已完成 */
  COMPLETE: "complete",
  /** 已暂停 */
  PAUSED: "paused",
  /** 已失败 */
  FAILED: "failed",
} as const;

/** Phase 字符串联合类型 */
export type Phase = (typeof PhaseEnum)[keyof typeof PhaseEnum];

/**
 * Part 1 设计气泡阶段列表
 * 这些 phase 在同一次 agent.send() 内完成
 */
export const PART1_PHASES: Phase[] = [
  PhaseEnum.PART_1_1,
  PhaseEnum.PART_1_2,
  PhaseEnum.PART_1_3,
];

/**
 * Part 2 顺序执行阶段列表
 * 每个 phase 需要一次独立的 agent.send()
 */
export const PART2_PHASES: Phase[] = [
  PhaseEnum.PART_2_1,
  PhaseEnum.PART_2_2,
  PhaseEnum.PART_2_3,
  PhaseEnum.PART_2_4,
  PhaseEnum.PART_2_5,
  PhaseEnum.PART_2_6,
  PhaseEnum.PART_2_7,
  PhaseEnum.PART_2_8,
];

/** 终端阶段：引擎应退出 */
export const TERMINAL_PHASES: Phase[] = [
  PhaseEnum.COMPLETE,
  PhaseEnum.PAUSED,
  PhaseEnum.FAILED,
];

/**
 * 信任级别枚举
 *
 * L1 (safe)：全部 6 个闸门激活，暂停等待用户确认
 * L2 (auto)：默认模式，自动通过方案确认，拦截不可逆操作
 * L3 (unsafe)：除灾难性操作外全部放行
 */
export const TrustLevelEnum = {
  SAFE: "L1",
  AUTO: "L2",
  UNSAFE: "L3",
} as const;

/** 信任级别字符串联合类型 */
export type TrustLevel = (typeof TrustLevelEnum)[keyof typeof TrustLevelEnum];

/**
 * 运行模式枚举
 */
export const RunModeEnum = {
  /** 安全模式：全部闸门激活，暂停等待确认 */
  SAFE: "safe",
  /** 标准模式（默认）：自动通过方案确认 */
  AUTO: "auto",
  /** 无限制模式：仅灾难性拦截 */
  UNSAFE: "unsafe",
  /** 协作模式：决策点暂停等待 */
  INTERACTIVE: "interactive",
} as const;

/** 运行模式字符串联合类型 */
export type RunMode = (typeof RunModeEnum)[keyof typeof RunModeEnum];

// ============================================================================
// 二、问题与任务类型 (Issue & Task Types)
// ============================================================================

/**
 * 问题记录
 * 由 agent 在 <<<LOOP_STATE>>> SAP block 中报告
 */
export interface Issue {
  /** 问题唯一标识 */
  id: string;
  /** 问题描述 */
  description: string;
  /** 受影响的文件路径列表 */
  affected_files?: string[];
  /** 问题严重度 */
  severity: "P0" | "P1" | "P2";
  /** 问题状态 */
  status?: "open" | "closed";
}

/**
 * 按严重度分组的问题集合
 */
export interface IssueCollection {
  /** P0 级问题：需求/方案/架构错误 */
  p0: Issue[];
  /** P1 级问题：核心功能缺失/安全漏洞 */
  p1: Issue[];
  /** P2 级问题：边界 case/UI 瑕疵 */
  p2: Issue[];
}

/**
 * 已解决问题计数
 */
export interface ResolvedIssueCount {
  p0: number;
  p1: number;
  p2: number;
}

/**
 * 任务状态
 */
export type TaskStatus = "completed" | "in_progress" | "pending" | "failed" | "skipped";

/**
 * 按状态分组的任务计数
 */
export interface TaskStatusCounts {
  completed: number;
  in_progress: number;
  pending: number;
  failed: number;
  skipped: number;
}

/**
 * 路由历史记录
 * 记录每次 phase 转换的原因和时间
 */
export interface RoutingRecord {
  /** 来源 phase */
  from_phase: Phase;
  /** 目标 phase */
  to_phase: Phase;
  /** 路由原因 */
  reason: string;
  /** 时间戳 */
  timestamp: string;
}

// ============================================================================
// 三、工作流进度与配置类型 (Progress & Config Types)
// ============================================================================

/**
 * 工作流进度状态
 * 记录当前执行的轮次、phase、收敛计数器等
 */
export interface ProgressState {
  /** 当前阶段 */
  phase: Phase;
  /** 当前轮次（agent.send() 调用次数，初始为 1） */
  cycle: number;
  /** 收敛计数器：0 -> rounds 之间变化 */
  convergence_counter: number;
  /** Part 1 设计气泡内部轮次 */
  part1_round: number;
  /** 本轮是否发现新问题 */
  new_issues_this_round: boolean;
  /** 上一轮是否发现新问题 */
  new_issues_last_round: boolean;
  /** 轮次开始时的问题快照计数 */
  issues_snapshot_at_round_start: ResolvedIssueCount;
  /** 当前 phase 重试次数 */
  retry_count_this_phase: number;
  /** 验证通过次数 */
  verification_pass_count: number;
  /** 实施引擎类型标识 */
  implementation_engine: string | null;
  /** 修复上下文 */
  repair_context: string | null;
  /** phase 转换历史 */
  phase_transitions: Array<{ from: Phase; to: Phase; at: string }>;
}

/**
 * 工作流配置
 * 用户可调整的运行时参数
 */
export interface WorkflowConfig {
  /** 运行模式 */
  mode: RunMode;
  /** 最大轮次上限 */
  max_cycles: number;
  /** Part 1 设计气泡最大内部轮次 */
  max_part1_rounds: number;
  /** 收敛所需轮次 */
  convergence_rounds: number;
  /** 路由重复最大次数 */
  route_repeat_max: number;
  /** 用户原始需求 */
  user_request: string;
  /** 使用的模型 ID */
  model: string;
  /** SDK 版本 */
  sdk_version: string;
}

/**
 * 待处理确认
 * 用于 interactive 模式下暂停等待用户输入
 */
export interface PendingConfirmation {
  /** 确认 ID */
  id: string | null;
  /** 确认状态 */
  status: "awaiting" | "approved" | "rejected" | null;
  /** 确认问题描述 */
  question?: string;
  /** 可用选项 */
  options?: string[];
  /** 创建时间 */
  created_at?: string;
  /** 超时时间 */
  timeout_at?: string;
}

/**
 * 内务管理
 */
export interface Housekeeping {
  /** 调用次数 */
  invocation_count: number;
  /** 预估总 token 消耗 */
  total_tokens_estimated: number;
  /** .lock 文件路径 */
  lock_file: string;
}

// ============================================================================
// 四、核心状态对象 (LoopState)
// ============================================================================

/**
 * loop-cursor 完整状态对象 (LoopState)
 *
 * 文件持久化的状态机核心。保存到 state.json，每轮 agent.send() 后原子更新。
 * 包含工作流进度、配置、任务/问题状态、路由历史、终止状态等全部运行时信息。
 */
export interface LoopState {
  /** Schema 版本号，用于向前兼容 */
  schema_version: number;

  /** 工作流进度 */
  progress: ProgressState;

  /** 工作流配置 */
  config: WorkflowConfig;

  /** 任务状态 */
  tasks: {
    total: number;
    by_status: TaskStatusCounts;
  };

  /** 问题追踪 */
  issues: {
    /** 当前活跃问题 */
    active: IssueCollection;
    /** 已解决问题计数 */
    resolved: ResolvedIssueCount;
    /** 历史总计 */
    all_time: {
      p0_total: number;
      p1_total: number;
      p2_total: number;
    };
  };

  /** 产出物引用 */
  artifacts: Record<string, string>;

  /** 路由历史 */
  routing_history: RoutingRecord[];

  /** 终止状态 */
  termination: {
    status: "running" | "complete" | "paused" | "failed";
    completed_at: string | null;
    exit_reason: string | null;
  };

  /** 待处理确认（interactive 模式） */
  pending_confirmation: PendingConfirmation;

  /** 内务管理 */
  housekeeping: Housekeeping;
}

// ============================================================================
// 五、平台适配器核心类型 (Platform Adapter Types)
// ============================================================================

/**
 * Agent 调用参数
 *
 * 传递给平台适配器的 agentCall() 方法的参数对象。
 * 封装了一次 agent.send() 所需的所有信息。
 */
export interface AgentCallParams {
  /** 模型 ID */
  model: string;
  /** 当前 phase 的指令 prompt */
  prompt: string;
  /** 跨轮次对话历史（context_summary.md 注入为前缀） */
  conversationHistory?: ConversationMessage[];
  /** 当前工作流阶段 */
  phase: Phase;
  /** 信任级别 */
  trustLevel: TrustLevel;
  /** 超时时间（毫秒），默认 120000 */
  timeoutMs?: number;
}

/**
 * 对话消息
 * 用于构造 conversation_history 数组
 */
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * 工具调用记录
 * 记录 agent 在单轮中使用的工具调用
 */
export interface ToolCallRecord {
  /** 工具名称 */
  tool: string;
  /** 工具调用参数 */
  args: Record<string, unknown>;
  /** 工具调用结果 */
  result?: string;
}

/**
 * Agent 调用结果
 *
 * 平台适配器 agentCall() 方法的返回值。
 * 封装了一次 agent.send() 的完整响应信息。
 */
export interface AgentCallResult {
  /** 调用是否成功 */
  success: boolean;
  /** 响应内容文本 */
  content: string;
  /** 工具调用记录（如果有） */
  toolCalls?: ToolCallRecord[];
  /** Token 使用量估计 */
  tokensUsed?: TokenUsage;
  /** 调用延迟（毫秒） */
  latencyMs: number;
  /** 错误信息（失败时） */
  error?: string;
  /** 原始响应对象（平台特定） */
  rawResponse?: unknown;
}

/**
 * Token 使用量
 */
export interface TokenUsage {
  /** 输入 token 数 */
  input: number;
  /** 输出 token 数 */
  output: number;
}

/**
 * 模型信息
 *
 * 描述一个可用模型的能力和推荐用途。
 */
export interface ModelInfo {
  /** 模型 ID */
  id: string;
  /** 供应商 */
  provider: string;
  /** 是否支持 tool use */
  supportsToolUse: boolean;
  /** 是否支持 streaming */
  supportsStreaming: boolean;
  /** 推荐用途 */
  recommendedFor: Array<"design" | "implement" | "verify">;
  /** 验证状态：confirmed（已验证通过）、untested（未测试）、failed（验证失败） */
  status: "confirmed" | "untested" | "failed";
}

/**
 * 模型验证结果
 *
 * 对单个模型进行工具调用和 streaming 能力验证后的结果。
 */
export interface ModelValidationResult {
  /** 模型是否通过验证 */
  valid: boolean;
  /** 模型 ID */
  model: string;
  /** 是否支持 tool use */
  toolUseSupported: boolean;
  /** 是否支持 streaming */
  streamingSupported: boolean;
  /** 验证调用延迟（毫秒） */
  latencyMs: number;
  /** 错误信息列表 */
  errors: string[];
}

/**
 * SDK 兼容性检查结果
 *
 * 5 项检查的完整结果，用于启动时判定 SDK 环境是否可用。
 */
export interface CompatibilityCheckResult {
  /** 总体是否通过 */
  allPassed: boolean;
  /** 各项检查明细 */
  checks: CompatibilityCheckItem[];
  /** 执行时间戳 */
  timestamp: string;
  /** 缓存有效期 */
  cacheValidUntil: string;
}

/**
 * 单项兼容性检查结果
 */
export interface CompatibilityCheckItem {
  /** 检查名称 */
  name: string;
  /** 是否通过 */
  pass: boolean;
  /** 检查详情 */
  detail: string;
}

// ============================================================================
// 六、平台适配器接口 (PlatformAdapter Interface -- 7 方法签名)
// ============================================================================

/**
 * 平台适配器抽象接口
 *
 * 定义了所有平台适配器（claude-code / cursor-sdk）必须实现的 7 个方法。
 * loop-core 引擎通过此接口与具体平台解耦，实现"一次编写，多平台适配"。
 *
 * **7 方法清单：**
 * 1. agentCall()    —— 执行一次 agent 调用（封装 agent.send() + 重试 + 错误分类）
 * 2. injectGuardrails() —— 注入平台特定的安全护栏（动态生成 .cursor/rules/ + hooks.json）
 * 3. clearGuardrails()  —— 清理平台护栏（终止/phase 切换时调用）
 * 4. prepareContext()   —— 准备跨轮次上下文（解决 Cursor SDK 上下文不保留的 P0-2 问题）
 * 5. listAvailableModels() —— 列出平台可用的模型清单
 * 6. validateModel()    —— 验证指定模型的 tool use / streaming 能力
 * 7. checkCompatibility() —— 执行 SDK 兼容性检查（5 项检查，启动时强制执行）
 */
export interface PlatformAdapter {
  /** 平台标识 */
  readonly platform: "claude-code" | "cursor-sdk";

  /** 适配器版本 */
  readonly version: string;

  /**
   * 方法 1：执行一次 agent 调用
   *
   * 封装平台特定的 agent 调用逻辑，包括：
   * - 构造请求参数
   * - 调用底层 SDK/CLI
   * - 指数退避重试（最多 3 次）
   * - 错误分类（AUTH / RATE_LIMIT / NETWORK / TRANSPORT / TIMEOUT / UNKNOWN）
   * - 超时控制
   *
   * @param params - Agent 调用参数（模型、prompt、对话历史、phase、信任级别、超时）
   * @returns Agent 调用结果（成功标志、响应内容、工具调用、token 用量、延迟、错误）
   */
  agentCall(params: AgentCallParams): Promise<AgentCallResult>;

  /**
   * 方法 2：注入平台特定的安全护栏
   *
   * 在每次 agent.send() 前调用，动态生成：
   * - .cursor/rules/*.mdc rule 文件（当前 phase 的 globs 作用域约束）
   * - hooks.json（beforeShellExecution + preToolUse matchers）
   *
   * @param phase - 当前工作流阶段
   * @param trustLevel - 信任级别（决定护栏拦截强度）
   */
  injectGuardrails(phase: string, trustLevel: TrustLevel): Promise<void>;

  /**
   * 方法 3：清理平台护栏
   *
   * 在以下时机调用：
   * - 工作流终止时（complete / paused / failed）
   * - phase 切换前（清理上一个 phase 的特定规则）
   * - 只删除 phase 特定规则，保留 global.mdc（alwaysApply: true）
   */
  clearGuardrails(): Promise<void>;

  /**
   * 方法 4：准备跨轮次上下文
   *
   * P0-2 workaround 核心实现。
   * 将 context_summary.md 注入为 conversation_history[0]，
   * 解决 @cursor/sdk Local agent 每轮 send() 后清空上下文的问题。
   *
   * @param state - 当前 LoopState（或 InjectorStateView）
   * @returns 构造好的对话历史数组（context header + 历史摘要）
   */
  prepareContext(state: unknown): ConversationMessage[];

  /**
   * 方法 5：列出平台可用模型
   *
   * 返回当前平台支持的所有模型信息，包括：
   * - 模型 ID、供应商
   * - tool use / streaming 支持状态
   * - 推荐用途（design / implement / verify）
   * - 验证状态
   *
   * @returns 模型信息列表
   */
  listAvailableModels(): Promise<ModelInfo[]>;

  /**
   * 方法 6：验证指定模型
   *
   * 发送轻量级 agent.send() 调用来验证指定模型的：
   * - tool use 支持
   * - streaming 支持
   * - 响应格式兼容性
   *
   * @param modelId - 待验证的模型 ID
   * @returns 模型验证结果（有效标志、能力标志、延迟、错误列表）
   */
  validateModel(modelId: string): Promise<ModelValidationResult>;

  /**
   * 方法 7：执行 SDK 兼容性检查
   *
   * 启动时强制执行 5 项检查：
   * 1. Node.js >= 22
   * 2. @cursor/sdk 可加载
   * 3. SDK 版本精确匹配 1.0.12
   * 4. API Key 有效（发送测试 agent.send() 调用）
   * 5. 响应格式兼容（解析响应对象结构）
   *
   * 结果缓存 24 小时，缓存有效时跳过 CHECK 4-5（省 tokens）。
   *
   * @param forceCheck - 是否强制重新检查（忽略缓存）
   * @returns 兼容性检查结果
   */
  checkCompatibility(forceCheck?: boolean): Promise<CompatibilityCheckResult>;
}
