/**
 * @loop-cursor/adapter-cursor-sdk — Cursor SDK 平台适配器入口
 *
 * 提供：
 * - SDK 兼容性检查（5 项检查）
 * - 可行性探针（3 个探针 + 决策矩阵）
 * - 注意：核心适配器类（CursorSdkAdapter）将在 M2 实现
 *
 * @module @loop-cursor/adapter-cursor-sdk
 * @version 0.1.0
 */

// 平台适配器（M2 核心）
export {
  CursorPlatformAdapter,
  createCursorPlatformAdapter,
  getDefaultAdapter,
  resetDefaultAdapter,
} from "./adapter.js";
export type { ErrorCategory } from "./adapter.js";

// SDK 兼容性检查
export { runSdkCompatibilityCheck } from "./sdk-check.js";

// 可行性探针
export {
  probe1BasicConnectivity,
  probe2ContextBridge,
  probe3MinimalClosedLoop,
  determineVerdict,
  generateReport,
  runAllProbes,
} from "./probe.js";
export type { ProbeResult, ProbeVerdict, ProbeReport } from "./probe.js";
