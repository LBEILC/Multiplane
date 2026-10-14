import { spawn } from 'node:child_process';
import path from 'node:path';

// Embedded so esbuild includes the helper in the packaged desktop main bundle.
// Only fixed code enters PowerShell; executable names and arguments use JSON stdin.
const helper = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
public static class OwnedJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct Extended {
    public Basic Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  static void Check(bool value) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static void Run(string file, string arguments, string cwd, string[] envKeys, string[] envValues) {
    // The private, non-inheritable handle is retained until this supervisor exits.
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    Check(job != IntPtr.Zero);
    Extended limits = new Extended(); limits.Basic.Flags = 0x2000;
    Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
    // Join BEFORE starting the target: all descendants inherit membership at birth.
    // No breakaway flags are enabled. PID/parent-PID reuse is irrelevant.
    Check(AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle));
    var start = new ProcessStartInfo(file, arguments);
    start.UseShellExecute = false; start.CreateNoWindow = true;
    start.RedirectStandardInput = true;
    // PowerShell adjusts its own environment. The target receives exactly the
    // caller's environment, without helper settings or PowerShell additions.
    start.EnvironmentVariables.Clear();
    if (envKeys != null) for (int i = 0; i < envKeys.Length; i++) start.EnvironmentVariables[envKeys[i]] = envValues[i];
    // CreateProcess searches the launching process's PATH, not the new block.
    Environment.SetEnvironmentVariable("PATH", start.EnvironmentVariables["PATH"]);
    if (!String.IsNullOrEmpty(cwd)) start.WorkingDirectory = cwd;
    var child = Process.Start(start);
    Task<string> input = Task.Run(() => Console.ReadLine());
    while (!child.WaitForExit(25)) {
      if (!input.IsCompleted) continue;
      string line = input.Result;
      // EOF means the owning Node/Electron process exited, even abruptly.
      if (line == null || line == "stop") Environment.Exit(1);
      if (line == "cancel") { child.StandardInput.WriteLine("cancel"); child.StandardInput.Flush(); }
      input = Task.Run(() => Console.ReadLine());
    }
    Environment.Exit(child.ExitCode);
  }
}
'@
$request = [Console]::ReadLine() | ConvertFrom-Json
[OwnedJob]::Run($request.file, $request.arguments, $request.cwd, [string[]]$request.envKeys, [string[]]$request.envValues)
} catch {
  $failure = $_.Exception.GetBaseException()
  [Console]::Error.WriteLine('__MULTIPLANE_OWNED_START_ERROR__' + $failure.NativeErrorCode)
  [Console]::Error.WriteLine($failure.ToString())
  exit 1
}
`;

// Windows CRT quoting, not shell quoting. Preserve empty args, quotes and slashes.
export function quoteWindows(value) {
  return '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

const owned = new WeakSet();
export function spawnOwned(file, args, options = {}) {
  if (process.platform !== 'win32') {
    const child = spawn(file, args, { ...options, detached: true });
    owned.add(child);
    return child;
  }
  if ([file, ...args].some(value => String(value).includes('\0'))) throw TypeError('Process arguments must not contain null bytes');
  const environment = { ...(options.env ?? process.env) };
  const seen = new Set();
  // Match Node's first-key rule for case-insensitive Windows environment names.
  const envKeys = Object.keys(environment).sort().filter(key => {
    const normalized = key.toUpperCase();
    if (environment[key] === undefined || seen.has(normalized)) return false;
    seen.add(normalized); return true;
  });
  // libuv supplies these essential Windows variables even for an explicit,
  // minimal env. Keep that behavior (SYSTEMROOT is required by Node/OpenSSL).
  for (const key of ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR']) {
    if (!seen.has(key) && process.env[key] !== undefined) { envKeys.push(key); environment[key] = process.env[key]; }
  }
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(helper, 'utf16le').toString('base64')], {
    cwd: options.cwd, env: { ...process.env, PSModuleAnalysisCachePath: 'NUL' }, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
  });
  owned.add(child);
  let diagnostic = '';
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-16384); });
  child.once('close', () => {
    const failure = /(?:^|\r?\n)__MULTIPLANE_OWNED_START_ERROR__(\d*)\r?\n/.exec(diagnostic);
    if (failure) child.emit('error', Object.assign(Error(`Owned process launch failed: ${file}`), {
      code: ({ 2: 'ENOENT', 3: 'ENOENT', 5: 'EACCES', 193: 'ENOEXEC' })[failure[1]] ?? 'EJOB',
    }));
  });
  child.stdin.on('error', () => {}); // An already-closed job needs no further cleanup.
  child.stdin.write(JSON.stringify({ file, arguments: args.map(options.windowsVerbatimArguments ? String : quoteWindows).join(' '), cwd: options.cwd, envKeys, envValues: envKeys.map(key => String(environment[key])) }) + '\n');
  child.send = (message, callback) => child.stdin.write(message?.action === 'cancel' ? 'cancel\n' : '', callback);
  if (options.stdio === 'inherit') { child.stdout.pipe(process.stdout, { end: false }); child.stderr.pipe(process.stderr, { end: false }); }
  return child;
}

export async function stopOwned(child) {
  if (!owned.has(child)) throw Error('Refusing to stop an unowned process');
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const closed = new Promise(resolve => child.once('close', resolve));
  if (process.platform === 'win32') child.stdin.end('stop\n');
  else {
    // The directly owned group leader must still be alive: only then is its
    // process-group ID protected from reuse. Never signal an exited leader.
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await closed;
}
