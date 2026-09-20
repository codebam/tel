// Tel core runtime — shared by the tree-walk interpreter and all code generators.
// Codegen inlines this file with `export ` prefixes stripped, so keep all top-level
// declarations side-effect free and dependency free (no node: imports here).

export class Sum {
  constructor(tag, vals = [], type = null) {
    this.__tag = tag;
    this.__v = vals;
    this.__t = type || tag;
  }
}

export class Range {
  constructor(start, end, inclusive = false, step = undefined) {
    this.start = start;
    this.end = end;
    this.inclusive = inclusive;
    this.step = step;
    this.__range = true;
  }
  *[Symbol.iterator]() {
    let s = this.step;
    if (s === undefined || s === null) s = this.end >= this.start ? 1 : -1;
    if (s === 0) throw new Error('range step cannot be 0');
    const stop = this.inclusive ? this.end : this.end - (s > 0 ? 0 : 0);
    if (s > 0) {
      for (let i = this.start; this.inclusive ? i <= stop : i < stop; i += s) yield i;
    } else {
      for (let i = this.start; this.inclusive ? i >= stop : i > stop; i += s) yield i;
    }
  }
}

// Early return payload for the `?` propagation operator.
export class Early {
  constructor(value) { this.value = value; this.__early = true; }
}

export function Ok(value) { return new Sum('Ok', [value], 'Result'); }
export function Err(error) { return new Sum('Err', [error], 'Result'); }
export const Nil = null;

// --- structural equality ---------------------------------------------------
export function eq(a, b) {
  if (Object.is(a, b)) return true;
  if (isSum(a) || isSum(b)) {
    if (!(isSum(a) && isSum(b))) return false;
    if (a.__tag !== b.__tag || a.__v.length !== b.__v.length) return false;
    return a.__v.every((v, i) => eq(v, b.__v[i]));
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!(Array.isArray(a) && Array.isArray(b)) || a.length !== b.length) return false;
    return a.every((v, i) => eq(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && eq(a[k], b[k]));
  }
  return false;
}

// --- printing / conversion -------------------------------------------------
export function str(x) {
  if (x === null || x === undefined) return 'nil';
  if (typeof x === 'string') return x;
  if (typeof x === 'number') return String(x);
  if (typeof x === 'boolean') return x ? 'true' : 'false';
  if (isSum(x)) return x.__v.length ? `${x.__tag}(${x.__v.map(str).join(', ')})` : x.__tag;
  if (Array.isArray(x)) return `[${x.map(str).join(', ')}]`;
  if (x && x.__range) return `${x.start}..${x.inclusive ? '=' : ''}${x.end}`;
  if (typeof x === 'function') return '<fn>';
  if (x instanceof Error) return x.message ? `${x.name}: ${x.message}` : x.name;
  return repr(x);
}

export function repr(x) {
  if (x === null || x === undefined) return 'nil';
  if (typeof x === 'string') return JSON.stringify(x);
  if (typeof x === 'number' || typeof x === 'boolean') return String(x);
  if (isSum(x)) return x.__v.length ? `${x.__tag}(${x.__v.map(repr).join(', ')})` : x.__tag;
  if (Array.isArray(x)) return `[${x.map(repr).join(', ')}]`;
  if (x instanceof Range) return str(x);
  if (typeof x === 'function') return '<fn>';
  if (x instanceof Error) return x.message ? `${x.name}: ${x.message}` : x.name;
  if (typeof x === 'object') {
    return `{${Object.entries(x).map(([k, v]) => `${k}: ${repr(v)}`).join(', ')}}`;
  }
  return String(x);
}

export function truthy(x) { return !(x === null || x === undefined || x === false); }

// Cross-module safe Sum check: each compiled file inlines its own runtime copy,
// so `instanceof` cannot be used between modules.
export function isSum(x) { return x !== null && typeof x === 'object' && typeof x.__tag === 'string' && Array.isArray(x.__v); }

export function add(a, b) {
  if (typeof a === 'string' || typeof b === 'string') return str(a) + str(b);
  return a + b;
}

// --- `?` propagation and helpers ------------------------------------------
export function q(x) {
  if (x === null || x === undefined) throw new Early(null);
  if (x instanceof Sum && x.__tag === 'Err') throw new Early(x);
  if (x instanceof Sum && x.__tag === 'Ok') return x.__v[0];
  return x;
}

// Wrap a sync function so `expr?` early-returns its Err/Nil payload.
export function __p(fn) {
  try { return fn(); } catch (e) { if (e instanceof Early) return e.value; throw e; }
}

// Async variant: also unwraps a returned promise *inside* the wrapper.
export async function __pa(fn) {
  try { return await fn(); } catch (e) { if (e instanceof Early) return e.value; throw e; }
}

// `a ?? b`
export function and(a, bf) { return truthy(a) ? bf() : a; }
export function or(a, bf) { return truthy(a) ? a : bf(); }
export function coalesce(a, bf) {
  if (a === null || a === undefined) return bf();
  if (isSum(a) && a.__tag === 'Err') return bf();
  if (isSum(a) && a.__tag === 'Ok') return a.__v[0];
  return a;
}

export function d(x, fallback) {
  if (x === null || x === undefined) return fallback;
  if (x instanceof Sum && x.__tag === 'Err') return fallback;
  if (x instanceof Sum && x.__tag === 'Ok') return x.__v[0];
  return x;
}

// --- records / variants ----------------------------------------------------
export function rec(type, fields) {
  const o = {};
  for (const [k, v] of Object.entries(fields)) o[k] = v;
  if (type) Object.defineProperty(o, '__t', { value: type, enumerable: false, configurable: true });
  return o;
}

export function variant(type, tag, fields = []) {
  const ctor = (...args) => {
    let vals = args;
    if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0]) && !(args[0] instanceof Sum)) {
      const named = args[0];
      vals = fields.map((f) => named[f]);
    }
    return new Sum(tag, vals, type);
  };
  ctor.__type = type;
  ctor.__tag = tag;
  ctor.__fields = fields;
  return ctor;
}

export function unit(type, tag) { return new Sum(tag, [], type); }

export function typeName(x) {
  if (x === null || x === undefined) return 'Nil';
  if (isSum(x)) return x.__t || x.__tag;
  if (Array.isArray(x)) return 'List';
  if (x && x.__range) return 'Range';
  const t = typeof x;
  if (t === 'string') return 'Str';
  if (t === 'number') return 'Num';
  if (t === 'boolean') return 'Bool';
  if (t === 'function') return 'Fn';
  if (x.__t) return x.__t;
  return 'Record';
}

export function isType(x, name) {
  if (name === 'Any') return true;
  if (name === 'Nil') return x === null || x === undefined;
  if (name === 'Str') return typeof x === 'string';
  if (name === 'Bool') return typeof x === 'boolean';
  if (name === 'Num' || name === 'Int') return typeof x === 'number';
  if (name === 'List') return Array.isArray(x);
  if (name === 'Fn') return typeof x === 'function';
  if (name === 'Range') return !!(x && x.__range);
  if (name === 'Result') return isSum(x) && (x.__tag === 'Ok' || x.__tag === 'Err');
  if (isSum(x)) return x.__t === name || x.__tag === name;
  return typeName(x) === name;
}

// --- iteration / ranges ----------------------------------------------------
export function range(start, end, inclusive = false, step = undefined) {
  return new Range(start, end, inclusive, step);
}

export function iter(x) {
  if (x === null || x === undefined) throw new Error('cannot iterate nil');
  if (Array.isArray(x)) return x;
  if (typeof x === 'string') return x;
  if (typeof x[Symbol.iterator] === 'function') return x;
  if (x && x.__range) return x;
  if (typeof x === 'object') return Object.keys(x);
  throw new Error(`cannot iterate ${typeName(x)}`);
}

export function len(x) {
  if (x === null || x === undefined) return 0;
  if (typeof x === 'string' || Array.isArray(x)) return x.length;
  if (x && x.__range) return [...x].length;
  if (typeof x === 'object') return Object.keys(x).length;
  return 0;
}

export function keys(x) {
  if (x === null || x === undefined) return [];
  return typeof x === 'object' && !Array.isArray(x) ? Object.keys(x) : [];
}
export function values(x) { return keys(x).map((k) => x[k]); }
export function entries(x) { return keys(x).map((k) => [k, x[k]]); }

export function at(x, i) {
  if (typeof x === 'string') return x.at(i);
  if (Array.isArray(x)) return x.at(i);
  return x?.[i];
}

export function slice(x, start, end, inclusive = false) {
  let s = start === undefined || start === null ? undefined : start;
  let e = end === undefined || end === null ? undefined : end;
  if (s !== undefined && s < 0) s = len(x) + s;
  if (e !== undefined) {
    if (inclusive) e = e + 1;
    if (e < 0) e = len(x) + e;
  }
  if (typeof x === 'string') return x.slice(s, e);
  if (Array.isArray(x)) return x.slice(s, e);
  return x;
}

export function get(x, k, fallback = null) {
  if (x === null || x === undefined) return fallback;
  const v = x[k];
  return v === undefined ? fallback : v;
}
export function has(x, k) { return x !== null && x !== undefined && Object.prototype.hasOwnProperty.call(x, k); }
export function set(x, k, v) { x[k] = v; return x; }
export function del(x, k) { delete x[k]; return x; }

export function push(x, ...vs) { x.push(...vs); return x; }
export function pop(x) { return x.pop(); }
export function shift(x) { return x.shift(); }
export function unshift(x, ...vs) { x.unshift(...vs); return x; }

// --- collection functions (also registered as UFCS methods) ---------------
function toList(x) {
  if (Array.isArray(x)) return x;
  if (x && x.__range) return [...x];
  if (typeof x === 'string') return [...x];
  return [...iter(x)];
}

export function map(x, fn) { return toList(x).map((v, i) => fn(v, i)); }
export function filter(x, fn) { return toList(x).filter((v, i) => truthy(fn(v, i))); }
export function reduce(x, init, fn) {
  const xs = toList(x);
  let acc = init, i = 0;
  if (arguments.length < 2 || init === undefined) { acc = xs[0]; i = 1; }
  for (; i < xs.length; i++) acc = fn(acc, xs[i], i);
  return acc;
}
export function find(x, fn) { return toList(x).find((v, i) => truthy(fn(v, i))) ?? null; }
export function findIndex(x, fn) { const i = toList(x).findIndex((v, j) => truthy(fn(v, j))); return i < 0 ? null : i; }
export function some(x, fn) { return toList(x).some((v, i) => truthy(fn(v, i))); }
export function every(x, fn) { return toList(x).every((v, i) => truthy(fn(v, i))); }
export function count(x, fn) { return toList(x).filter((v, i) => truthy(fn(v, i))).length; }
export function sum(x) { return toList(x).reduce((a, b) => a + b, 0); }
export function min(x) { return toList(x).reduce((a, b) => (a < b ? a : b)); }
export function max(x) { return toList(x).reduce((a, b) => (a > b ? a : b)); }
export function uniq(x) { const out = []; for (const v of toList(x)) if (!out.some((u) => eq(u, v))) out.push(v); return out; }
export function flat(x, depth = 1) { return toList(x).flat(depth); }
export function reverse(x) { return toList(x).slice().reverse(); }
export function join(x, sep = '') { return toList(x).map(str).join(sep); }
export function contains(x, v) { return toList(x).some((u) => eq(u, v)); }
export function sort(x, cmp) {
  const xs = toList(x).slice();
  if (cmp) xs.sort((a, b) => { const r = cmp(a, b); return typeof r === 'number' ? r : (truthy(r) ? -1 : 1); });
  else xs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return xs;
}
export function sortBy(x, key) { return sort(x, (a, b) => { const ka = key(a), kb = key(b); return ka < kb ? -1 : ka > kb ? 1 : 0; }); }
export function zip(a, b) { const x = toList(a), y = toList(b); const n = Math.min(x.length, y.length); return Array.from({ length: n }, (_, i) => [x[i], y[i]]); }
export function enumerate(x) { return toList(x).map((v, i) => [i, v]); }
export function take(x, n) { return toList(x).slice(0, n); }
export function drop(x, n) { return toList(x).slice(n); }
export function first(x) { const v = toList(x)[0]; return v === undefined ? null : v; }
export function last(x) { const xs = toList(x); return xs.length ? xs[xs.length - 1] : null; }
export function groupBy(x, key) {
  const out = {};
  for (const v of toList(x)) { const k = str(key(v)); (out[k] ||= []).push(v); }
  return out;
}
export function chunk(x, n) {
  const xs = toList(x), out = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
export function each(x, fn) { return toList(x).map((v, i) => fn(v, i)); }
export function show(cond, value) { return truthy(cond) ? value : null; }

// --- strings ---------------------------------------------------------------
export function upper(s) { return str(s).toUpperCase(); }
export function lower(s) { return str(s).toLowerCase(); }
export function trim(s) { return str(s).trim(); }
export function split(s, sep) { return str(s).split(sep); }
export function replace(s, a, b) { return str(s).replace(a, b); }
export function replaceAll(s, a, b) { return str(s).split(a).join(b); }
export function startsWith(s, p) { return str(s).startsWith(p); }
export function endsWith(s, p) { return str(s).endsWith(p); }
export function includes(s, p) { return str(s).includes(p); }
export function repeat(s, n) { return str(s).repeat(n); }
export function chars(s) { return [...str(s)]; }
export function padStart(s, n, c = ' ') { return str(s).padStart(n, c); }
export function padEnd(s, n, c = ' ') { return str(s).padEnd(n, c); }
export function lines(s) { return str(s).split(/\r?\n/); }

// --- numbers / misc ---------------------------------------------------------
export function int(x) { const n = Number(x); return Number.isNaN(n) ? 0 : Math.trunc(n); }
export function num(x) { const n = Number(x); return Number.isNaN(n) ? 0 : n; }
export function bool(x) { return truthy(x); }
export function abs(x) { return Math.abs(x); }
export function floor(x) { return Math.floor(x); }
export function ceil(x) { return Math.ceil(x); }
export function round(x) { return Math.round(x); }
export function sqrt(x) { return Math.sqrt(x); }
export function pow(a, b) { return a ** b; }
export function rand(a = 1, b = undefined) { return b === undefined ? Math.random() * a : a + Math.random() * (b - a); }
export function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

export function print(...args) { console.log(args.map(str).join(' ')); return null; }
export function eprint(...args) { console.error(args.map(str).join(' ')); return null; }
export function panic(msg = 'panic') { throw new Error(str(msg)); }
export function assert(cond, msg = 'assertion failed') { if (!truthy(cond)) throw new Error(str(msg)); return true; }

export function spawn(fn) { return Promise.resolve().then(fn); }
export function noMatch(value) { throw new Error(`match: no arm matched ${repr(value)}`); }

// --- pattern matching -------------------------------------------------------
export function matchPat(v, p) {
  const k = p[0];
  switch (k) {
    case '_': return {};
    case 'bind': return { [p[1]]: v };
    case 'lit': return eq(v, p[1]) ? {} : null;
    case 'nil': return (v === null || v === undefined) ? {} : null;
    case 'range': {
      const [, lo, hi, inc] = p;
      if (typeof v !== 'number') return null;
      const ok = inc ? (v >= lo && v <= hi) : (v >= lo && v < hi);
      return ok ? {} : null;
    }
    case 'tup': {
      if (!Array.isArray(v) || v.length !== p[1].length) return null;
      return mergeBinds(p[1].map((sp, i) => matchPat(v[i], sp)));
    }
    case 'arr': {
      if (!Array.isArray(v)) return null;
      const subs = p[1], rest = p[2];
      if (v.length < subs.length) return null;
      const head = subs.map((sp, i) => matchPat(v[i], sp));
      if (rest === null) {
        if (v.length !== subs.length) return null;
        return mergeBinds([...head, {}]);
      }
      return mergeBinds([...head, { [rest]: v.slice(subs.length) }]);
    }
    case 'rec': {
      if (v === null || typeof v !== 'object' || v instanceof Sum) return null;
      const [ , fields, restName ] = p;
      const out = {};
      for (const [f, sp] of Object.entries(fields)) {
        if (!(f in v)) return null;
        const b = matchPat(v[f], sp);
        if (b === null) return null;
        Object.assign(out, b);
      }
      if (restName) {
        const rest = {};
        for (const key of Object.keys(v)) if (!(key in fields)) rest[key] = v[key];
        out[restName] = rest;
      }
      return out;
    }
    case 'tag': {
      if (!isSum(v) || v.__tag !== p[1]) return null;
      const subs = p[2] || [];
      if (v.__v.length !== subs.length) return null;
      return mergeBinds(subs.map((sp, i) => matchPat(v.__v[i], sp)));
    }
    case 'or': {
      for (const alt of p[1]) { const b = matchPat(v, alt); if (b !== null) return b; }
      return null;
    }
    default: throw new Error(`bad pattern ${JSON.stringify(p)}`);
  }
}
function mergeBinds(parts) {
  if (parts.some((b) => b === null)) return null;
  return Object.assign({}, ...parts);
}

// --- method dispatch / registration ----------------------------------------
const methods = (globalThis.__tel_methods ||= Object.create(null));

export function reg(name, fn) {
  methods[name] = fn;
  return fn;
}

export function hasMethod(o, name) {
  if (o === null || o === undefined) return false;
  if (typeof o[name] === 'function') return true;
  const t = typeName(o);
  return !!(methods[`${t}.${name}`] || methods[name]);
}

function isPlainObject(o) {
  const p = Object.getPrototypeOf(o);
  return p === Object.prototype || p === null;
}

function isTelCore(o) {
  return Array.isArray(o) || typeof o === 'string' || (o && (o.__range || isSum(o))) || isPlainObject(o);
}

export function mcall(o, name, args) {
  if (o === null || o === undefined) throw new Error(`cannot call .${name} on nil`);
  if (o.__ns && typeof o[name] === 'function') return o[name](...args);
  if (Object.prototype.hasOwnProperty.call(o, name) && typeof o[name] === 'function') return o[name].apply(o, args);
  const t = typeName(o);
  const typed = methods[`${t}.${name}`];
  const bare = methods[name];
  if (isTelCore(o)) {
    if (typed) return typed(o, ...args);
    if (bare) return bare(o, ...args);
  }
  if (typeof o[name] === 'function') return o[name].apply(o, args);
  const f = typed || bare;
  if (f) return f(o, ...args);
  throw new Error(`unknown method .${name} on ${t}`);
}

// --- json / math namespaces -------------------------------------------------
export const json = {
  parse(s) { try { return Ok(JSON.parse(str(s))); } catch (e) { return Err(String(e.message || e)); } },
  stringify(x, indent = null) { try { return JSON.stringify(x, null, indent); } catch (e) { return repr(x); } },
  pretty(x) { return JSON.stringify(x, null, 2); },
};

export const math = {
  pi: Math.PI, e: Math.E,
  abs, floor, ceil, round, sqrt, pow, min, max, clamp,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log, exp: Math.exp,
  random: Math.random,
};

// register built-in methods for UFCS / `.method()` syntax
for (const [n, f] of Object.entries({ map, filter, reduce, find, findIndex, some, every, count, sum, min, max, uniq, flat, reverse, join, contains, sort, sortBy, zip, enumerate, take, drop, first, last, groupBy, chunk, each, len, push, pop, shift, unshift })) {
  reg(`List.${n}`, f);
}
for (const [n, f] of Object.entries({ map, filter, reduce, find, some, every, count, sum, join, contains, sort, reverse, take, drop, first, last, each })) {
  reg(`Str.${n}`, (s, ...a) => f(s, ...a));
}
for (const [n, f] of Object.entries({ upper, lower, trim, split, replace, replaceAll, startsWith, endsWith, includes, repeat, chars, padStart, padEnd, lines })) {
  reg(`Str.${n}`, f);
  reg(n, f);
}
for (const [n, f] of Object.entries({ len, keys, values, entries, get, has, set, del, map, filter, each })) {
  reg(`Record.${n}`, (o, ...a) => (n === 'len' ? len(o) : f(o, ...a)));
  reg(`${'Obj'}.${n}`, (o, ...a) => (n === 'len' ? len(o) : f(o, ...a)));
}
for (const n of ['map', 'filter', 'reduce', 'each', 'take', 'drop', 'contains', 'sum', 'join', 'reverse', 'sort', 'enumerate', 'len', 'first', 'last']) {
  const f = methods[`List.${n}`];
  reg(`Range.${n}`, (r, ...a) => f([...r], ...a));
}
// global function names usable with UFCS: xs.f(fn) -> f(xs, fn)
for (const [n, f] of Object.entries({ map, filter, reduce, find, findIndex, some, every, count, sum, min, max, uniq, flat, reverse, join, contains, sort, sortBy, zip, enumerate, take, drop, first, last, groupBy, chunk, each, len, keys, values, entries, get, has, set, del, push, pop, shift, unshift, upper, lower, trim, split, replace, replaceAll, startsWith, endsWith, includes, repeat, chars, padStart, padEnd, lines, abs, floor, ceil, round, sqrt, pow, str, int, num, bool })) {
  if (!methods[n]) reg(n, f);
}
