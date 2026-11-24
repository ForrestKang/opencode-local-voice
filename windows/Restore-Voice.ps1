param([switch]$DryRun)
$ErrorActionPreference = "Stop"
try {
  $ConfigPath = Join-Path $PSScriptRoot "active.json"
  $Active = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($Active.maintenanceRoot -and $Active.node -and (Test-Path -LiteralPath ([string]$Active.node) -PathType Leaf)) {
    $CandidateConfig = Join-Path ([string]$Active.maintenanceRoot) "active.json"
    if (Test-Path -LiteralPath $CandidateConfig -PathType Leaf) {
      $null = & $Active.node -e "const fs=require('fs');try{process.exit(fs.realpathSync.native(process.argv[1]).toLowerCase()===fs.realpathSync.native(process.argv[2]).toLowerCase()?0:1)}catch(_){process.exit(1)}" $ConfigPath $CandidateConfig
      if ($LASTEXITCODE -eq 0) { $ConfigPath = $CandidateConfig }
    }
  }
  $Restore = Join-Path $Active.packageRoot "windows\restore-voice-managed.ps1"
  $RestoreArgs = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Restore, '-ConfigPath', $ConfigPath)
  if ($DryRun) { $RestoreArgs += '-DryRun' }
  & powershell.exe @RestoreArgs
  if ($LASTEXITCODE -ne 0) { throw "Managed restore failed; preserved backups contain diagnostics." }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
