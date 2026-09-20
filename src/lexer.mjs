// Tel lexer. Produces a flat token stream with INDENT/DEDENT/NEWLINE tokens
// (Python-style layout), interpolation-aware strings, and `..`/`..=` ranges.

export const KEYWORDS = new Set([
  'fn', 'type', 'enum', 'import', 'pub', 'srv', 'cli', 'web',
  'async', 'await', 'spawn', 'if', 'elif', 'else', 'for', 'in', 'while', 'loop',
  'match', 'return', 'break', 'continue', 'throw', 'try', 'catch', 'finally', 'new',
  'is', 'not', 'and', 'or', 'true', 'false', 'nil', 'void', 'self', 'as', 'defer',
]);

const OPS = [
  '...', '..=', '??=', '**=', '?.', '??', '|>', '=>', '->', '==', '!=', '<=', '>=',
  '&&', '||', '..', '+=', '-=', '*=', '/=', '%=', '**', '<<', '>>', '::',
  '(', ')', '[', ']', '{', '}', ',', ';', ':', '.', '?', '+', '-', '*', '/',
  '%', '=', '<', '>', '!', '|', '&', '^', '~', '@',
];
const OP_BY_LEN = [...OPS].sort((a, b) => b.length - a.length);

export class LexError extends Error {
  constructor(msg, line, col) { super(msg); this.name = 'LexError'; this.line = line; this.col = col; }
}

const ID_START = /[A-Za-z_$]/;
const ID_CONT = /[A-Za-z0-9_$]/;
const NUM_RE = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)/;

export function lex(src, opts = {}) {
  const toks = [];
  let i = 0;
  const n = src.length;
  let line = opts.line || 1;
  let col = opts.col || 1;
  let atLineStart = true;
  let depth = 0; // (), [], {} nesting — layout is suppressed inside
  const indents = [0];
  let lineHasToken = false;

  function push(t, v, extra) {
    toks.push({ t, v, line, col, start: i, end: i + (v ? String(v).length : 0), ...(extra || {}) });
    lineHasToken = true;
  }
  function pushAt(t, v, l, c, start, end, extra) {
    toks.push({ t, v, line: l, col: c, start, end, ...(extra || {}) });
  }
  function fail(msg, l = line, c = col) { throw new LexError(msg, l, c); }

  function advance(s) {
    for (const ch of s) {
      if (ch === '\n') { line++; col = 1; } else { col++; }
      i++;
    }
  }

  // skip a # line comment, or a #[ ... ]# block comment (nesting allowed)
  function skipComment() {
    if (src[i] !== '#') return false;
    const l0 = line, c0 = col;
    if (src[i + 1] === '[') {
      let d = 1; advance('#[');
      while (i < n && d > 0) {
        if (src[i] === '#' && src[i + 1] === '[') { d++; advance('#['); }
        else if (src[i] === ']' && src[i + 1] === '#') { d--; advance(']#'); }
        else advance(src[i]);
      }
      if (d > 0) fail('unterminated block comment', l0, c0);
      return true;
    }
    while (i < n && src[i] !== '\n') advance(src[i]);
    return true;
  }

  while (i < n) {
    const ch = src[i];

    // --- line layout ------------------------------------------------------
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') { i++; }
      advance(ch);
      if (toks.length && toks[toks.length - 1].t !== 'nl') {
        pushAt('nl', '\n', line - 1, 1, i - 1, i);
      }
      atLineStart = true; lineHasToken = false;
      continue;
    }

    if (atLineStart && depth === 0) {
      let colStart = 0;
      let j = i;
      while (j < n && (src[j] === ' ' || src[j] === '\t')) {
        colStart += src[j] === '\t' ? 4 : 1; j++;
      }
      // blank line: ignore layout entirely
      if (j >= n || src[j] === '\n' || src[j] === '\r') {
        while (i < n && src[i] !== '\n') advance(src[i]);
        continue;
      }
      // block comments may span lines; line comments are comment-only lines
      if (src[j] === '#') {
        if (src[j + 1] === '[') {
          advance(src.slice(i, j));
          skipComment();
          if (i >= n || src[i] === '\n' || src[i] === '\r') continue;
        } else {
          while (i < n && src[i] !== '\n') advance(src[i]);
          continue;
        }
      } else {
        advance(src.slice(i, j));
      }
      atLineStart = false;
      const cur = indents[indents.length - 1];
      if (colStart > cur) {
        indents.push(colStart);
        pushAt('indent', colStart, line, 1, i, i);
        lineHasToken = false;
      } else if (colStart < cur) {
        while (indents.length > 1 && colStart < indents[indents.length - 1]) {
          indents.pop();
          pushAt('dedent', indents.length, line, 1, i, i);
          lineHasToken = false;
        }
        if (indents[indents.length - 1] !== colStart) fail('inconsistent indentation', line, 1);
      }
      continue;
    }

    if (atLineStart) { // inside brackets: just skip leading blanks
      if (ch === ' ' || ch === '\t') { advance(ch); continue; }
      atLineStart = false;
      continue;
    }

    if (ch === ' ' || ch === '\t') { advance(ch); continue; }
    if (ch === '#') { skipComment(); continue; }

    // --- strings -----------------------------------------------------------
    if (ch === '"' || ch === "'") {
      const l0 = line, c0 = col, s0 = i;
      const triple = src.slice(i, i + 3) === '"""';
      const quote = ch;
      const parts = [];
      let text = '';
      const canInterp = quote === '"';
      advance(triple ? '"""' : quote);
      let closed = false;
      while (i < n) {
        if (triple ? src.slice(i, i + 3) === '"""' : src[i] === quote) {
          advance(triple ? '"""' : quote); closed = true; break;
        }
        if (!triple && src[i] === '\n') fail('unterminated string', l0, c0);
        if (src[i] === '\\') {
          const e = src[i + 1];
          const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'", '{': '{', '}': '}', '0': '\0' };
          if (e in map) { text += map[e]; advance(src.slice(i, i + 2)); }
          else if (e === 'u') {
            const hex = src.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('bad \\u escape', line, col);
            text += String.fromCharCode(parseInt(hex, 16)); advance(src.slice(i, i + 6));
          } else { text += e; advance(src.slice(i, i + 2)); }
          continue;
        }
        if (canInterp && src[i] === '{') {
          if (text) { parts.push({ k: 't', v: text }); text = ''; }
          const el = line, ec = col, es = i + 1;
          advance('{');
          let d = 1, inStr = null;
          while (i < n && d > 0) {
            const c = src[i];
            if (inStr) {
              if (c === '\\') { advance(src.slice(i, i + 2)); continue; }
              if (c === inStr) inStr = null;
              advance(c); continue;
            }
            if (c === '"' || c === "'") { inStr = c; advance(c); continue; }
            if (c === '{') d++;
            else if (c === '}') { d--; if (d === 0) break; }
            advance(c);
          }
          if (d !== 0) fail('unterminated interpolation', el, ec);
          parts.push({ k: 'e', src: src.slice(es, i), line: el, col: ec + 1 });
          advance('}');
          continue;
        }
        text += src[i];
        advance(src[i]);
      }
      if (!closed) fail('unterminated string', l0, c0);
      if (text || parts.length === 0) parts.push({ k: 't', v: text });
      pushAt('str', null, l0, c0, s0, i, { parts });
      continue;
    }

    // --- numbers -----------------------------------------------------------
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(src[i + 1] || ''))) {
      const m = NUM_RE.exec(src.slice(i));
      if (!m) fail('bad number');
      let raw = m[0];
      // don't swallow the dot of a range operator: `1..3` is 1 .. 3
      if (raw.endsWith('.') && src[i + raw.length] === '.') raw = raw.slice(0, -1);
      let v;
      if (/^0[xX]/.test(raw)) v = parseInt(raw.replace(/_/g, ''), 16);
      else if (/^0[bB]/.test(raw)) v = parseInt(raw.replace(/_/g, '').slice(2), 2);
      else v = parseFloat(raw.replace(/_/g, ''));
      pushAt('num', v, line, col, i, i + raw.length, { raw });
      advance(raw);
      continue;
    }

    // --- identifiers / keywords -------------------------------------------
    if (ID_START.test(ch)) {
      let j = i + 1;
      while (j < n && ID_CONT.test(src[j])) j++;
      const word = src.slice(i, j);
      pushAt(KEYWORDS.has(word) ? 'kw' : 'id', word, line, col, i, j);
      advance(word);
      continue;
    }

    // --- operators ----------------------------------------------------------
    let matched = null;
    for (const op of OP_BY_LEN) { if (src.startsWith(op, i)) { matched = op; break; } }
    if (matched) {
      if ('([{'.includes(matched)) depth++;
      else if (')]}'.includes(matched)) depth = Math.max(0, depth - 1);
      pushAt('op', matched, line, col, i, i + matched.length);
      advance(matched);
      continue;
    }
    fail(`unexpected character ${JSON.stringify(ch)}`);
  }

  // final layout
  if (toks.length && toks[toks.length - 1].t !== 'nl') pushAt('nl', '\n', line, col, i, i);
  while (indents.length > 1) { indents.pop(); pushAt('dedent', indents.length, line, col, i, i); }
  toks.push({ t: 'eof', v: null, line, col, start: i, end: i });
  return toks;
}
