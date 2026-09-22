$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# TAPD token 只能由 Runtime 从受管 config.env 注入本进程；stdout 保留给 MCP stdio。
if ([string]::IsNullOrWhiteSpace($env:TAPD_TOKEN)) {
    [Console]::Error.WriteLine('TAPD MCP requires TAPD_TOKEN in CTI_HOME\config.env. Restart Bridge after configuring it.')
    exit 1
}

& npx.cmd --yes 'tapd-server-cli@0.4.3'
exit $LASTEXITCODE
