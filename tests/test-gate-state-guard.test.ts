/**
 * gate-state-guard 单元测试
 *
 * 测试 G7 状态守护门控的完整功能：
 * - 受保护路径检测（.cursor/loop-cursor/）
 * - 受保护路径检测（.cursor/rules/）
 * - 正常业务文件通过
 * - 跨平台路径规范化（反斜杠 -> 正斜杠）
 * - 路径前缀匹配逻辑
 * - GateResult 结构完整性
 * - 边界情况
 *
 * @module test-gate-state-guard
 */

import { gateStateGuard } from "../packages/loop-core/src/gate-state-guard.js";
import type { GateResult } from "../packages/loop-core/src/gate-content-safety.js";

// ============================================================================
// 辅助函数
// ============================================================================

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

// ============================================================================
// 测试套件
// ============================================================================

async function runTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>): Promise<void> {
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

  // ── 测试 1: 正常业务文件通过 ──
  await test("正常业务文件通过保护", async () => {
    const r1 = gateStateGuard("src/utils/helper.ts");
    assert(r1.pass === true, "src 应通过");
    assert(r1.blocks.length === 0, "应无拦截");

    const r2 = gateStateGuard("package.json");
    assert(r2.pass === true, "package.json 应通过");

    const r3 = gateStateGuard("tests/test-foo.test.ts");
    assert(r3.pass === true, "tests 应通过");
  });

  // ── 测试 2: .cursor/loop-cursor/ 路径被阻断 ──
  await test(".cursor/loop-cursor/ 路径被阻断", async () => {
    const result = gateStateGuard(".cursor/loop-cursor/state.json");
    assert(result.pass === false, "loop-cursor 路径应被阻断");
    assert(result.blocks.length > 0, "应有阻断项");
    assert(result.blocks.includes(".cursor/loop-cursor/state.json"), "阻断项应包含路径");
    assert(result.reason !== undefined, "应有阻断原因");
    assert(result.reason!.includes("G7"), "原因应提到 G7");
  });

  // ── 测试 3: .cursor/rules/ 路径被阻断 ──
  await test(".cursor/rules/ 路径被阻断", async () => {
    const result = gateStateGuard(".cursor/rules/loop-cursor-rules.md");
    assert(result.pass === false, "rules 路径应被阻断");
    assert(result.blocks.length > 0, "应有阻断项");
    assert(result.reason!.includes("受保护"), "原因应提到受保护");
  });

  // ── 测试 4: Windows 反斜杠路径规范化 ──
  await test("Windows 反斜杠路径被正确识别", async () => {
    const result = gateStateGuard(".cursor\\loop-cursor\\state.json");
    assert(result.pass === false, "反斜杠路径应被阻断");
    assert(result.blocks.length > 0, "应有阻断项");
  });

  // ── 测试 5: Windows 反斜杠 rules 路径 ──
  await test("Windows 反斜杠 rules 路径被阻断", async () => {
    const result = gateStateGuard(".cursor\\rules\\rules.json");
    assert(result.pass === false, "反斜杠 rules 应被阻断");
  });

  // ── 测试 6: 不含前缀的类似路径通过 ──
  await test("不含 .cursor/ 前缀的路径通过", async () => {
    const r1 = gateStateGuard("cursor/rules/foo.txt");
    assert(r1.pass === true, "无前导点的应通过");

    const r2 = gateStateGuard("some/path/.cursor/rules/foo.txt");
    assert(r2.pass === true, "非前缀匹配应通过");
  });

  // ── 测试 7: 精确前缀匹配（不以 .cursor 开头的通过） ──
  await test("不以保护前缀开头的路径通过", async () => {
    const r1 = gateStateGuard("myapp/.cursor/loop-cursor/state.json");
    assert(r1.pass === true, "嵌套路径应通过——不是前缀");

    const r2 = gateStateGuard("project/.cursor/rules/test.md");
    assert(r2.pass === true, "嵌套 rules 应通过");
  });

  // ── 测试 8: 循环目录下的子目录均阻断 ──
  await test("受保护目录下任意深度均阻断", async () => {
    const r1 = gateStateGuard(".cursor/loop-cursor/a/b/c/d/e/f/g.txt");
    assert(r1.pass === false, "深层嵌套应阻断");

    const r2 = gateStateGuard(".cursor/rules/sub/deep/file.json");
    assert(r2.pass === false, "深层 rules 应阻断");
  });

  // ── 测试 9: 空字符串路径断开 ──
  await test("空字符串路径不匹配任何保护前缀", async () => {
    const result = gateStateGuard("");
    assert(result.pass === true, "空字符串应通过");
  });

  // ── 测试 10: 仅 .cursor 目录通过 ──
  await test("仅 .cursor 目录本身通过（不是受保护的子目录）", async () => {
    const result = gateStateGuard(".cursor/");
    assert(result.pass === true, "仅 .cursor 应通过");
  });

  // ── 测试 11: GateResult pass=true 结构 ──
  await test("GateResult pass=true 结构完整", async () => {
    const result = gateStateGuard("src/index.ts");
    assert(result.pass === true, "pass 应为 true");
    assert(Array.isArray(result.blocks), "blocks 应为数组");
    assert(result.blocks.length === 0, "blocks 应为空");
  });

  // ── 测试 12: GateResult pass=false 结构完整 ──
  await test("GateResult pass=false 结构完整", async () => {
    const result = gateStateGuard(".cursor/loop-cursor/state.json");
    assert(result.pass === false, "pass 应为 false");
    assert(Array.isArray(result.blocks), "blocks 应为数组");
    assert(result.blocks.length > 0, "blocks 应有内容");
    assert(typeof result.reason === "string", "reason 应为字符串");
  });

  // ── 测试 13: 阻断原因包含关键信息 ──
  await test("阻断原因包含 G7 标记和受保护提示", async () => {
    const result = gateStateGuard(".cursor/loop-cursor/config.json");
    assert(result.pass === false, "应阻断");
    assert(result.reason!.includes("G7"), "原因应包含 [G7]");
    assert(result.reason!.includes("受保护") || result.reason!.includes("禁止"), "原因应提示保护");
    assert(result.reason!.includes("信任") || result.reason!.includes("绕过"), "原因应提到不可绕过");
  });

  // ── 测试 14: 批量路径检测 —— 混合通过和阻断 ──
  await test("批量路径混合检测正确", async () => {
    const paths: Array<{ path: string; expected: boolean }> = [
      { path: "src/main.ts", expected: true },
      { path: ".cursor/loop-cursor/state.json", expected: false },
      { path: "README.md", expected: true },
      { path: ".cursor/rules/global.json", expected: false },
      { path: ".cursor/loop-cursor/lock", expected: false },
      { path: "tests/utils.test.ts", expected: true },
    ];
    for (const { path, expected } of paths) {
      const result = gateStateGuard(path);
      assert(result.pass === expected,
        `路径 "${path}" 期望 pass=${expected}，实际 pass=${result.pass}`);
    }
  });

  // ── 测试 15: 混合路径分隔符 ──
  await test("混合正反斜杠路径被正确处理", async () => {
    const result = gateStateGuard(".cursor/loop-cursor\\state.json");
    assert(result.pass === false, "混合分隔符应阻断——开始以保护前缀匹配");
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
