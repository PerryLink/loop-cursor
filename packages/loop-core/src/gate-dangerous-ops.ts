/**
 * G4 危险操作闸门 — 拦截灾难性命令
 * rm -rf / | mkfs | dd 写 /dev | chmod 777 / | DROP TABLE | git push -f main | fork bomb
 * L1/L2: 全部拦截 | L3: 放行并附警告
 * @module gate-dangerous-ops
 */

import type { TrustLevel } from "./types.js";

// ============================================================================
// 类型
// ============================================================================

export interface GateResult { pass: boolean; blocks: string[]; reason?: string }

// ============================================================================
// 危险命令规则
// ============================================================================

interface DRule { regex: RegExp; label: string; s: "critical" | "high" }

const R: DRule[] = [
  { regex: /\brm\s+(?:-[a-z]*r[a-z]*f?[a-z]*|-rf?|--recursive).*\s+\/(?:\s|$)/i, label: "rm -rf /", s: "critical" },
  { regex: /\brm\s+(?:-[a-z]*r[a-z]*f?[a-z]*|-rf?|--recursive).*\s+\/\*/i,         label: "rm -rf /*", s: "critical" },
  { regex: /\brm\s+(?:-[a-z]*r[a-z]*f?[a-z]*|-rf?|--recursive).*\s+\/(?:home|etc|usr|var|opt|boot|srv|root|sys|proc|dev)\b/i, label: "rm -rf 系统目录", s: "critical" },
  { regex: /\bmkfs\.\S+/i,                           label: "mkfs 格式化", s: "critical" },
  { regex: /\bdd\s+.*of=\/dev\//i,                   label: "dd 写入 /dev", s: "critical" },
  { regex: /\bdd\s+.*if=\/dev\/(?:zero|urandom|random)\s+.*of=/i, label: "dd 覆写磁盘", s: "critical" },
  { regex: /\bchmod\s+(?:-R|--recursive)?\s*777\s+\//i, label: "chmod 777 /", s: "critical" },
  { regex: /\bchmod\s+(?:-R|--recursive)?\s*777\s+\/(?:home|etc|usr|var|opt|bin|sbin)/i, label: "chmod 777 系统目录", s: "high" },
  { regex: /\bchown\s+(?:-R|--recursive)?\s*[^:\s]+:[^:\s]*\s+\//i, label: "chown -R /", s: "critical" },
  { regex: /\bDROP\s+TABLE\s+/i,                     label: "DROP TABLE", s: "critical" },
  { regex: /\bDROP\s+DATABASE\s+/i,                  label: "DROP DATABASE", s: "critical" },
  { regex: /\bTRUNCATE\s+(?:TABLE\s+)?\S+/i,         label: "TRUNCATE TABLE", s: "high" },
  { regex: /\bgit\s+push\s+(?:--force|-f)\s+\S+\s+(?:main|master)\b/i, label: "git push -f main", s: "critical" },
  { regex: /\bgit\s+push\s+--force-with-lease\s+\S+\s+(?:main|master)\b/i, label: "git push --force-with-lease main", s: "high" },
  { regex: /\bgit\s+reset\s+--hard\s+origin\/(?:main|master)\b/i, label: "git reset --hard origin/main", s: "high" },
  { regex: /:\s*\(\s*\)\s*\{?\s*:\s*\|?\s*:\s*&?\s*\}?\s*;\s*:/, label: "Fork bomb", s: "critical" },
  { regex: />\s*\/dev\/sd[a-z]+/i,                   label: "覆写块设备 /dev/sd*", s: "critical" },
];

// ============================================================================
// 导出函数
// ============================================================================

/**
 * G4 危险操作闸门
 * L1/L2 拦截所有危险命令 | L3 放行并携带警告
 * @param command - shell 命令字符串
 * @param trustLevel - "L1"|"L2"|"L3"
 */
export function gateDangerousOps(command: string, trustLevel: TrustLevel): GateResult {
  if (!command || typeof command !== "string") return { pass: true, blocks: [] };

  const hits = R.filter(r => r.regex.test(command));
  if (hits.length === 0) return { pass: true, blocks: [] };

  const crit = hits.filter(h => h.s === "critical").length;
  const labels = hits.map(h => h.label).join(", ");

  // L3: 放行，附带警告
  if (trustLevel === "L3") {
    return {
      pass: true, blocks: [],
      reason: `[L3] 放行 ${hits.length} 项危险操作（${crit} 项灾难级）：${labels}。请谨慎！`,
    };
  }

  // L1 / L2: 拦截
  return {
    pass: false,
    blocks: hits.map(h => h.label),
    reason: `[${trustLevel}] 拦截 ${hits.length} 项危险操作` +
      (crit > 0 ? `（${crit} 项灾难级）` : "") + "，请手动执行",
  };
}
