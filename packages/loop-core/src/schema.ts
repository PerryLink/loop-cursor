/**
 * loop-cursor 验证 Schema 定义 (Validation Schema)
 *
 * 定义 state.json 和 gate_state.json 的 JSON Schema，
 * 提供运行时验证函数，确保数据完整性和类型安全。
 *
 * 功能：
 * - state.json JSON Schema（完整 LoopState 结构）
 * - gate_state.json Schema（闸门状态追踪）
 * - 运行时验证函数（validateState / validateGateState）
 * - Schema 版本兼容性检查
 *
 * @module schema
 * @version 0.1.0
 */

import type { LoopState } from "./types.js";
import { PhaseEnum } from "./types.js";

// ============================================================================
// Schema 版本与常量
// ============================================================================

/** 当前 schema 版本号 */
export const CURRENT_SCHEMA_VERSION = 1;

/** state.json 允许的 schema_version 范围 */
export const SUPPORTED_SCHEMA_VERSIONS = [1];

/** 已知 phase 值集合（用于运行时校验） */
const VALID_PHASES: Set<string> = new Set(Object.values(PhaseEnum));

/** 合法终止状态值 */
const VALID_TERMINATION_STATUSES: Set<string> = new Set([
  "running",
  "complete",
  "paused",
  "failed",
]);

/** 合法运行模式值 */
const VALID_RUN_MODES: Set<string> = new Set(["safe", "auto", "unsafe", "interactive"]);

// ============================================================================
// JSON Schema 定义
// ============================================================================

/**
 * LoopState 的 JSON Schema（草案 2020-12 子集）
 *
 * 用于运行时验证 state.json 的结构完整性。
 * 包含所有必需字段和类型约束。
 */
export const STATE_JSON_SCHEMA: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "LoopState",
  description: "loop-cursor 文件状态机核心数据对象",
  type: "object",
  required: [
    "schema_version",
    "progress",
    "config",
    "tasks",
    "issues",
    "artifacts",
    "routing_history",
    "termination",
    "pending_confirmation",
    "housekeeping",
  ],
  properties: {
    schema_version: { type: "integer", minimum: 1 },
    progress: {
      type: "object",
      required: [
        "phase",
        "cycle",
        "convergence_counter",
        "part1_round",
        "new_issues_this_round",
        "new_issues_last_round",
        "issues_snapshot_at_round_start",
        "retry_count_this_phase",
        "verification_pass_count",
        "implementation_engine",
        "repair_context",
        "phase_transitions",
      ],
      properties: {
        phase: { type: "string" },
        cycle: { type: "integer", minimum: 0 },
        convergence_counter: { type: "integer", minimum: 0 },
        part1_round: { type: "integer", minimum: 0 },
        new_issues_this_round: { type: "boolean" },
        new_issues_last_round: { type: "boolean" },
        issues_snapshot_at_round_start: {
          type: "object",
          required: ["p0", "p1", "p2"],
          properties: {
            p0: { type: "integer", minimum: 0 },
            p1: { type: "integer", minimum: 0 },
            p2: { type: "integer", minimum: 0 },
          },
        },
        retry_count_this_phase: { type: "integer", minimum: 0 },
        verification_pass_count: { type: "integer", minimum: 0 },
        implementation_engine: { type: ["string", "null"] },
        repair_context: { type: ["string", "null"] },
        phase_transitions: { type: "array" },
      },
    },
    config: {
      type: "object",
      required: [
        "mode",
        "max_cycles",
        "max_part1_rounds",
        "convergence_rounds",
        "route_repeat_max",
        "user_request",
        "model",
        "sdk_version",
      ],
      properties: {
        mode: { type: "string" },
        max_cycles: { type: "integer", minimum: 1 },
        max_part1_rounds: { type: "integer", minimum: 1 },
        convergence_rounds: { type: "integer", minimum: 1 },
        route_repeat_max: { type: "integer", minimum: 1 },
        user_request: { type: "string" },
        model: { type: "string" },
        sdk_version: { type: "string" },
      },
    },
    tasks: {
      type: "object",
      required: ["total", "by_status"],
      properties: {
        total: { type: "integer", minimum: 0 },
        by_status: {
          type: "object",
          required: ["completed", "in_progress", "pending", "failed", "skipped"],
          properties: {
            completed: { type: "integer", minimum: 0 },
            in_progress: { type: "integer", minimum: 0 },
            pending: { type: "integer", minimum: 0 },
            failed: { type: "integer", minimum: 0 },
            skipped: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    issues: {
      type: "object",
      required: ["active", "resolved", "all_time"],
      properties: {
        active: {
          type: "object",
          required: ["p0", "p1", "p2"],
          properties: {
            p0: { type: "array" },
            p1: { type: "array" },
            p2: { type: "array" },
          },
        },
        resolved: {
          type: "object",
          required: ["p0", "p1", "p2"],
          properties: {
            p0: { type: "integer", minimum: 0 },
            p1: { type: "integer", minimum: 0 },
            p2: { type: "integer", minimum: 0 },
          },
        },
        all_time: {
          type: "object",
          required: ["p0_total", "p1_total", "p2_total"],
          properties: {
            p0_total: { type: "integer", minimum: 0 },
            p1_total: { type: "integer", minimum: 0 },
            p2_total: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    artifacts: { type: "object" },
    routing_history: { type: "array" },
    termination: {
      type: "object",
      required: ["status", "completed_at", "exit_reason"],
      properties: {
        status: { type: "string", enum: ["running", "complete", "paused", "failed"] },
        completed_at: { type: ["string", "null"] },
        exit_reason: { type: ["string", "null"] },
      },
    },
    pending_confirmation: {
      type: "object",
      required: ["id", "status"],
      properties: {
        id: { type: ["string", "null"] },
        status: { type: ["string", "null"] },
      },
    },
    housekeeping: {
      type: "object",
      required: ["invocation_count", "total_tokens_estimated", "lock_file"],
      properties: {
        invocation_count: { type: "integer", minimum: 0 },
        total_tokens_estimated: { type: "integer", minimum: 0 },
        lock_file: { type: "string" },
      },
    },
  },
};

/**
 * GateState 的 JSON Schema
 *
 * 用于追踪每个闸门的执行状态和判定结果。
 */
export const GATE_STATE_JSON_SCHEMA: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "GateState",
  description: "loop-cursor 闸门状态追踪对象",
  type: "object",
  required: ["gate_id", "phase", "enabled", "results"],
  properties: {
    gate_id: { type: "string" },
    phase: { type: "string" },
    enabled: { type: "boolean" },
    results: {
      type: "object",
      required: ["pass", "blocks", "reason", "checked_at"],
      properties: {
        pass: { type: "boolean" },
        blocks: { type: "array", items: { type: "string" } },
        reason: { type: "string" },
        checked_at: { type: "string" },
      },
    },
  },
};

// ============================================================================
// 运行时验证函数
// ============================================================================

/** 验证结果类型 */
export interface ValidationResult {
  /** 是否通过验证 */
  valid: boolean;
  /** 错误信息列表 */
  errors: string[];
  /** 警告信息列表（非致命） */
  warnings: string[];
}

/**
 * 验证 LoopState 对象的运行时完整性
 *
 * 检查项：
 * 1. 顶层必需字段是否存在
 * 2. schema_version 是否受支持
 * 3. phase 是否为已知值
 * 4. termination.status 是否为合法值
 * 5. config.mode 是否为合法值
 * 6. 数值字段是否为非负整数
 * 7. progress.issues_snapshot_at_round_start 计数一致性
 *
 * @param state - 待验证的 LoopState 对象
 * @returns 验证结果（valid / errors / warnings）
 */
export function validateState(state: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 基础类型检查
  if (!state || typeof state !== "object") {
    return { valid: false, errors: ["state 不是有效对象"], warnings: [] };
  }

  const s = state as Record<string, unknown>;

  // 检查必需顶层字段
  const requiredTopKeys = [
    "schema_version",
    "progress",
    "config",
    "tasks",
    "issues",
    "artifacts",
    "routing_history",
    "termination",
    "pending_confirmation",
    "housekeeping",
  ];
  for (const key of requiredTopKeys) {
    if (!(key in s)) {
      errors.push(`缺少顶层字段: ${key}`);
    }
  }

  // schema_version 检查
  if (typeof s.schema_version !== "number" || !SUPPORTED_SCHEMA_VERSIONS.includes(s.schema_version)) {
    errors.push(
      `schema_version 不兼容: 期望 ${SUPPORTED_SCHEMA_VERSIONS.join("|")}，实际 ${s.schema_version}`,
    );
  }

  // progress 检查
  if (s.progress && typeof s.progress === "object") {
    const p = s.progress as Record<string, unknown>;
    if (typeof p.phase !== "string" || !VALID_PHASES.has(p.phase)) {
      errors.push(`progress.phase 无效: ${p.phase}`);
    }
    if (typeof p.cycle !== "number" || p.cycle < 0) {
      errors.push(`progress.cycle 无效: ${p.cycle}`);
    }
    if (typeof p.convergence_counter !== "number" || p.convergence_counter < 0) {
      errors.push(`progress.convergence_counter 无效: ${p.convergence_counter}`);
    }
    if (typeof p.part1_round !== "number" || p.part1_round < 0) {
      warnings.push(`progress.part1_round 异常: ${p.part1_round}`);
    }
    if (!Array.isArray(p.phase_transitions)) {
      errors.push("progress.phase_transitions 不是数组");
    }
  } else {
    errors.push("progress 字段缺失或不是对象");
  }

  // config 检查
  if (s.config && typeof s.config === "object") {
    const c = s.config as Record<string, unknown>;
    if (typeof c.mode !== "string" || !VALID_RUN_MODES.has(c.mode)) {
      errors.push(`config.mode 无效: ${c.mode}`);
    }
    if (typeof c.max_cycles !== "number" || c.max_cycles < 1) {
      errors.push(`config.max_cycles 无效: ${c.max_cycles}`);
    }
    if (typeof c.max_part1_rounds !== "number" || c.max_part1_rounds < 1) {
      warnings.push(`config.max_part1_rounds 异常: ${c.max_part1_rounds}`);
    }
  } else {
    errors.push("config 字段缺失或不是对象");
  }

  // termination 检查
  if (s.termination && typeof s.termination === "object") {
    const t = s.termination as Record<string, unknown>;
    if (typeof t.status !== "string" || !VALID_TERMINATION_STATUSES.has(t.status)) {
      errors.push(`termination.status 无效: ${t.status}`);
    }
  } else {
    errors.push("termination 字段缺失或不是对象");
  }

  // issues 结构检查
  if (s.issues && typeof s.issues === "object") {
    const iss = s.issues as Record<string, unknown>;
    if (iss.active && typeof iss.active === "object") {
      const a = iss.active as Record<string, unknown>;
      if (!Array.isArray(a.p0)) errors.push("issues.active.p0 不是数组");
      if (!Array.isArray(a.p1)) errors.push("issues.active.p1 不是数组");
      if (!Array.isArray(a.p2)) errors.push("issues.active.p2 不是数组");
    }
  }

  // tasks 结构检查
  if (s.tasks && typeof s.tasks === "object") {
    const ts = s.tasks as Record<string, unknown>;
    if (typeof ts.total !== "number" || ts.total < 0) {
      errors.push(`tasks.total 无效: ${ts.total}`);
    }
  }

  // housekeeping 检查
  if (s.housekeeping && typeof s.housekeeping === "object") {
    const h = s.housekeeping as Record<string, unknown>;
    if (typeof h.invocation_count !== "number" || h.invocation_count < 0) {
      warnings.push(`housekeeping.invocation_count 异常: ${h.invocation_count}`);
    }
    if (typeof h.total_tokens_estimated !== "number" || h.total_tokens_estimated < 0) {
      warnings.push(`housekeeping.total_tokens_estimated 异常: ${h.total_tokens_estimated}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * 验证 GateState 对象的运行时完整性
 *
 * @param gateState - 待验证的 GateState 对象
 * @returns 验证结果
 */
export function validateGateState(gateState: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!gateState || typeof gateState !== "object") {
    return { valid: false, errors: ["gateState 不是有效对象"], warnings: [] };
  }

  const gs = gateState as Record<string, unknown>;

  if (typeof gs.gate_id !== "string" || gs.gate_id.length === 0) {
    errors.push("gate_id 缺失或为空");
  }
  if (typeof gs.phase !== "string" || !VALID_PHASES.has(gs.phase)) {
    errors.push(`phase 无效: ${gs.phase}`);
  }
  if (typeof gs.enabled !== "boolean") {
    errors.push("enabled 不是布尔值");
  }
  if (gs.results && typeof gs.results === "object") {
    const r = gs.results as Record<string, unknown>;
    if (typeof r.pass !== "boolean") {
      errors.push("results.pass 不是布尔值");
    }
    if (!Array.isArray(r.blocks)) {
      warnings.push("results.blocks 不是数组");
    }
  } else {
    errors.push("results 字段缺失或不是对象");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * 检查 schema_version 兼容性
 *
 * 如果 state.json 的版本号不在受支持列表中，返回 false。
 * 用于向前兼容性检测——未来版本增加新字段时，旧版引擎仍能解析。
 *
 * @param version - state.json 中的 schema_version 值
 * @returns 是否兼容
 */
export function isSchemaVersionCompatible(version: number): boolean {
  return SUPPORTED_SCHEMA_VERSIONS.includes(version);
}

/**
 * 将所有验证错误格式化为可读字符串
 *
 * @param result - 验证结果
 * @returns 格式化的错误描述字符串
 */
export function formatValidationErrors(result: ValidationResult): string {
  const lines: string[] = [];
  if (result.errors.length > 0) {
    lines.push(`验证失败 (${result.errors.length} 个错误):`);
    for (const e of result.errors) {
      lines.push(`  [ERROR] ${e}`);
    }
  }
  if (result.warnings.length > 0) {
    lines.push(`警告 (${result.warnings.length} 条):`);
    for (const w of result.warnings) {
      lines.push(`  [WARN] ${w}`);
    }
  }
  return lines.join("\n");
}

/**
 * 确保 state 符合默认契约 —— 如果 termination.status 缺失则初始化为 "running"
 *
 * Default-FAIL 合约：termination.status 初始必须为 "running"，
 * 任何缺失都视为数据损坏并自动修复。
 *
 * @param state - 从 state.json 解析的原始对象
 * @returns 确保合法的 LoopState 对象
 */
export function ensureDefaultFailContract(state: LoopState): LoopState {
  if (!state.termination) {
    state.termination = {
      status: "running",
      completed_at: null,
      exit_reason: null,
    };
  } else if (!state.termination.status) {
    state.termination.status = "running";
  }
  return state;
}
