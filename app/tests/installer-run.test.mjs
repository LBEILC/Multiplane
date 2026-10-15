import test from 'node:test';
import assert from 'node:assert/strict';
import { installerEnvironment, runInstaller } from '../tools/installer-run.mjs';

test('installer restores system profile folders while retaining application isolation', () => {
  const isolated = { USERPROFILE: 'isolated', APPDATA: 'isolated-roaming', LOCALAPPDATA: 'isolated-local', MULTIPLANE_HOME: 'renderer', MULTIPLANE_APP_DATA: 'desktop', MULTIPLANE_AGENT_HOME: 'agents' };
  const system = { UserProfile: 'real-user', APPDATA: 'real-roaming', LOCALAPPDATA: 'real-local' };
  assert.deepEqual(installerEnvironment(isolated, system), { ...isolated, USERPROFILE: 'real-user', APPDATA: 'real-roaming', LOCALAPPDATA: 'real-local' });
  assert.equal(isolated.USERPROFILE, 'isolated');
  assert.equal(installerEnvironment(isolated, {}).USERPROFILE, undefined);
});

test('install and uninstall timeouts collect a read-only process list with the real profile', async () => {
  for (const file of ['setup.exe', 'Uninstall Multiplane.exe']) {
    const calls = [], logs = [];
    await runInstaller(file, ['/S', '/currentuser'], { USERPROFILE: 'isolated', MULTIPLANE_HOME: 'isolated-home' }, {
      system: { USERPROFILE: 'real' }, log: line => logs.push(line),
      execute: async (command, args, options) => {
        calls.push({ command, args, options });
        if (command === file) await options.onTimeout();
        return { stdout: '[{"ProcessId":123,"Name":"setup.exe"}]' };
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].command, 'powershell.exe');
    assert.match(calls[1].args.at(-1), /Get-CimInstance Win32_Process/);
    assert.equal(calls[1].options.timeout, 10000);
    assert.equal(calls[0].options.env.USERPROFILE, 'real');
    assert.equal(calls[0].options.windowsVerbatimArguments, true);
    assert.equal(calls[0].options.env.MULTIPLANE_HOME, 'isolated-home');
    assert.match(logs[0], /ProcessId.*123/);
  }
});

test('NSIS directory tails remain unquoted and last, including spaces', async () => {
  for (const tail of ['/D=C:\\test space\\installed', '_?=C:\\test space\\installed']) {
    const args = ['/S', '/currentuser', tail];
    await runInstaller('setup.exe', args, {}, { execute: async (_file, actual, options) => {
      assert.deepEqual(actual, args);
      assert.equal(options.windowsVerbatimArguments, true);
    } });
  }
  assert.throws(() => runInstaller('setup.exe', ['/D=C:\\test', '/S'], {}), /must be last/);
  assert.throws(() => runInstaller('setup.exe', ['"/S"'], {}), /Invalid NSIS/);
});
