[CmdletBinding()]
param(
    [switch]$Rebuild
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$executable = Join-Path $root "desktop\SpotifySynesthesia.Desktop\bin\Release\net10.0-windows10.0.20348.0\SpotifySynesthesia.Desktop.exe"

if ($Rebuild -or -not (Test-Path $executable)) {
    & (Join-Path $root "Build.ps1") -Configuration Release
}

Start-Process -FilePath $executable
