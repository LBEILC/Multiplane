module.exports = {
  appId: 'io.github.lbeilc.multiplane',
  productName: 'Multiplane',
  directories: { app: 'dist', output: 'release', buildResources: 'build' },
  asar: false,
  npmRebuild: false,
  files: ['**/*', '!node_modules/**/*', '!**/*.log'],
  extraResources: [
    { from: 'build/renderer', to: 'renderer', filter: ['**/*', '!**/*.log'] },
    { from: 'build/renderer/node_modules', to: 'renderer/node_modules', filter: ['**/*', '!**/*.log'] }
  ],
  afterPack: async context => {
    const path = require('node:path');
    const { verifyRendererBundle } = await import('./tools/renderer-bundle.mjs');
    const { verifyNotices } = await import('./tools/notices.mjs');
    const resources = context.electronPlatformName === 'darwin' ? path.join(context.appOutDir, 'Multiplane.app/Contents/Resources') : path.join(context.appOutDir, 'resources');
    await verifyRendererBundle(path.join(__dirname, 'build/renderer'), path.join(resources, 'renderer'));
    await verifyNotices(path.join(resources, 'app'));
  },
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: 'build/icons/app.ico', signtoolOptions: { sign: async () => {} } },
  mac: { target: [{ target: 'dmg', arch: ['arm64', 'x64'] }], icon: 'build/icons/app.icns', identity: null, notarize: false, artifactName: 'Multiplane-${version}-${arch}.${ext}' },
  dmg: { sign: false },
  linux: { target: ['AppImage'], icon: 'build/icons/app-512.png', category: 'AudioVideo', artifactName: 'Multiplane-${version}-${arch}.${ext}', maintainer: 'Multiplane contributors' },
  nsis: {
    include: 'tools/installer.nsh',
    oneClick: false, perMachine: false, allowElevation: false,
    allowToChangeInstallationDirectory: true, packElevateHelper: false,
    createDesktopShortcut: true, createStartMenuShortcut: true,
    artifactName: 'Multiplane-Setup-${version}-${arch}.${ext}'
  }
};
