$ErrorActionPreference = 'Stop'

$suiteRoot = Split-Path -Parent $PSScriptRoot
$targetDir = Join-Path $suiteRoot 'extensions\blender'
$targetFile = Join-Path $targetDir 'addon.py'
$sourceUrl = 'https://raw.githubusercontent.com/ahujasid/blender-mcp/main/addon.py'

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
Invoke-WebRequest -Uri $sourceUrl -OutFile $targetFile -UseBasicParsing

Write-Host "Downloaded Blender MCP addon:"
Write-Host $targetFile
Write-Host ""
Write-Host "Next steps:"
Write-Host "1. Open Blender"
Write-Host "2. Edit > Preferences > Add-ons > Install..."
Write-Host "3. Select the downloaded addon.py"
Write-Host "4. Enable 'Interface: Blender MCP'"
Write-Host "5. In Blender sidebar, open the BlenderMCP tab and click Connect to Claude"
