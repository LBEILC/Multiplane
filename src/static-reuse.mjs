import { invalidOption } from './errors.mjs';

export function reuseEnabled(options = {}, fallback = true) {
  for (const key of ['static-reuse', 'no-static-reuse']) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw invalidOption('--' + key, '--' + key + ' must be a boolean.');
  }
  if (options['static-reuse'] && options['no-static-reuse']) throw invalidOption('--static-reuse', 'Static reuse switches are mutually exclusive.');
  return !options['no-static-reuse'] && (options['static-reuse'] ?? fallback);
}

// Shared by all workers, including browser replacements. Only the first mismatch warns.
export const observationReasons = ['mutation', 'drawing_or_setter', 'unobservable_api', 'hook_replaced', 'dynamic_element', 'editable_focus', 'animation_or_font', 'image', 'external_style', 'stylesheet'];
export function reuseState(options) {
  return options._staticReuseState ??= new Int32Array(new SharedArrayBuffer((4 + observationReasons.length) * 4));
}

export function reuseReport(options) {
  const state = reuseState(options);
  return { enabled: reuseEnabled(options) && !Atomics.load(state, 0),
    reusedFrames: Atomics.load(state, 0) ? 0 : Atomics.load(state, 1),
    verifiedFrames: Atomics.load(state, 2),
    disabledReason: Atomics.load(state, 0) ? 'pixel_mismatch' : null,
    observationReasons: Object.fromEntries(observationReasons.map((reason, i) => [reason, Atomics.load(state, 4 + i)]).filter(([, count]) => count)) };
}

// A bounded interval is published only after its closing audit. A mismatch
// repairs this interval; already audited intervals need no rollback.
export const REUSE_INTERVAL = 16;
export async function* verifiedFrames(source, options, count, { owned = false } = {}) {
  const state = reuseState(options);
  for (let first = 0; first < count;) {
    options.check?.();
    const end = Math.min(count, first + REUSE_INTERVAL + (first === 0 ? 1 : 0));
    if (!reuseEnabled(options) || Atomics.load(state, 0)) {
      yield* source(first, end);
    } else {
      const pending = [];
      for await (const item of source(first, end)) {
        options.check?.();
        pending.push({ ...item, png: owned ? item.png : Buffer.from(item.png) });
      }
      if (Atomics.load(state, 0)) yield* source(first, end);
      else yield* pending;
    }
    first = end;
  }
}

// Runs before any shot script, so saved drawing functions are instrumented too.
export function installStaticObserver({ platform } = {}) {
  let dirty = true, suspended = false, unsafe = false, styleSignature, stylesDirty = true, stylesUnsafe = false, previousSheets = [], readingStyles = false;
  const exposedDeclarations = new Map();
  let reason = null;
  const mark = () => { if (!suspended) { dirty = true; reason = 'drawing_or_setter'; } };
  const changedRecords = records => records.some(record => record.type === 'attributes'
    ? record.oldValue !== record.target.getAttribute(record.attributeName)
    : record.type === 'characterData' ? record.oldValue !== record.target.data : true);
  const mutations = records => {
    if (records.some(record => record.type === 'childList' || record.target.nodeName === 'STYLE' || record.target.nodeName === 'LINK' || record.target.parentNode?.nodeName === 'STYLE')) stylesDirty = true;
    if (changedRecords(records)) { mark(); reason = 'mutation'; }
  };
  const observer = new MutationObserver(mutations);
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true });
  const hooks = [];
  const wrapped = new WeakMap();
  const wrap = (proto, name) => {
    if (!proto) return;
    if (wrapped.get(proto)?.has(name)) return;
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (!descriptor || (typeof descriptor.value !== 'function' && !descriptor.set)) return;
    try {
      const replacement = { ...descriptor };
      const style = proto === globalThis.CSSStyleDeclaration?.prototype;
      const stylesheet = ['CSSStyleSheet', 'StyleSheet', 'StylePropertyMap', 'MediaList'].some(type => proto === globalThis[type]?.prototype)
        || proto === globalThis.CSSRule?.prototype || globalThis.CSSRule?.prototype.isPrototypeOf(proto);
      const sheetEdit = object => {
        if ((style && object.parentRule) || stylesheet) stylesDirty = true;
      };
      if (typeof descriptor.value === 'function') replacement.value = function (...args) {
        const before = style ? this.cssText : undefined;
        const result = descriptor.value.apply(this, args);
        if (!style || before !== this.cssText) { mark(); sheetEdit(this); }
        if (proto === globalThis.CSSStyleSheet?.prototype && name === 'replace') result.then(() => { stylesDirty = true; mark(); }, mark);
        return result;
      };
      if (descriptor.set) replacement.set = function (value) {
        // PutForwards setters mutate a stable native object (rule.style/media).
        const current = () => {
          const result = descriptor.get?.call(this);
          return result?.cssText ?? result?.mediaText ?? result;
        };
        const before = current();
        const result = descriptor.set.call(this, value);
        if (!descriptor.get || before !== current()) { mark(); sheetEdit(this); }
        return result;
      };
      Object.defineProperty(proto, name, replacement);
      if (!wrapped.has(proto)) wrapped.set(proto, new Set());
      wrapped.get(proto).add(name);
      hooks.push(() => {
        const current = Object.getOwnPropertyDescriptor(proto, name);
        return current?.value === replacement.value && current?.set === replacement.set;
      });
    } catch { unsafe = true; }
  };
  for (const type of ['CanvasRenderingContext2D', 'WebGLRenderingContext', 'WebGL2RenderingContext', 'ImageBitmapRenderingContext', 'OffscreenCanvasRenderingContext2D', 'CSSStyleDeclaration', 'CSSStyleSheet', 'StylePropertyMap', 'StyleSheet', 'CSSRule', 'CSSStyleRule', 'CSSGroupingRule', 'CSSConditionRule', 'CSSMediaRule', 'CSSKeyframesRule', 'CSSKeyframeRule', 'MediaList', 'Animation', 'AnimationEffect', 'KeyframeEffect']) {
    const proto = globalThis[type]?.prototype;
    for (const name of Object.getOwnPropertyNames(proto ?? {})) if (name !== 'constructor' && name !== 'getExtension') wrap(proto, name);
  }
  // Named CSS declaration properties are exotic instance setters, not prototype
  // setters. Track only declarations exposed to shot code, including saved live
  // references. Returning the native object preserves Web IDL brand checks.
  for (const type of ['CSSStyleRule', 'CSSKeyframeRule', 'CSSFontFaceRule', 'CSSPageRule', 'CSSPositionTryRule']) {
    const proto = globalThis[type]?.prototype;
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'style');
    if (!descriptor?.get) continue;
    const get = function () {
      const style = descriptor.get.call(this);
      if (!readingStyles && !exposedDeclarations.has(style)) exposedDeclarations.set(style, style.cssText);
      return style;
    };
    try {
      Object.defineProperty(proto, 'style', { ...descriptor, get });
      hooks.push(() => Object.getOwnPropertyDescriptor(proto, 'style')?.get === get);
    } catch { unsafe = true; }
  }
  for (const type of ['Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLOptionElement', 'HTMLCanvasElement', 'SVGElement']) {
    const proto = globalThis[type]?.prototype;
    for (const name of Object.getOwnPropertyNames(proto ?? {})) if (Object.getOwnPropertyDescriptor(proto, name)?.set) wrap(proto, name);
  }
  // SVG exposes live numeric/list objects whose writes need not emit attribute
  // mutation records (for example rect.x.baseVal.value).
  for (const type of Object.getOwnPropertyNames(globalThis).filter(name => /^SVG/.test(name))) {
    const proto = globalThis[type]?.prototype;
    for (const name of Object.getOwnPropertyNames(proto ?? {})) if (name !== 'constructor') wrap(proto, name);
  }
  for (const name of ['scroll', 'scrollTo', 'scrollBy']) wrap(Element.prototype, name);
  wrap(HTMLElement.prototype, 'click');
  for (const type of ['Selection', 'Range']) {
    const proto = globalThis[type]?.prototype;
    for (const name of Object.getOwnPropertyNames(proto ?? {})) if (name !== 'constructor') wrap(proto, name);
  }
  for (const type of ['HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLFormElement']) {
    for (const name of ['stepUp', 'stepDown', 'select', 'setRangeText', 'setSelectionRange', 'setCustomValidity', 'reset']) wrap(globalThis[type]?.prototype, name);
  }
  const attach = Element.prototype.attachShadow;
  const attachShadow = function (...args) { unsafe = true; return attach.apply(this, args); };
  Element.prototype.attachShadow = attachShadow;
  hooks.push(() => Element.prototype.attachShadow === attachShadow);
  for (const type of ['HTMLCanvasElement', 'OffscreenCanvas']) {
    const proto = globalThis[type]?.prototype;
    if (!proto) continue;
    const getContext = proto.getContext;
    const replacement = function (...args) {
      if (!['2d', 'webgl', 'webgl2', 'experimental-webgl', 'bitmaprenderer'].includes(args[0])) unsafe = true;
      mark();
      const context = getContext.apply(this, args);
      if (typeof args[0] === 'string' && args[0].includes('webgl') && !context?.getContextAttributes()?.preserveDrawingBuffer) unsafe = true;
      return context;
    };
    proto.getContext = replacement;
    hooks.push(() => proto.getContext === replacement);
  }
  const uncertainCall = (target, name) => {
    const original = target?.[name];
    if (typeof original !== 'function') return;
    try {
      const replacement = function (...args) { unsafe = true; return original.apply(this, args); };
      target[name] = replacement;
      hooks.push(() => target[name] === replacement);
    }
    catch { unsafe = true; }
  };
  // Timer callbacks remain covered by the DOM and drawing hooks.
  uncertainCall(HTMLCanvasElement.prototype, 'transferControlToOffscreen');
  uncertainCall(Element.prototype, 'setHTMLUnsafe');
  uncertainCall(Document, 'parseHTMLUnsafe');
  uncertainCall(Document.prototype, 'write');
  uncertainCall(Document.prototype, 'writeln');
  uncertainCall(globalThis.Worklet?.prototype, 'addModule');
  // Extension objects and transferred contexts can render outside the
  // instrumented prototypes. Never trust their apparent inactivity.
  for (const type of ['WebGLRenderingContext', 'WebGL2RenderingContext']) uncertainCall(globalThis[type]?.prototype, 'getExtension');
  const uncertainStyle = text => /paint\s*\(/i.test(text)
    || [...text.matchAll(/url\s*\(([^)]*)\)/gi)].some(match => !match[1].trim().replace(/^["']|["']$/g, '').startsWith('#'));
  const uncertainRules = rules => [...rules].some(rule =>
    rule.type === CSSRule.IMPORT_RULE
    || (rule.style && rule.type !== CSSRule.FONT_FACE_RULE && uncertainStyle(rule.style.cssText))
    || (rule.cssRules && uncertainRules(rule.cssRules)));
  const images = new Map();
  const staticImage = source => {
    if (!source || source.startsWith('#')) return true;
    if (images.has(source)) return images.get(source);
    images.set(source, false);
    // Image pixels may animate without attributes or load events. Inspect the
    // complete resource once, then reuse only formats proven to be static.
    (async () => {
      let decoder;
      try {
        const response = await fetch(source, { cache: 'force-cache', headers: { 'X-Multiplane-Image-Probe': '1' } });
        if (!response.ok) return;
        const data = await response.arrayBuffer();
        const type = response.headers.get('content-type')?.split(';')[0].trim();
        let safe;
        if (type === 'image/svg+xml') {
          const text = new TextDecoder().decode(data);
          const svg = new DOMParser().parseFromString(text, 'image/svg+xml');
          safe = !svg.querySelector('parsererror,script,animate,animateTransform,animateMotion,set,foreignObject,iframe,video')
            && !/@(?:keyframes|import)|\banimation\s*:|\bon\w+\s*=|(?:href|src)\s*=\s*["'](?!#)/i.test(text) && !uncertainStyle(text);
        } else if (globalThis.ImageDecoder && type && await ImageDecoder.isTypeSupported(type)) {
          decoder = new ImageDecoder({ data, type });
          await decoder.tracks.ready;
          safe = decoder.tracks.selectedTrack && !decoder.tracks.selectedTrack.animated;
        }
        if (safe) { images.set(source, true); mark(); }
      } catch { /* Unreadable or unsupported image resources stay ineligible. */ }
      finally { decoder?.close(); }
    })();
    return false;
  };
  for (const event of ['load', 'error', 'scroll', 'resize', 'focus', 'blur', 'contextlost', 'contextrestored', 'webglcontextlost', 'webglcontextrestored']) addEventListener(event, mark, true);
  document.fonts.addEventListener('loading', mark);
  document.fonts.addEventListener('loadingdone', mark);
  document.fonts.addEventListener('loadingerror', mark);
  const drain = () => mutations(observer.takeRecords());
  const changedStyles = () => {
    try {
      let declarationChanged = false;
      for (const [style, previous] of exposedDeclarations) {
        const current = style.cssText;
        if (current !== previous) { exposedDeclarations.set(style, current); stylesDirty = declarationChanged = true; }
      }
      const sheets = [...document.styleSheets, ...document.adoptedStyleSheets];
      if (sheets.length !== previousSheets.length || sheets.some((sheet, i) => sheet !== previousSheets[i])) stylesDirty = true;
      if (!stylesDirty) return stylesUnsafe;
      previousSheets = sheets;
      readingStyles = true;
      stylesUnsafe = sheets.some(sheet => uncertainRules(sheet.cssRules));
      stylesDirty = false;
      if (stylesUnsafe) return true;
      // CSSOM edits (including adopted sheets, grouping rules and exotic named
      // style setters) do not reliably produce DOM mutation records.
      const signature = JSON.stringify(sheets.map(sheet => [sheet.disabled, sheet.media.mediaText, [...sheet.cssRules].map(rule => rule.cssText)]));
      const changed = styleSignature !== undefined && styleSignature !== signature;
      styleSignature = signature;
      return changed || declarationChanged;
    } catch { return true; }
    finally { readingStyles = false; }
  };
  const uncertain = () => unsafe ? 'unobservable_api' : !hooks.every(check => check()) ? 'hook_replaced'
    // Native macOS textarea scrollbars can animate outside observable DOM/CSS state.
    : platform === 'darwin' && document.querySelector('textarea') ? 'unobservable_api'
    : document.querySelector('video,iframe,object,embed,marquee,animate,animateTransform,animateMotion,set') ? 'dynamic_element'
    : document.activeElement?.matches('input,textarea,[contenteditable]:not([contenteditable="false"])') ? 'editable_focus'
    : document.getAnimations().some(animation => animation.playState === 'running' || (animation.pending && animation.playState !== 'paused')) || document.fonts.status !== 'loaded' ? 'animation_or_font'
    : [...document.images].some(image => !image.complete || !staticImage(image.currentSrc || image.src))
      || [...document.querySelectorAll('svg image,svg use')].some(image => !staticImage(image.getAttribute('href') ?? image.getAttribute('xlink:href'))) ? 'image'
    : [...document.querySelectorAll('[style]')].some(element => uncertainStyle(element.getAttribute('style'))) ? 'external_style'
    : changedStyles() ? 'stylesheet' : null;
  Object.defineProperty(globalThis, '__multiplaneStatic', { value: {
    suspend() { drain(); suspended = true; },
    resume() { observer.takeRecords(); suspended = false; },
    disqualify() { unsafe = true; },
    get reason() { return reason; },
    read() { drain(); reason = dirty ? reason ?? 'mutation' : uncertain(); dirty = false; return reason !== null; },
  } });
}
