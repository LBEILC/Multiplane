import { MultiplaneError, asError } from './errors.mjs';
import { parentPort, workerData, isMarkedAsUntransferable } from 'node:worker_threads';
import { openShot } from './capture.mjs';
import { createPostCapture, resolveScale } from './post.mjs';

let capture, closing = false, running = false;
const sendFailure = error => {
  const failure = asError(error);
  parentPort.postMessage({ type: 'failure', error: failure.message, code: failure.code, details: failure.details, hint: failure.hint });
};
async function close() {
  closing = true;
  if (running) return;
  await capture?.close();
  parentPort.close();
}
try {
  capture = await openShot(workerData.shot, resolveScale(workerData.options).renderScale, workerData.options);
  if (workerData.size && (capture.width !== workerData.size.width || capture.height !== workerData.size.height)) throw new MultiplaneError('internal_error', 'Worker stage dimensions differ from the main process.');
  const processed = createPostCapture(capture, workerData.options, workerData.fps);
  parentPort.on('message', async message => {
    if (message.type === 'cancel') { closing = true; await capture?.close(); if (!running) parentPort.close(); return; }
    if (message.type === 'close') { await close(); return; }
    if (closing) return;
    running = true;
    try {
      const frames = [], hashes = [], before = { ...processed.stats };
      for (let frame = message.first; frame < message.end && !closing; frame++) {
        const result = await processed.frame(frame / workerData.fps, frame);
        const png = result.byteOffset === 0 && result.byteLength === result.buffer.byteLength && !isMarkedAsUntransferable(result.buffer)
          ? new Uint8Array(result.buffer) : Uint8Array.from(result);
        frames.push(png);
        if (workerData.options.verify) hashes.push(processed.lastHash);
      }
      const stats = Object.fromEntries(Object.entries(processed.stats).map(([key, value]) => [key, value - before[key]]));
      if (!closing) parentPort.postMessage({ type: 'frames', first: message.first, frames, hashes, stats }, frames.map(f => f.buffer));
    } catch (error) {
      sendFailure(error); closing = true;
    } finally {
      running = false;
      if (closing) await close();
    }
  });
  parentPort.postMessage({ type: 'ready' });
} catch (error) {
  sendFailure(error);
  await close();
}
