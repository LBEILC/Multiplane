import { once } from 'node:events';
import { Configuration } from '../../src/config.mjs';

const [home, key, value, mode] = process.argv.slice(2);
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
