import type { LoopState } from "./types.js";
import type { GateResult } from "./gate-dangerous-ops.js";

/**
 * G5 文件变更审计钩子 — gateFileChanges
 *
 * 在一个循环周期内统计 Agent 修改的文件数量，根据信任等级决定是否放行。
 * - L1（低信任）：修改文件数 > 3 时暂停，要求人工审核。
 * - L2（中信任）：修改文件数 > 10 时暂停。
 * - L3（高信任）：一律放行。
 *
 * 设计意图：防止 Agent 在单次循环中批量修改过多文件，造成难以审计的变更风暴。
 *
 * @param changedFiles - 当前循环中被修改的文件路径列表（绝对路径或相对路径均可）
 * @param trustLevel   - 当前信任等级： "L1" | "L2" | "L3"
 * @returns GateResult - pass 为 true 表示允许继续；blocks 包含触发阻断的文件名
 *
 * @example
 * ```ts
 * const result = gateFileChanges(
 *   ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
 *   "L1"
 * );
 * // result.pass === false, result.blocks.length > 0
 * ```
 */
export function gateFileChanges(
  changedFiles: string[],
  trustLevel: string
): GateResult {
  const fileCount = changedFiles.length;

  switch (trustLevel) {
    case "L1": {
      // L1 模式：超过 3 个文件即暂停
      if (fileCount > 3) {
        return {
          pass: false,
          blocks: changedFiles,
          reason: `[G5] L1 信任等级：本次循环修改了 ${fileCount} 个文件（上限 3），需要人工审核。`,
        };
      }
      return { pass: true, blocks: [] };
    }

    case "L2": {
      // L2 模式：超过 10 个文件即暂停
      if (fileCount > 10) {
        return {
          pass: false,
          blocks: changedFiles,
          reason: `[G5] L2 信任等级：本次循环修改了 ${fileCount} 个文件（上限 10），需要人工审核。`,
        };
      }
      return { pass: true, blocks: [] };
    }

    case "L3": {
      // L3 模式：完全信任，一律放行
      return { pass: true, blocks: [] };
    }

    default: {
      // 未知信任等级，保守处理：按 L1 标准
      if (fileCount > 3) {
        return {
          pass: false,
          blocks: changedFiles,
          reason: `[G5] 未知信任等级 "${trustLevel}"，已回退为 L1 策略：本次循环修改了 ${fileCount} 个文件（上限 3）。`,
        };
      }
      return { pass: true, blocks: [] };
    }
  }
}
