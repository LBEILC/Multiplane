// Wall time controls recovery only; it never enters frame generation.
export function createCaptureWatchdog(slots, onStall, { minimumMs = 120000, now = () => performance.now() } = {}) {
  let longestFrameMs = 0, stopped = false;
  const check = () => {
    if (stopped) return;
    const time = now(), threshold = Math.max(minimumMs, longestFrameMs * 10);
    for (const [worker, slot] of slots.entries()) {
      if (!slot.job || slot.recovering || time - slot.lastDelivery < threshold) continue;
      slot.recovering = true;
      onStall(slot, { worker, frame: slot.frame ?? slot.job.first, waitedSeconds: (time - slot.lastDelivery) / 1000 });
    }
  };
  const timer = setInterval(check, Math.min(1000, Math.max(10, minimumMs / 4)));
  timer.unref();
  return {
    check,
    completed(slot) {
      const time = now();
      if (slot.frameStarted !== undefined) longestFrameMs = Math.max(longestFrameMs, time - slot.frameStarted);
      slot.lastDelivery = time;
    },
    recovered(slot) {
      slot.recovering = false;
      slot.lastDelivery = now();
      slot.frameStarted = slot.lastDelivery;
    },
    stop() { stopped = true; clearInterval(timer); },
  };
}
