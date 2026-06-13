/**
 * gate-content-safety 单元测试
 *
 * 测试 G1 内容安全闸门的完整功能：
 * - 明文密码检测
 * - API Key 泄露检测
 * - Token 泄露检测
 * - PEM 私钥检测
 * - AWS Access Key 检测
 * - 疑似凭证检测
 * - 空输入/非字符串输入处理
 * - 安全输出通过
 *
 * @module test-gate-content-safety
 */

import { gateContentSafety } from "../packages/loop-core/src/gate-content-safety.js";
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

  // ── 测试 1: 安全输出通过 ──
  await test("安全输出（无敏感信息）通过检测", async () => {
    const result = gateContentSafety("import React from 'react';\nconsole.log('hello');");
    assert(result.pass === true, "安全代码应通过");
    assert(result.blocks.length === 0, "应无拦截项");
  });

  // ── 测试 2: 明文密码赋值检测 ──
  await test("检测明文密码赋值", async () => {
    const result = gateContentSafety('password = "MyS3cretP@ss!"');
    assert(result.pass === false, "应拦截明文密码");
    assert(result.blocks.length > 0, "应有拦截项");
    assert(result.blocks.some((b) => b.includes("明文密码")), "拦截项应包含密码");
  });

  // ── 测试 3: 明文 Secret 检测 ──
  await test("检测明文 Secret 赋值", async () => {
    const result = gateContentSafety('secret = "abc123def456ghi789"');
    assert(result.pass === false, "应拦截明文 Secret");
    assert(result.blocks.some((b) => b.includes("Secret")), "拦截项应包含 Secret");
  });

  // ── 测试 4: API Key 泄露检测 ──
  await test("检测 API Key 泄露", async () => {
    const result = gateContentSafety('api_key = "sk-1234567890abcdef"');
    assert(result.pass === false, "应拦截 API Key");
    assert(result.blocks.some((b) => b.includes("API Key")), "拦截项应包含 API Key");
  });

  // ── 测试 5: API Key 下划线变体检测 ──
  await test("检测 apiKey 驼峰命名变体", async () => {
    const result = gateContentSafety('apiKey = "sk-proj-abcdefghijklmnop"');
    assert(result.pass === false, "应拦截 apiKey 变体");
    assert(result.blocks.some((b) => b.includes("API Key")), "拦截项应包含 API Key");
  });

  // ── 测试 6: Access Token 泄露检测 ──
  await test("检测 Access Token 泄露", async () => {
    const result = gateContentSafety('access_token = "ya29.a0AfH6S..."');
    assert(result.pass === false, "应拦截 Token");
    assert(result.blocks.some((b) => b.includes("Token")), "拦截项应包含 Token");
  });

  // ── 测试 7: Token 泄露检测（简化形式） ──
  await test("检测 Token 赋值（token =）", async () => {
    const result = gateContentSafety('token = "ghp_1234567890abcdefghijklmnop"');
    assert(result.pass === false, "应拦截 token");
    assert(result.blocks.some((b) => b.includes("Token")), "拦截项应包含 Token");
  });

  // ── 测试 8: PEM RSA 私钥检测（BEGIN） ──
  await test("检测 RSA 私钥 BEGIN 标记", async () => {
    const result = gateContentSafety(
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----"
    );
    assert(result.pass === false, "应拦截私钥");
    assert(result.blocks.some((b) => b.includes("私钥泄露")), "拦截项应包含私钥");
  });

  // ── 测试 9: PEM EC 私钥检测 ──
  await test("检测 EC 私钥", async () => {
    const result = gateContentSafety(
      "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIO...\n-----END EC PRIVATE KEY-----"
    );
    assert(result.pass === false, "应拦截 EC 私钥");
    assert(result.blocks.some((b) => b.includes("私钥泄露")), "拦截项应包含私钥");
  });

  // ── 测试 10: OpenSSH 私钥检测 ──
  await test("检测 OpenSSH 私钥", async () => {
    const result = gateContentSafety(
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXkt...\n-----END OPENSSH PRIVATE KEY-----"
    );
    assert(result.pass === false, "应拦截 OpenSSH 私钥");
    assert(result.blocks.some((b) => b.includes("私钥泄露")), "拦截项应包含私钥");
  });

  // ── 测试 11: AWS Access Key 检测（AKIA 前缀） ──
  await test("检测 AWS Access Key (AKIA)", async () => {
    const result = gateContentSafety("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE");
    assert(result.pass === false, "应拦截 AWS Key");
    assert(result.blocks.some((b) => b.includes("AWS")), "拦截项应包含 AWS");
  });

  // ── 测试 12: 疑似凭证泄露检测 ──
  await test("检测疑似凭证泄露（auth=长字符串）", async () => {
    const result = gateContentSafety('auth = "dGhpcyBpcyBhIGJhc2U2NCBlbmNvZGVkIHN0cmluZw=="');
    assert(result.pass === false, "应拦截疑似凭证");
    assert(result.blocks.some((b) => b.includes("疑似凭证")), "拦截项应包含疑似凭证");
  });

  // ── 测试 13: 疑似凭证（credential =） ──
  await test("检测 credential 赋值", async () => {
    const result = gateContentSafety('credential = "abcdefghijklmnopqrstuvwxyz1234567890"');
    assert(result.pass === false, "应拦截 credential");
    assert(result.blocks.some((b) => b.includes("疑似凭证")), "拦截项应包含疑似凭证");
  });

  // ── 测试 14: 多类型拦截汇总 ──
  await test("多类型敏感信息同时拦截", async () => {
    const result = gateContentSafety(
      'password = "p@ss"\napi_key = "sk-abc"\ntoken = "ghp_xyz"'
    );
    assert(result.pass === false, "应拦截多项");
    assert(result.blocks.length >= 3, `至少应拦截 3 项，实际 ${result.blocks.length}`);
    assert(result.reason !== undefined, "应有拦截原因");
  });

  // ── 测试 15: 空字符串通过 ──
  await test("空字符串通过检测", async () => {
    const result = gateContentSafety("");
    assert(result.pass === true, "空字符串应通过");
    assert(result.blocks.length === 0, "应无拦截项");
  });

  // ── 测试 16: null/undefined 输入通过 ──
  await test("null/undefined 输入通过检测", async () => {
    const r1 = gateContentSafety(null as unknown as string);
    assert(r1.pass === true, "null 应通过");

    const r2 = gateContentSafety(undefined as unknown as string);
    assert(r2.pass === true, "undefined 应通过");
  });

  // ── 测试 17: 数字输入通过 ──
  await test("非字符串输入通过检测", async () => {
    const result = gateContentSafety(42 as unknown as string);
    assert(result.pass === true, "数字应通过");
    assert(result.blocks.length === 0, "应无拦截项");
  });

  // ── 测试 18: 短 Token 不误拦截 ──
  await test("短 token 字符串不误拦截", async () => {
    const result = gateContentSafety('token = "short"');
    assert(result.pass === true, "短 token 应通过——不满足最小长度要求");
  });

  // ── 测试 19: 注释中的密码也拦截 ──
  await test("注释中的密码也检测", async () => {
    const result = gateContentSafety('// password = "secret123"');
    assert(result.pass === false, "注释中的密码也应拦截");
  });

  // ── 测试 20: 正常环境变量配置通过 ──
  await test("正常环境变量赋值通过（无硬编码值）", async () => {
    const result = gateContentSafety(
      'const password = process.env.DB_PASSWORD;\nconst key = getApiKey();'
    );
    assert(result.pass === true, "从环境变量读取应通过");
    assert(result.blocks.length === 0, "应无拦截项");
  });

  // ── 测试 21: 假阳性 —— 变量名含 password 但非赋值 ──
  await test("cancelPasswordReset 不误拦截", async () => {
    const result = gateContentSafety("cancelPasswordReset(userId);");
    assert(result.pass === true, "非赋值语境应通过");
  });

  // ── 测试 22: GateResult 结构完整性 ──
  await test("GateResult 返回结构完整", async () => {
    const pass = gateContentSafety("safe code");
    assert(pass.pass === true, "通过结果 pass 应为 true");
    assert(Array.isArray(pass.blocks), "blocks 应为数组");
    assert(pass.blocks.length === 0, "通过结果 blocks 应为空");

    const fail = gateContentSafety('password = "secret"');
    assert(fail.pass === false, "失败结果 pass 应为 false");
    assert(Array.isArray(fail.blocks), "blocks 应为数组");
    assert(fail.blocks.length > 0, "失败结果 blocks 应有内容");
    assert(fail.reason !== undefined, "失败结果应有 reason");
    assert(typeof fail.reason === "string", "reason 应为字符串");
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
