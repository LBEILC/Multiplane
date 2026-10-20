import path from 'node:path';
import { migrateUserHome } from './home-migration.mjs';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { userHome } from './platform.mjs';
import { MultiplaneError, invalidOption } from './errors.mjs';
import { ffmpegOutput } from './ffmpeg.mjs';
import { lockConfiguration } from './config-lock.mjs';

export const configKeys = ['ffmpeg', 'raster', 'encoder', 'workers', 'jobsDir', 'hosted'];
export async function probeFfmpeg(file) {
  const check = { usable: false, version: null, encoders: { libx264: false, 'libvpx-vp9': false, prores_ks: false }, reason: null };
  try {
    check.version = (await ffmpegOutput(file, ['-version'])).split(/\r?\n/)[0];
    if (!/^ffmpeg version\s/i.test(check.version)) { check.reason = 'not-ffmpeg'; return check; }
    const list = await ffmpegOutput(file, ['-encoders']);
    for (const name of Object.keys(check.encoders)) check.encoders[name] = new RegExp('\\b' + name + '\\b').test(list);
    check.usable = check.encoders.libx264;
    if (!check.usable) check.reason = 'missing-libx264';
  } catch (error) { check.reason = error.code === 'ENOENT' ? 'not-found' : 'cannot-run'; }
  return check;
}
export class Configuration {
  constructor(home = userHome(), env = process.env, warning = () => {}) { this.file = path.join(home, 'config.json'); this.env = env; this.warning = warning; }
  prepare() {
    if (path.resolve(path.dirname(this.file)) === path.resolve(userHome(this.env))) {
      for (const warning of migrateUserHome(this.env).warnings) this.warning(warning);
    }
  }
  async document() {
    let text;
    try { text = await fs.readFile(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return { exists: false, values: {} }; throw error; }
    try {
      const values = JSON.parse(text);
      if (!values || Array.isArray(values) || typeof values !== 'object') throw Error();
      return { exists: true, values };
    } catch { throw new MultiplaneError('config_invalid', `Invalid configuration: ${this.file}`, { details: { path: this.file }, hint: 'Repair or delete this configuration file before changing settings.' }); }
  }
  async read(key, prepared = false) {
    if (!prepared) this.prepare();
    if (key !== undefined && !configKeys.includes(key)) throw invalidOption('key', 'Unknown configuration key.');
    const { exists, values } = await this.document();
    return { file: this.file, exists, values: Object.fromEntries((key ? [key] : configKeys).map(k => [k, values[k] ?? null])), overrides: { ffmpeg: this.env.MULTIPLANE_FFMPEG || null, jobsDir: this.env.MULTIPLANE_JOBS_DIR || null } };
  }
  async save(key, value) {
    if (!configKeys.includes(key)) throw invalidOption('key', 'Unknown configuration key.');
    if (key === 'workers' && value === 'auto') value = null;
    if (value !== null) {
      if (key === 'hosted' && ['true', 'false'].includes(value)) value = value === 'true';
      if (key === 'workers' && /^\d+$/.test(String(value))) value = Number(value);
      const valid = ['ffmpeg', 'jobsDir'].includes(key) ? typeof value === 'string' && !!value.trim() && !value.includes('\0')
        : key === 'raster' ? ['gpu', 'software'].includes(value) : key === 'encoder' ? ['x264', 'nvenc-h264', 'nvenc-hevc'].includes(value)
          : key === 'hosted' ? typeof value === 'boolean' : Number.isSafeInteger(value) && value > 0;
      if (!valid) throw invalidOption(key, 'Invalid configuration value.');
      if (['ffmpeg', 'jobsDir'].includes(key)) value = path.resolve(value);
    }
    this.prepare();
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const unlock = await lockConfiguration(this.file);
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    let result;
    try {
      const { values } = await this.document();
      await fs.writeFile(temporary, JSON.stringify({ ...values, schema: 'multiplane/1', [key]: value }, null, 2) + '\n', { flag: 'wx' });
      await fs.rename(temporary, this.file);
      result = { ...await this.read(undefined, true), changed: key };
    } finally { await fs.unlink(temporary).catch(() => {}); await unlock(); }
    if (key === 'ffmpeg' && value !== null) result.check = await probeFfmpeg(value);
    return result;
  }
}
