#!/usr/bin/env pwsh
param(
  [String]$Version = $env:AGENT_SLACK_VERSION,
  [String]$InstallDir = $env:AGENT_SLACK_INSTALL_DIR,
  [String]$Repo = $(if ($env:AGENT_SLACK_REPO) { $env:AGENT_SLACK_REPO } else { "stablyai/agent-slack" }),
  [Switch]$SkipVerify = ($env:AGENT_SLACK_SKIP_VERIFY -eq "1"),
  [Switch]$NoPathUpdate = $false
)

$ErrorActionPreference = "Stop"

# Detect true CPU architecture from registry (works even under x64 emulation on ARM64).
$RegArch = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment").PROCESSOR_ARCHITECTURE
switch ($RegArch) {
  "AMD64" { $Arch = "x64" }
  "ARM64" { $Arch = "arm64" }
  default {
    Write-Error "Unsupported Windows architecture: $RegArch (supported: AMD64, ARM64)"
    exit 1
  }
}

$BinName = "agent-slack.exe"
$Asset = "agent-slack-windows-$Arch.exe"

if (-not $InstallDir) {
  $LocalAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME "AppData\Local" }
  $InstallDir = Join-Path $LocalAppData "agent-slack\bin"
}

if ($Version) {
  $Tag = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
  $BaseUrl = "https://github.com/$Repo/releases/download/$Tag"
} else {
  $BaseUrl = "https://github.com/$Repo/releases/latest/download"
}

$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "agent-slack-install-$([System.Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null

function Publish-EnvChange {
  if (-not ("Win32.NativeMethods" -as [Type])) {
    Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @"
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(
    IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
"@
  }
  $result = [UIntPtr]::Zero
  [Win32.NativeMethods]::SendMessageTimeout(
    [IntPtr]0xffff,
    0x1a,
    [UIntPtr]::Zero,
    "Environment",
    2,
    5000,
    [ref]$result
  ) | Out-Null
}

try {
  $BinTmp = Join-Path $TmpDir $Asset
  Write-Host "Downloading $Asset..."
  Invoke-WebRequest -Uri "$BaseUrl/$Asset" -OutFile $BinTmp -UseBasicParsing

  if (-not $SkipVerify) {
    Write-Host "Verifying checksum..."
    $SumsTmp = Join-Path $TmpDir "checksums-sha256.txt"
    Invoke-WebRequest -Uri "$BaseUrl/checksums-sha256.txt" -OutFile $SumsTmp -UseBasicParsing
    $ExpectedLine = Get-Content $SumsTmp | Where-Object { $_ -match "\s+$([Regex]::Escape($Asset))$" } | Select-Object -First 1
    if (-not $ExpectedLine) {
      throw "Checksum not found for $Asset in checksums-sha256.txt"
    }
    $ExpectedHash = ($ExpectedLine.Trim() -split "\s+")[0].ToLowerInvariant()
    $ActualHash = (Get-FileHash -Path $BinTmp -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ActualHash -ne $ExpectedHash) {
      throw "Checksum mismatch for ${Asset}: expected $ExpectedHash, got $ActualHash"
    }
  }

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  $DestBin = Join-Path $InstallDir $BinName
  $BackupBin = "$DestBin.bak"
  if (Test-Path $DestBin) {
    if (Test-Path $BackupBin) {
      Remove-Item -Path $BackupBin -Force -ErrorAction SilentlyContinue
    }
    Move-Item -Path $DestBin -Destination $BackupBin -Force
  }
  try {
    Copy-Item -Path $BinTmp -Destination $DestBin -Force
    if (Test-Path $BackupBin) {
      Remove-Item -Path $BackupBin -Force -ErrorAction SilentlyContinue
    }
  } catch {
    if (Test-Path $BackupBin) {
      Move-Item -Path $BackupBin -Destination $DestBin -Force -ErrorAction SilentlyContinue
    }
    throw
  }

  Write-Host "Installed agent-slack to $DestBin"

  if (-not $NoPathUpdate) {
    $RegKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
    $CurrentPath = $RegKey.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $Entries = @($CurrentPath -split ";" | Where-Object { $_ -ne "" })
    if ($Entries -notcontains $InstallDir) {
      $NewPath = if ($CurrentPath) { "$CurrentPath;$InstallDir" } else { $InstallDir }
      $RegKey.SetValue("Path", $NewPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
      Publish-EnvChange
      Write-Host "Added $InstallDir to user PATH. Restart your terminal to use 'agent-slack'."
    }
    $RegKey.Close()
  }
} finally {
  Remove-Item -Path $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
