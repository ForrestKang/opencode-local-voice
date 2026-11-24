# Shared per-user OpenCode config path canonicalization for Windows scripts.
# Resolves a top-level .config\opencode NTFS junction without hiding inner links.

function Resolve-OpencodeBase([string]$Path, [string]$NodePath = "", [switch]$Strict) {
  $full = [IO.Path]::GetFullPath($Path)
  $nodeExe = $NodePath
  if ([string]::IsNullOrWhiteSpace($nodeExe)) {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) { $nodeExe = $nodeCmd.Source }
  }
  if (-not [string]::IsNullOrWhiteSpace($nodeExe)) {
    $resolved = & $nodeExe -e "const fs=require('fs'),path=require('path');let cur=path.resolve(process.argv[1]),tail=[];while(!fs.existsSync(cur)){const p=path.dirname(cur);if(p===cur)break;tail.unshift(path.basename(cur));cur=p;}const base=fs.existsSync(cur)?fs.realpathSync.native(cur):cur;process.stdout.write(path.join(base,...tail));" $full 2>$null
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($resolved)) {
      return [IO.Path]::GetFullPath($resolved).TrimEnd('\')
    }
    if ($Strict) { throw "Failed to canonicalize OpenCode config directory." }
  } elseif ($Strict) {
    throw "Node.js is required to canonicalize OpenCode config directory."
  }
  $pyCmd = Get-Command python -ErrorAction SilentlyContinue
  if ($pyCmd) {
    $resolved = & $pyCmd.Source -c "import os,sys;p=os.path.abspath(sys.argv[1]);tail=[];cur=p
while not os.path.exists(cur):
 parent=os.path.dirname(cur)
 if parent==cur: break
 tail.insert(0,os.path.basename(cur));cur=parent
base=os.path.realpath(cur) if os.path.exists(cur) else cur
print(os.path.join(base,*tail))" $full 2>$null
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($resolved)) {
      return [IO.Path]::GetFullPath($resolved).TrimEnd('\')
    }
  }
  return $full.TrimEnd('\')
}

function Resolve-OpencodePrefix([string]$Candidate, [string]$LogicalBase, [string]$RealBase) {
  if ([string]::IsNullOrWhiteSpace($Candidate)) { return $Candidate }
  $full = [IO.Path]::GetFullPath($Candidate)
  $logicalTrim = [IO.Path]::GetFullPath($LogicalBase).TrimEnd('\')
  $realTrim = [IO.Path]::GetFullPath($RealBase).TrimEnd('\')
  $logicalPrefix = $logicalTrim + '\'
  if ($full.TrimEnd('\').Equals($logicalTrim, [StringComparison]::OrdinalIgnoreCase)) { return $realTrim }
  if ($full.StartsWith($logicalPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    return [IO.Path]::GetFullPath((Join-Path $realTrim $full.Substring($logicalPrefix.Length)))
  }
  return $full
}
