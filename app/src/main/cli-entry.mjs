import path from 'node:path';

export function cliEntry(platform, execPath, resources, env = process.env) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') return { path: p.join(p.dirname(execPath), 'multiplane.cmd'), args: [] };
  if (platform === 'darwin') return { path: p.join(resources, 'bin/multiplane'), args: [] };
  return { path: env.APPIMAGE || p.join(p.dirname(execPath), 'multiplane-desktop'), args: ['--multiplane-cli'] };
}
export function copyableCommand(entry, platform = process.platform) {
  return (platform === 'win32' ? `"${entry.path}"` : `'${entry.path.replaceAll("'", "'\\''")}'`) + entry.args.map(arg => ' ' + arg).join('');
}
