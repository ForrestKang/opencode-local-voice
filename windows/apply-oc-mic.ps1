$ErrorActionPreference = "Stop"
$CliArgs = @($args)
$AppPath = $null
$InputArchive = $null
$OutputArchive = $null
$BackupRoot = $null
$DryRun = $false
for ($i = 0; $i -lt $CliArgs.Count; $i++) {
  switch ($CliArgs[$i]) {
    "--app" { $i++; if ($i -ge $CliArgs.Count) { throw "--app requires a path" }; $AppPath = $CliArgs[$i] }
    "--input" { $i++; if ($i -ge $CliArgs.Count) { throw "--input requires a path" }; $InputArchive = $CliArgs[$i] }
    "--output" { $i++; if ($i -ge $CliArgs.Count) { throw "--output requires a path" }; $OutputArchive = $CliArgs[$i] }
    "--backup-root" { $i++; if ($i -ge $CliArgs.Count) { throw "--backup-root requires a path" }; $BackupRoot = $CliArgs[$i] }
    "--dry-run" { $DryRun = $true }
    default { throw "unknown argument: $($CliArgs[$i])" }
  }
}

try {
  $PlatformDir = $PSScriptRoot
  $Root = (Resolve-Path (Join-Path $PlatformDir "..")).Path
  if (-not $AppPath) { $AppPath = $env:OPENCODE_APP_PATH }
  if (-not $AppPath) { $AppPath = Join-Path $env:LOCALAPPDATA "Programs\@opencode-aidesktop" }
  $AppPath = [IO.Path]::GetFullPath($AppPath)
  if (-not (Test-Path -LiteralPath $AppPath -PathType Container)) { throw "OpenCode app directory not found: $AppPath" }
  $SupportedArchive = [IO.Path]::GetFullPath((Join-Path $AppPath "resources\app.asar"))
  $AlternateArchives = @((Join-Path $AppPath "app.asar"), (Join-Path $AppPath "Contents\Resources\app.asar")) |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
  if (-not (Test-Path -LiteralPath $SupportedArchive -PathType Leaf) -and $AlternateArchives.Count -gt 0) {
    throw "Only AppPath\resources\app.asar is supported by the Windows maintenance workflow; found an unsupported app.asar layout."
  }
  if (-not $InputArchive) {
    if (Test-Path -LiteralPath $SupportedArchive -PathType Leaf) { $InputArchive = (Resolve-Path -LiteralPath $SupportedArchive).Path }
  }
  if (-not $InputArchive -or -not (Test-Path -LiteralPath $InputArchive -PathType Leaf)) { throw "app.asar was not found; pass --input explicitly." }
  $InputArchive = [IO.Path]::GetFullPath($InputArchive)
  if (-not $InputArchive.Equals($SupportedArchive, [StringComparison]::OrdinalIgnoreCase)) { throw "Only AppPath\resources\app.asar is supported by the Windows maintenance workflow." }
  $GeneratedOutput = -not $OutputArchive
  if (-not $OutputArchive) { $OutputArchive = Join-Path ([IO.Path]::GetTempPath()) ("oc-voice-" + [guid]::NewGuid().ToString("N") + ".asar") }
  $OutputArchive = [IO.Path]::GetFullPath($OutputArchive)

  if (-not $DryRun) {
    $Running = @(Get-Process -Name "OpenCode" -ErrorAction SilentlyContinue)
    if ($Running.Count -gt 0) { throw "OpenCode is running. Close it manually, then rerun this command; this script never terminates the app." }
    if (-not $InputArchive.Equals($SupportedArchive, [StringComparison]::OrdinalIgnoreCase)) { throw "Applying a custom archive is unsupported. Use --dry-run for candidate generation, or apply the installed resources/app.asar." }
    $FeatureInstallArgs = @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $Root "windows\install-feature-preview.ps1"), "-AppPath", $AppPath)
    if ($BackupRoot) { $FeatureInstallArgs += @("-BackupRoot", $BackupRoot) }
    & powershell.exe @FeatureInstallArgs
    if ($LASTEXITCODE -ne 0) { throw "voice and maintenance installation failed (exit $LASTEXITCODE)." }
    exit 0
  }

  $Patcher = Join-Path $Root "shared\patch-package.cjs"
  & node $Patcher --platform windows --app $AppPath --input $InputArchive --output $OutputArchive
  if ($LASTEXITCODE -ne 0) { throw "ASAR candidate generation failed (exit $LASTEXITCODE)." }
  if ($DryRun) {
    Write-Host "[apply] dry run complete; candidate: $OutputArchive. The app archive was not changed."
    exit 0
  }

} catch {
  [Console]::Error.WriteLine("[apply] ERROR: $($_.Exception.Message)")
  exit 1
} finally {
  if ($GeneratedOutput -and -not $DryRun -and $OutputArchive -and (Test-Path -LiteralPath $OutputArchive)) {
    Remove-Item -LiteralPath $OutputArchive -Force -ErrorAction SilentlyContinue
  }
}
