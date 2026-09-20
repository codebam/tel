// src/check.mjs — lightweight static checker for Tel.
//
// This is deliberately not a type system. It walks the parsed AST and reports:
//   * undefined identifiers (scopes, imports, builtins)
//   * call arity for visible Tel functions/constructors
//   * unknown named arguments
//   * return/break/continue placement
//   * duplicate parameters and duplicate pattern bindings
//   * unknown annotation type names, and missing relative modules/exports
//
// Diagnostics are plain objects: { file, line, col, message }.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from './parser.mjs';
import { createGlobalEnv } from './interp.mjs';

const GLOBAL_ENV = createGlobalEnv();

export const BUILTIN_NAMES = new Set(Object.keys(GLOBAL_ENV.vars));

// Annotation type names that are part of the language even though they are not
// ordinary runtime values.
export const BUILTIN_TYPES = new Set([
  'Num', 'Int', 'Str', 'Bool', 'Nil', 'Any', 'Void', 'Never',
  'List', 'Map', 'Fn', 'Result', 'Error', 'Task', 'Range', 'Tuple', 'Record',
]);

class Scope {
  constructor(parent = null) {
    this.parent = parent;
    this.syms = new Map();
  }
  define(name, info) {
    if (name) this.syms.set(name, info);
    return info;
  }
  lookup(name) {
    for (let s = this; s; s = s.parent) {
      const v = s.syms.get(name);
      if (v) return v;
    }
    return null;
  }
  has(name) { return this.lookup(name) !== null; }
}

export function checkProgram(program, opts = {}) {
  const checker = new Checker(opts.file ?? null);
  checker.run(program);
  return checker.diagnostics;
}

export function checkSource(src, opts = {}) {
  const file = opts.file ?? null;
  const program = parse(src, { src, file });
  return checkProgram(program, { ...opts, file });
}

class Checker {
  constructor(file) {
    this.file = file;
    this.diagnostics = [];
  }

  run(program) {
    const root = new Scope();
    for (const n of BUILTIN_NAMES) root.define(n, { kind: 'builtin', name: n });
    for (const t of BUILTIN_TYPES) root.define(t, { kind: 'builtin-type', name: t });
    this.checkStatements(program.body, root, 0, 0);
    this.diagnostics.sort((a, b) => (a.line - b.line) || (a.col - b.col) || a.message.localeCompare(b.message));
  }

  error(message, node) {
    const line = Number.isInteger(node?.line) ? node.line : 1;
    const col = Number.isInteger(node?.col) ? node.col : 1;
    this.diagnostics.push({ file: this.file, line, col, message });
  }

  // --- scopes and declarations ---------------------------------------------
  checkStatements(stmts, scope, fnDepth, loopDepth) {
    // Hoist declarations first: imports, then functions, then types. This
    // mirrors Runtime.execStatements so forward references don't false-positive.
    for (const st of stmts) if (st.type === 'Import') this.hoistImport(st, scope);
    for (const st of stmts) if (st.type === 'FnDecl') this.defineFn(st, scope);
    for (const st of stmts) if (st.type === 'TypeDecl') this.defineTypeDecl(st, scope);
    for (const st of stmts) this.checkStatement(st, scope, fnDepth, loopDepth);
  }

  hoistImport(st, scope) {
    if (st.names && st.names.length) {
      for (const n of st.names) scope.define(n, { kind: 'import', name: n });
    } else if (st.alias) {
      scope.define(st.alias, { kind: 'import', name: st.alias });
    }
  }

  defineFn(st, scope) {
    scope.define(st.name, { kind: 'fn', name: st.name, params: st.params || [], node: st, recvType: st.recvType || null });
  }

  defineTypeDecl(st, scope) {
    if (st.kind === 'record') {
      scope.define(st.name, {
        kind: 'ctor', name: st.name, fields: st.fields.map((f) => f.name),
        isType: true, unionType: null, decl: st,
      });
      return;
    }
    scope.define(st.name, { kind: 'type', name: st.name, isType: true, decl: st });
    if (st.kind === 'union') {
      for (const v of st.variants) {
        scope.define(v.name, {
          kind: 'ctor', name: v.name, fields: v.fields.map((f) => f.name),
          isType: false, unionType: st.name, decl: st,
        });
      }
    }
  }

  // --- statements -----------------------------------------------------------
  checkStatement(st, scope, fnDepth, loopDepth) {
    switch (st.type) {
      case 'Import': return this.checkImport(st);
      case 'FnDecl': return this.checkFn(st, scope);
      case 'TypeDecl': return this.checkTypeDecl(st, scope);
      case 'Let': {
        if (st.value) this.checkExpr(st.value, scope, fnDepth, loopDepth);
        if (st.ann) this.checkType(st.ann, scope, st);
        this.bindPattern(st.pattern, scope);
        return;
      }
      case 'Assign': return this.checkAssign(st, scope, fnDepth, loopDepth);
      case 'ExprStmt': return this.checkExpr(st.expr, scope, fnDepth, loopDepth);
      case 'If': {
        this.checkExpr(st.cond, scope, fnDepth, loopDepth);
        this.checkStatements(st.then.body, scope, fnDepth, loopDepth);
        for (const el of st.elifs || []) {
          this.checkExpr(el.cond, scope, fnDepth, loopDepth);
          this.checkStatements(el.body.body, scope, fnDepth, loopDepth);
        }
        if (st.else) this.checkStatements(st.else.body, scope, fnDepth, loopDepth);
        return;
      }
      case 'While':
        this.checkExpr(st.cond, scope, fnDepth, loopDepth);
        this.checkStatements(st.body.body, scope, fnDepth, loopDepth + 1);
        return;
      case 'Loop':
        this.checkStatements(st.body.body, scope, fnDepth, loopDepth + 1);
        return;
      case 'For': {
        this.checkExpr(st.iter, scope, fnDepth, loopDepth);
        const child = new Scope(scope);
        this.bindPattern(st.pattern, child);
        this.checkStatements(st.body.body, child, fnDepth, loopDepth + 1);
        return;
      }
      case 'Match': {
        this.checkExpr(st.subj, scope, fnDepth, loopDepth);
        for (const arm of st.arms) {
          const child = new Scope(scope);
          this.bindPattern(arm.pattern, child);
          if (arm.guard) this.checkExpr(arm.guard, child, fnDepth, loopDepth);
          this.checkStatements(arm.body.body, child, fnDepth, loopDepth);
        }
        return;
      }
      case 'Try': {
        this.checkStatements(st.body.body, scope, fnDepth, loopDepth);
        for (const c of st.catches) {
          const child = new Scope(scope);
          this.bindPattern(c.pattern, child);
          this.checkStatements(c.body.body, child, fnDepth, loopDepth);
        }
        if (st.fin) this.checkStatements(st.fin.body, scope, fnDepth, loopDepth);
        return;
      }
      case 'Return':
        if (fnDepth <= 0) this.error('return outside of a function', st);
        if (st.value) this.checkExpr(st.value, scope, fnDepth, loopDepth);
        return;
      case 'Break':
        if (loopDepth <= 0) this.error('break outside of a loop', st);
        return;
      case 'Continue':
        if (loopDepth <= 0) this.error('continue outside of a loop', st);
        return;
      case 'Throw': return this.checkExpr(st.value, scope, fnDepth, loopDepth);
      case 'Defer': return this.checkExpr(st.value, scope, fnDepth, loopDepth);
      default:
        // Forward-compatible: unknown/new statement kinds are left to parse+run.
        return;
    }
  }

  checkFn(st, scope) {
    const fnScope = new Scope(scope);
    for (const g of st.generics || []) fnScope.define(g, { kind: 'generic', name: g });
    this.checkDuplicateParams(st.params || [], st);
    if (st.recvType || (st.params || []).some((p) => p.name === 'self')) {
      fnScope.define('self', { kind: 'param', name: 'self' });
    }
    for (const p of st.params || []) {
      if (p.ann) this.checkType(p.ann, fnScope, st);
      if (p.default) this.checkExpr(p.default, fnScope, 1, 0);
      fnScope.define(p.name, { kind: 'param', name: p.name });
    }
    if (st.ret) this.checkType(st.ret, fnScope, st);
    if (st.body) this.checkStatements(st.body.body, fnScope, 1, 0);
  }

  checkTypeDecl(st, scope) {
    const typeScope = new Scope(scope);
    for (const g of st.generics || []) typeScope.define(g, { kind: 'generic', name: g });
    if (st.kind === 'record') {
      for (const f of st.fields) if (f.ann) this.checkType(f.ann, typeScope, st);
    } else if (st.kind === 'union') {
      for (const v of st.variants) {
        for (const f of v.fields) if (f.ann) this.checkType(f.ann, typeScope, st);
      }
    } else if (st.kind === 'alias') {
      this.checkType(st.aliased, typeScope, st);
    }
  }

  checkDuplicateParams(params, owner) {
    const seen = new Set();
    for (const p of params) {
      if (p.name === '_' || p.name === '$0') continue;
      if (seen.has(p.name)) this.error(`duplicate parameter '${p.name}'`, owner);
      seen.add(p.name);
    }
  }

  // --- patterns -------------------------------------------------------------
  bindPattern(pat, scope) {
    const names = [];
    collectPatternNames(pat, names);
    const seen = new Map();
    for (const entry of names) {
      if (entry.name === '_' || entry.name === '$0') continue;
      const prevAlt = seen.get(entry.name);
      const sameName = seen.has(entry.name);
      // The same name bound in different `|` alternatives is normal.
      const differentAlt = sameName && prevAlt !== null && entry.alt !== null && prevAlt !== entry.alt;
      if (sameName && !differentAlt) this.error(`duplicate binding '${entry.name}' in pattern`, entry.node || pat);
      if (!sameName) seen.set(entry.name, entry.alt);
      scope.define(entry.name, { kind: 'var', name: entry.name });
    }
  }

  // --- imports --------------------------------------------------------------
  checkImport(st) {
    if (st.kind === 'std' || (st.path != null && st.file == null)) {
      const std = GLOBAL_ENV.lookup('std')?.value;
      const segs = String(st.path || '').split('.').slice(1);
      let ns = std;
      for (const s of segs) ns = ns && typeof ns === 'object' ? ns[s] : undefined;
      if (ns === undefined || ns === null) {
        this.error(`std has no namespace '${st.path}'`, st);
        return;
      }
      for (const n of st.names || []) {
        if (!(n in Object(ns))) this.error(`std has no export '${n}'`, st);
      }
      return;
    }
    const spec = st.file ?? st.spec ?? null;
    if (spec == null) return;
    const isTel = st.kind === 'tel' || String(spec).endsWith('.tel');
    if (!isTel) return; // npm/node: specifiers are deliberately not resolved here
    const base = this.file && !String(this.file).startsWith('<') ? path.dirname(path.resolve(this.file)) : process.cwd();
    const abs = path.resolve(base, String(spec));
    if (!fs.existsSync(abs)) {
      this.error(`cannot find module '${spec}'`, st);
      return;
    }
    if (!st.names || !st.names.length) return;
    // Check named imports against the module's published exports.
    try {
      const src = fs.readFileSync(abs, 'utf8');
      const program = parse(src, { src, file: abs });
      const anyPub = program.body.some((s) => (s.type === 'FnDecl' || s.type === 'TypeDecl') && s.isPub);
      const exported = new Set();
      for (const s of program.body) {
        if (s.type === 'FnDecl' && (s.isPub || !anyPub)) exported.add(s.name);
        if (s.type === 'TypeDecl' && (s.isPub || !anyPub)) {
          if (s.kind === 'union') for (const v of s.variants) exported.add(v.name);
          else exported.add(s.name);
        }
      }
      for (const n of st.names) {
        if (!exported.has(n)) this.error(`module '${spec}' has no export '${n}'`, st);
      }
    } catch {
      // Imported module has its own parse error; don't duplicate it here.
    }
  }

  // --- annotations ----------------------------------------------------------
  checkType(t, scope, owner) {
    if (!t) return;
    switch (t.type) {
      case 'TypeName': {
        const name = String(t.name);
        if (name.includes('.')) return; // JS/namespaced types are opaque to us
        if (BUILTIN_TYPES.has(name)) return;
        if (scope.lookup(name)) return;
        this.error(`unknown type '${name}'`, owner || t);
        return;
      }
      case 'TypeOpt': return this.checkType(t.of, scope, owner);
      case 'TypeList': return this.checkType(t.of, scope, owner);
      case 'TypeTuple': for (const x of t.items) this.checkType(x, scope, owner); return;
      case 'TypeMap': this.checkType(t.key, scope, owner); this.checkType(t.value, scope, owner); return;
      case 'TypeRecord': for (const f of t.fields) if (f.ann) this.checkType(f.ann, scope, owner); return;
      case 'TypeUnion': for (const x of t.options) this.checkType(x, scope, owner); return;
      case 'TypeFn':
        for (const x of t.params) this.checkType(x, scope, owner);
        this.checkType(t.ret, scope, owner);
        return;
      default: return;
    }
  }

  // --- expressions ----------------------------------------------------------
  checkExpr(e, scope, fnDepth, loopDepth) {
    if (!e || typeof e !== 'object') return;
    switch (e.type) {
      case 'Ident':
        if (!scope.has(e.name)) this.error(`undefined identifier '${e.name}'`, e);
        return;
      case 'Placeholder': case 'Num': case 'Bool': case 'Nil':
        return;
      case 'Str':
        for (const p of e.parts) if (p.k === 'e') this.checkExpr(p.e, scope, fnDepth, loopDepth);
        return;
      case 'Array':
        for (const it of e.items) this.checkExpr(it && it.type === 'Spread' ? it.e : it, scope, fnDepth, loopDepth);
        return;
      case 'Tuple':
        for (const it of e.items) this.checkExpr(it, scope, fnDepth, loopDepth);
        return;
      case 'Record':
        for (const f of e.fields) this.checkExpr(f.value, scope, fnDepth, loopDepth);
        return;
      case 'ArrayComp':
        this.checkComprehension(e.clauses, scope, fnDepth, loopDepth, (child) =>
          this.checkExpr(e.value, child, fnDepth, loopDepth));
        return;
      case 'MapComp':
        this.checkComprehension(e.clauses, scope, fnDepth, loopDepth, (child) => {
          if (e.key && typeof e.key === 'object') this.checkExpr(e.key, child, fnDepth, loopDepth);
          this.checkExpr(e.value, child, fnDepth, loopDepth);
        });
        return;
      case 'Lambda': return this.checkLambda(e, scope, fnDepth, loopDepth);
      case 'Call': return this.checkCall(e, scope, fnDepth, loopDepth);
      case 'New': {
        this.checkExpr(e.callee, scope, fnDepth, loopDepth);
        for (const a of e.args || []) this.checkExpr(a.value, scope, fnDepth, loopDepth);
        if (e.callee && e.callee.type === 'Ident') {
          const sym = scope.lookup(e.callee.name);
          if (sym && sym.kind === 'fn') this.checkFnCall(e, sym);
          else if (sym && sym.kind === 'ctor') this.checkCtorCall(e, sym);
        }
        return;
      }
      case 'Member': return this.checkExpr(e.obj, scope, fnDepth, loopDepth);
      case 'Index':
        this.checkExpr(e.obj, scope, fnDepth, loopDepth);
        this.checkExpr(e.index, scope, fnDepth, loopDepth);
        return;
      case 'Slice':
        this.checkExpr(e.obj, scope, fnDepth, loopDepth);
        if (e.start) this.checkExpr(e.start, scope, fnDepth, loopDepth);
        if (e.end) this.checkExpr(e.end, scope, fnDepth, loopDepth);
        return;
      case 'Propagate': return this.checkExpr(e.e, scope, fnDepth, loopDepth);
      case 'Unary': return this.checkExpr(e.e, scope, fnDepth, loopDepth);
      case 'Await': return this.checkExpr(e.e, scope, fnDepth, loopDepth);
      case 'Spawn': return this.checkExpr(e.e, scope, fnDepth, loopDepth);
      case 'Binary':
        this.checkExpr(e.l, scope, fnDepth, loopDepth);
        this.checkExpr(e.r, scope, fnDepth, loopDepth);
        return;
      case 'Range':
        this.checkExpr(e.start, scope, fnDepth, loopDepth);
        this.checkExpr(e.end, scope, fnDepth, loopDepth);
        return;
      case 'If': return this.checkIfExpr(e, scope, fnDepth, loopDepth);
      case 'Match': return this.checkMatchExpr(e, scope, fnDepth, loopDepth);
      case 'IsType':
        this.checkExpr(e.value, scope, fnDepth, loopDepth);
        this.checkType(e.of, scope, e);
        return;
      case 'Assign': return this.checkAssign(e, scope, fnDepth, loopDepth);
      default:
        return; // forward-compatible
    }
  }

  checkLambda(e, scope, fnDepth, loopDepth) {
    const lamScope = new Scope(scope);
    this.checkDuplicateParams(e.params || [], e);
    for (const p of e.params || []) {
      if (p.ann) this.checkType(p.ann, lamScope, e);
      if (p.default) this.checkExpr(p.default, lamScope, fnDepth + 1, 0);
      lamScope.define(p.name, { kind: 'param', name: p.name });
    }
    if (e.body) this.checkStatements(e.body.body, lamScope, fnDepth + 1, 0);
  }

  checkCall(e, scope, fnDepth, loopDepth) {
    this.checkExpr(e.callee, scope, fnDepth, loopDepth);
    const seen = new Set();
    for (const a of e.args || []) {
      if (a.name) {
        if (seen.has(a.name)) this.error(`duplicate named argument '${a.name}'`, e);
        seen.add(a.name);
      }
      this.checkExpr(a.value, scope, fnDepth, loopDepth);
    }
    if (e.callee && e.callee.type === 'Ident') {
      const sym = scope.lookup(e.callee.name);
      if (sym && sym.kind === 'fn') this.checkFnCall(e, sym);
      else if (sym && sym.kind === 'ctor') this.checkCtorCall(e, sym);
    }
  }

  checkFnCall(e, sym) {
    const params = sym.params || [];
    const named = (e.args || []).filter((a) => a.name);
    for (const a of named) {
      if (!params.some((p) => p.name === a.name)) {
        this.error(`fn '${sym.name}' has no parameter '${a.name}'`, e);
      }
    }
    if (named.length) return; // named calls use the runtime's packed-object path
    if ((e.args || []).some((a) => a.spread)) return;
    const positional = (e.args || []).length;
    const required = params.filter((p) => !p.default && !p.rest).length;
    const rest = params.some((p) => p.rest);
    const max = rest ? Infinity : params.length;
    if (positional < required) {
      const want = required === max ? String(required) : `at least ${required}`;
      this.error(`fn '${sym.name}' expects ${want} argument(s), got ${positional}`, e);
    } else if (positional > max) {
      this.error(`fn '${sym.name}' expects at most ${max} argument(s), got ${positional}`, e);
    }
  }

  checkCtorCall(e, sym) {
    const fields = sym.fields || [];
    const named = (e.args || []).filter((a) => a.name);
    for (const a of named) {
      if (!fields.includes(a.name)) this.error(`type '${sym.name}' has no field '${a.name}'`, e);
    }
    if (named.length || (e.args || []).some((a) => a.spread)) return;
    const positional = (e.args || []).length;
    if (positional > fields.length) {
      this.error(`type '${sym.name}' expects at most ${fields.length} field(s), got ${positional}`, e);
    }
  }

  checkIfExpr(e, scope, fnDepth, loopDepth) {
    this.checkExpr(e.cond, scope, fnDepth, loopDepth);
    this.checkBranch(e.then, scope, fnDepth, loopDepth);
    for (const el of e.elifs || []) {
      this.checkExpr(el.cond, scope, fnDepth, loopDepth);
      this.checkBranch(el.body, scope, fnDepth, loopDepth);
    }
    if (e.else) this.checkBranch(e.else, scope, fnDepth, loopDepth);
  }

  checkBranch(block, scope, fnDepth, loopDepth) {
    if (!block || !block.body) return;
    if (block.body.length === 1 && block.body[0].type === 'ExprStmt') {
      this.checkExpr(block.body[0].expr, scope, fnDepth, loopDepth);
      return;
    }
    this.checkStatements(block.body, scope, fnDepth, loopDepth);
  }

  checkMatchExpr(e, scope, fnDepth, loopDepth) {
    this.checkExpr(e.subj, scope, fnDepth, loopDepth);
    for (const arm of e.arms) {
      const child = new Scope(scope);
      this.bindPattern(arm.pattern, child);
      if (arm.guard) this.checkExpr(arm.guard, child, fnDepth, loopDepth);
      this.checkStatements(arm.body.body, child, fnDepth, loopDepth);
    }
  }

  checkComprehension(clauses, scope, fnDepth, loopDepth, done) {
    const walk = (i, sc) => {
      if (i >= clauses.length) { done(sc); return; }
      const c = clauses[i];
      if (c.k === 'for') {
        this.checkExpr(c.iter, sc, fnDepth, loopDepth);
        const child = new Scope(sc);
        this.bindPattern(c.pattern, child);
        walk(i + 1, child);
      } else {
        this.checkExpr(c.cond, sc, fnDepth, loopDepth);
        walk(i + 1, sc);
      }
    };
    walk(0, scope);
  }

  checkAssign(e, scope, fnDepth, loopDepth) {
    this.checkAssignTarget(e.target, e.op, scope, fnDepth, loopDepth);
    this.checkExpr(e.value, scope, fnDepth, loopDepth);
  }

  checkAssignTarget(target, op, scope, fnDepth, loopDepth) {
    if (!target) return;
    switch (target.type) {
      case 'Ident':
        if (op === '=') {
          if (!scope.has(target.name)) scope.define(target.name, { kind: 'var', name: target.name });
        } else if (!scope.has(target.name)) {
          this.error(`undefined identifier '${target.name}'`, target);
        }
        return;
      case 'Member': return this.checkExpr(target.obj, scope, fnDepth, loopDepth);
      case 'Index':
        this.checkExpr(target.obj, scope, fnDepth, loopDepth);
        this.checkExpr(target.index, scope, fnDepth, loopDepth);
        return;
      case 'Tuple':
      case 'Array':
        for (const it of target.items) {
          const sub = it && it.type === 'Spread' ? it.e : it;
          this.checkAssignTarget(sub, op, scope, fnDepth, loopDepth);
        }
        return;
      case 'Record':
        for (const f of target.fields) this.checkAssignTarget(f.value, op, scope, fnDepth, loopDepth);
        return;
      default:
        this.checkExpr(target, scope, fnDepth, loopDepth);
    }
  }
}

function collectPatternNames(pat, out, alt = null) {
  if (!pat) return out;
  switch (pat.type) {
    case 'PBind': out.push({ name: pat.name, node: pat, alt }); break;
    case 'PRest': break;
    case 'PTuple': for (const x of pat.items) collectPatternNames(x, out, alt); break;
    case 'PArray':
      for (const x of pat.items) collectPatternNames(x, out, alt);
      if (pat.rest) out.push({ name: pat.rest, node: pat, alt });
      break;
    case 'PRecord':
      for (const x of Object.values(pat.fields)) collectPatternNames(x, out, alt);
      if (pat.rest) out.push({ name: pat.rest, node: pat, alt });
      break;
    case 'PVariant': for (const x of pat.args) collectPatternNames(x, out, alt); break;
    case 'POr':
      // Each alternative gets its own id so equal names in different `|` arms
      // are allowed (only one arm binds at runtime).
      pat.options.forEach((x, i) => collectPatternNames(x, out, `${alt ?? ''}#${i}`));
      break;
    default: break;
  }
  return out;
}
