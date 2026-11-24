param(
  [switch]$FromGitHub,
  [string]$Repo = "ForrestKang/opencode-local-voice",
  [switch]$SkipPull,
  [switch]$Reinstall,
  [ValidateSet("auto", "large-v3-turbo", "medium", "small")]
  [string]$Model = "auto",
  [switch]$WithLocalModel,
  [switch]$Cpu,
  [string]$AppPath,
  [string]$Pypi = "https://pypi.tuna.tsinghua.edu.cn/simple",
  [switch]$NoApply,
  [switch]$DryRun,
  [switch]$InstallAutoRepairTask,
  [switch]$RemoveAutoRepairTask,
  [switch]$TaskOnly
)

$ErrorActionPreference = "Stop"
$PlatformDir = $PSScriptRoot
$Root = (Resolve-Path (Join-Path $PlatformDir "..")).Path
$TaskName = "OpenCodeLocalVoiceShortcutGuard"

function Info([string]$Message) { Write-Host "[update] $Message" -ForegroundColor Cyan }
function Fail([string]$Message) { throw $Message }

. (Join-Path $PlatformDir "voice-paths.ps1")

function Sha256-File([string]$Path) {
  $alg = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($Path)
  try { return ([BitConverter]::ToString($alg.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $alg.Dispose() }
}

function Set-AutoRepairTask([string]$RepairScript) {
  if (-not (Test-Path -LiteralPath $RepairScript -PathType Leaf)) {
    Fail "Cannot register shortcut guard task; installed Repair-Voice.ps1 not found at $RepairScript"
  }
  $psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $taskCmd = "`"$psExe`" -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RepairScript`" -Rebind"
  & schtasks.exe /Create /TN $TaskName /TR $taskCmd /SC ONLOGON /RL LIMITED /F | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "Failed to register scheduled task $TaskName (exit $LASTEXITCODE)." }
  Info "registered logon shortcut guard task: $TaskName"
}

function Remove-AutoRepairTaskIfPresent {
  & schtasks.exe /Query /TN $TaskName *> $null
  if ($LASTEXITCODE -eq 0) {
    & schtasks.exe /Delete /TN $TaskName /F | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "Failed to remove scheduled task $TaskName (exit $LASTEXITCODE)." }
    Info "removed logon shortcut guard task: $TaskName"
  } else {
    Info "logon shortcut guard task $TaskName is not present."
  }
}

$Base = Resolve-OpencodeBase (Join-Path $env:USERPROFILE ".config\opencode")
$VoiceHome = if ($env:OPENCODE_VOICE_HOME) { Resolve-OpencodeBase $env:OPENCODE_VOICE_HOME } else { Join-Path $Base "local-voice" }
$WhisperDir = Join-Path $Base "whisper"
$VenvPy = Join-Path $Base "whisper-venv\Scripts\python.exe"
$ExistingConfig = Join-Path $VoiceHome "config.json"
$InstalledRepair = Join-Path $Base "voice-maintenance\Repair-Voice.ps1"

if ($RemoveAutoRepairTask) {
  Remove-AutoRepairTaskIfPresent
  if ($TaskOnly -or (-not $FromGitHub -and -not $Reinstall -and -not $DryRun)) { exit 0 }
}

if ($TaskOnly) {
  if ($InstallAutoRepairTask) { Set-AutoRepairTask $InstalledRepair }
  exit 0
}

if ($FromGitHub) {
  if ($Repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { Fail "Invalid -Repo format: $Repo" }
  if (-not $DryRun -and -not $NoApply -and (Get-Process -Name OpenCode -ErrorAction SilentlyContinue)) {
    Fail "OpenCode is currently running. Close OpenCode manually before updating, or pass -DryRun to test compatibility."
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ApiUrl = "https://api.github.com/repos/$Repo/releases/latest"
  Info "checking latest release from $Repo ..."
  $Release = Invoke-RestMethod -Uri $ApiUrl -Headers @{ "User-Agent" = "opencode-local-voice-updater"; "Accept" = "application/vnd.github+json" }
  $Assets = @($Release.assets)
  $ZipAsset = $Assets | Where-Object { $_.name -match '-windows-candidate\.zip$' } | Select-Object -First 1
  if (-not $ZipAsset) { $ZipAsset = $Assets | Where-Object { $_.name -match '-source-candidate\.zip$' } | Select-Object -First 1 }
  if (-not $ZipAsset) { Fail "No Windows or source candidate ZIP asset found in release $($Release.tag_name)." }
  $SumsAsset = $Assets | Where-Object { $_.name -eq "SHA256SUMS.txt" } | Select-Object -First 1

  $Stage = Join-Path ([IO.Path]::GetTempPath()) ("oc-voice-update-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $Stage -Force | Out-Null
  try {
    $ZipPath = Join-Path $Stage $ZipAsset.name
    Info "downloading $($ZipAsset.name) ($($Release.tag_name)) ..."
    Invoke-WebRequest -Uri $ZipAsset.browser_download_url -OutFile $ZipPath -UseBasicParsing
    if (-not $SumsAsset) {
      Fail "Release $($Release.tag_name) is missing SHA256SUMS.txt; refusing to install an unverified archive."
    }
    $SumsPath = Join-Path $Stage "SHA256SUMS.txt"
    Invoke-WebRequest -Uri $SumsAsset.browser_download_url -OutFile $SumsPath -UseBasicParsing
    $ExpectedLine = Get-Content -LiteralPath $SumsPath -Encoding UTF8 | Where-Object { $_ -match ("^([0-9a-fA-F]{64})\s+" + [regex]::Escape($ZipAsset.name) + "$") } | Select-Object -First 1
    if (-not $ExpectedLine) { Fail "SHA256SUMS.txt does not list $($ZipAsset.name)." }
    $ExpectedHash = ($ExpectedLine -split '\s+')[0].ToLowerInvariant()
    $ActualHash = Sha256-File $ZipPath
    if ($ActualHash -ne $ExpectedHash) { Fail "Release archive SHA256 mismatch for $($ZipAsset.name)." }
    Info "verified archive SHA256 ($ExpectedHash)"
    $ExtractDir = Join-Path $Stage "extracted"
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractDir -Force
    $PkgRoot = (Get-ChildItem -LiteralPath $ExtractDir -Directory | Select-Object -First 1).FullName
    if (-not $PkgRoot) { $PkgRoot = $ExtractDir }
    $NodeCmd = (Get-Command node -ErrorAction Stop).Source
    $MaintVerify = Join-Path $PkgRoot "shared\maintenance-package.cjs"
    if (Test-Path -LiteralPath $MaintVerify -PathType Leaf) {
      & $NodeCmd $MaintVerify --verify-only --source $PkgRoot | Out-Null
      if ($LASTEXITCODE -ne 0) { Fail "Extracted package failed CONTENTS.sha256 verification." }
    }
    $ChildScript = Join-Path $PkgRoot "windows\Update-Plugin.ps1"
    if (-not (Test-Path -LiteralPath $ChildScript -PathType Leaf)) {
      Fail "Extracted release $($Release.tag_name) does not include windows\Update-Plugin.ps1; run its windows\install.ps1 directly."
    }
    # Forward -Model only when explicitly supplied so incremental updates remain eligible.
    $ForwardArgs = @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ChildScript, "-SkipPull", "-Pypi", $Pypi)
    if ($PSBoundParameters.ContainsKey("Model")) { $ForwardArgs += @("-Model", $Model) }
    if ($Reinstall) { $ForwardArgs += "-Reinstall" }
    if ($WithLocalModel) { $ForwardArgs += "-WithLocalModel" }
    if ($Cpu) { $ForwardArgs += "-Cpu" }
    if ($AppPath) { $ForwardArgs += @("-AppPath", $AppPath) }
    if ($NoApply) { $ForwardArgs += "-NoApply" }
    if ($DryRun) { $ForwardArgs += "-DryRun" }
    if ($InstallAutoRepairTask) { $ForwardArgs += "-InstallAutoRepairTask" }
    & powershell.exe @ForwardArgs
    if ($LASTEXITCODE -ne 0) { Fail "Release update execution failed (exit $LASTEXITCODE)." }
    exit 0
  } finally {
    if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

if (-not $DryRun -and -not $NoApply -and (Get-Process -Name OpenCode -ErrorAction SilentlyContinue)) {
  Fail "OpenCode is currently running. Close OpenCode manually before updating, or pass -DryRun to check compatibility."
}

if (-not $SkipPull -and -not $DryRun -and (Test-Path -LiteralPath (Join-Path $Root ".git"))) {
  $GitCmd = Get-Command git -ErrorAction SilentlyContinue
  if (-not $GitCmd) { Fail "git is required to pull updates in a git checkout (or pass -SkipPull)." }
  $Dirty = & $GitCmd.Source -C $Root status --porcelain
  if ($LASTEXITCODE -ne 0) { Fail "git status failed." }
  if ($Dirty) { Fail "Local uncommitted changes detected in $Root. Commit/stash them first or pass -SkipPull." }
  Info "pulling latest plugin commits via git pull --ff-only ..."
  & $GitCmd.Source -C $Root pull --ff-only
  if ($LASTEXITCODE -ne 0) { Fail "git pull --ff-only failed (exit $LASTEXITCODE)." }
} elseif (-not $SkipPull -and -not (Test-Path -LiteralPath (Join-Path $Root ".git"))) {
  Info "no .git directory in $Root; deploying current workspace files (pass -FromGitHub to fetch a GitHub release)."
}

$CanIncremental = (-not $Reinstall) -and (-not $WithLocalModel) -and (-not $PSBoundParameters.ContainsKey("Model")) -and (-not $Cpu) -and (Test-Path -LiteralPath $VenvPy -PathType Leaf) -and (Test-Path -LiteralPath $WhisperDir -PathType Container)

if ($DryRun) {
  if ((-not $NoApply) -and (Test-Path -LiteralPath $VenvPy -PathType Leaf) -and (Test-Path -LiteralPath $VoiceHome -PathType Container) -and (Test-Path -LiteralPath $WhisperDir -PathType Container)) {
    $DryArgs = @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PlatformDir "install-feature-preview.ps1"), "-VoiceHome", $VoiceHome, "-RuntimePath", $WhisperDir, "-PythonPath", $VenvPy, "-DryRun")
    if ($AppPath) { $DryArgs += @("-AppPath", $AppPath) }
    & powershell.exe @DryArgs
  } else {
    $DryArgs = @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PlatformDir "install.ps1"), "-DryRun")
    if ($NoApply) { $DryArgs += "-NoApply" }
    if ($AppPath) { $DryArgs += @("-AppPath", $AppPath) }
    & powershell.exe @DryArgs
  }
  if ($LASTEXITCODE -ne 0) { Fail "Dry-run compatibility check failed (exit $LASTEXITCODE)." }
  exit 0
}

if ($CanIncremental -and (Test-Path -LiteralPath $ExistingConfig -PathType Leaf)) {
  $Helper = Join-Path $Root "shared\install-support.py"
  Info "stopping authenticated local voice service before updating backend ..."
  & $VenvPy $Helper stop-service --voice-home $VoiceHome
  if ($LASTEXITCODE -ne 0) { Fail "Local voice service preflight failed (exit $LASTEXITCODE)." }
  Info "deploying updated Python runtime while preserving config.json ..."
  & $VenvPy $Helper deploy --destination $WhisperDir
  if ($LASTEXITCODE -ne 0) { Fail "Backend deployment failed (exit $LASTEXITCODE)." }
  if (-not $NoApply) {
    Info "applying updated desktop patch and maintenance hooks ..."
    $FeatureArgs = @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PlatformDir "install-feature-preview.ps1"), "-VoiceHome", $VoiceHome, "-RuntimePath", $WhisperDir, "-PythonPath", $VenvPy)
    if ($AppPath) { $FeatureArgs += @("-AppPath", $AppPath) }
    & powershell.exe @FeatureArgs
    if ($LASTEXITCODE -ne 0) { Fail "Incremental plugin update failed (exit $LASTEXITCODE)." }
  }
} elseif ($NoApply) {
  $InstallArgs = @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PlatformDir "install.ps1"), "-NoApply", "-Model", $Model, "-Pypi", $Pypi)
  if ($WithLocalModel) { $InstallArgs += "-WithLocalModel" }
  if ($Cpu) { $InstallArgs += "-Cpu" }
  if ($AppPath) { $InstallArgs += @("-AppPath", $AppPath) }
  & powershell.exe @InstallArgs
  if ($LASTEXITCODE -ne 0) { Fail "Backend install failed (exit $LASTEXITCODE)." }
} else {
  Info "running full plugin installation ..."
  $InstallArgs = @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PlatformDir "install.ps1"), "-Model", $Model, "-Pypi", $Pypi)
  if ($WithLocalModel) { $InstallArgs += "-WithLocalModel" }
  if ($Cpu) { $InstallArgs += "-Cpu" }
  if ($AppPath) { $InstallArgs += @("-AppPath", $AppPath) }
  & powershell.exe @InstallArgs
  if ($LASTEXITCODE -ne 0) { Fail "Plugin installation failed (exit $LASTEXITCODE)." }
}

if ($InstallAutoRepairTask) {
  Set-AutoRepairTask $InstalledRepair
}

Info "plugin update complete."
