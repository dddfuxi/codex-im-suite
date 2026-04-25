$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$suiteRoot = Split-Path -Parent $scriptDir

$extensionId = [string]$env:CTI_EXTENSION_ID
$extensionType = [string]$env:CTI_EXTENSION_TYPE
$extensionSource = [string]$env:CTI_EXTENSION_SOURCE
$displayName = if ([string]::IsNullOrWhiteSpace($env:CTI_EXTENSION_DISPLAY_NAME)) { $extensionId } else { [string]$env:CTI_EXTENSION_DISPLAY_NAME }

function Invoke-NpmInstall {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "npm install path not found: $Path"
    }
    Push-Location $Path
    try {
        npm install | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed: $Path"
        }
    }
    finally {
        Pop-Location
    }
}

switch ($extensionType) {
    'skill' {
        & (Join-Path $scriptDir 'install-suite-skills.ps1') | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "install-suite-skills.ps1 failed"
        }
        Write-Output "installed skill: $displayName"
        return
    }
    'plugin' {
        throw "插件暂未接入可自动安装流程：$displayName"
    }
    'skill.bundle' {
        & (Join-Path $scriptDir 'install-suite-skills.ps1') | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "install-suite-skills.ps1 failed"
        }
        Write-Output "installed skill: $displayName"
        return
    }
}

if ([string]::IsNullOrWhiteSpace($extensionSource)) {
    throw "missing CTI_EXTENSION_SOURCE"
}

if ($extensionSource -like 'uvx:*') {
    $packageName = $extensionSource.Substring(4)
    $uv = Get-Command uv -ErrorAction SilentlyContinue
    if (-not $uv) {
        $uv = Get-Command uvx -ErrorAction SilentlyContinue
    }
    if (-not $uv) {
        throw "uv / uvx not found. Please install uv first, then retry."
    }

    & $uv.Source tool install $packageName | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "uv tool install failed: $packageName"
    }
    Write-Output "installed mcp package: $packageName"
    return
}

if (Test-Path -LiteralPath $extensionSource) {
    if (Test-Path -LiteralPath (Join-Path $extensionSource 'package.json')) {
        Invoke-NpmInstall -Path $extensionSource
        Write-Output "installed package deps: $displayName"
        return
    }

    if ($extensionType -eq 'skill') {
        & (Join-Path $scriptDir 'install-suite-skills.ps1') | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "install-suite-skills.ps1 failed"
        }
        Write-Output "installed skill: $displayName"
        return
    }
}

throw "当前扩展未接入自动安装逻辑：$displayName ($extensionType / $extensionSource)"
