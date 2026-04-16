$ErrorActionPreference = 'Stop'

$SkillDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$SuiteRoot = Join-Path (Join-Path $env:USERPROFILE 'Documents\New project') 'codex-im-suite'
$ProjectDir = Join-Path $SkillDir 'tools\ControlPanel'
$PublishDir = Join-Path $SkillDir 'dist\control-panel'

$SuiteProgram = Join-Path $SuiteRoot 'apps\control-panel\Program.cs'
$LiveProgram = Join-Path $ProjectDir 'Program.cs'
if (Test-Path -LiteralPath $SuiteProgram) {
  Copy-Item -LiteralPath $SuiteProgram -Destination $LiveProgram -Force
}

dotnet publish $ProjectDir `
  -c Release `
  -r win-x64 `
  --self-contained false `
  -p:PublishSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -o $PublishDir

if ($LASTEXITCODE -ne 0) {
  throw "dotnet publish failed with exit code $LASTEXITCODE"
}

$Exe = Join-Path $PublishDir 'ClaudeToImControlPanel.exe'
if (-not (Test-Path -LiteralPath $Exe)) {
  throw "Control panel exe was not produced: $Exe"
}

Write-Host "Control panel built: $Exe"
