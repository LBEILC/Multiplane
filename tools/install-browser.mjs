import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';

if (!process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD) {
  const require = createRequire(import.meta.url);
  const playwrightRequire = createRequire(require.resolve('playwright/package.json'));
  // Avoid taking Playwright's installation lock when both pinned browsers already exist.
  const { registry: { registry } } = playwrightRequire('playwright-core/lib/coreBundle');
  const installed = ['chromium', 'chromium-headless-shell'].every(name => existsSync(registry.findExecutable(name).executablePath()));
  if (installed) process.exit(0);
  const result = spawnSync(process.execPath, [path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js'), 'install', 'chromium'],
    { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (process.platform === 'linux') console.error('If Chromium cannot launch because system libraries are missing, run npx playwright install-deps chromium.');
  process.exitCode = result.status ?? 1;
}
