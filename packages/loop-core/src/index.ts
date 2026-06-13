/**
 * @loop-cursor/core — 共享引擎入口
 *
 * loop-cursor 的核心类型系统和配置管理。
 * 从 loop-claudecode 继承，零代码修改。
 *
 * @module @loop-cursor/core
 * @version 0.1.0
 */

// 共享类型系统
export * from "./types.js";

// 配置管理
export * from "./config.js";

// 引擎
export { engineLoop } from "./engine-loop.js";

// 收敛引擎
export * from "./convergence.js";

// 路由引擎
export * from "./router.js";

// 文件状态机（state.json 读写/原子更新/Schema 校验）
export {
  loadState,
  saveState,
  atomicWrite,
  acquireLock,
  releaseLock,
  checkLock,
  transitionPhase,
  rollbackPhase,
  getTransitionSummary,
  restoreFromBackup,
  createNamedBackup,
  healthCheck,
  purgeStateFiles,
  batchUpdate,
  tryLoadState,
} from "./state-machine.js";
// 注意：isTerminalPhase 已在 config.ts 中导出，此处不重复导出

// 问题分类器（P0/P1/P2 严重度判定 + 决策树 + 优先级排序）
export * from "./issue-classifier.js";

// 验证 Schema（state.json / gate_state.json JSON Schema + 运行时验证）
export * from "./schema.js";

// SAP Block 解析器（<<<LOOP_STATE>>> 标记提取/验证/交叉校验）
export * from "./sap-parser.js";

// 工作树管理（创建/清理/泄漏检测）
export * from "./worktree.js";

// 平台适配器（PlatformAdapter 接口 + CursorAdapter 实现）
export * from "./platform-adapter.js";

// 7 安全 Gate（G1-G6 闸门系统）
export * from "./gate-content-safety.js";
export * from "./gate-dangerous-ops.js";
export * from "./gate-dependency-install.js";
export * from "./gate-file-changes.js";
export * from "./gate-plan-confirmation.js";
export * from "./gate-state-guard.js";
export * from "./gate-completion-stop.js";

// 模型注册表（model metadata + capability profiles）
export * from "./model-registry.js";
