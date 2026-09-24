[CmdletBinding()]
param(
    [ValidateSet("win-x64", "win-arm64")]
    [string] $Runtime,
    [ValidateSet("msvc", "gnu")]
    [string] $Toolchain,
    [switch] $Test
)

$ErrorActionPreference = "Stop"
$windowsRoot = Split-Path -Parent $PSScriptRoot
$appsRoot = Split-Path -Parent $windowsRoot
$projectRoot = Split-Path -Parent $appsRoot

if (-not $Runtime) {
    $Runtime = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") {
        "win-arm64"
    } else {
        "win-x64"
    }
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "A Rust toolchain is required to build Notes. Install Rust from https://rustup.rs (MSVC + Windows SDK, or the GNU toolchain + MinGW-w64). Python and .NET are not used."
}

if (-not $Toolchain) {
    $rustVersion = & rustc -vV
    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect the Rust toolchain."
    }
    $Toolchain = if ($rustVersion -match "host: .*windows-gnu") { "gnu" } else { "msvc" }
}
if ($Runtime -eq "win-arm64" -and $Toolchain -eq "gnu") {
    throw "Windows ARM64 requires the aarch64-pc-windows-msvc Rust target and the Visual C++ ARM64 build tools."
}

$architecture = if ($Runtime -eq "win-arm64") { "aarch64" } else { "x86_64" }
$target = "$architecture-pc-windows-$Toolchain"
$targetDirectory = Join-Path $projectRoot "build\rust"
$manifest = Join-Path $projectRoot "Cargo.toml"
$output = Join-Path $projectRoot "build\windows\$Runtime"

Push-Location $projectRoot
try {
    if ($Test) {
        & cargo test --locked --workspace --manifest-path $manifest --target $target --target-dir $targetDirectory
        if ($LASTEXITCODE -ne 0) { throw "The Rust tests failed." }
    }
    & cargo build --locked --release -p notes-app-windows --manifest-path $manifest --target $target --target-dir $targetDirectory
    if ($LASTEXITCODE -ne 0) { throw "The Windows build failed." }
} finally {
    Pop-Location
}

$executable = Join-Path $targetDirectory "$target\release\notes.exe"
if (-not (Test-Path -LiteralPath $executable)) {
    throw "The build did not produce the native executable."
}
if (Test-Path -LiteralPath $output) {
    Remove-Item -LiteralPath $output -Recurse -Force
}
New-Item -ItemType Directory -Path $output -Force | Out-Null
Copy-Item -LiteralPath $executable -Destination (Join-Path $output "Notes.exe")
$result = Get-Item -LiteralPath (Join-Path $output "Notes.exe")
Write-Host ("Built {0} ({1:N2} MB)" -f $result.FullName, ($result.Length / 1MB))
