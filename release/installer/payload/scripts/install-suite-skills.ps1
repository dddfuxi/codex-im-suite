$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$suiteRoot = Split-Path -Parent $scriptDir
$manifestDir = Join-Path $suiteRoot 'config\skills.d'
$ctiHome = if ([string]::IsNullOrWhiteSpace($env:CTI_HOME)) { Join-Path $env:USERPROFILE '.claude-to-im' } else { [string]$env:CTI_HOME }
$overlayManifestDir = Join-Path $ctiHome 'extensions\manifests\skills.d'
$skillsRoot = Join-Path $suiteRoot 'extensions\skills'
$targetRoot = Join-Path $env:USERPROFILE '.codex\skills'
$excludedSkillDirectories = @('.git', 'node_modules', 'dist', 'bin', 'obj', '.state', '__pycache__')

function Resolve-ManifestValue {
    param(
        [string]$Value,
        [string]$SuiteRoot
    )

    if ([string]::IsNullOrWhiteSpace($Value)) { return $Value }
    $result = $Value.Replace('${SUITE_ROOT}', $SuiteRoot)
    $result = $result.Replace('${CTI_HOME}', $script:ctiHome)
    $result = $result.Replace('${USERPROFILE}', $env:USERPROFILE)
    return [Environment]::ExpandEnvironmentVariables($result)
}

function Invoke-SkillMirror {
    param(
        [string]$Source,
        [string]$Target,
        [string[]]$ExcludedDirectories
    )

    robocopy $Source $Target /MIR /XD $ExcludedDirectories /R:2 /W:1 | Out-Null
    return $LASTEXITCODE
}

function Test-SkillMirrorIntegrity {
    param(
        [string]$Source,
        [string]$Target,
        [string[]]$ExcludedDirectories
    )

    $sourceRoot = (Get-Item -LiteralPath $Source).FullName.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $targetRootPath = (Get-Item -LiteralPath $Target).FullName.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )

    foreach ($sourceFile in @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File)) {
        $relativePath = $sourceFile.FullName.Substring($sourceRoot.Length).TrimStart(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar
        )
        $pathSegments = $relativePath -split '[\\/]'
        if (@($pathSegments | Where-Object { $ExcludedDirectories -contains $_ }).Count -gt 0) {
            continue
        }

        $targetFile = Join-Path $targetRootPath $relativePath
        if (-not (Test-Path -LiteralPath $targetFile -PathType Leaf)) {
            return $false
        }
        if ($sourceFile.Length -ne (Get-Item -LiteralPath $targetFile).Length) {
            return $false
        }
        if ((Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash -ne
            (Get-FileHash -LiteralPath $targetFile -Algorithm SHA256).Hash) {
            return $false
        }
    }

    return $true
}

New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null

$manifestFiles = @()
foreach ($dir in @($manifestDir, $overlayManifestDir)) {
    if (Test-Path -LiteralPath $dir) {
        $manifestFiles += @(Get-ChildItem -LiteralPath $dir -Filter *.json -File | Sort-Object Name)
    }
}

$manifestsById = [ordered]@{}
foreach ($manifestFile in $manifestFiles) {
    $manifest = Get-Content -LiteralPath $manifestFile.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    $id = [string]$manifest.id
    if ([string]::IsNullOrWhiteSpace($id)) { continue }
    $manifestsById[$id] = [pscustomobject]@{
        Manifest = $manifest
        File = $manifestFile
    }
}

foreach ($entry in $manifestsById.Values) {
    $manifest = $entry.Manifest
    if ($manifest.type -ne 'skill') { continue }
    if ($manifest.enabled -eq $false) { continue }

    $source = Resolve-ManifestValue -Value ([string]$manifest.source) -SuiteRoot $suiteRoot
    $target = Join-Path $targetRoot ([string]$manifest.id)

    if (-not (Test-Path -LiteralPath $source)) {
        Write-Warning "Skill source not found: $source"
        continue
    }

    New-Item -ItemType Directory -Force -Path $target | Out-Null
    # Skill 运行态不属于可发布源码；同步定义时保留现场会话状态，并忽略解释器缓存。
    $code = Invoke-SkillMirror -Source $source -Target $target -ExcludedDirectories $excludedSkillDirectories
    if ($code -ge 8) {
        throw "robocopy failed ($code): $source -> $target"
    }

    # 退出码只能说明复制过程没有硬失败；逐文件校验避免旧内容被误报为已安装。
    $integrityVerified = Test-SkillMirrorIntegrity -Source $source -Target $target -ExcludedDirectories $excludedSkillDirectories
    if (-not $integrityVerified) {
        $code = Invoke-SkillMirror -Source $source -Target $target -ExcludedDirectories $excludedSkillDirectories
        $integrityVerified = Test-SkillMirrorIntegrity -Source $source -Target $target -ExcludedDirectories $excludedSkillDirectories
        if ($code -ge 8 -or -not $integrityVerified) {
            throw "skill integrity verification failed: $source -> $target"
        }
    }

    Write-Output "installed skill: $($manifest.id)"
}

Write-Output "suite skills synced to $targetRoot"
