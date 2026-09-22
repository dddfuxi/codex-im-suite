$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$programPath = Join-Path $root "apps\control-panel\Program.cs"
$webPath = Join-Path $root "apps\control-panel\web\src\main.tsx"
$program = Get-Content -Raw -Encoding UTF8 $programPath
$web = Get-Content -Raw -Encoding UTF8 $webPath
# Windows PowerShell 5.1 会按系统代码页解析无 BOM 的脚本源码；用码点构造
# 中文标签，避免测试自身因宿主编码而把正确的 UTF-8 页面误报为缺失。
$restartPanelLabel = [string]::Concat(@([char]0x91CD, [char]0x542F, [char]0x9762, [char]0x677F))
$checks = @(
    @{ Name = "panel.restart command"; Ok = $program -match 'case\s+"panel\.restart"' },
    @{ Name = "panel restart implementation"; Ok = $program -match 'RestartControlPanelAsync' },
    @{ Name = "panel restart authorization"; Ok = $program -match 'command\.StartsWith\("panel\."' },
    @{ Name = "topbar restart button"; Ok = $web -match "run\('panel\.restart'" },
    @{ Name = "restart button label"; Ok = $web.Contains($restartPanelLabel) }
)
$failed = $checks | Where-Object { -not $_.Ok }
if ($failed) {
    foreach ($item in $failed) { Write-Host "Missing: $($item.Name)" -ForegroundColor Red }
    exit 1
}
Write-Host "Control panel restart checks passed."
