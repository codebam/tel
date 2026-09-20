// Tel -> JavaScript compiler.
//
// One language, one code generator, multiple emit modes:
//   target 'js'  -> standalone ESM for Node (fs/http/env/time in __.std)
//   target 'web' -> standalone ESM for browsers (DOM tag DSL, signals, mount)
//
// Output files are self-contained: the shared runtime is inlined (with
// `export ` prefixes stripped). UFCS method registrations live on a globalThis
// registry so methods defined in one compiled module are callable from another.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../runtime/tel_rt.mjs';
import { makeWebExtra } from '../runtime/web_factory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(HERE, '..', 'runtime');

function readRuntime(name) { return fs.readFileSync(path.join(RUNTIME_DIR, name), 'utf8'); }

function stripExports(src) {
  const names = [];
  const re = /^export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  let m;
  while ((m = re.exec(src)) !== null) names.push(m[1]);
  const code = src.replace(/^export\s+/gm, '');
  return { code, names };
}

const PRELUDE_CACHE = new Map();
function buildPrelude(target) {
  if (PRELUDE_CACHE.has(target)) return PRELUDE_CACHE.get(target);
  const coreSrc = stripExports(readRuntime('tel_rt.mjs'));
  const extraFile = target === 'web' ? 'web_factory.mjs' : 'node_factory.mjs';
  const extraSrc = stripExports(readRuntime(extraFile));
  const coreNames = Object.keys(core).filter((k) => k !== 'default');
  const extraNames = [...new Set(extraSrc.names)];
  const body = [];
  body.push(coreSrc.code);
  body.push(extraSrc.code);
  body.push(`const __core = { ${coreNames.join(', ')} };`);
  let imports = '';
  if (target === 'web') {
    body.push(`const __all = Object.assign(__core, makeWebExtra(__core));`);
    body.push(`__all.std = { json: __all.json, math: __all.math, time: { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, Number(ms) || 0)), iso: () => new Date().toISOString() }, env: { get: (_n, d = null) => d, args: [] } };`);
    body.push(`__all.args = [];`);
  } else {
    imports = 'import * as __fs from "node:fs";\nimport * as __http from "node:http";\nimport * as __path from "node:path";\nimport * as __process from "node:process";\n';
    body.push(`const __all = Object.assign(__core, makeNodeExtra(__core, __fs, __http, __path, __process));`);
    body.push(`__all.std = { json: __all.json, math: __all.math, fs: __all.fs, http: __all.http, env: __all.env, time: __all.time };`);
    body.push(`__all.args = __process.argv.slice(2);`);
  }
  body.push(`return __all;`);
  const code = `${imports}const __ = (() => {\n${body.join('\n')}\n})();\n`;
  const propNames = target === 'web'
    ? Object.keys(makeWebExtra(core))
    : ['fs', 'http', 'env', 'time', 'res', 'exit'];
  const builtinNames = new Set([...coreNames, ...extraNames, ...propNames, 'std', 'args']);
  const built = { code, header: imports, builtinNames, names: [...coreNames, ...extraNames] };
  PRELUDE_CACHE.set(target, built);
  return built;
}

// --- AST helpers -------------------------------------------------------------
function litCode(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function jsKey(k) { return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k); }

function patLit(p) {
  switch (p.type) {
    case 'PWild': return "['_']";
    case 'PBind': return `['bind', ${JSON.stringify(p.name)}]`;
    case 'PLit': return `['lit', ${litCode(p.value)}]`;
    case 'PTuple': return `['tup', [${p.items.map(patLit).join(', ')}]]`;
    case 'PArray': return `['arr', [${p.items.map(patLit).join(', ')}], ${p.rest ? JSON.stringify(p.rest) : 'null'}]`;
    case 'PRecord': {
      const fields = Object.entries(p.fields).map(([k, v]) => `${jsKey(k)}: ${patLit(v)}`).join(', ');
      return `['rec', {${fields}}, ${p.rest ? JSON.stringify(p.rest) : 'null'}]`;
    }
    case 'PVariant': return `['tag', ${JSON.stringify(p.name)}, [${p.args.map(patLit).join(', ')}]]`;
    case 'POr': return `['or', [${p.options.map(patLit).join(', ')}]]`;
    default: throw new Error(`codegen: unsupported pattern ${p.type}`);
  }
}

function patNames(p, out = []) {
  switch (p.type) {
    case 'PBind': out.push(p.name); break;
    case 'PTuple': p.items.forEach((x) => patNames(x, out)); break;
    case 'PArray': p.items.forEach((x) => patNames(x, out)); if (p.rest) out.push(p.rest); break;
    case 'PRecord':
      Object.values(p.fields).forEach((x) => patNames(x, out));
      if (p.rest) out.push(p.rest);
      break;
    case 'PVariant': p.args.forEach((x) => patNames(x, out)); break;
    case 'POr': if (p.options[0]) patNames(p.options[0], out); break;
    default: break;
  }
  return [...new Set(out)];
}

function isIrrefutable(p) { return p.type === 'PWild' || p.type === 'PBind'; }

function collectPatternNames(stmt, out) { patNames(stmt.pattern, out); return out; }

function hasAwait(node) {
  let found = false;
  (function walk(n) {
    if (found || n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    if (n.type === 'Await') { found = true; return; }
    if (n.type === 'Lambda' || n.type === 'FnDecl') return;
    for (const v of Object.values(n)) walk(v);
  })(node);
  return found;
}

function collectNamesInStatements(stmts, opts, acc) {
  // opts: { skipLambdaFn:true, exclude:Set, collectFns }
  for (const st of stmts) {
    if (!st) continue;
    if (st.type === 'FnDecl') {
      const jsName = st.recvType ? `${st.recvType}$${st.name}` : st.name;
      if (opts.collectFns !== false) acc.push([jsName, jsName]);
      continue;
    }
    if (st.type === 'TypeDecl') {
      if (st.kind === 'record') acc.push([st.name, st.name]);
      if (st.kind === 'union') for (const v of st.variants) acc.push([v.name, st.variants.length === 1 || v.fields.length > 0 ? v.name : v.name]);
      continue;
    }
    if (st.type === 'Import') continue;
    if (st.type === 'Let' && st.pattern) {
      for (const n of patNames(st.pattern)) {
        if (opts.exclude && opts.exclude.has(n)) continue;
        if (st.ann || st.pattern.type !== 'PBind' || !opts.outerBound.has(n)) acc.push([n, n]);
      }
      // initialisers may contain lambdas whose bodies are separate scopes: skip
      continue;
    }
    if (st.type === 'Assign' && st.target) {
      collectNamesInExpr(st.target, acc, opts);
      collectNamesInExpr(st.value, acc, opts);
      continue;
    }
    if (st.type === 'ExprStmt' || st.type === 'Return' || st.type === 'Throw' || st.type === 'Defer') {
      collectNamesInExpr(st.expr ?? st.value, acc, opts);
      continue;
    }
    if (st.type === 'If') {
      collectNamesInStatements(st.then ? st.then.body : [], opts, acc);
      for (const el of st.elifs || []) collectNamesInStatements(el.body.body, opts, acc);
      if (st.else) collectNamesInStatements(st.else.body, opts, acc);
      continue;
    }
    if (st.type === 'While') { collectNamesInStatements(st.body.body, opts, acc); continue; }
    if (st.type === 'Loop') { collectNamesInStatements(st.body.body, opts, acc); continue; }
    if (st.type === 'For') { collectNamesInStatements(st.body.body, opts, acc); continue; }
    if (st.type === 'Match') {
      for (const arm of st.arms) {
        const names = new Set(opts.exclude || []);
        patNames(arm.pattern, []).forEach((n) => names.add(n));
        const sub = { ...opts, exclude: names };
        collectNamesInStatements(arm.body.body, sub, acc);
      }
      continue;
    }
    if (st.type === 'Try') {
      collectNamesInStatements(st.body.body, opts, acc);
      for (const c of st.catches) {
        const names = new Set(opts.exclude || []);
        patNames(c.pattern, []).forEach((n) => names.add(n));
        collectNamesInStatements(c.body.body, { ...opts, exclude: names }, acc);
      }
      if (st.fin) collectNamesInStatements(st.fin.body, opts, acc);
      continue;
    }
  }
}

function collectNamesInExpr(e, acc, opts) {
  if (!e || typeof e !== 'object') return;
  if (Array.isArray(e)) { for (const x of e) collectNamesInExpr(x, acc, opts); return; }
  if (e.type === 'Lambda' || e.type === 'FnDecl') return;
  for (const v of Object.values(e)) collectNamesInExpr(v, acc, opts);
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------
function collectLocals(stmts, outerBound, exclude = new Set()) {
  const out = [];
  const seen = new Set(exclude);
  const add = (n) => { if (!seen.has(n)) { seen.add(n); out.push(n); } };
  const walk = (list) => {
    for (const st of list || []) {
      if (!st) continue;
      if (st.type === 'FnDecl') continue; // function declarations hoist themselves
      if (st.type === 'TypeDecl' || st.type === 'Import' || st.type === 'Defer') continue;
      if (st.type === 'Let' && st.pattern) {
        for (const n of patNames(st.pattern)) {
          if (st.ann || st.pattern.type !== 'PBind' || !outerBound.has(n)) add(n);
        }
        continue;
      }
      if (st.type === 'ExprStmt' || st.type === 'Assign' || st.type === 'Return' || st.type === 'Throw') continue;
      if (st.type === 'If') {
        walk(st.then ? st.then.body : []);
        for (const el of st.elifs || []) walk(el.body.body);
        if (st.else) walk(st.else.body);
        continue;
      }
      if (st.type === 'While' || st.type === 'Loop' || st.type === 'For') { walk(st.body.body); continue; }
      if (st.type === 'Match') { for (const arm of st.arms) walk(arm.body.body); continue; }
      if (st.type === 'Try') {
        walk(st.body.body);
        for (const c of st.catches) walk(c.body.body);
        if (st.fin) walk(st.fin.body);
      }
    }
  };
  walk(stmts);
  return out;
}

class Emitter {
  constructor(program, opts) {
    this.program = program;
    this.opts = opts || {};
    this.target = this.opts.target || 'js';
    this.platformTarget = this.target === 'ts' ? (this.opts.platform === 'web' ? 'web' : 'js') : this.target;
    this.entry = this.opts.entry !== false;
    this.file = this.opts.file ? path.resolve(this.opts.file) : null;
    this.lines = [];
    this.indent = 0;
    this.scopes = [new Map()];
    this.signals = [];
    this.typeDecls = new Map();
    this.recordFields = new Map();
    this.variantNames = new Set();
    this.moduleFns = new Map();
    this.moduleVars = [];
    this.jsImports = new Set();
    this.analyze();
  }

  // --- output helpers ------------------------------------------------------
  w(s = '') { this.lines.push('  '.repeat(this.indent) + s); }
  capture(fn) {
    const savedLines = this.lines, savedIndent = this.indent;
    this.lines = []; this.indent = 0;
    fn();
    const s = this.lines.join('\n');
    this.lines = savedLines; this.indent = savedIndent;
    return s;
  }
  push(map) { this.scopes.push(map); }
  pop() { this.scopes.pop(); }
  top() { return this.scopes[this.scopes.length - 1]; }
  lookup(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const m = this.scopes[i];
      if (m.has(name)) return m.get(name);
    }
    for (let i = this.signals.length - 1; i >= 0; i--) {
      const sig = this.signals[i];
      if (sig.map.has(name)) return { ref: `${sig.map.get(name)}()`, js: false };
    }
    if (buildPrelude(this.platformTarget).builtinNames.has(name)) return { ref: `__.${name}`, js: false };
    return { ref: name, js: false };
  }
  ref(name) { return this.lookup(name).ref; }
  isJsExpr(e) {
    if (!e || typeof e !== 'object') return false;
    switch (e.type) {
      case 'Ident': return !!this.lookup(e.name).js;
      case 'New': return true;
      case 'Await': return this.isJsExpr(e.e);
      case 'Member': return this.isJsExpr(e.obj);
      case 'Call':
        return e.callee.type === 'Member' ? this.isJsExpr(e.callee.obj) : this.isJsExpr(e.callee);
      case 'Propagate': return this.isJsExpr(e.e);
      default: return false;
    }
  }
  jsFnName(decl) { return decl.recvType ? `${decl.recvType}$${decl.name}` : decl.name; }

  // --- analysis ------------------------------------------------------------
  analyze() {
    const body = this.program.body;
    for (const st of body) {
      if (st.type === 'TypeDecl') {
        this.typeDecls.set(st.name, st);
        if (st.kind === 'record') this.recordFields.set(st.name, st.fields.map((f) => f.name));
        if (st.kind === 'union') for (const v of st.variants) this.variantNames.add(v.name);
      }
    }
    const moduleMap = this.scopes[0];
    for (const st of body) {
      if (st.type === 'FnDecl') {
        const jn = this.jsFnName(st);
        this.moduleFns.set(jn, st);
        moduleMap.set(st.name, { ref: st.recvType ? jn : st.name, js: false });
      }
    }
    // imports are bound in emitImports; reserve their aliases now
    for (const st of body) {
      if (st.type !== 'Import') continue;
      if (st.alias) moduleMap.set(st.alias, { ref: st.alias, js: st.kind !== 'tel' });
      if (st.names) for (const n of st.names) moduleMap.set(n, { ref: n, js: st.kind !== 'tel' });
    }
    const base = new Set(moduleMap.keys());
    this.moduleVars = collectLocals(body.filter((s) => s.type !== 'FnDecl' && s.type !== 'TypeDecl' && s.type !== 'Import'), base);
    for (const n of this.moduleVars) moduleMap.set(n, { ref: n, js: false });
  }

  // --- program -------------------------------------------------------------
  emit() {
    const prelude = buildPrelude(this.platformTarget);
    if (this.target === 'ts') {
      this.w(`import { __ } from ${JSON.stringify(this.opts.runtimeModule || './tel_runtime.ts')};`);
      this.emitImports();
      this.emitTypeDecls();
      this.emitFns();
      this.emitRegistrations();
      this.emitModuleVars();
      this.emitProgramStatements();
      this.emitExports();
      if (this.entry) this.emitBootstrap();
    } else {
      this.lines.push(prelude.code.trimEnd());
      this.emitImports();
      for (const st of this.program.body) if (st.type === 'TypeDecl') this.emitTypeDecl(st, false);
      this.emitFns();
      this.emitRegistrations();
      this.emitModuleVars();
      this.emitProgramStatements();
      this.emitExports();
      if (this.entry) this.emitBootstrap();
    }
    return this.lines.join('\n') + '\n';
  }

  emitImports() {
    for (const st of this.program.body) {
      if (st.type !== 'Import') continue;
      if (st.kind === 'std') {
        if (st.path === 'std') {
          if (st.names) for (const n of st.names) this.w(`const ${n} = __.std[${JSON.stringify(n)}];`);
          if (st.alias) this.w(`const ${st.alias} = __.std;`);
        } else {
          const segs = st.path.split('.').slice(1);
          const expr = segs.reduce((a, s) => `${a}[${JSON.stringify(s)}]`, '__.std');
          if (st.names) for (const n of st.names) this.w(`const ${n} = ${expr} && ${expr}[${JSON.stringify(n)}];`);
          if (st.alias) this.w(`const ${st.alias} = ${expr};`);
        }
        continue;
      }
      if (st.kind === 'js') {
        const spec = JSON.stringify(st.spec);
        if (st.ns) this.w(`import * as ${st.alias} from ${spec};`);
        else if (st.alias) {
          // interop contract: default export if present, else the namespace.
          // `as any` keeps generated TS accepted regardless of module shape.
          const nsVar = `${st.alias}$ns`;
          const defVar = `${st.alias}$def`;
          this.w(`import * as ${nsVar} from ${spec};`);
          if (this.target === 'ts') {
            this.w(`const ${defVar} = ((${nsVar} as any).default ?? ${nsVar}) as any;`);
          } else {
            this.w(`const ${defVar} = ${nsVar}.default ?? ${nsVar};`);
          }
          // hydrate the default with named exports so `<alias>.name` works for
          // both CJS-style defaults and ESM modules with default + named exports
          this.w(`if (${defVar} && (typeof ${defVar} === "object" || typeof ${defVar} === "function")) {`);
          this.indent++;
          this.w(`for (const $k of Object.keys(${nsVar})) { if ($k !== "default" && !($k in ${defVar})) { try { ${defVar}[$k] = ${nsVar}[$k]; } catch {} } }`);
          this.indent--;
          this.w(`}`);
          this.w(`const ${st.alias} = ${this.target === 'ts' ? `${defVar} as any` : defVar};`);
        }
        if (st.names) this.w(`import { ${st.names.join(', ')} } from ${spec};`);
        continue;
      }
      // tel module: rewrite .tel to the emitted extension
      let spec = st.file;
      if (this.file) {
        const abs = path.resolve(path.dirname(this.file), st.file);
        spec = this.opts.importSpecifier ? this.opts.importSpecifier(abs) : `./${path.basename(abs).replace(/\.tel$/, '.mjs')}`;
      }
      const q = JSON.stringify(spec);
      if (st.alias) this.w(`import * as ${st.alias} from ${q};`);
      if (st.names) this.w(`import { ${st.names.join(', ')} } from ${q};`);
    }
  }

  emitFns() {
    for (const st of this.program.body) if (st.type === 'FnDecl') this.emitFn(st);
  }

  emitRegistrations() {
    for (const st of this.program.body) {
      if (st.type !== 'FnDecl') continue;
      const jn = this.jsFnName(st);
      if (st.recvType) {
        this.w(`__.reg(${JSON.stringify(`${st.recvType}.${st.name}`)}, ${jn});`);
        const hasPlain = [...this.moduleFns.values()].some((d) => !d.recvType && d.name === st.name);
        if (!hasPlain) this.w(`__.reg(${JSON.stringify(st.name)}, ${jn});`);
      } else {
        this.w(`__.reg(${JSON.stringify(st.name)}, ${st.name});`);
      }
    }
  }

  emitModuleVars() {
    if (this.moduleVars.length) this.w(`let ${this.moduleVars.join(', ')};`);
  }

  emitProgramStatements() {
    for (const st of this.program.body) {
      if (st.type === 'FnDecl' || st.type === 'TypeDecl' || st.type === 'Import') continue;
      this.emitStmt(st);
    }
  }

  emitExports() {
    const names = new Set();
    for (const st of this.program.body) {
      if (st.type === 'FnDecl' && !st.recvType) names.add(st.name);
      if (st.type === 'TypeDecl') {
        if (st.kind === 'record') names.add(st.name);
        if (st.kind === 'union') for (const v of st.variants) names.add(v.name);
        // alias and union type names exist only in TypeScript; exported via `export type`
      }
    }
    for (const n of this.moduleVars) names.add(n);
    const list = [...names].filter((n) => n !== '__');
    this.w(`export { ${list.length ? list.join(', ') + ', ' : ''}__ as __tel };`);
  }

  emitBootstrap() {
    const isWeb = this.platformTarget === 'web';
    if (isWeb) {
      this.w(`if (typeof document !== "undefined") {`);
      this.indent++;
      this.w(`if (typeof main === "function") { Promise.resolve(main()).catch((e) => console.error(e && e.stack ? e.stack : String(e))); }`);
      this.w(`else if (typeof App === "function") { __.mount(App, "#app"); }`);
      this.indent--;
      this.w(`}`);
      return;
    }
    this.w(`if (typeof main === "function") {`);
    this.indent++;
    this.w(`const $r = main(__.args);`);
    this.w(`if ($r && typeof $r.then === "function") {`);
    this.indent++;
    this.w(`$r.then((v) => { if (v !== null && v !== undefined && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) console.log(__.str(v)); })`);
    this.indent++;
    this.w(`.catch((e) => { console.error(e && e.stack ? e.stack : String(e)); if (typeof process !== "undefined") process.exitCode = 1; });`);
    this.indent--;
    this.indent--;
    this.w(`} else if ($r !== null && $r !== undefined && (typeof $r === "string" || typeof $r === "number" || typeof $r === "boolean")) console.log(__.str($r));`);
    this.indent--;
    this.w(`}`);
  }

  // --- statements ----------------------------------------------------------
  emitBlockBody(stmts, opts = {}) {
    const { tail = false, skipDecls = false } = opts;
    const defers = stmts.filter((s) => s.type === 'Defer');
    if (defers.length) {
      this.w('try {');
      this.indent++;
      this.emitBlockBody(stmts.filter((s) => s.type !== 'Defer'), opts);
      this.indent--;
      this.w('} finally {');
      this.indent++;
      for (const d of [...defers].reverse()) this.w(`${this.expr(d.value)};`);
      this.indent--;
      this.w('}');
      return;
    }
    const list = stmts.filter((s) => !(skipDecls && (s.type === 'FnDecl' || s.type === 'TypeDecl' || s.type === 'Import')));
    if (!list.length) { if (tail) this.w('return null;'); return; }
    for (let i = 0; i < list.length; i++) {
      const last = i === list.length - 1;
      if (last && tail) this.emitTail(list[i]);
      else this.emitStmt(list[i]);
    }
  }

  emitStmt(st) {
    switch (st.type) {
      case 'Let': return this.emitLet(st);
      case 'Assign': return this.emitAssign(st);
      case 'ExprStmt':
        if (st.expr.type === 'If') return this.emitIf(st.expr, false);
        if (st.expr.type === 'Match') return this.emitMatch(st.expr, false);
        this.w(`${this.expr(st.expr)};`);
        return;
      case 'If': return this.emitIf(st, false);
      case 'For': return this.emitFor(st);
      case 'While': return this.emitWhile(st);
      case 'Loop': return this.emitLoop(st);
      case 'Match': return this.emitMatch(st, false);
      case 'Try': return this.emitTry(st, false);
      case 'Return': this.w(`return ${st.value ? this.expr(st.value) : 'null'};`); return;
      case 'Throw': this.w(`throw ${this.expr(st.value)};`); return;
      case 'Break': this.w('break;'); return;
      case 'Continue': this.w('continue;'); return;
      case 'FnDecl': return this.emitFn(st);
      case 'TypeDecl': return this.emitTypeDecl(st);
      case 'Import': return;
      case 'Defer': return;
      default: throw new Error(`codegen: unsupported statement ${st.type}`);
    }
  }

  emitTail(st) {
    switch (st.type) {
      case 'ExprStmt':
        if (st.expr.type === 'If') return this.emitIf(st.expr, true);
        if (st.expr.type === 'Match') return this.emitMatch(st.expr, true);
        this.w(`return ${this.expr(st.expr)};`);
        return;
      case 'If': return this.emitIf(st, true);
      case 'Match': return this.emitMatch(st, true);
      case 'Try': this.emitTry(st, true); this.w('return null;'); return;
      case 'Return': case 'Throw': case 'Break': case 'Continue': return this.emitStmt(st);
      case 'Let': case 'Assign': this.emitStmt(st); this.w('return null;'); return;
      case 'For': case 'While': case 'Loop': this.emitStmt(st); this.w('return null;'); return;
      case 'FnDecl': this.emitStmt(st); this.w('return null;'); return;
      case 'TypeDecl': this.emitStmt(st); this.w('return null;'); return;
      case 'Import': case 'Defer': return;
      default: throw new Error(`codegen: unsupported tail ${st.type}`);
    }
  }

  emitLet(st) {
    const name = st.pattern.type === 'PBind' ? st.pattern.name : null;
    if (name) {
      const sig = this.findSignal(name);
      if (sig) {
        if (!sig.state.declared.has(name)) { sig.state.declared.add(name); return; }
        this.w(`${sig.ref}(${st.value ? this.expr(st.value) : 'null'});`);
        return;
      }
      const info = this.lookup(name);
      this.w(`${info.ref} = ${st.value ? this.expr(st.value) : 'null'};`);
      return;
    }
    const names = patNames(st.pattern);
    this.w('{');
    this.indent++;
    this.w(`const $b = __.matchPat(${st.value ? this.expr(st.value) : 'null'}, ${patLit(st.pattern)});`);
    this.w(`if ($b === null) throw new Error("let pattern mismatch");`);
    if (names.length) this.w(`let { ${names.join(', ')} } = $b;`);
    this.indent--;
    this.w('}');
  }

  findSignal(name) {
    for (let i = this.signals.length - 1; i >= 0; i--) {
      const state = this.signals[i];
      if (state.map.has(name)) return { ref: state.map.get(name), state };
    }
    return null;
  }

  emitAssign(st) {
    // signal assignment
    if (st.target.type === 'Ident') {
      const sig = this.findSignal(st.target.name);
      if (sig) {
        const cur = `${sig.ref}()`;
        const val = this.expr(st.value);
        if (st.op === '=') this.w(`${sig.ref}(${val});`);
        else if (st.op === '??=') this.w(`${sig.ref}(__.coalesce(${cur}, () => ${val}));`);
        else if (st.op === '+=') this.w(`${sig.ref}(__.add(${cur}, ${val}));`);
        else this.w(`${sig.ref}(${cur} ${st.op.slice(0, -1)} ${val});`);
        return;
      }
    }
    if (st.target.type === 'Tuple' || st.target.type === 'Array' || st.target.type === 'Record') {
      const names = patNames(exprToPatternCodegen(st.target));
      this.w('{');
      this.indent++;
      this.w(`const $b = __.matchPat(${this.expr(st.value)}, ${patLit(exprToPatternCodegen(st.target))});`);
      this.w(`if ($b === null) throw new Error("assign pattern mismatch");`);
      for (const n of names) this.w(`${this.ref(n)} = $b[${JSON.stringify(n)}];`);
      this.indent--;
      this.w('}');
      return;
    }
    const target = this.expr(st.target);
    if (st.op === '=') this.w(`${target} = ${this.expr(st.value)};`);
    else if (st.op === '??=') this.w(`${target} = __.coalesce(${target}, () => ${this.expr(st.value)});`);
    else this.w(`${target} ${st.op} ${this.expr(st.value)};`);
  }

  emitIf(st, tail) {
    this.w(`if (${this.expr(st.cond)}) {`);
    this.indent++; this.emitBlockBody(st.then.body, { tail }); this.indent--;
    this.w('}');
    for (const el of st.elifs || []) {
      this.w(`else if (${this.expr(el.cond)}) {`);
      this.indent++; this.emitBlockBody(el.body.body, { tail }); this.indent--;
      this.w('}');
    }
    if (st.else) {
      this.w('else {');
      this.indent++; this.emitBlockBody(st.else.body, { tail }); this.indent--;
      this.w('}');
    } else if (tail) {
      this.w('return null;');
    }
  }

  emitMatch(st, tail) {
    this.w('{');
    this.indent++;
    this.w(`const $m = ${this.expr(st.subj)};`);
    let defaulted = false;
    for (const arm of st.arms) {
      if (isIrrefutable(arm.pattern) && !arm.guard) {
        if (arm.pattern.type === 'PBind') {
          this.w('{');
          this.indent++;
          this.w(`const ${arm.pattern.name} = $m;`);
          const map = new Map([[arm.pattern.name, { ref: arm.pattern.name, js: false }]]);
          this.push(map);
          this.emitBlockBody(arm.body.body, { tail });
          this.pop();
          this.indent--;
          this.w('}');
        } else {
          this.emitBlockBody(arm.body.body, { tail });
        }
        defaulted = true;
        break;
      }
      if (arm.pattern.type === 'PBind') {
        this.w('{');
        this.indent++;
        const bind = arm.pattern.name;
        this.w(`const ${bind} = $m;`);
        this.push(new Map([[bind, { ref: bind, js: false }]]));
        this.w(`if (${this.expr(arm.guard)}) {`);
        this.indent++;
        this.emitBlockBody(arm.body.body, { tail });
        this.indent--;
        this.w('}');
        this.pop();
        this.indent--;
        this.w('}');
        continue;
      }
      if (arm.pattern.type === 'PWild') {
        this.w(`if (${this.expr(arm.guard)}) {`);
        this.indent++; this.emitBlockBody(arm.body.body, { tail }); this.indent--;
        this.w('}');
        continue;
      }
      const names = patNames(arm.pattern);
      this.w('{');
      this.indent++;
      this.w(`const $b = __.matchPat($m, ${patLit(arm.pattern)});`);
      this.w('if ($b !== null) {');
      this.indent++;
      if (names.length) this.w(`let { ${names.join(', ')} } = $b;`);
      const map = new Map(names.map((n) => [n, { ref: n, js: false }]));
      this.push(map);
      if (arm.guard) {
        this.w(`if (${this.expr(arm.guard)}) {`);
        this.indent++;
        this.emitBlockBody(arm.body.body, { tail });
        this.indent--;
        this.w('}');
      } else {
        this.emitBlockBody(arm.body.body, { tail });
      }
      this.pop();
      this.indent--;
      this.w('}');
      this.indent--;
      this.w('}');
    }
    if (!defaulted) this.w(`throw __.noMatch($m);`);
    this.indent--;
    this.w('}');
  }

  emitFor(st) {
    const iter = this.expr(st.iter);
    if (st.pattern.type === 'PBind') {
      const name = st.pattern.name;
      this.w(`for (const ${name} of __.iter(${iter})) {`);
      this.push(new Map([[name, { ref: name, js: false }]]));
      this.indent++; this.emitBlockBody(st.body.body); this.indent--;
      this.pop();
      this.w('}');
      return;
    }
    this.w(`for (const $it of __.iter(${iter})) {`);
    this.indent++;
    if (st.pattern.type === 'PWild') {
      this.emitBlockBody(st.body.body);
    } else {
      const names = patNames(st.pattern);
      this.w(`const $b = __.matchPat($it, ${patLit(st.pattern)});`);
      this.w(`if ($b === null) throw new Error("for pattern mismatch");`);
      if (names.length) this.w(`let { ${names.join(', ')} } = $b;`);
      this.push(new Map(names.map((n) => [n, { ref: n, js: false }])));
      this.emitBlockBody(st.body.body);
      this.pop();
    }
    this.indent--;
    this.w('}');
  }

  emitWhile(st) {
    this.w(`while (${this.expr(st.cond)}) {`);
    this.indent++; this.emitBlockBody(st.body.body); this.indent--;
    this.w('}');
  }

  emitLoop(st) {
    this.w('for (;;) {');
    this.indent++; this.emitBlockBody(st.body.body); this.indent--;
    this.w('}');
  }

  emitTry(st, tail) {
    const innerTail = tail;
    this.w('try {');
    this.indent++; this.emitBlockBody(st.body.body, { tail: innerTail }); this.indent--;
    this.w('}');
    const catches = st.catches || [];
    if (catches.length) {
      this.w(`catch ($e) {`);
      this.indent++;
      this.w('if ($e instanceof __.Early) throw $e;');
      for (const c of catches) {
        if (c.pattern.type === 'PBind') {
          this.w('{');
          this.indent++;
          this.w(`const ${c.pattern.name} = $e;`);
          this.push(new Map([[c.pattern.name, { ref: c.pattern.name, js: false }]]));
          this.emitBlockBody(c.body.body, { tail: innerTail });
          this.pop();
          this.indent--;
          this.w('}');
        } else if (c.pattern.type === 'PWild') {
          this.emitBlockBody(c.body.body, { tail: innerTail });
        } else {
          const names = patNames(c.pattern);
          this.w('{');
          this.indent++;
          this.w(`const $b = __.matchPat($e, ${patLit(c.pattern)});`);
          this.w('if ($b !== null) {');
          this.indent++;
          if (names.length) this.w(`let { ${names.join(', ')} } = $b;`);
          this.push(new Map(names.map((n) => [n, { ref: n, js: false }])));
          this.emitBlockBody(c.body.body, { tail: innerTail });
          this.pop();
          this.indent--;
          this.w('}');
          this.indent--;
          this.w('}');
        }
      }
      if (!catches.some((c) => c.pattern.type === 'PBind' || c.pattern.type === 'PWild')) this.w('throw $e;');
      this.indent--;
      this.w('}');
    }
    if (st.fin) {
      this.w('finally {');
      this.indent++; this.emitBlockBody(st.fin.body); this.indent--;
      this.w('}');
    }
  }

  // --- type declarations / TS types ---------------------------------------
  tsType(t) {
    if (!t) return 'any';
    switch (t.type) {
      case 'TypeName': {
        const map = { Num: 'number', Int: 'number', Str: 'string', Bool: 'boolean', Nil: 'null', Any: 'any', Void: 'void', Never: 'never' };
        if (map[t.name]) return map[t.name];
        return t.name + (t.args && t.args.length ? `<${t.args.map((x) => this.tsType(x)).join(', ')}>` : '');
      }
      case 'TypeList': return `${this.tsWrap(t.of)}[]`;
      case 'TypeOpt': return `${this.tsType(t.of)} | null`;
      case 'TypeUnion': return t.options.map((x) => this.tsType(x)).join(' | ');
      case 'TypeRecord': return `{ ${t.fields.map((f) => `${jsKey(f.name)}${f.ann ? ': ' + this.tsType(f.ann) : ': any'}`).join('; ')} }`;
      case 'TypeTuple': return `[${t.items.map((x) => this.tsType(x)).join(', ')}]`;
      case 'TypeMap': return `Record<${this.tsType(t.key)}, ${this.tsType(t.value)}>`;
      case 'TypeFn': return `(${t.params.map((x) => this.tsType(x)).join(', ')}) => ${this.tsType(t.ret)}`;
      default: return 'any';
    }
  }
  tsWrap(t) { const s = this.tsType(t); return /[|&]/.test(s) ? `(${s})` : s; }

  emitTypeDecls() {
    for (const st of this.program.body) if (st.type === 'TypeDecl') this.emitTypeDecl(st, true);
  }

  emitTypeDecl(st, exported = false) {
    const kw = exported && this.target === 'ts' ? 'export ' : '';
    const generics = st.generics && st.generics.length ? `<${st.generics.join(', ')}>` : '';
    if (this.target === 'ts') {
      if (st.kind === 'record') {
        const fields = st.fields.map((f) => `${jsKey(f.name)}: ${this.tsType(f.ann)}`).join('; ');
        this.w(`${kw}type ${st.name}${generics} = { ${fields} };`);
      } else if (st.kind === 'union') {
        const parts = st.variants.map((v) => {
          const vals = v.fields.map((f) => `${f.name}: ${this.tsType(f.ann)}`).join('; ');
          return `{ __tag: ${JSON.stringify(v.name)}; __v: [${v.fields.map((f) => this.tsType(f.ann)).join(', ')}]; __t: ${JSON.stringify(st.name)} }`;
        });
        this.w(`${kw}type ${st.name}${generics} = ${parts.join(' | ')};`);
      } else if (st.kind === 'alias') {
        this.w(`${kw}type ${st.name}${generics} = ${this.tsType(st.aliased)};`);
      }
    }
    if (st.kind === 'record') this.emitRecordCtor(st);
    else if (st.kind === 'union') this.emitVariantCtors(st);
  }

  emitRecordCtor(st) {
    const fields = st.fields.map((f) => f.name);
    if (this.target === 'ts') {
      const positional = st.fields.map((f) => `${f.name}: ${this.tsType(f.ann)}`).join(', ');
      const named = `{ ${st.fields.map((f) => `${jsKey(f.name)}?: ${this.tsType(f.ann)}`).join('; ')} }`;
      this.w(`function ${st.name}(${positional || ''}): ${st.name};`);
      this.w(`function ${st.name}(o: ${named}): ${st.name};`);
    }
    this.w(`function ${st.name}(...$args${this.target === 'ts' ? ': any[]' : ''})${this.target === 'ts' ? `: ${st.name}` : ''} {`);
    this.indent++;
    this.w(`const $a = $args[0];`);
    if (fields.length) {
      this.w(`const $named = $a !== null && typeof $a === "object" && !Array.isArray($a) && !__.isSum($a) && (${fields.map((f) => JSON.stringify(f) + ' in $a').join(' || ')});`);
      this.w(`const $out = {};`);
      fields.forEach((f, i) => this.w(`$out.${f} = $named ? ($a.${f} ?? null) : ($args[${i}] ?? null);`));
      this.w(`return __.rec(${JSON.stringify(st.name)}, $out);`);
    } else {
      this.w(`return __.rec(${JSON.stringify(st.name)}, {});`);
    }
    this.indent--;
    this.w('}');
  }

  emitVariantCtors(st) {
    for (const v of st.variants) {
      const fields = v.fields.map((f) => f.name);
      if (!fields.length) {
        const cast = this.target === 'ts' ? ` as unknown as ${st.name}` : '';
        this.w(`const ${v.name} = __.unit(${JSON.stringify(st.name)}, ${JSON.stringify(v.name)})${cast};`);
      } else {
        const cast = this.target === 'ts'
          ? ` as unknown as (${v.fields.map((f) => `${f.name}: ${this.tsType(f.ann)}`).join(', ')}) => ${st.name}`
          : '';
        this.w(`const ${v.name} = __.variant(${JSON.stringify(st.name)}, ${JSON.stringify(v.name)}, [${fields.map((f) => JSON.stringify(f)).join(', ')}])${cast};`);
      }
    }
  }

  // --- functions -----------------------------------------------------------
  emitFn(decl) {
    const jsName = this.jsFnName(decl);
    const isWeb = decl.surface === 'web' && this.scopes.length === 1;
    let signalState = null;
    if (isWeb) {
      const states = [];
      for (const st of decl.body.body) {
        if (st.type === 'Let' && st.pattern.type === 'PBind' && st.value) states.push(st);
      }
      for (const st of states) {
        const s = `${jsName}$${st.pattern.name}`;
        this.w(`const ${s} = __.sig(${st.value ? this.expr(st.value) : 'null'});`);
      }
      signalState = { map: new Map(states.map((st) => [st.pattern.name, `${jsName}$${st.pattern.name}`])), declared: new Set() };
    }
    const params = decl.params.map((p) => {
      let s = p.rest ? `...${p.name}` : p.name;
      if (this.target === 'ts' && p.ann) s += `: ${this.tsType(p.ann)}`;
      if (p.default) s += ` = ${this.expr(p.default)}`;
      return s;
    });
    const outerBound = new Set();
    for (const s of this.scopes) for (const k of s.keys()) outerBound.add(k);
    const paramNames = new Set(decl.params.map((p) => p.name));
    if (signalState) for (const n of signalState.map.keys()) paramNames.add(n);
    const locals = collectLocals(decl.body.body, outerBound, paramNames);
    const scope = new Map();
    for (const p of decl.params) scope.set(p.name, { ref: p.name, js: false });
    for (const l of locals) if (!scope.has(l)) scope.set(l, { ref: l, js: false });
    if (decl.recvType && decl.params.length) {
      const recv = decl.params[0].name;
      for (const f of this.recordFields.get(decl.recvType) || []) {
        if (!scope.has(f) && !outerBound.has(f)) scope.set(f, { ref: `${recv}.${f}`, js: false });
      }
    }
    const isAsync = !!decl.async || hasAwait(decl.body);
    const retAnno = this.target === 'ts' && decl.ret ? `: ${this.tsType(decl.ret)}` : '';
    if (signalState) this.signals.push(signalState);
    this.push(scope);
    try {
      this.w(`${isAsync ? 'async ' : ''}function ${jsName}(${params.join(', ')})${retAnno} {`);
      this.indent++;
      this.w(`return __.${isAsync ? '__pa' : '__p'}(${isAsync ? 'async ' : ''}() => {`);
      this.indent++;
      if (locals.length) this.w(`let ${locals.join(', ')};`);
      this.emitBlockBody(decl.body.body, { tail: true });
      this.indent--;
      this.w('});');
      this.indent--;
      this.w('}');
    } finally {
      this.pop();
      if (signalState) this.signals.pop();
    }
  }

  // --- expressions ---------------------------------------------------------
  expr(e) {
    switch (e.type) {
      case 'Num': return e.raw ? e.raw.replace(/_/g, '') : String(e.value);
      case 'Bool': return e.value ? 'true' : 'false';
      case 'Nil': return 'null';
      case 'Str': {
        if (e.parts.every((p) => p.k === 't')) return JSON.stringify(e.parts.map((p) => p.v).join(''));
        let out = '`';
        for (const p of e.parts) {
          if (p.k === 't') out += p.v.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
          else out += '${__.str(' + this.expr(p.e) + ')}';
        }
        return out + '`';
      }
      case 'Ident': return this.ref(e.name);
      case 'Placeholder': throw new Error('codegen: unresolved `_` placeholder');
      case 'Array': return '[' + e.items.map((it) => it.type === 'Spread' ? `...${this.expr(it.e)}` : this.expr(it)).join(', ') + ']';
      case 'Tuple': return '[' + e.items.map((it) => this.expr(it)).join(', ') + ']';
      case 'Record': return '{ ' + e.fields.map((f) => f.spread ? `...${this.expr(f.value)}` : `${jsKey(f.key)}: ${this.expr(f.value)}`).join(', ') + ' }';
      case 'Spread': return `...${this.expr(e.e)}`;
      case 'Lambda': {
        const params = e.params.map((p) => {
          let s = p.rest ? `...${p.name}` : p.name;
          if (this.target === 'ts' && p.ann) s += `: ${this.tsType(p.ann)}`;
          if (p.default) s += ` = ${this.expr(p.default)}`;
          return s;
        }).join(', ');
        const scope = new Map(e.params.map((p) => [p.name, { ref: p.name, js: false }]));
        this.push(scope);
        const isAsync = !!e.async || hasAwait(e.body);
        const body = this.capture(() => this.emitBlockBody(e.body.body, { tail: true }));
        this.pop();
        return `${isAsync ? 'async ' : ''}(${params}) => __.${isAsync ? '__pa' : '__p'}(${isAsync ? 'async ' : ''}() => {\n${body}\n})`;
      }
      case 'Call': return this.exprCall(e);
      case 'Member': return `${this.expr(e.obj)}${e.optional ? '?.' : '.'}${e.name}`;
      case 'Index': return `__.at(${this.expr(e.obj)}, ${this.expr(e.index)})`;
      case 'Slice': return `__.slice(${this.expr(e.obj)}, ${e.start ? this.expr(e.start) : 'null'}, ${e.end ? this.expr(e.end) : 'null'}, ${e.inclusive ? 'true' : 'false'})`;
      case 'Unary': {
        const v = this.expr(e.e);
        if (e.op === '!' || e.op === 'not') return `!__.truthy(${v})`;
        return `${e.op}(${v})`;
      }
      case 'Binary': {
        const l = this.expr(e.l), r = this.expr(e.r);
        switch (e.op) {
          case 'and': case '&&': return `__.and(${l}, () => ${r})`;
          case 'or': case '||': return `__.or(${l}, () => ${r})`;
          case '??': return `__.coalesce(${l}, () => ${r})`;
          case '==': return `__.eq(${l}, ${r})`;
          case '!=': return `!__.eq(${l}, ${r})`;
          case '+': return `__.add(${l}, ${r})`;
          case 'in': return `__.contains(${r}, ${l})`;
          default: return `(${l} ${e.op} ${r})`;
        }
      }
      case 'Range': return `__.range(${this.expr(e.start)}, ${this.expr(e.end)}, ${e.inclusive ? 'true' : 'false'})`;
      case 'If': return `(() => {\n${this.capture(() => this.emitIf(e, true))}\n})()`;
      case 'Match': return `(() => {\n${this.capture(() => this.emitMatch(e, true))}\n})()`;
      case 'Propagate': return `__.q(${this.expr(e.e)})`;
      case 'Await': return `(await ${this.expr(e.e)})`;
      case 'Spawn': return `__.spawn(() => ${this.expr(e.e)})`;
      case 'IsType': return `__.isType(${this.expr(e.value)}, ${JSON.stringify(typeNameStr(e.of))})`;
      case 'New': {
        const args = e.args.map((a) => a.spread ? `...${this.expr(a.value)}` : this.expr(a.value)).join(', ');
        return `new (${this.expr(e.callee)})(${args})`;
      }
      case 'Assign': {
        if (e.target.type === 'Ident') {
          const sig = this.findSignal(e.target.name);
          if (sig) {
            const cur = `${sig.ref}()`;
            const val = this.expr(e.value);
            if (e.op === '=') return `${sig.ref}(${val})`;
            if (e.op === '??=') return `${sig.ref}(__.coalesce(${cur}, () => ${val}))`;
            if (e.op === '+=') return `${sig.ref}(__.add(${cur}, ${val}))`;
            return `${sig.ref}(${cur} ${e.op.slice(0, -1)} ${val})`;
          }
          const ref = this.ref(e.target.name);
          if (e.op === '=') return `(${ref} = ${this.expr(e.value)})`;
          if (e.op === '??=') return `(${ref} = __.coalesce(${ref}, () => ${this.expr(e.value)}))`;
          return `(${ref} ${e.op} ${this.expr(e.value)})`;
        }
        if (e.target.type === 'Tuple' || e.target.type === 'Array' || e.target.type === 'Record') {
          const p = exprToPatternCodegen(e.target);
          const names = patNames(p);
          const body = this.capture(() => {
            this.w(`const $b = __.matchPat(${this.expr(e.value)}, ${patLit(p)});`);
            this.w(`if ($b === null) throw new Error("assign pattern mismatch");`);
            for (const n of names) this.w(`${this.ref(n)} = $b[${JSON.stringify(n)}];`);
            this.w('return $b;');
          });
          return `(() => {\n${body}\n})()`;
        }
        const target = this.expr(e.target);
        if (e.op === '=') return `(${target} = ${this.expr(e.value)})`;
        if (e.op === '??=') return `(${target} = __.coalesce(${target}, () => ${this.expr(e.value)}))`;
        return `(${target} ${e.op} ${this.expr(e.value)})`;
      }
      case 'ArrayComp': {
        const body = this.capture(() => { this.w('const $a = [];'); this.emitComp(e.clauses, 0, () => this.w(`$a.push(${this.expr(e.value)});`)); this.w('return $a;'); });
        return `(() => {\n${body}\n})()`;
      }
      case 'MapComp': {
        const keyExpr = typeof e.key === 'string' ? JSON.stringify(e.key) : this.expr(e.key);
        const body = this.capture(() => { this.w('const $o = {};'); this.emitComp(e.clauses, 0, () => this.w(`$o[__.str(${keyExpr})] = ${this.expr(e.value)};`)); this.w('return $o;'); });
        return `(() => {\n${body}\n})()`;
      }
      default: throw new Error(`codegen: unsupported expression ${e.type}`);
    }
  }

  emitComp(clauses, i, emitValue) {
    if (i >= clauses.length) { emitValue(); return; }
    const c = clauses[i];
    if (c.k === 'for') {
      this.w(`for (const $v${i} of __.iter(${this.expr(c.iter)})) {`);
      this.indent++;
      const names = patNames(c.pattern);
      if (c.pattern.type === 'PBind') {
        this.push(new Map([[c.pattern.name, { ref: c.pattern.name, js: false }]]));
        this.w(`const ${c.pattern.name} = $v${i};`);
      } else if (names.length) {
        this.w(`const $b${i} = __.matchPat($v${i}, ${patLit(c.pattern)});`);
        this.w(`if ($b${i} === null) throw new Error("comprehension pattern mismatch");`);
        this.w(`let { ${names.join(', ')} } = $b${i};`);
        this.push(new Map(names.map((n) => [n, { ref: n, js: false }])));
      }
      this.emitComp(clauses, i + 1, emitValue);
      if (c.pattern.type === 'PBind' || names.length) this.pop();
      this.indent--;
      this.w('}');
    } else {
      this.w(`if (${this.expr(c.cond)}) {`);
      this.indent++;
      this.emitComp(clauses, i + 1, emitValue);
      this.indent--;
      this.w('}');
    }
  }

  exprCall(e) {
    const pos = [];
    let named = null;
    for (const a of e.args) {
      if (a.name) { (named ||= {})[a.name] = this.expr(a.value); }
      else pos.push(a.spread ? `...${this.expr(a.value)}` : this.expr(a.value));
    }
    if (e.callee.type === 'Member') {
      const obj = this.expr(e.callee.obj);
      const name = e.callee.name;
      const args = named ? [`{ ${Object.entries(named).map(([k, v]) => `${jsKey(k)}: ${v}`).join(', ')} }`, ...pos] : pos;
      if (this.isJsExpr(e.callee.obj)) {
        return `${obj}${e.callee.optional ? '?.' : '.'}${name}(${args.join(', ')})`;
      }
      return `__.mcall(${obj}, ${JSON.stringify(name)}, [${args.join(', ')}])`;
    }
    let callee = this.expr(e.callee);
    if (e.callee.type === 'Lambda' || e.callee.type === 'If' || e.callee.type === 'Match') callee = `(${callee})`;
    if (named) {
      const obj = `{ ${Object.entries(named).map(([k, v]) => `${jsKey(k)}: ${v}`).join(', ')} }`;
      if (e.callee.type === 'Ident' && this.typeDecls.has(e.callee.name) && this.typeDecls.get(e.callee.name).kind !== 'alias') {
        return `${callee}(${obj})`;
      }
      return `${callee}(${[obj, ...pos].join(', ')})`;
    }
    return `${callee}(${pos.join(', ')})`;
  }
}

function exprToPatternCodegen(e) {
  if (e.type === 'Tuple') return { type: 'PTuple', items: e.items.map(exprToPatternCodegen) };
  if (e.type === 'Array') return { type: 'PArray', items: e.items.map((x) => exprToPatternCodegen(x)), rest: null };
  if (e.type === 'Record') {
    const fields = {};
    for (const f of e.fields) fields[f.key] = exprToPatternCodegen(f.value);
    return { type: 'PRecord', fields, rest: null };
  }
  if (e.type === 'Ident') return { type: 'PBind', name: e.name };
  if (e.type === 'Placeholder') return { type: 'PWild' };
  return { type: 'PWild' };
}

function typeNameStr(t) {
  if (!t) return 'Any';
  switch (t.type) {
    case 'TypeName': return t.name;
    case 'TypeList': return 'List';
    case 'TypeRecord': return 'Record';
    case 'TypeTuple': return 'Tuple';
    case 'TypeMap': return 'Record';
    case 'TypeFn': return 'Fn';
    case 'TypeUnion': return 'Any';
    case 'TypeOpt': return typeNameStr(t.of) + '?';
    default: return 'Any';
  }
}

export function compileProgram(program, opts = {}) {
  return new Emitter(program, opts).emit();
}

export function compileRuntime(opts = {}) {
  const target = opts.target || 'js';
  const platform = target === 'ts' ? (opts.platform || 'node') : target;
  const prelude = buildPrelude(platform === 'web' ? 'web' : 'js');
  if (target === 'ts') return '// @ts-nocheck\n' + prelude.code.replace(/^const __ = /m, 'export const __ = ');
  return prelude.code;
}
