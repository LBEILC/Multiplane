import { rmSync } from 'node:fs';
import { createTempDirectory } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { packagedLaunch, packagedNodeCommand } from '../tools/packaged-launch.mjs';
import { bundledInvocation } from '../src/main/settings.mjs';
import os from 'node:os';

test('Linux probes bypass AppImage and AppRun while GUI retains its sandbox flags', () => {
  for (const noSandbox of [true, false]) {
    const launch = packagedLaunch('linux', '/tmp/install space/squashfs-root', '/tmp/Multiplane.AppImage', noSandbox);
    assert.equal(launch.gui, '/tmp/Multiplane.AppImage');
    assert.equal(launch.node, '/tmp/install space/squashfs-root/multiplane-desktop');
    assert.deepEqual(launch.guiArgs, noSandbox ? ['--no-sandbox'] : []);
    const args = ['-e', 'console.log(process.execPath)', '/tmp/renderer space'];
    const env = { APPIMAGE_EXTRACT_AND_RUN: '1', MULTIPLANE_NO_SANDBOX: '1' };
    const command = packagedNodeCommand(launch.node, args, env);
    assert.equal(command.file, launch.node);
    assert.deepEqual(command.args, args);
    assert.equal(command.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    assert.notEqual(command.args, args);
  }
});

test('Windows and macOS use the installed binary for both GUI and Node', () => {
  for (const [platform, installation, expected] of [
    ['win32', 'C:\\temporary install', 'C:\\temporary install\\Multiplane.exe'],
    ['darwin', '/Volumes/temporary install', '/Volumes/temporary install/Multiplane.app/Contents/MacOS/Multiplane']
  ]) {
    assert.deepEqual(packagedLaunch(platform, installation, '/installer', true), { gui: expected, node: expected, guiArgs: [] });
  }
});

test('app doctor and render use the running binary, never the APPIMAGE wrapper or GUI flags', t => {
  const temporary = createTempDirectory('multiplane-cwd-');
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  t.mock.method(os, 'tmpdir', () => temporary);
  for (const execPath of ['/tmp/.mount_Multiplane/multiplane-desktop', '/tmp/appimage_extracted_123/multiplane-desktop']) {
    for (const args of [['doctor', '--json'], ['render', '/project space/animation.html', '--json']]) {
      const env = { APPIMAGE: '/downloads/Multiplane.AppImage', APPDIR: path.dirname(execPath), MULTIPLANE_NO_SANDBOX: '1' };
      const root = path.join(path.dirname(execPath), 'resources/renderer');
      const command = bundledInvocation(root, args, execPath, env);
      assert.equal(command.file, execPath);
      assert.deepEqual(command.args, [path.join(root, 'bin/multiplane'), ...args]);
      assert.equal(command.options.cwd, temporary);
      assert.equal(bundledInvocation(root, args, execPath, env, '/temporary-project').options.cwd, '/temporary-project');
      assert.deepEqual(command.options.env, { ...env, ELECTRON_RUN_AS_NODE: '1' });
      assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    }
  }
});
