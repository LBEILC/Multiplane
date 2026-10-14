import { verifiedFrames } from './static-reuse.mjs';
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
  capture = await openShot(workerData.shot, resolveScale(workerData.options).renderScale, { ...workerData.options, onWarning: warning => parentPort.postMessage({ type: 'warning', warning }), check: () => { if (closing) throw new MultiplaneError('cancelled'); } });
  if (workerData.size && (capture.width !== workerData.size.width || capture.height !== workerData.size.height)) throw new MultiplaneError('internal_error', 'Worker stage dimensions differ from the main process.');
  const processed = createPostCapture(capture, { ...workerData.options, onWarning: warning => parentPort.postMessage({ type: 'warning', warning }) }, workerData.fps);
  parentPort.on('message', async message => {
    if (message.type === 'cancel') { closing = true; await capture?.close(); if (!running) parentPort.close(); return; }
    if (message.type === 'close') { await close(); return; }
    if (closing) return;
    running = true;
    try {
      const frames = [], hashes = [], blurSamples = [], before = { ...processed.stats };
      const source = async function* (first, end) {
        for (let index = first; index < end && !closing; index++) {
          const frame = message.first + index;
          const png = await processed.frame(frame / workerData.fps, frame, index === end - 1);
          yield { png, hash: processed.lastHash, blurSamples: processed.lastBlurSamples };
        }
      };
      // RAW post output already owns an independent buffer. Keep it until the
      // interval audit, then transfer it without a second full-frame copy.
      for await (const item of verifiedFrames(source, workerData.options, message.end - message.first, { owned: workerData.options.transport === 'raw' })) {
        const result = item.png;
        const png = result.byteOffset === 0 && result.byteLength === result.buffer.byteLength && !isMarkedAsUntransferable(result.buffer)
          ? new Uint8Array(result.buffer) : Uint8Array.from(result);
        frames.push(png);
        blurSamples.push(item.blurSamples);
        if (workerData.options.verify) hashes.push(item.hash);
      }
      const stats = Object.fromEntries(Object.entries(processed.stats).map(([key, value]) => [key, value - before[key]]));
      if (!closing) parentPort.postMessage({ type: 'frames', first: message.first, frames, hashes, blurSamples, stats }, frames.map(f => f.buffer));
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
