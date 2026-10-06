param(
  [ValidateSet("auto", "large-v3-turbo", "medium", "small")]
  [string]$Model = "auto",
  [switch]$Cpu,
  [switch]$SkipDeps,
  [switch]$SkipModel,
  [switch]$NoApply
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Info($m) { Write-Host "[install] $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "[install] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[install] $m" -ForegroundColor Red; exit 1 }

$Base       = Join-Path $env:USERPROFILE ".config\opencode"
$Venv       = Join-Path $Base "whisper-venv"
$WhisperDir = Join-Path $Base "whisper"
$VenvPy     = Join-Path $Venv "Scripts\python.exe"
$Mirror     = "https://pypi.tuna.tsinghua.edu.cn/simple"

$Repos = @{
  "large-v3-turbo" = "deepdml/faster-whisper-large-v3-turbo-ct2"
  "medium"         = "Systran/faster-whisper-medium"
  "small"          = "Systran/faster-whisper-small"
}

# ---- 硬件探测：有无 NVIDIA 显卡 / 逻辑核数 ----
$hasNvidia = $false
$cores = 4
try {
  $gpus = Get-CimInstance Win32_VideoController -ErrorAction Stop
  if ($gpus | Where-Object { $_.Name -match "NVIDIA" }) { $hasNvidia = $true }
} catch { }
try {
  $cores = [int](Get-CimInstance Win32_Processor -ErrorAction Stop | Measure-Object -Property NumberOfLogicalProcessors -Maximum).Maximum
} catch { }

if ($Model -eq "auto") {
  if ($hasNvidia -and -not $Cpu) {
    $Model = "large-v3-turbo"
  } elseif ($cores -ge 8) {
    $Model = "medium"
  } else {
    $Model = "small"
  }
  Info ("自动选型: {0}（NVIDIA={1}, 强制CPU={2}, 逻辑核数={3}）" -f $Model, $hasNvidia, [bool]$Cpu, $cores)
}
$ModelDir = Join-Path $Base ("whisper-models\" + $Model)

Info "环境检查 ..."
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { Fail "未找到 Python。请先安装 Python 3.10+。" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "未找到 Node.js（打补丁需要）。可执行: winget install OpenJS.NodeJS.LTS" }

if (-not $SkipDeps) {
  if (-not (Test-Path $VenvPy)) {
    Info "创建 Python 虚拟环境: $Venv"
    python -m venv $Venv
  }
  Info "安装 faster-whisper ..."
  & $VenvPy -m pip install -q --disable-pip-version-check -i $Mirror faster-whisper
  if (-not $Cpu -and $hasNvidia) {
    Info "安装 CUDA 运行库 (cuBLAS / cuDNN) ..."
    & $VenvPy -m pip install -q --disable-pip-version-check -i $Mirror nvidia-cublas-cu12 nvidia-cudnn-cu12
  } elseif (-not $Cpu) {
    Warn "未检测到 NVIDIA 显卡，跳过 CUDA 库（省约 1.3GB 下载），识别将走 CPU"
  } else {
    Warn "CPU 模式：不安装 CUDA 运行库（识别会慢一些）"
  }
}

if (-not $SkipModel) {
  New-Item -ItemType Directory -Path $ModelDir -Force | Out-Null
  if (Test-Path (Join-Path $ModelDir "model.bin")) {
    Info "模型已存在，跳过下载: $ModelDir"
  } else {
    Info "下载模型 $Model 从 hf-mirror（大文件，请耐心等待）..."
    $env:HF_ENDPOINT = "https://hf-mirror.com"
    $env:HF_HUB_DISABLE_XET = "1"
    $env:HF_HUB_ENABLE_HF_TRANSFER = "0"
    $env:HF_HUB_DISABLE_PROGRESS_BARS = "1"
    & $VenvPy -c "from huggingface_hub import snapshot_download; snapshot_download('$($Repos[$Model])', local_dir=r'$ModelDir')"
    if ($LASTEXITCODE -ne 0) { Fail "模型下载失败，请重试（会自动续传）。" }
  }
  if ($Model -ne "large-v3-turbo") {
    [Environment]::SetEnvironmentVariable("OPENCODE_WHISPER_MODEL_DIR", $ModelDir, "User")
    Info "已设置 OPENCODE_WHISPER_MODEL_DIR = $ModelDir"
  }
}

Info "部署识别服务 ..."
New-Item -ItemType Directory -Path $WhisperDir -Force | Out-Null
Copy-Item (Join-Path $Root "stt_server.py") (Join-Path $WhisperDir "stt_server.py") -Force

if (-not $NoApply) {
  Info "生成补丁并应用到 OpenCode 桌面版 ..."
  Push-Location $Root
  try {
    node (Join-Path $Root "patch-oc-mic.js")
    if ($LASTEXITCODE -ne 0) { Fail "补丁生成失败，未做任何修改。" }
  } finally { Pop-Location }

  $Res = Join-Path $env:LOCALAPPDATA "Programs\@opencode-aidesktop\resources"
  if (-not (Test-Path (Join-Path $Res "app.asar"))) { Fail "未找到 OpenCode 桌面版安装目录: $Res" }

  Info "关闭 OpenCode ..."
  Get-Process OpenCode -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2

  if (-not (Test-Path (Join-Path $Root "app.asar.original"))) {
    Copy-Item (Join-Path $Res "app.asar") (Join-Path $Root "app.asar.original") -Force
  }
  Copy-Item (Join-Path $Res "app.asar") (Join-Path $Root "app.asar.bak") -Force
  Copy-Item (Join-Path $Root "app.asar.patched") (Join-Path $Res "app.asar") -Force

  Info "重启 OpenCode ..."
  Start-Process (Join-Path $env:LOCALAPPDATA "Programs\@opencode-aidesktop\OpenCode.exe")
  Info "完成！输入框工具栏上会出现麦克风按钮。"
} else {
  Info "完成（未应用补丁）。之后双击 apply-oc-mic.cmd 即可应用。"
}
