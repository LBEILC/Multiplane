import { spawn } from 'node:child_process';
import { rename, stat, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import { stopChild } from './process.mjs';
import { writeFrame } from './video-pipe.mjs';
import { MultiplaneError } from './errors.mjs';
import { fileDigest } from './input-records.mjs';

function childProcess(ffmpeg, args, events, input = false) {
  events.check();
  const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args],
    { windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  let stderr = '', stdout = '', failure;
  const unsubscribe = events.onCancel(() => stopChild(child));
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8000); });
  child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-8000); });
  child.stdin?.on('error', error => { failure = error; });
  const finished = new Promise((resolve, reject) => {
    child.once('error', cause => reject(new MultiplaneError('encode_failed', undefined, { cause })));
    child.once('close', code => {
      unsubscribe();
      if (code === 0) resolve(stdout);
      else reject(new MultiplaneError('encode_failed', undefined, { details: { exitCode: code, stderr } }));
    });
  });
  finished.catch(error => { failure = error; });
  return { child, finished, async write(bytes) {
    try {
      if (failure) throw failure;
      await writeFrame(child.stdin, bytes);
    } catch (cause) {
      throw cause instanceof MultiplaneError ? cause : new MultiplaneError('encode_failed', undefined,
        { cause, details: { reason: cause.message } });
    }
  } };
}

export function segmentEncoder({ ffmpeg, directory, index, first, end, width, height, rate, encoding, format, events, store, hook }) {
  const file = `segment-${String(index).padStart(6, '0')}.${format}`;
  const temporary = path.join(directory, file + '.partial.' + format);
  const encoder = childProcess(ffmpeg, ['-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${width}x${height}`,
    '-framerate', rate.argument, '-i', 'pipe:0', '-an', ...encoding.args, '-fps_mode', 'passthrough',
    '-pix_fmt', encoding.pixelFormat, ...encoding.mux, temporary], events, true);
  return { ...encoder, async seal(extra = {}) {
    encoder.child.stdin.end();
    await encoder.finished;
    events.check();
    const probe = childProcess(ffmpeg, ['-i', temporary, '-map', '0:v:0', '-an', '-c', 'copy', '-f', 'null', '-', '-progress', 'pipe:1'], events);
    const output = await probe.finished;
    const frames = Number([...output.matchAll(/^frame=(\d+)/gm)].at(-1)?.[1]);
    if (frames !== end - first) throw new MultiplaneError('output_invalid', 'Segment frame count differs.', { details: { expected: end - first, frames } });
    const handle = await open(temporary, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    await hook?.('beforeSeal', index);
    await rename(temporary, path.join(directory, file));
    const segment = { file, first, end, bytes: (await stat(path.join(directory, file))).size,
      sha256: await fileDigest(path.join(directory, file)), ...extra };
    store.manifest.segments = store.manifest.segments.filter(item => item.first !== first).concat(segment).sort((a, b) => a.first - b.first);
    store.save();
    await hook?.('sealed', index);
    return segment;
  } };
}

export async function assembleSegments({ ffmpeg, directory, manifest, temporary, encoding, rate, audioOffset, events }) {
  const segments = [...manifest.segments].sort((a, b) => a.first - b.first);
  const { options, first, total } = manifest;
  if (segments.length === 1 && !options.audio) {
    const source = path.join(directory, segments[0].file);
    try { await rename(source, temporary); return source; }
    catch (error) {
      if (error.code !== 'EXDEV') throw error;
      const { copyFile } = await import('node:fs/promises');
      await copyFile(source, temporary);
      return;
    }
  }
  const list = path.join(directory, 'concat.txt');
  // Relative generated names avoid quoting user paths in the concat language.
  await writeFile(list, segments.map(segment => `file '${segment.file}'\nduration ${rate.seconds(segment.end - segment.first)}\n`).join(''));
  const input = segments.length === 1 ? ['-i', path.join(directory, segments[0].file)] : ['-f', 'concat', '-safe', '1', '-i', list];
  const audio = options.audio ? ['-i', options.audio, '-map', '0:v:0', '-map', '1:a:0', '-af',
    `atrim=start=${audioOffset + rate.seconds(first)},asetpts=PTS-STARTPTS,apad,atrim=duration=${rate.seconds(total)}`, ...encoding.audio] : ['-map', '0:v:0', '-an'];
  await childProcess(ffmpeg, [...input, ...audio, '-c:v', 'copy', ...encoding.mux, temporary], events).finished;
}
