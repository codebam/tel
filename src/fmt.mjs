// src/fmt.mjs — canonical Tel formatter.
//
// This is an AST -> source formatter, not a token-preserving one: comments and
// blank lines are dropped. Canonical output rules:
//   * 2-space indentation
//   * one statement per line
//   * expressions stay on one line (lambda brace bodies use `;` separators)
//   * parentheses are emitted wherever precedence would otherwise change
//     the meaning of the parsed AST.
import { parse } from './parser.mjs';
import { KEYWORDS } from './lexer.mjs';

// Precedence of expression operators, mirroring the parser's binding powers.
const OP_PREC = {
  '??': 3,
  or: 10, '||': 10,
  and: 20, '&&': 20,
  '==': 30, '!=': 30, '<': 30, '<=': 30, '>': 30, '>=': 30, in: 30,
  '|': 32, '^': 33, '&': 34,
  '<<': 40, '>>': 40,
  '+': 50, '-': 50,
  '*': 60, '/': 60, '%': 60,
  '**': 70,
};
const RIGHT_ASSOC = new Set(['**', '??']);
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Format a parsed Program node, returning source text ending in a newline. */
export function formatProgram(program) {
  if (!program || program.type !== 'Program') throw new Error('formatProgram expects a Program node');
  if (!program.body.length) return '';
  return program.body.map((st) => fmtStmt(st, 0)).join('\n') + '\n';
}

/** Parse `src` and return its canonical formatting. Throws ParseError/LexError. */
export function formatSource(src, opts = {}) {
  return formatProgram(parse(src, opts));
}

function ind(n) { return '  '.repeat(n); }

function precOf(e) {
  if (!e) return 100;
  switch (e.type) {
    case 'Assign': return 1;
    case 'If': return 2;
    case 'Lambda': return 0;
    case 'Binary': return OP_PREC[e.op] ?? 30;
    case 'Range': return 45;
    case 'IsType': return 30;
    case 'Unary': case 'Await': case 'Spawn': return 80;
    case 'Call': case 'Member': case 'Index': case 'Slice': case 'Propagate': return 90;
    case 'New': return 80;
    default: return 100;
  }
}

function fmtExpr(e, parentPrec = 0, indent = 0) {
  if (!e) return 'nil';
  const s = fmtExprInner(e, indent);
  return precOf(e) < parentPrec ? '(' + s + ')' : s;
}

function fmtChild(e, minPrec, indent) {
  const s = fmtExpr(e, 0, indent);
  return precOf(e) < minPrec ? '(' + s + ')' : s;
}

function fmtBinChild(parent, child, side, indent) {
  const p = precOf(parent);
  const cp = precOf(child);
  const s = fmtExpr(child, 0, indent);
  let need = cp < p;
  if (cp === p) need = RIGHT_ASSOC.has(parent.op) ? side === 'left' : side === 'right';
  return need ? '(' + s + ')' : s;
}

// --- statements -------------------------------------------------------------
function fmtStmt(st, indent) {
  const pad = ind(indent);
  switch (st.type) {
    case 'Import': return pad + fmtImport(st);
    case 'TypeDecl': return pad + fmtTypeDecl(st);
    case 'FnDecl': return pad + fmtFnDecl(st, indent);
    case 'Let': return pad + fmtLet(st, indent);
    case 'Assign': return pad + fmtAssign(st, indent);
    case 'ExprStmt': return pad + fmtExpr(st.expr, 0, indent);
    case 'If': return pad + fmtIfStmt(st, indent);
    case 'For':
      return pad + `for ${fmtPattern(st.pattern)} in ${fmtExpr(st.iter, 0, indent)}:\n` + fmtBlock(st.body, indent + 1);
    case 'While':
      return pad + `while ${fmtExpr(st.cond, 0, indent)}:\n` + fmtBlock(st.body, indent + 1);
    case 'Loop':
      return pad + 'loop:\n' + fmtBlock(st.body, indent + 1);
    case 'Match': return pad + fmtMatch(st, indent);
    case 'Try': return pad + fmtTry(st, indent);
    case 'Return':
      return pad + 'return' + (st.value ? ' ' + fmtExpr(st.value, 0, indent) : '');
    case 'Break': return pad + 'break';
    case 'Continue': return pad + 'continue';
    case 'Throw': return pad + 'throw ' + fmtExpr(st.value, 0, indent);
    case 'Defer': return pad + 'defer ' + fmtExpr(st.value, 0, indent);
    case 'Block': return fmtBlock(st, indent);
    default: throw new Error(`fmt: cannot format statement node ${st.type}`);
  }
}

function fmtBlock(block, indent) {
  if (!block || !block.body || !block.body.length) return ind(indent);
  return block.body.map((st) => fmtStmt(st, indent)).join('\n');
}

function fmtFnDecl(st, indent) {
  const mods = [];
  if (st.isPub && !st.surface) mods.push('pub');
  if (st.async) mods.push('async');
  if (st.surface) mods.push(st.surface);
  const name = (st.recvType ? st.recvType + '.' : '') + st.name;
  const generics = st.generics && st.generics.length ? '[' + st.generics.join(', ') + ']' : '';
  const params = '(' + (st.params || []).map((p) => fmtParam(p, indent)).join(', ') + ')';
  const ret = st.ret ? ' -> ' + fmtType(st.ret) : '';
  const head = (mods.length ? mods.join(' ') + ' ' : '') + 'fn ' + name + generics + params + ret;
  const body = st.body;
  if (body && body.body && body.body.length === 1 && body.body[0].type === 'ExprStmt') {
    return head + ' = ' + fmtExpr(body.body[0].expr, 0, indent);
  }
  return head + ':\n' + fmtBlock(body, indent + 1);
}

function fmtParam(p, indent) {
  let s = (p.rest ? '...' : '') + p.name;
  if (p.ann) s += ': ' + fmtType(p.ann);
  if (p.default) s += ' = ' + fmtExpr(p.default, 0, indent);
  return s;
}

function fmtLet(st, indent) {
  const pat = fmtPattern(st.pattern);
  const ann = st.ann ? ': ' + fmtType(st.ann) : '';
  const value = st.value ? fmtExpr(st.value, 0, indent) : 'nil';
  return `${pat}${ann} = ${value}`;
}

function fmtAssign(e, indent) {
  const target = fmtExpr(e.target, 0, indent);
  const rhs = fmtExpr(e.value, 0, indent);
  // Assignment is right-associative (`a = b = c`), so only lower-precedence
  // values (e.g. a bare lambda) need parentheses.
  const need = precOf(e.value) < 1;
  return `${target} ${e.op} ${need ? '(' + rhs + ')' : rhs}`;
}

function fmtIfStmt(st, indent) {
  let out = `if ${fmtExpr(st.cond, 0, indent)}:\n` + fmtBlock(st.then, indent + 1);
  for (const el of st.elifs) {
    out += '\n' + ind(indent) + `elif ${fmtExpr(el.cond, 0, indent)}:\n` + fmtBlock(el.body, indent + 1);
  }
  if (st.else) out += '\n' + ind(indent) + 'else:\n' + fmtBlock(st.else, indent + 1);
  return out;
}

function fmtMatch(st, indent) {
  let out = `match ${fmtExpr(st.subj, 0, indent)}:`;
  for (const arm of st.arms) {
    const guard = arm.guard ? ` if ${fmtExpr(arm.guard, 0, indent + 1)}` : '';
    out += '\n' + ind(indent + 1) + fmtPattern(arm.pattern) + guard + ':\n' + fmtBlock(arm.body, indent + 2);
  }
  return out;
}

function fmtTry(st, indent) {
  let out = 'try:\n' + fmtBlock(st.body, indent + 1);
  for (const c of st.catches) {
    out += '\n' + ind(indent) + 'catch ' + fmtPattern(c.pattern) + ':\n' + fmtBlock(c.body, indent + 1);
  }
  if (st.fin) out += '\n' + ind(indent) + 'finally:\n' + fmtBlock(st.fin, indent + 1);
  return out;
}

function fmtImport(st) {
  // std namespace imports use the dotted form; everything else is a string spec
  // (Tel module, JS/npm package, node: builtin, URL).
  if (st.kind === 'std' || (st.path != null && st.file == null)) {
    let s = 'import ' + st.path;
    if (st.names && st.names.length) s += '.{' + st.names.join(', ') + '}';
    else if (st.alias) s += ' as ' + st.alias;
    return s;
  }
  const spec = st.file ?? st.spec ?? st.path ?? '';
  let s = 'import ' + JSON.stringify(spec);
  if (st.names && st.names.length) s += ' {' + st.names.join(', ') + '}';
  if (st.alias) s += ' as ' + st.alias;
  return s;
}

function fmtTypeDecl(st) {
  const generics = st.generics && st.generics.length ? '[' + st.generics.join(', ') + ']' : '';
  const head = (st.isPub ? 'pub ' : '') + `type ${st.name}${generics} = `;
  if (st.kind === 'record') {
    return head + '{' + st.fields.map((f) => f.name + (f.ann ? ': ' + fmtType(f.ann) : '')).join(', ') + '}';
  }
  if (st.kind === 'union') {
    return head + st.variants.map((v) => {
      if (!v.fields || !v.fields.length) return v.name;
      return v.name + '(' + v.fields.map((f) => fmtFieldDecl(f)).join(', ') + ')';
    }).join(' | ');
  }
  return head + fmtType(st.aliased);
}

function fmtFieldDecl(f) {
  let s = f.name;
  if (f.ann) s += ': ' + fmtType(f.ann);
  if (f.default) s += ' = ' + fmtExpr(f.default, 0, 0);
  return s;
}

// --- expressions ------------------------------------------------------------
function fmtExprInner(e, indent) {
  switch (e.type) {
    case 'Num': return fmtNum(e);
    case 'Bool': return e.value ? 'true' : 'false';
    case 'Nil': return 'nil';
    case 'Str': return fmtStr(e, indent);
    case 'Ident': return e.name;
    case 'Placeholder': return '_';
    case 'Array': return '[' + e.items.map((it) => fmtArrayItem(it, indent)).join(', ') + ']';
    case 'Tuple': return '(' + e.items.map((it) => fmtExpr(it, 0, indent)).join(', ') + ')';
    case 'Record': return '{' + e.fields.map((f) => fmtRecordField(f, indent)).join(', ') + '}';
    case 'ArrayComp': {
      const body = fmtExpr(e.value, 0, indent);
      return '[' + body + ' ' + fmtCompClauses(e.clauses, indent) + ']';
    }
    case 'MapComp': {
      const key = fmtRecordKey(e.key);
      return '{' + key + ': ' + fmtExpr(e.value, 0, indent) + ' ' + fmtCompClauses(e.clauses, indent) + '}';
    }
    case 'Lambda': return fmtLambda(e, indent);
    case 'Call': {
      const callee = fmtChild(e.callee, 90, indent);
      const args = e.args.map((a) => fmtCallArg(a, indent)).join(', ');
      return callee + '(' + args + ')';
    }
    case 'Member':
      return fmtChild(e.obj, 90, indent) + (e.optional ? '?.' : '.') + e.name;
    case 'Index':
      return fmtChild(e.obj, 90, indent) + '[' + fmtExpr(e.index, 0, indent) + ']';
    case 'Slice':
      return fmtChild(e.obj, 90, indent) + '[' + fmtSliceBody(e, indent) + ']';
    case 'Propagate':
      return fmtChild(e.e, 90, indent) + '?';
    case 'Unary': {
      const sub = fmtExpr(e.e, 0, indent);
      const body = precOf(e.e) < 80 ? '(' + sub + ')' : sub;
      return e.op === 'not' ? 'not ' + body : e.op + body;
    }
    case 'Await': return 'await ' + fmtUnaryOperand(e.e, indent);
    case 'Spawn': return 'spawn ' + fmtUnaryOperand(e.e, indent);
    case 'Binary': {
      const left = fmtBinChild(e, e.l, 'left', indent);
      const right = fmtBinChild(e, e.r, 'right', indent);
      return left + ' ' + e.op + ' ' + right;
    }
    case 'Range': {
      let start = fmtChild(e.start, 45, indent);
      let end = fmtChild(e.end, 46, indent);
      // `1.` followed by `..` would lex as `1...`; protect both ends.
      if (start.endsWith('.')) start = '(' + start + ')';
      if (end.startsWith('.')) end = '(' + end + ')';
      return start + '..' + (e.inclusive ? '=' : '') + end;
    }
    case 'If': return fmtTernary(e, indent);
    case 'Match': return fmtMatchExpr(e, indent);
    case 'IsType':
      return fmtChild(e.value, 30, indent) + ' is ' + fmtType(e.of);
    case 'Assign': return fmtAssign(e, indent);
    case 'New': {
      const callee = fmtChild(e.callee, 90, indent);
      const args = (e.args || []).map((a) => fmtCallArg(a, indent)).join(', ');
      return 'new ' + callee + '(' + args + ')';
    }
    default:
      throw new Error(`fmt: cannot format expression node ${e.type}`);
  }
}

function fmtUnaryOperand(e, indent) {
  const s = fmtExpr(e, 0, indent);
  return precOf(e) < 80 ? '(' + s + ')' : s;
}

function fmtNum(e) {
  if (typeof e.raw === 'string' && e.raw.length) return e.raw;
  if (typeof e.value === 'number') return String(e.value);
  return String(e.value);
}

function fmtStr(e, indent) {
  let out = '"';
  for (const p of e.parts) {
    if (p.k === 't') out += quoteText(p.v);
    else out += '{' + fmtExpr(p.e, 0, indent) + '}';
  }
  return out + '"';
}

function quoteText(text) {
  let out = '';
  for (const ch of String(text)) {
    switch (ch) {
      case '\\': out += '\\\\'; break;
      case '"': out += '\\"'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\t': out += '\\t'; break;
      case '\0': out += '\\0'; break;
      case '{': out += '\\{'; break;
      default: {
        const c = ch.codePointAt(0);
        if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0');
        else out += ch;
      }
    }
  }
  return out;
}

function fmtArrayItem(it, indent) {
  if (it && it.type === 'Spread') return '...' + fmtExpr(it.e, 0, indent);
  return fmtExpr(it, 0, indent);
}

function fmtRecordKey(key) {
  return IDENT_RE.test(key) ? key : JSON.stringify(String(key));
}

function fmtRecordField(f, indent) {
  if (f.spread) return '...' + fmtExpr(f.value, 0, indent);
  const key = fmtRecordKey(f.key);
  if (IDENT_RE.test(f.key) && f.value && f.value.type === 'Ident' && f.value.name === f.key) return key;
  return key + ': ' + fmtExpr(f.value, 0, indent);
}

function fmtCallArg(a, indent) {
  if (a.spread) return '...' + fmtExpr(a.value, 0, indent);
  if (a.name) return a.name + ' = ' + fmtExpr(a.value, 0, indent);
  return fmtExpr(a.value, 0, indent);
}

function fmtSliceBody(e, indent) {
  let start = e.start ? fmtExpr(e.start, 0, indent) : '';
  let end = e.end ? fmtExpr(e.end, 0, indent) : '';
  if (start.endsWith('.')) start = '(' + start + ')';
  if (end.startsWith('.')) end = '(' + end + ')';
  return start + '..' + (e.inclusive ? '=' : '') + end;
}

function fmtTernary(e, indent) {
  const thenE = blockSingleExpr(e.then);
  const elseE = e.else ? blockSingleExpr(e.else) : null;
  if (!thenE) throw new Error('fmt: statement-level if cannot be formatted as an expression');
  const thenS = fmtBinChild({ type: 'If' }, thenE, 'left', indent);
  const condS = fmtExpr(e.cond, 0, indent);
  const elseS = elseE ? fmtBinChild({ type: 'If' }, elseE, 'right', indent) : 'nil';
  return thenS + ' if ' + condS + ' else ' + elseS;
}

function blockSingleExpr(block) {
  if (block && block.body && block.body.length === 1 && block.body[0].type === 'ExprStmt') {
    return block.body[0].expr;
  }
  return null;
}

function fmtMatchExpr(e, indent) {
  const lines = ['match ' + fmtExpr(e.subj, 0, indent) + ':'];
  for (const arm of e.arms) {
    const guard = arm.guard ? ` if ${fmtExpr(arm.guard, 0, indent + 1)}` : '';
    lines.push(ind(indent + 1) + fmtPattern(arm.pattern) + guard + ':');
    lines.push(fmtBlock(arm.body, indent + 2));
  }
  return lines.join('\n');
}

function fmtLambda(e, indent) {
  const params = e.params || [];
  const body = fmtLambdaBody(e.body, indent);
  if (params.length === 1) {
    const p = params[0];
    const bare = !p.rest && !p.ann && !p.default && IDENT_RE.test(p.name) && !KEYWORDS.has(p.name);
    if (bare) return p.name + ' => ' + body;
  }
  return '(' + params.map((p) => fmtParam(p, indent)).join(', ') + ') => ' + body;
}

function fmtLambdaBody(body, indent) {
  if (body && body.body && body.body.length === 1 && body.body[0].type === 'ExprStmt') {
    return fmtExpr(body.body[0].expr, 0, indent);
  }
  const parts = (body && body.body ? body.body : []).map((st) => fmtStmt(st, 0));
  return '{ ' + parts.join('; ') + ' }';
}

function fmtCompClauses(clauses, indent) {
  const out = [];
  for (const c of clauses) {
    if (c.k === 'for') out.push('for ' + fmtPattern(c.pattern) + ' in ' + fmtExpr(c.iter, 0, indent));
    else out.push('if ' + fmtExpr(c.cond, 0, indent));
  }
  return out.join(' ');
}

// --- patterns ---------------------------------------------------------------
function fmtPattern(p) {
  if (!p) return '_';
  switch (p.type) {
    case 'PWild': return '_';
    case 'PBind': return p.name;
    case 'PLit': return fmtLiteral(p.value);
    case 'PTuple': return '(' + p.items.map(fmtPattern).join(', ') + ')';
    case 'PArray': {
      const items = p.items.map(fmtPattern);
      if (p.rest) items.push('...' + p.rest);
      return '[' + items.join(', ') + ']';
    }
    case 'PRecord': {
      const parts = Object.entries(p.fields).map(([k, v]) =>
        (v.type === 'PBind' && v.name === k) ? k : k + ': ' + fmtPattern(v));
      if (p.rest) parts.push('...' + p.rest);
      return '{' + parts.join(', ') + '}';
    }
    case 'PVariant':
      return p.args && p.args.length ? p.name + '(' + p.args.map(fmtPattern).join(', ') + ')' : p.name;
    case 'POr': return p.options.map(fmtPattern).join(' | ');
    case 'PRest': return '...';
    default: throw new Error(`fmt: cannot format pattern node ${p.type}`);
  }
}

function fmtLiteral(v) {
  if (typeof v === 'string') return '"' + quoteText(v) + '"';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'number' && v < 0) return '-' + String(-v);
  return String(v);
}

// --- types ------------------------------------------------------------------
function fmtType(t) {
  if (!t) return 'Any';
  switch (t.type) {
    case 'TypeName':
      return t.name + (t.args && t.args.length ? '[' + t.args.map(fmtType).join(', ') + ']' : '');
    case 'TypeOpt': {
      const inner = fmtType(t.of);
      return t.of && t.of.type === 'TypeUnion' ? '(' + inner + ')?' : inner + '?';
    }
    case 'TypeList': return '[' + fmtType(t.of) + ']';
    case 'TypeTuple': return '(' + t.items.map(fmtType).join(', ') + ')';
    case 'TypeMap': return '[' + fmtType(t.key) + ': ' + fmtType(t.value) + ']';
    case 'TypeRecord':
      return '{' + t.fields.map((f) => f.name + (f.ann ? ': ' + fmtType(f.ann) : '')).join(', ') + '}';
    case 'TypeUnion': return typeUnionOptions(t).map(fmtType).join(' | ');
    case 'TypeFn': return '(' + t.params.map(fmtType).join(', ') + ') -> ' + fmtType(t.ret);
    default: throw new Error(`fmt: cannot format type node ${t.type}`);
  }
}

function typeUnionOptions(t) {
  if (t && t.type === 'TypeUnion') return [...typeUnionOptions(t.options[0]), ...typeUnionOptions(t.options[1])];
  return [t];
}
