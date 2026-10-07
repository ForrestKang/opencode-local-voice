param([string]$AppPath, [string]$VoiceHome, [string]$RuntimePath, [string]$BackupRoot, [string]$MaintenanceRoot, [string]$PythonPath, [string]$Transaction, [switch]$Restore, [switch]$DryRun)
$ErrorActionPreference = "Stop"
$GeneratedArchive = $null
try {
  $Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
  if (-not $AppPath) { $AppPath = Join-Path $env:LOCALAPPDATA "Programs\@opencode-aidesktop" }
  if (-not $VoiceHome) { $VoiceHome = Join-Path $env:USERPROFILE ".config\opencode\local-voice" }
  if (-not $RuntimePath) { $RuntimePath = Join-Path $env:USERPROFILE ".config\opencode\whisper" }
  if (-not $MaintenanceRoot) { $MaintenanceRoot = Join-Path $env:USERPROFILE ".config\opencode\voice-maintenance" }
  $NativeMaintenanceRoot = Join-Path $env:USERPROFILE ".config\opencode\voice-maintenance"
  if (-not [IO.Path]::GetFullPath($MaintenanceRoot).Equals([IO.Path]::GetFullPath($NativeMaintenanceRoot), [StringComparison]::OrdinalIgnoreCase)) { throw 'The native updater uses the per-user voice-maintenance directory; a custom maintenance root is unsupported.' }
  $ExpectedBackupRoot = Join-Path $MaintenanceRoot 'backups\0.2.0'
  if (-not $BackupRoot) { $BackupRoot = $ExpectedBackupRoot }
  if (-not [IO.Path]::GetFullPath($BackupRoot).Equals([IO.Path]::GetFullPath($ExpectedBackupRoot), [StringComparison]::OrdinalIgnoreCase)) { throw 'BackupRoot must be voice-maintenance/backups/0.2.0 for native update recovery.' }
  $Archive = [IO.Path]::GetFullPath((Join-Path $AppPath "resources\app.asar"))
  if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) {
    $AlternateArchives = @((Join-Path $AppPath "app.asar"), (Join-Path $AppPath "Contents\Resources\app.asar")) |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
    if ($AlternateArchives.Count -gt 0) { throw 'Only AppPath\resources\app.asar is supported by the Windows maintenance workflow; found an unsupported app.asar layout.' }
    throw "app.asar was not found under AppPath: $AppPath"
  }
  $VoicePython = if ($PythonPath) { [IO.Path]::GetFullPath($PythonPath) } else { Join-Path $env:USERPROFILE ".config\opencode\whisper-venv\Scripts\python.exe" }
  $VoiceNode = (Get-Command node -ErrorAction Stop).Source
  if (-not $DryRun -and (Get-Process -Name OpenCode -ErrorAction SilentlyContinue)) { throw "Close OpenCode manually before installing/restoring." }
  $FeatureArgs = @("--app", $AppPath, "--input", $Archive, "--home", $VoiceHome, "--runtime", $RuntimePath, "--python", $VoicePython)
  if ($DryRun) { $FeatureArgs += "--dry-run" }
  if ($Restore) {
    if (-not $Transaction) { throw "Restore requires -Transaction with the installation backup path." }
    & node (Join-Path $Root "shared\feature-update.cjs") restore @FeatureArgs --transaction $Transaction
  } else {
    $GeneratedArchive = Join-Path ([IO.Path]::GetTempPath()) ("oc-voice-feature-" + [guid]::NewGuid().ToString("N") + ".asar")
    $VoiceCandidateJson = & node (Join-Path $Root "shared\patch-package.cjs") --platform windows --app $AppPath --input $Archive --output $GeneratedArchive
    if ($LASTEXITCODE -ne 0) { throw "Candidate generation failed." }
    $VoiceCandidate = $VoiceCandidateJson | ConvertFrom-Json
    Write-Output $VoiceCandidateJson
    $FeatureJson = & $VoiceNode (Join-Path $Root "shared\feature-update.cjs") apply @FeatureArgs --patched $GeneratedArchive --backup-root $BackupRoot --expected-source-hash $VoiceCandidate.inputHash
    if ($LASTEXITCODE -ne 0) { throw "Feature transaction failed." }
    Write-Output $FeatureJson
    $AppliedFeature = $FeatureJson | ConvertFrom-Json
    try {
      $MaintenanceArgs = @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $Root "windows\install-maintenance.ps1"), "-PackageRoot", $Root, "-AppPath", $AppPath, "-VoiceHome", $VoiceHome, "-RuntimePath", $RuntimePath, "-BackupRoot", $BackupRoot, "-MaintenanceRoot", $MaintenanceRoot, "-NodePath", $VoiceNode, "-PythonPath", $VoicePython)
      if ($DryRun) { $MaintenanceArgs += @("-DryRun", "-CandidateAsar", $GeneratedArchive) }
      $MaintenanceJson = & powershell.exe @MaintenanceArgs
      if ($LASTEXITCODE -ne 0) { throw "Maintenance activation failed." }
      Write-Output $MaintenanceJson
      if (-not $DryRun) {
        $MaintenanceResult = ($MaintenanceJson -join "`n") | ConvertFrom-Json
        $MaintenanceResult | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $AppliedFeature.transaction "maintenance.json") -Encoding UTF8
      }
    } catch {
      $ActivationFailure = $_.Exception.Message
      if (-not $DryRun -and $MaintenanceResult -and $MaintenanceResult.state -eq "applied") {
        & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "windows\restore-maintenance.ps1") -Transaction $MaintenanceResult.transaction
        if ($LASTEXITCODE -ne 0) { throw "$ActivationFailure; maintenance rollback failed. Feature backup: $($AppliedFeature.transaction); maintenance backup: $($MaintenanceResult.transaction)" }
      }
      if (-not $DryRun -and $AppliedFeature.transaction) {
        $RollbackArgs = @("--app", $AppPath, "--input", $Archive, "--home", $VoiceHome, "--runtime", $RuntimePath, "--python", $VoicePython, "--transaction", $AppliedFeature.transaction)
        & $VoiceNode (Join-Path $Root "shared\feature-update.cjs") restore @RollbackArgs
        if ($LASTEXITCODE -ne 0) { throw "$ActivationFailure; feature rollback failed. Backup: $($AppliedFeature.transaction)" }
      }
      throw $ActivationFailure
    }
  }
  if ($LASTEXITCODE -ne 0) { throw "Feature transaction failed." }
  if ($DryRun) { Write-Host "Dry-run validation complete. Application, runtime, configuration and shortcuts were not replaced." }
  else { Write-Host "Feature transaction complete. Start OpenCode through its maintained shortcut after installation." }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
finally { if ($GeneratedArchive -and (Test-Path -LiteralPath $GeneratedArchive -PathType Leaf)) { Remove-Item -LiteralPath $GeneratedArchive -Force } }
