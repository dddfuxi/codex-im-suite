param()

$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'shared.ps1')

function Assert-Equal {
    param(
        [object]$Expected,
        [object]$Actual,
        [string]$Message
    )

    if ([string]$Expected -ne [string]$Actual) {
        throw "$Message expected=[$Expected] actual=[$Actual]"
    }
}

function Assert-Contains {
    param(
        [object[]]$Values,
        [string]$Expected,
        [string]$Message
    )

    if (-not (@($Values) -contains $Expected)) {
        throw "$Message missing=[$Expected] values=[$(@($Values) -join ',')]"
    }
}

function Assert-NotContains {
    param(
        [object[]]$Values,
        [string]$Unexpected,
        [string]$Message
    )

    if (@($Values) -contains $Unexpected) {
        throw "$Message unexpected=[$Unexpected] values=[$(@($Values) -join ',')]"
    }
}

function Write-TestJson {
    param(
        [string]$Path,
        [string]$Body
    )

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    Set-Content -LiteralPath $Path -Encoding UTF8 -Value $Body
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "codex-im-suite-release-manifest-summary-$([guid]::NewGuid().ToString('N'))"

try {
    $suiteRoot = Join-Path $tempRoot 'suite'
    $liveRoot = Join-Path $tempRoot 'live-runtime'
    New-Item -ItemType Directory -Force -Path $suiteRoot, $liveRoot | Out-Null

    @'
{
  "extensionProtocol": {
    "manifestDirs": [
      "./config/mcp.d",
      "./config/skills.d",
      "./config/plugins.d"
    ]
  },
  "runtimeProtocol": {
    "id": "runtime-manifest/v1"
  },
  "actionProtocol": {
    "manifestDirs": [
      "./config/action-manifests.d"
    ],
    "legacyManifestDirs": [
      "./config/local-agent-tools.d"
    ]
  },
  "config": {
    "runtimeManifestDir": "./config/runtime.d",
    "actionManifestDir": "./config/action-manifests.d",
    "legacyLocalAgentToolManifestDir": "./config/local-agent-tools.d"
  }
}
'@ | Set-Content -LiteralPath (Join-Path $suiteRoot 'suite.manifest.json') -Encoding UTF8

    $logicalFiles = @(
        'mcp.d/example-mcp.json',
        'skills.d/example-skill.json',
        'plugins.d/example-plugin.json',
        'runtime.d/example-runtime.json',
        'action-manifests.d/example-action.json',
        'local-agent-tools.d/example-legacy-action.json'
    )

    foreach ($relative in $logicalFiles) {
        $body = "{`"id`":`"$relative`"}"
        Write-TestJson -Path (Join-Path $suiteRoot "config/$relative") -Body $body

        $liveRelative = if ($relative -match '^(mcp\.d|skills\.d|plugins\.d)/') {
            $relative
        } else {
            "config/$relative"
        }
        Write-TestJson -Path (Join-Path $liveRoot $liveRelative) -Body $body
    }

    Write-TestJson -Path (Join-Path $suiteRoot 'config/feishu-emoji.d/default.json') -Body '{"id":"emoji-catalog"}'
    Write-TestJson -Path (Join-Path $liveRoot 'config/feishu-emoji.d/default.json') -Body '{"id":"emoji-catalog"}'

    $suiteSummary = Get-ReleaseManifestSummary -Root $suiteRoot
    $liveSummary = Get-ReleaseManifestSummary -Root $liveRoot

    Assert-Equal -Expected 6 -Actual $suiteSummary.Count -Message 'suite manifest count'
    Assert-Equal -Expected 6 -Actual $liveSummary.Count -Message 'live manifest count'
    Assert-Equal -Expected $suiteSummary.Hash -Actual $liveSummary.Hash -Message 'canonical manifest hash'

    foreach ($dir in @(
        'config/mcp.d',
        'config/skills.d',
        'config/plugins.d',
        'config/runtime.d',
        'config/action-manifests.d',
        'config/local-agent-tools.d'
    )) {
        Assert-Contains -Values $suiteSummary.Directories -Expected $dir -Message 'suite manifest directories'
        Assert-Contains -Values $liveSummary.Directories -Expected $dir -Message 'live manifest directories'
    }

    Assert-NotContains -Values $suiteSummary.Directories -Unexpected 'config/feishu-emoji.d' -Message 'suite non-manifest directory filter'
    Assert-NotContains -Values $liveSummary.Directories -Unexpected 'config/feishu-emoji.d' -Message 'live non-manifest directory filter'

    Write-Host "release manifest summary tests: PASS count=$($suiteSummary.Count) hash=$($suiteSummary.Hash)"
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
