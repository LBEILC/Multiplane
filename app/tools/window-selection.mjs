// Frameless tray popovers may share the main window's title and AX role.
export function selectWindowCandidate(candidates, { pid, title, requireWindowControls = false }) {
  const matches = candidates.filter(c => c.pid === pid && c.title === title && c.role === 'AXWindow' && (!requireWindowControls || c.hasWindowControls === true));
  return matches.length === 1 ? matches[0] : null;
}

export async function runAccessibilityAction(invoke, target, action, method, check, {
  timeout = 10000, interval = 100, now = () => performance.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  const start = now();
  const evidence = { action, target, attempts: [] };
  (check.windowSelections ??= []).push(evidence);
  do {
    const listing = await invoke('windows');
    if (!Array.isArray(listing.candidates)) throw Error('Invalid AX window listing');
    const selected = selectWindowCandidate(listing.candidates, target);
    evidence.attempts.push({ candidates: listing.candidates, selected: selected ?? null });
    if (selected) {
      // The helper revalidates the index, title and uniqueness in a fresh AX tree.
      const result = await invoke(action, method, selected.index);
      if (result.kind !== 'window-selection-pending') {
        evidence.status = 'selected';
        return result;
      }
      evidence.attempts.push({ candidates: result.candidates, selected: null });
    }
    if (now() - start >= timeout) break;
    await sleep(interval);
  } while (true);
  evidence.status = 'timeout';
  throw Error(`AX main window selection timed out for ${action}: ${JSON.stringify(evidence)}`);
}
