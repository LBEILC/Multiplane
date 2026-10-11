import path from 'node:path';
import { writeFile, rename, rm } from 'node:fs/promises';
import sharp from 'sharp';

export function createPreview(events, width, height, { enabled = true, now = () => performance.now() } = {}) {
  let last = -Infinity, failed = false;
  return async (pixels, frame) => {
    if (!enabled || failed || now() - last < 2000) return;
    const file = path.join(events.directory, 'preview.png'), temporary = file + '.tmp';
    try {
      const png = await sharp(pixels, { raw: { width, height, channels: 4 } })
        .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      await writeFile(temporary, png);
      await rename(temporary, file);
      events.preview(frame);
      last = now();
    } catch {
      failed = true;
      await rm(temporary, { force: true }).catch(() => {});
      events.warning({ code: 'preview_failed', message: 'Preview could not be written; further preview updates are disabled.' });
    }
  };
}
