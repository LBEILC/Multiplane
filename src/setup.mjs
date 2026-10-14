import { fileURLToPath } from 'node:url';
import { Configuration } from './config.mjs';
import { Skills } from './skills.mjs';
import { createEvents, version } from './events.mjs';
import { asError, invalidOption, MultiplaneError } from './errors.mjs';

export async function setup(command, args, onEvent) {
  const events = createEvents(command, null, { onEvent });
  events.start();
  try {
    const positional = [], options = {};
    for (let i = 0; i < args.length; i++) {
      const token = args[i];
      if (!token.startsWith('--')) { positional.push(token); continue; }
      const key = token.slice(2);
      if (!['json', ...(command === 'skill' ? ['host', 'force', 'expect'] : [])].includes(key) || key in options) throw invalidOption(token, 'Invalid or duplicate option.');
      if (['json', 'force'].includes(key)) options[key] = true;
      else { if (args[i + 1] === undefined || args[i + 1].startsWith('--')) throw invalidOption(token, 'Missing option value.'); options[key] = args[++i]; }
    }
    const [action, key, value] = positional;
    let data;
    if (command === 'config') {
      if (!['get', 'set', 'unset'].includes(action) || (action === 'get' ? positional.length > 2 : positional.length !== (action === 'set' ? 3 : 2))) throw invalidOption('action', 'Use config get [key], set <key> <value>, or unset <key>.');
      const config = new Configuration(undefined, process.env, warning => events.warning(warning));
      data = action === 'get' ? await config.read(key) : await config.save(key, action === 'unset' ? null : value);
      if (data.check && !data.check.usable) events.warning({ code: 'ffmpeg_unusable', message: 'The saved FFmpeg path is unusable.', details: { reason: data.check.reason } });
    } else {
      if (!['status', 'install', 'remove'].includes(action) || positional.length !== 1 || (action !== 'status' && !options.host) || !['all', 'claude', 'codex'].includes(options.host ?? 'all') || (action === 'status' && ('force' in options || 'expect' in options))) throw invalidOption('host', 'Use skill status, install, or remove with --host claude|codex|all.');
      const skills = new Skills(fileURLToPath(new URL('../skills/multiplane/', import.meta.url)), version);
      const hosts = await skills.list(!options.host || options.host === 'all' ? ['claude', 'codex'] : [options.host]);
      if (action === 'status') data = { hosts };
      else {
        data = { hosts: [] }; let first;
        for (const status of hosts) {
          const item = { host: status.host, action, ok: true, code: null, message: null, target: status.target, version: action === 'install' ? version : null, backup: null };
          try {
            if (status.blocked) throw new MultiplaneError('skill_blocked', status.error);
            // TODO(design): Document --expect null for the missing-copy signature.
            const expected = options.expect === 'null' ? null : options.expect;
            Object.assign(item, await skills.change(status.host, action, expected, undefined, !!options.force));
          } catch (failure) { const error = asError(failure); first ??= error; Object.assign(item, { ok: false, code: error.code, message: error.message, version: status.version }); }
          data.hosts.push(item);
        }
        if (first) { first.result = { data }; throw first; }
      }
    }
    return events.finish(data);
  } catch (failure) {
    const error = asError(failure); error.result = events.finish(error.result?.data ?? {}, error); throw error;
  } finally { events.dispose(); }
}
