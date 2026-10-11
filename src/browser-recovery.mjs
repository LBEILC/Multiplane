import { MultiplaneError } from './errors.mjs';

export const MAX_BROWSER_RESTARTS = 2;
export const recoveryBudget = () => new Int32Array(new SharedArrayBuffer(4));

// Playwright includes bounded browser logs on transport errors. Never retain the
// launch command (which also contains local profile paths) in public diagnostics.
export function crashDetails(error, t) {
  const messages = [], seen = new Set();
  for (let e = error; e && !seen.has(e); e = e.cause) { seen.add(e); messages.push(e.message ?? String(e)); }
  const log = messages.join('\n');
  const exit = log.match(/process did exit: exitCode=([^,\s]+), signal=([^\s>]+)/);
  const stderr = log.split(/\r?\n/).filter(line => /\[err\]/.test(line) && !line.includes('<launching>')).slice(-20).join('\n').slice(-4000);
  return { ...(t === undefined ? {} : { t }), reason: (messages.at(-1) ?? 'Browser closed unexpectedly').split(/\r?\n/)[0].slice(0, 500),
    ...(exit ? { exitCode: exit[1] === 'null' ? null : Number(exit[1]), signal: exit[2] === 'null' ? null : exit[2] } : {}),
    ...(stderr ? { stderr } : {}) };
}

export function browserClosed(error, browser, page, crashed = false) {
  if (error?.code === 'render_threw' || error?.code === 'cancelled') return false;
  return crashed || page?.isClosed() || (browser && !browser.isConnected())
    || /Target (?:page, context or browser|closed)|(?:Page|Browser|Connection|Session) closed|Page crashed|Target crashed|browser has disconnected/i.test(error?.message ?? '')
    || (error?.cause && browserClosed(error.cause, browser, page, crashed));
}

export const crashedError = (error, t) => new MultiplaneError('browser_crashed', undefined, { cause: error, details: crashDetails(error, t) });
