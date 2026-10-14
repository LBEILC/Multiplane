import { runCommand } from './events.mjs';
import { startServer } from './server.mjs';
import { stopSignals } from './platform.mjs';

export async function serve(options = {}) {
  return runCommand('serve', null, options, async events => {
    let server;
    let stop;
    const stopped = new Promise(resolve => { stop = resolve; });
    const signals = stopSignals();
    for (const signal of signals) process.on(signal, stop);
    try {
      server = await startServer(events.options.port ?? 0, events.options.root);
      const { url, root, port } = server;
      events.emit('listening', { url, root, port });
      await stopped;
      return {};
    } finally {
      try { await server?.close(); }
      finally { for (const signal of signals) process.off(signal, stop); }
    }
  }, false);
}
