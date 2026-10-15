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

// Concurrent extract-and-run processes share the hash-named extraction tree.
// Give short-lived invocations a different TMPDIR so their cleanup cannot
// remove the running GUI's files. Mounted AppImages need no override.
export function appImageInvocationEnvironment(env, temporaryDirectory) {
  return env.APPIMAGE_EXTRACT_AND_RUN === '1' ? { ...env, TMPDIR: temporaryDirectory } : env;
}
