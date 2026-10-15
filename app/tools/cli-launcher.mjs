import path from 'node:path';
import { mkdir, writeFile, rename } from 'node:fs/promises';

export function launcherText(platform) {
  if (platform === 'win32') return '@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%~dp0Multiplane.exe" "%~dp0resources\\renderer\\bin\\multiplane" %*\r\nexit /b %errorlevel%\r\n';
  if (platform === 'darwin') return '#!/bin/sh\nbase=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 1\nexport ELECTRON_RUN_AS_NODE=1\nexec "$base/../MacOS/Multiplane" "$base/renderer/bin/multiplane" "$@"\n';
  if (platform === 'linux') return '#!/bin/sh\nbase=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1\n# AppRun may prepend this flag when user namespaces are unavailable.\nif [ "${1-}" = "--no-sandbox" ] && [ "${2-}" = "--multiplane-cli" ]; then\n  shift\nfi\nif [ "${1-}" = "--multiplane-cli" ]; then\n  shift\n  export ELECTRON_RUN_AS_NODE=1\n  exec "$base/multiplane-runtime" "$base/resources/renderer/bin/multiplane" "$@"\nfi\nexec "$base/multiplane-runtime" --no-sandbox "$@"\n';
  throw Error('Unsupported launcher platform');
}
export async function writeLauncher(platform, appOutDir, resources) {
  const target = platform === 'win32' ? path.join(appOutDir, 'multiplane.cmd')
    : platform === 'darwin' ? path.join(resources, 'bin/multiplane') : path.join(appOutDir, 'multiplane-desktop');
  if (platform === 'linux') await rename(target, path.join(appOutDir, 'multiplane-runtime'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, launcherText(platform), { mode: 0o755 });
}
