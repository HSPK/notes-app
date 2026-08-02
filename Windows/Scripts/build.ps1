[CmdletBinding()]
param(
    [ValidateSet("win-x64", "win-arm64")]
    [string] $Runtime
)

$ErrorActionPreference = "Stop"
$windowsRoot = Split-Path -Parent $PSScriptRoot
$projectRoot = Split-Path -Parent $windowsRoot

if (-not $Runtime) {
    $Runtime = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") {
        "win-arm64"
    } else {
        "win-x64"
    }
}

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw "The .NET 8 SDK is required. Install it from https://dotnet.microsoft.com/download/dotnet/8.0 and try again."
}

$platform = switch ($Runtime) {
    "win-arm64" { "ARM64" }
    "win-x64" { "x64" }
}

$output = Join-Path $projectRoot "build\windows\$Runtime"
if (Test-Path -LiteralPath $output) {
    Remove-Item -LiteralPath $output -Recurse -Force
}
& dotnet publish `
    (Join-Path $windowsRoot "NotesApp.Windows.csproj") `
    --configuration Release `
    --runtime $Runtime `
    --output $output `
    -p:Platform=$platform `
    -p:DebugSymbols=false `
    -p:DebugType=None `
    --nologo

if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $output "Notes.exe"))) {
    throw "The Windows build failed."
}

Write-Host "Built $(Join-Path $output 'Notes.exe')"
