/**
 * G3 依赖安装安全闸门 — 拦截 npmpipcargo 安装命令
 * L1: 拦截所有 | L2: 拦截非默认源 | L3: 全部放行
 * @module gate-dependency-install
 */

import type { TrustLevel } from "./types.js";

// ============================================================================
// 类型
// ============================================================================

/** 闸门通用返回结果 */
export interface GateResult {
  pass: boolean;
  blocks: string[];
  reason?: string;
}

// ============================================================================
// 命令识别
// ============================================================================

/** 包管理器安装命令模式 */
const INSTALL_PATTERNS = [
  /\bnpm\s+(?:install|i|add)\b/i,
  /\byarn\s+(?:add|install)\b/i,
  /\bpnpm\s+(?:add|install)\b/i,
  /\bpip3?\s+install\b/i,
  /\bcargo\s+install\b/i,
  /\bgo\s+get\b/i,
  /\bbrew\s+install\b/i,
  /\bgem\s+install\b/i,
];

interface FlagRule { regex: RegExp; label: string }

/** 非默认源标志 */
const NON_DEFAULT_FLAGS: FlagRule[] = [
  { regex: /\s--extra-index-url\s+\S+/i, label: "--extra-index-url 第三方索引" },
  { regex: /\s--pre\b/i,                   label: "--pre 预发布版本" },
  { regex: /\s--trusted-host\s+\S+/i,      label: "--trusted-host 非标主机" },
  { regex: /\s--registry\s+\S+/i,          label: "--registry 第三方源" },
  { regex: /\s(?:git\+https?|github:|bitbucket:)/i, label: "从 Git 仓库直接安装" },
  { regex: /(?:curl|wget)\s+.*\|\s*(?:bash|sh|python)/i, label: "curlwget 管道执行" },
];

// ============================================================================
// 导出函数
// ============================================================================

/**
 * G3 依赖安装安全闸门
 * 根据信任级别拦截包管理器安装命令。
 * @param command - shell 命令字符串
 * @param trustLevel - 信任级别 "L1"|"L2"|"L3"
 * @returns GateResult
 */
export function gateDependencyInstall(
  command: string,
  trustLevel: TrustLevel,
): GateResult {
  if (!command || typeof command !== "string") return { pass: true, blocks: [] };

  // L3: 全部放行
  if (trustLevel === "L3") return { pass: true, blocks: [] };

  const isInstall = INSTALL_PATTERNS.some(p => p.test(command));
  if (!isInstall) return { pass: true, blocks: [] };

  // L1: 拦截所有
  if (trustLevel === "L1") {
    return {
      pass: false,
      blocks: ["依赖安装命令"],
      reason: "[L1] 禁止 agent 执行包管理器安装，请手动操作",
    };
  }

  // L2: 检查非默认源
  if (trustLevel === "L2") {
    const blocks = NON_DEFAULT_FLAGS
      .filter(f => f.regex.test(command))
      .map(f => f.label);

    if (blocks.length > 0) {
      return {
        pass: false,
        blocks,
        reason: `[L2] 检测到非默认源：${blocks.join("、")}`,
      };
    }
    return { pass: true, blocks: [] };
  }

  // 未知 trustLevel: 保守拦截
  return {
    pass: false,
    blocks: ["未识别信任级别"],
    reason: `未知 trustLevel "${trustLevel}"，保守拦截`,
  };
}
