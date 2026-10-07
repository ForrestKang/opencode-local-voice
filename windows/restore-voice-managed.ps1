param([Parameter(Mandatory = $true)][string]$ConfigPath, [switch]$DryRun)
$ErrorActionPreference = "Stop"

function Fail([string]$Message) { throw $Message }
function Full([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { Fail "path is empty" }
  return [IO.Path]::GetFullPath($Value)
}
function Same([string]$Left, [string]$Right) {
  return (Full $Left).TrimEnd('\').Equals((Full $Right).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
}
function Under([string]$Root, [string]$Value) {
  $rootFull = (Full $Root).TrimEnd('\') + '\'; $valueFull = Full $Value
  return $valueFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase) -or (Same $Root $Value)
}
function Read-Json([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Fail "$Label is missing: $Path" }
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "$Label must not be a reparse point: $Path" }
  try { return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json) }
  catch { Fail "$Label is invalid: $($_.Exception.Message)" }
}
function Find-ManagedArchive([string]$App) {
  $supported = Full (Join-Path $App 'resources\app.asar')
  if (Test-Path -LiteralPath $supported -PathType Leaf) { return $supported }
  $alternate = @((Join-Path $App 'app.asar'), (Join-Path $App 'Contents\Resources\app.asar')) |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
  if ($alternate.Count -gt 0) { Fail 'Only AppPath\resources\app.asar is supported by the Windows maintenance workflow; found an unsupported app.asar layout.' }
  Fail "app.asar was not found under AppPath: $App"
}
function FeatureTargetMatches($Manifest, $Active, [string]$Archive) {
  try {
    foreach ($pair in @(
      @([string]$Manifest.app, [string]$Active.app),
      @([string]$Manifest.input, $Archive),
      @([string]$Manifest.home, [string]$Active.home),
      @([string]$Manifest.runtime, [string]$Active.runtime)
    )) { if (-not (Same $pair[0] $pair[1])) { return $false } }
    return $true
  } catch { return $false }
}
function Require-FeatureTarget($Manifest, $Active, [string]$Archive) {
  foreach ($pair in @(
    @([string]$Manifest.app, [string]$Active.app),
    @([string]$Manifest.input, $Archive),
    @([string]$Manifest.home, [string]$Active.home),
    @([string]$Manifest.runtime, [string]$Active.runtime)
  )) { if (-not (Same $pair[0] $pair[1])) { Fail 'feature backup target paths do not match active.json' } }
}
function Require-MaintenanceMatch($Manifest, $Active, [string]$Transaction) {
  if ($Manifest.schema -ne 1 -or [string]$Manifest.featureVersion -ne '0.2.0') { Fail 'maintenance transaction schema is unsupported' }
  if (@('applied', 'restore-failed') -notcontains [string]$Manifest.state) { Fail 'maintenance transaction is not active or retryable' }
  if (-not (Same ([string]$Manifest.transaction) $Transaction) -or
      -not (Same ([string]$Manifest.appPath) ([string]$Active.app)) -or
      -not (Same ([string]$Manifest.packageRoot) ([string]$Active.packageRoot)) -or
      [string]$Manifest.packageManifestSha256 -ne [string]$Active.packageManifestSha256) {
    Fail 'active.json and maintenance transaction do not match'
  }
  if (-not (Same ([string]$Manifest.activePath) (Join-Path $Active.maintenanceRoot 'active.json')) -or
      -not (Same ([string]$Manifest.receiptPath) ([string]$Active.shortcutReceipt))) {
    Fail 'maintenance transaction paths do not match active.json'
  }
}

try {
  $Active = Read-Json (Full $ConfigPath) 'active.json'
  $Root = Full $Active.packageRoot
  $Core = Join-Path $Root 'shared\update-recovery.cjs'
  $CheckJson = & $Active.node $Core --config (Full $ConfigPath) --mode check
  if ($LASTEXITCODE -ne 0) { throw 'Active package validation failed.' }
  $Check = $CheckJson | ConvertFrom-Json
  $Archive = Find-ManagedArchive $Active.app
  if (-not (Same ([string]$Check.targetAsar) $Archive)) { throw 'active.json target archive is not the supported resources\app.asar.' }

  $Matched = @()
  foreach ($Directory in @(Get-ChildItem -LiteralPath $Active.backupRoot -Directory -Filter 'v0.2.0-*')) {
    if ($Directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
    $ManifestPath = Join-Path $Directory.FullName 'feature-manifest.json'
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { continue }
    $Manifest = Read-Json $ManifestPath 'feature manifest'
    if ([string]$Manifest.appVersion -ne [string]$Check.archive.version) { continue }
    if (-not (FeatureTargetMatches $Manifest $Active $Archive)) { continue }
    $state = [string]$Manifest.state
    if ($state -eq 'applied' -and [string]$Manifest.patchedAsarSha256 -eq [string]$Check.archive.hash) {
      $Matched += [pscustomobject]@{ path = $Directory.FullName; state = 'applied'; timestamp = [string]$Manifest.appliedAt; manifest = $Manifest }
    } elseif ($state -eq 'restored' -and [string]$Manifest.sourceAsarSha256 -eq [string]$Check.archive.hash) {
      $Matched += [pscustomobject]@{ path = $Directory.FullName; state = 'restored'; timestamp = [string]$Manifest.restoredAt; manifest = $Manifest }
    }
  }
  $Feature = $Matched | Sort-Object timestamp -Descending | Select-Object -First 1
  if (-not $Feature) { throw 'No feature backup matches the current OpenCode version, archive hash and active targets.' }
  Require-FeatureTarget $Feature.manifest $Active $Archive

  if ([string]::IsNullOrWhiteSpace([string]$Active.transactionPath)) { throw 'active.json has no maintenance transaction path.' }
  $TransactionsRoot = Join-Path (Full $Active.maintenanceRoot) 'transactions'
  $MaintenancePath = Full $Active.transactionPath
  if (-not (Under $TransactionsRoot $MaintenancePath)) { throw 'active.json maintenance transaction escaped the maintenance transactions directory.' }
  $MaintenanceDirectory = Get-Item -LiteralPath $MaintenancePath -Force -ErrorAction Stop
  if (-not $MaintenanceDirectory.PSIsContainer -or ($MaintenanceDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'active.json maintenance transaction must be a real directory.'
  }
  $MaintenanceManifestPath = Join-Path $MaintenancePath 'maintenance-transaction.json'
  $MaintenanceManifest = Read-Json $MaintenanceManifestPath 'maintenance transaction'
  Require-MaintenanceMatch $MaintenanceManifest $Active $MaintenancePath

  $FeatureLink = Join-Path $Feature.path 'maintenance.json'
  if (Test-Path -LiteralPath $FeatureLink -PathType Leaf) {
    $Link = Read-Json $FeatureLink 'feature maintenance link'
    if (-not (Same ([string]$Link.transaction) $MaintenancePath) -or
        [string]$Link.packageManifestSha256 -ne [string]$Active.packageManifestSha256) {
      throw 'feature and active maintenance transactions do not match.'
    }
  }

  $FeatureArgs = @('--app', $Active.app, '--input', $Archive, '--home', $Active.home, '--runtime', $Active.runtime, '--python', $Active.python, '--transaction', $Feature.path)
  if ($Feature.state -eq 'applied') {
    & $Active.node (Join-Path $Root 'shared\feature-update.cjs') restore @FeatureArgs --dry-run
    if ($LASTEXITCODE -ne 0) { throw 'Same-version feature restore validation failed.' }
  }
  $MaintenanceRestore = Join-Path $Root 'windows\restore-maintenance.ps1'
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $MaintenanceRestore -Transaction $MaintenancePath -DryRun
  if ($LASTEXITCODE -ne 0) { throw 'Shortcut and maintenance restore validation failed.' }
  if ($DryRun) { exit 0 }
  if (Get-Process -Name OpenCode -ErrorAction SilentlyContinue) { throw 'Close OpenCode manually before restoring.' }

  if ($Feature.state -eq 'applied') {
    & $Active.node (Join-Path $Root 'shared\feature-update.cjs') restore @FeatureArgs
    if ($LASTEXITCODE -ne 0) { throw ('Feature restore failed; maintenance transaction was preserved for retry. Backup: ' + $Feature.path) }
  }
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $MaintenanceRestore -Transaction $MaintenancePath
  if ($LASTEXITCODE -ne 0) { throw 'Maintenance restore failed; the feature restore is complete or was already complete, and the maintenance transaction is marked for retry.' }
  Write-Host 'The matching application/runtime backup and original shortcuts have been restored.'
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
