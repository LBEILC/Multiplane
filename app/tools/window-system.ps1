param(
  [Parameter(Mandatory=$true)][long]$WindowHandle,
  [Parameter(Mandatory=$true)][int]$OwnerPid,
  [Parameter(Mandatory=$true)][ValidateSet('minimize','maximize','restore','close')][string]$Action
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SmokeWindow {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam);
}
'@
[uint32]$windowPid = 0
[void][SmokeWindow]::GetWindowThreadProcessId([IntPtr]$WindowHandle, [ref]$windowPid)
if ($windowPid -ne $OwnerPid) { throw 'Window does not belong to the smoke application' }
# Use the same system commands as the native caption buttons, not BrowserWindow methods.
$commands = @{ minimize = 0xF020; maximize = 0xF030; restore = 0xF120; close = 0xF060 }
if (-not [SmokeWindow]::PostMessage([IntPtr]$WindowHandle, 0x0112, [IntPtr]$commands[$Action], [IntPtr]::Zero)) {
  throw 'WM_SYSCOMMAND failed'
}
