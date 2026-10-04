[CmdletBinding()]
param(
  [string]$ToolsRoot = (Join-Path $env:LOCALAPPDATA 'ssbt'),
  [string]$ProgramRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')),
  [switch]$Bootstrap,
  [string[]]$CargoArgs = @('build', '--release', '--locked')
)

# Builds the LiteSVM host (programs/svm) on the pinned portable toolchain, for
# `scripts/check-candy-svm.ts`; `-CargoArgs` runs any other cargo command on the same toolchain.
# Portable local build only: no network reads, installers, registry changes, wallet keys,
# deployments or uploads. `-Bootstrap` is the one exception, and it downloads only the
# pinned official archives listed below, each verified against its SHA-256.
# Environment changes are restored on exit.
$ErrorActionPreference = 'Stop'
$ToolsRoot = [IO.Path]::GetFullPath($ToolsRoot)
$programRoot = [IO.Path]::GetFullPath($ProgramRoot)
$manifestUrl = 'https://download.visualstudio.microsoft.com/download/pr/f8d58e41-102a-4347-a567-60d7235da3b5/469b3396a3493df91870ce13c52015a92283a2d1c6fd12e5f7e55669be8050ca/VisualStudio.vsman'

function Get-VerifiedArchive([string]$Url, [string]$Path, [string]$Sha256) {
  if (-not (Test-Path -LiteralPath $Path)) {
    Invoke-WebRequest $Url -OutFile $Path
  }
  if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $Sha256) {
    throw "Checksum mismatch; preserve and inspect this archive before retrying: $Path"
  }
}

function Expand-ToolArchive([string]$Path, [string]$Destination) {
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  & tar.exe -xf $Path -C $Destination
  if ($LASTEXITCODE -ne 0) { throw "Archive extraction failed: $Path" }
}

if ($Bootstrap) {
  New-Item -ItemType Directory -Path $ToolsRoot -Force | Out-Null
  $platformArchive = Join-Path $ToolsRoot 'platform-tools-v1.57.tar.bz2'
  Get-VerifiedArchive 'https://github.com/anza-xyz/platform-tools/releases/download/v1.57/platform-tools-windows-x86_64.tar.bz2' $platformArchive '792bc821f006e2b56aee31640110b449d5dc89f1305f16f24037465ab8cd7d5a'
  if (-not (Test-Path (Join-Path $ToolsRoot 'platform-tools/rust/bin/rustc.exe'))) {
    Expand-ToolArchive $platformArchive (Join-Path $ToolsRoot 'platform-tools')
  }
  $manifestFile = Join-Path $ToolsRoot 'VisualStudio.vsman'
  # The file's own SHA-256. The hash in the URL's path is Microsoft's name for the manifest, not
  # the digest of the bytes served.
  Get-VerifiedArchive $manifestUrl $manifestFile 'b60efac8768e31b4b0bb74d312a3fd3145de9bef7f794c050d498d079e540e11'
  $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json -Depth 100
  $packageIds = @(
    'Microsoft.VC.14.44.17.14.CRT.Headers.base',
    'Microsoft.VC.14.44.17.14.CRT.x64.Desktop.base',
    'Microsoft.VC.14.44.17.14.CRT.x64.OneCore.Desktop.base',
    'Microsoft.VC.14.44.17.14.Tools.HostX64.TargetX64.base',
    'Microsoft.VC.14.44.17.14.Tools.HostX64.TargetX64.Res.base'
  )
  foreach ($id in $packageIds) {
    $packages = @($manifest.packages | Where-Object { $_.id -eq $id -and (-not $_.language -or $_.language -eq 'en-US') })
    if ($packages.Count -ne 1) { throw "Expected one compiler package: $id" }
    $package = $packages[0]
    foreach ($payload in $package.payloads) {
      $file = Join-Path $ToolsRoot $payload.fileName
      Get-VerifiedArchive $payload.url $file $payload.sha256
      Expand-ToolArchive $file (Join-Path $ToolsRoot ('compiler-' + $package.id + '-' + $package.language))
    }
  }
  $sdkHashes = @{
    'microsoft.windows.sdk.cpp' = 'f8787b2f6678164ae789bdca6247e696c2a0f529a39ceb969d6ef3d69a987131'
    'microsoft.windows.sdk.cpp.x64' = 'dba411916afdd47c99fecdf7d5558df7679d291dc338746590ae9adf5fd0511b'
  }
  foreach ($name in $sdkHashes.Keys) {
    $file = Join-Path $ToolsRoot ($name + '.nupkg')
    Get-VerifiedArchive "https://api.nuget.org/v3-flatcontainer/$name/10.0.26100.8249/$name.10.0.26100.8249.nupkg" $file $sdkHashes[$name]
    Expand-ToolArchive $file (Join-Path $ToolsRoot $name)
  }
}

$vcBin = Join-Path $ToolsRoot 'compiler-Microsoft.VC.14.44.17.14.Tools.HostX64.TargetX64.base-/Contents/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64'
$vcResources = Join-Path $ToolsRoot 'compiler-Microsoft.VC.14.44.17.14.Tools.HostX64.TargetX64.Res.base-en-US/Contents/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64/1033'
$vcLib = Join-Path $ToolsRoot 'compiler-Microsoft.VC.14.44.17.14.CRT.x64.Desktop.base-/Contents/VC/Tools/MSVC/14.44.35207/lib/x64'
$vcOneCore = Join-Path $ToolsRoot 'compiler-Microsoft.VC.14.44.17.14.CRT.x64.OneCore.Desktop.base-/Contents/VC/Tools/MSVC/14.44.35207/lib/onecore/x64'
$vcInclude = Join-Path $ToolsRoot 'compiler-Microsoft.VC.14.44.17.14.CRT.Headers.base-/Contents/VC/Tools/MSVC/14.44.35207/include'
$sdkInclude = Join-Path $ToolsRoot 'microsoft.windows.sdk.cpp/c/Include/10.0.26100.0'
$cargo = Join-Path $ToolsRoot 'platform-tools/rust/bin/cargo.exe'
$rustc = Join-Path $ToolsRoot 'platform-tools/rust/bin/rustc.exe'
foreach ($required in @($cargo, $rustc, (Join-Path $vcBin 'link.exe'), (Join-Path $vcOneCore 'msvcrt.lib'), (Join-Path $sdkInclude 'ucrt/stdio.h'))) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Missing portable toolchain file: $required. Run with -Bootstrap to acquire the pinned official archives." }
}
Copy-Item -LiteralPath $vcResources -Destination $vcBin -Recurse -Force

$variables = @('CARGO_HOME', 'CARGO_TARGET_DIR', 'RUSTC', 'CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER', 'CC_x86_64_pc_windows_msvc', 'AR_x86_64_pc_windows_msvc', 'PATH', 'LIB', 'INCLUDE')
$previous = @{}
foreach ($name in $variables) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
Push-Location $programRoot
try {
  $env:CARGO_HOME = Join-Path $ToolsRoot 'cargo-cache'
  $env:CARGO_TARGET_DIR = Join-Path $programRoot 'target'
  $env:RUSTC = $rustc
  $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = Join-Path $vcBin 'link.exe'
  $env:CC_x86_64_pc_windows_msvc = Join-Path $vcBin 'cl.exe'
  $env:AR_x86_64_pc_windows_msvc = Join-Path $vcBin 'lib.exe'
  $env:PATH = (Join-Path $ToolsRoot 'platform-tools/rust/bin') + ';' + (Join-Path $ToolsRoot 'platform-tools/llvm/bin') + ';' + $vcBin + ';' + $env:PATH
  $env:LIB = $vcLib + ';' + $vcOneCore + ';' + (Join-Path $ToolsRoot 'microsoft.windows.sdk.cpp.x64/c/ucrt/x64') + ';' + (Join-Path $ToolsRoot 'microsoft.windows.sdk.cpp.x64/c/um/x64')
  $env:INCLUDE = $vcInclude + ';' + (Join-Path $sdkInclude 'ucrt') + ';' + (Join-Path $sdkInclude 'shared') + ';' + (Join-Path $sdkInclude 'um')
  & $rustc -V
  & $cargo @CargoArgs
  if ($LASTEXITCODE -ne 0) { throw "cargo $($CargoArgs -join ' ') failed." }
} finally {
  Pop-Location
  foreach ($name in $variables) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
