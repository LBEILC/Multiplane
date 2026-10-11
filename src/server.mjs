import http from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = process.cwd();
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json' };
const inside = (base, target) => { const relative = path.relative(base, target); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };

export async function startServer(port = 0, root = process.cwd()) {
  const base = await realpath(root);
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

      const segments = pathname.replaceAll('\\', '/').split('/');
      if (segments.some(p => p.startsWith('.') || p === 'node_modules')) { res.writeHead(403); return res.end(); }
      let resourceRoot = root, resourceBase = base, resourcePath = pathname;
      // /multiplane/ is reserved for runtime resources.
      if (pathname.startsWith('/multiplane/')) {
        if (pathname.startsWith('/multiplane/runtime/')) { resourceRoot = path.join(packageRoot, 'src/runtime'); resourcePath = pathname.slice('/multiplane/runtime'.length); }
        else if (pathname === '/multiplane/three.js') { resourceRoot = path.join(packageRoot, 'src/three'); resourcePath = '/index.js'; }
        else if (pathname.startsWith('/multiplane/vendor/three/')) {
          resourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve('three'))));
          resourcePath = pathname.slice('/multiplane/vendor/three'.length);
          if (!/^\/(build|examples\/jsm)\/.*\.js$/.test(resourcePath)) { res.writeHead(403); return res.end(); }
        } else { res.writeHead(404); return res.end(); }
        resourceBase = await realpath(resourceRoot);
      }
      let target = path.resolve(resourceRoot, `.${resourcePath}`);
      if (!inside(resourceRoot, target)) { res.writeHead(403); return res.end(); }
      if ((await stat(target)).isDirectory()) target = path.join(target, 'index.html');
      target = await realpath(target);
      if (!inside(resourceBase, target)) { res.writeHead(403); return res.end(); }
      const info = await stat(target);
      const contentType = { '.wav': 'audio/wav', '.srt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4' }[path.extname(target)] ?? mime[path.extname(target)] ?? 'application/octet-stream';
      const headers = { 'Content-Type': contentType, 'Content-Length': info.size, 'Accept-Ranges': 'bytes' };
      if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        let start = match?.[1] ? Number(match[1]) : Math.max(0, info.size - Number(match?.[2]));
        let end = match?.[1] && match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
        if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || start < 0 || start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end();
        }
        res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${info.size}` });
        if (req.method === 'HEAD') return res.end();
        return createReadStream(target, { start, end }).on('error', () => res.destroy()).pipe(res);
      }
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      createReadStream(target).on('error', () => res.destroy()).pipe(res);
    } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND') { res.writeHead(503, { 'x-multiplane-error': 'three_not_installed' }); return res.end('Optional three.js is not installed.'); }
      res.writeHead(error.code === 'ENOENT' ? 404 : 400);
      res.end('Cannot read the requested file.');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
