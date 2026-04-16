$ErrorActionPreference = 'Stop'

param(
    [Parameter(Mandatory = $true)]
    [string]$PackageRoot,

    [Parameter(Mandatory = $true)]
    [string]$UnityProjectPath,

    [string]$TargetAssetsRoot = 'Assets\\External\\AI_Generated'
)

function Ensure-Directory {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

$resolvedPackageRoot = (Resolve-Path -LiteralPath $PackageRoot).Path
$resolvedUnityProjectPath = (Resolve-Path -LiteralPath $UnityProjectPath).Path

if (-not (Test-Path -LiteralPath (Join-Path $resolvedUnityProjectPath 'Assets'))) {
    throw "UnityProjectPath does not look like a Unity project: $resolvedUnityProjectPath"
}

$packageName = Split-Path -Path $resolvedPackageRoot -Leaf
$glbDir = Join-Path $resolvedPackageRoot 'glb'
$unityDir = Join-Path $resolvedPackageRoot 'unity'
$manifestPath = Join-Path $resolvedPackageRoot 'manifest.json'

if (-not (Test-Path -LiteralPath $unityDir)) {
    throw "Missing unity export folder: $unityDir"
}

$destRoot = Join-Path $resolvedUnityProjectPath $TargetAssetsRoot
$destPackageRoot = Join-Path $destRoot $packageName
$destSourceGlb = Join-Path $destPackageRoot 'SourceGLB'
$destModel = Join-Path $destPackageRoot 'Model'
$destTextures = Join-Path $destPackageRoot 'Textures'
$destMaterials = Join-Path $destPackageRoot 'Materials'

Ensure-Directory -Path $destRoot
Ensure-Directory -Path $destPackageRoot
Ensure-Directory -Path $destSourceGlb
Ensure-Directory -Path $destModel
Ensure-Directory -Path $destTextures
Ensure-Directory -Path $destMaterials

if (Test-Path -LiteralPath $glbDir) {
    Copy-Item -LiteralPath (Join-Path $glbDir '*') -Destination $destSourceGlb -Recurse -Force
}

$unityModelDir = Join-Path $unityDir 'Model'
$unityTexturesDir = Join-Path $unityDir 'Textures'
$unityMaterialsDir = Join-Path $unityDir 'Materials'

if (Test-Path -LiteralPath $unityModelDir) {
    Copy-Item -LiteralPath (Join-Path $unityModelDir '*') -Destination $destModel -Recurse -Force
}

if (Test-Path -LiteralPath $unityTexturesDir) {
    Copy-Item -LiteralPath (Join-Path $unityTexturesDir '*') -Destination $destTextures -Recurse -Force
}

if (Test-Path -LiteralPath $unityMaterialsDir) {
    Copy-Item -LiteralPath (Join-Path $unityMaterialsDir '*') -Destination $destMaterials -Recurse -Force
}

if (Test-Path -LiteralPath $manifestPath) {
    Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $destPackageRoot 'manifest.json') -Force
}

Write-Output $destPackageRoot
