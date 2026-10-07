[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Install", "Rebind", "Restore")]
  [string]$Mode,
  [Parameter(Mandatory = $true)]
  [string]$ConfigPath,
  [string]$ReceiptPath,
  [string]$TransactionPath,
  [string]$FixtureRoot,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Fail([string]$Message) { throw "maintenance shortcuts: $Message" }
function Full([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { Fail "path is empty" }
  return [IO.Path]::GetFullPath($Value)
}
function Same-Path([string]$Left, [string]$Right) {
  $leftFull = [regex]::Replace(([IO.Path]::GetFullPath($Left)), '\\+$', '')
  $rightFull = [regex]::Replace(([IO.Path]::GetFullPath($Right)), '\\+$', '')
  return $leftFull.Equals($rightFull, [StringComparison]::OrdinalIgnoreCase)
}
function Under([string]$Root, [string]$Value) {
  $rootFull = ([regex]::Replace((Full $Root), '\\+$', '')) + '\'
  $valueFull = Full $Value
  return $valueFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase) -or (Same-Path $Root $Value)
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
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $tmp = "$Path.tmp-$PID-$([guid]::NewGuid().ToString('N'))"
  $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}
function Read-Json([string]$Path, [string]$Label) {
  Require-File $Path $Label
  try { return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json) }
  catch { Fail "$Label is invalid: $($_.Exception.Message)" }
}
function Quote-Argument([string]$Value) {
  # WSH stores one command-line string.  Preserve the original suffix and
  # quote paths without using a shell or a second parser.
  if ($null -eq $Value) { return '""' }
  $escaped = $Value -replace '(\\*)"', '$1$1\"'
  $escaped = $escaped -replace '(\\+)$', '$1$1'
  return '"' + $escaped + '"'
}
function New-Shell() { return New-Object -ComObject WScript.Shell }
function Release-Com($Object) {
  if ($null -ne $Object) { try { [Runtime.InteropServices.Marshal]::ReleaseComObject($Object) | Out-Null } catch {} }
}
function Get-LinkData([object]$Shell, [string]$Path) {
  $link = $null
  try {
    $link = $Shell.CreateShortcut($Path)
    return [ordered]@{
      TargetPath = [string]$link.TargetPath
      Arguments = [string]$link.Arguments
      IconLocation = [string]$link.IconLocation
      Description = [string]$link.Description
      WorkingDirectory = [string]$link.WorkingDirectory
    }
  } finally { Release-Com $link }
}
function Save-Link([object]$Shell, [string]$Path, [string]$Target, [string]$Arguments, [string]$Icon, [string]$Description, [string]$WorkingDirectory) {
  $link = $null
  try {
    $link = $Shell.CreateShortcut($Path)
    $link.TargetPath = $Target
    $link.Arguments = $Arguments
    $link.IconLocation = $Icon
    $link.Description = $Description
    $link.WorkingDirectory = $WorkingDirectory
    $link.Save()
  } finally { Release-Com $link }
}
function Link-Roots([string]$Fixture) {
  if ($Fixture) {
    $fixture = Full $Fixture
    if (-not (Test-Path -LiteralPath $fixture -PathType Container)) { Fail "fixture root is missing" }
    return @(
      (Join-Path $fixture "Desktop"),
      (Join-Path $fixture "AppData\Microsoft\Windows\Start Menu\Programs"),
      (Join-Path $fixture "AppData\Microsoft\Internet Explorer\Quick Launch"),
      (Join-Path $fixture "AppData\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar")
    )
  }
  $desktop = [Environment]::GetFolderPath("Desktop")
  $appData = $env:APPDATA
  if ([string]::IsNullOrWhiteSpace($desktop) -or [string]::IsNullOrWhiteSpace($appData)) { Fail "user shortcut roots are unavailable" }
  return @(
    $desktop,
    (Join-Path $appData "Microsoft\Windows\Start Menu\Programs"),
    (Join-Path $appData "Microsoft\Internet Explorer\Quick Launch"),
    (Join-Path $appData "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar")
  )
}
function Validate-Fixture([string]$Fixture, [string]$Config, $Active) {
  if (-not $Fixture) { return }
  $fixture = Full $Fixture
  foreach ($path in @($Config, [string]$Active.app, [string]$Active.maintenanceRoot, [string]$Active.shortcutReceipt)) {
    if (-not (Under $fixture $path)) { Fail "fixture mode path escaped FixtureRoot: $path" }
  }
}
function Link-Files([string[]]$Roots) {
  $files = New-Object System.Collections.Generic.List[string]
  foreach ($root in $Roots) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
    foreach ($item in @(Get-ChildItem -LiteralPath $root -Recurse -File -Filter *.lnk -Force -ErrorAction Stop)) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
      [void]$files.Add($item.FullName)
    }
  }
  return $files.ToArray()
}
function Is-Same([string]$Left, [string]$Right) {
  return ([string]$Left).Equals([string]$Right, [StringComparison]::OrdinalIgnoreCase)
}
function Stable-Arguments([string]$Arguments, [string]$Launcher, [string]$Config) {
  return $Arguments.IndexOf((Split-Path -Leaf $Launcher), [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $Arguments.IndexOf((Split-Path -Leaf $Config), [StringComparison]::OrdinalIgnoreCase) -ge 0
}
function Read-Receipt([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return [ordered]@{ schema = 1; entries = @() } }
  $value = Read-Json $Path "shortcut receipt"
  if ($value.schema -ne 1) { Fail "shortcut receipt schema is unsupported" }
  if ($null -eq $value.entries) { $value | Add-Member -NotePropertyName entries -NotePropertyValue @() }
  return $value
}
function Find-ReceiptEntry($Receipt, [string]$Path) {
  foreach ($entry in @($Receipt.entries)) { if (Is-Same ([string]$entry.path) $Path) { return $entry } }
  return $null
}
function Backup-Link([string]$Path, $Entry, [string]$BackupRoot, $Data) {
  $hash = Sha256 $Path
  if ($Entry -and [string]$Entry.beforeSha256 -and [string]$Entry.deployedFileSha256 -eq $hash -and [string]$Entry.backupPath) {
    return [ordered]@{ backupPath = [string]$Entry.backupPath; beforeSha256 = [string]$Entry.beforeSha256; beforeExists = $true }
  }
  $directory = Join-Path $BackupRoot ([guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $saved = Join-Path $directory (([IO.Path]::GetFileName($Path)) + ".before.lnk")
  Copy-Item -LiteralPath $Path -Destination $saved -Force
  return [ordered]@{ backupPath = $saved; beforeSha256 = $hash; beforeExists = $true }
}
function Restore-OriginalBytes([string]$Path, [bool]$Existed, [byte[]]$Bytes) {
  $pathFull = Full $Path
  if ($Existed) {
    if ($null -eq $Bytes) { Fail "missing rollback bytes: $pathFull" }
    Require-WriteTarget $pathFull "rollback target"
    if (Test-Path -LiteralPath $pathFull -PathType Container) { Fail "rollback target became a directory: $pathFull" }
    $parent = Split-Path -Parent $pathFull
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [IO.File]::WriteAllBytes($pathFull, $Bytes)
  } elseif (Test-Path -LiteralPath $pathFull) {
    Require-WriteTarget $pathFull "rollback target"
    if (-not (Test-Path -LiteralPath $pathFull -PathType Leaf)) { Fail "rollback target is not a file: $pathFull" }
    Remove-Item -LiteralPath $pathFull -Force
  }
}
function Restore-LinkUndo($Undo, [string[]]$AllowedRoots) {
  $path = Full ([string]$Undo.path)
  $allowed = $false
  foreach ($root in $AllowedRoots) { if (Under $root $path) { $allowed = $true; break } }
  if (-not $allowed) { Fail "rollback shortcut escaped a user link root: $path" }
  if ($Undo.beforeExists -eq $true) {
    Require-File ([string]$Undo.backupPath) "shortcut rollback backup"
    if ((Sha256 ([string]$Undo.backupPath)) -ne [string]$Undo.beforeSha256) { Fail "shortcut rollback backup hash mismatch: $path" }
    if (Test-Path -LiteralPath $path -PathType Container) { Fail "shortcut rollback target became a directory: $path" }
    Copy-Item -LiteralPath ([string]$Undo.backupPath) -Destination $path -Force
    if ((Sha256 $path) -ne [string]$Undo.beforeSha256) { Fail "shortcut rollback readback mismatch: $path" }
  } elseif (Test-Path -LiteralPath $path) {
    Require-WriteTarget $path "shortcut rollback target"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Fail "shortcut rollback target is not a file: $path" }
    Remove-Item -LiteralPath $path -Force
  }
}
function Restore-ReceiptLinks([string]$Path, [string]$Fixture, [switch]$WhatIf) {
  $receipt = Read-Json $Path "shortcut receipt"
  if ($receipt.schema -ne 1) { Fail "shortcut receipt schema is unsupported" }
  $shell = New-Shell
  try {
    foreach ($entry in @($receipt.entries)) {
      $linkPath = Full ([string]$entry.path)
      if ($Fixture -and -not (Under $Fixture $linkPath)) { Fail "receipt link escaped FixtureRoot: $linkPath" }
      if (-not (Test-Path -LiteralPath $linkPath -PathType Leaf)) {
        if ($entry.beforeExists -eq $true) { Fail "deployed shortcut is missing: $linkPath" }
        continue
      }
      $data = Get-LinkData $shell $linkPath
      $currentHash = Sha256 $linkPath
      if (-not (Is-Same ([string]$data.TargetPath) ([string]$entry.deployedTargetPath)) -or
          [string]$data.Arguments -cne [string]$entry.deployedArguments -or
          [string]$data.IconLocation -cne [string]$entry.deployedIconLocation -or
          ([string]$entry.deployedFileSha256 -and $currentHash -ne [string]$entry.deployedFileSha256)) {
        Fail "shortcut was changed after deployment: $linkPath"
      }
      if ($WhatIf) { continue }
      if ($entry.beforeExists -eq $true) {
        Require-File ([string]$entry.backupPath) "shortcut backup"
        if ((Sha256 ([string]$entry.backupPath)) -ne [string]$entry.beforeSha256) { Fail "shortcut backup hash mismatch: $linkPath" }
        Require-WriteTarget $linkPath "shortcut restore target"
        Copy-Item -LiteralPath ([string]$entry.backupPath) -Destination $linkPath -Force
      } else {
        Require-WriteTarget $linkPath "shortcut restore target"
        Remove-Item -LiteralPath $linkPath -Force
      }
    }
  } finally { Release-Com $shell }
  return $receipt
}
function Update-TransactionReceipt($Active, [string]$ReceiptFile) {
  if (-not $Active.transactionPath) { return }
  $transaction = Full ([string]$Active.transactionPath)
  $manifestPath = Join-Path $transaction "maintenance-transaction.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return }
  $manifest = Read-Json $manifestPath "maintenance transaction"
  if ($manifest.schema -ne 1 -or [string]$manifest.state -ne "applied") { return }
  $updated = $false
  foreach ($deployed in @($manifest.deployed)) {
    if (Same-Path ([string]$deployed.path) $ReceiptFile) { $deployed.sha256 = Sha256 $ReceiptFile; $updated = $true }
  }
  if ($updated) {
    if (-not $manifest.rebinds) { $manifest | Add-Member -NotePropertyName rebinds -NotePropertyValue @() }
    $manifest.rebinds = @($manifest.rebinds) + @([ordered]@{ at = [DateTime]::UtcNow.ToString("o"); receiptSha256 = Sha256 $ReceiptFile })
    Write-JsonAtomic $manifestPath $manifest
  }
}

$ConfigPath = Full $ConfigPath
$active = Read-Json $ConfigPath "active.json"
if ($active.schema -ne 1 -or $active.featureVersion -ne "0.2.0") { Fail "active.json schema or featureVersion is unsupported" }
Validate-Fixture $FixtureRoot $ConfigPath $active
$app = Full ([string]$active.app)
$maintenance = Full ([string]$active.maintenanceRoot)
$receiptFile = if ($ReceiptPath) { Full $ReceiptPath } else { Full ([string]$active.shortcutReceipt) }
$launcher = if ($active.launcherPath) { Full ([string]$active.launcherPath) } else { Join-Path $maintenance "Launch-Voice.pyw" }
$pythonw = Full ([string]$active.pythonw)
$appExe = Join-Path $app "OpenCode.exe"
Require-File $pythonw "pythonw.exe"
Require-File $appExe "OpenCode.exe"
Require-File $launcher "stable launcher"

if ($Mode -eq "Restore") {
  $restored = Restore-ReceiptLinks $receiptFile $FixtureRoot -WhatIf:$DryRun
  if (-not $DryRun) { Write-JsonAtomic $receiptFile ([ordered]@{ schema = 1; restoredAt = [DateTime]::UtcNow.ToString("o"); entries = @($restored.entries) }) }
  [ordered]@{ state = if ($DryRun) { "dry-run" } else { "restored" }; receipt = $receiptFile } | ConvertTo-Json -Depth 8
  exit 0
}

$roots = Link-Roots $FixtureRoot
$shell = New-Shell
$receipt = Read-Receipt $receiptFile
$receiptPathExists = Test-Path -LiteralPath $receiptFile
if ($receiptPathExists -and -not (Test-Path -LiteralPath $receiptFile -PathType Leaf)) { Fail "shortcut receipt path is not a file: $receiptFile" }
$receiptExisted = Test-Path -LiteralPath $receiptFile -PathType Leaf
$receiptBeforeBytes = if ($receiptExisted) { [IO.File]::ReadAllBytes($receiptFile) } else { $null }
$transactionManifestPath = $null
$transactionExisted = $false
$transactionBeforeBytes = $null
if ($Mode -eq "Rebind" -and $active.transactionPath) {
  $transactionManifestPath = Join-Path (Full ([string]$active.transactionPath)) "maintenance-transaction.json"
  $transactionExisted = Test-Path -LiteralPath $transactionManifestPath -PathType Leaf
  if ($transactionExisted) { $transactionBeforeBytes = [IO.File]::ReadAllBytes($transactionManifestPath) }
}
$entries = New-Object System.Collections.Generic.List[object]
foreach ($entry in @($receipt.entries)) { [void]$entries.Add($entry) }
$candidates = New-Object System.Collections.Generic.List[string]
$targetLinks = 0
$undoLinks = New-Object System.Collections.Generic.List[object]
try {
  foreach ($linkPath in Link-Files $roots) {
    $data = Get-LinkData $shell $linkPath
    $isTarget = Is-Same ([string]$data.TargetPath) $appExe
    $isStable = (Is-Same ([string]$data.TargetPath) $pythonw) -and (Stable-Arguments ([string]$data.Arguments) $launcher $ConfigPath)
    if ($isTarget -or $isStable) { [void]$candidates.Add($linkPath); if ($isTarget) { $targetLinks++ } }
  }
  if ($candidates.Count -eq 0 -and $Mode -eq "Install") {
    # A clean user profile may have no OpenCode link.  Create one only in the
    # user's Start Menu and only if the exact name is unused.
    $menu = $roots[1]
    if (-not (Test-Path -LiteralPath $menu -PathType Container)) { New-Item -ItemType Directory -Path $menu -Force | Out-Null }
    $newLink = Join-Path $menu "OpenCode.lnk"
    if (-not (Test-Path -LiteralPath $newLink -PathType Leaf)) { [void]$candidates.Add($newLink) }
  }
  if ($candidates.Count -eq 0) { Fail "no OpenCode shortcut was found and the safe Start Menu name is occupied" }
  if ((-not (Test-Path -LiteralPath (Join-Path $maintenance "shortcut-backups") -PathType Container)) -and (-not $DryRun)) { New-Item -ItemType Directory -Path (Join-Path $maintenance "shortcut-backups") -Force | Out-Null }
  $backupBase = if ($TransactionPath) { Join-Path (Full $TransactionPath) "shortcuts" } else { Join-Path $maintenance "shortcut-backups" }
  if (-not $DryRun) { New-Item -ItemType Directory -Path $backupBase -Force | Out-Null }
  foreach ($linkPath in $candidates) {
    $linkPath = Full $linkPath
    $existed = Test-Path -LiteralPath $linkPath -PathType Leaf
    $before = $null
    $data = [ordered]@{ TargetPath = ""; Arguments = ""; IconLocation = ""; Description = ""; WorkingDirectory = "" }
    if ($existed) { $data = Get-LinkData $shell $linkPath; $before = Find-ReceiptEntry $receipt $linkPath }
    $originalArguments = [string]$data.Arguments
    $isStable = ($existed) -and (Is-Same ([string]$data.TargetPath) $pythonw) -and (Stable-Arguments $originalArguments $launcher $ConfigPath)
    if ($isStable) {
      # Rebind may see a link saved by a prior maintenance package.  Take the
      # final separator so stale wrappers collapse to one stable prefix.
      $separator = $originalArguments.LastIndexOf(" -- ", [StringComparison]::Ordinal)
      if ($separator -ge 0) { $originalArguments = $originalArguments.Substring($separator + 4) }
    }
    $desiredArgs = (Quote-Argument $launcher) + " --config " + (Quote-Argument $ConfigPath) + " -- " + $originalArguments.Trim()
    $desiredIcon = $appExe + ",0"
    $already = ($existed) -and (Is-Same ([string]$data.TargetPath) $pythonw) -and ([string]$data.Arguments -ceq $desiredArgs) -and ([string]$data.IconLocation -ceq $desiredIcon)
    $backup = $null
    $needsSave = -not $already
    $needsBackup = $existed -and (-not $already -or $null -eq $before)
    if ($needsBackup -and -not $DryRun) {
      $backup = Backup-Link $linkPath $before $backupBase $data
      if ($needsSave) { [void]$undoLinks.Add([ordered]@{ path = $linkPath; beforeExists = $true; backupPath = $backup.backupPath; beforeSha256 = $backup.beforeSha256 }) }
    }
    if (-not $existed -and -not $DryRun) {
      $backup = [ordered]@{ backupPath = $null; beforeSha256 = $null; beforeExists = $false }
      [void]$undoLinks.Add([ordered]@{ path = $linkPath; beforeExists = $false; backupPath = $null; beforeSha256 = $null })
    }
    $newEntry = [ordered]@{
      path = $linkPath
      beforeExists = if ($existed) { $true } else { $false }
      backupPath = if ($backup) { $backup.backupPath } elseif ($before) { [string]$before.backupPath } else { $null }
      beforeSha256 = if ($backup) { $backup.beforeSha256 } elseif ($before) { [string]$before.beforeSha256 } else { $null }
      deployedTargetPath = $pythonw
      deployedArguments = $desiredArgs
      deployedIconLocation = $desiredIcon
      deployedFileSha256 = $null
      createdByMaintenance = (-not $existed)
      updatedAt = [DateTime]::UtcNow.ToString("o")
    }
    if (-not $DryRun -and $needsSave) {
      # Publish a recoverable pending entry before Save().  If COM changes the
      # link and then reports an error, this entry still identifies the exact
      # byte backup needed for the local undo and for install-maintenance.
      $pendingBase = @($entries.ToArray() | Where-Object { -not (Is-Same ([string]$_.path) $linkPath) })
      $pendingEntries = @($pendingBase) + @($newEntry)
      Write-JsonAtomic $receiptFile ([ordered]@{ schema = 1; mode = $Mode; state = "pending"; configPath = $ConfigPath; appPath = $app; launcherPath = $launcher; generatedAt = [DateTime]::UtcNow.ToString("o"); entries = $pendingEntries })
    }
    if (-not $DryRun -and $needsSave) {
      Save-Link $shell $linkPath $pythonw $desiredArgs $desiredIcon ([string]$data.Description) ([string]$data.WorkingDirectory)
      $after = Get-LinkData $shell $linkPath
      if (-not (Is-Same $after.TargetPath $pythonw) -or [string]$after.Arguments -cne $desiredArgs -or [string]$after.IconLocation -cne $desiredIcon) { Fail "shortcut readback mismatch: $linkPath" }
    }
    if (-not $DryRun) { $deployedHash = Sha256 $linkPath } else { $deployedHash = $null }
    $newEntry.deployedFileSha256 = $deployedHash
    for ($i = 0; $i -lt $entries.Count; $i++) { if (Is-Same ([string]$entries[$i].path) $linkPath) { $entries.RemoveAt($i); break } }
    [void]$entries.Add($newEntry)
  }
  $newReceipt = [ordered]@{ schema = 1; mode = $Mode; configPath = $ConfigPath; appPath = $app; launcherPath = $launcher; generatedAt = [DateTime]::UtcNow.ToString("o"); entries = $entries.ToArray() }
  if (-not $DryRun) { Write-JsonAtomic $receiptFile $newReceipt }
  if (-not $DryRun -and $Mode -eq "Rebind") { Update-TransactionReceipt $active $receiptFile }
  [ordered]@{ state = if ($DryRun) { "dry-run" } else { "applied" }; mode = $Mode; receipt = $receiptFile; entries = $newReceipt.entries } | ConvertTo-Json -Depth 12
} catch {
  $failure = $_.Exception.Message
  $rollbackErrors = New-Object System.Collections.Generic.List[string]
  if (-not $DryRun) {
    for ($index = $undoLinks.Count - 1; $index -ge 0; $index--) {
      try { Restore-LinkUndo $undoLinks[$index] $roots } catch { [void]$rollbackErrors.Add("$($undoLinks[$index].path): $($_.Exception.Message)") }
    }
    try { Restore-OriginalBytes $receiptFile $receiptExisted $receiptBeforeBytes } catch { [void]$rollbackErrors.Add("receipt: $($_.Exception.Message)") }
    if ($transactionManifestPath) {
      try { Restore-OriginalBytes $transactionManifestPath $transactionExisted $transactionBeforeBytes } catch { [void]$rollbackErrors.Add("transaction: $($_.Exception.Message)") }
    }
  }
  if ($rollbackErrors.Count -gt 0) { throw "maintenance shortcuts: $failure; rollback failed: $($rollbackErrors -join '; ')" }
  throw
} finally { Release-Com $shell }
