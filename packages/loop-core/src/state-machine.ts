/**
 * loop-cursor 文件状态机 (State Machine)
 *
 * 负责 state.json 的完整生命周期管理：
 * - 读取/写入 state.json
 * - 原子写入（tmp -> fsync -> rename -> fsync 父目录）
 * - Default-FAIL 合约（termination.status 初始 "running"）
 * - Phase 转换（含转换历史记录）
 * - 备份和恢复（.bak / .tmp 文件管理）
 * - 孤儿锁检测和清理
 *
 * 设计原则：
 * - 文件持久化优于内存状态（扛 agent 重启 + 会话丢失）
 * - 原子写入保证数据一致性（不会出现半写入文件）
 * - Default-FAIL：状态初始为 running，缺失则自动修复
 *
 * @module state-machine
 * @version 0.1.0
 */

import type { LoopState, Phase, ProgressState } from "./types.js";
import { PhaseEnum, TERMINAL_PHASES } from "./types.js";
import {
  DEFAULT_STATE_PATH,
  DEFAULT_CONTEXT_SUMMARY_PATH,
} from "./config.js";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  renameSync,
  statSync,
  fstatSync,
  openSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { dirname } from "node:path";
import { validateState, ensureDefaultFailContract, formatValidationErrors } from "./schema.js";

// ============================================================================
// 文件路径常量
// ============================================================================

/** 锁文件路径 */
const LOCK_PATH = DEFAULT_STATE_PATH + ".lock";

/** 临时文件路径（原子写入中间文件） */
const TMP_PATH = DEFAULT_STATE_PATH + ".tmp";

/** 备份文件路径 */
const BAK_PATH = DEFAULT_STATE_PATH + ".bak";

/** 锁超时时间（毫秒）——超时视为孤儿锁 */
const LOCK_TIMEOUT_MS = 60_000;

/** state.json 目录路径 */
const STATE_DIR = dirname(DEFAULT_STATE_PATH);

// ============================================================================
// 状态读取
// ============================================================================

/**
 * 从磁盘加载 LoopState
 *
 * 执行流程：
 * 1. 检查 state.json 是否存在
 * 2. 读取并 JSON 解析
 * 3. 运行 Schema 验证
 * 4. 应用 Default-FAIL 合约（修复缺失字段）
 *
 * @returns 加载的 LoopState 对象，若文件不存在则返回 null
 * @throws 若文件存在但 JSON 解析失败或 Schema 验证失败
 */
export function loadState(): LoopState | null {
  if (!existsSync(DEFAULT_STATE_PATH)) {
    return null;
  }

  const raw = readFileSync(DEFAULT_STATE_PATH, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // JSON 解析失败 —— 尝试从备份恢复
    if (existsSync(BAK_PATH)) {
      const bakRaw = readFileSync(BAK_PATH, "utf-8");
      parsed = JSON.parse(bakRaw);
    } else {
      throw new Error(
        `state.json JSON 解析失败且无可用备份: ${(e as Error).message}`,
      );
    }
  }

  const state = parsed as LoopState;

  // 运行 Schema 验证
  const validation = validateState(state);
  if (!validation.valid) {
    throw new Error(
      `state.json Schema 验证失败:\n${formatValidationErrors(validation)}`,
    );
  }

  // Default-FAIL 合约
  return ensureDefaultFailContract(state);
}

/**
 * 从磁盘加载 LoopState（带默认值）
 *
 * 如果 state.json 不存在，返回 null 而不是抛出异常。
 * 用于引擎初始化时的试探性加载。
 *
 * @returns LoopState 或 null
 */
export function tryLoadState(): LoopState | null {
  try {
    return loadState();
  } catch {
    return null;
  }
}

// ============================================================================
// 原子写入
// ============================================================================

/**
 * 原子写入 state.json
 *
 * 写入流程（确保不会出现半写入文件）：
 * 1. 确保目录存在
 * 2. 验证 Schema（写入前校验）
 * 3. 写入临时文件 .tmp
 * 4. fsync 临时文件（强制刷盘）
 * 5. 校验临时文件可解析
 * 6. 备份旧文件 -> .bak（如果存在）
 * 7. rename .tmp -> state.json（原子操作）
 * 8. fsync 父目录（确保 rename 元数据持久化）
 *
 * @param state - 待持久化的 LoopState 对象
 * @throws 若 Schema 验证失败
 */
export function saveState(state: LoopState): void {
  // Schema 验证（写入前门控）
  const validation = validateState(state);
  if (!validation.valid) {
    throw new Error(
      `写入前 Schema 验证失败:\n${formatValidationErrors(validation)}`,
    );
  }

  atomicWrite(state);
}

/**
 * 底层原子写入实现
 *
 * 执行 tmp -> fsync -> backup -> rename -> fsync dir 五步流程。
 *
 * @param state - 待写入的 LoopState
 */
export function atomicWrite(state: LoopState): void {
  // 1. 确保目录存在
  mkdirSync(STATE_DIR, { recursive: true });

  // 2. 序列化并写入临时文件
  const serialized = JSON.stringify(state, null, 2);
  writeFileSync(TMP_PATH, serialized, "utf-8");

  // 3. fsync 临时文件
  try {
    const tmpFd = openSync(TMP_PATH, "r+");
    fsyncSync(tmpFd);
    closeSync(tmpFd);
  } catch {
    // fsync 失败不影响原子性（rename 本身是原子的）
  }

  // 4. 校验临时文件可解析（二次验证）
  try {
    JSON.parse(readFileSync(TMP_PATH, "utf-8"));
  } catch (e) {
    throw new Error(`临时文件 JSON 解析失败: ${(e as Error).message}`);
  }

  // 5. 备份旧文件
  if (existsSync(DEFAULT_STATE_PATH)) {
    try {
      writeFileSync(BAK_PATH, readFileSync(DEFAULT_STATE_PATH), "utf-8");
    } catch {
      // 备份失败不阻塞写入——丢失备份可接受
    }
  }

  // 6. 原子 rename（同一文件系统内保证原子性）
  renameSync(TMP_PATH, DEFAULT_STATE_PATH);

  // 7. fsync 父目录（确保 rename 元数据持久化到磁盘）
  try {
    const dirFd = openSync(STATE_DIR, "r");
    fsyncSync(dirFd);
    closeSync(dirFd);
  } catch {
    // 父目录 fsync 失败——最坏情况是断电后丢失本次写入
    // 有 .tmp 和 .bak 兜底，下次启动可从备份恢复
  }
}

/**
 * 批量原子写入 state.json（多次更新合并为一次写入）
 *
 * 使用 mutator 函数修改 state 后一次性写入磁盘，
 * 避免多次 atomicWrite 带来的 I/O 开销。
 *
 * @param state - 当前 LoopState（会被原地修改）
 * @param mutator - 修改 state 的函数
 */
export function batchUpdate(
  state: LoopState,
  mutator: (s: LoopState) => void,
): void {
  mutator(state);
  saveState(state);
}

// ============================================================================
// 备份和恢复
// ============================================================================

/**
 * 从备份文件恢复 state.json
 *
 * 恢复流程：
 * 1. 检查 .bak 文件是否存在
 * 2. 读取并解析 .bak
 * 3. Schema 验证
 * 4. 写入 state.json
 *
 * @returns 恢复后的 LoopState，若无备份则返回 null
 */
export function restoreFromBackup(): LoopState | null {
  if (!existsSync(BAK_PATH)) {
    return null;
  }

  const raw = readFileSync(BAK_PATH, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // 备份文件损坏
  }

  const state = parsed as LoopState;
  const validation = validateState(state);
  if (!validation.valid) {
    return null; // 备份文件 Schema 版本不兼容
  }

  // 写入恢复后的状态
  saveState(ensureDefaultFailContract(state));
  return state;
}

/**
 * 创建显式备份快照（命名备份）
 *
 * 将当前 state.json 复制到带时间戳的备份文件，
 * 用于调试或手工回滚场景。
 *
 * @param label - 备份标签（会追加到文件名）
 * @returns 备份文件路径，若 state.json 不存在则返回 null
 */
export function createNamedBackup(label: string): string | null {
  if (!existsSync(DEFAULT_STATE_PATH)) {
    return null;
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${DEFAULT_STATE_PATH}.backup-${label}-${ts}`;
  try {
    writeFileSync(backupPath, readFileSync(DEFAULT_STATE_PATH), "utf-8");
    return backupPath;
  } catch {
    return null;
  }
}

// ============================================================================
// 锁管理
// ============================================================================

/**
 * 获取文件锁（防止并发写入 state.json）
 *
 * 如果锁文件已存在但超过 LOCK_TIMEOUT_MS，视为孤儿锁并强制清除。
 *
 * @returns 是否成功获取锁
 */
export function acquireLock(): boolean {
  if (existsSync(LOCK_PATH)) {
    try {
      const stat = statSync(LOCK_PATH);
      const age = Date.now() - stat.mtimeMs;
      if (age > LOCK_TIMEOUT_MS) {
        // 孤儿锁——超时强制清理
        try {
          unlinkSync(LOCK_PATH);
        } catch {
          return false;
        }
      } else {
        return false; // 有效锁，拒绝获取
      }
    } catch {
      // stat 失败——清除可能损坏的锁文件
      try {
        unlinkSync(LOCK_PATH);
      } catch {
        return false;
      }
    }
  }

  // 创建锁文件（写入当前 PID 便于调试）
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(LOCK_PATH, String(process.pid), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 释放文件锁
 *
 * 仅在锁文件内容为当前进程 PID 时释放，防止误释放其他进程的锁。
 */
export function releaseLock(): void {
  try {
    if (!existsSync(LOCK_PATH)) return;
    const content = readFileSync(LOCK_PATH, "utf-8").trim();
    if (content === String(process.pid)) {
      unlinkSync(LOCK_PATH);
    } else {
      // 锁不属于本进程——可能被外部清理或孤儿锁已被自己之前清除
      unlinkSync(LOCK_PATH);
    }
  } catch {
    // 锁文件已被删除或不可访问——视为已释放
  }
}

/**
 * 检查锁状态
 *
 * @returns 锁信息：是否锁定、锁定 PID、持锁时长
 */
export function checkLock(): {
  locked: boolean;
  pid: string | null;
  ageMs: number | null;
} {
  if (!existsSync(LOCK_PATH)) {
    return { locked: false, pid: null, ageMs: null };
  }

  try {
    const stat = statSync(LOCK_PATH);
    const pid = readFileSync(LOCK_PATH, "utf-8").trim();
    return {
      locked: true,
      pid,
      ageMs: Date.now() - stat.mtimeMs,
    };
  } catch {
    return { locked: false, pid: null, ageMs: null };
  }
}

// ============================================================================
// Phase 转换
// ============================================================================

/**
 * 执行 phase 转换并记录历史
 *
 * 记录 from/to/timestamp 到 phase_transitions 数组。
 * 如果目标 phase 是终止阶段，同时更新 termination 字段。
 *
 * @param state - 当前 LoopState（会被原地修改）
 * @param targetPhase - 目标 phase
 * @param reason - 转换原因（记录到路由历史）
 */
export function transitionPhase(
  state: LoopState,
  targetPhase: Phase,
  reason: string,
): void {
  const fromPhase = state.progress.phase;

  // 记录转换历史
  state.progress.phase_transitions.push({
    from: fromPhase,
    to: targetPhase,
    at: new Date().toISOString(),
  });

  // 记录路由历史
  state.routing_history.push({
    from_phase: fromPhase,
    to_phase: targetPhase,
    reason,
    timestamp: new Date().toISOString(),
  });

  // 更新 phase
  state.progress.phase = targetPhase;

  // 如果是终止阶段，更新 termination
  if (TERMINAL_PHASES.includes(targetPhase)) {
    state.termination = {
      status: targetPhase as "complete" | "paused" | "failed",
      completed_at: new Date().toISOString(),
      exit_reason: reason,
    };
  }
}

/**
 * 检查当前 phase 是否为终端阶段
 *
 * @param phase - 当前 phase 值
 * @returns 是否为终端阶段
 */
export function isTerminalPhase(phase: Phase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

/**
 * 回滚到上一个 phase
 *
 * 从 phase_transitions 历史中获取上一个非终端的 phase
 * 并恢复到该 phase。用于 agent 调用失败后的回退逻辑。
 *
 * @param state - 当前 LoopState（会被原地修改）
 * @returns 是否成功回滚
 */
export function rollbackPhase(state: LoopState): boolean {
  const history = state.progress.phase_transitions;
  if (history.length === 0) return false;

  // 移除最后一个转换记录
  const lastTransition = history.pop()!;

  // 恢复到上一个 phase
  state.progress.phase = lastTransition.from;

  // 如果当前是失败状态，恢复为 running
  if (state.termination.status === "failed") {
    state.termination = {
      status: "running",
      completed_at: null,
      exit_reason: null,
    };
  }

  // 记录回滚
  state.routing_history.push({
    from_phase: lastTransition.to,
    to_phase: lastTransition.from,
    reason: `回滚: 从 ${lastTransition.to} 恢复到 ${lastTransition.from}`,
    timestamp: new Date().toISOString(),
  });

  return true;
}

/**
 * 获取 phase 转换历史摘要
 *
 * @param state - 当前 LoopState
 * @returns 格式化的转换历史字符串
 */
export function getTransitionSummary(state: LoopState): string {
  if (state.progress.phase_transitions.length === 0) {
    return "无转换历史";
  }

  return state.progress.phase_transitions
    .map((t) => `${t.from} -> ${t.to} (${t.at})`)
    .join("\n");
}

// ============================================================================
// state.json 健康检查
// ============================================================================

/**
 * 检查 state.json 文件健康状态
 *
 * 检查项：
 * - 文件是否存在
 * - JSON 是否可解析
 * - Schema 是否通过
 * - 锁是否被持有
 * - 备份文件是否可用
 *
 * @returns 健康检查结果
 */
export function healthCheck(): {
  healthy: boolean;
  stateExists: boolean;
  stateValid: boolean;
  lockHeld: boolean;
  backupAvailable: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  const stateExists = existsSync(DEFAULT_STATE_PATH);
  let stateValid = false;
  const lockHeld = existsSync(LOCK_PATH);
  const backupAvailable = existsSync(BAK_PATH);

  if (!stateExists) {
    issues.push("state.json 不存在");
  } else {
    try {
      const state = JSON.parse(readFileSync(DEFAULT_STATE_PATH, "utf-8"));
      const validation = validateState(state);
      stateValid = validation.valid;
      if (!stateValid) {
        issues.push(`Schema 验证失败: ${formatValidationErrors(validation)}`);
      }
    } catch {
      issues.push("state.json JSON 解析失败");
    }
  }

  if (lockHeld) {
    const lock = checkLock();
    if (lock.ageMs && lock.ageMs > LOCK_TIMEOUT_MS) {
      issues.push(`锁文件存在但已超时 (${Math.round(lock.ageMs / 1000)}s)，可能为孤儿锁`);
    } else {
      issues.push(`锁文件被进程 ${lock.pid} 持有`);
    }
  }

  if (!backupAvailable) {
    issues.push("无可用备份文件");
  }

  return {
    healthy: stateExists && stateValid && !lockHeld,
    stateExists,
    stateValid,
    lockHeld,
    backupAvailable,
    issues,
  };
}

/**
 * 删除所有状态相关文件（state.json + .lock + .tmp + .bak）
 *
 * 用于重置或清理。谨慎使用——会丢失所有运行时状态。
 *
 * @returns 成功删除的文件路径列表
 */
export function purgeStateFiles(): string[] {
  const files = [DEFAULT_STATE_PATH, LOCK_PATH, TMP_PATH, BAK_PATH];
  const removed: string[] = [];

  for (const f of files) {
    try {
      if (existsSync(f)) {
        unlinkSync(f);
        removed.push(f);
      }
    } catch {
      // 删除失败则跳过
    }
  }

  return removed;
}
