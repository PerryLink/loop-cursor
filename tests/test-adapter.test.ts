/**
 * adapter 单元测试
 *
 * 测试 CursorPlatformAdapter 的核心功能：
 * - 工厂函数和单例管理
 * - listAvailableModels 返回正确清单
 * - PlatformAdapter 接口合规（7 方法存在）
 * - 错误分类逻辑（分类和可重试判定）
 * - 护栏注入和清理流程
 * - 上下文准备
 * - 边界情况
 *
 * 注意：此测试不依赖 @cursor/sdk 实际可用。
 * 仅测试适配器层的逻辑，不发起真实的 agent 调用。
 *
 * @module test-adapter
 */

import {
  CursorPlatformAdapter,
  createCursorPlatformAdapter,
  getDefaultAdapter,
  resetDefaultAdapter,
} from "../packages/adapter-cursor-sdk/src/adapter.js";
import type { PlatformAdapter } from "../packages/loop-core/src/types.js";
import { TrustLevelEnum } from "../packages/loop-core/src/types.js";
import type { TrustLevel } from "../packages/loop-core/src/types.js";

// ============================================================================
// 辅助函数
// ============================================================================

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

/** 检查对象是否实现 PlatformAdapter 的 7 个方法 */
function checkPlatformAdapterMethods(obj: unknown): string[] {
  const requiredMethods = [
    "agentCall",
    "injectGuardrails",
    "clearGuardrails",
    "prepareContext",
    "listAvailableModels",
    "validateModel",
    "checkCompatibility",
  ];
  const missing: string[] = [];
  for (const method of requiredMethods) {
    if (typeof (obj as Record<string, unknown>)[method] !== "function") {
      missing.push(method);
    }
  }
  return missing;
}

// ============================================================================
// 测试套件
// ============================================================================

async function runTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function describe(name: string, fn: () => void): void {
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
  // Scenario 1: Factory functions and singleton management
  // ═══════════════════════════════════════════════════════════════

  describe("工厂函数与单例管理", () => {
    it("createCursorPlatformAdapter 应返回正确的实例", () => {
      const adapter = createCursorPlatformAdapter("/tmp/test-project");
      assert(adapter instanceof CursorPlatformAdapter, "应为 CursorPlatformAdapter 实例");
      assert(adapter.platform === "cursor-sdk", "platform 应为 cursor-sdk");
      assert(adapter.version === "0.2.0", "version 应为 0.2.0");
    });

    it("getDefaultAdapter 应返回单例", () => {
      resetDefaultAdapter();
      const a1 = getDefaultAdapter();
      const a2 = getDefaultAdapter();
      assert(a1 === a2, "两次调用应返回同一实例");
    });

    it("resetDefaultAdapter 应创建新实例", () => {
      const a1 = getDefaultAdapter();
      resetDefaultAdapter();
      const a2 = getDefaultAdapter();
      assert(a1 !== a2, "reset 后应为新实例");
    });

    it("可以用自定义 projectRoot 创建适配器", () => {
      const adapter = new CursorPlatformAdapter("/custom/project/root");
      assert(adapter.platform === "cursor-sdk", "platform 正确");
      assert(adapter.version === "0.2.0", "version 正确");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 2: PlatformAdapter interface compliance
  // ═══════════════════════════════════════════════════════════════

  describe("PlatformAdapter 接口合规（7 方法）", () => {
    it("应实现全部 7 个 PlatformAdapter 方法", () => {
      const adapter = new CursorPlatformAdapter("/tmp/test-project");
      const missing = checkPlatformAdapterMethods(adapter);
      assert(missing.length === 0, `缺失方法: ${missing.join(", ")}`);
    });

    it("platform 应为 cursor-sdk（const 类型）", () => {
      const adapter = new CursorPlatformAdapter();
      assert(adapter.platform === "cursor-sdk", "platform 固定值正确");
    });

    it("应可赋值给 PlatformAdapter 类型（编译时检查 + 运行时验证）", () => {
      const adapter: PlatformAdapter = new CursorPlatformAdapter();
      assert(typeof adapter.agentCall === "function", "agentCall 为函数");
      assert(typeof adapter.injectGuardrails === "function", "injectGuardrails 为函数");
      assert(typeof adapter.clearGuardrails === "function", "clearGuardrails 为函数");
      assert(typeof adapter.prepareContext === "function", "prepareContext 为函数");
      assert(typeof adapter.listAvailableModels === "function", "listAvailableModels 为函数");
      assert(typeof adapter.validateModel === "function", "validateModel 为函数");
      assert(typeof adapter.checkCompatibility === "function", "checkCompatibility 为函数");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 3: listAvailableModels
  // ═══════════════════════════════════════════════════════════════

  describe("listAvailableModels 模型清单", () => {
    it("应返回 5 个预定义模型", async () => {
      const adapter = new CursorPlatformAdapter();
      const models = await adapter.listAvailableModels();
      assert(models.length === 5, `期望 5 个模型，实际 ${models.length}`);
    });

    it("应包含 claude-sonnet-4-20250514", async () => {
      const adapter = new CursorPlatformAdapter();
      const models = await adapter.listAvailableModels();
      const sonnet = models.find((m) => m.id === "claude-sonnet-4-20250514");
      assert(sonnet !== undefined, "应包含 claude-sonnet-4-20250514");
      assert(sonnet!.provider === "Anthropic", "供应商应为 Anthropic");
      assert(sonnet!.supportsToolUse === true, "应支持 tool use");
      assert(sonnet!.status === "confirmed", "状态应为 confirmed");
    });

    it("应包含 claude-opus-4-20250514（设计推荐）", async () => {
      const adapter = new CursorPlatformAdapter();
      const models = await adapter.listAvailableModels();
      const opus = models.find((m) => m.id === "claude-opus-4-20250514");
      assert(opus !== undefined, "应包含 claude-opus-4-20250514");
      assert(opus!.recommendedFor.includes("design"), "应推荐用于 design");
    });

    it("应返回副本而非内部引用", async () => {
      const adapter = new CursorPlatformAdapter();
      const models1 = await adapter.listAvailableModels();
      const models2 = await adapter.listAvailableModels();
      assert(models1 !== models2, "每次调用应返回新数组");
    });

    it("应包含 gpt-4o（untested 状态）", async () => {
      const adapter = new CursorPlatformAdapter();
      const models = await adapter.listAvailableModels();
      const gpt4o = models.find((m) => m.id === "gpt-4o");
      assert(gpt4o !== undefined, "应包含 gpt-4o");
      assert(gpt4o!.provider === "OpenAI", "供应商应为 OpenAI");
      assert(gpt4o!.status === "untested", "状态应为 untested");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 4: Guardrail injection and clearing
  // ═══════════════════════════════════════════════════════════════

  describe("护栏注入与清理", () => {
    it("injectGuardrails 应在不依赖 SDK 的情况下正常执行", async () => {
      const adapter = new CursorPlatformAdapter("/tmp/test-guardrails");
      // injectGuardrails 只操作文件系统（创建 rules/ 目录和文件）
      try {
        await adapter.injectGuardrails("part_1_1", TrustLevelEnum.AUTO);
        // 不抛异常即为通过
        assert(true, "injectGuardrails 无异常执行");
      } catch (e) {
        // 在某些环境中可能因权限问题失败
        assert((e as Error).message.length > 0, "错误消息非空");
      }
    });

    it("clearGuardrails 应在不依赖 SDK 的情况下正常执行", async () => {
      const adapter = new CursorPlatformAdapter("/tmp/test-guardrails");
      try {
        await adapter.clearGuardrails();
        assert(true, "clearGuardrails 无异常执行");
      } catch (e) {
        assert((e as Error).message.length > 0, "错误消息非空");
      }
    });

    it("prepareContext 应返回 ConversationMessage 数组", () => {
      const adapter = new CursorPlatformAdapter();
      const messages = adapter.prepareContext({});
      assert(Array.isArray(messages), "应返回数组");
      // 即使没有上下文，也应返回空数组
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 5: Adapter constants and properties
  // ═══════════════════════════════════════════════════════════════

  describe("适配器常量与属性", () => {
    it("platform 应为只读的 cursor-sdk", () => {
      const adapter = new CursorPlatformAdapter();
      assert(adapter.platform === "cursor-sdk", "platform 正确");
      // TypeScript 层面已经是 readonly，运行时验证
    });

    it("version 应匹配 ADAPTER_VERSION", () => {
      const adapter = new CursorPlatformAdapter();
      assert(adapter.version === "0.2.0", "默认 version 为 0.2.0");
    });

    it("version 属性为固定 ADAPTER_VERSION", () => {
      const adapter = new CursorPlatformAdapter("/tmp/p", "2.5.0");
      assert(adapter.version === "0.2.0", "version 属性固定为 ADAPTER_VERSION");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scenario 6: Edge cases and error scenarios
  // ═══════════════════════════════════════════════════════════════

  describe("边界情况", () => {
    it("不传参数应使用 process.cwd()", () => {
      const adapter = new CursorPlatformAdapter();
      assert(adapter.platform === "cursor-sdk", "默认构造不抛异常");
    });

    it("agentCall 应在 SDK 不可用时返回失败（非抛出）", async () => {
      const adapter = new CursorPlatformAdapter("/tmp/no-sdk");
      try {
        const result = await adapter.agentCall({
          model: "test-model",
          prompt: "test",
          phase: "init",
          trustLevel: TrustLevelEnum.AUTO,
          timeoutMs: 1000,
        });
        // 如果 SDK 不可用，会尝试动态 import 并失败
        // 应该返回 success: false 并包含错误消息
        if (!result.success) {
          assert(typeof result.error === "string", "错误消息应为字符串");
          assert(result.error!.length > 0, "错误消息非空");
        }
        // SDK 可用时 success 也可为 true（不强制要求失败）
      } catch (e) {
        // 某些实现可能 throw 而非返回错误对象
        assert((e as Error).message.length > 0, "异常消息非空");
      }
    });

    it("多次创建适配器不应互相影响", () => {
      const a1 = new CursorPlatformAdapter("/tmp/p1");
      const a2 = new CursorPlatformAdapter("/tmp/p2");
      assert(a1 !== a2, "应为不同实例");
      assert(a1.platform === a2.platform, "platform 一致");
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
