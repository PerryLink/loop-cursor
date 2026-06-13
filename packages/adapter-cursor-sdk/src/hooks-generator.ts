/**
 * HooksGenerator (M2) —— 动态生成 .cursor/hooks.json（五层命令匹配器）
 *
 * 职责：
 * 1. 根据当前 phase 和 trustLevel 动态生成 hooks.json
 * 2. beforeShellExecution 五层匹配器（L0-L4）——OS 级命令拦截
 *    L0_CATASTROPHIC:  灾难性操作——所有模式硬拦截（不可绕过）
 *    L1_IRREVERSIBLE:  不可逆操作——L1+L2 拦截，L3 放行
 *    L2_SEMI_REVERSIBLE: 半可逆操作——L1 暂停，L2 警告，L3 放行
 *    L3_DEPENDENCY:    依赖安装——L1 暂停，L2 部分暂停，L3 放行
 *    L4_PATH_PROTECTION: 路径保护——所有模式硬拦截（不可绕过）
 * 3. preToolUse 匹配器——Write/Edit 工具的文件路径拦截
 * 4. 支持 L1(safe) / L2(auto) / L3(unsafe) 三个信任级别差异化配置
 * 5. 支持 phase 特定的额外规则（只读 phase 禁止修改，实施 phase 允许构建等）
 * 6. 预检 API——在 agent.send() 前判定命令是否被硬拦截
 *
 * 安全模型：
 * hooks.json 由 SDK 引擎在每次 agent.send() 前写入文件系统。
 * Cursor IDE 的 hooks 系统在 OS 层执行 hooks.json 中的匹配规则。
 * agent 不读取 hooks.json——它对规则完全不知情。
 *
 * @module hooks-generator
 * @version 0.2.0 (M2)
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// 类型定义
// ============================================================================

/** 信任级别——与 state.json 的 config.mode 对应 */
export type TrustLevel = "L1" | "L2" | "L3";

/** Phase ID——与 state.json 的 progress.phase 一致 */
export type PhaseId =
  | "init"
  | "part_1_1" | "part_1_2" | "part_1_3"
  | "part_2_1" | "part_2_2" | "part_2_3" | "part_2_4"
  | "part_2_5" | "part_2_6" | "part_2_7" | "part_2_8"
  | "routing" | "complete" | "paused" | "failed";

/** Hook 动作类型——block 硬拦截 / warn 警告但继续 / allow 放行 */
type HookAction = "block" | "warn" | "allow";

/**
 * beforeShellExecution 单个匹配规则
 * 当 agent 执行 Bash 命令时，Cursor hooks 系统按顺序匹配
 */
interface ShellHookRule {
  /** JavaScript 兼容的正则表达式 */
  matcher: string;
  /** 匹配后的动作 */
  action: HookAction;
  /** 拦截/警告的原因说明 */
  reason: string;
  /** 仅在指定 phase 列表生效；空/undefined = 所有 phase 生效 */
  phases?: PhaseId[];
}

/**
 * preToolUse 单个匹配规则
 * 当 agent 调用 Write/Edit 等工具时，Cursor hooks 系统按顺序匹配
 */
interface ToolHookRule {
  /** 工具名称匹配（如 "Write|Edit"） */
  matcher: string;
  /** 目标路径匹配（glob 模式，可选） */
  target?: string;
  /** 匹配后的动作 */
  action: HookAction;
  /** 拦截/警告的原因说明 */
  reason: string;
  /** 仅在指定 phase 列表生效 */
  phases?: PhaseId[];
}

/**
 * 完整的 hooks.json 结构
 * 包含元数据字段用于调试和审计
 */
interface HooksJson {
  beforeShellExecution: ShellHookRule[];
  preToolUse: ToolHookRule[];
  _generated_by: string;
  _generated_for_phase: string;
  _generated_at: string;
  _trust_level: string;
}

/** HooksGenerator 配置 */
interface HooksGeneratorConfig {
  /** .cursor/ 目录的绝对路径 */
  cursorDir: string;
  /** SDK 引擎版本标识（用于 _generated_by 元数据） */
  engineVersion: string;
}


// ============================================================================
// 五层匹配器：正则表达式定义
// ============================================================================

/**
 * L0_CATASTROPHIC — 灾难性操作（所有信任级别硬拦截）
 *
 * 包括：文件系统破坏、磁盘覆写、fork bomb、系统服务破坏、
 *       数据库整库删除、force push 主分支、npm unpublish 等。
 * L1/L2/L3 均硬拦截，不可绕过。
 */
const RE_CATASTROPHIC =
  // 文件系统破坏
  "rm\\s+-rf\\s+/" +
  "|rm\\s+-rf\\s+~" +
  "|>\\s*/dev/sd[a-z]" +
  "|dd\\s+if=.*of=/dev/" +
  "|mkfs\\." +
  // 权限全开
  "|chmod\\s+777\\s+/" +
  "|chmod\\s+-R\\s+777" +
  "|chown\\s+-R\\s+\\S+\\s+/" +
  // Fork bomb
  "|:\\(\\)\\s*\\{\\s*:\\|:&\\s*\\}\\s*;\\s*:" +
  "|\\.\\S+\\(\\).*\\{.*\\1\\|\\1" +
  // 系统服务破坏
  "|systemctl\\s+disable\\s+sshd" +
  "|systemctl\\s+stop\\s+firewalld" +
  // 防火墙清空
  "|iptables\\s+-F" +
  "|iptables\\s+-P\\s+INPUT\\s+ACCEPT" +
  "|nft\\s+flush\\s+ruleset" +
  // 数据库破坏
  "|DROP\\s+DATABASE\\s+\\w+" +
  "|DROP\\s+TABLE\\s+\\w+" +
  "|DELETE\\s+FROM\\s+\\w+\\s*(?:WHERE\\s+1\\s*=\\s*1|;|$)" +
  "|TRUNCATE\\s+(?:TABLE\\s+)?\\w+" +
  // git 强制推送到主分支
  "|git\\s+push\\s+(?:--force|-f)\\s+origin\\s+(main|master)" +
  // npm 危险操作
  "|npm\\s+unpublish\\s+(?:--force|-f)" +
  // Docker 危险操作
  "|docker\\s+(?:rm|rmi|system\\s+prune)\\s+(?:-af?|--all)" +
  "";

/**
 * L1_IRREVERSIBLE — 不可逆操作（但非灾难性）
 *
 * 包括：强制递归删除、git 硬重置/清理、force push 非主分支、
 *       权限/所有者修改、覆盖关键配置文件、shred/wipe 安全删除。
 * L1 + L2 硬拦截；L3 放行。
 */
const RE_IRREVERSIBLE =
  "rm\\s+-rf(?!\\s+/|\\s+~)" +
  "|rm\\s+-r(?!\\s+/|\\s+~)" +
  "|git\\s+reset\\s+--hard" +
  "|git\\s+clean\\s+(?:-f[dx]?|-df|-fd)" +
  "|git\\s+push\\s+(?:--force|-f)(?!\\s+origin\\s+(main|master))" +
  "|chmod(?!\\s+777\\s+/|\\s+-R\\s+777)" +
  "|chown(?!\\s+-R)" +
  "|(?:>|>>)\\s*(?:/etc/|/boot/|~/\\.(?:bash|zsh|ssh|git|npm))" +
  "|shred\\s+" +
  "|wipe\\s+" +
  "|truncate\\s+-s\\s+0\\s+/var/log/" +
  "";

/**
 * L2_SEMI_REVERSIBLE — 半可逆操作
 *
 * 包括：git rebase、git commit --amend、docker rm/rmi（非 all）、
 *       kubectl delete、terraform destroy、文件批量操作、npm publish。
 * L1 暂停确认；L2 警告（记录日志）；L3 放行。
 */
const RE_SEMI_REVERSIBLE =
  "git\\s+rebase(?!\\s+--continue|\\s+--abort)" +
  "|git\\s+commit\\s+--amend" +
  "|git\\s+reflog\\s+(?:delete|expire)" +
  "|docker\\s+(?:rm|rmi)(?!\\s+(?:-af?|--all))" +
  "|kubectl\\s+delete\\s+(?:deploy|svc|pod|ns|namespace)" +
  "|terraform\\s+destroy" +
  "|terraform\\s+apply\\s+(?:-auto-approve|--auto-approve)" +
  "|(?:mv|cp|rm)\\s+.*\\*/\\*" +
  "|npm\\s+publish(?!\\s+--dry-run)" +
  "";

/**
 * L3_DEPENDENCY — 依赖安装操作
 *
 * 包括：npm/pip/cargo/gem/composer/go install, brew/apt/yum/dnf/pacman install。
 * L1 暂停（仅方案中列出的包可安装）；L2 暂停（非默认源的包）；L3 放行。
 */
const RE_DEPENDENCY =
  // Node.js
  "npm\\s+(?:i|install)(?!\\s+--dry-run)" +
  "|yarn\\s+add" +
  "|pnpm\\s+add" +
  "|bun\\s+(?:add|install)" +
  // Python
  "|pip\\s+install(?!\\s+--dry-run)" +
  "|pip3\\s+install(?!\\s+--dry-run)" +
  "|poetry\\s+add" +
  "|conda\\s+install" +
  // Rust
  "|cargo\\s+(?:add|install)" +
  // Ruby
  "|gem\\s+install" +
  "|bundle\\s+add" +
  // PHP
  "|composer\\s+require" +
  // Go
  "|go\\s+install" +
  "|go\\s+get\\s+-u" +
  // System package managers
  "|brew\\s+install" +
  "|apt(?:-get)?\\s+install" +
  "|yum\\s+install" +
  "|dnf\\s+install" +
  "|pacman\\s+-S" +
  "";

/**
 * L4_PATH_PROTECTION — 受保护路径拦截（所有信任级别硬拦截）
 *
 * 保护 loop-cursor 自身核心文件不被 agent 意外修改。
 * 覆盖操作：rm/mv/cp/cat>/tee/dd of=/sed -i/awk -i/truncate/chmod/chown/touch/echo>
 *
 * 受保护路径：
 * - .cursor/loop-cursor/state.json（状态文件）
 * - .cursor/loop-cursor/hooks/（Hook 脚本目录）
 * - .cursor/rules/loop-cursor-*（动态 rule 文件）
 * - .cursor/loop-cursor/.lock（并发锁）
 * - .cursor/loop-cursor/engine.js（引擎文件）
 */
const RE_PATH_PROTECTION =
  "(?:rm|mv|cp|cat\\s*>|tee|dd\\s+of=|sed\\s+-i|awk\\s+-i|truncate|chmod|chown|touch|echo\\s+.*>)" +
  ".*" +
  "(" +
  "\\.cursor/loop-cursor/state\\.json" +
  "|\\.cursor/loop-cursor/hooks/" +
  "|\\.cursor/rules/loop-cursor-" +
  "|\\.cursor/loop-cursor/\\.lock" +
  "|\\.cursor/loop-cursor/engine\\.js" +
  ")";

// ============================================================================
// 各层规则构建器
// ============================================================================

/**
 * 构建 L0_CATASTROPHIC 层规则
 * 所有模式硬拦截，不区分 phase 和 trustLevel
 */
function buildL0CatastrophicRules(): ShellHookRule[] {
  return [
    {
      matcher: RE_CATASTROPHIC,
      action: "block",
      reason:
        "CATASTROPHIC: 此操作不可逆且影响无法控制。" +
        "在所有信任级别（L1/L2/L3）中被硬拦截。",
    },
  ];
}

/**
 * 构建 L1_IRREVERSIBLE 层规则
 * L1 + L2 硬拦截（block），L3 放行（allow）
 */
function buildL1IrreversibleRules(trustLevel: TrustLevel): ShellHookRule[] {
  if (trustLevel === "L3") {
    return [
      {
        matcher: RE_IRREVERSIBLE,
        action: "allow",
        reason: "IRREVERSIBLE: 信任级别 L3 —— 用户已接受风险。",
      },
    ];
  }

  return [
    {
      matcher: RE_IRREVERSIBLE,
      action: "block",
      reason:
        "IRREVERSIBLE: 此操作无法轻易撤销。" +
        "在 " + trustLevel + " 模式中被拦截。使用 --unsafe (L3) 可绕过。",
    },
  ];
}

/**
 * 构建 L2_SEMI_REVERSIBLE 层规则
 * L1 → block（暂停确认）；L2 → warn（警告但继续）；L3 → allow
 */
function buildL2SemiReversibleRules(trustLevel: TrustLevel): ShellHookRule[] {
  switch (trustLevel) {
    case "L1":
      return [
        {
          matcher: RE_SEMI_REVERSIBLE,
          action: "block",
          reason:
            "SEMI_REVERSIBLE: 此操作可撤销但可能需要付出努力。" +
            "在 L1 (safe) 模式中暂停等待确认。",
        },
      ];
    case "L2":
      return [
        {
          matcher: RE_SEMI_REVERSIBLE,
          action: "warn",
          reason:
            "SEMI_REVERSIBLE: 此操作可撤销但可能需要付出努力。" +
            "在 L2 (auto) 模式中带警告继续。",
        },
      ];
    case "L3":
      return [
        {
          matcher: RE_SEMI_REVERSIBLE,
          action: "allow",
          reason: "SEMI_REVERSIBLE: 信任级别 L3 —— 用户已接受风险。",
        },
      ];
  }
}

/**
 * 构建 L3_DEPENDENCY 层规则
 * L1 → block（仅方案中列出的包）；L2 → block（非默认源）；L3 → allow
 */
function buildL3DependencyRules(trustLevel: TrustLevel): ShellHookRule[] {
  switch (trustLevel) {
    case "L1":
      return [
        {
          matcher: RE_DEPENDENCY,
          action: "block",
          reason:
            "DEPENDENCY: 检测到包安装操作。" +
            "在 L1 (safe) 模式中，仅方案文档中列出的包可安装。暂停等待确认。",
        },
      ];
    case "L2":
      return [
        {
          matcher: RE_DEPENDENCY,
          action: "block",
          reason:
            "DEPENDENCY: 检测到非默认源的包安装。" +
            "在 L2 (auto) 模式中，仅默认仓库（npmjs.org, pypi.org, crates.io）的包可安装。",
        },
      ];
    case "L3":
      return [
        {
          matcher: RE_DEPENDENCY,
          action: "allow",
          reason: "DEPENDENCY: 信任级别 L3 —— 用户已接受依赖安装的风险。",
        },
      ];
  }
}

/**
 * 构建 L4_PATH_PROTECTION 层规则
 * 所有模式硬拦截，不区分 trustLevel
 */
function buildL4PathProtectionRules(): ShellHookRule[] {
  return [
    {
      matcher: RE_PATH_PROTECTION,
      action: "block",
      reason:
        "PATH_PROTECTION: 修改受保护的 loop-cursor 文件在所有信任级别中均被禁止。" +
        "受保护路径：state.json、hooks/、rules/、.lock、engine.js",
    },
  ];
}


// ============================================================================
// Phase 特定的额外 beforeShellExecution 规则
// ============================================================================

/**
 * 构建特定 phase 的额外 beforeShellExecution 规则
 *
 * 某些 phase 需要额外的命令限制：
 * - 只读 phase（part_2_3/part_2_7/part_2_8）：禁止修改类操作
 * - 实施 phase（part_2_2）：允许 git add 和构建命令，禁止 git commit
 * - 初始化 phase（init）：允许 git worktree 和 mkdir
 */
function buildPhaseSpecificShellRules(phase: PhaseId): ShellHookRule[] {
  const rules: ShellHookRule[] = [];

  // Phase 特定的禁止规则
  const phaseForbidden: Partial<Record<PhaseId, ShellHookRule[]>> = {
    part_2_2: [
      {
        matcher: "git\\s+commit",
        action: "block",
        reason:
          "PHASE_RULE: 实施阶段不允许 git commit。" +
          "Commit 由 SDK 引擎管理。",
        phases: ["part_2_2"],
      },
      {
        matcher: "gh\\s+pr\\s+create",
        action: "block",
        reason:
          "PHASE_RULE: 实施阶段不允许创建 PR。",
        phases: ["part_2_2"],
      },
    ],
    part_2_3: [
      {
        matcher: "git\\s+commit|Write|Edit",
        action: "block",
        reason:
          "PHASE_RULE: Code Review 阶段为只读。不允许任何修改。",
        phases: ["part_2_3"],
      },
    ],
    part_2_7: [
      {
        matcher: "Write|Edit|git\\s+commit",
        action: "block",
        reason:
          "PHASE_RULE: 审计阶段为只读。查找问题，不修复。",
        phases: ["part_2_7"],
      },
    ],
    part_2_8: [
      {
        matcher: "Write|Edit|git\\s+commit",
        action: "block",
        reason:
          "PHASE_RULE: 硬验证闸门为只读。验证，不修复。",
        phases: ["part_2_8"],
      },
    ],
  };

  // Phase 特定的允许规则（在只读检查后追加）
  const phaseAllowed: Partial<Record<PhaseId, ShellHookRule[]>> = {
    init: [
      {
        matcher: "git\\s+worktree\\s+add",
        action: "allow",
        reason:
          "PHASE_RULE: 初始化阶段允许创建 git worktree。",
        phases: ["init"],
      },
      {
        matcher: "mkdir\\s+-p\\s+\\.cursor",
        action: "allow",
        reason:
          "PHASE_RULE: 初始化阶段允许创建目录。",
        phases: ["init"],
      },
    ],
    part_2_2: [
      {
        matcher: "npm\\s+(?:run|test|build|lint|start|dev)",
        action: "allow",
        reason:
          "PHASE_RULE: 实施阶段允许 build/test/lint 命令。",
        phases: ["part_2_2"],
      },
      {
        matcher: "git\\s+add",
        action: "allow",
        reason:
          "PHASE_RULE: 实施阶段允许 git add 暂存文件。",
        phases: ["part_2_2"],
      },
    ],
    part_2_6: [
      {
        matcher: "npm\\s+(?:run|test|build|lint)",
        action: "allow",
        reason:
          "PHASE_RULE: 测试执行阶段允许 test 命令。",
        phases: ["part_2_6"],
      },
    ],
  };

  const forbidden = phaseForbidden[phase];
  if (forbidden) rules.push(...forbidden);

  const allowed = phaseAllowed[phase];
  if (allowed) rules.push(...allowed);

  return rules;
}

// ============================================================================
// preToolUse 规则构建器
// ============================================================================

/**
 * 构建 preToolUse 匹配规则
 *
 * preToolUse hook 在 agent 调用 Write/Edit 等工具前触发。
 * 用于保护 loop-cursor 自身的关键文件不被 agent 意外修改。
 *
 * 规则分层：
 * 1. 核心保护（所有 phase 生效）：state.json、hooks/、rules/、.lock、engine.js
 * 2. Phase 特定规则：只读 phase 禁止所有 Write/Edit
 */
function buildPreToolUseRules(phase: PhaseId): ToolHookRule[] {
  const rules: ToolHookRule[] = [
    // --- 核心文件保护（所有 phase 硬拦截） ---
    {
      matcher: "Write|Edit",
      target: ".cursor/loop-cursor/state.json",
      action: "block",
      reason:
        "PROTECTED: 直接编辑 state.json 被禁止。" +
        "状态更新通过 SDK 引擎处理。",
    },
    {
      matcher: "Write|Edit",
      target: ".cursor/loop-cursor/state.json.bak",
      action: "block",
      reason: "PROTECTED: state.json 备份由 SDK 引擎管理。",
    },
    {
      matcher: "Write|Edit",
      target: ".cursor/loop-cursor/hooks/*",
      action: "block",
      reason:
        "PROTECTED: Hook 脚本已编译且不可变。不得修改。",
    },
    {
      matcher: "Write|Edit",
      target: ".cursor/loop-cursor/engine.js",
      action: "block",
      reason:
        "PROTECTED: 引擎文件是 loop-cursor 核心的一部分。不得修改。",
    },
    {
      matcher: "Write|Edit",
      target: ".cursor/loop-cursor/.lock",
      action: "block",
      reason:
        "PROTECTED: 锁文件由 SDK 引擎管理，用于并发控制。",
    },
    {
      matcher: "Write|Edit",
      target: ".cursor/rules/loop-cursor-*.mdc",
      action: "block",
      reason:
        "PROTECTED: Rule 文件由 SDK 引擎动态生成。" +
        "Agent 可以读取但不得写入。",
    },
    {
      matcher: "Write|Edit",
      target: ".cursor/hooks.json",
      action: "block",
      reason:
        "PROTECTED: hooks.json 由 SDK 引擎动态生成。" +
        "Agent 不得写入此文件。",
    },
    // --- artifacts 目录修改警告 ---
    {
      matcher: "Write|Edit",
      target: ".cursor/loop-cursor/artifacts/*",
      action: "warn",
      reason:
        "WARNING: 修改已存在的 artifact 应谨慎操作。" +
        "建议创建新文件或追加而非覆盖。",
    },
  ];

  // --- Phase 特定的 preToolUse 规则 ---

  // 只读 phase：禁止所有 src/ 和 tests/ 的 Write/Edit
  const readOnlyPhases: PhaseId[] = ["part_2_3", "part_2_7", "part_2_8"];
  if (readOnlyPhases.includes(phase)) {
    rules.push({
      matcher: "Write|Edit",
      target: "src/**",
      action: "block",
      reason:
        "PHASE_RULE: Phase " + phase + " 为只读。不允许修改源代码。",
      phases: [phase],
    });
    rules.push({
      matcher: "Write|Edit",
      target: "tests/**",
      action: "block",
      reason:
        "PHASE_RULE: Phase " + phase + " 为只读。不允许修改测试文件。",
      phases: [phase],
    });
  }

  // part_2_2：实施阶段——允许写入 src/ + tests/
  if (phase === "part_2_2") {
    rules.push({
      matcher: "Write|Edit",
      target: "src/**",
      action: "allow",
      reason:
        "PHASE_RULE: 实施阶段允许修改源代码。",
      phases: ["part_2_2"],
    });
    rules.push({
      matcher: "Write|Edit",
      target: "tests/**",
      action: "allow",
      reason:
        "PHASE_RULE: 实施阶段允许修改测试文件。",
      phases: ["part_2_2"],
    });
  }

  // part_2_6：测试执行阶段——允许写入 tests/，禁止写入 src/
  if (phase === "part_2_6") {
    rules.push({
      matcher: "Write|Edit",
      target: "tests/**",
      action: "allow",
      reason:
        "PHASE_RULE: 测试执行阶段允许创建/修改测试文件。",
      phases: ["part_2_6"],
    });
    rules.push({
      matcher: "Write|Edit",
      target: "src/**",
      action: "block",
      reason:
        "PHASE_RULE: 测试执行阶段不允许修改源代码。" +
        "测试失败应记录为 issue，不应在此阶段修复。",
      phases: ["part_2_6"],
    });
  }

  return rules;
}


// ============================================================================
// HooksGenerator 主类
// ============================================================================

/**
 * HooksGenerator —— 动态生成 .cursor/hooks.json（五层命令匹配器）
 *
 * 在每次 agent.send() 前由适配器调用 generate(phase, trustLevel)
 * 来生成当前阶段的安全护栏 hooks 配置。
 *
 * 使用示例：
 *   const gen = createHooksGenerator("/path/to/project");
 *   gen.generate("part_2_2", "L2");       // 生成 hooks.json
 *   gen.preflightCheck("rm -rf /tmp/x");  // 预检命令是否被拦截
 *   gen.remove();                          // 清理 hooks.json
 */
export class HooksGenerator {
  private readonly config: Required<HooksGeneratorConfig>;

  constructor(config: HooksGeneratorConfig) {
    this.config = {
      cursorDir: config.cursorDir,
      engineVersion: config.engineVersion,
    };
  }

  // ========================================================================
  // 公开 API
  // ========================================================================

  /**
   * 生成完整的 hooks.json 并写入文件系统
   *
   * 这是 injectGuardrails() 的核心调用——在每次 agent.send() 前执行。
   * 生成的 hooks.json 包含 beforeShellExecution（五层匹配器）和
   * preToolUse（文件路径保护）两部分规则。
   *
   * @param phase - 当前 phase ID
   * @param trustLevel - 当前信任级别（L1/L2/L3）
   * @returns 写入的 hooks.json 文件绝对路径
   */
  generate(phase: PhaseId, trustLevel: TrustLevel): string {
    const hooksJson = this.buildHooksJson(phase, trustLevel);
    const hooksPath = this.getHooksPath();
    this.ensureCursorDir();
    writeFileSync(hooksPath, JSON.stringify(hooksJson, null, 2), "utf-8");
    return hooksPath;
  }

  /**
   * 为首次初始化生成默认 hooks.json（L2 默认信任级别 + init phase）
   *
   * @returns hooks.json 文件路径
   */
  generateInitial(): string {
    return this.generate("init", "L2");
  }

  /**
   * 获取 hooks.json 文件路径
   *
   * @returns hooks.json 文件的绝对路径
   */
  getHooksPath(): string {
    return join(this.config.cursorDir, "hooks.json");
  }

  /**
   * 删除 hooks.json 文件
   *
   * 在以下时机调用：
   * - 工作流终止时（complete / paused / failed）
   * - 需要重置 hooks 配置时
   */
  remove(): void {
    const hooksPath = this.getHooksPath();
    if (existsSync(hooksPath)) {
      try {
        unlinkSync(hooksPath);
      } catch {
        // 文件可能已被外部删除
      }
    }
  }

  /**
   * 构建 hooks.json 对象（不写入文件系统——用于预览/测试/审计）
   *
   * @param phase - 当前 phase ID
   * @param trustLevel - 当前信任级别
   * @returns 完整的 HooksJson 对象
   */
  buildHooksJson(phase: PhaseId, trustLevel: TrustLevel): HooksJson {
    return {
      beforeShellExecution: this.buildShellRules(phase, trustLevel),
      preToolUse: this.buildToolRules(phase),
      _generated_by:
        "loop-cursor SDK engine v" + this.config.engineVersion,
      _generated_for_phase: phase,
      _generated_at: new Date().toISOString(),
      _trust_level: trustLevel,
    };
  }

  /**
   * 列出当前配置下的所有 beforeShellExecution 规则（用于审计）
   *
   * @param phase - 当前 phase
   * @param trustLevel - 信任级别
   * @returns Shell 规则列表
   */
  listShellRules(
    phase: PhaseId,
    trustLevel: TrustLevel,
  ): ShellHookRule[] {
    return this.buildShellRules(phase, trustLevel);
  }

  /**
   * 列出当前配置下的所有 preToolUse 规则（用于审计）
   *
   * @param phase - 当前 phase
   * @returns 工具规则列表
   */
  listToolRules(phase: PhaseId): ToolHookRule[] {
    return this.buildToolRules(phase);
  }

  /**
   * 预检：判定一个 shell 命令是否被 L0 或 L4 层硬拦截
   *
   * 用于 SDK 引擎在 agent.send() 前进行预检——
   * 如果命令已被 L0（灾难性）或 L4（路径保护）硬拦截，
   * 引擎可以提前拒绝而不需要等待 hooks 系统执行。
   *
   * 注意：此方法仅检查 L0 和 L4（所有模式硬拦截的层级），
   * L1-L3 层由 hooks.json 在运行时动态匹配（受信任级别影响）。
   *
   * @param command - 要执行的 shell 命令
   * @returns "block"（被硬拦截）或 "allow"（通过预检）
   */
  preflightCheck(command: string): "block" | "allow" {
    // 检查 L0 灾难性操作
    const catastrophicRe = new RegExp(RE_CATASTROPHIC);
    if (catastrophicRe.test(command)) {
      return "block";
    }

    // 检查 L4 路径保护
    const pathProtectionRe = new RegExp(RE_PATH_PROTECTION);
    if (pathProtectionRe.test(command)) {
      return "block";
    }

    return "allow";
  }

  /**
   * 检查 hooks.json 是否已存在
   *
   * @returns hooks.json 文件是否存在
   */
  exists(): boolean {
    return existsSync(this.getHooksPath());
  }

  /**
   * 更新引擎版本（用于 _generated_by 元数据）
   *
   * @param version - 新的引擎版本号
   */
  setEngineVersion(version: string): void {
    this.config.engineVersion = version;
  }

  // ========================================================================
  // 内部方法
  // ========================================================================

  /** 确保 .cursor/ 目录存在 */
  private ensureCursorDir(): void {
    if (!existsSync(this.config.cursorDir)) {
      mkdirSync(this.config.cursorDir, { recursive: true });
    }
  }

  /**
   * 构建完整的 beforeShellExecution 规则数组（五层叠加）
   *
   * 规则叠加顺序（hooks 系统按数组顺序匹配，先匹配先生效）：
   * L0_CATASTROPHIC  → 灾难性操作硬拦截
   * L1_IRREVERSIBLE  → 不可逆操作（模式相关）
   * L2_SEMI_REVERSIBLE → 半可逆操作（模式相关）
   * L3_DEPENDENCY    → 依赖安装（模式相关）
   * L4_PATH_PROTECTION → 路径保护硬拦截
   * Phase 特定规则    → 最后追加（优先级最高，覆盖前面的规则）
   */
  private buildShellRules(
    phase: PhaseId,
    trustLevel: TrustLevel,
  ): ShellHookRule[] {
    const rules: ShellHookRule[] = [];

    // L0: 灾难性操作——全模式硬拦截
    rules.push(...buildL0CatastrophicRules());

    // L1: 不可逆操作——L1+L2 拦截，L3 放行
    rules.push(...buildL1IrreversibleRules(trustLevel));

    // L2: 半可逆操作——L1 暂停，L2 警告，L3 放行
    rules.push(...buildL2SemiReversibleRules(trustLevel));

    // L3: 依赖安装——模式相关
    rules.push(...buildL3DependencyRules(trustLevel));

    // L4: 路径保护——全模式硬拦截
    rules.push(...buildL4PathProtectionRules());

    // Phase 特定规则（追加在最后，具有最高优先级）
    rules.push(...buildPhaseSpecificShellRules(phase));

    return rules;
  }

  /**
   * 构建完整的 preToolUse 规则数组
   */
  private buildToolRules(phase: PhaseId): ToolHookRule[] {
    return buildPreToolUseRules(phase);
  }
}

// ============================================================================
// 便捷工厂函数
// ============================================================================

/**
 * 使用默认路径创建 HooksGenerator 实例
 *
 * @param projectRoot - 项目根目录路径（默认当前工作目录）
 * @param engineVersion - 引擎版本号（默认 "0.2.0"）
 * @returns HooksGenerator 实例
 */
export function createHooksGenerator(
  projectRoot?: string,
  engineVersion?: string,
): HooksGenerator {
  const base = projectRoot ?? process.cwd();
  return new HooksGenerator({
    cursorDir: join(base, ".cursor"),
    engineVersion: engineVersion ?? "0.2.0",
  });
}

// ============================================================================
// 导出匹配层正则（供外部预检和审计使用）
// ============================================================================

export {
  RE_CATASTROPHIC,
  RE_IRREVERSIBLE,
  RE_SEMI_REVERSIBLE,
  RE_DEPENDENCY,
  RE_PATH_PROTECTION,
};
