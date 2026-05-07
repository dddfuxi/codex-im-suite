$ErrorActionPreference = 'Stop'

function Get-SuiteRoot {
    return Split-Path -Parent $PSScriptRoot
}

function Get-SuiteManifest {
    param([string]$SuiteRoot)
    $manifestPath = Join-Path $SuiteRoot 'suite.manifest.json'
    return Get-Content -LiteralPath $manifestPath -Encoding UTF8 -Raw | ConvertFrom-Json
}

function Get-CtiConfig {
    $path = Join-Path $env:USERPROFILE '.claude-to-im\config.env'
    $values = @{}
    if (-not (Test-Path -LiteralPath $path)) { return $values }
    foreach ($line in Get-Content -LiteralPath $path -Encoding UTF8) {
        if (-not $line -or $line.TrimStart().StartsWith('#')) { continue }
        $index = $line.IndexOf('=')
        if ($index -le 0) { continue }
        $values[$line.Substring(0, $index).Trim()] = $line.Substring($index + 1).Trim()
    }
    return $values
}

function Expand-SuiteValue {
    param(
        [string]$Value,
        [string]$SuiteRoot,
        [hashtable]$Config
    )
    if ($null -eq $Value) { return $null }
    $result = $Value
    $result = $result.Replace('${SUITE_ROOT}', $SuiteRoot)
    $result = $result.Replace('${CTI_HOME}', (Join-Path $env:USERPROFILE '.claude-to-im'))
    $result = $result.Replace('${USERPROFILE}', $env:USERPROFILE)
    foreach ($key in $Config.Keys) {
        $result = $result.Replace(('${' + $key + '}'), [string]$Config[$key])
    }
    return [Environment]::ExpandEnvironmentVariables($result)
}

function Get-GitText {
    param(
        [string]$SuiteRoot,
        [string[]]$GitArgs
    )

    Push-Location $SuiteRoot
    try {
        return (& git @GitArgs 2>$null) -join [Environment]::NewLine
    }
    finally {
        Pop-Location
    }
}

function Get-ReleaseFileHash {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return '<missing>'
    }

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.Substring(0, 12)
}

function Get-ReleaseContentHash {
    param(
        [string[]]$Paths,
        [string[]]$ExcludeDirectories = @('node_modules', 'bin', 'obj', '.git', 'coverage', '.turbo', '.next', 'CodexImSuiteControlPanel.exe.WebView2')
    )

    $entries = New-Object System.Collections.Generic.List[string]
    foreach ($path in $Paths) {
        if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path)) {
            $entries.Add("$path`n<missing>") | Out-Null
            continue
        }

        $item = Get-Item -LiteralPath $path
        if (-not $item.PSIsContainer) {
            $entries.Add("$($item.Name)`n$(Get-ReleaseFileHash -Path $item.FullName)") | Out-Null
            continue
        }

        $root = $item.FullName.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
        Get-ChildItem -LiteralPath $root -Recurse -File -Force |
            Where-Object {
                $parts = $_.FullName.Substring($root.Length).TrimStart('\', '/') -split '[\\/]'
                foreach ($exclude in $ExcludeDirectories) {
                    if ($parts -contains $exclude) { return $false }
                }
                return $true
            } |
            Sort-Object FullName |
            ForEach-Object {
                $relative = $_.FullName.Substring($root.Length).TrimStart('\', '/').Replace('\', '/')
                $entries.Add("$relative`n$(Get-ReleaseFileHash -Path $_.FullName)") | Out-Null
            }
    }

    if ($entries.Count -eq 0) {
        return '<empty>'
    }

    $text = (@($entries) | Sort-Object) -join "`n"
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '')).Substring(0, 12)
    }
    finally {
        $sha.Dispose()
    }
}

function Get-ReleaseManifestSummary {
    param([string]$Root)

    $configRoot = Join-Path $Root 'config'
    $manifestFiles = @()
    foreach ($name in @('mcp.d', 'skills.d', 'plugins.d')) {
        $dir = Join-Path $configRoot $name
        if (Test-Path -LiteralPath $dir) {
            $manifestFiles += @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -File)
        }
    }

    return [pscustomobject]@{
        Count = $manifestFiles.Count
        Hash = Get-ReleaseContentHash -Paths @($configRoot)
    }
}

function Get-ReleasePanelSummary {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject]@{
            Path = $Path
            Exists = $false
            Hash = '<missing>'
            Length = 0
            Modified = ''
        }
    }

    $item = Get-Item -LiteralPath $Path
    return [pscustomobject]@{
        Path = $item.FullName
        Exists = $true
        Hash = Get-ReleaseFileHash -Path $item.FullName
        Length = $item.Length
        Modified = $item.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
    }
}

function New-SuiteReleaseFingerprint {
    param(
        [string]$SuiteRoot,
        [string]$TargetName,
        [string]$TargetRole,
        [string]$ReleaseRunId,
        [object]$Content,
        [object]$ManifestSummary,
        [object]$PanelSummary
    )

    $manifest = Get-SuiteManifest -SuiteRoot $SuiteRoot
    $branch = (Get-GitText -SuiteRoot $SuiteRoot -GitArgs @('branch', '--show-current')).Trim()
    $commit = (Get-GitText -SuiteRoot $SuiteRoot -GitArgs @('rev-parse', '--short', 'HEAD')).Trim()
    $dirty = @((Get-GitText -SuiteRoot $SuiteRoot -GitArgs @('status', '--short')) -split "\r?\n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })

    if ([string]::IsNullOrWhiteSpace($ReleaseRunId)) {
        $ReleaseRunId = if ($env:CTI_RELEASE_RUN_ID) { $env:CTI_RELEASE_RUN_ID } else { [guid]::NewGuid().ToString('N') }
    }

    return [pscustomobject]@{
        schema = 'codex-im-suite/release-fingerprint/v1'
        generatedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        releaseRunId = $ReleaseRunId
        targetName = $TargetName
        targetRole = $TargetRole
        suite = [pscustomobject]@{
            name = [string]$manifest.name
            version = [string]$manifest.version
            extensionProtocol = [string]$manifest.extensionProtocol.id
            branch = $branch
            commit = $commit
            dirty = ($dirty.Count -gt 0)
        }
        manifest = $ManifestSummary
        panel = $PanelSummary
        content = [pscustomobject]$Content
    }
}

function Write-SuiteReleaseFingerprint {
    param(
        [string]$TargetRoot,
        [object]$Fingerprint
    )

    if (-not (Test-Path -LiteralPath $TargetRoot)) {
        New-Item -ItemType Directory -Force -Path $TargetRoot | Out-Null
    }

    $path = Join-Path $TargetRoot '.suite-release.json'
    $Fingerprint | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $path -Encoding UTF8
    return $path
}

function Get-SuiteReleaseExpectedContentMap {
    param(
        [string]$SuiteRoot,
        [ValidateSet('LiveRuntime', 'LiveCore', 'Portable', 'InstallerPayload')]
        [string]$Layout
    )

    $runtimeRoot = Join-Path $SuiteRoot 'packages\bridge-runtime'
    $coreRoot = Join-Path $SuiteRoot 'packages\bridge-core'
    $panelRoot = if ($env:CTI_RELEASE_CONTROL_PANEL_DIR) {
        $env:CTI_RELEASE_CONTROL_PANEL_DIR
    } else {
        Join-Path $SuiteRoot 'release\artifacts\control-panel'
    }
    $runtimeDistExclude = @('node_modules', 'bin', 'obj', '.git', 'coverage', '.turbo', '.next', 'control-panel', 'release', 'CodexImSuiteControlPanel.exe.WebView2')

    $map = [ordered]@{}
    if ($Layout -in @('LiveRuntime', 'Portable', 'InstallerPayload')) {
        $map['runtime.package'] = Get-ReleaseFileHash -Path (Join-Path $runtimeRoot 'package.json')
        $map['runtime.dist'] = Get-ReleaseContentHash -Paths @((Join-Path $runtimeRoot 'dist')) -ExcludeDirectories $runtimeDistExclude
        $runtimeScriptPaths = @((Join-Path $runtimeRoot 'scripts'))
        if ($Layout -eq 'LiveRuntime') {
            $runtimeScriptPaths += (Join-Path $SuiteRoot 'scripts\export-glb-asset-package.ps1')
            $runtimeScriptPaths += (Join-Path $SuiteRoot 'scripts\export-glb-asset-package.py')
        }
        $map['runtime.scripts'] = Get-ReleaseContentHash -Paths $runtimeScriptPaths
        $map['runtime.configExample'] = Get-ReleaseFileHash -Path (Join-Path $runtimeRoot 'config.env.example')
        $map['runtime.skill'] = Get-ReleaseFileHash -Path (Join-Path $runtimeRoot 'SKILL.md')
        $map['panel.exe'] = Get-ReleaseFileHash -Path (Join-Path $panelRoot 'CodexImSuiteControlPanel.exe')
        $map['panel.wwwroot'] = Get-ReleaseContentHash -Paths @((Join-Path $panelRoot 'wwwroot'))
    }

    if ($Layout -in @('LiveCore', 'Portable', 'InstallerPayload')) {
        $map['core.package'] = Get-ReleaseFileHash -Path (Join-Path $coreRoot 'package.json')
        $map['core.dist'] = Get-ReleaseContentHash -Paths @((Join-Path $coreRoot 'dist'))
    }

    if ($Layout -in @('Portable', 'InstallerPayload')) {
        $map['suite.manifest'] = Get-ReleaseFileHash -Path (Join-Path $SuiteRoot 'suite.manifest.json')
        $map['config.manifests'] = Get-ReleaseContentHash -Paths @((Join-Path $SuiteRoot 'config'))
        $map['extensions.skills'] = Get-ReleaseContentHash -Paths @((Join-Path $SuiteRoot 'extensions\skills'))
        $map['release.scripts'] = Get-ReleaseContentHash -Paths @((Join-Path $SuiteRoot 'scripts'))
        $map['docs'] = Get-ReleaseContentHash -Paths @((Join-Path $SuiteRoot 'docs'))
    }

    return $map
}

function Get-SuiteReleaseActualContentMap {
    param(
        [string]$SuiteRoot,
        [string]$TargetRoot,
        [ValidateSet('LiveRuntime', 'LiveCore', 'Portable', 'InstallerPayload')]
        [string]$Layout
    )

    $runtimeDistExclude = @('node_modules', 'bin', 'obj', '.git', 'coverage', '.turbo', '.next', 'control-panel', 'release', 'CodexImSuiteControlPanel.exe.WebView2')
    $map = [ordered]@{}

    if ($Layout -eq 'LiveRuntime') {
        $map['runtime.package'] = Get-ReleaseFileHash -Path (Join-Path $TargetRoot 'package.json')
        $map['runtime.dist'] = Get-ReleaseContentHash -Paths @((Join-Path $TargetRoot 'dist')) -ExcludeDirectories $runtimeDistExclude
        $map['runtime.scripts'] = Get-ReleaseContentHash -Paths @((Join-Path $TargetRoot 'scripts'))
        $map['runtime.configExample'] = Get-ReleaseFileHash -Path (Join-Path $TargetRoot 'config.env.example')
        $map['runtime.skill'] = Get-ReleaseFileHash -Path (Join-Path $TargetRoot 'SKILL.md')
        $map['panel.exe'] = Get-ReleaseFileHash -Path (Join-Path $TargetRoot 'dist\control-panel\CodexImSuiteControlPanel.exe')
        $map['panel.wwwroot'] = Get-ReleaseContentHash -Paths @((Join-Path $TargetRoot 'dist\control-panel\wwwroot'))
        return $map
    }

    if ($Layout -eq 'LiveCore') {
        $map['core.package'] = Get-ReleaseFileHash -Path (Join-Path $TargetRoot 'package.json')
        $map['core.dist'] = Get-ReleaseContentHash -Paths @((Join-Path $TargetRoot 'dist'))
        return $map
    }

    $runtimeRoot = Join-Path $TargetRoot 'packages\bridge-runtime'
    $coreRoot = Join-Path $TargetRoot 'packages\bridge-core'
    $map['runtime.package'] = Get-ReleaseFileHash -Path (Join-Path $runtimeRoot 'package.json')
    $map['runtime.dist'] = Get-ReleaseContentHash -Paths @((Join-Path $runtimeRoot 'dist')) -ExcludeDirectories $runtimeDistExclude
    $map['runtime.scripts'] = Get-ReleaseContentHash -Paths @((Join-Path $runtimeRoot 'scripts'))
    $map['runtime.configExample'] = Get-ReleaseFileHash -Path (Join-Path $runtimeRoot 'config.env.example')
    $map['runtime.skill'] = Get-ReleaseFileHash -Path (Join-Path $runtimeRoot 'SKILL.md')
    $map['core.package'] = Get-ReleaseFileHash -Path (Join-Path $coreRoot 'package.json')
    $map['core.dist'] = Get-ReleaseContentHash -Paths @((Join-Path $coreRoot 'dist'))
    $map['suite.manifest'] = Get-ReleaseFileHash -Path (Join-Path $TargetRoot 'suite.manifest.json')
    $map['config.manifests'] = Get-ReleaseContentHash -Paths @((Join-Path $TargetRoot 'config'))
    $map['extensions.skills'] = Get-ReleaseContentHash -Paths @((Join-Path $TargetRoot 'extensions\skills'))
    $map['release.scripts'] = Get-ReleaseContentHash -Paths @((Join-Path $TargetRoot 'scripts'))
    $map['docs'] = Get-ReleaseContentHash -Paths @((Join-Path $TargetRoot 'docs'))
    $map['panel.exe'] = Get-ReleaseFileHash -Path (Join-Path $TargetRoot 'CodexImSuiteControlPanel.exe')
    $map['panel.wwwroot'] = Get-ReleaseContentHash -Paths @((Join-Path $TargetRoot 'wwwroot'))
    return $map
}

function Read-SuiteReleaseFingerprint {
    param([string]$TargetRoot)

    $path = Join-Path $TargetRoot '.suite-release.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return $null
    }

    return Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Find-RunningProcessInPath {
    param([string[]]$Roots)

    $normalizedRoots = @($Roots |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { [System.IO.Path]::GetFullPath($_).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar })

    if ($normalizedRoots.Count -eq 0) {
        return @()
    }

    $matches = New-Object System.Collections.Generic.List[object]
    foreach ($process in Get-Process) {
        $path = $null
        try {
            $path = $process.Path
        }
        catch {
            $path = $null
        }
        if ([string]::IsNullOrWhiteSpace($path)) { continue }

        $fullPath = [System.IO.Path]::GetFullPath($path)
        foreach ($root in $normalizedRoots) {
            if ($fullPath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
                $matches.Add([pscustomobject]@{
                    Id = $process.Id
                    ProcessName = $process.ProcessName
                    Path = $fullPath
                    Root = $root.TrimEnd('\', '/')
                }) | Out-Null
            }
        }
    }

    return $matches.ToArray()
}

function Assert-NoRunningProcessInPath {
    param(
        [string[]]$Roots,
        [string]$Purpose = 'release operation'
    )

    $matches = @(Find-RunningProcessInPath -Roots $Roots)
    if ($matches.Count -eq 0) {
        return
    }

    Write-Host "Release process lock check failed: $Purpose"
    foreach ($match in $matches) {
        Write-Host ("  PID {0} | {1} | {2}" -f $match.Id, $match.ProcessName, $match.Path)
    }
    throw "Running release/runtime copy process found. Close the listed process and retry; this script will not kill it automatically."
}
