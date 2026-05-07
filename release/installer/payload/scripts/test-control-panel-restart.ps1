$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$programPath = Join-Path $root "apps\control-panel\Program.cs"
$webPath = Join-Path $root "apps\control-panel\web\src\main.tsx"
$program = Get-Content -Raw -Encoding UTF8 $programPath
$web = Get-Content -Raw -Encoding UTF8 $webPath
$checks = @(
    @{ Name = "panel.restart command"; Ok = $program -match 'case\s+"panel\.restart"' },
    @{ Name = "panel restart implementation"; Ok = $program -match 'RestartControlPanelAsync' },
    @{ Name = "panel restart authorization"; Ok = $program -match 'command\.StartsWith\("panel\."' },
    @{ Name = "topbar restart button"; Ok = $web -match "run\('panel\.restart'" },
    @{ Name = "restart button label"; Ok = $web -match '重启面板' }
)
$failed = $checks | Where-Object { -not $_.Ok }
if ($failed) {
    foreach ($item in $failed) { Write-Host "Missing: $($item.Name)" -ForegroundColor Red }
    exit 1
}
Write-Host "Control panel restart checks passed."
