// Tel parser: layout-sensitive recursive descent + Pratt expressions.
import { lex, KEYWORDS } from './lexer.mjs';

export class ParseError extends Error {
  constructor(msg, line, col) { super(msg); this.name = 'ParseError'; this.line = line; this.col = col; }
}

export function parse(src, opts = {}) {
  const tokens = Array.isArray(src) ? src : lex(src, opts);
  return new Parser(tokens, opts).parseProgram();
}

export function parseExpression(src, opts = {}) {
  const p = new Parser(lex(src, opts), opts);
  p.skipSoftNl();
  const e = p.parseExpr(0);
  p.skipSoftNl();
  if (!p.atEof()) p.fail('unexpected trailing input');
  return e;
}

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '??=']);
const MODIFIERS = new Set(['pub', 'async', 'srv', 'cli', 'web']);

export class Parser {
  constructor(tokens, opts = {}) {
    this.toks = tokens;
    this.pos = 0;
    this.src = opts.src ?? null;
    this.noTernary = 0;
  }

  // --- token helpers -------------------------------------------------------
  peek(k = 0) { return this.toks[Math.min(this.pos + k, this.toks.length - 1)]; }
  next() { const t = this.toks[this.pos]; if (t.t !== 'eof') this.pos++; return t; }
  atEof() { return this.peek().t === 'eof'; }
  at(t, v) { const x = this.peek(); return x.t === t && (v === undefined || x.v === v); }
  atOp(v) { return this.at('op', v); }
  atKw(v) { return this.at('kw', v); }
  eat(t, v) { if (this.at(t, v)) return this.next(); return null; }
  eatOp(v) { return this.atOp(v) ? this.next() : null; }
  eatKw(v) { return this.atKw(v) ? this.next() : null; }
  expect(t, v, msg) {
    if (this.at(t, v)) return this.next();
    this.fail(msg || `expected ${v ?? t}, got ${this.describe(this.peek())}`);
  }
  expectOp(v, msg) { return this.expect('op', v, msg); }
  expectKw(v, msg) { return this.expect('kw', v, msg); }
  expectName(msg = 'expected a name') {
    const x = this.peek();
    if (x.t === 'id' || x.t === 'kw') { this.next(); return x.v; }
    this.fail(msg);
  }
  describe(t) {
    if (t.t === 'eof') return 'end of file';
    if (t.t === 'nl') return 'newline';
    if (t.t === 'indent') return 'indent';
    if (t.t === 'dedent') return 'dedent';
    if (t.t === 'str') return 'string';
    return `${t.t} ${JSON.stringify(t.v)}`;
  }
  fail(msg, tok = this.peek()) {
    throw new ParseError(msg, tok.line, tok.col);
  }
  skipNl() { while (this.at('nl') || this.atOp(';')) this.next(); }
  skipSoftNl() { while (this.at('nl') || this.atOp(';')) this.next(); }
  withNoTernary(fn) { this.noTernary++; try { return fn(); } finally { this.noTernary--; } }

  // --- program / declarations ---------------------------------------------
  parseProgram() {
    const body = [];
    this.skipNl();
    while (!this.atEof()) {
      body.push(this.parseDeclaration());
      this.skipNl();
    }
    return { type: 'Program', body };
  }

  parseDeclaration() {
    if (this.atKw('import')) return this.parseImport();
    let sawMod = false;
    const flags = { isPub: false, async: false, surface: null };
    while (MODIFIERS.has(this.peek().v)) {
      sawMod = true;
      const m = this.next().v;
      if (m === 'pub') flags.isPub = true;
      else if (m === 'async') flags.async = true;
      else { flags.surface = m; flags.isPub = true; }
    }
    if (this.atKw('fn')) return this.parseFn(flags);
    if (sawMod) this.fail('expected fn after modifiers');
    if (this.atKw('type') || this.atKw('enum')) return this.parseTypeDecl();
    return this.parseStatement();
  }

  parseImport() {
    const start = this.expectKw('import');
    let file = null, path = null, alias = null, names = null;
    if (this.at('str')) {
      const t = this.next();
      file = t.parts.map((p) => (p.k === 't' ? p.v : '')).join('');
    } else {
      const segs = [this.expectName('expected module path after import')];
      while (this.atOp('.')) {
        if (this.peek(1).t === 'op' && this.peek(1).v === '{') break;
        this.next();
        segs.push(this.expectName());
      }
      path = segs.join('.');
      if (this.atOp('.') && this.peek(1).t === 'op' && this.peek(1).v === '{') {
        this.next(); this.next();
        names = [];
        while (!this.atOp('}')) {
          names.push(this.expectName());
          if (!this.eatOp(',')) break;
        }
        this.expectOp('}');
      }
    }
    if (this.eatKw('as')) alias = this.expectName();
    else if (!names && path) alias = path.split('.').pop();
    else if (!names && file) alias = file.split('/').pop().replace(/\.tel$/, '');
    if (!alias && !names) this.fail('import needs an alias, e.g. `import std.http as http`');
    return { type: 'Import', path, file, alias, names, line: start.line, col: start.col };
  }

  parseTypeDecl() {
    const start = this.next(); // type | enum
    const isEnum = start.v === 'enum';
    const name = this.expectName('expected type name');
    const generics = this.parseGenericParams();
    this.expectOp('=', 'expected = in type declaration');
    if (isEnum) {
      const variants = this.parseVariantList();
      return { type: 'TypeDecl', name, generics, kind: 'union', variants, line: start.line, col: start.col };
    }
    // record/union/alias decision
    if (this.atOp('{')) {
      const fields = this.parseRecordTypeFields();
      return { type: 'TypeDecl', name, generics, kind: 'record', fields, line: start.line, col: start.col };
    }
    const save = this.pos;
    try {
      const variants = this.parseVariantList();
      const known = new Set([...generics, 'Num', 'Int', 'Str', 'Bool', 'Nil', 'Any', 'Void', 'Never', 'List', 'Map', 'Fn', 'Result', 'Error', 'Task']);
      // any variant with payload fields is certainly a union type
      if (variants.some((v) => v.fields.length > 0)) {
        return { type: 'TypeDecl', name, generics, kind: 'union', variants, line: start.line, col: start.col };
      }
      const allCaps = variants.every((v) => /^[A-Z]/.test(v.name));
      const touchesKnown = variants.some((v) => known.has(v.name));
      if (allCaps && !touchesKnown) {
        return { type: 'TypeDecl', name, generics, kind: 'union', variants, line: start.line, col: start.col };
      }
      this.pos = save;
    } catch { this.pos = save; }
    const aliased = this.parseType();
    return { type: 'TypeDecl', name, generics, kind: 'alias', aliased, line: start.line, col: start.col };
  }

  parseVariantList() {
    const variants = [];
    for (;;) {
      const t = this.peek();
      if (t.t !== 'id' && t.t !== 'kw') this.fail('expected variant name');
      const name = this.next().v;
      let fields = [];
      if (this.atOp('(')) fields = this.parseVariantFields();
      variants.push({ name, fields });
      if (!this.eatOp('|')) break;
    }
    return variants;
  }

  parseVariantFields() {
    this.expectOp('(');
    const fields = [];
    this.skipSoftNl();
    while (!this.atOp(')')) {
      const name = this.expectName();
      let ann = null;
      if (this.eatOp(':')) ann = this.parseType();
      let def = null;
      if (this.eatOp('=')) def = this.parseExpr(0);
      fields.push({ name, ann, default: def });
      this.skipSoftNl();
      if (!this.eatOp(',')) break;
      this.skipSoftNl();
    }
    this.expectOp(')');
    return fields;
  }

  parseRecordTypeFields() {
    this.expectOp('{');
    const fields = [];
    this.skipSoftNl();
    while (!this.atOp('}')) {
      const name = this.expectName();
      let ann = null;
      if (this.eatOp(':')) ann = this.parseType();
      fields.push({ name, ann });
      this.skipSoftNl();
      if (!this.eatOp(',')) break;
      this.skipSoftNl();
    }
    this.expectOp('}');
    return fields;
  }

  parseGenericParams() {
    if (!this.atOp('[')) return [];
    this.next();
    const out = [];
    while (!this.atOp(']')) { out.push(this.expectName()); if (!this.eatOp(',')) break; }
    this.expectOp(']');
    return out;
  }

  parseFn(flags) {
    const start = this.expectKw('fn');
    const first = this.expectName('expected function name');
    let name = first, recvType = null;
    if (this.atOp('.')) { // Type.method
      this.next();
      recvType = first;
      name = this.expectName('expected method name');
    }
    const generics = this.parseGenericParams();
    const params = this.parseParams();
    let ret = null;
    if (this.eatOp('->')) ret = this.parseType();
    let body;
    if (this.eatOp('=')) {
      const e = this.parseExpr(0);
      body = { type: 'Block', body: [{ type: 'ExprStmt', expr: e }] };
    } else {
      body = this.parseBodyAfterColon();
    }
    return { type: 'FnDecl', name, recvType, generics, params, ret, body, async: flags.async, isPub: flags.isPub, surface: flags.surface, line: start.line, col: start.col };
  }

  parseParams() {
    this.expectOp('(');
    const params = [];
    this.skipSoftNl();
    while (!this.atOp(')')) {
      let rest = false;
      if (this.eatOp('...')) rest = true;
      if (this.atOp('_')) this.next();
      const name = this.expectName('expected parameter name');
      let ann = null, def = null;
      if (this.eatOp(':')) ann = this.parseType();
      if (this.eatOp('=')) def = this.parseExpr(0);
      params.push({ name, ann, default: def, rest });
      this.skipSoftNl();
      if (!this.eatOp(',')) break;
      this.skipSoftNl();
    }
    this.expectOp(')');
    return params;
  }

  // --- statements -----------------------------------------------------------
  parseBlock() { // after `:` or `{` is handled elsewhere
    this.skipNl();
    this.expect('indent');
    const body = [];
    while (!this.at('dedent') && !this.atEof()) {
      body.push(this.parseDeclaration());
      this.skipNl();
    }
    this.expect('dedent');
    return { type: 'Block', body };
  }

  parseBodyAfterColon() {
    this.expectOp(':');
    if (this.at('nl')) return this.parseBlock();
    // inline body: exactly one statement (expression forms are enough for one-liners)
    const st = this.parseDeclaration();
    return { type: 'Block', body: [st] };
  }

  parseBraceBlock() {
    this.expectOp('{');
    const body = [];
    this.skipNl();
    while (!this.atOp('}') && !this.atEof()) {
      body.push(this.parseDeclaration());
      this.skipNl();
    }
    this.expectOp('}');
    return { type: 'Block', body };
  }

  parseStatement() {
    const t = this.peek();
    if (t.t === 'kw') {
      switch (t.v) {
        case 'if': return this.parseIf();
        case 'for': return this.parseFor();
        case 'while': return this.parseWhile();
        case 'loop': return this.parseLoop();
        case 'match': return this.parseMatch();
        case 'try': return this.parseTry();
        case 'return': {
          this.next();
          const value = this.atEndOfStatement() ? null : this.parseExpr(0);
          return { type: 'Return', value };
        }
        case 'break': this.next(); return { type: 'Break' };
        case 'continue': this.next(); return { type: 'Continue' };
        case 'throw': { this.next(); return { type: 'Throw', value: this.parseExpr(0) }; }
        case 'defer': { this.next(); return { type: 'Defer', value: this.parseExpr(0) }; }
        default: break;
      }
    }
    if (this.atKw('fn')) return this.parseFn({ isPub: false, async: false, surface: null });
    if (this.atKw('type') || this.atKw('enum')) return this.parseTypeDecl();

    const bind = this.tryParseBinding();
    if (bind) return bind;
    const expr = this.parseExpr(0);
    return { type: 'ExprStmt', expr };
  }

  atEndOfStatement() {
    return this.at('nl') || this.at('dedent') || this.at('eof') || this.atOp(';') || this.atOp('}');
  }

  tryParseBinding() {
    const save = this.pos;
    let pattern;
    try { pattern = this.parsePattern(); } catch { this.pos = save; return null; }
    if (this.atOp(':')) {
      const ann = (this.next(), this.parseType());
      if (this.eatOp('=')) {
        const value = this.parseExpr(0);
        return { type: 'Let', pattern, ann, value };
      }
      this.pos = save; return null;
    }
    if (ASSIGN_OPS.has(this.peek().v) && this.peek().t === 'op') {
      const op = this.next().v;
      const value = this.parseExpr(0);
      if (op === '=') {
        if (pattern.type === 'PBind') return { type: 'Let', pattern, ann: null, value };
        if (pattern.type === 'PWild') return { type: 'ExprStmt', expr: value };
        return { type: 'Let', pattern, ann: null, value, destructure: true };
      }
      if (pattern.type !== 'PBind' && pattern.type !== 'PWild') { this.pos = save; return null; }
      const target = pattern.type === 'PBind' ? { type: 'Ident', name: pattern.name } : { type: 'Placeholder' };
      return { type: 'Assign', target, op, value };
    }
    this.pos = save; return null;
  }

  parseIf() {
    const start = this.expectKw('if');
    const col = start.col;
    const cond = this.parseExpr(0);
    const then = this.parseBodyAfterColon();
    const elifs = [];
    for (;;) {
      const save = this.pos;
      this.skipNl();
      if (this.atKw('elif') && this.peek().col === col) {
        this.next();
        const c = this.parseExpr(0);
        elifs.push({ cond: c, body: this.parseBodyAfterColon() });
        continue;
      }
      if (this.atKw('else') && this.peek().col === col) {
        this.next();
        const elseBody = this.parseBodyAfterColon();
        return { type: 'If', cond, then, elifs, else: elseBody, line: start.line };
      }
      this.pos = save;
      break;
    }
    return { type: 'If', cond, then, elifs, else: null, line: start.line };
  }

  parseFor() {
    const start = this.expectKw('for');
    const pattern = this.parsePattern();
    this.expectKw('in', 'expected `in` in for loop');
    const iter = this.withNoTernary(() => this.parseExpr(0));
    const body = this.parseBodyAfterColon();
    return { type: 'For', pattern, iter, body, line: start.line };
  }

  parseWhile() {
    this.expectKw('while');
    const cond = this.parseExpr(0);
    return { type: 'While', cond, body: this.parseBodyAfterColon() };
  }

  parseLoop() {
    this.expectKw('loop');
    return { type: 'Loop', body: this.parseBodyAfterColon() };
  }

  parseMatch() {
    const start = this.expectKw('match');
    const subj = this.parseExpr(0);
    this.expectOp(':', 'expected : in match');
    this.skipNl();
    this.expect('indent', undefined, 'expected indented match arms');
    const arms = [];
    while (!this.at('dedent') && !this.atEof()) {
      const pattern = this.parsePattern();
      let guard = null;
      if (this.eatKw('if')) guard = this.parseExpr(0);
      const body = this.parseBodyAfterColon();
      arms.push({ pattern, guard, body });
      this.skipNl();
    }
    this.expect('dedent');
    return { type: 'Match', subj, arms, line: start.line };
  }

  parseTry() {
    const start = this.expectKw('try');
    const col = start.col;
    const body = this.parseBodyAfterColon();
    const catches = [];
    for (;;) {
      const save = this.pos;
      this.skipNl();
      if (this.atKw('catch') && this.peek().col === col) { this.next(); }
      else { this.pos = save; break; }
      let pattern;
      if (this.atOp('{') || this.atOp('[') || this.atOp('(')) pattern = this.parsePattern();
      else if (this.atOp('_')) { this.next(); pattern = { type: 'PWild' }; }
      else pattern = { type: 'PBind', name: this.expectName('expected catch binding') };
      const cbody = this.parseBodyAfterColon();
      catches.push({ pattern, body: cbody });
    }
    let fin = null;
    {
      const save = this.pos;
      this.skipNl();
      if (this.atKw('finally') && this.peek().col === col) { this.next(); fin = this.parseBodyAfterColon(); }
      else this.pos = save;
    }
    if (!catches.length && !fin) this.fail('try needs catch or finally');
    return { type: 'Try', body, catches, fin };
  }

  // --- expressions ----------------------------------------------------------
  parseExpr(minBp = 0) {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      const tn = t.t === 'op' || t.t === 'kw' ? t.v : null;

      // assignment (right-assoc, lowest)
      if (tn && ASSIGN_OPS.has(tn) && t.t === 'op' && 1 >= minBp) {
        this.next();
        const value = this.parseExpr(1);
        left = { type: 'Assign', target: left, op: tn, value };
        continue;
      }
      // `a if c else b`
      if (t.t === 'kw' && t.v === 'if' && !this.noTernary && 2 >= minBp) {
        this.next();
        const cond = this.parseExpr(0);
        this.expectKw('else', 'expected `else` in conditional expression');
        const els = this.parseExpr(2);
        left = {
          type: 'If', cond,
          then: { type: 'Block', body: [{ type: 'ExprStmt', expr: left }] },
          elifs: [],
          else: { type: 'Block', body: [{ type: 'ExprStmt', expr: els }] },
        };
        continue;
      }
      // ranges
      if ((t.t === 'op' && (t.v === '..' || t.v === '..=')) && 45 >= minBp) {
        this.next();
        const end = this.parseExpr(46);
        left = { type: 'Range', start: left, end, inclusive: t.v === '..=' };
        continue;
      }
      // pipelines: x |> f  ==>  f(x);  x |> f(a) ==> f(x, a)
      if (t.t === 'op' && t.v === '|>' && 2 >= minBp) {
        this.next();
        const right = this.parseExpr(3);
        left = desugarPipe(left, right);
        continue;
      }
      // `x is Type`
      if (t.t === 'kw' && t.v === 'is' && 30 >= minBp) {
        this.next();
        left = { type: 'IsType', value: left, of: this.parseType() };
        continue;
      }
      const bp = tn === null ? undefined : BP[tn];
      if (bp === undefined || bp < minBp) break;
      this.next();
      const right = this.parseExpr(RIGHT.has(tn) ? bp : bp + 1);
      left = { type: 'Binary', op: tn, l: left, r: right };
    }
    return left;
  }

  parseUnary() {
    const t = this.peek();
    if (t.t === 'op' && ['-', '+', '!', '~'].includes(t.v)) {
      this.next();
      return { type: 'Unary', op: t.v, e: this.parseUnary() };
    }
    if (t.t === 'kw' && t.v === 'not') { this.next(); return { type: 'Unary', op: 'not', e: this.parseUnary() }; }
    if (t.t === 'kw' && t.v === 'await') { this.next(); return { type: 'Await', e: this.parseUnary() }; }
    if (t.t === 'kw' && t.v === 'spawn') { this.next(); return { type: 'Spawn', e: this.parseUnary() }; }
    if (t.t === 'kw' && t.v === 'async' && this.lambdaAhead()) {
      this.next();
      return this.parseLambdaTail();
    }
    return this.parsePostfix(this.parsePrimary());
  }

  lambdaAhead() {
    const n = this.peek(1);
    if (n.t === 'id' && n.v === '_') return true;
    if (n.t === 'id' || n.t === 'kw') return this.peek(2).t === 'op' && this.peek(2).v === '=>';
    if (n.t === 'op' && n.v === '(') {
      let d = 0, k = 1;
      for (; k < 200; k++) {
        const x = this.peek(k);
        if (x.t === 'eof') return false;
        if (x.t === 'op' && x.v === '(') d++;
        else if (x.t === 'op' && x.v === ')') { d--; if (d === 0) { const a = this.peek(k + 1); return a.t === 'op' && a.v === '=>'; } }
      }
    }
    return false;
  }

  parseLambdaTail() {
    if (this.at('id') && this.peek().v === '_' && this.peek(1).t === 'op' && this.peek(1).v === '=>') {
      this.next(); this.next();
      return { type: 'Lambda', params: [{ name: '$0' }], body: this.parseLambdaBody() };
    }
    if ((this.at('id') || this.at('kw')) && this.peek(1).t === 'op' && this.peek(1).v === '=>') {
      const name = this.next().v; this.next();
      return { type: 'Lambda', params: [{ name }], body: this.parseLambdaBody() };
    }
    const params = this.parseLambdaParams();
    this.expectOp('=>');
    return { type: 'Lambda', params, body: this.parseLambdaBody() };
  }

  parseLambdaParams() {
    this.expectOp('(');
    const params = [];
    this.skipSoftNl();
    while (!this.atOp(')')) {
      let rest = false;
      if (this.eatOp('...')) rest = true;
      let name;
      if (this.at('id') && this.peek().v === '_') { this.next(); name = '$0'; }
      else name = this.expectName('expected lambda parameter');
      let ann = null, def = null;
      if (this.eatOp(':')) ann = this.parseType();
      if (this.eatOp('=')) def = this.parseExpr(0);
      params.push({ name, ann, default: def, rest });
      this.skipSoftNl();
      if (!this.eatOp(',')) break;
      this.skipSoftNl();
    }
    this.expectOp(')');
    return params;
  }

  parseLambdaBody() {
    if (this.atOp('{')) return this.parseBraceBlock();
    const e = this.parseExpr(0);
    return { type: 'Block', body: [{ type: 'ExprStmt', expr: e }] };
  }

  parsePostfix(expr) {
    let e = expr;
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && t.v === '(') {
        this.next();
        e = { type: 'Call', callee: e, args: this.parseCallArgs() };
      } else if (t.t === 'op' && t.v === '[') {
        this.next();
        e = this.parseIndexOrSlice(e);
      } else if (t.t === 'op' && t.v === '.') {
        this.next();
        e = { type: 'Member', obj: e, name: this.expectName('expected member name'), optional: false };
      } else if (t.t === 'op' && t.v === '?.') {
        this.next();
        e = { type: 'Member', obj: e, name: this.expectName('expected member name'), optional: true };
      } else if (t.t === 'op' && t.v === '?') {
        this.next();
        e = { type: 'Propagate', e };
      } else break;
    }
    return e;
  }

  parseCallArgs() {
    const args = [];
    this.skipSoftNl();
    while (!this.atOp(')') && !this.atEof()) {
      if (this.eatOp('...')) {
        args.push({ name: null, spread: true, value: this.parseExpr(0) });
      } else if ((this.at('id') || this.at('kw')) && this.peek(1).t === 'op' && this.peek(1).v === '=') {
        const name = this.next().v; this.next();
        args.push({ name, spread: false, value: this.parseExpr(0) });
      } else {
        const value = rewritePlaceholders(this.parseExpr(0));
        args.push({ name: null, spread: false, value });
      }
      this.skipSoftNl();
      if (!this.eatOp(',')) break;
      this.skipSoftNl();
    }
    this.expectOp(')');
    return args;
  }

  parseIndexOrSlice(obj) {
    this.skipSoftNl();
    if (this.atOp('..') || this.atOp('..=')) {
      const inc = this.next().v === '..=';
      let end = null;
      if (!this.atOp(']')) end = this.parseExpr(0);
      this.skipSoftNl();
      this.expectOp(']');
      return { type: 'Slice', obj, start: null, end, inclusive: inc };
    }
    const start = this.parseExpr(0);
    this.skipSoftNl();
    if (this.atOp('..') || this.atOp('..=')) {
      const inc = this.next().v === '..=';
      let end = null;
      if (!this.atOp(']')) end = this.parseExpr(0);
      this.skipSoftNl();
      this.expectOp(']');
      return { type: 'Slice', obj, start, end, inclusive: inc };
    }
    this.expectOp(']');
    return { type: 'Index', obj, index: start };
  }

  parsePrimary() {
    const t = this.peek();
    if (t.t === 'num') { this.next(); return { type: 'Num', value: t.v, raw: t.raw }; }
    if (t.t === 'str') { this.next(); return this.buildStr(t); }
    if (t.t === 'kw') {
      if (t.v === 'true' || t.v === 'false') { this.next(); return { type: 'Bool', value: t.v === 'true' }; }
      if (t.v === 'nil') { this.next(); return { type: 'Nil' }; }
      if (t.v === 'self') { this.next(); return { type: 'Ident', name: 'self' }; }
      if (t.v === 'match') return this.parseMatch();
    }
    if (t.t === 'id') {
      if (t.v === '_') { this.next(); return { type: 'Placeholder' }; }
      if (this.peek(1).t === 'op' && this.peek(1).v === '=>') {
        const name = this.next().v; this.next();
        return { type: 'Lambda', params: [{ name }], body: this.parseLambdaBody() };
      }
      this.next();
      return { type: 'Ident', name: t.v };
    }
    if (t.t === 'op' && t.v === '(') return this.parseParenOrLambda();
    if (t.t === 'op' && t.v === '[') return this.parseArrayOrComp();
    if (t.t === 'op' && t.v === '{') return this.parseRecordOrComp();
    this.fail(`unexpected ${this.describe(t)} in expression`);
  }

  parseParenOrLambda() {
    const save = this.pos;
    try {
      const params = this.parseLambdaParams();
      if (this.atOp('=>')) {
        this.next();
        return { type: 'Lambda', params, body: this.parseLambdaBody() };
      }
    } catch { /* fall through to parenthesised expression */ }
    this.pos = save;
    this.expectOp('(');
    this.skipSoftNl();
    const first = this.parseExpr(0);
    this.skipSoftNl();
    if (this.eatOp(',')) {
      const items = [first];
      this.skipSoftNl();
      while (!this.atOp(')')) {
        items.push(this.parseExpr(0));
        this.skipSoftNl();
        if (!this.eatOp(',')) break;
        this.skipSoftNl();
      }
      this.expectOp(')');
      return { type: 'Tuple', items };
    }
    this.expectOp(')');
    return first;
  }

  parseArrayOrComp() {
    this.expectOp('[');
    this.skipSoftNl();
    if (this.atOp(']')) { this.next(); return { type: 'Array', items: [] }; }
    const first = this.parseExpr(0);
    if (this.atKw('for')) {
      const clauses = this.parseCompClauses();
      this.skipSoftNl();
      this.expectOp(']');
      return { type: 'ArrayComp', value: first, clauses };
    }
    const items = [];
    const pushItem = (e) => items.push(e);
    pushItem(first);
    this.skipSoftNl();
    while (this.eatOp(',')) {
      this.skipSoftNl();
      if (this.atOp(']')) break;
      if (this.eatOp('...')) { pushItem({ type: 'Spread', e: this.parseExpr(0) }); }
      else pushItem(this.parseExpr(0));
      this.skipSoftNl();
    }
    this.expectOp(']');
    return { type: 'Array', items };
  }

  parseCompClauses() {
    const clauses = [];
    while (this.eatKw('for')) {
      const pattern = this.parsePattern();
      this.expectKw('in', 'expected `in` in comprehension');
      const iter = this.withNoTernary(() => this.parseExpr(0));
      clauses.push({ k: 'for', pattern, iter });
      while (this.eatKw('if')) clauses.push({ k: 'if', cond: this.withNoTernary(() => this.parseExpr(0)) });
    }
    return clauses;
  }

  parseRecordOrComp() {
    this.expectOp('{');
    this.skipSoftNl();
    if (this.atOp('}')) { this.next(); return { type: 'Record', fields: [], map: false }; }
    const entries = [];
    let map = false;
    for (;;) {
      this.skipSoftNl();
      if (this.eatOp('...')) {
        entries.push({ spread: true, value: this.parseExpr(0) });
      } else {
        const t = this.peek();
        if (t.t === 'str') {
          const keyTok = this.next();
          const key = keyTok.parts.map((p) => (p.k === 't' ? p.v : '')).join('');
          this.expectOp(':');
          entries.push({ key, value: this.parseExpr(0) });
          map = true;
        } else if (t.t === 'id' || t.t === 'kw') {
          const key = t.v;
          if (this.peek(1).t === 'op' && this.peek(1).v === ':') {
            this.next(); this.next();
            entries.push({ key, value: this.parseExpr(0) });
          } else {
            this.next();
            entries.push({ key, value: { type: 'Ident', name: key } });
          }
        } else if (t.t === 'op' && t.v === '[') {
          this.fail('computed record keys are not supported yet');
        } else {
          this.fail('expected a record key');
        }
      }
      this.skipSoftNl();
      if (this.atKw('for')) {
        const last = entries[entries.length - 1];
        if (entries.length !== 1 || !last.key) this.fail('map comprehension must be `{key: value for ...}`');
        const clauses = this.parseCompClauses();
        this.skipSoftNl();
        this.expectOp('}');
        return { type: 'MapComp', key: last.key, value: last.value, clauses };
      }
      if (!this.eatOp(',')) break;
    }
    this.expectOp('}');
    return { type: 'Record', fields: entries, map };
  }

  buildStr(tok) {
    const parts = [];
    for (const p of tok.parts) {
      if (p.k === 't') { if (p.v) parts.push({ k: 't', v: p.v }); continue; }
      const sub = new Parser(lex(p.src, { line: p.line, col: p.col }), { src: p.src });
      sub.skipSoftNl();
      const e = sub.parseExpr(0);
      sub.skipSoftNl();
      if (!sub.atEof()) sub.fail('bad interpolation');
      parts.push({ k: 'e', e });
    }
    return { type: 'Str', parts };
  }

  // --- patterns -------------------------------------------------------------
  parsePattern() { return this.parsePatternOr(); }

  parsePatternOr() {
    const first = this.parsePatternPrimary();
    if (this.atOp('|')) {
      const options = [first];
      while (this.eatOp('|')) options.push(this.parsePatternPrimary());
      return { type: 'POr', options };
    }
    return first;
  }

  parsePatternPrimary() {
    const t = this.peek();
    if (t.t === 'op' && t.v === '...') { this.next(); return { type: 'PRest' }; }
    if (t.t === 'op' && t.v === '-' && this.peek(1).t === 'num') {
      this.next(); const num = this.next();
      return { type: 'PLit', value: -num.v };
    }
    if (t.t === 'num') { this.next(); return { type: 'PLit', value: t.v }; }
    if (t.t === 'str') {
      this.next();
      const s = t.parts.map((p) => (p.k === 't' ? p.v : this.fail('interpolated string cannot be a pattern'))).join('');
      return { type: 'PLit', value: s };
    }
    if (t.t === 'kw' && (t.v === 'true' || t.v === 'false')) { this.next(); return { type: 'PLit', value: t.v === 'true' }; }
    if (t.t === 'kw' && t.v === 'nil') { this.next(); return { type: 'PWild' }; }
    if (t.t === 'id') {
      if (t.v === '_') { this.next(); return { type: 'PWild' }; }
      const name = this.next().v;
      if (this.atOp('(')) {
        this.expectOp('(');
        const args = [];
        this.skipSoftNl();
        while (!this.atOp(')')) {
          args.push(this.parsePattern());
          this.skipSoftNl();
          if (!this.eatOp(',')) break;
          this.skipSoftNl();
        }
        this.expectOp(')');
        return { type: 'PVariant', name, args };
      }
      return /^[A-Z]/.test(name) ? { type: 'PVariant', name, args: [] } : { type: 'PBind', name };
    }
    if (t.t === 'op' && t.v === '(') {
      this.next();
      const items = [];
      this.skipSoftNl();
      while (!this.atOp(')')) {
        items.push(this.parsePattern());
        this.skipSoftNl();
        if (!this.eatOp(',')) break;
        this.skipSoftNl();
      }
      this.expectOp(')');
      return { type: 'PTuple', items };
    }
    if (t.t === 'op' && t.v === '[') {
      this.next();
      const items = [];
      let rest = null;
      this.skipSoftNl();
      while (!this.atOp(']')) {
        if (this.eatOp('...')) { rest = this.expectName('expected rest binding name'); this.skipSoftNl(); break; }
        items.push(this.parsePattern());
        this.skipSoftNl();
        if (!this.eatOp(',')) break;
        this.skipSoftNl();
      }
      this.expectOp(']');
      return { type: 'PArray', items, rest };
    }
    if (t.t === 'op' && t.v === '{') {
      this.next();
      const fields = {};
      let rest = null;
      this.skipSoftNl();
      while (!this.atOp('}')) {
        if (this.eatOp('...')) { rest = this.expectName('expected rest binding name'); this.skipSoftNl(); break; }
        const key = this.expectName('expected field name in record pattern');
        if (this.eatOp(':')) fields[key] = this.parsePattern();
        else fields[key] = { type: 'PBind', name: key };
        this.skipSoftNl();
        if (!this.eatOp(',')) break;
        this.skipSoftNl();
      }
      this.expectOp('}');
      return { type: 'PRecord', fields, rest };
    }
    this.fail(`unexpected ${this.describe(t)} in pattern`);
  }

  // --- types ----------------------------------------------------------------
  parseType() {
    let t = this.parseTypePrimary();
    while (this.atOp('|')) {
      this.next();
      t = { type: 'TypeUnion', options: [t, this.parseTypePrimary()] };
    }
    return t;
  }

  parseTypePrimary() {
    const t = this.peek();
    if (t.t === 'op' && t.v === '(') {
      this.next();
      this.skipSoftNl();
      if (this.atOp(')')) {
        this.next();
        if (this.eatOp('->')) return { type: 'TypeFn', params: [], ret: this.parseType() };
        return { type: 'TypeName', name: 'Void' };
      }
      const first = this.parseType();
      const items = [first];
      this.skipSoftNl();
      while (this.eatOp(',')) { this.skipSoftNl(); items.push(this.parseType()); this.skipSoftNl(); }
      this.expectOp(')');
      if (this.eatOp('->')) return { type: 'TypeFn', params: items, ret: this.parseType() };
      return items.length === 1 ? first : { type: 'TypeTuple', items };
    }
    if (t.t === 'op' && t.v === '[') {
      this.next();
      this.skipSoftNl();
      const first = this.parseType();
      this.skipSoftNl();
      if (this.eatOp(':')) {
        const second = this.parseType();
        this.expectOp(']');
        return { type: 'TypeMap', key: first, value: second };
      }
      this.expectOp(']');
      return { type: 'TypeList', of: first };
    }
    if (t.t === 'op' && t.v === '{') {
      const fields = this.parseRecordTypeFields();
      return { type: 'TypeRecord', fields };
    }
    if (t.t === 'id' || t.t === 'kw') {
      const name = this.next().v;
      let args = null;
      if (this.atOp('[')) {
        this.next();
        args = [];
        this.skipSoftNl();
        while (!this.atOp(']')) { args.push(this.parseType()); this.skipSoftNl(); if (!this.eatOp(',')) break; this.skipSoftNl(); }
        this.expectOp(']');
      }
      let ty = { type: 'TypeName', name, args };
      while (this.eatOp('?')) ty = { type: 'TypeOpt', of: ty };
      return ty;
    }
    this.fail('expected a type');
  }
}

const BP = {
  '??': 3,
  or: 10, '||': 10,
  and: 20, '&&': 20,
  '==': 30, '!=': 30, '<': 30, '<=': 30, '>': 30, '>=': 30,
  '|': 32, '^': 33, '&': 34,
  '<<': 40, '>>': 40,
  '+': 50, '-': 50,
  '*': 60, '/': 60, '%': 60,
  '**': 70,
};
const RIGHT = new Set(['**', '??']);

function desugarPipe(left, right) {
  if (right.type === 'Call') {
    return { ...right, args: [{ name: null, spread: false, value: left }, ...right.args] };
  }
  return { type: 'Call', callee: right, args: [{ name: null, spread: false, value: left }] };
}

export function rewritePlaceholders(e) {
  let found = false;
  function walk(node) {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(walk);
    if (node.type === 'Placeholder') { found = true; return { type: 'Ident', name: '$0' }; }
    if (node.type === 'Lambda') return node; // nested lambdas own their placeholders
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v);
    return out;
  }
  const out = walk(e);
  if (!found) return e;
  return { type: 'Lambda', params: [{ name: '$0' }], body: { type: 'Block', body: [{ type: 'ExprStmt', expr: out }] } };
}
