param(
    [string]$ManifestRoot,
    [switch]$Strict
)

$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'shared.ps1')

$suiteRoot = Get-SuiteRoot
if (-not $ManifestRoot) {
    $ManifestRoot = Join-Path $suiteRoot 'config'
}

$suiteManifest = Get-SuiteManifest -SuiteRoot $suiteRoot
$protocolId = if ($suiteManifest.extensionProtocol.id) { [string]$suiteManifest.extensionProtocol.id } else { 'extension-manifest/v1' }
$suiteVersion = [string]$suiteManifest.version
$requiredFields = @($suiteManifest.extensionProtocol.requiredFields | ForEach-Object { [string]$_ })
if ($requiredFields.Count -eq 0) {
    $requiredFields = @('id', 'displayName', 'type', 'version', 'compatibility', 'category', 'optional', 'installState', 'source', 'enabled', 'description')
}

$knownDirs = @(
    @{ Path = Join-Path $ManifestRoot 'mcp.d'; Types = @('http', 'stdio'); Label = 'mcp' },
    @{ Path = Join-Path $ManifestRoot 'skills.d'; Types = @('skill'); Label = 'skill' },
    @{ Path = Join-Path $ManifestRoot 'plugins.d'; Types = @('plugin'); Label = 'plugin' }
)

$errors = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]
$seenIds = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$checked = 0
$enabled = 0
$disabled = 0

function Has-Property {
    param($Object, [string]$Name)
    return $null -ne $Object -and ($Object.PSObject.Properties.Name -contains $Name)
}

function Add-Error {
    param([string]$Message)
    $script:errors.Add($Message) | Out-Null
}

function Add-Warning {
    param([string]$Message)
    $script:warnings.Add($Message) | Out-Null
}

function Expand-ManifestSource {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    return Expand-SuiteValue -Value $Value -SuiteRoot $suiteRoot -Config (Get-CtiConfig)
}

function Is-ExternalSource {
    param([string]$Value)
    return $Value -match '^(external|uvx|codex-plugin|npm|git|https?)[:/]'
}

function Test-ManifestFile {
    param(
        [System.IO.FileInfo]$File,
        [string[]]$AllowedTypes,
        [string]$DirectoryLabel
    )

    $script:checked++
    $raw = Get-Content -LiteralPath $File.FullName -Raw -Encoding UTF8
    try {
        $manifest = $raw | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        Add-Error "$($File.FullName): JSON 解析失败：$($_.Exception.Message)"
        return
    }

    foreach ($field in $requiredFields) {
        if (-not (Has-Property $manifest $field)) {
            Add-Error "$($File.FullName): 缺少扩展协议字段 '$field'"
        }
    }

    $id = if (Has-Property $manifest 'id') { [string]$manifest.id } else { '' }
    if ([string]::IsNullOrWhiteSpace($id)) {
        Add-Error "$($File.FullName): id 不能为空"
    }
    elseif ($id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
        Add-Error "$($File.FullName): id '$id' 只能包含字母、数字、点、下划线和短横线，并且必须以字母或数字开头"
    }
    elseif (-not $seenIds.Add($id)) {
        Add-Error "$($File.FullName): id '$id' 与其他扩展重复"
    }

    $type = if (Has-Property $manifest 'type') { [string]$manifest.type } else { '' }
    if ($AllowedTypes -notcontains $type) {
        Add-Error "$($File.FullName): type '$type' 不符合 $DirectoryLabel manifest 目录要求，允许值：$($AllowedTypes -join ', ')"
    }

    if ((Has-Property $manifest 'enabled') -and ($manifest.enabled -is [bool]) -and $manifest.enabled -eq $false) {
        $script:disabled++
        Add-Warning "$($File.Name): 扩展已禁用，运行时会跳过启用流程"
        return
    }
    $script:enabled++

    if (-not (Has-Property $manifest 'optional') -or -not ($manifest.optional -is [bool])) {
        Add-Error "$($File.FullName): optional 必须是 boolean"
    }

    $compatProtocol = if ($manifest.compatibility -and (Has-Property $manifest.compatibility 'protocol')) { [string]$manifest.compatibility.protocol } else { '' }
    if ($compatProtocol -ne $protocolId) {
        Add-Error "$($File.FullName): compatibility.protocol '$compatProtocol' 不匹配 suite 协议 '$protocolId'"
    }

    if (-not $manifest.compatibility -or -not (Has-Property $manifest.compatibility 'suite') -or [string]::IsNullOrWhiteSpace([string]$manifest.compatibility.suite)) {
        Add-Error "$($File.FullName): compatibility.suite 不能为空"
    }

    foreach ($textField in @('displayName', 'version', 'category', 'installState', 'source', 'description')) {
        if (-not (Has-Property $manifest $textField) -or [string]::IsNullOrWhiteSpace([string]$manifest.$textField)) {
            Add-Error "$($File.FullName): $textField 不能为空"
        }
    }

    $installState = if (Has-Property $manifest 'installState') { [string]$manifest.installState } else { '' }
    if (@('bundled', 'external', 'configured', 'missing') -notcontains $installState) {
        Add-Error "$($File.FullName): installState '$installState' 不受支持，允许值：bundled, external, configured, missing"
    }

    $source = if (Has-Property $manifest 'source') { [string]$manifest.source } else { '' }
    if (-not [string]::IsNullOrWhiteSpace($source) -and -not (Is-ExternalSource $source)) {
        $expandedSource = Expand-ManifestSource $source
        if ($installState -eq 'bundled' -and -not (Test-Path -LiteralPath $expandedSource)) {
            Add-Error "$($File.FullName): bundled source 不存在：$expandedSource"
        }
        elseif (-not (Test-Path -LiteralPath $expandedSource)) {
            Add-Warning "$($File.Name): source 当前不可访问：$expandedSource"
        }
    }

    if ($type -in @('http', 'stdio')) {
        if (-not (Has-Property $manifest 'launcher') -or [string]::IsNullOrWhiteSpace([string]$manifest.launcher)) {
            Add-Error "$($File.FullName): MCP manifest 必须声明 launcher"
        }
        else {
            $launcher = Expand-ManifestSource ([string]$manifest.launcher)
            if ($launcher -notmatch '\$\{.+\}' -and -not (Test-Path -LiteralPath $launcher)) {
                Add-Warning "$($File.Name): launcher 当前不可访问：$launcher"
            }
        }
        if ($type -eq 'http' -and (-not $manifest.healthCheck -or [string]::IsNullOrWhiteSpace([string]$manifest.healthCheck.url))) {
            Add-Error "$($File.FullName): HTTP MCP manifest 必须声明 healthCheck.url"
        }
    }

    if ($type -eq 'skill') {
        $expandedSkillSource = Expand-ManifestSource ([string]$manifest.source)
        if (-not (Test-Path -LiteralPath (Join-Path $expandedSkillSource 'SKILL.md'))) {
            Add-Error "$($File.FullName): skill source 缺少 SKILL.md：$expandedSkillSource"
        }
    }
}

foreach ($dir in $knownDirs) {
    if (-not (Test-Path -LiteralPath $dir.Path)) {
        Add-Error "manifest 目录不存在：$($dir.Path)"
        continue
    }
    Get-ChildItem -LiteralPath $dir.Path -Filter '*.json' -File | Sort-Object Name | ForEach-Object {
        Test-ManifestFile -File $_ -AllowedTypes $dir.Types -DirectoryLabel $dir.Label
    }
}

foreach ($warning in $warnings) {
    Write-Warning $warning
}

if ($errors.Count -gt 0) {
    Write-Error "扩展 manifest 校验失败：$($errors.Count) 个错误。"
    foreach ($errorItem in $errors) {
        Write-Error $errorItem
    }
    exit 1
}

if ($Strict -and $warnings.Count -gt 0) {
    Write-Error "扩展 manifest 严格校验失败：$($warnings.Count) 个警告。"
    exit 1
}

Write-Host "extension manifest protocol: $protocolId | suite $suiteVersion"
Write-Host "extension manifests valid: checked=$checked enabled=$enabled disabled=$disabled warnings=$($warnings.Count)"
