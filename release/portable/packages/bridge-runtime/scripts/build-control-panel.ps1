$ErrorActionPreference = 'Stop'

throw @'
This legacy bridge-runtime control panel build entry is disabled.
Use the suite control panel project instead:

  apps/control-panel/CodexImSuite.ControlPanel.csproj

From the suite root, run:

  powershell -ExecutionPolicy Bypass -File .\scripts\build-packages.ps1
'@
