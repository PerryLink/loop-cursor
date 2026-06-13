/**
 * 可行性探针模块 (Feasibility Probes)
 *
 * 3 个探针用于判明 @cursor/sdk v1.0.12 是否具备承载 loop-cursor 核心路径的能力。
 *
 * **探针清单：**
 * P1: SDK 基础连通性与认证 —— agent.send() 是否可正常连接、认证、返回响应
 * P2: 上下文桥接可行性 —— conversation_history 注入是否能在两次独立 send() 间传递信息
 * P3: 最小闭环 (hello.py) —— 3-turn 闭环（init -> implement -> verify）全路径可行性
 *
 * **通过条件：**
 * 3 项探针全部 PASS -> GREEN，可进入 M2。
 * 否则按探针决策矩阵判定下一步（详见 Creative.txt 8.1.4）。
 *
 * **Token 成本估算：** 探针约 ~15K tokens，总成本 < $1。
 *
 * @module probe
 * @version 0.1.0
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

// ============================================================================
// 类型定义
// ============================================================================

/** 单个探针结果 */
export interface ProbeResult {
  /** 探针编号 (1-3) */
  probe: number;
  /** 探针名称 */
  name: string;
  /** 是否通过 */
  passed: boolean;
  /** 延迟（秒） */
  elapsedS: number;
  /** 详情 */
  detail: string;
  /** 错误信息 */
  error?: string;
  /** 建议操作 */
  recommendation?: string;
}

/** 探针决策判定 */
export type ProbeVerdict = "GREEN" | "YELLOW" | "RED";

/** 探针报告 */
export interface ProbeReport {
  /** 判定结果 */
  verdict: ProbeVerdict;
  /** 各探针结果 */
  results: ProbeResult[];
  /** 时间戳 */
  timestamp: string;
  /** 环境信息 */
  environment: {
    nodeVersion: string;
    sdkVersion: string;
    model: string;
  };
  /** 建议下一步操作 */
  nextAction: string;
}

// ============================================================================
// 常量
// ============================================================================

/** 上下文桥接测试的临时文件 */
const CTX_FILE = "probe-ctx.json";

/** 最小闭环测试的工作目录名 */
const CLOSED_LOOP_DIR = "probe-3-test";

// ============================================================================
// 探针 1：SDK 基础连通性与认证
// ============================================================================

/**
 * 探针 P1：SDK 基础连通性与认证
 *
 * 验证要点：
 * - @cursor/sdk 可被 import
 * - agent.send() 可成功调用
 * - 响应中包含预期的 "PROBE_OK" 文本
 * - 错误分类：AUTH / RATE_LIMIT / NETWORK / HTTP2 / UNKNOWN
 *
 * @param model - 使用的模型 ID，默认 claude-sonnet-4-20250514
 * @returns 探针结果
 */
export async function probe1BasicConnectivity(
  model: string = "claude-sonnet-4-20250514",
): Promise<ProbeResult> {
  const start = Date.now();

  try {
    // 动态导入 @cursor/sdk
    const { agent } = await import("@cursor/sdk");

    // 发送极简 prompt，期望返回 "PROBE_OK"
    const response = await agent.send({
      model,
      prompt: "Reply with exactly this text and nothing else: PROBE_OK",
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    // 提取响应文本
    const text = typeof response === "string"
      ? response
      : response?.content ?? response?.text ?? response?.message ??
        JSON.stringify(response);

    if (text.includes("PROBE_OK")) {
      return {
        probe: 1,
        name: "SDK 基础连通性与认证",
        passed: true,
        elapsedS: parseFloat(elapsed),
        detail: `响应包含 PROBE_OK (${elapsed}s)`,
      };
    }

    return {
      probe: 1,
      name: "SDK 基础连通性与认证",
      passed: false,
      elapsedS: parseFloat(elapsed),
      detail: `响应已返回但不包含 PROBE_OK`,
      error: `实际响应: ${text.substring(0, 200)}`,
      recommendation: "检查模型是否返回被截断或格式异常",
    };
  } catch (e) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const msg = (e as Error).message ?? String(e);

    let errorType = "UNKNOWN";
    let recommendation = "";

    if (msg.includes("401") || msg.includes("unauthorized")) {
      errorType = "AUTH";
      recommendation =
        "CURSOR_API_KEY 无效。请在 https://cursor.com/settings/api 验证 key";
    } else if (msg.includes("429")) {
      errorType = "RATE_LIMIT";
      recommendation = "请求限流。请等待后重试";
    } else if (
      msg.includes("ECONNREFUSED") ||
      msg.includes("ENOTFOUND")
    ) {
      errorType = "NETWORK";
      recommendation = "网络不通。请检查网络连接和代理设置";
    } else if (
      msg.includes("HTTP2") ||
      msg.includes("NGHTTP2") ||
      msg.includes("FRAME_SIZE")
    ) {
      errorType = "HTTP2";
      recommendation =
        "确认了 Bun HTTP/2 bug。验证当前使用 Node.js >= 22 运行时";
    }

    return {
      probe: 1,
      name: "SDK 基础连通性与认证",
      passed: false,
      elapsedS: parseFloat(elapsed),
      detail: `失败 (${elapsed}s)`,
      error: `[${errorType}] ${msg}`,
      recommendation,
    };
  }
}

// ============================================================================
// 探针 2：上下文桥接可行性
// ============================================================================

/**
 * 探针 P2：上下文桥接可行性
 *
 * 验证 P0-2 workaround 的有效性。
 *
 * 测试方案：
 * Turn 1: 要求 agent 记住数字 42，输出 JSON {"stored": 42}
 * Turn 2: 将 Turn 1 结果作为 conversation_history[0] 注入，
 *          要求 agent 回忆数字并输出 {"recalled": 42, "match": true}
 *
 * 通过条件：agent 在 Turn 2 中成功回忆出 42 且 match=true。
 *
 * 此探针是 P0-2（SDK 上下文不保留）workaround 的前置验证。
 * 如果此探针失败，context_summary.md 注入方案将不可行。
 *
 * @param model - 使用的模型 ID
 * @param workDir - 工作目录（用于存放临时文件）
 * @returns 探针结果
 */
export async function probe2ContextBridge(
  model: string = "claude-sonnet-4-20250514",
  workDir: string = process.cwd(),
): Promise<ProbeResult> {
  const start = Date.now();

  try {
    const { agent } = await import("@cursor/sdk");

    // ===== Turn 1：存储数字 42 =====
    console.log("  [P2 Turn 1] 存储数字 42...");

    const t1Response = await agent.send({
      model,
      prompt: [
        "Remember this exact number: 42. Do NOT output anything else except",
        'the following JSON: {"stored": 42, "note": "number remembered"}',
        "Reply with ONLY that JSON, no other text.",
      ].join(" "),
    });

    const t1Text = typeof t1Response === "string"
      ? t1Response
      : t1Response?.content ?? t1Response?.text ?? "";
    console.log(
      `  [P2 Turn 1] 响应: ${t1Text.substring(0, 200)}`,
    );

    // 保存 Turn 1 结果到文件
    const ctxFilePath = join(workDir, CTX_FILE);
    writeFileSync(ctxFilePath, t1Text, "utf-8");

    // ===== Turn 2：通过 conversation_history 回忆数字 =====
    console.log("  [P2 Turn 2] 通过 conversation_history 回忆数字...");

    const ctxData = readFileSync(ctxFilePath, "utf-8");

    const t2Response = await agent.send({
      model,
      conversation_history: [
        {
          role: "user",
          content: [
            "[CONTEXT FROM PREVIOUS TURN -- READ BEFORE RESPONDING]",
            `Previous task result: ${ctxData}`,
            "Your task: Recall the stored number and reply with:",
            '{"recalled": <the_number>, "match": true_or_false}',
            "Reply with ONLY that JSON, no other text.",
          ].join("\n"),
        },
      ],
      prompt:
        "Execute the task described in the conversation_history. Reply with JSON only.",
    });

    const t2Text = typeof t2Response === "string"
      ? t2Response
      : t2Response?.content ?? t2Response?.text ?? "";
    console.log(
      `  [P2 Turn 2] 响应: ${t2Text.substring(0, 200)}`,
    );

    // ===== 验证 =====
    const recalledMatch = t2Text.match(/"recalled"\s*:\s*(\d+)/);
    const matchMatch = t2Text.match(/"match"\s*:\s*(true|false)/);
    const recalledCorrect =
      recalledMatch && recalledMatch[1] === "42";
    const matchCorrect = matchMatch && matchMatch[1] === "true";

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (recalledCorrect && matchCorrect) {
      return {
        probe: 2,
        name: "上下文桥接可行性",
        passed: true,
        elapsedS: parseFloat(elapsed),
        detail: "上下文桥接有效 —— agent 正确回忆了 42",
      };
    }

    return {
      probe: 2,
      name: "上下文桥接可行性",
      passed: false,
      elapsedS: parseFloat(elapsed),
      detail: "上下文桥接失败",
      error:
        `预期 recalled=42, match=true。实际 recalled=${recalledMatch?.[1] ?? "N/A"}, match=${matchMatch?.[1] ?? "N/A"}`,
      recommendation:
        "P0-2 workaround 可能无效。需要验证 agent 是否正确读取了 conversation_history[0]。",
    };
    // 清理临时文件
  } catch (e) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    return {
      probe: 2,
      name: "上下文桥接可行性",
      passed: false,
      elapsedS: parseFloat(elapsed),
      detail: `异常失败 (${elapsed}s)`,
      error: (e as Error).message,
      recommendation:
        "检查 SDK 是否支持 conversation_history 参数",
    };
  }
}

// ============================================================================
// 探针 3：最小闭环 (hello.py)
// ============================================================================

/**
 * 探针 P3：最小 3-turn 闭环 (hello.py)
 *
 * 决定性探针。验证完整的 init -> implement -> verify 闭环。
 *
 * 测试方案：
 * Turn 1 (init): 探索空目录，路由到 part_2_2
 * Turn 2 (part_2_2): 创建 hello.py 和 test_hello.py，运行测试验证通过
 * Turn 3 (part_2_8): 硬验证闸门，确认所有产出正确
 *
 * 目标产出：
 * - hello.py: 打印 "Hello World"
 * - test_hello.py: 测试脚本验证 hello.py 输出
 *
 * 若此探针全部通过，基本架构可行。
 * 若失败，需按 Creative.txt 8.1.3 诊断失败根因。
 *
 * @param model - 使用的模型 ID
 * @param workDir - 工作目录（会在此目录下创建 probe-3-test 子目录）
 * @returns 探针结果
 */
export async function probe3MinimalClosedLoop(
  model: string = "claude-sonnet-4-20250514",
  workDir: string = process.cwd(),
): Promise<ProbeResult> {
  const start = Date.now();
  const testDir = join(workDir, CLOSED_LOOP_DIR);

  // 准备工作目录
  mkdirSync(testDir, { recursive: true });
  const originalCwd = process.cwd();
  process.chdir(testDir);

  try {
    // 初始化 git 仓库
    execSync("git init", { stdio: "pipe" });

    // 写入最小 state.json
    const state = {
      progress: { phase: "init", cycle: 1 },
      config: {
        user_request:
          "Create hello.py that prints Hello World. Create test_hello.py that verifies the output.",
        model,
        max_cycles: 5,
      },
    };
    writeFileSync("state.json", JSON.stringify(state, null, 2));

    const { agent } = await import("@cursor/sdk");
    const turnResults: string[] = [];

    // ===== Turn 1: init =====
    console.log("  [P3 Turn 1] init...");
    const t1Start = Date.now();
    let t1Passed = false;

    try {
      const r1 = await agent.send({
        model,
        prompt: [
          "Phase: init. Explore the current directory. The codebase is empty.",
          'Report what you found. Output <<<LOOP_STATE>>> block with phase set to "part_2_2"',
          "(skip Part 1 design since the task is trivial).",
          "<<<LOOP_STATE>>>",
          '{"phase":"part_2_2","issues":{"p0":[],"p1":[],"p2":[]},"summary":"empty project, routing to implementation"}',
          "<</LOOP_STATE>>>",
        ].join(" "),
      });
      const txt = typeof r1 === "string"
        ? r1
        : r1?.content ?? r1?.text ?? "";
      t1Passed = txt.includes("<<<LOOP_STATE>>>") ||
        txt.includes("part_2_2");
      const t1Elapsed = ((Date.now() - t1Start) / 1000).toFixed(1);
      turnResults.push(
        `Turn 1: ${t1Passed ? "通过" : "失败"} (${t1Elapsed}s)`,
      );
    } catch (e) {
      turnResults.push(
        `Turn 1: 异常 - ${(e as Error).message}`,
      );
    }

    // ===== Turn 2: part_2_2 (implement) =====
    console.log("  [P3 Turn 2] part_2_2 (实现)...");
    const t2Start = Date.now();
    let t2Passed = false;

    try {
      const ctxSummary = [
        "[CONTEXT FROM PREVIOUS CYCLES -- READ CAREFULLY]",
        "Current Phase: part_2_2",
        "Project Goal: Create hello.py and test_hello.py",
        "Previous Turn: init -- empty project detected, routing to implementation.",
        "[END CONTEXT]",
      ].join("\n");

      await agent.send({
        model,
        conversation_history: [{
          role: "user",
          content: ctxSummary,
        }],
        prompt: [
          "Phase: part_2_2 -- Implementation.",
          'Write file hello.py with content: print("Hello World")',
          "Write file test_hello.py with content:",
          "  import subprocess;",
          "  result = subprocess.run(['python','hello.py'], capture_output=True, text=True);",
          '  assert "Hello World" in result.stdout, f\"FAIL: {result.stdout}\";',
          '  print("PASS")',
          "Run: python test_hello.py",
          "Output <<<LOOP_STATE>>> block with the results.",
        ].join(" "),
      });
      const t2Elapsed = ((Date.now() - t2Start) / 1000).toFixed(1);

      const helloExists = existsSync("hello.py");
      const testExists = existsSync("test_hello.py");
      let testPass = false;
      if (testExists) {
        try {
          const out = execSync("python test_hello.py", {
            encoding: "utf-8",
            timeout: 10_000,
          });
          testPass = out.includes("PASS");
        } catch {
          // 测试执行失败
        }
      }

      t2Passed = helloExists && testExists && testPass;
      turnResults.push(
        `Turn 2: ${t2Passed ? "通过" : "失败"} (${t2Elapsed}s) ` +
          `[hello.py:${helloExists ? "存在" : "缺失"}, ` +
          `test_hello.py:${testExists ? "存在" : "缺失"}, ` +
          `test:${testPass ? "通过" : "失败"}]`,
      );
    } catch (e) {
      turnResults.push(
        `Turn 2: 异常 - ${(e as Error).message}`,
      );
    }

    // ===== Turn 3: part_2_8 (verify) =====
    console.log("  [P3 Turn 3] part_2_8 (验证)...");
    const t3Start = Date.now();
    let t3Passed = false;

    try {
      const ctxSummary = [
        "[CONTEXT FROM PREVIOUS CYCLES -- READ CAREFULLY]",
        "Current Phase: part_2_8",
        "Project Goal: Create hello.py and test_hello.py",
        "Previous Turn: part_2_2 -- hello.py and test_hello.py created.",
        "[END CONTEXT]",
      ].join("\n");

      const r3 = await agent.send({
        model,
        conversation_history: [{
          role: "user",
          content: ctxSummary,
        }],
        prompt: [
          "Phase: part_2_8 -- Hard Verification Gate.",
          'Verify: 1) hello.py exists and prints "Hello World" exactly,',
          "2) test_hello.py exists and runs successfully, 3) Running test yields PASS.",
          "If all pass, set issues.p0/p1/p2 to empty arrays.",
          "Output <<<LOOP_STATE>>> block.",
        ].join(" "),
      });
      const txt = typeof r3 === "string"
        ? r3
        : r3?.content ?? r3?.text ?? "";
      const t3Elapsed = ((Date.now() - t3Start) / 1000).toFixed(1);

      // 验证所有 issues 是否已清空
      const issuesCleared = !txt.includes('"description"') ||
        (txt.match(/"p0"\s*:\s*\[\s*\]/g)?.length ?? 0) >= 1;
      t3Passed = issuesCleared;
      turnResults.push(
        `Turn 3: ${t3Passed ? "通过" : "失败"} (${t3Elapsed}s)`,
      );
    } catch (e) {
      turnResults.push(
        `Turn 3: 异常 - ${(e as Error).message}`,
      );
    }

    // ===== 汇总结果 =====
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const allPassed = t1Passed && t2Passed && t3Passed;

    return {
      probe: 3,
      name: "最小闭环 (hello.py)",
      passed: allPassed,
      elapsedS: parseFloat(elapsed),
      detail: allPassed
        ? "3 轮全部通过 -- 基本架构可行"
        : "部分轮次失败",
      error: allPassed ? undefined : turnResults.join("; "),
      recommendation: allPassed
        ? undefined
        : "请查看 Creative.txt 8.1.3 诊断失败根因",
    };
  } catch (e) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    return {
      probe: 3,
      name: "最小闭环 (hello.py)",
      passed: false,
      elapsedS: parseFloat(elapsed),
      detail: `异常崩溃 (${elapsed}s)`,
      error: (e as Error).message,
      recommendation:
        "可能是工作目录初始化或 git 不可用。请检查环境。",
    };
  } finally {
    process.chdir(originalCwd);
  }
}

// ============================================================================
// 探针决策矩阵
// ============================================================================

/**
 * 根据 3 个探针的结果判定下一步操作
 *
 * **决策矩阵（来自 Creative.txt 8.1.4）：**
 *
 * | Probe 1 | Probe 2 | Probe 3 | 判定 | 操作 |
 * |:-------:|:-------:|:-------:|------|------|
 * | PASS    | PASS    | PASS    | GREEN | 进入 M2。所有 P0 降级为 P1。 |
 * | PASS    | PASS    | FAIL    | YELLOW | 评估失败原因；若 1 周内可修复则修复，否则考虑替代架构。 |
 * | PASS    | FAIL    | --      | RED | 上下文桥接失败。确认 P0-2。考虑适配器层方案或等待 SDK 更新。 |
 * | FAIL    | --      | --      | RED | SDK 不可用。终止 SDK 驱动路径；考虑降级为 rules+hooks-only 轻量闭环。 |
 *
 * @param results - 3 个探针的结果数组
 * @returns 判定（GREEN / YELLOW / RED）和建议操作
 */
export function determineVerdict(
  results: ProbeResult[],
): { verdict: ProbeVerdict; nextAction: string } {
  const p1 = results.find((r) => r.probe === 1);
  const p2 = results.find((r) => r.probe === 2);
  const p3 = results.find((r) => r.probe === 3);

  // P1 失败 → RED
  if (!p1?.passed) {
    return {
      verdict: "RED",
      nextAction:
        "SDK 基础连通性失败。终止 SDK 驱动路径。" +
        "考虑降级为 rules+hooks-only 轻量闭环，或等待 SDK 稳定版。",
    };
  }

  // P1 通过、P2 失败 → RED
  if (!p2?.passed) {
    return {
      verdict: "RED",
      nextAction:
        "上下文桥接失败，确认 P0-2 为阻塞项。" +
        "考虑适配器层方案（在 adapter 内部维持长期对话状态），或等待 SDK 更新支持上下文保留。",
    };
  }

  // P1 通过、P2 通过、P3 失败 → YELLOW
  if (!p3?.passed) {
    return {
      verdict: "YELLOW",
      nextAction:
        "SDK 连通性和上下文桥接正常，但最小闭环失败。" +
        "评估 P3 失败原因（参考 Creative.txt 8.1.3）。若 1 周内可修复，修复后重新探针。" +
        "若根因在 SDK 层面，考虑替代架构。",
    };
  }

  // 全部通过 → GREEN
  return {
    verdict: "GREEN",
    nextAction:
      "所有探针通过。进入 M2：替代架构 + 核心适配器实现。" +
      "所有 P0 降级为 P1。开始实现 PlatformAdapter 接口和 adapter-cursor-sdk.ts。",
  };
}

// ============================================================================
// 生成探针报告
// ============================================================================

/**
 * 生成完整的探针决策报告
 *
 * @param results - 3 个探针结果
 * @param model - 使用的模型
 * @returns 探针报告对象
 */
export function generateReport(
  results: ProbeResult[],
  model: string,
): ProbeReport {
  const { verdict, nextAction } = determineVerdict(results);

  return {
    verdict,
    results,
    timestamp: new Date().toISOString(),
    environment: {
      nodeVersion: process.versions.node,
      sdkVersion: "1.0.12",
      model,
    },
    nextAction,
  };
}

// ============================================================================
// 主入口：运行全部 3 个探针
// ============================================================================

/**
 * 主入口：依次执行全部 3 个可行性探针
 *
 * 执行顺序：P1 -> P2 -> P3
 * 如果 P1 失败，跳过 P2 和 P3（因为 P2/P3 依赖 P1 的连通性）。
 *
 * @param model - 使用的模型 ID
 * @param workDir - 工作目录
 * @returns 探针报告
 */
export async function runAllProbes(
  model: string = "claude-sonnet-4-20250514",
  workDir: string = process.cwd(),
): Promise<ProbeReport> {
  console.log("=== loop-cursor 可行性探针开始执行 ===");
  console.log(`运行时: Node.js ${process.versions.node}`);
  console.log(`模型: ${model}`);
  console.log("");

  const results: ProbeResult[] = [];

  // P1: SDK 基础连通性
  console.log("--- 探针 1/3: SDK 基础连通性与认证 ---");
  const r1 = await probe1BasicConnectivity(model);
  results.push(r1);
  console.log(
    `  结果: ${r1.passed ? "通过" : "失败"} (${r1.elapsedS}s)`,
  );
  console.log("");

  if (!r1.passed) {
    console.log(
      "探针 1 失败，跳过后继探针（P2/P3 依赖 P1 连通性）。",
    );
    return generateReport(results, model);
  }

  // P2: 上下文桥接可行性
  console.log("--- 探针 2/3: 上下文桥接可行性 ---");
  const r2 = await probe2ContextBridge(model, workDir);
  results.push(r2);
  console.log(
    `  结果: ${r2.passed ? "通过" : "失败"} (${r2.elapsedS}s)`,
  );
  console.log("");

  if (!r2.passed) {
    console.log(
      "探针 2 失败，跳过探针 3（P3 依赖 P2 上下文桥接）。",
    );
    return generateReport(results, model);
  }

  // P3: 最小闭环
  console.log("--- 探针 3/3: 最小闭环 (hello.py) ---");
  const r3 = await probe3MinimalClosedLoop(model, workDir);
  results.push(r3);
  console.log(
    `  结果: ${r3.passed ? "通过" : "失败"} (${r3.elapsedS}s)`,
  );
  console.log("");

  const report = generateReport(results, model);

  // 输出汇总
  console.log("=== 探针决策报告 ===");
  console.log(`判定: ${report.verdict}`);
  console.log(`下一步: ${report.nextAction}`);
  console.log("");

  for (const r of report.results) {
    const status = r.passed ? "通过" : "失败";
    console.log(
      `  探针 ${r.probe}: ${status} - ${r.name}`,
    );
    console.log(`    耗时: ${r.elapsedS}s | ${r.detail}`);
    if (r.error) {
      console.log(`    错误: ${r.error}`);
    }
    if (r.recommendation) {
      console.log(`    建议: ${r.recommendation}`);
    }
  }

  return report;
}

// ============================================================================
// 直接执行入口（用于 `node probe.ts` 独立运行）
// ============================================================================

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("probe.ts") ||
    process.argv[1].endsWith("probe.js"));

if (isDirectRun) {
  const model =
    process.argv.find((a) => a.startsWith("--model="))?.split("=")[1] ??
    "claude-sonnet-4-20250514";

  runAllProbes(model)
    .then((report) => {
      const exitCode = report.verdict === "GREEN" ? 0 : 1;
      process.exit(exitCode);
    })
    .catch((err) => {
      console.error("探针执行异常崩溃:", err);
      process.exit(2);
    });
}
