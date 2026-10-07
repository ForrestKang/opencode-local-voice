[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string]$PackageRoot,
  [Parameter(Mandatory = $true)] [string]$AppPath,
  [Parameter(Mandatory = $true)] [string]$VoiceHome,
  [Parameter(Mandatory = $true)] [string]$RuntimePath,
  [Parameter(Mandatory = $true)] [string]$BackupRoot,
  [Parameter(Mandatory = $true)] [string]$MaintenanceRoot,
  [Parameter(Mandatory = $true)] [string]$NodePath,
  [Parameter(Mandatory = $true)] [string]$PythonPath,
  [string]$FixtureRoot,
  [string]$CandidateAsar,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Fail([string]$Message) { throw "install maintenance: $Message" }
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
function Require-Dir([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { Fail "$Label is missing: $Path" }
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "$Label must not be a reparse point: $Path" }
}
function Require-File([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Fail "$Label is missing: $Path" }
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "$Label must not be a reparse point: $Path" }
}
function Sha256([string]$Path) {
  $algorithm = [Security.Cryptography.SHA256]::Create(); $stream = [IO.File]::OpenRead($Path)
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}
function Write-JsonAtomic([string]$Path, $Value) {
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $tmp = "$Path.tmp-$PID-$([guid]::NewGuid().ToString('N'))"
  $Value | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}
function Read-Json([string]$Path, [string]$Label) {
  Require-File $Path $Label
  try { return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json) }
  catch { Fail "$Label is invalid: $($_.Exception.Message)" }
}
function Backup-File([string]$Path, [string]$Name, [string]$BeforeRoot) {
  $item = [ordered]@{ name = $Name; path = $Path; exists = $false; backupPath = $null; beforeSha256 = $null }
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    $source = Get-Item -LiteralPath $Path -Force
    if ($source.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "refusing to back up a reparse point: $Path" }
    $saved = Join-Path $BeforeRoot $Name
    $savedParent = Split-Path -Parent $saved
    if (-not (Test-Path -LiteralPath $savedParent -PathType Container)) { New-Item -ItemType Directory -Path $savedParent -Force | Out-Null }
    Copy-Item -LiteralPath $Path -Destination $saved -Force
    $item.exists = $true; $item.backupPath = $saved; $item.beforeSha256 = Sha256 $Path
  } elseif (Test-Path -LiteralPath $Path) { Fail "known maintenance target is not a regular file: $Path" }
  return $item
}
function Restore-File([object]$Item) {
  $path = Full ([string]$Item.path)
  if ($Item.exists -eq $true) {
    Require-File ([string]$Item.backupPath) "maintenance backup"
    if ((Sha256 ([string]$Item.backupPath)) -ne [string]$Item.beforeSha256) { Fail "maintenance backup hash mismatch: $path" }
    Copy-Item -LiteralPath ([string]$Item.backupPath) -Destination $path -Force
  } elseif (Test-Path -LiteralPath $path -PathType Leaf) {
    Remove-Item -LiteralPath $path -Force
  } elseif (Test-Path -LiteralPath $path) { Fail "refusing to remove a non-file rollback target: $path" }
}
function Find-Asar([string]$App) {
  foreach ($candidate in @((Join-Path $App "resources\app.asar"), (Join-Path $App "app.asar"), (Join-Path $App "Contents\Resources\app.asar"))) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Full $candidate) }
  }
  Fail "app.asar is missing under AppPath"
}
function Test-Hook([string]$Asar) {
  $text = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($Asar))
  if ($text.IndexOf("oc-voice-update.cjs", [StringComparison]::Ordinal) -lt 0 -and
      $text.IndexOf("oc-voice-update:install", [StringComparison]::Ordinal) -lt 0 -and
      $text.IndexOf("oc-voice-update:call", [StringComparison]::Ordinal) -lt 0) {
    Fail "target app.asar does not contain the 0.2.0 update bridge hook"
  }
}
function Invoke-PackageCache([string]$Source, [string]$Destination, [string]$Node) {
  $tool = Join-Path $Source "shared\maintenance-package.cjs"
  Require-File $tool "maintenance-package.cjs"
  $lines = @(& $Node $tool --source $Source --maintenance-root $Destination 2>&1 | ForEach-Object { [string]$_ })
  if ($LASTEXITCODE -ne 0) { Fail "stable maintenance package creation failed (exit $LASTEXITCODE): $($lines -join ' ')" }
  $json = $null
  foreach ($line in $lines) { if ($line.Trim().StartsWith("{")) { try { $json = $line | ConvertFrom-Json } catch {} } }
  if ($null -eq $json -or [string]::IsNullOrWhiteSpace([string]$json.packageRoot)) { Fail "maintenance-package.cjs returned no package metadata" }
  return $json
}
function Invoke-PackageVerify([string]$Source, [string]$Node) {
  $tool = Join-Path $Source "shared\maintenance-package.cjs"
  Require-File $tool "maintenance-package.cjs"
  $lines = @(& $Node $tool --verify-only --source $Source 2>&1 | ForEach-Object { [string]$_ })
  if ($LASTEXITCODE -ne 0) { Fail "maintenance package verification failed (exit $LASTEXITCODE): $($lines -join ' ')" }
  $json = $null
  foreach ($line in $lines) { if ($line.Trim().StartsWith("{")) { try { $json = $line | ConvertFrom-Json } catch {} } }
  if ($null -eq $json -or [string]::IsNullOrWhiteSpace([string]$json.packageRoot)) { Fail "maintenance-package.cjs returned no verification metadata" }
  return $json
}
function Invoke-ShortcutScript([string]$Mode, [string]$Config, [string]$Receipt, [string]$Transaction, [string]$Fixture, [switch]$WhatIf) {
  $script = Join-Path $PackageRoot "windows\maintenance-shortcuts.ps1"
  Require-File $script "maintenance-shortcuts.ps1"
  $args = @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script, "-Mode", $Mode, "-ConfigPath", $Config, "-ReceiptPath", $Receipt)
  if ($Transaction) { $args += @("-TransactionPath", $Transaction) }
  if ($Fixture) { $args += @("-FixtureRoot", $Fixture) }
  if ($WhatIf) { $args += "-DryRun" }
  $lines = @(& powershell.exe @args 2>&1 | ForEach-Object { [string]$_ })
  if ($LASTEXITCODE -ne 0) { Fail "shortcut $Mode failed: $($lines -join ' ')" }
  return $lines
}
function Test-ExistingDeployment([string]$ActivePath, [string]$LauncherPath, [string]$ReceiptPath, [string]$StablePackageRoot, $Package, [string]$ExpectedApp, [string]$ExpectedHome, [string]$ExpectedRuntime, [string]$ExpectedBackup, [string]$ExpectedMaintenance, [string]$ExpectedNode, [string]$ExpectedPython, [string]$ExpectedPythonw) {
  try {
    if (-not (Test-Path -LiteralPath $ActivePath -PathType Leaf) -or -not (Test-Path -LiteralPath $LauncherPath -PathType Leaf) -or -not (Test-Path -LiteralPath $ReceiptPath -PathType Leaf)) { return $false }
    $active = Read-Json $ActivePath "active.json"
    if ($active.schema -ne 1 -or [string]$active.featureVersion -ne "0.2.0") { return $false }
    if (-not (Same ([string]$active.packageRoot) $StablePackageRoot) -or [string]$active.packageManifestSha256 -ne [string]$Package.manifestSha256) { return $false }
    foreach ($pair in @(
      @([string]$active.app, $ExpectedApp), @([string]$active.home, $ExpectedHome), @([string]$active.runtime, $ExpectedRuntime),
      @([string]$active.backupRoot, $ExpectedBackup), @([string]$active.maintenanceRoot, $ExpectedMaintenance), @([string]$active.node, $ExpectedNode),
      @([string]$active.python, $ExpectedPython), @([string]$active.pythonw, $ExpectedPythonw), @([string]$active.launcherPath, $LauncherPath), @([string]$active.shortcutReceipt, $ReceiptPath)
    )) { if (-not (Same $pair[0] $pair[1])) { return $false } }
    if ([string]::IsNullOrWhiteSpace([string]$active.transactionPath)) { return $false }
    $transaction = Full ([string]$active.transactionPath); $manifestPath = Join-Path $transaction "maintenance-transaction.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $false }
    $manifest = Read-Json $manifestPath "maintenance transaction"
    if ($manifest.schema -ne 1 -or [string]$manifest.featureVersion -ne "0.2.0" -or [string]$manifest.state -ne "applied" -or [string]$manifest.packageManifestSha256 -ne [string]$Package.manifestSha256) { return $false }
    $deployed = @($manifest.deployed); if ($deployed.Count -eq 0) { return $false }
    foreach ($item in $deployed) {
      $path = Full ([string]$item.path)
      if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Sha256 $path) -ne [string]$item.sha256) { return $false }
    }
    $receipt = Read-Json $ReceiptPath "shortcut receipt"; $entries = @($receipt.entries); if ($receipt.schema -ne 1 -or $entries.Count -eq 0) { return $false }
    foreach ($entry in $entries) {
      $path = Full ([string]$entry.path)
      if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or [string]::IsNullOrWhiteSpace([string]$entry.deployedFileSha256) -or (Sha256 $path) -ne [string]$entry.deployedFileSha256) { return $false }
    }
    return $true
  } catch { return $false }
}

$PackageRoot = Full $PackageRoot; $AppPath = Full $AppPath; $VoiceHome = Full $VoiceHome; $RuntimePath = Full $RuntimePath
$BackupRoot = Full $BackupRoot; $MaintenanceRoot = Full $MaintenanceRoot; $NodePath = Full $NodePath; $PythonPath = Full $PythonPath
if (-not $FixtureRoot) {
  $nativeMaintenance = Join-Path $env:USERPROFILE '.config\opencode\voice-maintenance'
  if (-not (Same $MaintenanceRoot $nativeMaintenance)) { Fail 'native updater requires the per-user voice-maintenance directory' }
  if (-not (Same $BackupRoot (Join-Path $MaintenanceRoot 'backups\0.2.0'))) { Fail 'native recovery requires voice-maintenance/backups/0.2.0' }
}
if ($CandidateAsar -and -not $DryRun) { Fail "CandidateAsar is allowed only with -DryRun" }
if ($CandidateAsar) { $CandidateAsar = Full $CandidateAsar; Require-File $CandidateAsar "CandidateAsar" }
Require-Dir $PackageRoot "PackageRoot"; Require-Dir $AppPath "AppPath"; Require-Dir $VoiceHome "VoiceHome"; Require-Dir $RuntimePath "RuntimePath"
Require-File $NodePath "NodePath"; Require-File $PythonPath "PythonPath"
$PythonwPath = Join-Path (Split-Path -Parent $PythonPath) "pythonw.exe"
Require-File $PythonwPath "matching pythonw.exe"
if ($FixtureRoot) {
  $FixtureRoot = Full $FixtureRoot; Require-Dir $FixtureRoot "FixtureRoot"
  # Fixture mode fences every user-facing target and link root.  The package
  # source and interpreter may intentionally live outside the fixture because
  # they model an immutable downloaded package and an installed runtime.
  foreach ($path in @($AppPath, $VoiceHome, $RuntimePath, $BackupRoot, $MaintenanceRoot)) { if (-not (Under $FixtureRoot $path)) { Fail "FixtureRoot does not contain $path" } }
}
if ((Same $AppPath $MaintenanceRoot) -or (Under $AppPath $MaintenanceRoot)) { Fail "MaintenanceRoot must be outside AppPath" }
Require-File (Join-Path $AppPath "OpenCode.exe") "OpenCode.exe"
$AsarPath = Find-Asar $AppPath
$HookAsar = if ($CandidateAsar) { $CandidateAsar } else { $AsarPath }
$hookInspector = Join-Path $PackageRoot "shared\maintenance-inspect.cjs"
Require-File $hookInspector "maintenance-inspect.cjs"
$hookLines = @(& $NodePath $hookInspector --asar $HookAsar --source $PackageRoot 2>&1 | ForEach-Object { [string]$_ })
if ($LASTEXITCODE -ne 0) { Fail "target app.asar does not contain a verified 0.2.0 update bridge hook: $($hookLines -join ' ')" }
$running = @(Get-Process -Name OpenCode -ErrorAction SilentlyContinue)
if (-not $FixtureRoot -and -not $DryRun -and $running.Count -gt 0) { Fail "OpenCode is still running; close it before activating maintenance" }

if ($DryRun) {
  $package = Invoke-PackageVerify $PackageRoot $NodePath
  if ([string]$package.featureVersion -and [string]$package.featureVersion -ne "0.2.0") { Fail "maintenance package featureVersion is unsupported" }
  [ordered]@{ state = "dry-run"; app = $AppPath; candidateAsar = $HookAsar; hook = $hookLines[-1]; package = $package; writes = @() } | ConvertTo-Json -Depth 16
  exit 0
}

$package = Invoke-PackageCache $PackageRoot $MaintenanceRoot $NodePath
if ([string]$package.featureVersion -ne "0.2.0") { Fail "stable package featureVersion is unsupported" }
$stablePackageRoot = Full ([string]$package.packageRoot)
Require-Dir $stablePackageRoot "stable package cache"
$launcherSource = Join-Path $stablePackageRoot "shared\update-launcher.pyw"
Require-File $launcherSource "stable update-launcher.pyw"
$activePath = Join-Path $MaintenanceRoot "active.json"
$launcherPath = Join-Path $MaintenanceRoot "Launch-Voice.pyw"
$receiptPath = Join-Path $MaintenanceRoot "shortcut-receipt.json"
if (Test-ExistingDeployment $activePath $launcherPath $receiptPath $stablePackageRoot $package $AppPath $VoiceHome $RuntimePath $BackupRoot $MaintenanceRoot $NodePath $PythonPath $PythonwPath) {
  [ordered]@{ state = "applied"; reused = $true; transaction = (Read-Json $activePath "active.json").transactionPath; active = $activePath; shortcutReceipt = $receiptPath; packageRoot = $stablePackageRoot; packageManifestSha256 = [string]$package.manifestSha256 } | ConvertTo-Json -Depth 12
  exit 0
}
$transaction = Join-Path $MaintenanceRoot ("transactions\0.2.0-" + [guid]::NewGuid().ToString("N"))
$beforeRoot = Join-Path $transaction "before"
New-Item -ItemType Directory -Path $beforeRoot -Force | Out-Null
$targets = @(
  (Backup-File $activePath "active.json" $beforeRoot),
  (Backup-File $launcherPath "Launch-Voice.pyw" $beforeRoot),
  (Backup-File (Join-Path $MaintenanceRoot "update-recovery.cjs") "update-recovery.cjs" $beforeRoot),
  (Backup-File (Join-Path $MaintenanceRoot "update-notify.pyw") "update-notify.pyw" $beforeRoot),
  (Backup-File $receiptPath "shortcut-receipt.json" $beforeRoot),
  (Backup-File (Join-Path $MaintenanceRoot "Repair-Voice.cmd") "Repair-Voice.cmd" $beforeRoot),
  (Backup-File (Join-Path $MaintenanceRoot "Repair-Voice.ps1") "Repair-Voice.ps1" $beforeRoot),
  (Backup-File (Join-Path $MaintenanceRoot "Restore-Voice.cmd") "Restore-Voice.cmd" $beforeRoot),
  (Backup-File (Join-Path $MaintenanceRoot "Restore-Voice.ps1") "Restore-Voice.ps1" $beforeRoot),
  (Backup-File (Join-Path $MaintenanceRoot "maintenance-README.txt") "maintenance-README.txt" $beforeRoot),
  (Backup-File (Join-Path $MaintenanceRoot "README.md") "README.md" $beforeRoot),
  (Backup-File (Join-Path $MaintenanceRoot "README.txt") "README.txt" $beforeRoot)
)
$transactionReceipt = [ordered]@{
  schema = 1; featureVersion = "0.2.0"; state = "prepared"; createdAt = [DateTime]::UtcNow.ToString("o")
  transaction = $transaction; activePath = $activePath; launcherPath = $launcherPath; receiptPath = $receiptPath
  packageRoot = $stablePackageRoot; packageManifestSha256 = [string]$package.manifestSha256; appPath = $AppPath
  before = @($targets); deployed = @()
}
$receiptFile = Join-Path $transaction "maintenance-transaction.json"
Write-JsonAtomic $receiptFile $transactionReceipt

try {
  $active = [ordered]@{
    schema = 1; featureVersion = "0.2.0"; packageRoot = $stablePackageRoot; packageManifestSha256 = [string]$package.manifestSha256
    node = $NodePath; python = $PythonPath; pythonw = $PythonwPath; app = $AppPath; home = $VoiceHome; runtime = $RuntimePath
    backupRoot = $BackupRoot; maintenanceRoot = $MaintenanceRoot; shortcutReceipt = $receiptPath; launcherPath = $launcherPath; transactionPath = $transaction
  }
  New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $VoiceHome -Force | Out-Null
  New-Item -ItemType Directory -Path $RuntimePath -Force | Out-Null
  Copy-Item -LiteralPath $launcherSource -Destination $launcherPath -Force
  foreach ($name in @("Repair-Voice.cmd", "Repair-Voice.ps1", "Restore-Voice.cmd", "Restore-Voice.ps1")) {
    $source = Join-Path $stablePackageRoot ("windows\" + $name)
    if (Test-Path -LiteralPath $source -PathType Leaf) { Copy-Item -LiteralPath $source -Destination (Join-Path $MaintenanceRoot $name) -Force }
  }
  $maintenanceReadme = Join-Path $stablePackageRoot "windows\maintenance-README.txt"
  Require-File $maintenanceReadme "maintenance-README.txt"
  Copy-Item -LiteralPath $maintenanceReadme -Destination (Join-Path $MaintenanceRoot "maintenance-README.txt") -Force
  Copy-Item -LiteralPath $maintenanceReadme -Destination (Join-Path $MaintenanceRoot "README.md") -Force
  Copy-Item -LiteralPath $maintenanceReadme -Destination (Join-Path $MaintenanceRoot "README.txt") -Force
  Write-JsonAtomic $activePath $active
  Invoke-ShortcutScript "Install" $activePath $receiptPath $transaction $FixtureRoot | Out-Null
  Require-File $activePath "deployed active.json"; Require-File $launcherPath "deployed launcher"; Require-File $receiptPath "deployed shortcut receipt"
  $transactionReceipt.state = "applied"; $transactionReceipt.appliedAt = [DateTime]::UtcNow.ToString("o")
  $deployed = @(
    [ordered]@{ path = $activePath; sha256 = Sha256 $activePath },
    [ordered]@{ path = $launcherPath; sha256 = Sha256 $launcherPath },
    [ordered]@{ path = $receiptPath; sha256 = Sha256 $receiptPath }
  )
  foreach ($name in @("Repair-Voice.cmd", "Repair-Voice.ps1", "Restore-Voice.cmd", "Restore-Voice.ps1", "maintenance-README.txt", "README.md", "README.txt")) {
    $path = Join-Path $MaintenanceRoot $name
    if (Test-Path -LiteralPath $path -PathType Leaf) { $deployed += [ordered]@{ path = $path; sha256 = Sha256 $path } }
  }
  $transactionReceipt.deployed = $deployed
  Write-JsonAtomic $receiptFile $transactionReceipt
  [ordered]@{ state = "applied"; transaction = $transaction; active = $activePath; shortcutReceipt = $receiptPath; packageRoot = $stablePackageRoot; packageManifestSha256 = [string]$package.manifestSha256 } | ConvertTo-Json -Depth 12
} catch {
  $failure = $_.Exception.Message
  $rollbackErrors = New-Object System.Collections.Generic.List[string]
  # Roll back only the files this invocation owns.  Shortcut restoration uses
  # the current receipt and therefore checks deployed values before restoring.
  $receiptPresent = Test-Path -LiteralPath $receiptPath -PathType Leaf
  $activePresent = Test-Path -LiteralPath $activePath -PathType Leaf
  if ($receiptPresent -and $activePresent) {
    try {
      $restore = Join-Path $PackageRoot "windows\maintenance-shortcuts.ps1"
      $restoreArgs = @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $restore, "-Mode", "Restore", "-ConfigPath", $activePath, "-ReceiptPath", $receiptPath)
      if ($FixtureRoot) { $restoreArgs += @("-FixtureRoot", $FixtureRoot) }
      $restoreLines = @(& powershell.exe @restoreArgs 2>&1 | ForEach-Object { [string]$_ })
      if ($LASTEXITCODE -ne 0) { throw "shortcut restore exited ${LASTEXITCODE}: $($restoreLines -join ' ')" }
    } catch { [void]$rollbackErrors.Add("shortcuts: $($_.Exception.Message)") }
  } elseif ($receiptPresent) {
    [void]$rollbackErrors.Add("shortcuts: shortcut-receipt.json was present but active.json was unavailable for rollback")
  }
  for ($index = $targets.Count - 1; $index -ge 0; $index--) {
    try { Restore-File $targets[$index] } catch { [void]$rollbackErrors.Add("$($targets[$index].path): $($_.Exception.Message)") }
  }
  if ($rollbackErrors.Count -eq 0) {
    $transactionReceipt.state = "rolled-back"
  } else {
    $transactionReceipt.state = "rollback-failed"
    $transactionReceipt.rollbackErrors = @($rollbackErrors.ToArray())
  }
  $transactionReceipt.error = $failure; $transactionReceipt.rolledBackAt = [DateTime]::UtcNow.ToString("o")
  try { Write-JsonAtomic $receiptFile $transactionReceipt } catch { [void]$rollbackErrors.Add("transaction receipt: $($_.Exception.Message)") }
  if ($rollbackErrors.Count -gt 0) { Fail "$failure; rollback failed: $($rollbackErrors -join '; ')" }
  Fail $failure
}
