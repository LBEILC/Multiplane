export function selectMainWindow(pages) {
  const matches = pages.filter(page => {
    try { const url = new URL(page.url()); return url.protocol === 'file:' && url.pathname.endsWith('/index.html'); }
    catch { return false; }
  });
  if (matches.length > 1) throw Error('Multiple main application pages');
  return matches[0];
}

export async function waitForMainWindow(pages, { timeout = 30000, interval = 100, now = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const start = now();
  do {
    const page = selectMainWindow(pages());
    if (page) return page;
    if (now() - start >= timeout) throw Error('Main application page did not load');
    await sleep(interval);
  } while (true);
}
