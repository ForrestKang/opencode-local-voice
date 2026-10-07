param(
  [ValidateSet("auto", "large-v3-turbo", "medium", "small")]
  [string]$Model = "auto",
  [switch]$Cpu,
  [switch]$SkipDeps,
  [switch]$SkipModel,
  [switch]$NoApply,
  [switch]$DryRun,
  [string]$AppPath,
  [string]$Pypi = "https://pypi.tuna.tsinghua.edu.cn/simple"
)

$ErrorActionPreference = "Stop"
$PlatformDir = $PSScriptRoot
$Root = (Resolve-Path (Join-Path $PlatformDir "..")).Path

function Info([string]$Message) { Write-Host "[install] $Message" -ForegroundColor Cyan }
function Fail([string]$Message) { throw $Message }
function Check-Native([string]$Operation) {
  if ($LASTEXITCODE -ne 0) { Fail "$Operation failed (exit $LASTEXITCODE)." }
}
function Find-AppAsar([string]$App) {
  $Candidate = Join-Path $App "resources\app.asar"
  if (Test-Path -LiteralPath $Candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $Candidate).Path }
  $Alternate = @((Join-Path $App "app.asar"), (Join-Path $App "Contents\Resources\app.asar")) |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
  if ($Alternate.Count -gt 0) { Fail "Only AppPath\resources\app.asar is supported by the Windows maintenance workflow; found an unsupported app.asar layout." }
  Fail "app.asar not found under $App. Pass -AppPath with the OpenCode installation directory."
}

$Base = Join-Path $env:USERPROFILE ".config\opencode"
$VoiceHome = if ($env:OPENCODE_VOICE_HOME) { $env:OPENCODE_VOICE_HOME } else { Join-Path $Base "local-voice" }
$Venv = Join-Path $Base "whisper-venv"
$VenvPy = Join-Path $Venv "Scripts\python.exe"
$WhisperDir = Join-Path $Base "whisper"
$Helper = Join-Path $Root "shared\install-support.py"
$Requirements = Join-Path $Root "requirements.txt"
$CudaRequirements = Join-Path $Root "requirements-cuda.txt"

if (-not $AppPath) { $AppPath = $env:OPENCODE_APP_PATH }
$NeedsDesktop = ($DryRun -or -not $NoApply)
if (-not $AppPath -and $NeedsDesktop) { $AppPath = Join-Path $env:LOCALAPPDATA "Programs\@opencode-aidesktop" }
if ($AppPath) { $AppPath = [IO.Path]::GetFullPath($AppPath) }
if ($NeedsDesktop) {
  if (-not (Test-Path -LiteralPath $AppPath -PathType Container)) { Fail "OpenCode desktop directory not found: $AppPath" }
  $AppAsar = Find-AppAsar $AppPath
}

if ($Model -eq "auto") {
  $cores = 4
  try { $cores = [int](Get-CimInstance Win32_Processor -ErrorAction Stop | Measure-Object -Property NumberOfLogicalProcessors -Maximum).Maximum } catch { }
  if ($cores -ge 8) { $Model = "medium" } else { $Model = "small" }
  Info ("automatic model: {0} ({1} logical cores)" -f $Model, $cores)
}
$Repo = @{
  "large-v3-turbo" = "deepdml/faster-whisper-large-v3-turbo-ct2"
  "medium" = "Systran/faster-whisper-medium"
  "small" = "Systran/faster-whisper-small"
}[$Model]
$ModelPath = Join-Path $VoiceHome ("models\faster-whisper-" + $Model)
$Device = if ($Cpu) { "cpu" } else { "auto" }

if ($NeedsDesktop -and -not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js is required to build the isolated patch candidate." }

if ($DryRun) {
  $Candidate = Join-Path ([IO.Path]::GetTempPath()) ("oc-voice-dry-run-" + [guid]::NewGuid().ToString("N") + ".asar")
  & node (Join-Path $PlatformDir "patch-oc-mic.js") --app $AppPath --input $AppAsar --output $Candidate
  Check-Native "ASAR candidate generation"
  Info "dry run complete; candidate generated at $Candidate. Nothing was installed or applied."
  exit 0
}

if (-not $SkipDeps) {
  if (-not (Get-Command python -ErrorAction SilentlyContinue)) { Fail "Python 3.10 or newer is required." }
  $PreflightPython = "python"
} else {
  if (-not (Test-Path -LiteralPath $VenvPy -PathType Leaf)) {
    Fail "-SkipDeps was set, but the existing voice virtual environment is missing: $VenvPy"
  }
  $PreflightPython = $VenvPy
}
$PythonVersion = & $PreflightPython -c "import sys; print('%d.%d' % sys.version_info[:2])"
Check-Native "Python version check"
if ([version]$PythonVersion -lt [version]"3.10") { Fail "Python 3.10 or newer is required; found $PythonVersion." }
Info "checking and stopping only an authenticated idle local voice service before dependency changes ..."
& $PreflightPython $Helper stop-service --voice-home $VoiceHome
Check-Native "local voice service preflight"

if (-not $SkipDeps) {
  if (-not (Test-Path -LiteralPath $VenvPy -PathType Leaf)) {
    Info "creating isolated Python environment: $Venv"
    & python -m venv $Venv
    Check-Native "virtual environment creation"
  }
  Info "installing pinned runtime requirements ..."
  & $VenvPy -m pip install -q --disable-pip-version-check -i $Pypi -r $Requirements
  if ($LASTEXITCODE -ne 0) {
    Info "package mirror failed; retrying with official PyPI ..."
    & $VenvPy -m pip install -q --disable-pip-version-check -r $Requirements
    Check-Native "runtime dependency installation"
  }
}

$HasNvidia = $false
if (-not $Cpu -and (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
  & nvidia-smi -L *> $null
  $HasNvidia = ($LASTEXITCODE -eq 0)
}
if ($HasNvidia) {
  if (-not (Test-Path -LiteralPath $CudaRequirements -PathType Leaf)) { Fail "Pinned CUDA runtime requirements are missing: $CudaRequirements" }
  if ($SkipDeps) {
    & $VenvPy -m pip show nvidia-cublas-cu12 nvidia-cudnn-cu12 *> $null
    Check-Native "existing CUDA runtime verification"
  } else {
    Info "installing pinned CUDA 12 / cuDNN 9 runtime wheels ..."
    & $VenvPy -m pip install -q --disable-pip-version-check -i $Pypi -r $CudaRequirements
    if ($LASTEXITCODE -ne 0) {
      Info "package mirror failed; retrying CUDA runtime wheels from official PyPI ..."
      & $VenvPy -m pip install -q --disable-pip-version-check -r $CudaRequirements
      Check-Native "CUDA runtime installation"
    }
  }
} elseif (-not $Cpu) {
  Info "NVIDIA runtime not detected; automatic backend selection can fall back to CPU. Use -Cpu to persist explicit CPU mode."
}

$Validated = $false
if (Test-Path -LiteralPath $ModelPath -PathType Container) {
  & $VenvPy $Helper validate-model --backend faster-whisper --model-path $ModelPath
  $Validated = ($LASTEXITCODE -eq 0)
}
if (-not $Validated) {
  if ($SkipModel) { Fail "-SkipModel was set, but the model is missing or incomplete: $ModelPath" }
  Info "downloading local model $Repo ..."
  & $VenvPy $Helper download-model --backend faster-whisper --repo $Repo --model-path $ModelPath
  Check-Native "model download and validation"
}

Info "persisting backend, device, and model path in local-voice/config.json ..."
& $VenvPy $Helper configure --backend faster-whisper --device $Device --model-path $ModelPath --voice-home $VoiceHome
Check-Native "local voice configuration"

& $VenvPy $Helper deploy --destination $WhisperDir
Check-Native "voice server, CLI, and desktop bridge deployment"
if (-not (Test-Path -LiteralPath (Join-Path $WhisperDir "stt_server.py") -PathType Leaf)) { Fail "voice service deployment failed verification." }
if (-not (Test-Path -LiteralPath (Join-Path $WhisperDir "voice_server.py") -PathType Leaf)) { Fail "canonical voice server deployment failed verification." }
if (-not (Test-Path -LiteralPath (Join-Path $WhisperDir "voice_cli.py") -PathType Leaf)) { Fail "voice CLI deployment failed verification." }
if (-not (Test-Path -LiteralPath (Join-Path $WhisperDir "desktop-bridge.cjs") -PathType Leaf)) { Fail "desktop bridge deployment failed verification." }

if ($NoApply) {
  if ($AppPath) { Info "runtime installed; desktop patch was not applied. Run windows\apply-oc-mic.cmd --app `"$AppPath`" after closing OpenCode." }
  else { Info "runtime and local CLI dependencies installed without requiring the desktop app. Run windows\apply-oc-mic.cmd --app APP_DIR after closing OpenCode if you use the desktop client." }
  exit 0
}

Info "applying the patch from its verified candidate ..."
$FeatureInstaller = Join-Path $PlatformDir "install-feature-preview.ps1"
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $FeatureInstaller -AppPath $AppPath -VoiceHome $VoiceHome -RuntimePath $WhisperDir -PythonPath $VenvPy
Check-Native "desktop patch application"
Info "installation complete. Start OpenCode through its maintained shortcut to use voice input."
