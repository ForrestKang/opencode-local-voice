[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string]$Transaction,
  [string]$FixtureRoot,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Fail([string]$Message) { throw "restore maintenance: $Message" }
function Full([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { Fail "path is empty" }
  return [IO.Path]::GetFullPath($Value)
}
function Same([string]$Left, [string]$Right) {
  $leftFull = [regex]::Replace((Full $Left), '\\+$', '')
  $rightFull = [regex]::Replace((Full $Right), '\\+$', '')
  return $leftFull.Equals($rightFull, [StringComparison]::OrdinalIgnoreCase)
}
function Under([string]$Root, [string]$Value) {
  $rootFull = ([regex]::Replace((Full $Root), '\\+$', '')) + '\'; $valueFull = Full $Value
  return $valueFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase) -or (Same $Root $Value)
}
function Require-File([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Fail "$Label is missing: $Path" }
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "$Label must not be a reparse point: $Path" }
}
function Require-WriteTarget([string]$Path, [string]$Label) {
  $full = Full $Path
  $item = Get-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
  if ($item) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "$Label must not be a reparse point: $full" }
    if ($item.PSIsContainer) { Fail "$Label must not be a directory: $full" }
  }
  $cursor = Split-Path -Parent $full
  while ($cursor) {
    $parent = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
    if ($parent) {
      if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "$Label parent must not be a reparse point: $cursor" }
      if (-not $parent.PSIsContainer) { Fail "$Label parent must be a directory: $cursor" }
    }
    $next = Split-Path -Parent $cursor
    if ($next -eq $cursor) { break }
    $cursor = $next
  }
}
function Sha256([string]$Path) {
  $algorithm = [Security.Cryptography.SHA256]::Create(); $stream = [IO.File]::OpenRead($Path)
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}
function Write-JsonAtomic([string]$Path, $Value) {
  Require-WriteTarget $Path "JSON write target"
  $tmp = "$Path.tmp-$PID-$([guid]::NewGuid().ToString('N'))"
  $Value | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}
function Read-Json([string]$Path, [string]$Label) {
  Require-File $Path $Label
  try { return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json) }
  catch { Fail "$Label is invalid: $($_.Exception.Message)" }
}
function Restore-File([object]$Before) {
  $path = Full ([string]$Before.path)
  if ($Before.exists -eq $true) {
    Require-File ([string]$Before.backupPath) "maintenance backup"
    if ((Sha256 ([string]$Before.backupPath)) -ne [string]$Before.beforeSha256) { Fail "maintenance backup hash mismatch: $path" }
    Require-WriteTarget $path "maintenance rollback target"
    Copy-Item -LiteralPath ([string]$Before.backupPath) -Destination $path -Force
  } elseif (Test-Path -LiteralPath $path -PathType Leaf) {
    Require-WriteTarget $path "maintenance rollback target"
    Remove-Item -LiteralPath $path -Force
  } elseif (Test-Path -LiteralPath $path) { Fail "refusing to remove a non-file rollback target: $path" }
}
function Invoke-Shortcut([string]$Script, [string]$Mode, [string]$Config, [string]$Receipt, [string]$Fixture, [switch]$WhatIf) {
  $args = @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Script, "-Mode", $Mode, "-ConfigPath", $Config, "-ReceiptPath", $Receipt)
  if ($Fixture) { $args += @("-FixtureRoot", $Fixture) }
  if ($WhatIf) { $args += "-DryRun" }
  $lines = @(& powershell.exe @args 2>&1 | ForEach-Object { [string]$_ })
  if ($LASTEXITCODE -ne 0) { Fail "shortcut restore failed: $($lines -join ' ')" }
  return $lines
}
function Shortcut-Paths($Receipt) { return @($Receipt.entries | ForEach-Object { Full ([string]$_.path) }) }

$Transaction = Full $Transaction
if (-not (Test-Path -LiteralPath $Transaction -PathType Container)) { Fail "transaction directory is missing" }
$manifestPath = Join-Path $Transaction "maintenance-transaction.json"
$manifest = Read-Json $manifestPath "maintenance transaction"
if ($manifest.schema -ne 1 -or $manifest.featureVersion -ne "0.2.0") { Fail "maintenance transaction schema is unsupported" }
if (@("applied", "restore-failed") -notcontains [string]$manifest.state) { Fail "maintenance transaction is not an applied or retryable restore transaction" }
if ($FixtureRoot) {
  $FixtureRoot = Full $FixtureRoot
  foreach ($path in @($Transaction, [string]$manifest.activePath, [string]$manifest.launcherPath, [string]$manifest.receiptPath)) { if (-not (Under $FixtureRoot $path)) { Fail "FixtureRoot does not contain $path" } }
}
$activePath = Full ([string]$manifest.activePath); $launcherPath = Full ([string]$manifest.launcherPath); $receiptPath = Full ([string]$manifest.receiptPath)
$beforeEntries = @($manifest.before); $deployedEntries = @($manifest.deployed)
if ($beforeEntries.Count -eq 0 -or $deployedEntries.Count -eq 0) { Fail "maintenance transaction is incomplete" }

# Validate every deployed value before touching any file or link.  This is the
# manual-change gate: a user edit makes the restore stop without partial work.
foreach ($deployed in $deployedEntries) {
  $path = Full ([string]$deployed.path)
  if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Sha256 $path) -ne [string]$deployed.sha256) { Fail "deployed maintenance file was changed: $path" }
}
$active = Read-Json $activePath "active.json"
$shortcutScript = Join-Path (Full ([string]$manifest.packageRoot)) "windows\maintenance-shortcuts.ps1"
Require-File $shortcutScript "maintenance-shortcuts.ps1"
$rollbackRoot = Join-Path $Transaction ("restore-rollback-" + [guid]::NewGuid().ToString("N"))
$rollbackFiles = @(); $rollbackLinks = @(); $receiptBeforeBytes = $null
if (-not $DryRun) {
  New-Item -ItemType Directory -Path $rollbackRoot -Force | Out-Null
  foreach ($deployed in $deployedEntries) {
    $source = Full ([string]$deployed.path); $saved = Join-Path $rollbackRoot ([IO.Path]::GetFileName($source))
    Copy-Item -LiteralPath $source -Destination $saved -Force
    $rollbackFiles += [ordered]@{ path = $source; backup = $saved; sha256 = [string]$deployed.sha256 }
  }
  $receiptObject = Read-Json $receiptPath "shortcut receipt"
  foreach ($link in @($receiptObject.entries)) {
    $source = Full ([string]$link.path)
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { Fail "deployed shortcut is missing: $source" }
    $saved = Join-Path $rollbackRoot ("link-" + [guid]::NewGuid().ToString("N") + ".lnk")
    Copy-Item -LiteralPath $source -Destination $saved -Force
    $rollbackLinks += [ordered]@{ path = $source; backup = $saved }
  }
} else { $receiptObject = Read-Json $receiptPath "shortcut receipt" }

try {
  if ($DryRun) {
    Invoke-Shortcut $shortcutScript "Restore" $activePath $receiptPath $FixtureRoot -WhatIf | Out-Null
    [ordered]@{ state = "dry-run"; transaction = $Transaction; activePath = $activePath; receiptPath = $receiptPath } | ConvertTo-Json -Depth 10
    exit 0
  }
  Invoke-Shortcut $shortcutScript "Restore" $activePath $receiptPath $FixtureRoot | Out-Null
  foreach ($before in $beforeEntries) { Restore-File $before }
  $manifest.state = "restored"
  $manifest | Add-Member -NotePropertyName restoredAt -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) -Force
  Write-JsonAtomic $manifestPath $manifest
  [ordered]@{ state = "restored"; transaction = $Transaction; activePath = $activePath; launcherPath = $launcherPath; receiptPath = $receiptPath } | ConvertTo-Json -Depth 10
} catch {
  $failure = $_.Exception.Message
  # Restore the exact deployed bytes and shortcut files if an intermediate
  # rollback step failed.  This keeps this script itself recoverable.
  foreach ($file in $rollbackFiles) { try { Require-WriteTarget $file.path "maintenance rollback target"; Copy-Item -LiteralPath $file.backup -Destination $file.path -Force } catch {} }
  foreach ($link in $rollbackLinks) { try { Require-WriteTarget $link.path "shortcut rollback target"; Copy-Item -LiteralPath $link.backup -Destination $link.path -Force } catch {} }
  $manifest.state = "restore-failed"
  $manifest | Add-Member -NotePropertyName error -NotePropertyValue $failure -Force
  $manifest | Add-Member -NotePropertyName restoreFailedAt -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) -Force
  try { Write-JsonAtomic $manifestPath $manifest } catch {}
  Fail $failure
}
