(function () {
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') || 'standalone';
  const stage = document.getElementById('stage');
  const css = stage && getComputedStyle(stage);
  const size = css ? { w: parseFloat(css.width), h: parseFloat(css.height) } : { w: 1920, h: 1080 };

  const E = {
    clamp: (x, a = 0, b = 1) => Math.min(b, Math.max(a, x)),
    lerp: (a, b, k) => a + (b - a) * k,
    prog: (t, start, dur) => E.clamp((t - start) / dur),
    inCubic: k => k * k * k,
    outCubic: k => 1 - Math.pow(1 - k, 3),
    outQuart: k => 1 - Math.pow(1 - k, 4),
    outExpo: k => (k >= 1 ? 1 : 1 - Math.pow(2, -10 * k)),
    inOutCubic: k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
    inOutQuart: k => (k < 0.5 ? 8 * k ** 4 : 1 - Math.pow(-2 * k + 2, 4) / 2),
  };

  function fitStage(stage) {
    if (mode === 'render') return;
    const s = Math.min(innerWidth / size.w, innerHeight / size.h);
    const x = (innerWidth - size.w * s) / 2;
    const y = (innerHeight - size.h * s) / 2;
    stage.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
  }

  // spec: { duration, fps?, fonts?: [[font, text?]...], setup?(), render(t) }
  function define(spec) {
    const stage = document.getElementById('stage');
    document.documentElement.dataset.mode = mode;
    fitStage(stage);
    addEventListener('resize', () => fitStage(stage));

    const fontLoads = (spec.fonts || []).map(([f, text]) => document.fonts.load(f, text));
    const ready = Promise.all(fontLoads)
      .then(() => document.fonts.ready)
      .then(() => (spec.setup ? spec.setup() : null))
      .then(() => spec.render(0));

    window.SHOT = {
      get duration() { return spec.duration; },
      fps: spec.fps || 30,
      get cuts() { return spec.cuts || []; },
      post: spec.post || {},
      ready,
      ...(spec.blurAt ? { blurAt: t => spec.blurAt(t) } : {}),
      render: t => spec.render(Math.min(Math.max(t, 0), spec.duration)),
    };

    if (mode === 'standalone') {
      ready.then(() => {
        const fixed = params.get('t');
        if (fixed !== null) return window.SHOT.render(+fixed);
        const t0 = performance.now();
        const loop = now => {
          const t = ((now - t0) / 1000) % (spec.duration + 1);
          window.SHOT.render(t);
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });
    }
  }

  window.Shot = { define, ease: E, mode, size };
})();
