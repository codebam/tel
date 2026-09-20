// Browser/frontend runtime: VNodes, reactive signals, DOM mount and SSR.
// Pure factory so codegen can inline; interpreter can import it in Node too.
export function makeWebExtra(core) {
  const { str, truthy, eq, isSum } = core;

  const SVG_TAGS = new Set(['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g', 'text', 'defs', 'use', 'ellipse']);

  function frag(...children) { return { __vnode: true, tag: null, attrs: {}, children: flatten(children) }; }

  function flatten(kids) {
    const out = [];
    for (const k of kids) {
      if (k === null || k === undefined || k === false || k === true) continue;
      if (Array.isArray(k)) out.push(...flatten(k));
      else out.push(k);
    }
    return out;
  }

  function isAttrs(x) {
    return x !== null && typeof x === 'object' && !Array.isArray(x) && !x.__vnode && !x.__tag && !isSum(x) && typeof x !== 'function';
  }

  function h(tag, ...args) {
    let attrs = {};
    let kids = args;
    if (args.length && isAttrs(args[0])) { attrs = args[0]; kids = args.slice(1); }
    return { __vnode: true, tag, attrs, children: flatten(kids) };
  }

  const tags = {};
  const HTML_TAGS = ['a', 'abbr', 'article', 'aside', 'b', 'blockquote', 'br', 'button', 'canvas', 'code', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'em', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'input', 'label', 'legend', 'li', 'link', 'main', 'nav', 'ol', 'option', 'p', 'pre', 'progress', 'section', 'select', 'small', 'source', 'span', 'strong', 'summary', 'table', 'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'video', 'audio', 'meta', 'title', 'style', 'script', 'iframe', 'template', 'slot'];
  for (const t of [...HTML_TAGS, ...SVG_TAGS]) tags[t] = (...a) => h(t, ...a);
  tags.h = h; tags.frag = frag;

  // --- SSR ------------------------------------------------------------------
  function esc(s) {
    return str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function attrString(attrs) {
    let out = '';
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false || k.startsWith('on')) continue;
      if (k === 'style' && typeof v === 'object') {
        const css = Object.entries(v).map(([p, val]) => `${p.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}:${typeof val === 'number' ? val + 'px' : val}`).join(';');
        out += ` style="${esc(css)}"`; continue;
      }
      if (v === true) { out += ` ${k}`; continue; }
      if (k === 'class' && Array.isArray(v)) { out += ` class="${esc(v.filter(Boolean).join(' '))}"`; continue; }
      out += ` ${k}="${esc(v)}"`;
    }
    return out;
  }
  function html(v) {
    if (v === null || v === undefined || v === false || v === true) return '';
    if (Array.isArray(v)) return v.map(html).join('');
    if (typeof v === 'object' && v.__vnode) {
      const inner = v.children.map(html).join('');
      if (!v.tag) return inner;
      return `<${v.tag}${attrString(v.attrs)}>${inner}</${v.tag}>`;
    }
    if (typeof v === 'function') return html(v());
    return esc(v);
  }
  const renderToString = html;

  // --- reactivity ----------------------------------------------------------
  const watchers = new Set();
  let schedule = false;
  let currentWatcher = null;
  function notify() {
    if (schedule) return;
    schedule = true;
    queueMicrotask(() => { schedule = false; for (const w of [...watchers]) w(); });
  }
  function sig(init) {
    let value = init;
    const s = (...args) => {
      if (currentWatcher) watchers.add(currentWatcher);
      if (args.length === 0) return value;
      if (!eq(value, args[0])) { value = args[0]; notify(); }
      return value;
    };
    s.get = () => { if (currentWatcher) watchers.add(currentWatcher); return value; };
    s.set = (v) => { if (!eq(value, v)) { value = v; notify(); } return value; };
    return s;
  }

  // --- DOM ------------------------------------------------------------------
  function build(v) {
    if (v === null || v === undefined || v === false || v === true) return null;
    if (Array.isArray(v)) { const f = document.createDocumentFragment(); for (const c of v) { const n = build(c); if (n) f.append(n); } return f; }
    if (v.__vnode) {
      if (!v.tag) { const f = document.createDocumentFragment(); for (const c of v.children) { const n = build(c); if (n) f.append(n); } return f; }
      const el = SVG_TAGS.has(v.tag) ? document.createElementNS('http://www.w3.org/2000/svg', v.tag) : document.createElement(v.tag);
      for (const [k, val] of Object.entries(v.attrs || {})) {
        if (val === null || val === undefined || val === false) continue;
        if (k.startsWith('on') && typeof val === 'function') { el.addEventListener(k.slice(2).toLowerCase(), val); continue; }
        if (k === 'style' && typeof val === 'object') { for (const [p, x] of Object.entries(val)) el.style[p] = typeof x === 'number' ? x + 'px' : x; continue; }
        if (k === 'class' && Array.isArray(val)) { el.className = val.filter(Boolean).join(' '); continue; }
        if (k === 'value' || k === 'checked') { el[k] = val; continue; }
        if (v.tag === 'input' || v.tag === 'textarea') { el.setAttribute(k, val); continue; }
        el.setAttribute(k, val);
      }
      for (const c of v.children) { const n = build(c); if (n) el.append(n); }
      return el;
    }
    return document.createTextNode(str(v));
  }

  function mount(comp, sel = '#app') {
    if (typeof document === 'undefined') throw new Error('mount() needs a browser DOM; use renderToString for SSR');
    const root = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!root) throw new Error(`mount target not found: ${sel}`);
    const watcher = () => { currentWatcher = watcher; try { root.replaceChildren(build(comp())); } finally { currentWatcher = null; } };
    watcher();
    return { root, redraw: watcher };
  }

  const out = { h, frag, html, renderToString, sig, mount, text: (x) => str(x) };
  Object.assign(out, tags);
  return out;
}
