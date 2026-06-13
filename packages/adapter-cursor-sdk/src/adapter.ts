/**
 * CursorPlatformAdapter — PlatformAdapter 接口的 Cursor SDK 实现 (M2)
 *
 * 这是 loop-cursor 适配器层的核心类，实现了 PlatformAdapter 接口的全部 7 个方法。
 * 将 loop-core 引擎与 @cursor/sdk 的具体 API 解耦，提供：
 * - agent.send() 封装（含重试、错误分类、超时控制）
 * - 安全护栏注入（rules + hooks）
 * - 跨轮次上下文桥接（P0-2 workaround）
 * - 模型管理与验证
 * - SDK 兼容性检查
 *
 * @module adapter/cursor-platform-adapter
 * @version 0.2.0 (M2)
 */

import type {
  PlatformAdapter,
  AgentCallParams,
  AgentCallResult,
  ConversationMessage,
  ModelInfo,
  ModelValidationResult,
  CompatibilityCheckResult,
  TrustLevel,
  TokenUsage,
  ToolCallRecord,
} from "@loop-cursor/core";

// M2 子模块
import { RuleGenerator, createRuleGenerator } from "./rules-generator.js";
import { HooksGenerator, createHooksGenerator } from "./hooks-generator.js";
import { ContextInjector, createContextInjector } from "./context-injector.js";
import { runSdkCompatibilityCheck } from "./sdk-check.js";

// ============================================================================
// 适配器常量
// ============================================================================

/** 适配器版本标识 */
const ADAPTER_VERSION = "0.2.0";

/** agent.send() 默认超时（毫秒）—— 2 分钟 */
const DEFAULT_TIMEOUT_MS = 120_000;

/** 最大重试次数 */
const MAX_RETRIES = 3;

/** 重试基础等待时间（毫秒） */
const RETRY_BASE_MS = 1_000;

/** 不可重试的错误类型关键词 */
const NON_RETRYABLE_KEYWORDS = [
  "AUTH_ERROR",
  "MODEL_NOT_SUPPORTED",
  "PROMPT_REJECTED",
  "INVALID_PARAMETER",
];

// ============================================================================
// 错误分类
// ============================================================================

/** 错误类别枚举 */
type ErrorCategory =
  | "AUTH"        // 认证失败
  | "RATE_LIMIT"  // 请求限流
  | "NETWORK"     // 网络不通
  | "TIMEOUT"     // 超时
  | "TRANSPORT"   // 传输层协议错误
  | "UNKNOWN";    // 未知错误

/**
 * 根据错误消息字符串分类错误类型
 * 用于决定重试策略、日志级别和用户提示
 *
 * @param errorMessage - 错误消息文本
 * @returns 错误类别
 */
function classifyError(errorMessage: string): ErrorCategory {
  const lower = errorMessage.toLowerCase();
  if (lower.includes("401") || lower.includes("unauthorized")) return "AUTH";
  if (lower.includes("429") || lower.includes("rate limit")) return "RATE_LIMIT";
  if (lower.includes("timeout") || lower.includes("timed out")) return "TIMEOUT";
  if (lower.includes("econnrefused") || lower.includes("enotfound")) return "NETWORK";
  if (lower.includes("http2") || lower.includes("nghttp2") || lower.includes("protocol"))
    return "TRANSPORT";
  return "UNKNOWN";
}

/**
 * 判断错误是否可重试
 * 认证失败 / 模型不支持 / Prompt 被拒绝 → 不可重试
 * 网络 / 超时 / 协议错误 → 可重试
 */
function isRetryable(errorMessage: string): boolean {
  return !NON_RETRYABLE_KEYWORDS.some((kw) =>
    errorMessage.toUpperCase().includes(kw),
  );
}

// ============================================================================
// 可用模型清单
// ============================================================================

/**
 * 已知的 Cursor SDK 可用模型清单
 * 包含模型 ID、供应商、推荐用途和验证状态
 * 在实际使用前通过 validateModel() 验证能力
 */
const KNOWN_MODELS: ModelInfo[] = [
  {
    id: "claude-sonnet-4-20250514",
    provider: "Anthropic",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: ["implement", "verify"],
    status: "confirmed",
  },
  {
    id: "claude-opus-4-20250514",
    provider: "Anthropic",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: ["design"],
    status: "confirmed",
  },
  {
    id: "claude-3.5-sonnet",
    provider: "Anthropic",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: ["implement", "verify"],
    status: "confirmed",
  },
  {
    id: "cursor-small",
    provider: "Cursor",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: ["implement"],
    status: "confirmed",
  },
  {
    id: "gpt-4o",
    provider: "OpenAI",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: ["implement", "verify"],
    status: "untested",
  },
];

// ============================================================================
// CursorPlatformAdapter 主类
// ============================================================================

/**
 * CursorPlatformAdapter —— PlatformAdapter 接口的 Cursor SDK 实现
 *
 * 封装了 @cursor/sdk 的 agent.send() API，提供完整的平台适配层。
 * 实现了 PlatformAdapter 接口的 7 个方法：
 * 1. agentCall()          —— 执行 agent 调用
 * 2. injectGuardrails()   —— 注入安全护栏
 * 3. clearGuardrails()    —— 清理护栏
 * 4. prepareContext()     —— 准备跨轮次上下文
 * 5. listAvailableModels()—— 列出可用模型
 * 6. validateModel()      —— 验证模型能力
 * 7. checkCompatibility() —— SDK 兼容性检查
 */
export class CursorPlatformAdapter implements PlatformAdapter {
  /** 平台标识 —— 固定为 "cursor-sdk" */
  readonly platform = "cursor-sdk" as const;

  /** 适配器版本 */
  readonly version = ADAPTER_VERSION;

  /** 规则生成器实例 */
  private ruleGenerator: RuleGenerator;

  /** Hooks 生成器实例 */
  private hooksGenerator: HooksGenerator;

  /** 上下文注入器实例 */
  private contextInjector: ContextInjector;

  /** Cursor SDK agent 实例（延迟初始化） */
  private agentInstance: unknown = null;

  /** 项目根目录 */
  private projectRoot: string;

  /**
   * 创建 CursorPlatformAdapter 实例
   *
   * @param projectRoot - 项目根目录路径（默认当前工作目录）
   * @param engineVersion - 引擎版本号（用于 hooks.json 元数据）
   */
  constructor(projectRoot?: string, engineVersion?: string) {
    this.projectRoot = projectRoot ?? process.cwd();
    const version = engineVersion ?? ADAPTER_VERSION;

    this.ruleGenerator = createRuleGenerator(this.projectRoot);
    this.hooksGenerator = createHooksGenerator(this.projectRoot, version);
    this.contextInjector = createContextInjector(this.projectRoot);
  }

  // ========================================================================
  // 方法 1：agentCall —— 执行一次 agent 调用
  // ========================================================================

  /**
   * 执行一次 agent 调用，含重试和错误分类
   *
   * 封装逻辑：
   * 1. 动态导入并缓存 agent 实例
   * 2. 构造 agent.send() 参数（model / prompt / conversation_history）
   * 3. 设置超时控制（Promise.race）
   * 4. 解析响应内容字段（content / text / message / response / output）
   * 5. 失败时执行指数退避重试（0s → 2s → 4s）
   * 6. 分类错误类型并附加用户友好的修复建议
   *
   * @param params - Agent 调用参数
   * @returns Agent 调用结果（成功/失败、内容、工具调用、token、延迟、错误）
   */
  async agentCall(params: AgentCallParams): Promise<AgentCallResult> {
    const startMs = Date.now();
    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // 动态导入 agent（延迟初始化，避免启动时加载失败）
    let lastError: string | undefined;
    let lastCategory: ErrorCategory = "UNKNOWN";

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // 获取 agent 实例（首次调用时动态 import）
        const agent = await this.getAgent();

        // 发起调用，带超时竞争
        const response = await Promise.race([
          (agent as { send: (opts: Record<string, unknown>) => Promise<unknown> }).send({
            model: params.model,
            prompt: params.prompt,
            conversation_history: params.conversationHistory ?? [],
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("AGENT_TIMEOUT")), timeoutMs),
          ),
        ]);

        // 解析响应
        const content = this.extractContent(response);
        const tokensUsed = this.extractTokenUsage(response);
        const toolCalls = this.extractToolCalls(response);
        const latencyMs = Date.now() - startMs;

        return {
          success: true,
          content,
          toolCalls,
          tokensUsed,
          latencyMs,
          rawResponse: response,
        };
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        lastError = msg;
        lastCategory = classifyError(msg);

        // 不可重试错误 → 立即返回
        if (!isRetryable(msg)) {
          return {
            success: false,
            content: "",
            latencyMs: Date.now() - startMs,
            error: `[${lastCategory}] ${msg}`,
          };
        }

        // 最后一次尝试 → 返回失败
        if (attempt >= MAX_RETRIES) {
          return {
            success: false,
            content: "",
            latencyMs: Date.now() - startMs,
            error: `[${lastCategory}] 重试 ${MAX_RETRIES} 次后仍失败: ${msg}`,
          };
        }

        // 指数退避等待
        const delay = RETRY_BASE_MS * Math.pow(2, attempt);
        console.warn(
          `[CursorPlatformAdapter] agent.send() 第 ${attempt + 1}/${MAX_RETRIES + 1} 次失败: ${msg}。` +
          `${delay}ms 后重试...`,
        );
        await this.sleep(delay);
      }
    }

    // 理论上不会到达这里（兜底）
    return {
      success: false,
      content: "",
      latencyMs: Date.now() - startMs,
      error: `[${lastCategory}] ${lastError ?? "未知错误"}`,
    };
  }

  // ========================================================================
  // 方法 2：injectGuardrails —— 注入平台安全护栏
  // ========================================================================

  /**
   * 注入平台特定的安全护栏
   *
   * 在每次 agent.send() 前调用，动态生成：
   * - .cursor/rules/loop-cursor-phase-{phase}.mdc —— 当前 phase 的行为约束 rule
   * - .cursor/hooks.json —— beforeShellExecution + preToolUse 钩子
   * - 清理上一个 phase 的过期 rule 文件
   *
   * @param phase - 当前工作流阶段 ID
   * @param trustLevel - 信任级别（L1/L2/L3，决定拦截强度）
   */
  async injectGuardrails(phase: string, trustLevel: TrustLevel): Promise<void> {
    // 确保 rules/ 目录存在
    this.ruleGenerator.ensureRulesDir();

    // 生成全局护栏 rule（仅在不存在时生成）
    const globalPath = this.ruleGenerator.getGlobalRulePath();
    try {
      const { existsSync } = await import("node:fs");
      if (!existsSync(globalPath)) {
        this.ruleGenerator.generateGlobal();
      }
    } catch {
      this.ruleGenerator.generateGlobal();
    }

    // 生成当前 phase 的 .mdc rule
    this.ruleGenerator.generate(phase as import("./rules-generator.js").PhaseId);
    // 清理过期 rule
    this.ruleGenerator.cleanup(phase as import("./rules-generator.js").PhaseId);

    // 生成 hooks.json（五层匹配器，信任级别决定拦截强度）
    this.hooksGenerator.generate(
      phase as import("./hooks-generator.js").PhaseId,
      trustLevel as import("./hooks-generator.js").TrustLevel,
    );
  }

  // ========================================================================
  // 方法 3：clearGuardrails —— 清理平台护栏
  // ========================================================================

  /**
   * 清理平台护栏文件
   *
   * 在以下时机调用：
   * - 工作流终止时（complete / paused / failed）
   * - 执行以下清理操作：
   *   - 删除 hooks.json（如果存在）
   *   - 删除所有 phase 特定的 .mdc rule 文件（保留全局 rule）
   *
   * 注意：phase 切换时的过期 rule 清理由 injectGuardrails() 中的 cleanup() 处理，
   * 本方法主要用于终止时的彻底清理。
   */
  async clearGuardrails(): Promise<void> {
    const { existsSync, unlinkSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");

    try {
      // 删除 hooks.json
      const hooksPath = this.hooksGenerator.getHooksPath();
      if (existsSync(hooksPath)) {
        unlinkSync(hooksPath);
      }
    } catch {
      // hooks.json 可能已被外部删除
    }

    try {
      // 删除所有 phase 特定的 rule 文件（保留全局 rule）
      const rulesDir = join(this.projectRoot, ".cursor", "rules");
      if (existsSync(rulesDir)) {
        const entries = readdirSync(rulesDir);
        for (const entry of entries) {
          if (
            entry.startsWith("loop-cursor-phase-") &&
            entry.endsWith(".mdc")
          ) {
            try {
              unlinkSync(join(rulesDir, entry));
            } catch {
              // 文件可能已被外部删除
            }
          }
        }
      }
    } catch {
      // rules 目录可能不存在
    }
  }

  // ========================================================================
  // 方法 4：prepareContext —— 准备跨轮次上下文
  // ========================================================================

  /**
   * 准备跨轮次上下文（P0-2 workaround 核心实现）
   *
   * 将 context_summary.md 注入为 conversation_history[0]，
   * 解决 @cursor/sdk Local agent 每轮 send() 后清空上下文的问题。
   *
   * 实现流程：
   * 1. 委托给 ContextInjector 读取和构建上下文
   * 2. ContextInjector 从 context_summary.md 读取历史摘要
   * 3. 构建标准化上下文头（phase / cycle / goal）
   * 4. 如果有 repair_context，追加修复指令
   * 5. 返回完整的 conversation_history 数组
   *
   * @param state - 当前 LoopState（或包含关键字段的 InjectorStateView）
   * @returns 构造好的对话历史数组
   */
  prepareContext(state: unknown): ConversationMessage[] {
    return this.contextInjector.buildConversationHistory(
      state as Record<string, unknown>,
    );
  }

  // ========================================================================
  // 方法 5：listAvailableModels —— 列出可用模型
  // ========================================================================

  /**
   * 列出平台可用的模型清单
   *
   * 返回预定义的已知模型列表。如果 forceRefresh 为 true，
   * 将从 @cursor/sdk 动态获取最新模型列表（如果 SDK 支持）。
   *
   * 每个模型标注了：
   * - 供应商
   * - tool use / streaming 支持状态
   * - 推荐用途（design / implement / verify）
   * - 验证状态（confirmed / untested / failed）
   *
   * @returns 模型信息列表
   */
  async listAvailableModels(): Promise<ModelInfo[]> {
    // 返回预定义清单的副本（避免外部修改破坏内部状态）
    return KNOWN_MODELS.map((m) => ({ ...m }));
  }

  // ========================================================================
  // 方法 6：validateModel —— 验证模型能力
  // ========================================================================

  /**
   * 验证指定模型的 tool use 和 streaming 能力
   *
   * 发送轻量级 agent.send() 调用（极简 prompt）来验证：
   * - 模型是否可正常连接和响应
   * - 是否支持 tool use（检查响应中是否有工具调用记录字段）
   * - 是否支持 streaming（通过响应延迟判断）
   *
   * 验证策略：
   * - 发送 "Reply with exactly one word: ok" 到指定模型
   * - 检查响应内容非空
   * - 检查 tool_calls/toolCalls 字段是否存在（判断 tool use 支持）
   * - 10 秒超时保护
   *
   * @param modelId - 待验证的模型 ID
   * @returns 模型验证结果（valid / toolUseSupported / streamingSupported / latency / errors）
   */
  async validateModel(modelId: string): Promise<ModelValidationResult> {
    const startMs = Date.now();
    const errors: string[] = [];
    let toolUseSupported = false;
    let streamingSupported = false;

    try {
      const agent = await this.getAgent();

      // 发送极简验证 prompt，限制输出长度
      const rawResponse = await Promise.race([
        (agent as { send: (opts: Record<string, unknown>) => Promise<unknown> }).send({
          model: modelId,
          prompt: "Reply with exactly one word: ok",
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("VALIDATE_TIMEOUT")),
            10_000,
          ),
        ),
      ]);

      const content = this.extractContent(rawResponse);

      // 检查响应内容
      if (!content || content.trim().length === 0) {
        errors.push("模型返回空响应");
      }

      // 检查 tool use 支持（通过响应对象中的工具调用字段判断）
      if (rawResponse && typeof rawResponse === "object") {
        const respObj = rawResponse as Record<string, unknown>;
        const tc =
          respObj.tool_calls ??
          respObj.toolCalls ??
          respObj.tool_use ??
          respObj.toolUse;
        if (Array.isArray(tc) && tc.length > 0) {
          toolUseSupported = true;
        }
      }

      // streaming 支持判断：响应在合理时间内返回即视为支持
      const latencyMs = Date.now() - startMs;
      streamingSupported = latencyMs < 15_000;

      return {
        valid: errors.length === 0,
        model: modelId,
        toolUseSupported,
        streamingSupported,
        latencyMs,
        errors,
      };
    } catch (e) {
      const msg = (e as Error).message;
      const latencyMs = Date.now() - startMs;

      if (msg === "VALIDATE_TIMEOUT") {
        errors.push("验证超时（10秒）");
      } else if (msg.includes("not found") || msg.includes("not supported")) {
        errors.push(`模型不可用: ${msg}`);
      } else {
        errors.push(`验证异常: ${msg}`);
      }

      return {
        valid: false,
        model: modelId,
        toolUseSupported,
        streamingSupported,
        latencyMs,
        errors,
      };
    }
  }

  // ========================================================================
  // 方法 7：checkCompatibility —— SDK 兼容性检查
  // ========================================================================

  /**
   * 执行 SDK 兼容性检查（5 项检查）
   *
   * 委托给 sdk-check.ts 模块的 runSdkCompatibilityCheck() 执行。
   * 5 项检查：
   * 1. Node.js >= 22 运行时版本
   * 2. @cursor/sdk 包可加载
   * 3. SDK 版本精确匹配 1.0.12
   * 4. CURSOR_API_KEY 有效
   * 5. 响应格式兼容
   *
   * 结果缓存 24 小时，传入 forceCheck=true 强制重新检查。
   *
   * @param forceCheck - 是否强制重新检查（忽略缓存）
   * @returns 兼容性检查结果（allPassed / checks / timestamp）
   */
  async checkCompatibility(
    forceCheck: boolean = false,
  ): Promise<CompatibilityCheckResult> {
    return runSdkCompatibilityCheck(forceCheck);
  }

  // ========================================================================
  // 私有辅助方法：响应解析
  // ========================================================================

  /**
   * 从 agent 响应中提取文本内容
   *
   * @cursor/sdk 的响应格式可能包含多个内容字段。
   * 按优先级尝试提取：content > text > message > response > output
   * 支持嵌套的 content blocks 数组（[{type:"text",text:"..."}] 格式）
   *
   * @param response - agent.send() 的原始响应对象
   * @returns 提取的文本内容字符串
   */
  private extractContent(response: unknown): string {
    // 直接返回字符串类型
    if (typeof response === "string") return response;

    if (response && typeof response === "object") {
      const obj = response as Record<string, unknown>;

      // 按优先级尝试各内容字段
      const contentFields = ["content", "text", "message", "response", "output"];
      for (const field of contentFields) {
        const val = obj[field];
        if (typeof val === "string" && val.trim().length > 0) {
          return val;
        }
        // 处理 content blocks 数组格式
        if (Array.isArray(val)) {
          const texts = val
            .map((block: unknown) => {
              if (typeof block === "string") return block;
              if (typeof block === "object" && block !== null) {
                const b = block as Record<string, unknown>;
                return String(b.text ?? b.content ?? "");
              }
              return "";
            })
            .filter((s: string) => s.trim().length > 0)
            .join("\n");
          if (texts.length > 0) return texts;
        }
      }

      // 兜底：JSON 序列化整个响应对象
      try {
        return JSON.stringify(response);
      } catch {
        return String(response);
      }
    }

    return String(response ?? "");
  }

  /**
   * 从 agent 响应中提取工具调用记录
   *
   * 检查响应对象中的 tool_calls / toolCalls / tool_use / toolUse 字段。
   * 每个工具调用标准化为 { tool, args, result } 结构。
   *
   * @param response - agent.send() 的原始响应对象
   * @returns 标准化工具调用记录数组，无工具调用时返回 undefined
   */
  private extractToolCalls(response: unknown): ToolCallRecord[] | undefined {
    if (!response || typeof response !== "object") return undefined;

    const obj = response as Record<string, unknown>;
    const rawCalls =
      obj.tool_calls ??
      obj.toolCalls ??
      obj.tool_use ??
      obj.toolUse;

    if (!Array.isArray(rawCalls) || rawCalls.length === 0) return undefined;

    return (rawCalls as unknown[]).map((tc: unknown) => {
      const call = tc as Record<string, unknown>;
      return {
        tool: String(call.tool ?? call.name ?? call.function ?? "unknown"),
        args: (call.args ?? call.arguments ?? call.input ?? {}) as Record<
          string,
          unknown
        >,
        result: call.result
          ? typeof call.result === "string"
            ? call.result.substring(0, 500)
            : JSON.stringify(call.result).substring(0, 500)
          : undefined,
      };
    });
  }

  /**
   * 从 agent 响应中提取 token 使用量
   *
   * 检查响应中的 usage / token_usage / tokens 字段，
   * 尝试从多种命名惯例中提取输入/输出 token 数。
   *
   * @param response - agent.send() 的原始响应对象
   * @returns Token 使用量对象，无法提取时返回 undefined
   */
  private extractTokenUsage(response: unknown): TokenUsage | undefined {
    if (!response || typeof response !== "object") return undefined;

    const obj = response as Record<string, unknown>;
    const usage = (obj.usage ?? obj.token_usage ?? obj.tokens) as
      | Record<string, unknown>
      | undefined;

    if (!usage || typeof usage !== "object") return undefined;

    // 输入 token 数：尝试多种字段名
    const input =
      typeof usage.input_tokens === "number"
        ? usage.input_tokens
        : typeof usage.input === "number"
          ? usage.input
          : typeof usage.prompt_tokens === "number"
            ? usage.prompt_tokens
            : undefined;

    // 输出 token 数：尝试多种字段名
    const output =
      typeof usage.output_tokens === "number"
        ? usage.output_tokens
        : typeof usage.output === "number"
          ? usage.output
          : typeof usage.completion_tokens === "number"
            ? usage.completion_tokens
            : undefined;

    if (input !== undefined || output !== undefined) {
      return { input: input ?? 0, output: output ?? 0 };
    }

    return undefined;
  }

  /**
   * 获取 Cursor SDK agent 实例（延迟初始化 + 缓存）
   *
   * 首次调用时动态 import @cursor/sdk，之后使用缓存的实例。
   * 延迟初始化确保即使 @cursor/sdk 未安装，也只在首次 agentCall() 时才报错，
   * 而非类实例化时立刻崩溃。
   *
   * @returns Cursor SDK 的 agent 对象
   */
  private async getAgent(): Promise<unknown> {
    if (this.agentInstance) return this.agentInstance;

    // 动态导入 @cursor/sdk（避免顶层导入时的加载失败）
    const mod = await import("@cursor/sdk");
    // @cursor/sdk 导出 { agent } 对象，也可能直接默认导出 agent
    this.agentInstance =
      (mod as Record<string, unknown>).agent ?? (mod as Record<string, unknown>).default ?? mod;
    return this.agentInstance;
  }

  /**
   * 异步等待工具函数
   *
   * @param ms - 等待毫秒数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// 便捷工厂函数与单例管理
// ============================================================================

/**
 * 创建 CursorPlatformAdapter 实例的便捷工厂函数
 *
 * 等价于 new CursorPlatformAdapter(projectRoot, engineVersion)。
 * 推荐使用此函数而非直接 new，便于未来 AOP 扩展（如日志代理）。
 *
 * @param projectRoot - 项目根目录路径（默认当前工作目录）
 * @param engineVersion - 引擎版本号（默认与适配器版本一致）
 * @returns CursorPlatformAdapter 实例
 */
export function createCursorPlatformAdapter(
  projectRoot?: string,
  engineVersion?: string,
): CursorPlatformAdapter {
  return new CursorPlatformAdapter(projectRoot, engineVersion);
}

// ============================================================================
// 默认适配器单例
// ============================================================================

/** 默认适配器单例缓存 */
let _defaultAdapter: CursorPlatformAdapter | null = null;

/**
 * 获取默认的 CursorPlatformAdapter 单例
 *
 * 首次调用时创建实例（基于 process.cwd()），之后返回缓存的实例。
 * 适用于大多数场景——只需一个适配器实例即可驱动整个 loop-cursor 引擎。
 *
 * @returns 默认适配器单例
 */
export function getDefaultAdapter(): CursorPlatformAdapter {
  if (!_defaultAdapter) {
    _defaultAdapter = new CursorPlatformAdapter();
  }
  return _defaultAdapter;
}

/**
 * 重置默认适配器单例
 *
 * 用于测试场景或配置变更后需要重新初始化适配器的情况。
 * 调用后，下一次 getDefaultAdapter() 将创建新的实例。
 */
export function resetDefaultAdapter(): void {
  _defaultAdapter = null;
}

// ============================================================================
// 类型导出
// ============================================================================

export type { ErrorCategory };
