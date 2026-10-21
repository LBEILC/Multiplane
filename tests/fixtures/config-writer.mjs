import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Configuration } from '../../src/config.mjs';

const [home, key, value, mode] = process.argv.slice(2);
if (mode === 'before-owner' || mode === 'partial-owner') {
  const writeFile = fs.writeFile;
  fs.writeFile = async (file, ...args) => {
    if (path.dirname(file) === path.join(home, 'config.json.lock')) {
      if (mode === 'partial-owner') await writeFile(file, '{');
      process.send({ type: 'initializing' });
      await once(process, 'message');
      fs.writeFile = writeFile;
    }
    return writeFile(file, ...args);
  };
}
class Writer extends Configuration {
  async document() {
    if (mode === 'hold' && !this.held) {
      this.held = true;
      process.send({ type: 'locked' });
      await once(process, 'message');
    }
    return super.document();
  }
}
try {
  await new Writer(home).save(key, JSON.parse(value));
  process.send({ type: 'saved' });
} catch (error) {
  process.send({ type: 'error', code: error.code, message: error.message });
  process.exitCode = 1;
} finally { process.disconnect(); }
