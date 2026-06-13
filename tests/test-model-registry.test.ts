/**
 * model-registry 单元测试
 *
 * 测试模型注册表的完整功能：
 * - 兼容模型列表（18 个）
 * - 不兼容模型列表（9 个）
 * - 模型兼容性检查
 * - Phase -> 模型推荐映射
 * - 按能力/用途/供应商筛选
 * - 模型信息查询
 * - 不兼容原因查询
 * - 成本估算
 * - 供应商列表
 *
 * ============================================================
 * 本文件已迁移至 Node.js 原生 describe/it 模式。
 * 旧的自定义 runTests() 包装器已被 import { describe, it }
 * from "node:test" 替代。
 * 其他测试文件可参照本文件进行迁移。
 * ============================================================
 *
 * @module test-model-registry
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  recommendModel,
  listAvailableModels,
  listIncompatibleModels,
  isModelCompatible,
  filterModelsByCapability,
  filterModelsByUse,
  filterModelsByProvider,
  getModelInfo,
  getIncompatibilityReason,
  estimateCost,
  listProviders,
} from "../packages/loop-core/src/model-registry.js";
import type { CapabilityLevel } from "../packages/loop-core/src/model-registry.js";

// ============================================================================
// 测试套件 (使用 Node.js 原生 describe/it)
// ============================================================================

describe("model-registry", () => {
  // ── 测试 1: 兼容模型列表 ──
  it("listAvailableModels: 应包含 18 个兼容模型", () => {
    const models = listAvailableModels();
    assert.ok(models.length >= 18, `应至少 18 个兼容模型，实际 ${models.length}`);
    const anthropicModels = models.filter((m) => m.provider === "Anthropic");
    assert.ok(anthropicModels.length >= 4, `应至少 4 个 Anthropic 模型，实际 ${anthropicModels.length}`);
  });

  // ── 测试 2: 不兼容模型列表 ──
  it("listIncompatibleModels: 应包含 9 个不兼容模型", () => {
    const models = listIncompatibleModels();
    assert.ok(models.length >= 9, `应至少 9 个不兼容模型，实际 ${models.length}`);
  });

  // ── 测试 3: 兼容模型检查 ──
  it("isModelCompatible: claude-sonnet-4-20250514 应兼容", () => {
    assert.ok(isModelCompatible("claude-sonnet-4-20250514"));
  });

  // ── 测试 4: 不兼容模型检查 ──
  it("isModelCompatible: gpt-3.5-turbo 应不兼容", () => {
    assert.ok(!isModelCompatible("gpt-3.5-turbo"));
  });

  // ── 测试 5: 未知模型默认不兼容 ──
  it("isModelCompatible: 未知模型应返回 false", () => {
    assert.ok(!isModelCompatible("unknown-model"));
  });

  // ── 测试 6: 按能力筛选 ──
  it("filterModelsByCapability: high 能力筛选结果非空", () => {
    const result = filterModelsByCapability("high" as CapabilityLevel);
    assert.ok(result.length >= 6, `high 能力应至少 6 个模型，实际 ${result.length}`);
    for (const m of result) {
      assert.equal(m.capabilityLevel, "high", `${m.id} 能力应为 high`);
    }
  });

  // ── 测试 7: 按用途筛选 ──
  it("filterModelsByUse: design 用途筛选结果非空", () => {
    const result = filterModelsByUse("design");
    assert.ok(result.length >= 5, `design 用途应至少 5 个模型，实际 ${result.length}`);
    for (const m of result) {
      assert.ok(m.recommendedFor.includes("design"), `${m.id} 应包含 design 用途`);
    }
  });

  // ── 测试 8: 按供应商筛选 ──
  it("filterModelsByProvider: OpenAI 供应商筛选", () => {
    const result = filterModelsByProvider("OpenAI");
    assert.ok(result.length >= 2, `OpenAI 应至少 2 个模型，实际 ${result.length}`);
    for (const m of result) {
      assert.equal(m.provider, "OpenAI", `${m.id} 供应商应为 OpenAI`);
    }
  });

  // ── 测试 9: 按供应商筛选 —— Anthropic ──
  it("filterModelsByProvider: Anthropic 供应商筛选", () => {
    const result = filterModelsByProvider("Anthropic");
    assert.ok(result.length >= 3, `Anthropic 应至少 3 个模型，实际 ${result.length}`);
  });

  // ── 测试 10: 模型信息查询 —— 存在 ──
  it("getModelInfo: 已知模型返回有效信息", () => {
    const info = getModelInfo("claude-sonnet-4-20250514");
    assert.ok(info !== null, "应找到模型信息");
    assert.equal(info!.provider, "Anthropic");
    assert.ok(info!.maxContextTokens >= 200000, `上下文窗口应 >= 200k，实际 ${info!.maxContextTokens}`);
  });

  // ── 测试 11: 模型信息查询 —— 不存在 ──
  it("getModelInfo: 未知模型返回 null", () => {
    assert.equal(getModelInfo("no-such-model"), null);
  });

  // ── 测试 12: 不兼容原因查询 ──
  it("getIncompatibilityReason: gpt-3.5-turbo 应返回原因", () => {
    const reason = getIncompatibilityReason("gpt-3.5-turbo");
    assert.ok(reason !== null && reason.length > 0, "应返回不兼容原因");
  });

  // ── 测试 13: 不兼容原因查询 —— 兼容模型 ──
  it("getIncompatibilityReason: 兼容模型返回 null", () => {
    assert.equal(getIncompatibilityReason("claude-sonnet-4-20250514"), null);
  });

  // ── 测试 14: 不兼容原因查询 —— 未知模型返回 null ──
  it("getIncompatibilityReason: 未注册模型返回 null", () => {
    const result = getIncompatibilityReason("unknown-model");
    assert.equal(result, null, "未注册模型应返回 null");
  });

  // ── 测试 15: 成本估算 —— gpt-4o 已知 ──
  it("estimateCost: gpt-4o 成本大于 0", () => {
    const cost = estimateCost("gpt-4o", 50_000, 5_000);
    assert.ok(cost > 0, "成本应大于 0");
    // gpt-4o: input $2.50/1M, output $10.00/1M
    // 50k input = 0.125, 5k output = 0.05, total ≈ 0.175
    assert.ok(cost < 0.3, `成本应小于 $0.30，实际 ${cost}`);
  });

  // ── 测试 16: 成本估算 —— claude-sonnet-4 已知 ──
  it("estimateCost: claude-sonnet-4 成本合理", () => {
    const cost = estimateCost("claude-sonnet-4-20250514", 10_000, 1_000);
    assert.ok(cost > 0, "成本应大于 0");
    // claude-sonnet-4: input $3/1M, output $15/1M
    // 10k input = 0.03, 1k output = 0.015, total ≈ 0.045
    assert.ok(cost < 0.1, `成本应小于 $0.10，实际 ${cost}`);
  });

  // ── 测试 17: 成本估算 —— 未知模型返回 0 ──
  it("estimateCost: 未知模型返回 0", () => {
    const cost = estimateCost("unknown", 1000, 100);
    assert.equal(cost, 0, "未知模型成本应为 0");
  });

  // ── 测试 18: 列出所有供应商去重排序 ──
  it("listProviders: 列出所有供应商去重排序", () => {
    const providers = listProviders();
    assert.ok(providers.length >= 6, `至少应有 6 个供应商，实际 ${providers.length}`);
    assert.ok(providers.includes("Anthropic"), "应包含 Anthropic");
    assert.ok(providers.includes("OpenAI"), "应包含 OpenAI");
    assert.ok(providers.includes("Google"), "应包含 Google");
    assert.ok(providers.includes("DeepSeek"), "应包含 DeepSeek");
    // 确保去重
    const unique = new Set(providers);
    assert.equal(unique.size, providers.length, "供应商列表应无重复");
    // 确保排序
    for (let i = 1; i < providers.length; i++) {
      assert.ok(providers[i] >= providers[i - 1], `供应商列表未排序: ${providers[i]} < ${providers[i - 1]}`);
    }
  });

  // ── 测试 19: 模型推荐 —— init 阶段 ──
  it("recommendModel: init 阶段推荐成熟稳定模型", () => {
    const result = recommendModel("init");
    assert.equal(result, "claude-3.5-sonnet", `init 阶段期望 claude-3.5-sonnet，实际 ${result}`);
  });

  // ── 测试 20: 所有兼容模型有有效定价 ──
  it("所有兼容模型 pricing 大于 0", () => {
    const models = listAvailableModels();
    for (const m of models) {
      // cursor 免费模型除外
      if (m.provider === "Cursor") continue;
      assert.ok(m.pricing.input > 0, `${m.id} input 定价应大于 0`);
    }
  });

  // ── 测试 21: 所有兼容模型有有效上下文窗口 ──
  it("所有兼容模型 maxContextTokens 有效", () => {
    const models = listAvailableModels();
    for (const m of models) {
      assert.ok(m.maxContextTokens >= 8192, `${m.id} 上下文窗口应 >= 8192，实际 ${m.maxContextTokens}`);
    }
  });
});
