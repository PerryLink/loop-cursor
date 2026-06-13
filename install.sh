#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# loop-cursor — Linux / macOS 安装脚本
# ============================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║       loop-cursor 安装脚本               ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

# ---- 检测 Node.js >= 22 ----
echo -e "${CYAN}[1/4]${NC} 检测 Node.js ..."
if ! command -v node &>/dev/null; then
  echo -e "${RED}错误:${NC} 未找到 Node.js，请先安装 Node.js >= 22"
  echo "  下载地址: https://nodejs.org/"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
  echo -e "${RED}错误:${NC} Node.js 版本过低 (当前: $(node -v))，需要 >= 22"
  echo "  使用 nvm: nvm install 22 && nvm use 22"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"

# ---- 检测 Git >= 2.30 ----
echo -e "${CYAN}[2/4]${NC} 检测 Git ..."
if ! command -v git &>/dev/null; then
  echo -e "${RED}错误:${NC} 未找到 Git，请先安装 Git >= 2.30"
  echo "  下载地址: https://git-scm.com/"
  exit 1
fi

GIT_VERSION=$(git --version | sed 's/git version //' | cut -d. -f1,2)
GIT_MAJOR=$(echo "$GIT_VERSION" | cut -d. -f1)
GIT_MINOR=$(echo "$GIT_VERSION" | cut -d. -f2)
if [ "$GIT_MAJOR" -lt 2 ] || { [ "$GIT_MAJOR" -eq 2 ] && [ "$GIT_MINOR" -lt 30 ]; }; then
  echo -e "${RED}错误:${NC} Git 版本过低 (当前: $(git --version))，需要 >= 2.30"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} $(git --version)"

# ---- 检测 CURSOR_API_KEY ----
echo -e "${CYAN}[3/4]${NC} 检测 CURSOR_API_KEY ..."
if [ -z "${CURSOR_API_KEY:-}" ]; then
  echo -e "  ${YELLOW}⚠${NC}  CURSOR_API_KEY 未设置"
  echo "  请在运行前设置: export CURSOR_API_KEY=\"your-key-here\""
  echo "  获取 Key: Cursor IDE -> Settings -> API Keys"
else
  echo -e "  ${GREEN}✓${NC} CURSOR_API_KEY 已设置"
fi

# ---- npm install ----
echo -e "${CYAN}[4/4]${NC} 安装依赖 ..."
npm install --loglevel=error

echo ""
echo -e "${CYAN}── 类型检查 ──${NC}"
npm run typecheck

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║       ✓ 安装完成！                       ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo "  使用方式:"
echo ""
echo "    # 安全模式 (每步确认)"
echo "    node dist/cli.js run \"你的目标\" --mode safe"
echo ""
echo "    # 自动模式 (推荐日常使用)"
echo "    node dist/cli.js run \"你的目标\" --mode auto"
echo ""
echo "    # 查看帮助"
echo "    node dist/cli.js --help"
echo ""
echo "  确保 CURSOR_API_KEY 已设置:"
echo "    export CURSOR_API_KEY=\"your-key-here\""
echo ""
