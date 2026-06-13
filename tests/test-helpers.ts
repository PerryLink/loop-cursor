/**
 * 共享测试辅助工具
 *
 * 标准化测试套件的通用工具函数和测试夹具。
 * 测试文件可以通过导入本模块来使用一致的 assert、状态构建和环境管理。
 *
 * ============================================================
 * 迁移指南 (Migration Guide):
 *
 * 旧模式（自定义 runTests 包装器）:
 *   async function runTests() {
 *     let passed = 0, failed = 0;
 *     async function test(name, fn) { ... }
 *     await test("测试名称", async () => { ... });
 *     // 手动汇总结果
 *   }
 *   runTests();
 *
 * 新模式（Node.js 原生 describe/it）:
 *   import { describe, it } from "node:test";
 *   import { strict as assert } from "node:assert";
 *   import { makeBasicState, cleanupStateFiles } from "./test-helpers.js";
 *
 *   describe("模块名称", () => {
 *     it("测试用例", () => {
 *       const state = makeBasicState();
 *       assert.equal(state.progress.phase, PhaseEnum.INIT);
 *     });
 *   });
 * ============================================================
 *
 * @module test-helpers
 */

import { buildInitialState } from "../packages/loop-core/src/config.js";
import { RunModeEnum } from "../packages/loop-core/src/types.js";
import type { LoopState } from "../packages/loop-core/src/types.js";
import { existsSync, unlinkSync } from "node:fs";

// ============================================================================
// 状态构建辅助函数
// ============================================================================

/** 构建基础的测试用 LoopState */
export function makeBasicState(userRequest?: string): LoopState {
  return buildInitialState(userRequest ?? "test goal", RunModeEnum.AUTO);
}

/**
 * 构建带自定义覆盖的 LoopState
 * 使用 JSON.parse(JSON.stringify(...)) 做深拷贝以避免引用污染
 */
export function makeStateWithOverrides(overrides: Partial<LoopState>): LoopState {
  const base = buildInitialState("test goal", "auto");
  return JSON.parse(JSON.stringify({ ...base, ...overrides }));
}

// ============================================================================
// 文件/环境清理
// ============================================================================

/** state-machine 测试常用的绑定文件路径 */
const DEFAULT_STATE_FILES = [
  ".loop-cursor/state.json",
  ".loop-cursor/state.json.lock",
  ".loop-cursor/state.json.tmp",
  ".loop-cursor/state.json.bak",
];

/**
 * 清理状态机产生的临时文件
 * 适合在 state-machine 相关测试的 beforeEach/afterEach 中调用
 */
export function cleanupStateFiles(paths?: string[]): void {
  for (const p of paths ?? DEFAULT_STATE_FILES) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* 忽略权限等无法清理的情况 */
    }
  }
}

// ============================================================================
// 简单断言（兼容不需要 node:assert 的场景）
// ============================================================================

/**
 * 简单断言函数
 * 与 node:assert/strict 等价，保留用于向后兼容
 */
export function assert(condition: boolean, msg: string): void {
  if (!condition) throw new AssertionError(msg);
}

class AssertionError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AssertionError";
  }
}
