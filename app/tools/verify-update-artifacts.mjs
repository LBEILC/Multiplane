import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function referencedArtifactNames(metadata) {
  const names = new Set();
  for (const line of metadata.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:-\s*)?(?:url|path):\s*(.+?)\s*$/);
    if (!match) continue;
    let value = match[1];
    if (/^["']/.test(value) && value.at(-1) === value[0]) value = value.slice(1, -1);
    value = decodeURIComponent(value);
    if (!value || value === '.' || value === '..' || /[/\\:#?\r\n]/.test(value)) throw Error(`Invalid update artifact: ${value}`);
    names.add(value);
  }
  if (!names.size) throw Error('Update metadata has no artifact references');
  return [...names];
}
export function verifyUpdateArtifacts(directory) {
  const metadata = readFileSync(path.join(directory, 'latest.yml'), 'utf8');
  const names = referencedArtifactNames(metadata);
  if (!names.some(name => name.endsWith('.exe'))) throw Error('Windows update metadata has no installer');
  const required = new Set(names);
  for (const file of readdirSync(directory).filter(name => name.endsWith('.exe'))) { required.add(file); required.add(`${file}.blockmap`); }
  for (const name of names.filter(name => name.endsWith('.exe'))) required.add(`${name}.blockmap`);
  for (const name of required) {
    const stat = statSync(path.join(directory, name));
    if (!stat.isFile() || !stat.size) throw Error(`Missing or empty update artifact: ${name}`);
  }
  return { metadata: 'latest.yml', artifacts: [...required] };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { console.log(JSON.stringify(verifyUpdateArtifacts(path.resolve(process.argv[2] ?? 'release')))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
