param([Parameter(Mandatory=$true)][string]$Node)
$ErrorActionPreference = 'Stop'
# An unselected desktop exercises unattended NSIS without a visible wizard.
# This is not a separate service session. Never switch the user's desktop.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class InstallerDesktop077 {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int cb; public string reserved, desktop, title;
    public int x,y,xs,ys,xc,yc,fill,flags; public short show,reserved2;
    public IntPtr reservedPtr, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, uint flags, uint access, IntPtr security);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string file, StringBuilder args, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo process);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static void Check(bool ok, string operation = "Win32") { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
  public static void Run(string node, string script, string cwd) {
    string name = "MultiplaneInstaller077_" + System.Diagnostics.Process.GetCurrentProcess().Id;
    IntPtr desktop = IntPtr.Zero;
    ProcessInfo child = new ProcessInfo();
    try {
      desktop = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, 0xF01FF, IntPtr.Zero); Check(desktop != IntPtr.Zero, "CreateDesktop");
      Startup start = new Startup(); start.cb = Marshal.SizeOf(start); start.desktop = name;
      Check(CreateProcess(node, new StringBuilder("\"" + node + "\" \"" + script + "\""), IntPtr.Zero, IntPtr.Zero, false, 0x08000000, IntPtr.Zero, cwd, ref start, out child));
      if (WaitForSingleObject(child.process, 300000) != 0) {
        // Exact retained process handle; no process-name or parent-PID traversal.
        TerminateProcess(child.process, 1); WaitForSingleObject(child.process, 10000);
        throw new Exception("Non-interactive verification timed out");
      }
      uint code; Check(GetExitCodeProcess(child.process, out code));
      if (code != 0) throw new Exception("Non-interactive worker exited " + code);
      Console.WriteLine("Unselected private desktop: passed (same logon session)");
    } finally {
      if (child.thread != IntPtr.Zero) CloseHandle(child.thread);
      if (child.process != IntPtr.Zero) CloseHandle(child.process);
      if (desktop != IntPtr.Zero) CloseDesktop(desktop);
    }
  }
}
'@
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
[InstallerDesktop077]::Run($Node, (Join-Path $PSScriptRoot 'verify-ci-installer.mjs'), $root)
