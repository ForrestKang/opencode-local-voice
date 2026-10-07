param([switch]$DryRun)
$ErrorActionPreference = "Stop"
try {
  $ConfigPath = Join-Path $PSScriptRoot "active.json"
  $Active = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $Restore = Join-Path $Active.packageRoot "windows\restore-voice-managed.ps1"
  $RestoreArgs = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Restore, '-ConfigPath', $ConfigPath)
  if ($DryRun) { $RestoreArgs += '-DryRun' }
  & powershell.exe @RestoreArgs
  if ($LASTEXITCODE -ne 0) { throw "Managed restore failed; preserved backups contain diagnostics." }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
