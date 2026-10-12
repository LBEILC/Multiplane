import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { decodeNativePNG } from './png-native.mjs';
import { MultiplaneError } from './errors.mjs';
import { stopChild } from './process.mjs';

export function probeVideo(ffmpeg, file, events, spawnProcess = spawn, options = {}) {
  return new Promise((resolve, reject) => {
    // Decode into the null sink; no media file is written or encoded.
    const child = spawnProcess(ffmpeg, ['-hide_banner', '-nostdin', '-nostats', ...(options.alpha && options.format === 'webm' ? ['-c:v', 'libvpx-vp9'] : []), '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'showinfo=checksum=0', '-af', 'ashowinfo', '-fps_mode', 'passthrough', '-f', 'null', '-'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const unsubscribe = events?.onCancel?.(() => stopChild(child));
    let buffer = '', frames = 0, minTime = Infinity, maxTime = -Infinity, audioStart = Infinity, audioEnd = -Infinity;
    let width, height, fps, codec, pixelFormat, timeBase;
    let input = true, hasAudio = false;
    const line = text => {
      if (text.startsWith('Stream mapping:')) input = false;
      if (input && !codec) codec = text.match(/Stream #0:\d+.*Video: (\w+)/)?.[1];
      if (input && /Stream #0:\d+.*Audio:/.test(text)) hasAudio = true;
      if (text.includes('Parsed_showinfo')) {
        const rate = text.match(/config in time_base:\s*(\d+)\/(\d+), frame_rate:\s*(\d+)\/(\d+)/);
        if (rate) { timeBase = Number(rate[1]) / Number(rate[2]); fps = Number(rate[3]) / Number(rate[4]); }
        const frame = text.match(/\bn:\s*\d+\s+pts:\s*(-?\d+)\s+pts_time:.*?fmt:(\S+).*?\bs:(\d+)x(\d+)/);
        if (frame) {
          frames++;
          const t = Number(frame[1]) * timeBase;
          const duration = Number(text.match(/\bduration:\s*(\d+)/)?.[1]) * timeBase;
          minTime = Math.min(minTime, t); maxTime = Math.max(maxTime, t + (duration > 0 ? duration : 1 / fps));
          pixelFormat = frame[2]; width = Number(frame[3]); height = Number(frame[4]);
        }
      }
      if (text.includes('Parsed_ashowinfo')) {
        const audio = text.match(/pts_time:([\d.e+-]+).*?rate:(\d+).*?nb_samples:(\d+)/);
        if (audio) { audioStart = Math.min(audioStart, Number(audio[1])); audioEnd = Math.max(audioEnd, Number(audio[1]) + Number(audio[3]) / Number(audio[2])); }
      }
    };
    child.stderr.on('data', bytes => {
      buffer += bytes.toString();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      if (buffer.length > 65536) buffer = buffer.slice(-65536);
    });
    child.once('error', reject);
    child.once('close', code => {
      unsubscribe?.(); line(buffer);
      if (code !== 0) return reject(new Error(`FFmpeg probe exited with code ${code}.`));
      if (!frames || !width || !height || !Number.isFinite(fps) || fps <= 0 || !Number.isFinite(maxTime - minTime) || maxTime <= minTime || !codec || !pixelFormat) return reject(new Error('FFmpeg probe output could not be parsed.'));
      if (hasAudio && (!Number.isFinite(audioEnd - audioStart) || audioEnd <= audioStart)) return reject(new Error('FFmpeg audio duration could not be parsed.'));
      resolve({ frames, durationSeconds: maxTime - minTime, width, height, fps, codec, pixelFormat,
        // TODO(design): Document the optional audioDurationSeconds field.
        ...(Number.isFinite(audioEnd) ? { audioDurationSeconds: audioEnd - audioStart } : {}) });
    });
  });
}

export async function checkVideo(ffmpeg, file, expected, events, probe = probeVideo) {
  let actual;
  try { actual = await probe(ffmpeg, file, events, undefined, expected); }
  catch (error) {
    events.check();
    if (expected.alpha) throw new MultiplaneError('output_invalid', 'Transparent output could not be verified.', { cause: error });
    events.warning({ code: 'output_unverified', message: 'Output could not be verified.', details: { reason: error.message } });
    return { verified: false, frames: null, durationSeconds: null, width: null, height: null, fps: null, codec: null, pixelFormat: null };
  }
  events.check();
  const durationPrecision = 8 * Number.EPSILON * Math.max(1, expected.durationSeconds, actual.durationSeconds);
  const mismatch = ['frames', 'width', 'height'].some(key => actual[key] !== expected[key])
    || Math.abs(actual.fps - expected.fps) > 1e-6
    || Math.abs(actual.durationSeconds - expected.durationSeconds) - 1 / expected.fps > durationPrecision;
  if (expected.alpha && !/^(yuva|gbrap|rgba|bgra|argb|abgr)/.test(actual.pixelFormat)) throw new MultiplaneError('output_invalid', 'Decoded output has no alpha channel.', { details: { actual } });
  if (mismatch) throw new MultiplaneError('output_invalid', undefined, { details: { expected, actual } });
  return { verified: true, ...actual };
}

export async function checkStill(file, expected) {
  let actual = { width: null, height: null };
  try {
    const decoded = await decodeNativePNG(await readFile(file));
    actual = { width: decoded.width, height: decoded.height };
    if (actual.width === expected.width && actual.height === expected.height) return;
  } catch {}
  await rm(file, { force: true });
  throw new MultiplaneError('output_invalid', 'Still image could not be decoded or has incorrect dimensions.', { details: { expected, actual } });
}
