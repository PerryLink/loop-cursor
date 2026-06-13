/**
 * loop-cursor 工作树管理 (Worktree Manager)
 *
 * 负责 git worktree 的完整生命周期管理：
 * - 并发工作树创建（用于隔离实施环境）
 * - 清理所有工作树（所有终止路径：complete / paused / failed）
 * - 泄漏检测（识别未正确清理的孤儿工作树）
 *
 * 设计意图：
 * - 主工作区不受 agent 修改影响，实施完成后可选择性合并
 * - 每个修复任务可以在独立 worktree 中并行执行
 * - 终止时强制清理，防止磁盘泄漏
 *
 * @module worktree
 * @version 0.1.0
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

// ============================================================================
// 类型定义
// ============================================================================

/** 工作树信息 */
export interface WorktreeInfo {
  /** 工作树在文件系统中的绝对路径 */
  path: string;
  /** 关联的分支名 */
  branch: string;
  /** HEAD 提交哈希 */
  head: string;
  /** 是否为当前工作树（当前所在目录） */
  isCurrent: boolean;
  /** 是否为 loop-cursor 管理的工作树 */
  isManaged: boolean;
}

/** 工作树创建选项 */
export interface WorktreeCreateOptions {
  /** 分支名（可选，自动生成 loop-cursor/task-<timestamp>） */
  branchName?: string;
  /** 基础提交（默认 HEAD） */
  baseRef?: string;
  /** 是否为新 orphan 分支（不继承历史，默认 false） */
  detached?: boolean;
}

/** 工作树清理选项 */
export interface WorktreeCleanupOptions {
  /** 是否强制删除（跳过未提交变更确认） */
  force?: boolean;
  /** 是否清理 git 分支引用 */
  pruneBranch?: boolean;
  /** 清理超时（毫秒），默认 15000 */
  timeoutMs?: number;
}

/** 工作树泄漏检测结果 */
export interface WorktreeLeakResult {
  /** 是否发现泄漏 */
  leaked: boolean;
  /** 泄漏的工作树路径列表 */
  leakedPaths: string[];
  /** 总计扫描数 */
  totalScanned: number;
  /** 其中 loop-cursor 管理的工作树数 */
  managedCount: number;
  /** 已自动清理数 */
  autoCleaned: number;
}

// ============================================================================
// 常量
// ============================================================================

/** loop-cursor 工作树管理目录（相对于项目根目录） */
const WORKTREE_BASE_DIR = ".cursor/loop-cursor/worktrees";

/** 工作树分支名前缀 */
const WORKTREE_BRANCH_PREFIX = "loop-cursor/task-";

/** 工作树闲置判定阈值（毫秒）—— 超过此时间未修改视为可能泄漏 */
const WORKTREE_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 小时

// ============================================================================
// 工作树创建
// ============================================================================

/**
 * 创建一个新的 git worktree
 *
 * 在 .cursor/loop-cursor/worktrees/ 目录下创建隔离的工作树。
 * 分支名自动生成（基于时间戳），避免冲突。
 *
 * @param projectRoot - 项目根目录的绝对路径
 * @param options - 创建选项
 * @returns 创建的工作树信息
 * @throws 若 git worktree add 失败
 */
export function createWorktree(
  projectRoot: string,
  options: WorktreeCreateOptions = {},
): WorktreeInfo {
  const baseDir = join(projectRoot, WORKTREE_BASE_DIR);
  const branchName =
    options.branchName ??
    `${WORKTREE_BRANCH_PREFIX}${Date.now().toString(36)}`;
  const taskId = branchName.replace(WORKTREE_BRANCH_PREFIX, "");
  const worktreePath = join(baseDir, taskId);

  // 确保基目录存在
  mkdirSync(baseDir, { recursive: true });

  // 如果目标路径已存在，追加随机后缀
  let finalPath = worktreePath;
  let retry = 0;
  while (existsSync(finalPath) && retry < 10) {
    finalPath = `${worktreePath}-${Math.random().toString(36).slice(2, 6)}`;
    retry++;
  }

  // 构造 git worktree add 命令
  const args = ["worktree", "add"];
  if (options.detached) {
    args.push("--detach");
  }
  args.push(finalPath);

  if (options.baseRef) {
    args.push(options.baseRef);
  }

  // 执行创建
  try {
    execSync(`git ${args.join(" ")}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 15_000,
      stdio: "pipe",
    });

    // 在新 worktree 中创建分支（如果需要）
    if (!options.detached) {
      try {
        execSync(`git checkout -b ${branchName}`, {
          cwd: finalPath,
          encoding: "utf-8",
          timeout: 10_000,
          stdio: "pipe",
        });
      } catch {
        // 分支可能已存在，使用已有分支
      }
    }

    return getWorktreeInfo(finalPath, projectRoot);
  } catch (e) {
    throw new Error(
      `无法创建 worktree 在 ${finalPath}: ${(e as Error).message}`,
    );
  }
}

/**
 * 并发创建多个工作树
 *
 * 适用于并行修复多个独立 P2 issue 的场景。
 * 限制最大并发数以避免 I/O 拥塞。
 *
 * @param projectRoot - 项目根目录
 * @param count - 需要创建的工作树数量
 * @param options - 创建选项（所有工作树共享）
 * @returns 创建的工作树信息列表
 */
export function createMultipleWorktrees(
  projectRoot: string,
  count: number,
  options: WorktreeCreateOptions = {},
): WorktreeInfo[] {
  const result: WorktreeInfo[] = [];

  for (let i = 0; i < count; i++) {
    const branchName = `${WORKTREE_BRANCH_PREFIX}${Date.now().toString(36)}-${i}`;
    const info = createWorktree(projectRoot, {
      ...options,
      branchName,
    });
    result.push(info);
  }

  return result;
}

// ============================================================================
// 工作树查询
// ============================================================================

/**
 * 获取指定路径的工作树详细信息
 *
 * @param worktreePath - 工作树路径
 * @param projectRoot - 项目根目录（用于解析相对路径）
 * @returns 工作树信息
 */
function getWorktreeInfo(
  worktreePath: string,
  projectRoot: string,
): WorktreeInfo {
  const allWorktrees = listAllWorktrees(projectRoot);
  const found = allWorktrees.find(
    (w) => resolve(w.path) === resolve(worktreePath),
  );

  if (found) return found;

  // 构造基本信息
  return {
    path: worktreePath,
    branch: "unknown",
    head: "unknown",
    isCurrent: false,
    isManaged: worktreePath.includes(WORKTREE_BASE_DIR),
  };
}

/**
 * 列出项目中所有 git worktree
 *
 * @param projectRoot - 项目根目录
 * @returns 所有工作树信息列表
 */
export function listAllWorktrees(projectRoot: string): WorktreeInfo[] {
  try {
    const output = execSync("git worktree list --porcelain", {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: "pipe",
    });

    return parseWorktreePorcelain(output, projectRoot);
  } catch {
    return [];
  }
}

/**
 * 列出 loop-cursor 管理的工作树
 *
 * @param projectRoot - 项目根目录
 * @returns loop-cursor 管理的工作树列表
 */
export function listManagedWorktrees(projectRoot: string): WorktreeInfo[] {
  return listAllWorktrees(projectRoot).filter((w) => w.isManaged);
}

/**
 * 解析 git worktree list --porcelain 输出
 */
function parseWorktreePorcelain(
  output: string,
  projectRoot: string,
): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      // 保存上一个
      if (current.path) {
        worktrees.push(finalizeWorktreeEntry(current, projectRoot));
      }
      current = { path: line.slice("worktree ".length).trim() };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim();
    } else if (line.startsWith("detached")) {
      current.branch = "(detached)";
    }
  }

  // 保存最后一个
  if (current.path) {
    worktrees.push(finalizeWorktreeEntry(current, projectRoot));
  }

  return worktrees;
}

/** 补齐 worktree 条目缺失字段 */
function finalizeWorktreeEntry(
  partial: Partial<WorktreeInfo>,
  projectRoot: string,
): WorktreeInfo {
  const path = partial.path ?? "";
  return {
    path,
    branch: partial.branch ?? "unknown",
    head: partial.head ?? "unknown",
    isCurrent: path === projectRoot,
    isManaged: path.includes(WORKTREE_BASE_DIR),
  };
}

// ============================================================================
// 工作树清理
// ============================================================================

/**
 * 移除单个工作树
 *
 * @param projectRoot - 项目根目录
 * @param worktreePath - 待移除的工作树路径
 * @param options - 清理选项
 * @returns 是否成功移除
 */
export function removeWorktree(
  projectRoot: string,
  worktreePath: string,
  options: WorktreeCleanupOptions = {},
): boolean {
  if (!existsSync(worktreePath)) {
    return true; // 路径已不存在，视为已清理
  }

  const force = options.force ?? true;
  const timeout = options.timeoutMs ?? 15_000;

  try {
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(`"${worktreePath}"`);

    execSync(`git ${args.join(" ")}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout,
      stdio: "pipe",
    });

    // 如果 git worktree remove 未清理目录，手动清理
    if (existsSync(worktreePath)) {
      try {
        rmdirSync(worktreePath, { recursive: true });
      } catch {
        // 手动清理也失败——可能在 Windows 上有进程占用
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * 清理所有 loop-cursor 管理的工作树
 *
 * 在以下终止路径调用：
 * - complete：实施完成，清理所有隔离环境
 * - paused：暂停等待，清理临时工作树
 * - failed：异常终止，强制清理所有残留
 *
 * @param projectRoot - 项目根目录
 * @param options - 清理选项
 * @returns 成功清理的工作树路径列表
 */
export function cleanupAllManagedWorktrees(
  projectRoot: string,
  options: WorktreeCleanupOptions = {},
): string[] {
  const managed = listManagedWorktrees(projectRoot);
  const cleaned: string[] = [];

  for (const wt of managed) {
    // 跳过当前工作树（正在使用中）
    if (wt.isCurrent) continue;

    if (removeWorktree(projectRoot, wt.path, options)) {
      cleaned.push(wt.path);
    }
  }

  // 清理空的基目录
  const baseDir = join(projectRoot, WORKTREE_BASE_DIR);
  if (existsSync(baseDir)) {
    try {
      const entries = readdirSync(baseDir);
      if (entries.length === 0) {
        rmdirSync(baseDir);
      }
    } catch {
      // 目录可能不空或被占用
    }
  }

  return cleaned;
}

// ============================================================================
// 泄漏检测
// ============================================================================

/**
 * 检测工作树泄漏
 *
 * 扫描 loop-cursor 管理目录下的工作树，检查是否有：
 * - 超过闲置阈值（24h）的工作树
 * - 路径存在但不在 git worktree list 中的孤儿目录
 * - 已损坏的工作树（worktree 路径存在但 git 元数据损坏）
 *
 * @param projectRoot - 项目根目录
 * @returns 泄漏检测结果
 */
export function detectWorktreeLeaks(projectRoot: string): WorktreeLeakResult {
  const baseDir = join(projectRoot, WORKTREE_BASE_DIR);
  const gitWorktrees = listAllWorktrees(projectRoot);
  const managedInGit = gitWorktrees.filter((w) => w.isManaged);
  const leakedPaths: string[] = [];
  let autoCleaned = 0;

  // 检查文件系统上是否存在但不在 git worktree list 中的目录
  if (existsSync(baseDir)) {
    try {
      const dirEntries = readdirSync(baseDir);
      const gitPaths = new Set(
        managedInGit.map((w) => resolve(w.path)),
      );

      for (const entry of dirEntries) {
        const fullPath = resolve(join(baseDir, entry));

        // 跳过非目录
        try {
          if (!statSync(fullPath).isDirectory()) continue;
        } catch {
          continue;
        }

        if (!gitPaths.has(fullPath)) {
          // 孤儿目录：文件系统有但 git 不知道
          leakedPaths.push(fullPath);
        }
      }
    } catch {
      // 目录读取失败
    }

    // 检查 git 中已知的工作树是否过期
    const now = Date.now();
    for (const wt of managedInGit) {
      try {
        const stat = statSync(wt.path);
        const age = now - stat.mtimeMs;
        if (age > WORKTREE_STALE_THRESHOLD_MS) {
          if (!leakedPaths.includes(wt.path)) {
            leakedPaths.push(wt.path);
          }
        }
      } catch {
        // stat 失败——路径可能已损坏
        if (!leakedPaths.includes(wt.path)) {
          leakedPaths.push(wt.path);
        }
      }
    }
  }

  // 尝试自动清理泄漏
  for (const path of leakedPaths) {
    if (removeWorktree(projectRoot, path, { force: true })) {
      autoCleaned++;
    }
  }

  // 更新泄漏列表（排除已自动清理的）
  const remainingLeaks = leakedPaths.filter((p) => existsSync(p));

  return {
    leaked: remainingLeaks.length > 0,
    leakedPaths: remainingLeaks,
    totalScanned: gitWorktrees.length,
    managedCount: managedInGit.length,
    autoCleaned,
  };
}

/**
 * 执行工作树健康检查
 *
 * 在所有终止路径（complete / paused / failed）调用：
 * 1. 检测泄漏
 * 2. 清理所有被管理的工作树
 * 3. 报告结果
 *
 * @param projectRoot - 项目根目录
 * @returns 清理结果摘要
 */
export function performWorktreeHealthCheck(projectRoot: string): {
  leaksFound: number;
  leaksCleaned: number;
  worktreesCleaned: string[];
  healthy: boolean;
} {
  // 步骤 1：检测泄漏
  const leakResult = detectWorktreeLeaks(projectRoot);

  // 步骤 2：清理所有被管理的工作树
  const cleaned = cleanupAllManagedWorktrees(projectRoot, { force: true });

  // 步骤 3：再次检测（验证清理效果）
  const postLeakResult = detectWorktreeLeaks(projectRoot);

  return {
    leaksFound: leakResult.leakedPaths.length,
    leaksCleaned: leakResult.autoCleaned,
    worktreesCleaned: cleaned,
    healthy: !postLeakResult.leaked,
  };
}
