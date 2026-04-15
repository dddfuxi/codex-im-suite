$ErrorActionPreference = 'Stop'

$SkillDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ProjectDir = Join-Path $SkillDir 'tools\ControlPanel'
$PublishDir = Join-Path $SkillDir 'dist\control-panel'

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
