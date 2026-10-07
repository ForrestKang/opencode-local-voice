param()

$ErrorActionPreference = "Stop"

try {
  # Keep this list intentionally minimal.  Command lines, owners, and other
  # user supplied process text are not part of the recovery protocol.
  # System Idle Process has PID 0 and cannot own a recovery lock or installer.
  # Keep the protocol limited to live, addressable process identities.
  $items = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ProcessId -gt 0 } | ForEach-Object {
    $creation = $null
    if ($_.CreationDate) {
      try { $creation = ([System.Management.ManagementDateTimeConverter]::ToDateTime($_.CreationDate)).ToUniversalTime().ToString("o") } catch { $creation = [string]$_.CreationDate }
    }
    [pscustomobject]@{
      pid = [int]$_.ProcessId
      parent = [int]$_.ParentProcessId
      name = [string]$_.Name
      path = if ($_.ExecutablePath) { [string]$_.ExecutablePath } else { "" }
      creation = $creation
    }
  }
  $items | ConvertTo-Json -Compress
  exit 0
} catch {
  [Console]::Error.WriteLine("process query failed")
  exit 1
}
