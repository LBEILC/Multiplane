param([Parameter(Mandatory=$true)][string]$Installer, [Parameter(Mandatory=$true)][string]$Evidence)
$ErrorActionPreference = 'Stop'
if ([IO.Path]::GetFileName($Installer) -ne 'MultiplaneUpdateTest064-Setup-0.3.91-x64.exe') { throw 'Not a test installer' }
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class UpdateInstallerUI {
  public delegate bool Callback(IntPtr h, IntPtr arg);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr arg);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int size);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static string Text(IntPtr h) { var s = new StringBuilder(1024); GetWindowText(h,s,1024); return s.ToString(); }
}
'@
$rows = [Collections.Generic.List[object]]::new()
$deadline = (Get-Date).AddMinutes(3)
$seen = $false
while ((Get-Date) -lt $deadline) {
  $owned = @(Get-CimInstance Win32_Process -Filter "Name = 'MultiplaneUpdateTest064-Setup-0.3.91-x64.exe'" | Where-Object { $_.ExecutablePath -eq $Installer })
  if ($owned.Count -gt 0) { $seen = $true }
  if ($seen -and $owned.Count -eq 0) { $rows | ConvertTo-Json | Set-Content -Encoding utf8 $Evidence; exit 0 }
  foreach ($process in $owned) {
    $targetPid = [uint32]$process.ProcessId
    $created = $process.CreationDate
    $callback = [UpdateInstallerUI+Callback]{ param($window, $arg)
      $windowPid = [uint32]0
      [void][UpdateInstallerUI]::GetWindowThreadProcessId($window, [ref]$windowPid)
      if ($windowPid -eq $targetPid -and [UpdateInstallerUI]::IsWindowVisible($window)) {
        $button = [UpdateInstallerUI]::GetDlgItem($window, 1)
        if ($button -ne [IntPtr]::Zero -and [UpdateInstallerUI]::IsWindowEnabled($button)) {
          $current = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid"
          if ($current.ExecutablePath -eq $Installer -and $current.CreationDate -eq $created) {
            $rows.Add(@{ title=[UpdateInstallerUI]::Text($window); button=[UpdateInstallerUI]::Text($button) })
            [void][UpdateInstallerUI]::PostMessage($button, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
          }
        }
      }
      return $true
    }
    [void][UpdateInstallerUI]::EnumWindows($callback, [IntPtr]::Zero)
  }
  Start-Sleep -Milliseconds 750
}
$rows | ConvertTo-Json | Set-Content -Encoding utf8 $Evidence
throw 'Test installer UI timed out'
