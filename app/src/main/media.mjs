import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm' };

// Authorization and extension restrictions remain with the protocol caller.
export async function mediaResponse(file, request) {
  const handle = await open(file, 'r');
  let streaming = false;
  try {
    const { size } = await handle.stat();
    const headers = new Headers({ 'Accept-Ranges': 'bytes', 'Content-Type': types[path.extname(file).toLowerCase()] });
    const range = request.headers.get('range');
    let start = 0, end = size - 1, status = 200;
    if (range !== null) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      let valid = !!match && !!(match[1] || match[2]) && size > 0;
      if (valid) {
        if (!match[1]) {
          const suffix = Number(match[2]);
          valid = Number.isSafeInteger(suffix) && suffix > 0;
          start = Math.max(0, size - suffix);
        } else {
          start = Number(match[1]);
          const requestedEnd = match[2] ? Number(match[2]) : end;
          valid = Number.isSafeInteger(start) && Number.isSafeInteger(requestedEnd) && start < size && requestedEnd >= start;
          end = Math.min(requestedEnd, end);
        }
      }
      if (!valid) {
        headers.set('Content-Range', `bytes */${size}`);
        headers.set('Content-Length', '0');
        return new Response(null, { status: 416, headers });
      }
      status = 206;
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    headers.set('Content-Length', String(Math.max(0, end - start + 1)));
    if (request.method === 'HEAD' || size === 0) return new Response(null, { status, headers });
    const stream = handle.createReadStream({ start, end, autoClose: true });
    const response = new Response(Readable.toWeb(stream, { strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength } }), { status, headers });
    streaming = true;
    return response;
  } finally {
    if (!streaming) await handle.close();
  }
}
