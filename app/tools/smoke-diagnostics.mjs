import path from 'node:path';

export function privacyMasks(page) {
  // Mask the path text, never its sibling reveal button.
  return ['.path-value > .mono', '.check-detail', ':lang(en) .check-row .check-status', '.info-row .mono', '[data-host-card] .mono', '.path-input', '.setting-row small .mono'].map(selector => page.locator(selector));
}

export async function captureFailure(page, out, error) {
  const failure = { message: error.message };
  if (!page || page.isClosed()) return { ...failure, diagnosticError: 'No live renderer page' };
  try {
    Object.assign(failure, await page.evaluate(() => ({
      page: document.querySelector('[data-page][aria-current="page"]')?.getAttribute('data-page') ?? document.querySelector('#heading')?.textContent ?? null,
      heading: document.querySelector('#heading')?.textContent ?? null,
      dataset: { ...document.documentElement.dataset }
    })));
    const session = await page.context().newCDPSession(page);
    try {
      // Chromium computes names including aria-label / aria-labelledby and hidden descendants.
      const { nodes } = await session.send('Accessibility.getFullAXTree');
      failure.buttons = nodes.filter(node => !node.ignored && ['button', 'switch', 'tab'].includes(node.role?.value))
        .map(node => ({ role: node.role.value, name: node.name?.value ?? '' }));
    } finally { await session.detach(); }
  } catch (error) { failure.diagnosticError = error.message; }
  try {
    const file = 'failure.png';
    await page.screenshot({ path: path.join(out, file), mask: privacyMasks(page), timeout: 5000 });
    failure.screenshot = file;
  } catch (error) { failure.screenshotError = error.message; }
  return failure;
}
