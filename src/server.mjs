import { normalizeResourcePath, isInsideResourceRoot } from './resource-path.mjs';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MultiplaneError, invalidOption } from './errors.mjs';
import { resolveThree } from './three-package.mjs';
import { recordInput } from './input-records.mjs';

export const root = process.cwd();
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json' };

export async function startServer(port = 0, root = process.cwd()) {
  if (typeof root !== 'string' || !root.trim()) throw invalidOption('--root', '--root must be a directory path.');
  if (!String(port).trim() || !Number.isInteger(Number(port)) || Number(port) < 0 || Number(port) > 65535) throw invalidOption('--port', '--port must be an integer from 0 to 65535.');
  port = Number(port);
  const base = await normalizeResourcePath(root);
  try { if (!(await stat(base)).isDirectory()) throw new Error(); }
  catch { throw invalidOption('--root', '--root must be an existing directory.'); }
  root = base;
  async function shots(directory = base, ancestors = new Set()) {
    const canonical = await normalizeResourcePath(directory);
    if (ancestors.has(canonical) || !await isInsideResourceRoot(base, canonical)) return [];
    const parents = new Set([...ancestors, canonical]), found = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ['node_modules', 'out'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (!await isInsideResourceRoot(base, file)) continue;
      let info;
      try { info = await stat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (info.isDirectory()) found.push(...await shots(file, parents));
      else if (info.isFile() && path.extname(file).toLowerCase() === '.html') found.push(path.relative(base, file).split(path.sep).join('/'));
    }
    return found;
  }
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
        if (pathname === '/multiplane/shots.json') {
          const body = JSON.stringify((await shots()).sort());
          res.writeHead(200, { 'Content-Type': mime['.json'], 'Content-Length': Buffer.byteLength(body) });
          return res.end(req.method === 'HEAD' ? undefined : body);
        }
        if (pathname.startsWith('/multiplane/runtime/')) { resourceRoot = path.join(packageRoot, 'src/runtime'); resourcePath = pathname.slice('/multiplane/runtime'.length); }
        else if (pathname === '/multiplane/three.js') { resourceRoot = path.join(packageRoot, 'src/three'); resourcePath = '/index.js'; }
        else if (pathname.startsWith('/multiplane/vendor/three/')) {
          resourceRoot = (await resolveThree()).root;
          resourcePath = pathname.slice('/multiplane/vendor/three'.length);
          if (!/^\/(build|examples\/jsm)\/.*\.js$/.test(resourcePath)) { res.writeHead(403); return res.end(); }
        } else { res.writeHead(404); return res.end(); }
        resourceBase = await normalizeResourcePath(resourceRoot);
      }
      let target = path.resolve(resourceRoot, `.${resourcePath}`);
      if (!await isInsideResourceRoot(resourceRoot, target)) { res.writeHead(403); return res.end(); }
      let targetInfo;
      try { targetInfo = await stat(target); }
      catch (error) {
        if (pathname === '/favicon.ico' && error.code === 'ENOENT') { res.writeHead(204); return res.end(); }
        throw error;
      }
      if (targetInfo.isDirectory()) target = path.join(target, 'index.html');
      target = await normalizeResourcePath(target);
      if (!await isInsideResourceRoot(resourceBase, target)) { res.writeHead(403); return res.end(); }
      const info = await stat(target);
      const recorded = await recordInput(target);
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
        if (recorded) return res.end(recorded.subarray(start, end + 1));
        return createReadStream(target, { start, end }).on('error', () => res.destroy()).pipe(res);
      }
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      if (recorded) return res.end(recorded);
      createReadStream(target).on('error', () => res.destroy()).pipe(res);
    } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND') { res.writeHead(503, { 'x-multiplane-error': 'three_not_installed' }); return res.end('Optional three.js is not installed.'); }
      res.writeHead(error.code === 'ENOENT' ? 404 : 400);
      res.end('Cannot read the requested file.');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); })
    .catch(cause => { if (cause.code === 'EADDRINUSE') throw new MultiplaneError('port_in_use', undefined, { cause }); throw cause; });
  return { url: `http://127.0.0.1:${server.address().port}`, root: base, port: server.address().port,
    close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
