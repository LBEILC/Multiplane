import { realpath, realpathSync } from 'node:fs';
import { promisify } from 'node:util';

// Match the renderer's native filesystem resolution, including Windows 8.3 aliases.
// Keep synchronous fixture creation synchronous and existing-path errors intact.
export const nativeRealpath = promisify(realpath.native);
export const nativeRealpathSync = realpathSync.native;
