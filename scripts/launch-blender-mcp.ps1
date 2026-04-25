$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'

$uv = Get-Command uvx -ErrorAction SilentlyContinue
if (-not $uv) {
    throw "uvx not found. Install uv first, then retry."
}

if (-not $env:BLENDER_HOST) {
    $env:BLENDER_HOST = '127.0.0.1'
}

if (-not $env:BLENDER_PORT) {
    $env:BLENDER_PORT = '9876'
}

uvx blender-mcp
