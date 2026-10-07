param([switch]$Check)
$ErrorActionPreference = "Stop"
try {
  $ConfigPath = Join-Path $PSScriptRoot "active.json"
  $Active = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $Core = Join-Path $Active.packageRoot "shared\update-recovery.cjs"
  if ($Check) {
    & $Active.node $Core --config $ConfigPath --mode check
    if ($LASTEXITCODE -ne 0) { throw "Maintenance validation failed." }
  } else {
    $Launcher = Join-Path $PSScriptRoot "Launch-Voice.pyw"
    Start-Process -FilePath $Active.pythonw -ArgumentList @(('"' + $Launcher + '"'), '--config', ('"' + $ConfigPath + '"')) -WindowStyle Hidden
  }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
