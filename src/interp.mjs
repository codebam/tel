// Tel tree-walk interpreter. Evaluation is written as generator functions so an
// async runner can await promises without forcing every callback to be async.
// Sync callbacks handed to runtime builtins (map/filter/sort/...) complete
// synchronously unless they actually use `await`, which is an error there.
import fs from 'node:fs';
import path from 'node:path';
import proc from 'node:process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parse } from './parser.mjs';
import * as core from '../runtime/tel_rt.mjs';
import { makeNodeExtra } from '../runtime/node_factory.mjs';
import { makeWebExtra } from '../runtime/web_factory.mjs';
import * as nodeFs from 'node:fs';
import * as nodeHttp from 'node:http';
import * as nodePath from 'node:path';

export class TelRuntimeError extends Error {
  constructor(msg, loc) {
    super(msg);
    this.name = 'TelRuntimeError';
    this.loc = loc && typeof loc === 'object' && Number.isInteger(loc.line)
      ? { line: loc.line, col: loc.col }
      : (loc ?? null);
  }
}
class ReturnSignal { constructor(v) { this.value = v; } }
class BreakSignal {}
class ContinueSignal {}

function isThenable(x) { return x !== null && x !== undefined && typeof x.then === 'function'; }

// --- runners ----------------------------------------------------------------
export function runSync(gen) {
  let input;
  for (;;) {
    const r = gen.next(input);
    if (r.done) return r.value;
    if (isThenable(r.value)) {
      throw new TelRuntimeError('await used outside an async function', r.value?.loc);
    }
    input = r.value;
  }
}

export async function runAsync(gen) {
  let input;
  for (;;) {
    const r = gen.next(input);
    if (r.done) return r.value;
    input = await r.value;
  }
}

// --- environments -----------------------------------------------------------
export class Env {
  constructor(parent = null) {
    this.vars = Object.create(null);
    this.parent = parent;
    this.selfValue = null;
  }
  hasLocal(n) { return n in this.vars; }
  lookup(n) {
    let e = this;
    while (e) {
      if (n in e.vars) return { found: true, env: e, value: e.vars[n], field: false };
      if (e.selfValue && n in Object(e.selfValue)) return { found: true, env: e, value: e.selfValue[n], field: true };
      e = e.parent;
    }
    return { found: false };
  }
  get(n, loc) {
    const r = this.lookup(n);
    if (!r.found) throw new TelRuntimeError(`undefined name '${n}'`, loc);
    return r.value;
  }
  define(n, v) { this.vars[n] = v; return v; }
  assign(n, v) {
    const r = this.lookup(n);
    if (r.found) { r.env.vars[n] = v; return v; }
    this.vars[n] = v; return v;
  }
}

// --- engine -----------------------------------------------------------------
export function makeBuiltins(opts = {}) {
  const nodeExtra = opts.node === false ? {} : makeNodeExtra(core, nodeFs, nodeHttp, nodePath, proc);
  const webExtra = makeWebExtra(core);
  const std = {
    json: core.json,
    math: core.math,
    ...(nodeExtra.fs ? { fs: nodeExtra.fs, http: nodeExtra.http, env: nodeExtra.env, time: nodeExtra.time } : {}),
  };
  const builtins = { ...core, ...webExtra, ...(nodeExtra.fs ? nodeExtra : {}) };
  // JavaScript standard library globals, so interop feels like JS.
  const JS_GLOBALS = ['Object', 'Array', 'String', 'Number', 'Boolean', 'BigInt', 'Symbol', 'Math', 'JSON',
    'Date', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Error', 'TypeError', 'RangeError',
    'SyntaxError', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'Intl', 'Proxy', 'Reflect',
    'structuredClone', 'fetch', 'console', 'process', 'Buffer', 'setTimeout', 'clearTimeout', 'setInterval',
    'clearInterval', 'queueMicrotask'];
  for (const g of JS_GLOBALS) {
    if (typeof globalThis[g] !== 'undefined') builtins[g] = globalThis[g];
  }
  delete builtins.Sum; delete builtins.Early; delete builtins.Range;
  builtins.std = std;
  builtins.args = opts.args ?? [];
  builtins.render = webExtra.html;
  builtins.html = webExtra.html;
  for (const ns of [std.json, std.math, std.fs, std.http, std.env, std.time]) {
    if (ns && typeof ns === 'object') Object.defineProperty(ns, '__ns', { value: true, enumerable: false });
  }
  return builtins;
}

export function createGlobalEnv(opts = {}) {
  const env = new Env(null);
  for (const [k, v] of Object.entries(makeBuiltins(opts))) env.define(k, v);
  return env;
}

export class Runtime {
  constructor(opts = {}) {
    this.opts = opts;
    this.globalEnv = createGlobalEnv(opts);
    this.moduleCache = new Map();
    this.currentFile = opts.file ? path.resolve(opts.file) : null;
  }

  // -- functions ------------------------------------------------------------
  makeFn(decl, closure) {
    const isAsync = !!decl.async;
    const self = this;
    const fn = function (...args) {
      const gen = self.callUserGen(decl, args, closure);
      return self.finishCall(gen, isAsync);
    };
    fn.__telDecl = decl;
    return fn;
  }

  makeLambda(lam, closure) {
    const isAsync = !!lam.async;
    const self = this;
    const fn = function (...args) {
      const gen = self.callLambdaGen(lam, args, closure);
      return self.finishCall(gen, isAsync);
    };
    fn.__telLambda = lam;
    return fn;
  }

  finishCall(gen, isAsync) {
    const settle = (e) => {
      if (e instanceof ReturnSignal) return { v: e.value };
      if (e instanceof core.Early) return { v: e.value };
      return null;
    };
    if (isAsync) {
      return (async () => {
        try { return await runAsync(gen); }
        catch (e) { const r = settle(e); if (r) return r.v; throw e; }
      })();
    }
    try { return runSync(gen); }
    catch (e) { const r = settle(e); if (r) return r.v; throw e; }
  }

  *callUserGen(decl, args, closure) {
    const env = new Env(closure);
    yield* this.bindParams(decl.params, args, env);
    if (decl.recvType || (decl.params[0] && decl.params[0].name === 'self')) {
      env.selfValue = args[0] ?? null;
    }
    return yield* this.execStatements(decl.body.body, env, { hoist: true });
  }

  *callLambdaGen(lam, args, closure) {
    const env = new Env(closure);
    yield* this.bindParams(lam.params, args, env);
    return yield* this.execStatements(lam.body.body, env, { hoist: true });
  }

  *bindParams(params, args, env) {
    let ai = 0;
    for (const p of params) {
      if (p.rest) { env.define(p.name, args.slice(ai)); ai = args.length; continue; }
      let v = args[ai++];
      if (v === undefined && p.default) v = yield* this.ev(p.default, env);
      env.define(p.name, v === undefined ? null : v);
    }
    return env;
  }

  // -- statements -----------------------------------------------------------
  *execStatements(stmts, env, opts = {}) {
    // hoist imports, functions and type declarations
    for (const st of stmts) {
      if (st.type === 'Import') yield* this.execImport(st, env);
    }
    for (const st of stmts) {
      if (st.type === 'FnDecl') {
        const fn = this.makeFn(st, env);
        env.define(st.name, fn);
        if (st.recvType) {
          core.reg(`${st.recvType}.${st.name}`, fn);
          core.reg(st.name, fn);
        } else {
          core.reg(st.name, fn);
        }
      }
    }
    for (const st of stmts) {
      if (st.type === 'TypeDecl') this.defineType(st, env);
    }
    const defers = [];
    let result = null;
    try {
      for (const st of stmts) {
        if (st.type === 'Import' || st.type === 'FnDecl' || st.type === 'TypeDecl') continue;
        if (st.type === 'Defer') { defers.push(st); continue; }
        result = yield* this.exec(st, env);
      }
    } finally {
      for (const d of defers.reverse()) yield* this.ev(d.value, env);
    }
    return result;
  }

  *exec(st, env) {
    try {
      switch (st.type) {
        case 'ExprStmt': return yield* this.ev(st.expr, env);
        case 'Let': {
          const value = st.value ? yield* this.ev(st.value, env) : null;
          if (st.pattern.type === 'PBind' && !st.ann) env.assign(st.pattern.name, value);
          else yield* this.bindPattern(st.pattern, value, env, { local: !!st.ann || st.pattern.type !== 'PBind' });
          return value;
        }
        case 'Assign': return yield* this.assign(st.target, st.op, st.value, env);
        case 'If': {
          const c = yield* this.ev(st.cond, env);
          if (core.truthy(c)) return yield* this.execStatements(st.then.body, env, { hoist: true });
          for (const el of st.elifs) {
            if (core.truthy(yield* this.ev(el.cond, env))) return yield* this.execStatements(el.body.body, env, { hoist: true });
          }
          if (st.else) return yield* this.execStatements(st.else.body, env, { hoist: true });
          return null;
        }
        case 'While': {
          let out = null;
          while (core.truthy(yield* this.ev(st.cond, env))) {
            try { out = yield* this.execStatements(st.body.body, env, { hoist: true }); }
            catch (e) {
              if (e instanceof BreakSignal) break;
              if (e instanceof ContinueSignal) continue;
              throw e;
            }
          }
          return out;
        }
        case 'Loop': {
          let out = null;
          for (;;) {
            try { out = yield* this.execStatements(st.body.body, env, { hoist: true }); }
            catch (e) {
              if (e instanceof BreakSignal) break;
              if (e instanceof ContinueSignal) continue;
              throw e;
            }
          }
          return out;
        }
        case 'For': {
          const xs = yield* this.ev(st.iter, env);
          let out = null;
          for (const v of core.iter(xs)) {
            const child = new Env(env);
            yield* this.bindPattern(st.pattern, v, child, { local: true });
            try { out = yield* this.execStatements(st.body.body, child, { hoist: true }); }
            catch (e) {
              if (e instanceof BreakSignal) break;
              if (e instanceof ContinueSignal) continue;
              throw e;
            }
          }
          return out;
        }
        case 'Match': return yield* this.execMatch(st, env);
        case 'Return': throw new ReturnSignal(st.value ? yield* this.ev(st.value, env) : null);
        case 'Break': throw new BreakSignal();
        case 'Continue': throw new ContinueSignal();
        case 'Throw': throw yield* this.ev(st.value, env);
        case 'Try': {
          try {
            return yield* this.execStatements(st.body.body, env, { hoist: true });
          } catch (e) {
            if (e instanceof ReturnSignal || e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof core.Early) throw e;
            for (const c of st.catches) {
              const child = new Env(env);
              const b = core.matchPat(e, patternDesc(c.pattern));
              if (b === null) continue;
              for (const [k, v] of Object.entries(b)) child.define(k, v);
              return yield* this.execStatements(c.body.body, child, { hoist: true });
            }
            throw e;
          } finally {
            if (st.fin) yield* this.execStatements(st.fin.body, env, { hoist: true });
          }
        }
        case 'Defer': return null;
        default:
          if (st.type === 'FnDecl' || st.type === 'TypeDecl' || st.type === 'Import') return null;
          throw new TelRuntimeError(`interpreter: cannot execute ${st.type}`, st);
      }
    } catch (e) {
      if (e instanceof Error && !e.loc && st.line !== undefined) e.loc = { line: st.line, col: st.col };
      throw e;
    }
  }

  *execMatch(st, env) {
    const v = yield* this.ev(st.subj, env);
    for (const arm of st.arms) {
      const b = core.matchPat(v, patternDesc(arm.pattern));
      if (b === null) continue;
      const child = new Env(env);
      for (const [k, val] of Object.entries(b)) child.define(k, val);
      if (arm.guard && !core.truthy(yield* this.ev(arm.guard, child))) continue;
      return yield* this.execStatements(arm.body.body, child, { hoist: true });
    }
    return core.noMatch(v);
  }

  *assign(target, op, valueExpr, env) {
    if (target.type === 'Ident' && op === '=') return env.assign(target.name, yield* this.ev(valueExpr, env));
    const rhs = yield* this.ev(valueExpr, env);
    if (target.type === 'Tuple' || target.type === 'Array' || target.type === 'Record') {
      return yield* this.bindPattern(exprToPattern(target), rhs, env, { local: false });
    }
    if (target.type === 'Ident') {
      const cur = op === '=' ? rhs : env.get(target.name, target);
      const next = op === '=' ? rhs : applyCompound(op, cur, rhs);
      env.assign(target.name, next);
      return next;
    }
    if (target.type === 'Member') {
      const o = yield* this.ev(target.obj, env);
      if (o === null || o === undefined) throw new TelRuntimeError(`cannot assign .${target.name} of nil`, target);
      const cur = op === '=' ? undefined : o[target.name];
      const next = op === '=' ? rhs : applyCompound(op, cur, rhs);
      o[target.name] = next;
      return next;
    }
    if (target.type === 'Index') {
      const o = yield* this.ev(target.obj, env);
      const i = yield* this.ev(target.index, env);
      const cur = op === '=' ? undefined : core.at(o, i);
      const next = op === '=' ? rhs : applyCompound(op, cur, rhs);
      o[i] = next;
      return next;
    }
    throw new TelRuntimeError('invalid assignment target', target);
  }

  // Pattern binding. local=true always defines in this env; otherwise first
  // assignment uses normal assign-or-define semantics.
  *bindPattern(pat, value, env, { local = false } = {}) {
    const b = core.matchPat(value, patternDesc(pat));
    if (b === null) throw new TelRuntimeError(`value does not match pattern ${pat.type}`, pat);
    for (const [k, v] of Object.entries(b)) {
      if (local) env.define(k, v); else env.assign(k, v);
    }
    return value;
  }

  // -- declarations ---------------------------------------------------------
  defineType(st, env) {
    if (st.kind === 'record') {
      const fields = st.fields.map((f) => f.name);
      const ctor = (...args) => {
        const out = {};
        const named = args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0]) && !(args[0] instanceof core.Sum) && fields.some((f) => f in args[0]);
        if (named) for (const f of fields) out[f] = args[0][f] === undefined ? null : args[0][f];
        else fields.forEach((f, i) => { out[f] = args[i] === undefined ? null : args[i]; });
        return core.rec(st.name, out);
      };
      ctor.__telKind = 'record';
      ctor.__fields = fields;
      env.define(st.name, ctor);
    } else if (st.kind === 'union') {
      for (const v of st.variants) {
        const fields = v.fields.map((f) => f.name);
        const ctor = core.variant(st.name, v.name, fields);
        if (fields.length === 0) env.define(v.name, ctor());
        else env.define(v.name, ctor);
        ctor.__telKind = 'variant';
      }
    }
    this.typeFields = this.typeFields || {};
    if (st.kind === 'record') this.typeFields[st.name] = st.fields.map((f) => f.name);
  }

  // -- imports ---------------------------------------------------------------
  *execImport(st, env, fromFile = this.currentFile) {
    if (st.kind === 'std' || (st.path && st.path.startsWith('std'))) {
      const std = this.globalEnv.get('std');
      const segs = st.path.split('.').slice(1);
      const source = segs.length ? segs.reduce((o, s) => (o ? o[s] : undefined), std) : std;
      if (st.names) {
        for (const n of st.names) {
          const v = st.path === 'std' ? std[n] : (source && source[n]);
          if (v === undefined) throw new TelRuntimeError(`std has no export '${n}'`, st);
          env.define(n, v);
        }
      } else if (st.alias) env.define(st.alias, source);
      return;
    }
    if (st.kind === 'js') {
      const spec = st.spec;
      const baseFile = fromFile || path.join(proc.cwd(), 'index.mjs');
      let href = spec;
      if (spec.startsWith('node:')) href = spec;
      else if (spec.startsWith('.') || spec.startsWith('/')) {
        href = pathToFileURL(path.resolve(path.dirname(baseFile), spec)).href;
      } else {
        try {
          const require = createRequire(pathToFileURL(baseFile));
          href = pathToFileURL(require.resolve(spec)).href;
        } catch { /* fall through: let Node try the bare specifier */ }
      }
      let mod;
      try { mod = yield import(href); }
      catch (e) { throw new TelRuntimeError(`cannot import '${spec}': ${e.message}`, st); }
      if (st.names) {
        for (const n of st.names) {
          if (!(n in mod)) throw new TelRuntimeError(`module '${spec}' has no export '${n}'`, st);
          env.define(n, mod[n]);
        }
      }
      if (st.alias && st.ns) { env.define(st.alias, mod); return; }
      if (st.alias) {
        let ns = mod.default !== undefined ? mod.default : mod;
        // hydrate default with named exports so `<alias>.name` works for both
        // CJS-style defaults (express) and ESM modules with default + named.
        if (ns && (typeof ns === 'object' || typeof ns === 'function')) {
          for (const k of Object.keys(mod)) {
            if (k === 'default' || k in ns) continue;
            try { ns[k] = mod[k]; } catch { /* frozen default: ignore */ }
          }
          if (Object.isExtensible(ns)) {
            try { Object.defineProperty(ns, '__ns', { value: true, enumerable: false }); } catch { /* ignore */ }
          }
        } else {
          ns = mod;
        }
        env.define(st.alias, ns);
      }
      return;
    }
    const base = fromFile ? path.dirname(fromFile) : proc.cwd();
    const abs = path.resolve(base, st.file || st.path || '');
    const mod = yield* this.loadModule(abs, { entry: false });
    if (st.names) {
      for (const n of st.names) {
        const v = mod.exports[n];
        if (v === undefined) throw new TelRuntimeError(`module '${st.file}' has no export '${n}'`, st);
        env.define(n, v);
      }
    } else if (st.alias) env.define(st.alias, mod.namespace);
  }

  *loadModule(abs, opts = {}) {
    if (this.moduleCache.has(abs)) return this.moduleCache.get(abs);
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch (e) { throw new TelRuntimeError(`cannot read module ${abs}: ${e.message}`); }
    const program = parse(src, { src });
    const env = new Env(this.globalEnv);
    const prevFile = this.currentFile;
    this.currentFile = abs;
    try {
      yield* this.execStatements(program.body, env, { hoist: true });
    } finally {
      this.currentFile = prevFile;
    }
    const programs = program.body;
    const pubNames = programs.filter((s) => (s.type === 'FnDecl' || s.type === 'TypeDecl') && s.isPub).map((s) => s.name);
    const anyPub = pubNames.length > 0;
    const exports = {};
    for (const st of programs) {
      if (st.type === 'FnDecl' && (!anyPub || st.isPub)) exports[st.name] = env.get(st.name, st);
      if (st.type === 'TypeDecl' && (!anyPub || st.isPub)) {
        if (st.kind === 'union') {
          for (const v of st.variants) { const b = env.lookup(v.name); if (b.found) exports[v.name] = b.value; }
        } else {
          const v = env.lookup(st.name); if (v.found) exports[st.name] = v.value;
        }
      }
    }
    const namespace = { ...exports };
    Object.defineProperty(namespace, '__ns', { value: true, enumerable: false });
    const mod = { path: abs, env, exports, namespace, program };
    this.moduleCache.set(abs, mod);
    return mod;
  }

  // -- expressions (generators) ---------------------------------------------
  *ev(e, env) {
    try {
      return yield* this.evInner(e, env);
    } catch (err) {
      if (err instanceof Error && !err.loc && e && e.line !== undefined) err.loc = { line: e.line, col: e.col };
      throw err;
    }
  }

  *evInner(e, env) {
    switch (e.type) {
      case 'Num': return e.value;
      case 'Bool': return e.value;
      case 'Nil': return null;
      case 'Str': {
        let out = '';
        for (const p of e.parts) {
          if (p.k === 't') out += p.v;
          else out += core.str(yield* this.ev(p.e, env));
        }
        return out;
      }
      case 'Ident': return env.get(e.name, e);
      case 'Placeholder': throw new TelRuntimeError('`_` is only valid as a shorthand lambda argument', e);
      case 'Array': {
        const out = [];
        for (const it of e.items) {
          if (it.type === 'Spread') out.push(...core.iter(yield* this.ev(it.e, env)));
          else out.push(yield* this.ev(it, env));
        }
        return out;
      }
      case 'Tuple': {
        const out = [];
        for (const it of e.items) out.push(yield* this.ev(it, env));
        return out;
      }
      case 'Record': {
        const out = {};
        for (const f of e.fields) {
          if (f.spread) { Object.assign(out, yield* this.ev(f.value, env)); continue; }
          out[f.key] = yield* this.ev(f.value, env);
        }
        return out;
      }
      case 'ArrayComp': {
        const out = [];
        yield* this.evalComprehension(e.clauses, 0, env, function* (rt, child) {
          out.push(yield* rt.ev(e.value, child));
        });
        return out;
      }
      case 'MapComp': {
        const out = {};
        yield* this.evalComprehension(e.clauses, 0, env, function* (rt, child) {
          const k = typeof e.key === 'string' ? e.key : core.str(yield* rt.ev(e.key, child));
          out[k] = yield* rt.ev(e.value, child);
        });
        return out;
      }
      case 'Lambda': return this.makeLambda(e, env);
      case 'Call': return yield* this.evalCall(e, env);
      case 'Member': {
        const o = yield* this.ev(e.obj, env);
        if (o === null || o === undefined) {
          if (e.optional) return null;
          throw new TelRuntimeError(`cannot read .${e.name} of nil`, e);
        }
        if (Object.prototype.hasOwnProperty.call(o, e.name)) {
          const v = o[e.name];
          return typeof v === 'function' ? v.bind(o) : v;
        }
        if (e.name in Object(o)) {
          const v = o[e.name]; // prototype getters and native methods
          if (typeof v === 'function') return (...args) => core.mcall(o, e.name, args);
          return v;
        }
        if (core.hasMethod(o, e.name)) return (...args) => core.mcall(o, e.name, args);
        return null;
      }
      case 'Index': {
        const o = yield* this.ev(e.obj, env);
        const i = yield* this.ev(e.index, env);
        return core.at(o, i);
      }
      case 'Slice': {
        const o = yield* this.ev(e.obj, env);
        const s = e.start ? yield* this.ev(e.start, env) : null;
        const en = e.end ? yield* this.ev(e.end, env) : null;
        return core.slice(o, s, en, e.inclusive);
      }
      case 'Unary': {
        const v = yield* this.ev(e.e, env);
        switch (e.op) {
          case '-': return -v;
          case '+': return +v;
          case '!': case 'not': return !core.truthy(v);
          case '~': return ~v;
          default: throw new TelRuntimeError(`bad unary ${e.op}`, e);
        }
      }
      case 'Binary': return yield* this.evalBinary(e, env);
      case 'Range': {
        const s = yield* this.ev(e.start, env);
        const en = yield* this.ev(e.end, env);
        return core.range(s, en, e.inclusive);
      }
      case 'If': {
        for (const [cond, body] of [[e.cond, e.then], ...e.elifs.map((x) => [x.cond, x.body])]) {
          if (core.truthy(yield* this.ev(cond, env))) return yield* this.execStatements(body.body, env, { hoist: true });
        }
        return e.else ? yield* this.execStatements(e.else.body, env, { hoist: true }) : null;
      }
      case 'Match': return yield* this.execMatch(e, env);
      case 'Propagate': return core.q(yield* this.ev(e.e, env));
      case 'Await': {
        const v = yield* this.ev(e.e, env);
        return isThenable(v) ? yield v : v;
      }
      case 'Spawn': {
        const rt = this; const childEnv = env;
        return core.spawn(() => runAsync((function* () { return yield* rt.ev(e.e, childEnv); })()));
      }
      case 'IsType': return core.isType(yield* this.ev(e.value, env), typeNameOf(e.of));
      case 'Assign': return yield* this.assign(e.target, e.op, e.value, env);
      case 'New': {
        const fn = yield* this.ev(e.callee, env);
        if (typeof fn !== 'function') throw new TelRuntimeError(`${exprName(e.callee)} is not a constructor`, e);
        const { args } = yield* this.evalArgs(e.args, env);
        return Reflect.construct(fn, args);
      }
      default:
        throw new TelRuntimeError(`interpreter: cannot evaluate ${e.type}`, e);
    }
  }

  *evalComprehension(clauses, i, env, cb) {
    if (i >= clauses.length) { yield* cb(this, env); return; }
    const c = clauses[i];
    if (c.k === 'for') {
      const xs = yield* this.ev(c.iter, env);
      for (const v of core.iter(xs)) {
        const child = new Env(env);
        yield* this.bindPattern(c.pattern, v, child, { local: true });
        yield* this.evalComprehension(clauses, i + 1, child, cb);
      }
    } else {
      if (core.truthy(yield* this.ev(c.cond, env))) yield* this.evalComprehension(clauses, i + 1, env, cb);
    }
  }

  *evalBinary(e, env) {
    const op = e.op;
    const a = yield* this.ev(e.l, env);
    if (op === 'and' || op === '&&') return core.truthy(a) ? yield* this.ev(e.r, env) : a;
    if (op === 'or' || op === '||') return core.truthy(a) ? a : yield* this.ev(e.r, env);
    if (op === '??') return core.d(a, yield* this.ev(e.r, env));
    const b = yield* this.ev(e.r, env);
    switch (op) {
      case '==': return core.eq(a, b);
      case '!=': return !core.eq(a, b);
      case '+': return (typeof a === 'string' || typeof b === 'string') ? core.str(a) + core.str(b) : a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return a / b;
      case '%': return a % b;
      case '**': return a ** b;
      case '<': return a < b;
      case '<=': return a <= b;
      case '>': return a > b;
      case '>=': return a >= b;
      case '&': return a & b;
      case '|': return a | b;
      case '^': return a ^ b;
      case '<<': return a << b;
      case '>>': return a >> b;
      case 'in': return core.contains(b, a);
      default: throw new TelRuntimeError(`bad operator ${op}`, e);
    }
  }

  *evalArgs(argNodes, env) {
    const named = {};
    const args = [];
    let hasNamed = false;
    for (const a of argNodes) {
      if (a.name) { hasNamed = true; named[a.name] = yield* this.ev(a.value, env); }
      else if (a.spread) args.push(...core.iter(yield* this.ev(a.value, env)));
      else args.push(yield* this.ev(a.value, env));
    }
    return { args, named, hasNamed };
  }

  *evalCall(e, env) {
    const { args, named, hasNamed } = yield* this.evalArgs(e.args, env);
    const namedObj = hasNamed ? named : undefined;

    if (e.callee.type === 'Member') {
      const o = yield* this.ev(e.callee.obj, env);
      if (o === null || o === undefined) {
        if (e.callee.optional) return null;
        throw new TelRuntimeError(`cannot call .${e.callee.name} of nil`, e);
      }
      const finalArgs = hasNamed ? [named, ...args] : args;
      return core.mcall(o, e.callee.name, finalArgs);
    }

    const fn = yield* this.ev(e.callee, env);
    if (typeof fn !== 'function') {
      const got = fn instanceof core.Sum ? `${fn.__tag}(...)` : core.typeName(fn);
      throw new TelRuntimeError(`'${exprName(e.callee)}' is ${got}, not a function`, e);
    }
    if (hasNamed) {
      if (fn.__telKind === 'record') return fn(named); // ctor tags __t correctly
      if (fn.__telKind === 'variant') return fn(named);
      args.unshift(named);
    }
    return fn(...args);
  }

  // -- program ---------------------------------------------------------------
  *runProgram(program, env) {
    return yield* this.execStatements(program.body, env, { hoist: true });
  }

  async runSource(src, { file, env } = {}) {
    const program = parse(src, { src });
    const target = env || new Env(this.globalEnv);
    const prev = this.currentFile;
    if (file) this.currentFile = path.resolve(file);
    try {
      let value;
      try {
        value = await runAsync(this.execStatements(program.body, target, { hoist: true }));
      } catch (e) {
        if (e instanceof core.Early) throw new TelRuntimeError(`unhandled ${core.repr(e.value)} propagated by ?`, null);
        throw e;
      }
      return { program, env: target, value };
    } finally { this.currentFile = prev; }
  }

  async runFile(file, { args } = {}) {
    const abs = path.resolve(file);
    const src = fs.readFileSync(abs, 'utf8');
    const program = parse(src, { src, file: abs });
    const env = new Env(this.globalEnv);
    this.currentFile = abs;
    const mod = { path: abs, env, exports: {}, namespace: {}, program };
    this.moduleCache.set(abs, mod);
    let value;
    try {
      value = await runAsync(this.execStatements(program.body, env, { hoist: true }));
    } catch (e) {
      if (e instanceof core.Early) throw new TelRuntimeError(`unhandled ${core.repr(e.value)} propagated by ?`, null);
      throw e;
    }
    const main = Object.prototype.hasOwnProperty.call(env.vars, 'main')
      ? { found: true, value: env.vars.main }
      : { found: false };
    let mainResult = value;
    if (main.found && typeof main.value === 'function') {
      const a = (args || []).map((x) => x);
      mainResult = await main.value(a);
    }
    return { program, env, value, mainResult };
  }
}

// --- shared pattern/type helpers -------------------------------------------
export function patternDesc(p) {
  switch (p.type) {
    case 'PWild': return ['_'];
    case 'PBind': return ['bind', p.name];
    case 'PLit': return ['lit', p.value];
    case 'PTuple': return ['tup', p.items.map(patternDesc)];
    case 'PArray': return ['arr', p.items.map(patternDesc), p.rest || null];
    case 'PRecord': {
      const fields = {};
      for (const [k, v] of Object.entries(p.fields)) fields[k] = patternDesc(v);
      return ['rec', fields, p.rest || null];
    }
    case 'PVariant': return ['tag', p.name, p.args.map(patternDesc)];
    case 'POr': return ['or', p.options.map(patternDesc)];
    default: throw new TelRuntimeError(`interpreter: cannot compile pattern ${p.type}`, p);
  }
}

function exprToPattern(e) {
  if (e.type === 'Tuple') return { type: 'PTuple', items: e.items.map(exprToPattern) };
  if (e.type === 'Array') return { type: 'PArray', items: e.items.map(exprToPattern), rest: null };
  if (e.type === 'Record') {
    const fields = {};
    for (const f of e.fields) fields[f.key] = exprToPattern(f.value);
    return { type: 'PRecord', fields, rest: null };
  }
  if (e.type === 'Ident') return { type: 'PBind', name: e.name };
  if (e.type === 'Placeholder') return { type: 'PWild' };
  return { type: 'PLit', value: undefined };
}

export function typeNameOf(t) {
  switch (t.type) {
    case 'TypeName': return t.name;
    case 'TypeOpt': return `${typeNameOf(t.of)}?`;
    case 'TypeList': return 'List';
    case 'TypeTuple': return 'Tuple';
    case 'TypeMap': return 'Record';
    case 'TypeRecord': return 'Record';
    case 'TypeUnion': return 'Any';
    case 'TypeFn': return 'Fn';
    default: return 'Any';
  }
}

function applyCompound(op, cur, rhs) {
  switch (op) {
    case '+=': return (typeof cur === 'string' || typeof rhs === 'string') ? core.str(cur) + core.str(rhs) : cur + rhs;
    case '-=': return cur - rhs;
    case '*=': return cur * rhs;
    case '/=': return cur / rhs;
    case '%=': return cur % rhs;
    case '**=': return cur ** rhs;
    case '??=': return core.d(cur, rhs);
    default: return rhs;
  }
}

function exprName(e) {
  if (!e) return '?';
  if (e.type === 'Ident') return e.name;
  if (e.type === 'Member') return `${exprName(e.obj)}.${e.name}`;
  return e.type;
}
