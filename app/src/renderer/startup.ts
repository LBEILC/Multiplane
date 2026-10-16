/** One-shot startup presentation; subsequent snapshots never restart the animation. */
export class Startup {
  ready = false;
  private finishing = false;
  private shownAt = 0;
  private timer: ReturnType<typeof setTimeout>;
  constructor(private enter: () => void) {
    this.timer = setTimeout(() => {
      this.shownAt = performance.now();
      document.body.classList.add('boot-waiting');
    }, 300);
  }
  finish() {
    if (this.ready || this.finishing) return;
    this.finishing = true; clearTimeout(this.timer);
    const enter = () => {
      this.ready = true;
      document.querySelector('.boot-wait')?.remove();
      document.body.classList.remove('boot');
      document.body.classList.add('boot-in');
      this.enter();
      document.querySelectorAll<HTMLElement>('#list .job').forEach((el, i) => el.style.setProperty('--boot-i', String(Math.min(i, 8))));
      setTimeout(() => document.body.classList.remove('boot-in'), 400);
    };
    if (!this.shownAt) { enter(); return; }
    setTimeout(() => {
      document.body.classList.remove('boot-waiting');
      setTimeout(enter, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 120);
    }, Math.max(0, 500 - (performance.now() - this.shownAt)));
  }
}
