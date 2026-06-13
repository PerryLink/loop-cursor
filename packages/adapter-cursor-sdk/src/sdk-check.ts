/**
 * SDK 兼容性检查模块 (5 项检查)
 *
 * 在 loop-cursor 启动时强制执行 5 项兼容性检查。
 * 所有检查通过后才允许进入主循环。
 *
 * **5 项检查清单：**
 * CHECK 1/5: Node.js >= 22 运行时版本
 * CHECK 2/5: @cursor/sdk 包可加载
 * CHECK 3/5: SDK 版本精确匹配 1.0.12（不使用 ^ 或 ~）
 * CHECK 4/5: CURSOR_API_KEY 有效（发送轻量 agent.send() 测试）
 * CHECK 5/5: agent 响应格式兼容（包含 content 字段）
 *
 * **缓存策略：**
 * - 检查结果缓存到 .cursor/loop-cursor/.compat-check
 * - 缓存有效期 24 小时
 * - 缓存有效时跳过 CHECK 4-5（省 API tokens）
 * - 使用 --force-check 强制全量重新检查
 * - 使用 --no-check 跳过所有检查（开发模式）
 *
 * **缓存键设计：**
 * 缓存依赖：SDK 版本 + Node.js 版本 + API Key 哈希前 8 位
 * 任意一项变化 → 缓存失效 → 重新全量检查
 *
 * @module sdk-check
 * @version 0.1.0
 */

import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CompatibilityCheckResult,
  CompatibilityCheckItem,
} from "@loop-cursor/core";
import {
  EXPECTED_SDK_VERSION,
  COMPAT_CHECK_CACHE_FILE,
  COMPAT_CHECK_CACHE_TTL_MS,
} from "@loop-cursor/core/config";

// ============================================================================
// 路径与常量
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 状态文件目录 */
const STATE_DIR = join(__dirname, "..", "..", ".cursor", "loop-cursor");

/** 兼容性检查缓存文件路径 */
const CACHE_FILE = join(STATE_DIR, ".compat-check");

/** @cursor/sdk 的 package.json 路径（用于版本检查） */
const SDK_PACKAGE_PATH = join(
  __dirname,
  "..",
  "node_modules",
  "@cursor",
  "sdk",
  "package.json",
);

/** 单次检查超时（毫秒） */
const CHECK_TIMEOUT_MS = 15_000;

/** 总检查超时（毫秒） */
const TOTAL_TIMEOUT_MS = 60_000;

// ============================================================================
// 命令行参数解析
// ============================================================================

/** 检查模式 */
type CheckMode = "normal" | "force" | "skip";

function parseCheckMode(): CheckMode {
  if (process.argv.includes("--force-check")) return "force";
  if (process.argv.includes("--no-check")) return "skip";
  return "normal";
}

// ============================================================================
// 缓存管理
// ============================================================================

/**
 * 读取并验证缓存
 *
 * 缓存有效条件：
 * 1. 缓存文件存在且可解析
 * 2. 缓存未过期（valid_until > 当前时间）
 * 3. SDK 版本未变化
 * 4. Node.js 版本未变化
 * 5. API Key 哈希未变化
 *
 * @returns 缓存有效时返回缓存数据，否则返回 null
 */
function readCache(): Record<string, unknown> | null {
  if (!existsSync(CACHE_FILE)) return null;

  try {
    const raw = readFileSync(CACHE_FILE, "utf-8");
    const cache = JSON.parse(raw);
    const apiKey = process.env.CURSOR_API_KEY ?? "";
    const keyHash = createHash("sha256")
      .update(apiKey)
      .digest("hex")
      .substring(0, 8);

    const isExpired =
      new Date(cache.cache_valid_until).getTime() <= Date.now();
    const sdkChanged = cache.sdk_version_checked !== EXPECTED_SDK_VERSION;
    const nodeChanged = cache.node_version_checked !== process.versions.node;
    const keyChanged = cache.api_key_hash !== keyHash;

    if (isExpired || sdkChanged || nodeChanged || keyChanged) {
      return null;
    }

    return cache;
  } catch {
    return null;
  }
}

/**
 * 写入缓存
 *
 * @param checks - 检查结果列表
 */
function writeCache(checks: CompatibilityCheckItem[]): void {
  const apiKey = process.env.CURSOR_API_KEY ?? "";
  const keyHash = createHash("sha256")
    .update(apiKey)
    .digest("hex")
    .substring(0, 8);

  mkdirSync(dirname(CACHE_FILE), { recursive: true });

  writeFileSync(
    CACHE_FILE,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        checks: Object.fromEntries(
          checks.map((c) => [
            c.name.toLowerCase().replace(/\s+/g, "_"),
            c.pass ? "pass" : "fail",
          ]),
        ),
        sdk_version_checked: EXPECTED_SDK_VERSION,
        node_version_checked: process.versions.node,
        api_key_hash: keyHash,
        cache_valid_until: new Date(
          Date.now() + COMPAT_CHECK_CACHE_TTL_MS,
        ).toISOString(),
      },
      null,
      2,
    ),
    "utf-8",
  );
}

// ============================================================================
// 各检查项实现
// ============================================================================

/**
 * CHECK 2/5：SDK 包可加载性检查
 *
 * 验证 @cursor/sdk 是否已安装且可被 import 加载。
 * 动态 import 测试，不依赖顶层静态 import。
 */
async function checkSdkPackage(): Promise<CompatibilityCheckItem> {
  try {
    await import("@cursor/sdk");
    return {
      name: "SDK 包加载",
      pass: true,
      detail: "@cursor/sdk 加载成功",
    };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ERR_MODULE_NOT_FOUND") {
      return {
        name: "SDK 包加载",
        pass: false,
        detail:
          "@cursor/sdk 未安装。修复: cd .cursor/loop-cursor && npm install @cursor/sdk@1.0.12 --save-exact",
      };
    }
    return {
      name: "SDK 包加载",
      pass: false,
      detail: `@cursor/sdk 加载失败: ${err.message}`,
    };
  }
}

/**
 * CHECK 3/5：SDK 版本精确匹配检查
 *
 * 验证已安装的 @cursor/sdk 版本是否精确匹配 1.0.12。
 * SDK 处于 Public Beta —— 任何升级都可能引入 breaking changes，
 * 因此必须精确 pin 版本，不使用 ^ 或 ~ 前缀。
 */
function checkSdkVersion(): CompatibilityCheckItem {
  if (!existsSync(SDK_PACKAGE_PATH)) {
    return {
      name: "SDK 版本",
      pass: false,
      detail: `找不到 @cursor/sdk 的 package.json。预期路径: ${SDK_PACKAGE_PATH}`,
    };
  }

  try {
    const pkg = JSON.parse(readFileSync(SDK_PACKAGE_PATH, "utf-8"));
    const installed = pkg.version;

    if (installed === EXPECTED_SDK_VERSION) {
      return {
        name: "SDK 版本",
        pass: true,
        detail: `${installed} 精确匹配`,
      };
    }

    return {
      name: "SDK 版本",
      pass: false,
      detail: `版本不匹配。预期: ${EXPECTED_SDK_VERSION} (精确 pin，禁止 ^/~)，实际安装: ${installed}。` +
        `修复: npm install @cursor/sdk@${EXPECTED_SDK_VERSION} --save-exact`,
    };
  } catch (e) {
    return {
      name: "SDK 版本",
      pass: false,
      detail: `无法读取 SDK package.json: ${(e as Error).message}`,
    };
  }
}

/**
 * CHECK 4/5：API Key 有效性检查
 *
 * 验证 CURSOR_API_KEY 环境变量是否设置且有效。
 * 发送轻量 agent.send() 调用到 cursor-small 模型来测试连通性。
 * 15 秒超时。
 *
 * 会将 agent 响应保存到全局变量，供 CHECK 5 复用。
 */
async function checkApiKey(): Promise<CompatibilityCheckItem> {
  const apiKey = process.env.CURSOR_API_KEY;

  if (!apiKey) {
    return {
      name: "API Key",
      pass: false,
      detail: "CURSOR_API_KEY 环境变量未设置。" +
        "修复: export CURSOR_API_KEY=cur-... 或创建 .cursor/.env 文件并添加 CURSOR_API_KEY=cur-...",
    };
  }

  if (!apiKey.startsWith("cur-")) {
    console.warn(
      "警告: CURSOR_API_KEY 不以 'cur-' 开头，可能是无效 key。",
    );
  }

  try {
    const { agent } = await import("@cursor/sdk");
    const startMs = Date.now();

    const response = await Promise.race([
      agent.send({
        model: "cursor-small",
        prompt: "Reply with exactly one word: ok",
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("CHECK_TIMEOUT")),
          CHECK_TIMEOUT_MS,
        )
      ),
    ]);

    const text = typeof response === "string"
      ? response
      : response?.content ?? response?.text ?? "";

    if (text && text.trim().length > 0) {
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      // 保存响应供 CHECK 5 复用（避免重复 API 调用）
      (globalThis as Record<string, unknown>).__CHECK4_RESPONSE = response;
      return {
        name: "API Key",
        pass: true,
        detail: `cursor-small 响应成功 (${elapsed}s)`,
      };
    }

    return {
      name: "API Key",
      pass: false,
      detail: "Agent 返回空响应。可能原因: 无效 key、限流、或模型不可用。",
    };
  } catch (e) {
    const msg = (e as Error).message;

    if (msg === "CHECK_TIMEOUT") {
      return {
        name: "API Key",
        pass: false,
        detail: "超时 (15s)。可能原因: 网络不通、限流、或模型过载。",
      };
    }
    if (msg.includes("401") || msg.includes("unauthorized")) {
      return {
        name: "API Key",
        pass: false,
        detail: "API Key 被拒绝 (401)。请在 https://cursor.com/settings/api 验证 key 是否有效。",
      };
    }
    if (msg.includes("429")) {
      return {
        name: "API Key",
        pass: false,
        detail: "请求限流 (429)。请在 https://cursor.com/settings/usage 查看用量。",
      };
    }

    return {
      name: "API Key",
      pass: false,
      detail: `Agent 调用失败: ${msg}`,
    };
  }
}

/**
 * CHECK 5/5：响应格式兼容性验证
 *
 * 复用 CHECK 4 的 agent 响应，验证响应对象结构是否兼容。
 * 检查项：
 * - 响应是否为对象类型
 * - 是否存在 content/text/message/response/output 等字段
 * - 内容字段是否非空
 *
 * 注意：此检查必须在 CHECK 4 之后运行，依赖 __CHECK4_RESPONSE 全局变量。
 */
function checkResponseFormat(): CompatibilityCheckItem {
  const resp = (globalThis as Record<string, unknown>).__CHECK4_RESPONSE;

  if (typeof resp !== "object" || resp === null) {
    return {
      name: "响应格式",
      pass: false,
      detail: `响应不是对象类型，类型: ${typeof resp}`,
    };
  }

  const contentFields = [
    "content",
    "text",
    "message",
    "response",
    "output",
  ];
  const foundField = contentFields.find(
    (k) => resp[k] !== undefined && resp[k] !== null,
  );

  if (!foundField) {
    return {
      name: "响应格式",
      pass: false,
      detail: `缺少内容字段。可用字段: ${Object.keys(resp).join(", ")}`,
    };
  }

  const contentVal = resp[foundField];
  if (typeof contentVal === "string" && contentVal.trim().length === 0) {
    return {
      name: "响应格式",
      pass: false,
      detail: "响应内容字段为空字符串。",
    };
  }

  return {
    name: "响应格式",
    pass: true,
    detail: `字段: ${Object.keys(resp).join(", ")}。内容通过 ${foundField} 获取`,
  };
}

// ============================================================================
// 主入口：执行全部检查
// ============================================================================

/**
 * 执行 5 项 SDK 兼容性检查
 *
 * 这是模块的主入口函数。执行流程：
 * 1. 解析检查模式（normal / force / skip）
 * 2. skip 模式 → 直接退出
 * 3. normal 模式 → 检查缓存是否有效
 * 4. 缓存有效 → 仅执行本地检查（CHECK 1-3），跳过 API 检查（CHECK 4-5）
 * 5. 缓存无效或 force 模式 → 执行全部 5 项检查
 * 6. 写入缓存
 * 7. 输出结果报告
 * 8. 任何检查失败 → 以对应退出码退出
 *
 * @param forceCheck - 是否强制重新检查（忽略缓存），默认 false
 * @returns 兼容性检查结果
 */
export async function runSdkCompatibilityCheck(
  forceCheck: boolean = false,
): Promise<CompatibilityCheckResult> {
  const mode = parseCheckMode();

  // --no-check: 跳过所有检查
  if (mode === "skip") {
    console.log(
      "[SDK 兼容性检查] 已跳过 (--no-check 标志)。风险自负。",
    );
    return {
      allPassed: true,
      checks: [],
      timestamp: new Date().toISOString(),
      cacheValidUntil: new Date(0).toISOString(),
    };
  }

  const cache = mode !== "force" ? readCache() : null;
  const checks: CompatibilityCheckItem[] = [];
  let allPassed = true;

  // CHECK 1: 运行时版本（始终执行）
  const c1 = checkRuntime();
  checks.push(c1);
  logCheck(c1, checks.length, 5);
  if (!c1.pass) allPassed = false;

  // CHECK 2: SDK 包加载（始终执行）
  const c2 = await checkSdkPackage();
  checks.push(c2);
  logCheck(c2, checks.length, 5);
  if (!c2.pass) allPassed = false;

  // CHECK 3: SDK 版本（始终执行）
  const c3 = checkSdkVersion();
  checks.push(c3);
  logCheck(c3, checks.length, 5);
  if (!c3.pass) allPassed = false;

  // 如果缓存有效，跳过 CHECK 4-5
  if (cache) {
    console.log(
      `[SDK 兼容性检查] 使用缓存结果 (有效期至 ${cache.cache_valid_until})。跳过 API 检查以省 tokens。`,
    );
    return {
      allPassed,
      checks,
      timestamp: new Date().toISOString(),
      cacheValidUntil: cache.cache_valid_until,
    };
  }

  console.log("---");

  // CHECK 4: API Key 有效性
  const c4 = await checkApiKey();
  checks.push(c4);
  logCheck(c4, checks.length, 5);
  if (!c4.pass) allPassed = false;

  // CHECK 5: 响应格式（复用 CHECK 4 响应）
  const c5 = checkResponseFormat();
  checks.push(c5);
  logCheck(c5, checks.length, 5);
  if (!c5.pass) allPassed = false;

  // 写入缓存
  writeCache(checks);

  // 输出汇总
  printSummary(checks, allPassed);

  return {
    allPassed,
    checks,
    timestamp: new Date().toISOString(),
    cacheValidUntil: new Date(
      Date.now() + COMPAT_CHECK_CACHE_TTL_MS,
    ).toISOString(),
  };
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 输出单项检查结果到控制台
 */
function logCheck(
  item: CompatibilityCheckItem,
  index: number,
  total: number,
): void {
  const status = item.pass ? "通过" : "失败";
  const prefix = item.pass
    ? `[CHECK ${index}/${total} 通过]`
    : `[严重] [CHECK ${index}/${total} 失败]`;

  if (item.pass) {
    console.log(`${prefix} ${item.name}: ${item.detail}`);
  } else {
    console.error(`${prefix} ${item.name} -- ${item.detail}`);
  }
}

/**
 * 输出检查结果汇总
 */
function printSummary(
  checks: CompatibilityCheckItem[],
  allPassed: boolean,
): void {
  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.length - passed;

  console.log("");
  console.log("=== loop-cursor SDK 兼容性检查报告 ===");
  for (const c of checks) {
    const marker = c.pass ? "通过" : "失败";
    console.log(`  ${marker}  ${c.name}: ${c.detail}`);
  }
  console.log(
    `\n共 ${checks.length} 项检查，${passed} 项通过，${failed} 项未通过。`,
  );

  if (allPassed) {
    console.log("所有检查通过，正在进入 loop-cursor 主循环...");
  } else {
    console.error("存在未通过的检查项，无法继续。请修复上述问题后重试。");
  }
}

// ============================================================================
// 直接执行入口（用于 `node sdk-check.ts` 独立运行）
// ============================================================================

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("sdk-check.ts") ||
    process.argv[1].endsWith("sdk-check.js"));

if (isDirectRun) {
  const forceCheck = process.argv.includes("--force-check");
  runSdkCompatibilityCheck(forceCheck)
    .then((result) => {
      process.exit(result.allPassed ? 0 : 1);
    })
    .catch((err) => {
      console.error("兼容性检查异常崩溃:", err);
      process.exit(2);
    });
}

