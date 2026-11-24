param([switch]$Check, [switch]$Rebind, [switch]$Compat, [switch]$Prune, [switch]$Adapt)
$ErrorActionPreference = "Stop"
try {
  $ConfigPath = Join-Path $PSScriptRoot "active.json"
  $Active = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $MaintenanceDir = $PSScriptRoot
  if ($Active.maintenanceRoot -and $Active.node -and (Test-Path -LiteralPath ([string]$Active.node) -PathType Leaf)) {
    $CandidateConfig = Join-Path ([string]$Active.maintenanceRoot) "active.json"
    if (Test-Path -LiteralPath $CandidateConfig -PathType Leaf) {
      $null = & $Active.node -e "const fs=require('fs');try{process.exit(fs.realpathSync.native(process.argv[1]).toLowerCase()===fs.realpathSync.native(process.argv[2]).toLowerCase()?0:1)}catch(_){process.exit(1)}" $ConfigPath $CandidateConfig
      if ($LASTEXITCODE -eq 0) {
        $MaintenanceDir = [string]$Active.maintenanceRoot
        $ConfigPath = $CandidateConfig
      }
    }
  }
  $Core = Join-Path $Active.packageRoot "shared\update-recovery.cjs"
  $AsarPath = Join-Path ([string]$Active.app) "resources\app.asar"
  if ($Compat) {
    $PatchTool = Join-Path $Active.packageRoot "shared\patch-package.cjs"
    & $Active.node $PatchTool --check-compat --platform windows --input $AsarPath
    if ($LASTEXITCODE -ne 0) { throw "Compatibility check failed for current OpenCode app.asar." }
  } elseif ($Prune) {
    $FeatureTool = Join-Path $Active.packageRoot "shared\feature-update.cjs"
    $CacheTool = Join-Path $Active.packageRoot "shared\maintenance-package.cjs"
    $AppVer = & $Active.node -e "const p=require(process.argv[1]),fs=require('fs');console.log(p.inspectAsarBuffer(fs.readFileSync(process.argv[2])).version)" (Join-Path $Active.packageRoot "shared\patch-package.cjs") $AsarPath
    & $Active.node $FeatureTool prune --backup-root ([string]$Active.backupRoot) --app-version $AppVer
    if ($LASTEXITCODE -ne 0) { throw "Backup pruning failed." }
    & $Active.node $CacheTool --prune-cache --maintenance-root $MaintenanceDir --keep ([string]$Active.packageRoot) --active-version ([string]$Active.featureVersion)
    if ($LASTEXITCODE -ne 0) { throw "Cache pruning failed." }
  } elseif ($Adapt) {
    $PatchTool = Join-Path $Active.packageRoot "shared\patch-package.cjs"
    & $Active.node $PatchTool --check-compat --platform windows --input $AsarPath
    if ($LASTEXITCODE -ne 0) { throw "OpenCode app.asar layout changed; manual patch update required." }
    & $Active.node $Core --config $ConfigPath --mode repair
    if ($LASTEXITCODE -ne 0) { throw "OpenCode update adaptation failed." }
  } elseif ($Check) {
    & $Active.node $Core --config $ConfigPath --mode check
    if ($LASTEXITCODE -ne 0) { throw "Maintenance validation failed." }
  } elseif ($Rebind) {
    $Shortcuts = Join-Path $Active.packageRoot "windows\maintenance-shortcuts.ps1"
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Shortcuts -Mode Rebind -ConfigPath $ConfigPath -ReceiptPath ([string]$Active.shortcutReceipt)
    if ($LASTEXITCODE -ne 0) { throw "Shortcut rebind failed." }
  } else {
    $Launcher = Join-Path $MaintenanceDir "Launch-Voice.pyw"
    Start-Process -FilePath $Active.pythonw -ArgumentList @(('"' + $Launcher + '"'), '--config', ('"' + $ConfigPath + '"')) -WindowStyle Hidden
  }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
