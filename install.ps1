#Requires -Version 5.1

<#
.SYNOPSIS
    loop-cursor — Windows PowerShell 安装脚本
.DESCRIPTION
    检测 Node.js、Git、CURSOR_API_KEY，安装依赖并运行类型检查。
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host ""
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║       loop-cursor 安装脚本 (Windows)     ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ---- 检测 Node.js >= 22 ----
Write-Host "[1/4] 检测 Node.js ..." -ForegroundColor Cyan
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "错误: 未找到 Node.js，请先安装 Node.js >= 22" -ForegroundColor Red
    Write-Host "  下载地址: https://nodejs.org/"
    exit 1
}

$nodeVersion = (node --version) -replace '^v', ''
$nodeMajor = [int]($nodeVersion -split '\.')[0]
if ($nodeMajor -lt 22) {
    Write-Host "错误: Node.js 版本过低 (当前: v$nodeVersion)，需要 >= 22" -ForegroundColor Red
    Write-Host "  使用 nvm-windows: nvm install 22 && nvm use 22"
    exit 1
}
Write-Host "  ✓  Node.js v$nodeVersion" -ForegroundColor Green

# ---- 检测 Git ----
Write-Host "[2/4] 检测 Git ..." -ForegroundColor Cyan
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    Write-Host "错误: 未找到 Git，请先安装 Git" -ForegroundColor Red
    Write-Host "  下载地址: https://git-scm.com/"
    exit 1
}

$gitVersionRaw = (git --version) -replace 'git version ', ''
$gitParts = $gitVersionRaw -split '\.'
$gitMajor = [int]$gitParts[0]
$gitMinor = [int]$gitParts[1]
if ($gitMajor -lt 2 -or ($gitMajor -eq 2 -and $gitMinor -lt 30)) {
    Write-Host "错误: Git 版本过低 (当前: git version $gitVersionRaw)，需要 >= 2.30" -ForegroundColor Red
    exit 1
}
Write-Host "  ✓  git version $gitVersionRaw" -ForegroundColor Green

# ---- 检测 CURSOR_API_KEY ----
Write-Host "[3/4] 检测 CURSOR_API_KEY ..." -ForegroundColor Cyan
if ([string]::IsNullOrWhiteSpace($env:CURSOR_API_KEY)) {
    Write-Host "  ⚠  CURSOR_API_KEY 未设置" -ForegroundColor Yellow
    Write-Host "  请在运行前设置: `$env:CURSOR_API_KEY = ""your-key-here""""
    Write-Host "  获取 Key: Cursor IDE -> Settings -> API Keys"
} else {
    Write-Host "  ✓  CURSOR_API_KEY 已设置" -ForegroundColor Green
}

# ---- npm install ----
Write-Host "[4/4] 安装依赖 ..." -ForegroundColor Cyan
npm install --loglevel=error

Write-Host ""
Write-Host "── 类型检查 ──" -ForegroundColor Cyan
npm run typecheck

Write-Host ""
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║       ✓ 安装完成！                       ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  使用方式:"
Write-Host ""
Write-Host "    # 安全模式 (每步确认)"
Write-Host "    node dist/cli.js run ""你的目标"" --mode safe"
Write-Host ""
Write-Host "    # 自动模式 (推荐日常使用)"
Write-Host "    node dist/cli.js run ""你的目标"" --mode auto"
Write-Host ""
Write-Host "    # 查看帮助"
Write-Host "    node dist/cli.js --help"
Write-Host ""
Write-Host "  确保 CURSOR_API_KEY 已设置:"
Write-Host '    $env:CURSOR_API_KEY = "your-key-here"'
Write-Host ""
