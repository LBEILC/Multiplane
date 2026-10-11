// Adapted from DispatchDock's menu; maintained independently (REFERENCE_LICENSE).
let dismiss: (() => void) | undefined;
export function menu(anchor: HTMLElement, items: { label: string; selected: boolean; run: () => void }[]) {
  if (anchor.getAttribute('aria-expanded') === 'true') { dismiss?.(); return; }
  dismiss?.();
  const panel = document.createElement('div');
  panel.className = 'ctx scroll'; panel.id = 'filter-options';
  panel.setAttribute('role', 'listbox');
  panel.setAttribute('aria-label', anchor.getAttribute('aria-label')!);
  const buttons = items.map((item, index) => {
    const button = document.createElement('button');
    button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(item.selected));
    button.textContent = item.label; button.dataset.option = String(index); panel.append(button);
    return button;
  });
  document.body.append(panel);
  const r = anchor.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(innerWidth - panel.offsetWidth - 8, r.left))}px`;
  panel.style.top = `${Math.max(8, Math.min(innerHeight - panel.offsetHeight - 8, r.bottom + 4))}px`;
  anchor.setAttribute('aria-expanded', 'true'); anchor.setAttribute('aria-controls', panel.id);
  const close = () => {
    panel.remove(); anchor.setAttribute('aria-expanded', 'false'); anchor.removeAttribute('aria-controls');
    document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', close);
    anchor.focus({ preventScroll: true }); dismiss = undefined;
  };
  const outside = (e: PointerEvent) => { if (!panel.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
  dismiss = close;
  document.addEventListener('pointerdown', outside, true); window.addEventListener('resize', close);
  buttons.forEach((button, index) => button.onclick = () => { close(); items[index].run(); });
  panel.onkeydown = e => {
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); close(); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const n = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[n]?.focus();
    }
  };
  requestAnimationFrame(() => panel.classList.add('motion-open'));
  buttons[0]?.focus();
}
