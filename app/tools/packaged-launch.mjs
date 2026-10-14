import path from 'node:path';

// AppRun may inject Chromium flags. Only GUI launches may go through it.
export function packagedLaunch(platform, installation, installer, noSandbox = false) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const node = platform === 'win32' ? paths.join(installation, 'Multiplane.exe')
    : platform === 'darwin' ? paths.join(installation, 'Multiplane.app/Contents/MacOS/Multiplane')
      : paths.join(installation, 'multiplane-runtime');
  return { gui: platform === 'linux' ? installer : node, node, guiArgs: platform === 'linux' && noSandbox ? ['--no-sandbox'] : [] };
}

export function packagedNodeCommand(executable, args, env) {
  return { file: executable, args: [...args], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
}
