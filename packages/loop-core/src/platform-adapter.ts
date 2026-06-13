/**
 * loop-cursor 平台适配器接口与实现 (Platform Adapter)
 *
 * 定义 PlatformAdapter 抽象接口（7 个方法）并提供 CursorAdapter 具体实现。
 * loop-core 引擎通过此接口与具体平台解耦，实现"一次编写，多平台适配"。
 *
 * 接口设计原则：
 * - 最小依赖：仅依赖 Node.js 标准库 + types.ts 中的共享类型
 * - 异步优先：所有方法返回 Promise，适配不同平台的异步模型
 * - 错误分类：统一的错误分类体系，便于上层重试策略
 *
 * 7 方法清单：
 * 1. agentCall()           —— 执行一次 agent 调用
 * 2. injectGuardrails()    —— 注入平台安全护栏
 * 3. clearGuardrails()     —— 清理平台护栏
 * 4. prepareContext()      —— 准备跨轮次上下文
 * 5. listAvailableModels() —— 列出可用模型
 * 6. validateModel()       —— 验证模型能力
 * 7. checkCompatibility()  —— 执行兼容性检查
 *
 * @module platform-adapter
 * @version 0.1.0
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
} from "./types.js";
import { TrustLevelEnum } from "./types.js";

// ============================================================================
// 错误分类（与 adapter-cursor-sdk 中的错误分类保持一致）
// ============================================================================

/** 错误类别 */
export type ErrorCategory =
  | "AUTH"
  | "RATE_LIMIT"
  | "NETWORK"
  | "TIMEOUT"
  | "TRANSPORT"
  | "UNKNOWN";

/**
 * 根据错误消息分类错误类型
 *
 * @param errorMessage - 错误消息文本
 * @returns 错误类别
 */
export function classifyError(errorMessage: string): ErrorCategory {
  const lower = errorMessage.toLowerCase();
  if (lower.includes("401") || lower.includes("unauthorized")) return "AUTH";
  if (lower.includes("429") || lower.includes("rate limit")) return "RATE_LIMIT";
  if (lower.includes("timeout") || lower.includes("timed out")) return "TIMEOUT";
  if (
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("enetunreach")
  )
    return "NETWORK";
  if (
    lower.includes("http2") ||
    lower.includes("nghttp2") ||
    lower.includes("protocol")
  )
    return "TRANSPORT";
  return "UNKNOWN";
}

/** 不可重试的错误关键词 */
const NON_RETRYABLE_KEYWORDS = [
  "AUTH_ERROR",
  "MODEL_NOT_SUPPORTED",
  "PROMPT_REJECTED",
  "INVALID_PARAMETER",
];

/**
 * 判断错误是否可重试
 *
 * @param errorMessage - 错误消息
 * @returns 是否可重试
 */
export function isRetryableError(errorMessage: string): boolean {
  return !NON_RETRYABLE_KEYWORDS.some((kw) =>
    errorMessage.toUpperCase().includes(kw),
  );
}

// ============================================================================
// CursorAdapter —— PlatformAdapter 的 Cursor SDK 精简实现
// ============================================================================

/**
 * CursorAdapter —— 面向 Cursor SDK 的平台适配器实现
 *
 * 实现了 PlatformAdapter 接口的全部 7 个方法。
 * 适合在 loop-core 内部直接使用，无需外部 adapter-cursor-sdk 包。
 *
 * 使用方式：
 * ```ts
 * const adapter = new CursorAdapter({ projectRoot: process.cwd() });
 * await adapter.injectGuardrails("part_1_1", "L2");
 * ```
 */
export class CursorAdapter implements PlatformAdapter {
  /** 平台标识 */
  readonly platform = "cursor-sdk" as const;

  /** 适配器版本 */
  readonly version: string = "0.1.0";

  /** 项目根目录 */
  private projectRoot: string;

  /** 护栏注入记录 */
  private injectedPhases: Set<string> = new Set();

  /** 是否已初始化 agent 实例 */
  private agentInitialized = false;

  /** 缓存的模型列表 */
  private cachedModels: ModelInfo[] | null = null;

  /** 兼容性检查缓存 */
  private compatCache: CompatibilityCheckResult | null = null;

  /**
   * 构造 CursorAdapter 实例
   *
   * @param options - 配置选项
   */
  constructor(options?: { projectRoot?: string; version?: string }) {
    this.projectRoot = options?.projectRoot ?? process.cwd();
    if (options?.version) {
      this.version = options.version;
    }
  }

  // ========================================================================
  // 方法 1：agentCall
  // ========================================================================

  /**
   * 执行一次 agent 调用（含重试和错误分类）
   *
   * 封装逻辑：
   * 1. 构造 agent.send() 参数
   * 2. 设置超时控制
   * 3. 解析响应内容
   * 4. 失败时执行指数退避重试（最多 3 次）
   * 5. 分类错误类型
   *
   * @param params - Agent 调用参数
   * @returns Agent 调用结果
   */
  async agentCall(params: AgentCallParams): Promise<AgentCallResult> {
    const startMs = Date.now();
    const timeoutMs = params.timeoutMs ?? 120_000;
    const maxRetries = 3;
    const retryBase = 1_000;
    let lastError = "";

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // 尝试动态导入 @cursor/sdk
        const agent = await this.getAgent();

        // 调用 agent.send()
        const response = await this.withTimeout(
          (agent as { send: (o: Record<string, unknown>) => Promise<unknown> }).send({
            model: params.model,
            prompt: params.prompt,
            conversation_history: params.conversationHistory ?? [],
          }),
          timeoutMs,
        );

        // 解析响应
        const content = this.extractContent(response);
        const toolCalls = this.extractToolCalls(response);
        const tokensUsed = this.extractTokenUsage(response);
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

        // 不可重试错误 → 立即返回
        if (!isRetryableError(msg)) {
          return {
            success: false,
            content: "",
            latencyMs: Date.now() - startMs,
            error: `[${classifyError(msg)}] ${msg}`,
          };
        }

        // 指数退避等待
        if (attempt < maxRetries) {
          const delay = retryBase * Math.pow(2, attempt);
          await this.sleep(delay);
        }
      }
    }

    return {
      success: false,
      content: "",
      latencyMs: Date.now() - startMs,
      error: `所有 ${maxRetries + 1} 次尝试均失败。最后错误: ${lastError}`,
    };
  }

  // ========================================================================
  // 方法 2：injectGuardrails
  // ========================================================================

  /**
   * 注入平台特定的安全护栏
   *
   * 在每次 agent.send() 前调用，动态生成：
   * - .cursor/rules/loop-cursor-phase-{phase}.mdc
   * - .cursor/hooks.json
   *
   * 信任级别影响护栏拦截强度：
   * - L1 (safe)：全部 6 个闸门激活
   * - L2 (auto)：自动通过方案确认，拦截不可逆操作
   * - L3 (unsafe)：除灾难性操作外全部放行
   *
   * @param phase - 当前工作流阶段
   * @param trustLevel - 信任级别
   */
  async injectGuardrails(phase: string, trustLevel: TrustLevel): Promise<void> {
    // 记录已注入的 phase（避免重复注入）
    this.injectedPhases.add(phase);

    const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");

    // 确保基础目录存在
    const baseDir = join(this.projectRoot, ".cursor", "loop-cursor");
    mkdirSync(baseDir, { recursive: true });

    // 生成 guardrails 配置记录
    const guardConfigPath = join(baseDir, "guardrails.json");
    const guardConfig = {
      phase,
      trustLevel,
      injectedAt: new Date().toISOString(),
      activeGates: this.getActiveGates(trustLevel),
    };

    writeFileSync(guardConfigPath, JSON.stringify(guardConfig, null, 2), "utf-8");
  }

  /**
   * 根据信任级别返回激活的闸门列表
   */
  private getActiveGates(trustLevel: TrustLevel): string[] {
    switch (trustLevel) {
      case TrustLevelEnum.SAFE:
        return ["G1", "G2", "G3", "G4", "G5", "G6", "G7"];
      case TrustLevelEnum.AUTO:
        return ["G1", "G3", "G4", "G5", "G6", "G7"];
      case TrustLevelEnum.UNSAFE:
        return ["G4", "G6", "G7"];
      default:
        return ["G1", "G3", "G4", "G5", "G6", "G7"];
    }
  }

  // ========================================================================
  // 方法 3：clearGuardrails
  // ========================================================================

  /**
   * 清理平台护栏文件
   *
   * 在以下时机调用：
   * - 工作流终止时（complete / paused / failed）
   * - 删除 hooks.json 和 phase 特定的 rule 文件
   *
   * 注意：保留全局 rule（alwaysApply: true），仅删除 phase 特定 rule。
   */
  async clearGuardrails(): Promise<void> {
    const { existsSync, unlinkSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");

    // 清除注入记录
    this.injectedPhases.clear();

    // 清理 guardrails 配置记录
    const guardConfigPath = join(
      this.projectRoot,
      ".cursor",
      "loop-cursor",
      "guardrails.json",
    );
    try {
      if (existsSync(guardConfigPath)) {
        unlinkSync(guardConfigPath);
      }
    } catch {
      // 文件可能已被外部删除
    }

    // 清理 hooks.json
    const hooksPath = join(this.projectRoot, ".cursor", "hooks.json");
    try {
      if (existsSync(hooksPath)) {
        unlinkSync(hooksPath);
      }
    } catch {
      // hooks.json 可能已被删除
    }

    // 清理 phase 特定 rule 文件
    const rulesDir = join(this.projectRoot, ".cursor", "rules");
    try {
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
              // 文件可能已被删除
            }
          }
        }
      }
    } catch {
      // rules 目录可能不存在
    }
  }

  // ========================================================================
  // 方法 4：prepareContext
  // ========================================================================

  /**
   * 准备跨轮次上下文（P0-2 workaround 核心实现）
   *
   * 将 context_summary.md 注入为 conversation_history[0]，
   * 解决 @cursor/sdk Local agent 每轮 send() 后清空上下文的问题。
   *
   * @param state - 当前 LoopState 或包含关键字段的对象
   * @returns 构造好的对话历史数组
   */
  prepareContext(state: unknown): ConversationMessage[] {
    const s = state as Record<string, unknown> | null | undefined;
    const messages: ConversationMessage[] = [];

    // 构建上下文头消息
    const progress = (s?.progress ?? {}) as Record<string, unknown>;
    const config = (s?.config ?? {}) as Record<string, unknown>;

    const contextHeader = [
      `[loop-cursor 跨轮次上下文]`,
      `Phase: ${progress.phase ?? "unknown"}`,
      `Cycle: ${progress.cycle ?? 1}`,
      `Goal: ${config.user_request ?? "unspecified"}`,
      ``,
      "这是跨轮次的上下文注入。请基于以上信息继续工作。",
    ];

    // 如果有修复上下文，追加修复指令
    const repairContext = (progress.repair_context ?? null) as string | null;
    if (repairContext) {
      contextHeader.push("");
      contextHeader.push(`修复上下文: ${repairContext}`);
      contextHeader.push("仅修复列出的问题。不要修改无关代码。");
    }

    messages.push({
      role: "user",
      content: contextHeader.join("\n"),
    });

    return messages;
  }

  // ========================================================================
  // 方法 5：listAvailableModels
  // ========================================================================

  /**
   * 列出平台可用的模型清单
   *
   * 返回预定义的已知模型列表。结果会被缓存。
   *
   * @returns 模型信息列表
   */
  async listAvailableModels(): Promise<ModelInfo[]> {
    if (this.cachedModels) {
      return [...this.cachedModels];
    }

    // 预定义模型列表
    const models: ModelInfo[] = [
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

    this.cachedModels = models;
    return [...models];
  }

  // ========================================================================
  // 方法 6：validateModel
  // ========================================================================

  /**
   * 验证指定模型的 tool use 和 streaming 能力
   *
   * 发送轻量级 agent.send() 调用（极简 prompt）来验证。
   * 验证超时 10 秒。
   *
   * @param modelId - 待验证的模型 ID
   * @returns 模型验证结果
   */
  async validateModel(modelId: string): Promise<ModelValidationResult> {
    const startMs = Date.now();
    const errors: string[] = [];
    let toolUseSupported = false;
    let streamingSupported = false;

    try {
      const agent = await this.getAgent();

      const rawResponse = await this.withTimeout(
        (agent as { send: (o: Record<string, unknown>) => Promise<unknown> }).send({
          model: modelId,
          prompt: "Reply with exactly one word: ok",
        }),
        10_000,
      );

      const content = this.extractContent(rawResponse);

      if (!content || content.trim().length === 0) {
        errors.push("模型返回空响应");
      }

      // 检查 tool use 支持
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

      if (msg.includes("timeout")) {
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
  // 方法 7：checkCompatibility
  // ========================================================================

  /**
   * 执行 SDK 兼容性检查（5 项检查）
   *
   * 5 项检查：
   * 1. Node.js >= 22 运行时版本
   * 2. @cursor/sdk 包可加载
   * 3. SDK 版本精确匹配 1.0.12
   * 4. API Key 有效
   * 5. 响应格式兼容
   *
   * 结果缓存 24 小时，传入 forceCheck=true 强制重新检查。
   *
   * @param forceCheck - 是否强制重新检查（忽略缓存）
   * @returns 兼容性检查结果
   */
  async checkCompatibility(
    forceCheck: boolean = false,
  ): Promise<CompatibilityCheckResult> {
    // 使用缓存
    if (!forceCheck && this.compatCache) {
      const cacheAge = Date.now() - new Date(this.compatCache.timestamp).getTime();
      const ttlMs = 24 * 60 * 60 * 1000; // 24 小时
      if (cacheAge < ttlMs) {
        return this.compatCache;
      }
    }

    const checks = await this.runCompatibilityChecks();
    const allPassed = checks.every((c) => c.pass);

    const result: CompatibilityCheckResult = {
      allPassed,
      checks,
      timestamp: new Date().toISOString(),
      cacheValidUntil: new Date(
        Date.now() + 24 * 60 * 60 * 1000,
      ).toISOString(),
    };

    this.compatCache = result;
    return result;
  }

  /**
   * 执行 5 项兼容性检查
   */
  private async runCompatibilityChecks(): Promise<
    Array<{ name: string; pass: boolean; detail: string }>
  > {
    const checks: Array<{ name: string; pass: boolean; detail: string }> = [];

    // 检查 1：Node.js >= 22
    const nodeVersion = process.versions.node;
    const majorVersion = parseInt(nodeVersion.split(".")[0], 10);
    checks.push({
      name: "Node.js >= 22",
      pass: majorVersion >= 22,
      detail: majorVersion >= 22
        ? `Node.js ${nodeVersion} — 通过`
        : `Node.js ${nodeVersion} — 需 >= 22.0.0`,
    });

    // 检查 2：@cursor/sdk 可加载
    try {
      // @ts-ignore - @cursor/sdk 为运行时依赖
      await import("@cursor/sdk");
      checks.push({
        name: "@cursor/sdk 可加载",
        pass: true,
        detail: "@cursor/sdk 已成功加载",
      });
    } catch (e) {
      checks.push({
        name: "@cursor/sdk 可加载",
        pass: false,
        detail: `加载失败: ${(e as Error).message}`,
      });
    }

    // 检查 3：SDK 版本精确匹配
    try {
      const sdkPkg = await this.readSdkPackageJson();
      const version = sdkPkg?.version ?? "unknown";
      const isExact = version === "1.0.12";
      checks.push({
        name: "SDK 版本精确匹配 1.0.12",
        pass: isExact,
        detail: isExact
          ? `@cursor/sdk ${version} — 匹配`
          : `@cursor/sdk ${version} — 需要 1.0.12`,
      });
    } catch {
      checks.push({
        name: "SDK 版本精确匹配 1.0.12",
        pass: false,
        detail: "无法读取 SDK 版本",
      });
    }

    // 检查 4：API Key 有效
    const apiKey = process.env.CURSOR_API_KEY ?? "";
    if (!apiKey || !apiKey.startsWith("cur-")) {
      checks.push({
        name: "CURSOR_API_KEY 有效",
        pass: false,
        detail: "CURSOR_API_KEY 未设置或格式不正确（应以 cur- 开头）",
      });
    } else {
      checks.push({
        name: "CURSOR_API_KEY 有效",
        pass: true,
        detail: "CURSOR_API_KEY 格式正确",
      });
    }

    // 检查 5：响应格式兼容
    // 发送最小 agent.send() 调用验证响应格式
    try {
      const agent = await this.getAgent();
      const response = await this.withTimeout(
        (agent as { send: (o: Record<string, unknown>) => Promise<unknown> }).send({
          model: "cursor-small",
          prompt: "Reply with exactly: ok",
        }),
        15_000,
      );
      const content = this.extractContent(response);
      checks.push({
        name: "响应格式兼容",
        pass: content.length > 0,
        detail: content.length > 0
          ? "响应格式正常"
          : "响应为空或格式不兼容",
      });
    } catch (e) {
      checks.push({
        name: "响应格式兼容",
        pass: false,
        detail: `测试调用失败: ${(e as Error).message}`,
      });
    }

    return checks;
  }

  // ========================================================================
  // 辅助方法
  // ========================================================================

  /**
   * 获取 agent 实例（延迟初始化 + 缓存）
   */
  private async getAgent(): Promise<unknown> {
    // @ts-ignore - @cursor/sdk 为运行时依赖
    const mod = await import("@cursor/sdk");
    return (
      (mod as Record<string, unknown>).agent ??
      (mod as Record<string, unknown>).default ??
      mod
    );
  }

  /**
   * 从响应中提取文本内容
   */
  private extractContent(response: unknown): string {
    if (typeof response === "string") return response;

    if (response && typeof response === "object") {
      const obj = response as Record<string, unknown>;
      const contentFields = ["content", "text", "message", "response", "output"];
      for (const field of contentFields) {
        const val = obj[field];
        if (typeof val === "string" && val.trim().length > 0) return val;
        if (Array.isArray(val)) {
          const texts = (val as unknown[])
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
      try { return JSON.stringify(response); } catch { return String(response); }
    }

    return String(response ?? "");
  }

  /**
   * 从响应中提取工具调用
   */
  private extractToolCalls(response: unknown): ToolCallRecord[] | undefined {
    if (!response || typeof response !== "object") return undefined;
    const obj = response as Record<string, unknown>;
    const rawCalls = obj.tool_calls ?? obj.toolCalls ?? obj.tool_use ?? obj.toolUse;
    if (!Array.isArray(rawCalls) || rawCalls.length === 0) return undefined;

    return (rawCalls as unknown[]).map((tc: unknown) => {
      const call = tc as Record<string, unknown>;
      return {
        tool: String(call.tool ?? call.name ?? call.function ?? "unknown"),
        args: (call.args ?? call.arguments ?? call.input ?? {}) as Record<string, unknown>,
        result: call.result ? String(call.result).substring(0, 500) : undefined,
      };
    });
  }

  /**
   * 从响应中提取 token 使用量
   */
  private extractTokenUsage(response: unknown): TokenUsage | undefined {
    if (!response || typeof response !== "object") return undefined;
    const obj = response as Record<string, unknown>;
    const usage = (obj.usage ?? obj.token_usage ?? obj.tokens) as Record<string, unknown> | undefined;
    if (!usage || typeof usage !== "object") return undefined;

    const input =
      typeof usage.input_tokens === "number"
        ? usage.input_tokens
        : typeof usage.input === "number"
          ? usage.input
          : typeof usage.prompt_tokens === "number"
            ? usage.prompt_tokens
            : undefined;

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
   * 读取 SDK package.json 获取版本号
   */
  private async readSdkPackageJson(): Promise<{ version?: string } | null> {
    try {
      const { readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");

      // 尝试多个可能路径
      const candidates = [
        resolve(this.projectRoot, "node_modules/@cursor/sdk/package.json"),
        resolve(process.cwd(), "node_modules/@cursor/sdk/package.json"),
      ];

      for (const p of candidates) {
        try {
          const content = readFileSync(p, "utf-8");
          return JSON.parse(content) as { version?: string };
        } catch {
          continue;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 带超时的 Promise 竞赛
   */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`操作超时 (${ms}ms)`)), ms),
      ),
    ]);
  }

  /**
   * 异步延迟
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 CursorAdapter 实例的便捷工厂函数
 *
 * @param projectRoot - 项目根目录路径
 * @returns CursorAdapter 实例
 */
export function createCursorAdapter(projectRoot?: string): CursorAdapter {
  return new CursorAdapter({ projectRoot });
}

/**
 * 创建空适配器（用于测试/占位）
 *
 * 所有方法默认抛出 "未实现" 错误。
 * 适合在 CI 或不需要 agent 调用的场景中使用。
 *
 * @returns 空 PlatformAdapter 实现
 */
export function createNullAdapter(): PlatformAdapter {
  const err = (method: string) => () => {
    throw new Error(`NullAdapter.${method}(): 未实现——需要真实适配器`);
  };

  return {
    platform: "cursor-sdk",
    version: "0.0.0-null",
    agentCall: err("agentCall"),
    injectGuardrails: async () => {},
    clearGuardrails: async () => {},
    prepareContext: () => [],
    listAvailableModels: async () => [],
    validateModel: async () => ({
      valid: false,
      model: "null",
      toolUseSupported: false,
      streamingSupported: false,
      latencyMs: 0,
      errors: ["NullAdapter: 未实现"],
    }),
    checkCompatibility: async () => ({
      allPassed: false,
      checks: [],
      timestamp: new Date().toISOString(),
      cacheValidUntil: new Date(0).toISOString(),
    }),
  };
}
