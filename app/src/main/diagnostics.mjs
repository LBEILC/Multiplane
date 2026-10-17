import path from 'node:path';
import { constants } from 'node:fs';
import { open, readdir, readFile, rename, appendFile, rm, copyFile, stat } from 'node:fs/promises';

// Read backwards so a large native crash log does not enter the desktop snapshot.
export async function errorTail(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    let position = (await handle.stat()).size, bytes = Buffer.alloc(0);
    while (position > 0) {
      const size = Math.min(position, 8192); position -= size;
      const chunk = Buffer.alloc(size);
      const { bytesRead } = await handle.read(chunk, 0, size, position);
      bytes = Buffer.concat([chunk.subarray(0, bytesRead), bytes]);
      if (bytes.toString('utf8').split('\n').length > 21) break;
    }
    const text = bytes.toString('utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
    return text.trim() ? text.split('\n').slice(-20).join('\n') : '';
  } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  finally { await handle?.close(); }
}

// The stdout/index pair survives desktop exit and identifies the new resume job.
const pending = new Map();
export function retainResumeLog(directory, records, finished = false) {
  const operation = (pending.get(directory) ?? Promise.resolve()).catch(() => {}).then(() => transfer(directory, records, finished));
  pending.set(directory, operation);
  return operation.finally(() => { if (pending.get(directory) === operation) pending.delete(directory); });
}
async function transfer(directory, records, finished) {
  const source = path.join(directory, 'stderr.log');
  try { await stat(source); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  let rows;
  try { rows = (await readFile(path.join(directory, 'stdout.jsonl'), 'utf8')).split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const event = rows.find(e => e.schema === 'multiplane/1' && e.command === 'render' && records.has(e.jobId));
  if (!event) return false;
  const target = path.join(records.get(event.jobId).jobDir, 'stderr.log');
  try {
    // Hosted executors already write here; merge the waiter's diagnostics only at exit.
    const existing = await open(target, 'r').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing) {
      await existing.close();
      if (!finished) return false;
      await appendFile(target, await readFile(source));
      await rm(source);
    } else {
      try { await rename(source, target); }
      catch (error) {
        if (error.code !== 'EXDEV') throw error;
        if (!finished) return false;
        await copyFile(source, target, constants.COPYFILE_EXCL);
        await rm(source);
      }
    }
    return true;
  } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
export async function resumeRecords(home) {
  const records = new Map();
  for (const name of ['jobs.1.jsonl', 'jobs.jsonl']) {
    const text = await readFile(path.join(home, name), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    for (const line of text.split('\n')) {
      try { const r = JSON.parse(line); if (r.schema === 'multiplane/1' && typeof r.jobId === 'string' && typeof r.jobDir === 'string' && path.isAbsolute(r.jobDir)) records.set(r.jobId, r); } catch {}
    }
  }
  return records;
}
export async function recoverResumeLogs(home, records, finished = false) {
  const base = path.join(home, 'desktop-resume');
  const names = await readdir(base).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of names.filter(n => n.startsWith('attempt-'))) await retainResumeLog(path.join(base, name), records, finished);
}
