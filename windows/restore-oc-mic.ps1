$ErrorActionPreference = "Stop"
$CliArgs = @($args)
$AppPath = $null
$InputArchive = $null
$BackupRoot = $null
for ($i = 0; $i -lt $CliArgs.Count; $i++) {
  switch ($CliArgs[$i]) {
    "--app" { $i++; if ($i -ge $CliArgs.Count) { throw "--app requires a path" }; $AppPath = $CliArgs[$i] }
    "--input" { $i++; if ($i -ge $CliArgs.Count) { throw "--input requires a path" }; $InputArchive = $CliArgs[$i] }
    "--backup-root" { $i++; if ($i -ge $CliArgs.Count) { throw "--backup-root requires a path" }; $BackupRoot = $CliArgs[$i] }
    default { throw "unknown argument: $($CliArgs[$i])" }
  }
}
try {
  $Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  if (-not $AppPath) { $AppPath = $env:OPENCODE_APP_PATH }
  if (-not $AppPath) { $AppPath = Join-Path $env:LOCALAPPDATA "Programs\@opencode-aidesktop" }
  $AppPath = [IO.Path]::GetFullPath($AppPath)
  $ActivePath = Join-Path $env:USERPROFILE ".config\opencode\voice-maintenance\active.json"
  if (Test-Path -LiteralPath $ActivePath -PathType Leaf) {
    $ActiveVoice = Get-Content -LiteralPath $ActivePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($ActiveVoice.schema -eq 1 -and $ActiveVoice.featureVersion -eq '0.2.0' -and $AppPath.Equals([IO.Path]::GetFullPath($ActiveVoice.app), [StringComparison]::OrdinalIgnoreCase)) {
      if ($InputArchive -or $BackupRoot) { throw 'Use the managed Restore-Voice entry for an active 0.2.0 install; custom legacy ledgers cannot restore its maintained shortcuts.' }
      & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ActiveVoice.packageRoot 'windows\restore-voice-managed.ps1') -ConfigPath $ActivePath
      if ($LASTEXITCODE -ne 0) { throw 'Managed voice restore failed.' }
      exit 0
    }
  }
  if (-not $InputArchive) {
    foreach ($Candidate in @((Join-Path $AppPath "resources\app.asar"), (Join-Path $AppPath "app.asar"), (Join-Path $AppPath "Contents\Resources\app.asar"))) {
      if (Test-Path -LiteralPath $Candidate -PathType Leaf) { $InputArchive = (Resolve-Path -LiteralPath $Candidate).Path; break }
    }
  }
  if (-not $InputArchive -or -not (Test-Path -LiteralPath $InputArchive -PathType Leaf)) { throw "app.asar was not found; pass --input explicitly." }
  $Running = @(Get-Process -Name "OpenCode" -ErrorAction SilentlyContinue)
  if ($Running.Count -gt 0) { throw "OpenCode is running. Close it manually, then rerun this command; this script never terminates the app." }
  if (-not $BackupRoot) { $BackupRoot = Join-Path $env:LOCALAPPDATA "OpenCodeVoice\backups" }
  $BackupRoot = [IO.Path]::GetFullPath($BackupRoot)
  $Support = Join-Path $Root "shared\install-support.cjs"
  & node $Support restore-asar --platform windows --app $AppPath --input ([IO.Path]::GetFullPath($InputArchive)) --backup-root $BackupRoot
  if ($LASTEXITCODE -ne 0) { throw "manifest-matched restore failed (exit $LASTEXITCODE)." }
  Write-Host "[restore] the verified original archive was restored. Reopen OpenCode manually."
  exit 0
} catch {
  [Console]::Error.WriteLine("[restore] ERROR: $($_.Exception.Message)")
  exit 1
}
