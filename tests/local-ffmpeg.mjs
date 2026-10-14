import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Tests and verification tools isolate the user directory, so an FFmpeg path saved in the
// real user config is invisible to them. When FFmpeg is not on PATH, take it from the
// untracked, per-machine `.local/test-env.json` ({ "ffmpeg": "<path to ffmpeg executable>" })
// and put its directory first on PATH for this process and its children. A git worktree
// falls back to the main checkout's `.local/`, so worktrees need no copy of their own.
export function ensureLocalFfmpeg() {
  const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const onPath = (process.env.PATH ?? '').split(path.delimiter).some(dir => dir && existsSync(path.join(dir, executable)));
  if (onPath) return;
  const root = fileURLToPath(new URL('../', import.meta.url));
  const roots = [root];
  try {
    const gitdir = readFileSync(path.join(root, '.git'), 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1].trim();
    const marker = gitdir && gitdir.replaceAll('\\', '/').lastIndexOf('/.git/worktrees/');
    if (marker > 0) roots.push(gitdir.slice(0, marker));
  } catch {}
  let ffmpeg;
  for (const base of roots) {
    try { ffmpeg = JSON.parse(readFileSync(path.join(base, '.local', 'test-env.json'), 'utf8')).ffmpeg; break; } catch {}
  }
  if (typeof ffmpeg === 'string' && existsSync(ffmpeg)) process.env.PATH = path.dirname(ffmpeg) + path.delimiter + process.env.PATH;
  else console.error(`FFmpeg is not on PATH. Steps that encode video will fail. Put {"ffmpeg": "<path to ${executable}>"} in .local/test-env.json (not tracked by git) or add FFmpeg to PATH.`);
}
