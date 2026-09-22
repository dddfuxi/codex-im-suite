param(
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $root = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.claude-to-im\runtime\captures'
  $OutputPath = Join-Path $root ("desktop-{0:yyyyMMdd-HHmmss}.png" -f (Get-Date))
}

$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($bounds.Width -le 0 -or $bounds.Height -le 0) {
  throw "Invalid virtual screen bounds."
}

$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
  $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}

if (-not (Test-Path -LiteralPath $OutputPath)) {
  throw "Screenshot was not written: $OutputPath"
}

[pscustomobject]@{
  success = $true
  path = $OutputPath
  width = $bounds.Width
  height = $bounds.Height
} | ConvertTo-Json -Compress
