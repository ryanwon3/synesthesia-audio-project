[CmdletBinding()]
param(
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$localNode = Get-ChildItem -Path (Join-Path $root ".tools") -Directory -Filter "node-v*-win-x64" -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    Select-Object -First 1
$npm = if ($localNode) {
    $env:Path = "$($localNode.FullName);$env:Path"
    Join-Path $localNode.FullName "npm.cmd"
} else {
    (Get-Command npm.cmd -ErrorAction Stop).Source
}

Push-Location (Join-Path $root "visualizer")
try {
    if (-not (Test-Path "node_modules")) {
        & $npm ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
    }

    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw "Visualizer build failed." }
} finally {
    Pop-Location
}

$dotnet = "C:\Program Files\dotnet\dotnet.exe"
if (-not (Test-Path $dotnet)) {
    $dotnet = (Get-Command dotnet -ErrorAction Stop).Source
}

& $dotnet restore (Join-Path $root "SpotifySynesthesia.sln") `
    --configfile (Join-Path $root "NuGet.Config") `
    --packages (Join-Path $root ".packages")
if ($LASTEXITCODE -ne 0) { throw ".NET restore failed." }

& $dotnet build (Join-Path $root "SpotifySynesthesia.sln") `
    --configuration $Configuration `
    --no-restore
if ($LASTEXITCODE -ne 0) { throw ".NET build failed." }
