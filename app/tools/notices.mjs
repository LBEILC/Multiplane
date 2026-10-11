import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function packageRoots(modules) {
  const result = [];
  for (const entry of (await readdir(modules, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
    const dir = path.join(modules, entry.name);
    if (entry.name.startsWith('@')) { for (const item of await readdir(dir, { withFileTypes: true })) if (item.isDirectory()) result.push(path.join(dir, item.name)); }
    else result.push(dir);
  }
  for (const dir of [...result]) {
    try { result.push(...await packageRoots(path.join(dir, 'node_modules'))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return result;
}
async function licenseFiles(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw Error('License input cannot be a symbolic link');
    const name = path.posix.join(prefix, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') result.push(...await licenseFiles(root, name));
    else if (entry.isFile() && /licen[sc]e|notice|copying|copyright/i.test(entry.name)) result.push(name);
  }
  return result.sort();
}
async function allFiles(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const file = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await allFiles(root, file)); else files.push(file);
  }
  return files.sort();
}
export async function generateNotices(root, app, renderer, output) {
  const entries = [], inventory = [];
  const add = async (source, name) => {
    const bytes = await readFile(source);
    if (!bytes.length) throw Error(`Empty license: ${name}`);
    entries.push({ name, bytes }); return { file: name, sha256: digest(bytes) };
  };
  for (const directory of await packageRoots(path.join(renderer, 'node_modules'))) {
    const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    if (pkg.name === 'three') throw Error('three must not be bundled');
    const files = await licenseFiles(directory);
    // libvips binary packages publish their attribution table in README.md;
    // exact upstream texts are verified and copied from the native inventory below.
    const libvips = /^@img\/sharp-libvips-/.test(pkg.name);
    if (!files.length && !libvips) throw Error(`Missing license text for ${pkg.name}@${pkg.version}`);
    if (libvips) files.push('README.md');
    const licenses = [];
    // Keep copied notices outside directories that packagers treat as runtime dependencies.
    const location = path.relative(path.join(renderer, 'node_modules'), directory).replaceAll('\\', '/').replaceAll('/node_modules/', '/nested/');
    for (const file of files) licenses.push(await add(path.join(directory, file), `licenses/dependencies/${location}/${file}`));
    if (libvips) licenses.push(await add(path.join(root, 'licenses/native/vips-COPYING'), `licenses/dependencies/${location}/COPYING`));
    inventory.push({ name: pkg.name, version: pkg.version, license: pkg.license, licenses });
  }
  for (const [name, directory, selected] of [
    ['electron', path.join(app, 'node_modules/electron'), ['LICENSE', 'dist/LICENSES.chromium.html']],
    ['remixicon', path.join(app, 'node_modules/remixicon'), ['License']]
  ]) {
    const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const licenses = [];
    for (const file of selected) licenses.push(await add(path.join(directory, file), `licenses/${name}/${path.basename(file)}`));
    inventory.push({ name, version: pkg.version, license: pkg.license, licenses });
  }
  for (const file of await allFiles(path.join(root, 'licenses'))) await add(path.join(root, 'licenses', file), `licenses/renderer/${file}`);
  const native = JSON.parse(await readFile(path.join(root, 'licenses/native/sources.json'), 'utf8'));
  const nativeRoot = path.join(renderer, `node_modules/@img/sharp-${process.platform}-${process.arch}`);
  const nativePackage = JSON.parse(await readFile(path.join(nativeRoot, 'package.json'), 'utf8'));
  if (nativePackage.version !== native.sharp) throw Error('Native license inventory needs updating for this sharp version');
  const { sharp: sharpVersion, ...nativeVersions } = createRequire(path.join(renderer, 'package.json'))('sharp').versions;
  for (const name of Object.keys(nativeVersions)) if (!native.entries.some(entry => entry.component === name)) throw Error(`Missing native component license: ${name}`);
  const components = new Map();
  for (const entry of native.entries) {
    if (!nativeVersions[entry.bundledWith ?? entry.component]) continue;
    if (nativeVersions[entry.bundledWith ?? entry.component] !== entry.version) throw Error(`Native component version mismatch: ${entry.component}`);
    const bytes = await readFile(path.join(root, 'licenses/native', entry.file));
    if (digest(bytes) !== entry.sha256) throw Error(`Native license SHA-256 mismatch: ${entry.file}`);
    if (!components.has(entry.component)) components.set(entry.component, { name: entry.component, version: entry.version, license: 'See upstream license texts', licenses: [] });
    components.get(entry.component).licenses.push({ file: `licenses/renderer/native/${entry.file}`, sha256: entry.sha256, source: entry.url });
  }
  const nativeInventory = [...components.values()];
  await add(path.join(root, 'LICENSE'), 'licenses/Multiplane-LICENSE');
  await add(path.join(app, 'REFERENCE_LICENSE'), 'licenses/REFERENCE_LICENSE');
  await add(path.join(root, 'examples/assets/OFL.txt'), 'licenses/Roboto-OFL.txt');
  const software = (await readFile(path.join(app, 'THIRD_PARTY_NOTICES.md'), 'utf8')).replaceAll('`REFERENCE_LICENSE`', '[REFERENCE_LICENSE](licenses/REFERENCE_LICENSE)');
  const rendering = (await readFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')).replaceAll('](licenses/', '](licenses/renderer/').replaceAll('](examples/assets/OFL.txt)', '](licenses/Roboto-OFL.txt)');
  const text = '# Third-party notices\n\nGenerated from the exact installed production dependency tree. Development tools are not bundled. three.js and the standalone Playwright browser are not included. Electron includes its own Chromium runtime; its complete third-party license texts are linked below.\n\n'
    + software + '\n\n' + rendering + '\n\n## Bundled dependency inventory\n\n'
    + inventory.map(pkg => `### ${pkg.name} ${pkg.version}\n\nLicense: ${pkg.license}\n\n${pkg.licenses.map(l => `- [${l.file}](${l.file})`).join('\n')}\n`).join('\n')
    + '\n## Native components in sharp / libvips\n\nThis software is based in part on the work of the Independent JPEG Group.\n\n'
    + nativeInventory.map(pkg => `### ${pkg.name} ${pkg.version}\n\n${pkg.licenses.map(l => `- [${path.basename(l.file)}](${l.file}) ([upstream source](${l.source}))`).join('\n')}\n`).join('\n');
  entries.push({ name: 'THIRD_PARTY_NOTICES.md', bytes: Buffer.from(text) });
  const manifest = { packages: inventory, nativeComponents: nativeInventory, files: entries.map(e => ({ file: e.name, sha256: digest(e.bytes) })) };
  for (const entry of entries) { const target = path.join(output, entry.name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, entry.bytes); }
  await writeFile(path.join(output, 'license-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await verifyNotices(output);
  return manifest;
}
export async function verifyNotices(output) {
  const manifest = JSON.parse(await readFile(path.join(output, 'license-manifest.json'), 'utf8'));
  for (const entry of manifest.files) if (digest(await readFile(path.join(output, entry.file))) !== entry.sha256) throw Error(`License mismatch: ${entry.file}`);
  return manifest;
}
