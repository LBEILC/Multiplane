import { run } from '../../tools/process.mjs';

export function installerEnvironment(isolated, system = process.env) {
  const env = { ...isolated };
  // NSIS and its PowerShell checks need the real Windows profile folders.
  for (const key of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    for (const name of Object.keys(env)) if (name.toUpperCase() === key) delete env[name];
    const name = Object.keys(system).find(name => name.toUpperCase() === key);
    if (name) env[key] = system[name];
  }
  return env;
}

export function runInstaller(file, args, isolated, { system = process.env, execute = run, timeout = 300000, log = console.error } = {}) {
  const env = installerEnvironment(isolated, system);
  // NSIS parses the raw command line: even quoting /S disables silent mode.
  // /D= and _?= must be last and unquoted, including paths containing spaces.
  if (args.some(arg => /["\r\n\0]/.test(arg))) throw Error('Invalid NSIS argument');
  const directory = args.findIndex(arg => arg.startsWith('/D=') || arg.startsWith('_?='));
  if (directory >= 0 && directory !== args.length - 1) throw Error('NSIS directory argument must be last');
  return execute(file, args, { env, timeout, windowsVerbatimArguments: true, onTimeout: async () => {
    // Read only: capture diagnostics before the owned installer job is stopped.
    const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,Name | ConvertTo-Json -Compress'],
    { env, capture: true, timeout: 10000 });
    log(`Installer timeout process list: ${result.stdout}`);
  } });
}
