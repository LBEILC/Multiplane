import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { parse as parseJS } from 'acorn';
import { parse as parseHTML } from 'parse5';
import postcss from 'postcss';
import values from 'postcss-value-parser';
import { MultiplaneError } from './errors.mjs';

const rules = {
  wall_clock: ['error', 'Wall-clock time is nondeterministic.', 'Calculate time from the render(t) argument.'],
  unseeded_random: ['error', 'Unseeded randomness is nondeterministic.', 'Use a seeded random generator with a fixed seed.'],
  css_animation: ['error', 'An autonomous CSS animation or transition is used.', 'Set animation and transition to none and assign styles from render(t).'],
  web_animations: ['error', 'The Web Animations timeline is used.', 'Calculate and assign each animated property in render(t).'],
  timer_driven: ['warning', 'A timer can change the frame independently of t.', 'Move visual updates into render(t).'],
  media_playback: ['error', 'Autonomous media playback is used.', 'Use a still image or predecoded frame selected by t.'],
  animated_image: ['warning', 'An animated image may advance independently of t.', 'Replace it with still frames selected by t.'],
  remote_resource: ['error', 'A resource is loaded from the network.', 'Download the resource and reference a local file inside the resource root.'],
  resource_missing: ['error', 'A local resource is missing or outside the resource root.', 'Place the file inside the resource root and correct the relative URL.'],
  stage_missing: ['error', 'The stage element is missing.', 'Add an element with id="stage".'],
  stage_size_unfixed: ['warning', 'Fixed stage dimensions could not be found.', 'Set #stage width and height to positive px values.'],
  shot_missing: ['error', 'The shot definition is missing.', 'Call Shot.define({...}) or assign window.SHOT.'],
  runtime_missing: ['error', 'Shot.define is used without the runtime.', 'Include /multiplane/runtime/shot.js before defining the shot.'],
  async_render: ['error', 'The render function is asynchronous.', 'Await resources in setup and make render(t) synchronous.'],
  font_not_awaited: ['warning', 'Custom fonts have no explicit loading declaration.', 'Add fonts to Shot.define or await document.fonts.load in setup.'],
  lint_directive_invalid: ['warning', 'The lint directive has no valid rule codes.', 'List rule codes after multiplane-disable-next-line.'],
  lint_incomplete: ['warning', 'Source parsing failed.', 'Correct the source syntax to complete lint coverage.'],
};
const inside = (root, file) => { const p = path.relative(root, file); return p !== '..' && !p.startsWith('..' + path.sep) && !path.isAbsolute(p); };
const children = node => Object.values(node).flatMap(v => Array.isArray(v) ? v : [v]).filter(v => v && typeof v.type === 'string');
const walk = (node, fn, parents = []) => { fn(node, parents); for (const child of children(node)) walk(child, fn, [...parents, node]); };
const member = n => n?.type === 'Identifier' ? n.name : n?.type === 'MemberExpression' && !n.computed ? `${member(n.object)}.${n.property.name}` : '';
const literal = n => n?.type === 'Literal' && typeof n.value === 'string' ? n.value : n?.type === 'TemplateLiteral' && !n.expressions.length ? n.quasis[0].value.cooked : null;

export async function scanShot(shot, options = {}) {
  const root = await realpath(path.resolve(options.root ?? process.cwd()));
  const entry = path.resolve(root, shot);
  if (!inside(root, entry)) throw new MultiplaneError('shot_outside_root');
  let entryReal;
  try { entryReal = await realpath(entry); if (!(await stat(entryReal)).isFile()) throw Error(); }
  catch { throw new MultiplaneError('shot_not_found'); }
  if (!inside(root, entryReal)) throw new MultiplaneError('shot_outside_root');
  const sources = new Map(), pending = [], findings = [], directives = new Map(), seen = new Set();
  const state = { stage: null, width: false, height: false, shot: false, define: null, runtime: false, fonts: false, fontFace: null, fontLoad: false };
  const location = (file, offset) => {
    const prefix = sources.get(file).slice(0, offset), lines = prefix.split('\n');
    return { file: path.relative(root, file).split(path.sep).join('/'), line: lines.length, column: lines.at(-1).length + 1 };
  };
  const add = (code, file, offset, extra = {}) => {
    const loc = location(file, offset), [severity, message, hint] = rules[code];
    if (findings.some(f => f.code === code && f.location.file === loc.file && f.location.line === loc.line && f.location.column === loc.column)) return;
    findings.push({ code, severity, message, hint, location: loc, ...extra, details: { snippet: sources.get(file).split('\n')[loc.line - 1].trim().slice(0, 160), ...extra.details } });
  };
  const comment = (file, offset, text) => {
    const match = /multiplane-disable-next-line\b([^\r\n]*)/.exec(text);
    if (!match) return;
    const codes = match[1].trim().split(/\s*,\s*/).filter(c => rules[c] && c !== 'lint_directive_invalid');
    if (!codes.length) add('lint_directive_invalid', file, offset);
    else {
      const loc = location(file, offset + text.slice(0, match.index).length);
      directives.set(`${loc.file}:${loc.line + 1}`, new Set([...(directives.get(`${loc.file}:${loc.line + 1}`) ?? []), ...codes]));
    }
  };
  const resource = (url, file, offset, kind, module = false) => {
    if (url === null) return;
    url = url.trim();
    if (/^(https?:)?\/\//i.test(url)) { add('remote_resource', file, offset); return; }
    if (!url || /^(data:|blob:|#)/i.test(url)) return;
    if ((kind === 'js' || module) && url.split(/[?#]/)[0] === '/multiplane/runtime/shot.js') state.runtime = true;
    if (url.startsWith('/multiplane/')) return;
    if (module && !/^[./]/.test(url)) return;
    if (/^[a-z][\w+.-]*:/i.test(url)) return;
    if (/\.(gif|apng)(?:[?#]|$)/i.test(url)) add('animated_image', file, offset);
    pending.push({ url, file, offset, kind });
  };
  function css(text, file, base = 0, inlineStage = false) {
    let tree;
    try { tree = postcss.parse(text, { from: file, map: false }); }
    catch (error) { add('lint_incomplete', file, base, { message: 'CSS parsing failed; source fragment was skipped.', details: { reason: error.message.split(/\r?\n/)[0] } }); return; }
    tree.walk(node => {
      const offset = base + node.source.start.offset;
      if (node.type === 'comment') comment(file, offset, node.text);
      if (node.type === 'atrule') {
        if (/^(?:-\w+-)?keyframes$/i.test(node.name)) add('css_animation', file, offset);
        if (node.name.toLowerCase() === 'font-face') state.fontFace ??= { file, offset };
        if (node.name.toLowerCase() === 'import') {
          const first = values(node.params).nodes.find(n => !['space', 'comment'].includes(n.type));
          if (first?.type === 'string') resource(first.value, file, offset, 'css');
        }
      }
      if (node.type === 'decl') {
        const prop = node.prop.toLowerCase(), value = node.value.trim().toLowerCase();
        if (['animation', 'animation-name'].includes(prop) && value.split(',').some(v => v.trim() !== 'none')) add('css_animation', file, offset);
        if (['transition', 'transition-duration'].includes(prop)) {
          const durations = value.match(/-?(?:\d*\.)?\d+m?s\b/g) ?? [];
          if (durations.some(v => parseFloat(v) !== 0)) add('css_animation', file, offset);
        }
        if (inlineStage || (node.parent.type === 'rule' && node.parent.selector.split(',').some(s => s.trim() === '#stage'))) {
          if (['width', 'height'].includes(prop) && /^\d+(?:\.\d+)?px$/.test(value) && parseFloat(value) > 0) state[prop] = true;
        }
      }
      if (node.type === 'decl' || node.type === 'atrule') {
        values(node.value ?? node.params).walk(v => {
          if (v.type === 'function' && v.value.toLowerCase() === 'url') {
            const url = v.nodes.filter(n => !['space', 'comment'].includes(n.type)).map(n => n.value).join('');
            resource(url, file, offset, node.type === 'atrule' && node.name === 'import' ? 'css' : undefined);
            return false;
          }
        });
      }
    });
  }
  function js(text, file, base = 0, module = false) {
    let tree;
    try { tree = parseJS(text, { ecmaVersion: 'latest', sourceType: module ? 'module' : 'script', allowAwaitOutsideFunction: true,
      onComment: (_block, value, start) => comment(file, base + start, value) }); }
    catch (error) { add('lint_incomplete', file, base, { message: 'JavaScript parsing failed; source fragment was skipped.', details: { reason: error.message.split(/\r?\n/)[0] } }); return; }
    const bindings = new Map();
    let globalShotVariable = false;
    // Track lexical scopes so local variables named Date/Math/etc. do not match globals.
    const isScope = n => /Function/.test(n.type) || ['Program', 'BlockStatement', 'ArrowFunctionExpression', 'CatchClause'].includes(n.type);
    const bind = (scope, pattern) => {
      if (!scope || !pattern) return;
      const names = bindings.get(scope) ?? new Set(); bindings.set(scope, names);
      if (pattern.type === 'Identifier') names.add(pattern.name);
      else for (const c of children(pattern)) bind(scope, c);
    };
    walk(tree, (n, ancestors) => {
      if (/Function/.test(n.type)) { for (const p of n.params ?? []) bind(n, p); if (n.id) bind(n.type === 'FunctionDeclaration' ? ancestors.findLast(isScope) : n, n.id); }
      if (n.type === 'VariableDeclaration') for (const d of n.declarations) {
        bind(ancestors.findLast(a => n.kind === 'var' ? /Function/.test(a.type) || a.type === 'Program' : isScope(a)), d.id);
        if (!module && n.kind === 'var' && d.id.name === 'SHOT' && !ancestors.some(a => /Function/.test(a.type))) {
          globalShotVariable = true;
          if (d.init) state.shot = true;
        }
      }
      if (n.type === 'ImportDeclaration') for (const s of n.specifiers) bind(tree, s.local);
      if (n.type === 'ClassDeclaration') bind(ancestors.findLast(isScope), n.id);
      if (n.type === 'CatchClause') bind(n, n.param);
    });
    walk(tree, (n, ancestors) => {
      const offset = base + n.start, call = ['CallExpression', 'NewExpression'].includes(n.type);
      const name = member(call ? n.callee : n), global = value => ![...ancestors, n].some(a => bindings.get(a)?.has(value.split('.')[0]));
      if (call && global(name)) {
        if (['Date.now', 'performance.now'].includes(name) || name === 'Date' && (n.type === 'CallExpression' || !n.arguments.length)) add('wall_clock', file, offset);
        if (['Math.random', 'crypto.getRandomValues', 'crypto.randomUUID'].includes(name)) add('unseeded_random', file, offset);
        if (['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback'].includes(name.replace(/^(window|globalThis)\./, ''))) add('timer_driven', file, offset);
        if (name === 'Animation' && n.type === 'NewExpression') add('web_animations', file, offset);
        if (name === 'Audio' && n.type === 'NewExpression') add('media_playback', file, offset);
        if (name === 'fetch') resource(literal(n.arguments[0]), file, base + (n.arguments[0]?.start ?? n.start));
        if (name === 'FontFace') {
          const source = literal(n.arguments[1]);
          if (source) values(source).walk(v => { if (v.type === 'function' && v.value === 'url') resource(v.nodes.map(x => x.value).join(''), file, base + n.arguments[1].start); });
        }
        if (name === 'Shot.define') {
          state.shot = true; state.define ??= { file, offset };
          // An indirect definition may supply fonts; do not infer their absence.
          state.fonts ||= n.arguments[0]?.type !== 'ObjectExpression' || n.arguments[0].properties.some(p => (p.key?.name ?? p.key?.value) === 'fonts' || p.type === 'SpreadElement');
        }
        if (name === 'document.fonts.load') state.fontLoad = true;
      }
      if (call && n.callee.type === 'MemberExpression' && !n.callee.computed) {
        if (n.callee.property.name === 'animate') add('web_animations', file, offset);
        if (n.callee.property.name === 'play') add('media_playback', file, offset);
      }
      if (name === 'document.timeline' && global(name)) add('web_animations', file, offset);
      if (n.type === 'AssignmentExpression') {
        const target = member(n.left);
        if (['SHOT', 'window.SHOT'].includes(target) && (global(target) || target === 'SHOT' && globalShotVariable
          && !ancestors.some(a => a.type !== 'Program' && bindings.get(a)?.has('SHOT')))) state.shot = true;
        const value = literal(n.right);
        if (/\.style\.(animation|transition)$/.test(target) && value !== null && value !== '') add('css_animation', file, offset);
      }
      if (n.type === 'ImportDeclaration' || ['ExportNamedDeclaration', 'ExportAllDeclaration'].includes(n.type) && n.source) resource(literal(n.source), file, base + n.source.start, 'js', true);
      if (n.type === 'ImportExpression') resource(literal(n.source), file, base + n.source.start, undefined, true);
      const render = ['Property', 'MethodDefinition'].includes(n.type) && (n.key.name ?? n.key.value) === 'render' ? n.value
        : n.type === 'VariableDeclarator' && n.id.name === 'render' ? n.init
        : n.type === 'FunctionDeclaration' && n.id?.name === 'render' ? n
          : n.type === 'AssignmentExpression' && /(?:^|\.)render$/.test(member(n.left)) ? n.right : null;
      if (render && /Function/.test(render.type)) {
        let async = render.async;
        walk(render.body, child => { if (child.type === 'AwaitExpression') async = true; });
        if (async) add('async_render', file, offset);
      }
    });
  }
  async function scan(file, kind) {
    if (seen.has(file)) return;
    seen.add(file);
    const text = await readFile(file, 'utf8'); sources.set(file, text);
    if (kind === 'js') return js(text, file, 0, true);
    if (kind === 'css') return css(text, file);
    const tree = parseHTML(text, { sourceCodeLocationInfo: true });
    function visit(node) {
      const loc = node.sourceCodeLocation, attrs = Object.fromEntries((node.attrs ?? []).map(a => [a.name, a.value]));
      if (node.nodeName === '#comment') comment(file, loc.startOffset, node.data);
      if (loc && node.tagName) {
        if (attrs.id === 'stage') state.stage ??= { file, offset: loc.startOffset };
        if (['video', 'audio'].includes(node.tagName)) add('media_playback', file, loc.startOffset);
        for (const a of node.attrs ?? []) {
          const attrLoc = loc.attrs[a.name];
          if (a.name === 'style') {
            const raw = text.slice(attrLoc.startOffset, attrLoc.endOffset), match = /=\s*["']?/.exec(raw);
            if (match) {
              const valueStart = match.index + match[0].length;
              css(raw.slice(valueStart).replace(/["']$/, ''), file, attrLoc.startOffset + valueStart, attrs.id === 'stage');
            }
          }
          if (['src', 'href', 'poster', 'xlink:href'].includes(a.name) && !(node.tagName === 'a' && a.name === 'href')) resource(a.value, file, attrLoc.startOffset,
            node.tagName === 'script' ? 'js' : node.tagName === 'link' && attrs.rel?.split(/\s+/).includes('stylesheet') ? 'css' : undefined);
        }
        if (node.tagName === 'script' && !attrs.src && (!attrs.type || /^(module|(?:text|application)\/(?:java|ecma)script)$/i.test(attrs.type))) js(text.slice(loc.startTag.endOffset, loc.endTag?.startOffset ?? loc.endOffset), file, loc.startTag.endOffset, attrs.type === 'module');
        if (node.tagName === 'style') css(text.slice(loc.startTag.endOffset, loc.endTag?.startOffset ?? loc.endOffset), file, loc.startTag.endOffset);
      }
      for (const child of node.childNodes ?? []) visit(child);
    }
    visit(tree);
  }
  await scan(entryReal, 'html');
  for (let i = 0; i < pending.length; i++) {
    const { url, file, offset, kind } = pending[i];
    let target;
    try {
      const decoded = decodeURIComponent(url.split(/[?#]/)[0]);
      target = path.resolve(decoded.startsWith('/') ? root : path.dirname(file), decoded.replace(/^\//, ''));
      if (!inside(root, target)) throw Error();
      target = await realpath(target);
      if (!inside(root, target) || !(await stat(target)).isFile()) throw Error();
    } catch { add('resource_missing', file, offset); continue; }
    if (kind) await scan(target, kind);
  }
  if (!state.stage) add('stage_missing', entryReal, 0);
  else if (!state.width || !state.height) add('stage_size_unfixed', state.stage.file, state.stage.offset);
  if (!state.shot) add('shot_missing', entryReal, 0);
  if (state.define && !state.runtime) add('runtime_missing', state.define.file, state.define.offset);
  if (state.fontFace && !state.fonts && !state.fontLoad) add('font_not_awaited', state.fontFace.file, state.fontFace.offset);
  const visible = findings.filter(f => !directives.get(`${f.location.file}:${f.location.line}`)?.has(f.code));
  visible.sort((a, b) => a.location.file.localeCompare(b.location.file) || a.location.line - b.location.line || a.location.column - b.location.column || a.code.localeCompare(b.code));
  const data = { files: [...sources.keys()].map(f => path.relative(root, f).split(path.sep).join('/')), errors: visible.filter(f => f.severity === 'error').length,
    warnings: visible.filter(f => f.severity === 'warning').length, suppressed: findings.length - visible.length };
  return { findings: visible, data };
}

export async function checkLint(shot, options, events) {
  const { findings, data } = await scanShot(shot, options);
  for (const finding of findings) events.emit('finding', finding);
  if (data.errors) throw new MultiplaneError('lint_failed', undefined, { result: { data } });
  return data;
}
