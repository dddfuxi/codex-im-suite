$ErrorActionPreference = 'Stop'

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
