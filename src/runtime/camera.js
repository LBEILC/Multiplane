(function () {
  const E = Shot.ease;

  function interp(a, b, k) {
    const s = a.s * Math.pow(b.s / a.s, k);
    if (b.s >= a.s) {
      const px = (b.f[0] - a.f[0]) * a.s * (1 - k);
      const py = (b.f[1] - a.f[1]) * a.s * (1 - k);
      return { f: [b.f[0] - px / s, b.f[1] - py / s], s };
    }
    const px = (a.f[0] - b.f[0]) * b.s * k;
    const py = (a.f[1] - b.f[1]) * b.s * k;
    return { f: [a.f[0] - px / s, a.f[1] - py / s], s };
  }

  function track(keys) {
    function at(t) {
      if (t <= keys[0].t) return { f: keys[0].f, s: keys[0].s };
      for (let i = 1; i < keys.length; i++) {
        const a = keys[i - 1], b = keys[i];
        if (b.t === a.t) continue;
        if (t < b.t) return interp(a, b, (b.ease || E.inOutCubic)((t - a.t) / (b.t - a.t)));
      }
      const z = keys[keys.length - 1];
      return { f: z.f, s: z.s };
    }
    return {
      at,
      apply(node, t, w = Shot.size.w, h = Shot.size.h) {
        const { f, s } = at(t);
        node.setAttribute('transform', `translate(${w / 2} ${h / 2}) scale(${s}) translate(${-f[0]} ${-f[1]})`);
      },
    };
  }

  window.Camera = { track, linear: k => k };
})();
