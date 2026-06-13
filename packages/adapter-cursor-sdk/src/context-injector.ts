/**
 * ContextInjector —— 跨轮次上下文注入器 (M2)
 *
 * P0-2 workaround 核心模块。由于 @cursor/sdk v1.0.12 的 Local agent
 * 在每次 agent.send() 调用后会清空上下文，loop-cursor 需要在每次
 * 调用前通过 conversation_history[0] 重新注入历史上下文。
 *
 * 职责：
 * 1. 读取 context_summary.md 获取跨轮次历史摘要
 * 2. 构建标准化的上下文头（phase / cycle / goal / 问题状态）
 * 3. 如果有 repair_context，追加精准修复指令
 * 4. 上下文窗口管理——当上下文过大时智能裁剪旧内容
 * 5. 提供 InjectorStateView 接口，从 LoopState 中提取所需字段
 *
 * @module context-injector
 * @version 0.2.0 (M2)
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ConversationMessage } from "@loop-cursor/core";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * InjectorStateView —— 上下文注入器所需的状态视图
 *
 * 从完整的 LoopState 中提取上下文注入所需的关键字段。
 * 这是一个轻量级的视图接口，ContextInjector 不依赖完整的 LoopState 类型。
 */
export interface InjectorStateView {
  /** 当前阶段 ID */
  phase: string;
  /** 当前轮次（agent.send() 调用次数） */
  cycle: number;
  /** 收敛计数器 */
  convergence_counter: number;
  /** 用户原始目标 */
  user_request: string;
  /** 最大轮次上限 */
  max_cycles: number;
  /** 收敛所需轮次 */
  convergence_rounds: number;
  /** 活期问题 */
  issues?: {
    active?: {
      p0?: Array<{ title: string; description?: string; affected_files?: string[] }>;
      p1?: Array<{ title: string; description?: string; affected_files?: string[] }>;
      p2?: Array<{ title: string; description?: string; affected_files?: string[] }>;
    };
    resolved?: { p0: number; p1: number; p2: number };
  };
  /** 修复上下文（routing 到 repair 时设置） */
  repair_context?: {
    target_issues?: Array<{
      severity?: string;
      title: string;
      description?: string;
    }>;
    affected_files?: string[];
    reason?: string;
  };
  /** 任务统计 */
  tasks?: {
    total: number;
    by_status?: Record<string, number>;
  };
}

/**
 * ContextInjector 配置
 */
export interface ContextInjectorConfig {
  /** 项目根目录的绝对路径 */
  projectRoot: string;
  /** context_summary.md 的相对路径（相对于 projectRoot） */
  contextSummaryPath: string;
  /** 上下文最大字节数（超过后触发裁剪），默认 40KB */
  maxContextBytes: number;
  /** 裁剪后保留的尾部字节数，默认 30KB */
  trimKeepBytes: number;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: Omit<ContextInjectorConfig, "projectRoot"> = {
  contextSummaryPath: ".cursor/loop-cursor/artifacts/context-summary.md",
  maxContextBytes: 40 * 1024,
  trimKeepBytes: 30 * 1024,
};

// ============================================================================
// ContextInjector 主类
// ============================================================================

/**
 * ContextInjector —— 跨轮次上下文注入器
 *
 * 在每次 agent.send() 前调用 buildConversationHistory()，
 * 将 context_summary.md 的内容封装为 conversation_history[0]。
 *
 * 使用示例：
 *   const injector = createContextInjector("/path/to/project");
 *   const history = injector.buildConversationHistory(state);
 *   // history 可直接传入 agentCall() 的 conversationHistory 参数
 */
export class ContextInjector {
  private config: Required<ContextInjectorConfig>;

  constructor(config: ContextInjectorConfig) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    } as Required<ContextInjectorConfig>;
  }

  // ========================================================================
  // 公开 API
  // ========================================================================

  /**
   * 构建 conversation_history 数组
   *
   * 这是 ContextInjector 的主入口方法——在每次 agent.send() 前调用。
   * 返回的数组直接传入 agent.send({ conversation_history: [...] })。
   *
   * 构建流程：
   * 1. 从 state 中提取关键信息
   * 2. 读取 context_summary.md（如果存在）
   * 3. 构建标准化上下文头
   * 4. 如果有 repair_context，追加修复指令
   * 5. 如果上下文过大，裁剪旧内容
   *
   * @param state - LoopState 或等效的状态视图对象
   * @returns 对话历史数组
   */
  buildConversationHistory(
    state: InjectorStateView,
  ): ConversationMessage[] {
    // 步骤 1：提取状态信息
    const phase = state.phase ?? "unknown";
    const cycle = state.cycle ?? 1;
    const goal = state.user_request ?? "(unspecified)";

    // 步骤 2：读取上下文摘要
    const contextContent = this.readContextSummary();

    // 步骤 3：构建问题摘要
    const issuesSummary = this.buildIssuesSummary(state);

    // 步骤 4：构建任务摘要
    const taskSummary = this.buildTaskSummary(state);

    // 步骤 5：构建收敛状态摘要
    const convergenceSummary = this.buildConvergenceSummary(state);

    // 步骤 6：组装标准上下文头
    const contextHeader = this.buildContextHeader(
      phase,
      cycle,
      goal,
      contextContent,
      issuesSummary,
      taskSummary,
      convergenceSummary,
    );

    // 步骤 7：构建 conversation_history
    const history: ConversationMessage[] = [
      { role: "user", content: contextHeader },
    ];

    // 步骤 8：如果有 repair_context，追加修复指令
    if (state.repair_context) {
      const repairMsg = this.buildRepairContextMessage(state.repair_context);
      if (repairMsg) {
        history.push({ role: "user", content: repairMsg });
      }
    }

    return history;
  }

  /**
   * 读取 context_summary.md 的内容
   *
   * 如果文件不存在，返回空字符串。
   * 如果文件过大（超过 maxContextBytes），触发裁剪并返回裁剪后的内容。
   *
   * @returns 上下文摘要文本内容
   */
  readContextSummary(): string {
    const fullPath = join(
      this.config.projectRoot,
      this.config.contextSummaryPath,
    );

    if (!existsSync(fullPath)) {
      return "";
    }

    try {
      const stats = statSync(fullPath);

      // 如果文件过大，返回裁剪后的内容
      if (stats.size > this.config.maxContextBytes) {
        return this.trimContextFile(fullPath, stats.size);
      }

      return readFileSync(fullPath, "utf-8");
    } catch (err) {
      console.warn(
        `[ContextInjector] 读取 context_summary.md 失败: ${(err as Error).message}`,
      );
      return "";
    }
  }

  /**
   * 获取上下文摘要文件的完整路径
   *
   * @returns 上下文摘要文件的绝对路径
   */
  getContextSummaryPath(): string {
    return join(
      this.config.projectRoot,
      this.config.contextSummaryPath,
    );
  }

  /**
   * 获取当前上下文的字节大小
   *
   * @returns 上下文文件大小（字节），文件不存在时返回 0
   */
  getContextSize(): number {
    const fullPath = this.getContextSummaryPath();
    if (!existsSync(fullPath)) return 0;
    try {
      return statSync(fullPath).size;
    } catch {
      return 0;
    }
  }

  /**
   * 检查上下文是否超过阈值
   *
   * @returns 上下文是否过大需要裁剪
   */
  isContextOverLimit(): boolean {
    return this.getContextSize() > this.config.maxContextBytes;
  }

  // ========================================================================
  // 上下文头构建
  // ========================================================================

  /**
   * 构建标准化的上下文头
   *
   * 上下文头是注入到 conversation_history[0] 的核心消息。
   * 它告知 agent 当前的阶段、目标、历史摘要、问题状态和收敛情况。
   *
   * 格式：
   * [CONTEXT FROM PREVIOUS CYCLES — READ CAREFULLY]
   * Current Phase: part_2_3
   * Current Cycle: 3 / 5
   * Project Goal: ...
   * Convergence: 1/2 rounds stable
   * Active Issues:
   *   P0: 0 | P1: 2 | P2: 1
   * Tasks: 5/12 completed
   * ---
   * (context_summary.md content)
   * ---
   * [END CONTEXT]
   */
  private buildContextHeader(
    phase: string,
    cycle: number,
    goal: string,
    contextContent: string,
    issuesSummary: string,
    taskSummary: string,
    convergenceSummary: string,
  ): string {
    const lines: string[] = [];

    lines.push("[CONTEXT FROM PREVIOUS CYCLES — READ CAREFULLY BEFORE RESPONDING]");
    lines.push("");
    lines.push(`Current Phase: ${phase}`);
    lines.push(`Current Cycle: ${cycle}`);
    lines.push(`Project Goal: ${goal}`);
    lines.push("");

    // 收敛状态
    if (convergenceSummary) {
      lines.push(`Convergence Status: ${convergenceSummary}`);
      lines.push("");
    }

    // 问题摘要
    if (issuesSummary) {
      lines.push(issuesSummary);
      lines.push("");
    }

    // 任务摘要
    if (taskSummary) {
      lines.push(taskSummary);
      lines.push("");
    }

    // 历史上下文摘要
    if (contextContent.trim().length > 0) {
      lines.push("---");
      lines.push("## Historical Context (Previous Cycles Summary)");
      lines.push("");
      lines.push(contextContent);
      lines.push("---");
    } else {
      lines.push("(This is the first cycle — no previous context available.)");
    }

    lines.push("");
    lines.push("[END CONTEXT — PROCEED WITH YOUR TASK]");

    return lines.join("\n");
  }

  /**
   * 构建问题摘要
   *
   * 从 state 的 issues 中提取活跃问题数量和详情。
   * 如果存在 P0 问题，标注为关键。
   *
   * @param state - 状态视图对象
   * @returns 格式化的多行问题摘要
   */
  private buildIssuesSummary(state: InjectorStateView): string {
    const active = state.issues?.active;
    if (!active) return "";

    const p0s = active.p0 ?? [];
    const p1s = active.p1 ?? [];
    const p2s = active.p2 ?? [];
    const total = p0s.length + p1s.length + p2s.length;

    if (total === 0) {
      return "Active Issues: None — all issues resolved.";
    }

    const lines: string[] = [];
    lines.push(`Active Issues: ${total} total (P0: ${p0s.length}, P1: ${p1s.length}, P2: ${p2s.length})`);

    // 列出 P0 问题（最多 5 个）
    if (p0s.length > 0) {
      lines.push("  CRITICAL (P0):");
      for (const issue of p0s.slice(0, 5)) {
        const files =
          issue.affected_files && issue.affected_files.length > 0
            ? ` [files: ${issue.affected_files.join(", ")}]`
            : "";
        lines.push(`    - ${issue.title}${files}`);
      }
      if (p0s.length > 5) {
        lines.push(`    ... and ${p0s.length - 5} more P0 issues`);
      }
    }

    // 列出 P1 问题（最多 3 个）
    if (p1s.length > 0) {
      lines.push("  IMPORTANT (P1):");
      for (const issue of p1s.slice(0, 3)) {
        lines.push(`    - ${issue.title}`);
      }
      if (p1s.length > 3) {
        lines.push(`    ... and ${p1s.length - 3} more P1 issues`);
      }
    }

    // P2 问题仅显示数量
    if (p2s.length > 0) {
      lines.push(`  Minor (P2): ${p2s.length} issues`);
    }

    return lines.join("\n");
  }

  /**
   * 构建任务进度摘要
   *
   * 从 state 的 tasks 字段提取任务完成情况。
   *
   * @param state - 状态视图对象
   * @returns 格式化的任务摘要
   */
  private buildTaskSummary(state: InjectorStateView): string {
    const tasks = state.tasks;
    if (!tasks || tasks.total === 0) return "";

    const byStatus = tasks.by_status ?? {};
    const completed = byStatus.completed ?? 0;
    const inProgress = byStatus.in_progress ?? 0;
    const pending = byStatus.pending ?? 0;
    const failed = byStatus.failed ?? 0;

    const parts: string[] = [];
    parts.push(`Tasks: ${completed}/${tasks.total} completed`);
    if (inProgress > 0) parts.push(`${inProgress} in progress`);
    if (pending > 0) parts.push(`${pending} pending`);
    if (failed > 0) parts.push(`${failed} failed`);

    return `Task Progress: ${parts.join(", ")}`;
  }

  /**
   * 构建收敛状态摘要
   *
   * 告知 agent 当前的收敛进度：还剩多少轮才能判定完成。
   *
   * @param state - 状态视图对象
   * @returns 收敛状态描述
   */
  private buildConvergenceSummary(state: InjectorStateView): string {
    const counter = state.convergence_counter ?? 0;
    const required = state.convergence_rounds ?? 2;
    const maxCycles = state.max_cycles ?? 5;
    const cycle = state.cycle ?? 1;

    if (counter >= required) {
      return `CONVERGED: ${counter}/${required} rounds stable. Ready for completion.`;
    }

    if (counter === 0) {
      return `Not yet converging — issues were recently found or design was revisited. Cycle ${cycle}/${maxCycles}.`;
    }

    return `Converging: ${counter}/${required} rounds stable (need ${required - counter} more). Cycle ${cycle}/${maxCycles}.`;
  }

  // ========================================================================
  // 修复上下文构建
  // ========================================================================

  /**
   * 构建修复上下文消息
   *
   * 当 routing 引擎检测到需要修复的问题时，会在 state 中设置 repair_context。
   * 此方法将该修复上下文转换为 agent 可理解的指令消息。
   *
   * 修复上下文严格要求 agent：
   * - 仅修复指定的 issues
   * - 仅修改 affected_files 中列出的文件
   * - 不做额外的重构或设计变更
   *
   * @param repairCtx - 修复上下文对象
   * @returns 修复指令文本
   */
  private buildRepairContextMessage(repairCtx: {
    target_issues?: Array<{
      severity?: string;
      title: string;
      description?: string;
    }>;
    affected_files?: string[];
    reason?: string;
  }): string {
    const lines: string[] = [];

    lines.push("[REPAIR CONTEXT — FIX ONLY THESE ISSUES]");
    lines.push("");
    lines.push(`Reason: ${repairCtx.reason ?? "Issues detected by routing engine"}`);
    lines.push("");

    // 列出需要修复的 issues
    const targetIssues = repairCtx.target_issues ?? [];
    if (targetIssues.length > 0) {
      lines.push("Issues to fix:");
      for (const issue of targetIssues) {
        const severity = issue.severity ? `[${issue.severity}] ` : "";
        const desc = issue.description
          ? ` — ${issue.description}`
          : "";
        lines.push(`  - ${severity}${issue.title}${desc}`);
      }
    } else {
      lines.push("Issues to fix: (none specified — perform general repair)");
    }

    lines.push("");

    // 限定修改范围
    const affectedFiles = repairCtx.affected_files ?? [];
    if (affectedFiles.length > 0) {
      lines.push(`Affected files (ONLY modify these): ${affectedFiles.join(", ")}`);
    } else {
      lines.push("Affected files: (none specified — use your judgment)");
    }

    lines.push("");
    lines.push("CRITICAL INSTRUCTIONS:");
    lines.push("1. Do NOT modify files outside the affected_files list.");
    lines.push("2. Do NOT redesign or refactor unrelated code.");
    lines.push("3. Do NOT create new files unless absolutely necessary for the fix.");
    lines.push("4. Focus ONLY on resolving the issues listed above.");
    lines.push("5. After fixing, verify that no new issues are introduced.");
    lines.push("");
    lines.push("[END REPAIR CONTEXT]");

    return lines.join("\n");
  }

  // ========================================================================
  // 上下文裁剪
  // ========================================================================

  /**
   * 裁剪过大的上下文文件
   *
   * 当 context_summary.md 超过 maxContextBytes 时，
   * 保留文件尾部的 trimKeepBytes 字节，丢弃较旧的头部内容。
   *
   * 裁剪策略：
   * - 定位到保留起始位置
   * - 找到最近的节分隔符（"## " 或 "---"），确保裁剪后的内容是完整的
   * - 在开头添加裁剪标记
   *
   * @param filePath - 上下文文件路径
   * @param totalSize - 原始文件大小
   * @returns 裁剪后的内容
   */
  private trimContextFile(filePath: string, totalSize: number): string {
    try {
      const raw = readFileSync(filePath, "utf-8");

      // 计算保留起始位置（从文件尾部向前 trimKeepBytes）
      const keepStart = Math.max(0, raw.length - this.config.trimKeepBytes);

      // 找到保留起始位置后第一个节分隔符，确保内容完整
      let sectionStart = raw.indexOf("\n## ", keepStart);
      if (sectionStart < 0) {
        sectionStart = raw.indexOf("\n---", keepStart);
      }
      if (sectionStart < 0) {
        // 找不到明确的节边界——从保留起始位置截断
        sectionStart = keepStart;
      }

      // 去除开头的空白行
      const trimmed = raw.substring(sectionStart);
      const cleaned = trimmed.replace(/^\n+/, "");

      const trimNotice = [
        `[CONTEXT TRIMMED — original size: ${(totalSize / 1024).toFixed(1)}KB, `,
        `showing last ${(cleaned.length / 1024).toFixed(1)}KB]`,
        "",
        "",
      ].join("\n");

      console.warn(
        `[ContextInjector] context_summary.md 过大 (${(totalSize / 1024).toFixed(1)}KB)，` +
        `已裁剪至 ${((trimNotice.length + cleaned.length) / 1024).toFixed(1)}KB`,
      );

      return trimNotice + cleaned;
    } catch (err) {
      console.warn(
        `[ContextInjector] 上下文裁剪失败: ${(err as Error).message}`,
      );
      return `[CONTEXT CROPPING FAILED — ${(err as Error).message}]`;
    }
  }

  /**
   * 估计上下文消息的 token 数量
   *
   * 使用简单估算：平均 4 字符 ≈ 1 token（英文），2 字符 ≈ 1 token（中文混合）
   * 此估算用于上下文窗口管理决策，非精确计数。
   *
   * @param text - 待估算的文本
   * @returns 估算的 token 数量
   */
  estimateTokenCount(text: string): number {
    // 中文/日文等宽字符粗略按 2 字符 = 1 token
    // 英文按 4 字符 = 1 token
    let asciiChars = 0;
    let wideChars = 0;

    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code <= 0x7f) {
        asciiChars++;
      } else {
        wideChars++;
      }
    }

    return Math.ceil(asciiChars / 4 + wideChars / 2);
  }

  /**
   * 更新配置
   *
   * @param partial - 要更新的部分配置项
   */
  updateConfig(partial: Partial<ContextInjectorConfig>): void {
    if (partial.projectRoot !== undefined) {
      this.config.projectRoot = partial.projectRoot;
    }
    if (partial.contextSummaryPath !== undefined) {
      this.config.contextSummaryPath = partial.contextSummaryPath;
    }
    if (partial.maxContextBytes !== undefined) {
      this.config.maxContextBytes = partial.maxContextBytes;
    }
    if (partial.trimKeepBytes !== undefined) {
      this.config.trimKeepBytes = partial.trimKeepBytes;
    }
  }
}

// ============================================================================
// 便捷工厂函数
// ============================================================================

/**
 * 使用默认路径创建 ContextInjector 实例
 *
 * @param projectRoot - 项目根目录路径（默认当前工作目录）
 * @param overrides - 可选的配置覆盖项
 * @returns ContextInjector 实例
 */
export function createContextInjector(
  projectRoot?: string,
  overrides?: Partial<Omit<ContextInjectorConfig, "projectRoot">>,
): ContextInjector {
  return new ContextInjector({
    projectRoot: projectRoot ?? process.cwd(),
    ...DEFAULT_CONFIG,
    ...overrides,
  });
}

/**
 * 构建最小化的上下文头（用于不需要完整历史摘要的轻量级调用）
 *
 * 仅包含 phase、cycle 和 goal，适合验证探针、兼容性检查等场景。
 *
 * @param phase - 当前阶段
 * @param cycle - 当前轮次
 * @param goal - 用户目标
 * @returns 轻量级对话历史数组
 */
export function buildMinimalContext(
  phase: string,
  cycle: number,
  goal: string,
): ConversationMessage[] {
  const header = [
    "[MINIMAL CONTEXT]",
    `Phase: ${phase}`,
    `Cycle: ${cycle}`,
    `Goal: ${goal}`,
    "[END MINIMAL CONTEXT]",
  ].join("\n");

  return [{ role: "user", content: header }];
}
