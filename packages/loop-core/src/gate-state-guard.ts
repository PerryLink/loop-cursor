import type { GateResult } from "./gate-dangerous-ops.js";

/**
 * 受保护的目录列表 — loop-cursor 内部文件所在路径前缀。
 * 任何 Agent 对这些路径的写入都将被 G7 无条件阻断。
 */
const PROTECTED_PATHS = [
  ".cursor/loop-cursor/",
  ".cursor/rules/",
] as const;

/**
 * G7 状态守护钩子 — gateStateGuard
 *
 * 保护 loop-cursor 自身的内部文件不被 Agent 意外（或恶意）修改。
 * 该门控采用“零信任”策略：无论信任等级如何，只要目标路径
 * 位于受保护目录内，**一律阻断**。
 *
 * 设计意图：
 * - 防止 Agent 破坏自身运行所需的配置文件、规则文件和状态快照。
 * - 阻断是不可协商的安全措施，不随信任等级升级而放宽。
 *
 * @param targetPath - Agent 将要写入/修改的文件路径（绝对或相对均可）
 * @returns GateResult - 若路径受保护则 pass: false，blocks 包含该路径
 *
 * @example
 * ```ts
 * const result = gateStateGuard(".cursor/loop-cursor/state.json");
 * // result.pass === false
 * // result.blocks === [".cursor/loop-cursor/state.json"]
 * // result.reason 包含阻断说明
 * ```
 *
 * @example
 * ```ts
 * const result = gateStateGuard("src/utils/helper.ts");
 * // result.pass === true（正常业务文件，不受保护）
 * ```
 */
export function gateStateGuard(targetPath: string): GateResult {
  // 统一使用正斜杠，便于跨平台比较
  const normalized = targetPath.replace(/\\/g, "/");

  // 判断目标路径是否落入任一受保护目录
  const isProtected = PROTECTED_PATHS.some((prefix) =>
    normalized.startsWith(prefix)
  );

  if (isProtected) {
    return {
      pass: false,
      blocks: [targetPath],
      reason:
        `[G7] 路径 "${targetPath}" 位于 loop-cursor 受保护目录内，` +
        `Agent 禁止修改内部状态文件。任何信任等级均不可绕过。`,
    };
  }

  return {
    pass: true,
    blocks: [],
  };
}
