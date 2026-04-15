$ErrorActionPreference = 'Stop'

$SkillDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$DistDir = Join-Path $SkillDir 'dist'
$ControlPanelDir = Join-Path $DistDir 'control-panel'
$ReleaseDir = Join-Path $DistDir 'release'
$PortableDir = Join-Path $ReleaseDir 'ClaudeToImPortable'
$InstallerBundleDir = Join-Path $ReleaseDir 'installer-bundle'
$InstallerPayloadDir = Join-Path $InstallerBundleDir 'payload'
$InstallerProject = Join-Path $SkillDir 'tools\Installer\ClaudeToIm.Installer.csproj'
$InstallerPublishDir = Join-Path $ReleaseDir 'installer-build'

& (Join-Path $SkillDir 'scripts\build-control-panel.ps1')
if ($LASTEXITCODE -ne 0) {
  throw "build-control-panel.ps1 failed with exit code $LASTEXITCODE"
}

Remove-Item -LiteralPath $ReleaseDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $PortableDir | Out-Null

Copy-Item -LiteralPath (Join-Path $ControlPanelDir 'ClaudeToImControlPanel.exe') -Destination $PortableDir -Force
Copy-Item -LiteralPath (Join-Path $SkillDir 'scripts') -Destination (Join-Path $PortableDir 'scripts') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $SkillDir 'mcp.d') -Destination (Join-Path $PortableDir 'mcp.d') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $SkillDir 'config.env.example') -Destination $PortableDir -Force
Copy-Item -LiteralPath (Join-Path $SkillDir 'README_CN.md') -Destination (Join-Path $PortableDir 'README_CN.md') -Force

@(
  '# Claude-to-IM Portable',
  '',
  'Run ClaudeToImControlPanel.exe to open the Feishu / Codex / MCP control panel.',
  '',
  '## Layout',
  '- `scripts/`: bridge and MCP launcher scripts',
  '- `mcp.d/`: MCP manifests. Add one JSON file to add a new MCP.',
  '- `config.env.example`: config template',
  '',
  'The default config file is `%USERPROFILE%\.claude-to-im\config.env`.'
) | Set-Content -LiteralPath (Join-Path $PortableDir 'PORTABLE_README.md') -Encoding UTF8

$zipPath = Join-Path $ReleaseDir 'ClaudeToImPortable.zip'
Compress-Archive -Path (Join-Path $PortableDir '*') -DestinationPath $zipPath -Force

New-Item -ItemType Directory -Force -Path $InstallerPayloadDir | Out-Null
Copy-Item -Path (Join-Path $PortableDir '*') -Destination $InstallerPayloadDir -Recurse -Force

dotnet publish $InstallerProject `
  -c Release `
  -r win-x64 `
  --self-contained false `
  -p:PublishSingleFile=false `
  -o $InstallerBundleDir
if ($LASTEXITCODE -ne 0) {
  throw "installer publish failed with exit code $LASTEXITCODE"
}

$installerExe = Join-Path $InstallerBundleDir 'ClaudeToImInstaller.exe'
if (-not (Test-Path -LiteralPath $installerExe)) {
  throw "Installer exe was not produced: $installerExe"
}

Write-Host "Portable zip: $zipPath"
Write-Host "Installer bundle: $InstallerBundleDir"
