// Exit normally so Playwright releases only its own installation lock.
process.on('message', message => { if (message?.action === 'cancel') process.exit(130); });
process.on('disconnect', () => process.exit(130));
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const cli = process.argv[2];
const playwrightRequire = createRequire(cli);
const { program } = playwrightRequire('./lib/program');
// Keep IPC alive until the asynchronous CLI action and cache validation complete.
program.parseAsync([process.execPath, cli, ...process.argv.slice(3)]).then(() => {
  if (process.exitCode) process.exit(process.exitCode);
  const coreRequire = createRequire(playwrightRequire.resolve('playwright-core/package.json'));
  const { registry: { registry } } = coreRequire('./lib/coreBundle');
  for (const name of ['chromium', 'chromium-headless-shell']) {
    const executable = registry.findExecutable(name).executablePath();
    if (!executable || !fs.existsSync(executable) || !fs.existsSync(path.join(registry.findExecutable(name).directory, 'INSTALLATION_COMPLETE'))) throw Error(`Browser installation is incomplete: ${name}`);
  }
  process.exit(0);
}).catch(error => { console.error(error.message); process.exit(1); });
