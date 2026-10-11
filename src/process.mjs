// FFmpeg has no descendants; wait for its streams to close before cleaning files.
export function stopChild(child, graceMs = 2000) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
