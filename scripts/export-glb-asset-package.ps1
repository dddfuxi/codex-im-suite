param(
    [Parameter(Mandatory = $true)]
    [string]$SourceGlb,

    [string]$OutputRoot = '',

    [switch]$PackageZip
)

$ErrorActionPreference = "Stop"

function Resolve-BlenderExe {
    if ($env:BLENDER_EXE -and (Test-Path -LiteralPath $env:BLENDER_EXE)) {
        return (Resolve-Path -LiteralPath $env:BLENDER_EXE).Path
    }

    $cmd = Get-Command blender -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) {
        return $cmd.Source
    }

    $commonRoots = @(
        "C:\Program Files\Blender Foundation",
        "C:\Program Files",
        "C:\Program Files (x86)"
    )
    foreach ($root in $commonRoots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $hit = Get-ChildItem -LiteralPath $root -Recurse -Filter blender.exe -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }

    throw "未找到 blender.exe。请安装 Blender，或设置 BLENDER_EXE 指向 blender.exe。"
}

$sourcePath = (Resolve-Path -LiteralPath $SourceGlb).Path
$sourceExt = [IO.Path]::GetExtension($sourcePath).ToLowerInvariant()
if ($sourceExt -ne ".glb" -and $sourceExt -ne ".gltf") {
    throw "Source must be .glb or .gltf: $sourcePath"
}

$modelName = [IO.Path]::GetFileNameWithoutExtension($sourcePath) -replace "[^a-zA-Z0-9._-]+", "-"
if (-not $OutputRoot) {
    $OutputRoot = Join-Path (Split-Path -Parent $sourcePath) "$($modelName)_export"
}
$outputRootPath = $OutputRoot
if (-not [IO.Path]::IsPathRooted($outputRootPath)) {
    $outputRootPath = Join-Path (Get-Location).Path $outputRootPath
}
New-Item -ItemType Directory -Force -Path $outputRootPath | Out-Null
$outputRootPath = (Resolve-Path -LiteralPath $outputRootPath).Path

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonPath = Join-Path $scriptRoot "export-glb-asset-package.py"
if (-not (Test-Path -LiteralPath $pythonPath)) {
    throw "未找到 Blender 导出 Python 脚本: $pythonPath"
}

try {
    $blenderExe = Resolve-BlenderExe
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $blenderOutput = & $blenderExe --background --factory-startup --python $pythonPath -- $sourcePath $outputRootPath $modelName 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -ne 0) {
        $blenderOutputText = $blenderOutput -join [Environment]::NewLine
        throw "Blender 导出失败 ($exitCode): $blenderOutputText"
    }

    $manifestPath = Join-Path $outputRootPath "manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) {
        throw "导出完成但未生成 manifest: $manifestPath"
    }
    $manifest = Get-Content -Raw -Encoding UTF8 $manifestPath | ConvertFrom-Json
    $files = @()
    foreach ($rel in @($manifest.files)) {
        $full = Join-Path $outputRootPath ([string]$rel)
        if (Test-Path -LiteralPath $full) {
            $item = Get-Item -LiteralPath $full
            $files += [PSCustomObject]@{
                path = $item.FullName
                relativePath = [string]$rel
                length = $item.Length
            }
        }
    }

    $zipPath = $null
    if ($PackageZip) {
        $zipPath = "$outputRootPath.zip"
        if (Test-Path -LiteralPath $zipPath) {
            Remove-Item -LiteralPath $zipPath -Force
        }
        Compress-Archive -LiteralPath (Join-Path $outputRootPath "*") -DestinationPath $zipPath -CompressionLevel Optimal
    }

    [PSCustomObject]@{
        ok = $true
        sourceFile = $sourcePath
        outputRoot = $outputRootPath
        manifestPath = $manifestPath
        fbxPath = (Join-Path $outputRootPath ([string]$manifest.unityModelPath))
        textureCount = [int]$manifest.textureCount
        objectCount = [int]$manifest.objectCount
        materialCount = [int]$manifest.materialCount
        files = $files
        zipPath = $zipPath
    } | ConvertTo-Json -Depth 8
} finally {
}


