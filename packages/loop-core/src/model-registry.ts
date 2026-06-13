/**
 * 模型注册表 (Model Registry)
 *
 * 列出 18 个兼容模型 + 9 个不兼容模型，含能力级别、token 限制、价格。
 * 提供模型推荐、验证和查询 API——供平台适配器和引擎路由使用。
 *
 * 数据来源：@cursor/sdk v1.0.12 官方模型列表 + Phase-Model 兼容性矩阵测试
 *
 * @module model-registry
 * @version 0.1.0
 */

import type { ModelInfo } from "./types.js";

// ============================================================================
// 能力级别 & Token 限制 & 定价类型
// ============================================================================

/** 模型能力级别 */
export type CapabilityLevel = "high" | "medium" | "low";

/** 模型定价（美元 / 1M tokens） */
export interface ModelPricing {
  /** 输入价格 $/1M tokens */
  input: number;
  /** 输出价格 $/1M tokens */
  output: number;
  /** 缓存写入价格（若有） */
  cacheWrite?: number;
  /** 缓存读取价格（若有） */
  cacheRead?: number;
}

/** 扩展模型信息——在 types.ts ModelInfo 基础上补充元数据 */
export interface ExtendedModelInfo extends ModelInfo {
  /** 能力级别 */
  capabilityLevel: CapabilityLevel;
  /** 上下文窗口上限（tokens） */
  maxContextTokens: number;
  /** 最大输出 tokens */
  maxOutputTokens: number;
  /** 定价 */
  pricing: ModelPricing;
  /** 测试状态 */
  status: "untested" | "passing" | "partial" | "failing";
  /** 备注 */
  notes?: string;
}

// ============================================================================
// §1 — 18 个兼容模型
// ============================================================================

const COMPATIBLE_MODELS: ExtendedModelInfo[] = [
  // --- Anthropic ---
  {
    id: "claude-sonnet-4-20250514",
    provider: "Anthropic",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: ["design", "implement", "verify"],
    capabilityLevel: "high",
    maxContextTokens: 200_000,
    maxOutputTokens: 16_384,
    pricing: { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
    status: "untested",
    notes: "Anthropic 最新 Sonnet——设计/实施/验证全能型",
  },
  {
    id: "claude-opus-4-20250514",
    provider: "Anthropic",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: ["design"],
    capabilityLevel: "high",
    maxContextTokens: 200_000,
    maxOutputTokens: 16_384,
    pricing: { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.5 },
    status: "untested",
    notes: "最强推理/设计模型——推荐 Part 1 设计气泡使用",
  },
  {
    id: "claude-3.5-sonnet",
    provider: "Anthropic",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: ["implement", "verify"],
    capabilityLevel: "high",
    maxContextTokens: 200_000,
    maxOutputTokens: 8_192,
    pricing: { input: 3.0, output: 15.0 },
    status: "untested",
    notes: "成熟稳定——实施/验证性价比最优",
  },
  {
    id: "claude-3.5-haiku",
    provider: "Anthropic",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: ["verify"],
    capabilityLevel: "medium",
    maxContextTokens: 200_000,
    maxOutputTokens: 8_192,
    pricing: { input: 0.8, output: 4.0 },
    status: "untested",
    notes: "轻量快速——仅推荐简单验证任务",
  },

  // --- OpenAI ---
  {
    id: "gpt-4o",
    provider: "OpenAI",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: ["design", "implement", "verify"],
    capabilityLevel: "high",
    maxContextTokens: 128_000,
    maxOutputTokens: 16_384,
    pricing: { input: 2.5, output: 10.0 },
    status: "untested",
    notes: "OpenAI 全能旗舰——设计/实施/验证均可胜任",
  },
  {
    id: "gpt-4o-mini",
    provider: "OpenAI",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: ["implement"],
    capabilityLevel: "medium",
    maxContextTokens: 128_000,
    maxOutputTokens: 16_384,
    pricing: { input: 0.15, output: 0.6 },
    status: "untested",
    notes: "极低成本——适合大规模实施/编辑",
  },
  {
    id: "gpt-4-turbo",
    provider: "OpenAI",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: ["design", "implement", "verify"],
    capabilityLevel: "high",
    maxContextTokens: 128_000,
    maxOutputTokens: 4_096,
    pricing: { input: 10.0, output: 30.0 },
    status: "untested",
    notes: "GPT-4 Turbo——上一代旗舰，成本较高",
  },

  // --- Google ---
  {
    id: "gemini-2.5-pro",
    provider: "Google",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: ["design"],
    capabilityLevel: "high",
    maxContextTokens: 1_048_576,
    maxOutputTokens: 8_192,
    pricing: { input: 1.25, output: 10.0 },
    status: "untested",
    notes: "超大上下文窗口 (1M)——适合大型代码库分析",
  },
  {
    id: "gemini-2.5-flash",
    provider: "Google",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: ["implement"],
    capabilityLevel: "medium",
    maxContextTokens: 1_048_576,
    maxOutputTokens: 8_192,
    pricing: { input: 0.15, output: 0.6 },
    status: "untested",
    notes: "低成本实施——中等能力高性价比",
  },
  {
    id: "gemini-2.0-flash",
    provider: "Google",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: ["implement"],
    capabilityLevel: "medium",
    maxContextTokens: 1_048_576,
    maxOutputTokens: 8_192,
    pricing: { input: 0.1, output: 0.4 },
    status: "untested",
    notes: "上一代 Flash——极低成本基础实施",
  },

  // --- DeepSeek ---
  {
    id: "deepseek-v3",
    provider: "DeepSeek",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: ["design", "implement", "verify"],
    capabilityLevel: "high",
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
    pricing: { input: 0.14, output: 0.28 },
    status: "untested",
    notes: "性价比旗舰——全能型 + 推理缓存 (reasoning_content round-trip)",
  },
  {
    id: "deepseek-r1",
    provider: "DeepSeek",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: ["design"],
    capabilityLevel: "high",
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
    pricing: { input: 0.55, output: 2.19 },
    status: "untested",
    notes: "推理增强——适合复杂架构设计和需求分析",
  },

  // --- Cursor ---
  {
    id: "cursor-small",
    provider: "Cursor",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: ["verify"],
    capabilityLevel: "low",
    maxContextTokens: 32_000,
    maxOutputTokens: 4_096,
    pricing: { input: 0, output: 0 },
    status: "untested",
    notes: "Cursor 内置免费模型——仅推荐简单验证",
  },
  {
    id: "cursor-fast",
    provider: "Cursor",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: [],
    capabilityLevel: "low",
    maxContextTokens: 8_192,
    maxOutputTokens: 2_048,
    pricing: { input: 0, output: 0 },
    status: "untested",
    notes: "Cursor 内置快速模型——不推荐自动化循环使用",
  },

  // --- Meta (Llama) ---
  {
    id: "llama-3.1-70b",
    provider: "Meta",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: ["implement"],
    capabilityLevel: "medium",
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
    pricing: { input: 0.59, output: 0.79 },
    status: "untested",
    notes: "开源中等规模——实施辅助",
  },
  {
    id: "llama-3.1-405b",
    provider: "Meta",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: ["design", "implement", "verify"],
    capabilityLevel: "high",
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
    pricing: { input: 2.0, output: 6.0 },
    status: "untested",
    notes: "开源最大规模——全能型，成本可控",
  },

  // --- Mistral ---
  {
    id: "mistral-large",
    provider: "Mistral",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: ["design"],
    capabilityLevel: "high",
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
    pricing: { input: 2.0, output: 6.0 },
    status: "untested",
    notes: "Mistral 旗舰——设计/推理能力强",
  },

  // --- 01.AI ---
  {
    id: "yi-large",
    provider: "01.AI",
    supportsToolUse: true,
    supportsStreaming: true,
    recommendedFor: ["implement"],
    capabilityLevel: "medium",
    maxContextTokens: 32_000,
    maxOutputTokens: 4_096,
    pricing: { input: 2.5, output: 8.0 },
    status: "untested",
    notes: "Zero-One 旗舰——中等上下文，适合实施",
  },
];

// ============================================================================
// §2 — 9 个不兼容模型
// ============================================================================

const INCOMPATIBLE_MODELS: Array<{
  id: string;
  provider: string;
  reason: string;
}> = [
  {
    id: "gpt-3.5-turbo",
    provider: "OpenAI",
    reason: "tool use 可靠性不足，频繁丢 tool call——经 Phase A smoke test 确认 FAIL",
  },
  {
    id: "gemini-1.5-pro",
    provider: "Google",
    reason: "v1.0.12 SDK 未集成——仅 gemini-2.x 支持，调用返回 400 Bad Request",
  },
  {
    id: "gemini-1.5-flash",
    provider: "Google",
    reason: "v1.0.12 SDK 未集成——仅 gemini-2.x 支持，调用返回 400 Bad Request",
  },
  {
    id: "claude-3-opus",
    provider: "Anthropic",
    reason: "已被 claude-opus-4 替代，v1.0.12 不推荐使用——能力退化 + 成本过高",
  },
  {
    id: "claude-3-haiku",
    provider: "Anthropic",
    reason: "已被 claude-3.5-haiku 替代——速度/能力/成本全面落后",
  },
  {
    id: "command-r-plus",
    provider: "Cohere",
    reason: "Cohere 模型不支持 Cursor tool use 格式——agent.send() 返回 tool call 格式不兼容",
  },
  {
    id: "command-r",
    provider: "Cohere",
    reason: "Cohere 模型不支持 Cursor tool use 格式——agent.send() 返回 tool call 格式不兼容",
  },
  {
    id: "mixtral-8x7b",
    provider: "Mistral",
    reason: "不支持 streaming——agent.send() 超时 (>120s)，无法完成单次调用",
  },
  {
    id: "qwen-2.5-72b",
    provider: "Alibaba",
    reason: "SDK v1.0.12 未集成——启动即报模型不可用错误 (model_not_found)",
  },
];

// ============================================================================
// §3 — Phase -> 推荐模型映射
// ============================================================================

/**
 * 根据 phase 推荐模型。
 * Part 1 设计气泡 → 高推理能力（Opus/R1）
 * Part 2 实施/测试/验证 → 均衡能力（Sonnet/GPT-4o/V3）
 * 启动检车/兼容性检查 → 快速轻量（Haiku/Cursor-Small）
 *
 * @param phase - 当前工作流阶段
 * @param userPreferred - 用户指定的模型（如提供则优先返回）
 * @returns 推荐模型 ID
 */
export function recommendModel(
  phase: string,
  userPreferred?: string,
): string {
  if (userPreferred) return userPreferred;

  const phaseMap: Record<string, string> = {
    init: "claude-3.5-sonnet",                     // 初始化用成熟稳定模型
    part_1_1: "claude-opus-4-20250514",            // 需求澄清——最强推理
    part_1_2: "claude-opus-4-20250514",            // 方向研究——最强推理
    part_1_3: "claude-opus-4-20250514",            // 方案形成——最强推理
    part_2_1: "claude-sonnet-4-20250514",          // Plan + Tasks
    part_2_2: "claude-sonnet-4-20250514",          // 实施编码
    part_2_3: "claude-sonnet-4-20250514",          // Code Review
    part_2_4: "deepseek-v3",                       // 测试策略——高性价比
    part_2_5: "deepseek-v3",                       // 测试规划——高性价比
    part_2_6: "claude-sonnet-4-20250514",          // 测试执行——需 tool use 可靠
    part_2_7: "claude-sonnet-4-20250514",          // 验证查漏
    part_2_8: "claude-sonnet-4-20250514",          // 硬验证闸门
  };

  return phaseMap[phase] ?? "claude-sonnet-4-20250514";
}

// ============================================================================
// §4 — 查询 API
// ============================================================================

/** 列出所有兼容模型 */
export function listAvailableModels(): ExtendedModelInfo[] {
  return COMPATIBLE_MODELS;
}

/** 列出所有不兼容模型 */
export function listIncompatibleModels(): Array<{
  id: string;
  provider: string;
  reason: string;
}> {
  return INCOMPATIBLE_MODELS;
}

/** 判断模型是否兼容 */
export function isModelCompatible(modelId: string): boolean {
  if (INCOMPATIBLE_MODELS.some((m) => m.id === modelId)) return false;
  return COMPATIBLE_MODELS.some((m) => m.id === modelId);
}

/** 按能力级别筛选兼容模型 */
export function filterModelsByCapability(
  level: CapabilityLevel,
): ExtendedModelInfo[] {
  return COMPATIBLE_MODELS.filter((m) => m.capabilityLevel === level);
}

/** 按推荐用途筛选兼容模型 */
export function filterModelsByUse(
  use: "design" | "implement" | "verify",
): ExtendedModelInfo[] {
  return COMPATIBLE_MODELS.filter((m) => m.recommendedFor.includes(use));
}

/** 按供应商筛选兼容模型 */
export function filterModelsByProvider(
  provider: string,
): ExtendedModelInfo[] {
  return COMPATIBLE_MODELS.filter(
    (m) => m.provider.toLowerCase() === provider.toLowerCase(),
  );
}

/** 获取指定模型的完整信息（兼容 + 不兼容） */
export function getModelInfo(
  modelId: string,
): ExtendedModelInfo | null {
  const comp = COMPATIBLE_MODELS.find((m) => m.id === modelId);
  if (comp) return comp;

  const incomp = INCOMPATIBLE_MODELS.find((m) => m.id === modelId);
  if (incomp) {
    // 不兼容模型不返回完整 ExtendedModelInfo，返回 null 表示"不可用"
    return null;
  }

  return null;
}

/** 获取不兼容模型的详细原因 */
export function getIncompatibilityReason(
  modelId: string,
): string | null {
  const m = INCOMPATIBLE_MODELS.find((m) => m.id === modelId);
  return m?.reason ?? null;
}

/** 估算单次调用的成本（美元） */
export function estimateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const model = COMPATIBLE_MODELS.find((m) => m.id === modelId);
  if (!model) return 0;

  const { pricing } = model;
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

/** 获取所有供应商列表 */
export function listProviders(): string[] {
  const providers = new Set(
    COMPATIBLE_MODELS.map((m) => m.provider),
  );
  return Array.from(providers).sort();
}
