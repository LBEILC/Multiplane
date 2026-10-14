import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';

export function createLogger(directory) {
  const file = path.join(directory, 'logs', 'desktop.log');
  const recent = new Map();
  return (scope, error) => {
    const message = String(error?.stack ?? error?.message ?? error).slice(0, 12000);
    const key = `${scope}: ${message}`, now = Date.now();
    if (now - (recent.get(key) ?? 0) < 60000) return;
    if (recent.size >= 200) recent.clear();
    recent.set(key, now);
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      try { if (statSync(file).size > 2 * 1024 * 1024) renameSync(file, file + '.1'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      appendFileSync(file, JSON.stringify({ time: new Date(now).toISOString(), scope, message }) + '\n');
    } catch (failure) { console.error('Desktop log could not be written:', failure); }
  };
}
