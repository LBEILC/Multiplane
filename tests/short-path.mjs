import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTempDirectory } from './helpers.mjs';

export function windowsShortPath(directory) {
  const short = execFileSync('powershell.exe', ['-NoProfile', '-Command', `
    Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public class ShortPath { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathName(string path, StringBuilder result, uint size); }';
    $result = New-Object System.Text.StringBuilder 32768;
    if ([ShortPath]::GetShortPathName($env:MULTIPLANE_SHORT_PATH, $result, 32768) -eq 0) { throw 'GetShortPathName failed'; }
    $result.ToString()
  `], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, MULTIPLANE_SHORT_PATH: directory }
  }).trim();
  return short;
}

// Mock only the OS boundary; helpers still perform real creation and resolution.
export async function useShortTempDirectory(t) {
  const work = createTempDirectory('multiplane-short-temp-');
  t.after(() => rm(work, { recursive: true, force: true }));
  const long = path.join(work, 'Long system temporary directory');
  await mkdir(long);
  const short = windowsShortPath(long);
  if (!path.basename(short).includes('~')) {
    t.skip('The temporary volume does not provide an 8.3 alias for the long directory');
    return null;
  }
  t.mock.method(os, 'tmpdir', () => short);
  return { long, short };
}
