/**
 * loop-cursor CLI M3 — 完整闭环引擎
 * 解析参数、验证环境、初始化目录、写state、spawn引擎子进程。
 * @module cli @version 0.3.0
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import type { RunMode } from "@loop-cursor/core";
import {
  RunModeEnum, DEFAULT_MODEL, DEFAULT_MAX_CYCLES,
  EXPECTED_SDK_VERSION, buildInitialState,
} from "@loop-cursor/core";

interface CliArgs {
  mode: RunMode; userRequest: string; skipCompatCheck: boolean;
  modelOverride: string; showHelp: boolean;
}

/** 解析 CLI 参数 */
function parseArgs(): CliArgs {
  const a = process.argv.slice(2);
  const r: CliArgs = {
    mode: RunModeEnum.AUTO, userRequest: "", skipCompatCheck: false,
    modelOverride: "", showHelp: false,
  };
  for (let i=0;i<a.length;i++) {
    switch (a[i]) {
      case "--safe": r.mode = RunModeEnum.SAFE; break;
      case "--unsafe": r.mode = RunModeEnum.UNSAFE; break;
      case "--interactive": r.mode = RunModeEnum.INTERACTIVE; break;
      case "--no-check": r.skipCompatCheck = true; break;
      case "--model": if (i+1<a.length) r.modelOverride = a[++i]; break;
      case "--help": r.showHelp = true; break;
      default:
        if (a[i] && !a[i].startsWith("--"))
          r.userRequest += (r.userRequest ? " " : "") + a[i];
    }
  }
  return r;
}

/** 输出帮助信息 */
function printHelp(): void {
  console.log(`loop-cursor — Cursor 自动设计->实施->测试->验证全闭环

用法: loop-cursor [选项] "<目标>"

选项:
  --safe          安全模式(L1): 闸门全开，关键步骤等待确认
  --unsafe        无限制模式(L3): 仅拦截灾难性操作
  --interactive   协作模式: 决策点暂停等回复
  --model <id>    指定模型
  --no-check      跳过兼容性检查
  --help          帮助

环境变量: CURSOR_API_KEY(必需) https://cursor.com/settings/api
版本: 0.3.0 (M3)`);
}

/** CLI 主入口 */
async function main(): Promise<void> {
  const a = parseArgs();
  if (a.showHelp) { printHelp(); process.exit(0); }
  if (!a.userRequest) {
    console.error('错误: 未指定目标。loop-cursor "<目标>"\n--help 查看帮助');
    process.exit(1);
  }
  // Node.js >=22
  if (parseInt(process.versions.node,10) < 22) {
    console.error(`需要 Node.js>=22 当前:${process.versions.node}`);
    process.exit(1);
  }
  console.log(`[CLI] Node ${process.versions.node}`);
  // CURSOR_API_KEY
  const k = process.env.CURSOR_API_KEY;
  if (!k) {
    console.error('严重: CURSOR_API_KEY 未设\nexport CURSOR_API_KEY=cur-...');
    process.exit(1);
  }
  if (!k.startsWith("cur-")) console.warn('key 不以 cur- 开头');
  // 目录 + state.json
  const sd = resolve(".cursor", "loop-cursor");
  const ad = resolve(sd, "artifacts");
  mkdirSync(ad, { recursive: true });
  const m = a.modelOverride || DEFAULT_MODEL;
  writeFileSync(resolve(sd,"state.json"),
    JSON.stringify(buildInitialState(a.userRequest,a.mode,m),null,2),"utf-8");
  // 摘要
  console.log(`\n=== loop-cursor M3 ===\n  目标: ${a.userRequest}\n  模式: ${a.mode}\n  模型: ${m}\n  版本: ${EXPECTED_SDK_VERSION}`);
  // Spawn 引擎
  const ec = `import('@loop-cursor/core').then(m=>m.engineLoop())`;
  const ce = {
    ...process.env,CURSOR_API_KEY:k,
    LOOP_CURSOR_STATE_DIR:sd,LOOP_CURSOR_ARTIFACTS_DIR:ad,
    LOOP_CURSOR_MODE:a.mode,LOOP_CURSOR_MODEL:m,
  };
  const c = spawn("node", ["-e", ec], { stdio: "inherit", env: ce, shell: false });
  // 转发信号
  process.on("SIGINT", () => { if (!c.killed) c.kill("SIGINT"); process.exit(0); });
  process.on("SIGTERM", () => { if (!c.killed) c.kill("SIGTERM"); });
  c.on("exit", (cd, sg) => {
    console.log(`\n[CLI] 引擎退出 (${sg || cd || 0})`);
    process.exit(cd ?? 0);
  });
}
main();
