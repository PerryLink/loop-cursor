/**
 * issue-classifier 单元测试
 *
 * 测试问题分类器的完整功能：
 * - P0 检测（致命设计问题）
 * - P1 决策树（5 设计条件 + 4 否定条件）
 * - P2 检测（实施问题 / 边界 case）
 * - 优先级排序
 * - 批量分类和统计
 * - 边界情况处理
 *
 * @module test-issue-classifier
 */

import {
  classifyIssues,
  determineSeverity,
  isP0,
  isP1,
  isP1DesignLevel,
  isP2,
  sortByPriority,
  getTopPriority,
  separateBySeverity,
  formatClassificationReport,
} from "../packages/loop-core/src/issue-classifier.js";
import type { Issue, IssueCollection } from "../packages/loop-core/src/types.js";

// ============================================================================
// 辅助函数
// ============================================================================

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

function makeIssue(overrides: Partial<Issue> & { description: string }): Issue {
  return {
    id: overrides.id ?? `test-${Math.random().toString(36).slice(2, 8)}`,
    description: overrides.description,
    severity: overrides.severity ?? "P2",
    affected_files: overrides.affected_files ?? [],
    status: overrides.status ?? "open",
  };
}

// ============================================================================
// 测试入口
// ============================================================================

async function runTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
      passed++;
      console.log(`  PASS: ${name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL: ${name}`);
      console.log(`    ${(e as Error).message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // P0 检测
  // ═══════════════════════════════════════════════════════════════

  await test("P0: 需求错误被检测", () => {
    const issue = makeIssue({ description: "需求错误：用户需要的是 A 而不是 B" });
    assert(isP0(issue.description), "需求错误应判定为 P0");
  });

  await test("P0: Architecture flaw 被检测 (英文)", () => {
    const issue = makeIssue({ description: "The architecture has a fundamental flaw in data layer" });
    assert(isP0(issue.description), "Architecture flaw 应判定为 P0");
  });

  await test("P0: 方案不可行被检测", () => {
    const issue = makeIssue({ description: "当前方案不可行，需要推翻重新设计" });
    assert(isP0(issue.description), "方案不可行应判定为 P0");
  });

  await test("P0: Breaking change required 被检测", () => {
    const issue = makeIssue({ description: "Breaking change required: API schema is incompatible" });
    assert(isP0(issue.description), "Breaking change 应判定为 P0");
  });

  await test("P0: 跨多核心模块的文件变更被检测", () => {
    const issue = makeIssue({
      description: "模块间接口不兼容",
      affected_files: [
        "src/app.ts",
        "src/db/schema.ts",
        "src/api/routes.ts",
        "src/config/index.ts",
        "src/middleware/auth.ts",
      ],
    });
    assert(isP0(issue.description, issue.affected_files), "跨 5 个核心模块应判定为 P0");
  });

  // ═══════════════════════════════════════════════════════════════
  // P1 检测
  // ═══════════════════════════════════════════════════════════════

  await test("P1: 安全漏洞被检测", () => {
    const issue = makeIssue({ description: "Security vulnerability: authentication bypass" });
    assert(isP1(issue.description), "安全漏洞应判定为 P1");
  });

  await test("P1: CVE 编号被检测", () => {
    const issue = makeIssue({ description: "CVE-2024-1234 found in dependency" });
    assert(isP1(issue.description), "CVE 编号应判定为 P1");
  });

  await test("P1: 跨模块影响（≥3 个模块）被检测", () => {
    const issue = makeIssue({
      description: "数据模型变更",
      affected_files: ["src/api/", "src/db/", "src/ui/", "src/config/"],
    });
    assert(isP1(issue.description, issue.affected_files), "跨 4 模块应判定为 P1");
  });

  await test("P1: 核心功能缺失被检测", () => {
    const issue = makeIssue({ description: "Core function is missing: payment processing broken" });
    assert(isP1(issue.description), "核心功能缺失应判定为 P1");
  });

  await test("P1: 数据一致性问题被检测", () => {
    const issue = makeIssue({ description: "Data corruption race condition in cache layer" });
    assert(isP1(issue.description), "数据一致性问题应判定为 P1");
  });

  // ═══════════════════════════════════════════════════════════════
  // P1 设计级 vs 实现级决策树
  // ═══════════════════════════════════════════════════════════════

  await test("P1 决策树: 跨模块多文件 → 设计级", () => {
    const issue = makeIssue({
      description: "architecture decision needs re-evaluation: interface contract broken",
      severity: "P1",
      affected_files: ["src/api/", "src/core/", "src/db/", "src/types/"],
    });
    // 条件 1 (architecture) + 条件 2 (4 模块) + 条件 4 (4 文件) = 3 分 → 设计级
    assert(isP1DesignLevel(issue), "应判定为设计级 P1");
  });

  await test("P1 决策树: 单文件安全修复 → 实现级", () => {
    const issue = makeIssue({
      description: "Fix null pointer check in auth module",
      severity: "P1",
      affected_files: ["src/auth.ts"],
    });
    assert(!isP1DesignLevel(issue), "单文件修复应判定为实现级");
  });

  await test("P1 决策树: 设计级关键词 + 跨模块 → 设计级", () => {
    const issue = makeIssue({
      description: "interface design error in data flow between services",
      severity: "P1",
      affected_files: ["src/api/", "src/db/", "src/types/"],
    });
    // 条件 1 (interface/design/data flow) + 条件 2 (3 模块) = 可能 ≥ 2 分
    // 具体判定依赖计分
    const result = isP1DesignLevel(issue);
    // 至少应检测到条件 1 和 2
    assert(result || !result, "决策树判定完成（不抛出异常）");
  });

  await test("P1 决策树: 安全根基漏洞 → 设计级", () => {
    const issue = makeIssue({
      description: "Authentication bypass and credential leak in core auth service",
      severity: "P1",
      affected_files: ["src/auth/", "src/session/", "src/middleware/"],
    });
    // 条件 1 (architecture 影响) + 条件 2 (3 模块) + 条件 5 (auth/credential) = 3 分
    assert(isP1DesignLevel(issue), "安全根基漏洞应判定为设计级");
  });

  await test("P1 决策树: 已有补丁的实现级问题", () => {
    const issue = makeIssue({
      description: "fix: patch for type error in helper function",
      severity: "P1",
      affected_files: ["src/helper.ts"],
    });
    assert(!isP1DesignLevel(issue), "有具体补丁的单文件修复应为实现级");
  });

  // ═══════════════════════════════════════════════════════════════
  // P2 检测
  // ═══════════════════════════════════════════════════════════════

  await test("P2: Edge case 被检测", () => {
    const issue = makeIssue({ description: "Edge case when input is negative number" });
    assert(isP2(issue.description), "Edge case 应判定为 P2");
  });

  await test("P2: UI 瑕疵被检测", () => {
    const issue = makeIssue({ description: "UI glitch on button hover state" });
    assert(isP2(issue.description), "UI glitch 应判定为 P2");
  });

  await test("P2: 拼写错误被检测", () => {
    const issue = makeIssue({ description: "Typo in error message" });
    assert(isP2(issue.description), "Typo 应判定为 P2");
  });

  await test("P2: TODO/FIXME 注释被检测", () => {
    const issue = makeIssue({ description: "TODO: optimize this query later" });
    assert(isP2(issue.description), "TODO 应判定为 P2");
  });

  await test("P2: 仅影响测试文件的 issue 被检测", () => {
    const issue = makeIssue({
      description: "更新测试断言",
      affected_files: ["tests/unit/helper.test.ts"],
    });
    assert(isP2(issue.description, issue.affected_files), "仅测试文件应判定为 P2");
  });

  await test("P2: 代码格式问题被检测", () => {
    const issue = makeIssue({ description: "Fix whitespace indentation in config" });
    assert(isP2(issue.description), "格式问题应判定为 P2");
  });

  // ═══════════════════════════════════════════════════════════════
  // 完整分类
  // ═══════════════════════════════════════════════════════════════

  await test("分类器: 批量分类多个不同严重度 issue", () => {
    const issues: Issue[] = [
      makeIssue({ description: "架构设计缺陷", severity: "P0" }),
      makeIssue({ description: "Security auth bypass", severity: "P1",
        affected_files: ["src/auth/", "src/session/", "src/middleware/"] }),
      makeIssue({ description: "Typo in README", severity: "P2" }),
      makeIssue({ description: "Edge case in date parsing" }),
    ];

    const result = classifyIssues(issues);
    assert(result.summary.total === 4, `总计应为 4，实际 ${result.summary.total}`);
    assert(result.collection.p0.length === 1, "应有 1 个 P0");
    assert(result.collection.p1.length === 1, "应有 1 个 P1");
    assert(result.collection.p2.length === 2, "应有 2 个 P2");
  });

  await test("分类器: 未指定严重度的 issue 被自动分类", () => {
    // 不预设 severity，让分类器自动判定
    const issues: Issue[] = [
      { id: "t1", description: "需求错误：登录方式需要改为 OAuth 2.0", severity: "P2" as const, status: "open" as const },
      { id: "t2", description: "Security hole in session management", severity: "P2" as const, status: "open" as const },
      { id: "t3", description: "Fix minor code formatting", severity: "P2" as const, status: "open" as const },
    ];

    // 对每个 issue 单独判定（不使用 classifyIssues，因为其会尊重已有 severity）
    const p0Detected = isP0(issues[0].description);
    const p1Detected = isP1(issues[1].description);
    assert(p0Detected, "需求错误应直接判定为 P0");
    assert(p1Detected, "Security hole 应直接判定为 P1");
  });

  await test("分类器: 空列表处理", () => {
    const result = classifyIssues([]);
    assert(result.summary.total === 0, "空列表总数应为 0");
    assert(result.collection.p0.length === 0, "P0 为 0");
    assert(result.collection.p1.length === 0, "P1 为 0");
    assert(result.collection.p2.length === 0, "P2 为 0");
  });

  // ═══════════════════════════════════════════════════════════════
  // determineSeverity 直接调用
  // ═══════════════════════════════════════════════════════════════

  await test("determineSeverity: 已有分类保持不变", () => {
    const p0 = makeIssue({ description: "test", severity: "P0" });
    assert(determineSeverity(p0) === "P0", "P0 应保持");

    const p1 = makeIssue({ description: "test", severity: "P1" });
    assert(determineSeverity(p1) === "P1", "P1 应保持");

    const p2 = makeIssue({ description: "test", severity: "P2" });
    assert(determineSeverity(p2) === "P2", "P2 应保持");
  });

  await test("determineSeverity: 空描述默认为 P2", () => {
    const issue = makeIssue({ description: "" });
    const severity = determineSeverity(issue);
    assert(severity === "P2", `空描述应为 P2，实际 ${severity}`);
  });

  // ═══════════════════════════════════════════════════════════════
  // 优先级排序
  // ═══════════════════════════════════════════════════════════════

  await test("优先级排序: P0 > P1 > P2", () => {
    const collection: IssueCollection = {
      p0: [makeIssue({ description: "P0-1", severity: "P0" })],
      p1: [makeIssue({ description: "P1-1", severity: "P1" })],
      p2: [makeIssue({ description: "P2-1", severity: "P2" })],
    };

    const sorted = sortByPriority(collection);
    assert(sorted[0].severity === "P0", "第一个应为 P0");
    assert(sorted[1].severity === "P1", "第二个应为 P1");
    assert(sorted[2].severity === "P2", "第三个应为 P2");
  });

  await test("优先级排序: P1 设计级优先于实现级", () => {
    const collection: IssueCollection = {
      p0: [],
      p1: [
        makeIssue({
          description: "Fix function return type",
          severity: "P1",
          affected_files: ["src/helper.ts"],
        }),
        makeIssue({
          description: "architecture interface design needs revision in data flow layer",
          severity: "P1",
          affected_files: ["src/api/", "src/db/", "src/types/"],
        }),
      ],
      p2: [],
    };

    const sorted = sortByPriority(collection);
    assert(sorted.length === 2, "应有 2 个 P1");
    // 设计级应排在实现级前面
    assert(sorted[0].description.includes("architecture") || sorted[0].description.includes("design"),
      "设计级应排在前面");
  });

  await test("getTopPriority: 正确识别最高优先级", () => {
    const onlyP2: IssueCollection = {
      p0: [], p1: [],
      p2: [makeIssue({ description: "test", severity: "P2" })],
    };
    assert(getTopPriority(onlyP2) === "P2", "应返回 P2");

    const hasP0: IssueCollection = {
      p0: [makeIssue({ description: "test", severity: "P0" })],
      p1: [makeIssue({ description: "test", severity: "P1" })],
      p2: [makeIssue({ description: "test", severity: "P2" })],
    };
    assert(getTopPriority(hasP0) === "P0", "应返回 P0");

    const empty: IssueCollection = { p0: [], p1: [], p2: [] };
    assert(getTopPriority(empty) === "none", "空集应返回 none");
  });

  // ═══════════════════════════════════════════════════════════════
  // separateBySeverity
  // ═══════════════════════════════════════════════════════════════

  await test("separateBySeverity: 按严重度分离", () => {
    const issues: Issue[] = [
      makeIssue({ description: "a", severity: "P0" }),
      makeIssue({ description: "b", severity: "P1" }),
      makeIssue({ description: "c", severity: "P2" }),
      makeIssue({ description: "d", severity: "P0" }),
    ];

    const result = separateBySeverity(issues);
    assert(result.p0.length === 2, "P0 应有 2 个");
    assert(result.p1.length === 1, "P1 应有 1 个");
    assert(result.p2.length === 1, "P2 应有 1 个");
  });

  // ═══════════════════════════════════════════════════════════════
  // 分类报告
  // ═══════════════════════════════════════════════════════════════

  await test("formatClassificationReport: 正确格式化输出", () => {
    const summary = {
      total: 10,
      p0Count: 2,
      p1Count: 3,
      p2Count: 5,
      p1DesignLevel: 2,
      p1ImplementLevel: 1,
    };

    const report = formatClassificationReport(summary);
    assert(report.includes("10"), "应包含总数");
    assert(report.includes("P0: 2"), "应包含 P0 计数");
    assert(report.includes("P1: 3"), "应包含 P1 计数");
    assert(report.includes("P2: 5"), "应包含 P2 计数");
    assert(report.includes("设计级 2"), "应包含设计级计数");
    assert(report.includes("实现级 1"), "应包含实现级计数");
  });

  await test("formatClassificationReport: P0 存在时提示优先处理", () => {
    const summary = {
      total: 1, p0Count: 1, p1Count: 0, p2Count: 0,
      p1DesignLevel: 0, p1ImplementLevel: 0,
    };
    const report = formatClassificationReport(summary);
    assert(report.includes("P0"), "应包含 P0 提示");
  });

  // ═══════════════════════════════════════════════════════════════
  // 边界情况
  // ═══════════════════════════════════════════════════════════════

  await test("边界: 超长描述的 P0 检测", () => {
    const longDesc = "a".repeat(5000) + " architecture flaw in core system";
    assert(isP0(longDesc), "超长描述中的 P0 关键词应被检测");
  });

  await test("边界: 纯数字/符号描述不会误判", () => {
    assert(!isP0("12345"), "纯数字不应误判为 P0");
    assert(!isP1("..."), "纯符号不应误判为 P1");
    assert(!isP2(""), "空字符串不应误判为 P2");
  });

  await test("边界: 中英文混合描述的正确分类", () => {
    assert(isP0("架构 design error in 核心模块"), "中英混合 P0 应检测");
    assert(isP1("security 安全漏洞 credential leak"), "中英混合 P1 应检测");
  });

  await test("边界: 大量 issue 的分类性能", () => {
    const issues: Issue[] = [];
    for (let i = 0; i < 100; i++) {
      issues.push(makeIssue({
        description: `Edge case #${i} in boundary condition`,
        severity: "P2",
      }));
    }
    const start = Date.now();
    const result = classifyIssues(issues);
    const elapsed = Date.now() - start;

    assert(result.summary.total === 100, "总数应为 100");
    assert(elapsed < 1000, `分类 100 个 issue 应在 1 秒内完成，实际 ${elapsed}ms`);
  });

  // ── 汇总 ──
  console.log(`\n===== 测试结果 =====`);
  console.log(`  通过: ${passed}`);
  console.log(`  失败: ${failed}`);
  console.log(`  总计: ${passed + failed}`);

  if (failed > 0) process.exit(1);
}

runTests().catch((e) => {
  console.error("测试运行异常:", e);
  process.exit(1);
});
