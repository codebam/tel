// Independent end-to-end verification suite for Tel v0.1.
// Owner: verify-eng (task-4). Built from docs/PLAN.md + deliberate adversarial cases,
// NOT from examples. Tests that depend on not-yet-existing deliverables call t.skip.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Runtime } from '../src/interp.mjs';
import { parse, ParseError } from '../src/parser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'bin', 'tel.mjs');
const CLI_MOD = path.join(ROOT, 'src', 'cli.mjs');
const CODEGEN = path.join(ROOT, 'src', 'codegen.mjs');
const TOKCOUNT = path.join(ROOT, 'tools', 'tokcount.mjs');
const VOCAB = path.join(ROOT, 'tools', 'vocab', 'cl100k_base.tiktoken');
const EXAMPLES_DIR = path.join(ROOT, 'examples');

const hasCli = fs.existsSync(CLI) && fs.existsSync(CLI_MOD);
const hasCodegen = fs.existsSync(CODEGEN);
const hasTokcount = fs.existsSync(TOKCOUNT) && fs.existsSync(VOCAB);
const exampleFiles = fs.existsSync(EXAMPLES_DIR)
  ? fs.readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.tel')).sort().map((f) => path.join(EXAMPLES_DIR, f))
  : [];

const lines = (...ls) => ls.join('\n');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '');

// --- helpers ---------------------------------------------------------------
function pending(t, flag, dep) {
  if (!flag) { t.skip(`PENDING: ${dep}`); return true; }
  return false;
}

async function evalTel(src, opts = {}) {
  const rt = new Runtime({ args: opts.args ?? [] });
  const { value } = await rt.runSource(src, opts.file ? { file: opts.file } : {});
  return value;
}

// Run interpreter while capturing `print` output (core.print -> console.log).
async function runTel(src, opts = {}) {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.map((x) => String(x)).join(' '));
  try {
    const rt = new Runtime({ args: opts.args ?? [] });
    const r = await rt.runSource(src, opts.file ? { file: opts.file } : {});
    return { value: r.value, out: logs.join('\n') };
  } finally {
    console.log = orig;
  }
}

function spawnNode(args, opts = {}) {
  const r = spawnSync(process.execPath, args, {
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
    timeout: opts.timeout ?? 20000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    timedOut: r.error?.code === 'ETIMEDOUT',
    error: r.error,
  };
}
const runCli = (args, opts = {}) => spawnNode([CLI, ...args], opts);
const runNodeFile = (file, opts = {}) => spawnNode([file], opts);

function mkTmp(prefix = 'tel-verify-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function writeFile(dir, name, src) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, src);
  return p;
}

// ===========================================================================
// 1. Interpreter public API (Runtime + runSource/runFile)
// ===========================================================================

test('interp: arithmetic, precedence and unary operators', async () => {
  assert.equal(await evalTel('2 + 3 * 4'), 14);
  assert.equal(await evalTel('(2 + 3) * 4'), 20);
  assert.equal(await evalTel('2 ** 3 ** 2'), 512, '** must be right-associative');
  assert.equal(await evalTel('10 % 3 + 1'), 2);
  assert.equal(await evalTel('1 + 2 * 3 - 4 / 2'), 5);
  assert.equal(await evalTel('-3 + 5'), 2);
  assert.equal(await evalTel('!(1 == 2)'), true);
  assert.equal(await evalTel('not false'), true);
  assert.equal(await evalTel('1 < 2 and 3 >= 3'), true);
  assert.equal(await evalTel('false or 5'), 5);
});

test('interp: strings, escapes and {interpolation}', async () => {
  assert.equal(await evalTel('"a" + 1'), 'a1');
  assert.equal(await evalTel('1 + "a"'), '1a');
  assert.equal(await evalTel(lines('n = 3', '"n={n}!"')), 'n=3!');
  assert.equal(await evalTel('"sum={1 + 2}"'), 'sum=3');
  assert.equal(await evalTel('"a\\tb"'), 'a\tb');
  assert.equal(await evalTel('"quote: \\"x\\""'), 'quote: "x"');
  // Triple-quoted strings keep the first newline (Python-like).
  assert.equal(await evalTel(lines('s = """', 'line1', 'line2"""', 's')), '\nline1\nline2');
  assert.equal(await evalTel('"\\{"'), '{');
  assert.throws(() => parse('"{"'), /unterminated interpolation/);
});

test('interp: ambient mutable bindings and compound assignment', async () => {
  assert.equal(await evalTel(lines('x = 1', 'x += 2', 'x *= 3', 'x')), 9);
  assert.equal(await evalTel(lines('s = "a"', 's += "b"', 's')), 'ab');
  assert.equal(await evalTel(lines('x = 10', 'x -= 4', 'x /= 2', 'x')), 3);
  assert.equal(await evalTel(lines('x = 7', 'x %= 4', 'x')), 3);
});

test('interp: arrays, indexing, slices and records', async () => {
  assert.deepEqual(await evalTel('[1, 2, 3]'), [1, 2, 3]);
  assert.equal(await evalTel('[1, 2, 3][1]'), 2);
  assert.equal(await evalTel('[1, 2, 3][-1]'), 3);
  assert.equal(await evalTel('[1, 2, 3].len()'), 3);
  assert.deepEqual(await evalTel('[1, 2, 3].push(4)'), [1, 2, 3, 4]);
  assert.deepEqual(await evalTel('{a: 1, b: 2}'), { a: 1, b: 2 });
  assert.equal(await evalTel('{a: 1, b: 2}.b'), 2);
  assert.equal(await evalTel('{a: 1, b: 2}["a"]'), 1);
  // Slice syntax is in the parser and runtime; must not silently index by Range.
  assert.deepEqual(await evalTel(lines('xs = [10, 20, 30, 40]', 'xs[1..3]')), [20, 30]);
  assert.deepEqual(await evalTel(lines('xs = [10, 20, 30, 40]', 'xs[1..=3]')), [20, 30, 40]);
  assert.equal(await evalTel(lines('s = "hello"', 's[1..3]')), 'el');
});

test('interp: destructuring patterns (array/record/tuple/nested)', async () => {
  assert.equal(await evalTel(lines('[a, b] = [1, 2]', 'a + b')), 3);
  assert.equal(await evalTel(lines('{x, y} = {x: 3, y: 4}', 'x * y')), 12);
  assert.equal(await evalTel(lines('(p, q) = (5, 6)', 'p + q')), 11);
  assert.equal(await evalTel(lines('[a, ...rest] = [1, 2, 3]', 'a * 100 + rest.len()')), 102);
  assert.equal(await evalTel(lines('[a, [b, c]] = [1, [2, 3]]', 'a + b + c')), 6);
  assert.equal(await evalTel(lines('{p: {x, y}} = {p: {x: 2, y: 5}}', 'x * y')), 10);
});

test('interp: match with literals, or-patterns, guards and wildcard', async () => {
  const src = lines(
    'fn describe(n: Num) -> Str:',
    '  match n:',
    '    0: "zero"',
    '    1 | 2: "small"',
    '    x if x > 10: "big"',
    '    _: "other"',
    'print(describe(0), describe(2), describe(11), describe(5))',
  );
  const r = await runTel(src);
  assert.equal(r.out, 'zero small big other');
  assert.equal(await evalTel(lines('match 3:', '  1: "a"', '  2 | 3: "b"', '  _: "c"')), 'b');
});

test('interp: structural patterns (array with rest, tuple, record, variant)', async () => {
  assert.equal(await evalTel(lines('match [1, 2, 3]:', '  [a, ...rest]: a + rest.len()')), 3);
  assert.equal(await evalTel(lines('match [1, 2]:', '  [a, b]: a + b')), 3);
  assert.equal(await evalTel(lines('match (1, 2):', '  (a, b): a + b')), 3);
  assert.equal(await evalTel(lines('match 1:', '  (x): x')), 1, 'parenthesized single pattern groups (V11)');
  assert.equal(await evalTel(lines('match {x: 1, y: 2}:', '  {x, y}: x + y')), 3);
  const src = lines(
    'type Shape = Circle(r: Num) | Rect(w: Num, h: Num)',
    'fn area(s):',
    '  match s:',
    '    Circle(r): 3 * r * r',
    '    Rect(w, h): w * h',
    'area(Circle(2)) * 1000 + area(Rect(2, 5))',
  );
  assert.equal(await evalTel(src), 12010);
  assert.equal(await evalTel(lines(
    'type Shape = Circle(r: Num) | Rect(w: Num, h: Num)',
    'fn area(s):',
    '  match s:',
    '    Circle(r): 3 * r * r',
    '    Rect(w, h): w * h',
    'area(Circle(r=2)) * 1000 + area(Rect(w=2, h=5))',
  )), 12010);
});

test('interp: type declarations, named args and is', async () => {
  const src = lines(
    'type Point = {x: Num, y: Num}',
    'a = Point(y=2, x=1)',
    'b = Point(3, 4)',
    'a.x * 100 + a.y * 10 + b.x',
  );
  assert.equal(await evalTel(src), 123);
  assert.equal(await evalTel(lines('type Color = Red | Green | Blue', 'Red is Color')), true);
  assert.equal(await evalTel(lines('x = 3', 'x is Num')), true);
  assert.equal(await evalTel(lines('x = 3', 'x is Str')), false);
  assert.equal(await evalTel(lines('x = nil', 'x is Nil')), true);
});

test('interp: `_` shorthand lambdas and built-in UFCS methods', async () => {
  assert.equal(await evalTel(lines('xs = [1, 2, 3, 4]', 'xs.filter(_ > 1).map(_ * 10).sum()')), 90);
  assert.deepEqual(await evalTel('[1, 2, 3].map(_ * 2)'), [2, 4, 6]);
  assert.equal(await evalTel('"abc".upper()'), 'ABC');
  assert.deepEqual(await evalTel('[3, 1, 2].sort()'), [1, 2, 3]);
  assert.equal(await evalTel('"a,b,c".split(",").len()'), 3);
  assert.equal(await evalTel('(0 - 5).abs()'), 5);
  assert.equal(await evalTel('"  x  ".trim()'), 'x');
});

test('interp: user-defined UFCS method via Type.method(self)', async () => {
  const src = lines(
    'type Vec = {x: Num, y: Num}',
    'fn Vec.dot(self: Vec, o: Vec) -> Num = self.x * o.x + self.y * o.y',
    'a = Vec(1, 2)',
    'b = Vec(3, 4)',
    'a.dot(b)',
  );
  assert.equal(await evalTel(src), 11);
});

test('interp: ? propagation returns Err/Nil from a function', async () => {
  const src = lines(
    'fn half(n: Num):',
    '  if n % 2 == 1: return Err("odd")',
    '  Ok(n / 2)',
    'fn calc(n: Num):',
    '  v = half(n)?',
    '  v + 1',
    'print(calc(4))',
    'print(calc(5))',
  );
  const r = await runTel(src);
  assert.equal(r.out, lines('3', 'Err(odd)'));

  const srcNil = lines(
    'fn maybe(n: Num):',
    '  if n < 0: return nil',
    '  n',
    'fn plus100(n: Num):',
    '  v = maybe(n)?',
    '  v + 100',
    'print(plus100(5))',
    'print(plus100(-1))',
  );
  const rn = await runTel(srcNil);
  assert.equal(rn.out, lines('105', 'nil'));
});

test('interp: try/catch/throw and finally', async () => {
  assert.equal(await runTel(lines('try:', '  throw "boom"', 'catch e:', '  print("caught", e)')).then((r) => r.out), 'caught boom');
  assert.equal(await runTel(lines('try:', '  panic("oops")', 'catch e:', '  print(e.message)')).then((r) => r.out), 'oops', 'caught Error should expose .message (V8)');
  const src = lines(
    'calls = []',
    'fn f():',
    '  try:',
    '    throw Err("x")',
    '  catch e:',
    '    calls.push("caught:" + e)',
    '  finally:',
    '    calls.push("finally")',
    '  99',
    'print(f())',
    'print(calls)',
  );
  const r = await runTel(src);
  assert.equal(r.out, lines('99', '[caught:Err(x), finally]'));
});
test('interp: ranges, for loops and comprehensions', async () => {
  assert.equal(await evalTel(lines('total = 0', 'for i in 1..=5:', '  total += i', 'total')), 15);
  assert.equal(await evalTel('(1..=4).sum()'), 10);
  assert.deepEqual(await evalTel('[x * x for x in 1..=5 if x % 2 == 0]'), [4, 16]);
  assert.deepEqual(await evalTel('[y for x in [1, 2, 3] for y in [x, x * 10]]'), [1, 10, 2, 20, 3, 30]);
  assert.equal(await evalTel(lines('n = 0', 'for c in "abc":', '  n += 1', 'n')), 3);
});

test('interp: control flow if/elif/else, while/break, loop/continue', async () => {
  const grade = lines(
    'fn grade(n):',
    '  if n >= 90: "A"',
    '  elif n >= 80: "B"',
    '  else: "C"',
    'print(grade(95), grade(85), grade(10))',
  );
  assert.equal((await runTel(grade)).out, 'A B C');
  assert.equal(await evalTel(lines('i = 0', 'while true:', '  i += 1', '  if i >= 3: break', 'i')), 3);
  const loop = lines(
    'i = 0',
    'total = 0',
    'loop:',
    '  i += 1',
    '  if i % 2 == 0: continue',
    '  total += i',
    '  if i >= 5: break',
    'total',
  );
  assert.equal(await evalTel(loop), 9);
});

test('interp: recursion (incl. mutual) and closures', async () => {
  assert.equal(await evalTel(lines('fn fact(n: Num) -> Num:', '  if n <= 1: 1', '  else: n * fact(n - 1)', 'fact(5)')), 120);
  assert.equal(await evalTel(lines(
    'fn even(n): if n == 0: true else: odd(n - 1)',
    'fn odd(n): if n == 0: false else: even(n - 1)',
    'even(10)',
  )), true);
  const closure = lines(
    'fn counter():',
    '  c = 0',
    '  () => c += 1',
    'a = counter()',
    'b = counter()',
    'a()',
    'a()',
    'b()',
    'a() * 10 + b()',
  );
  assert.equal(await evalTel(closure), 32);
});

test('interp: explicit return exits a function with its value', async () => {
  assert.equal(await evalTel(lines('fn f():', '  return 5', 'f()')), 5);
  assert.equal(await evalTel(lines('fn f():', '  if true: return 5', '  9', 'f()')), 5);
  assert.equal(await evalTel(lines('fn f():', '  for i in 1..=3:', '    if i == 2: return i', '  0', 'f()')), 2);
});

test('interp: ?? fallback and ??= ', async () => {
  assert.equal(await evalTel('nil ?? 5'), 5);
  assert.equal(await evalTel('Err("x") ?? 7'), 7);
  assert.equal(await evalTel('Ok(9) ?? 11'), 9);
  assert.equal(await evalTel('0 ?? 3'), 0);
  assert.equal(await evalTel('"" ?? "fallback"'), '');
  assert.equal(await evalTel(lines('x = nil', 'x ??= 9', 'x')), 9);
  assert.equal(await evalTel(lines('y = 1', 'y ??= 9', 'y')), 1);
});

test('interp: optional member access and calls', async () => {
  assert.equal(await evalTel(lines('r = nil', 'r?.name')), null);
  assert.equal(await evalTel('{a: 1}?.a'), 1);
  assert.equal(await evalTel(lines('r = nil', 'r?.upper()')), null);
});

test('interp: async/await and runFile async main', async () => {
  const src = lines(
    'async fn work():',
    '  await time.sleep(5)',
    '  42',
    'await work()',
  );
  assert.equal(await evalTel(src), 42);

  const dir = mkTmp('tel-async-');
  const file = writeFile(dir, 'main.tel', lines(
    'async fn main(a):',
    '  await time.sleep(5)',
    '  a.len()',
  ));
  const rt = new Runtime({});
  const r = await rt.runFile(file, { args: ['x', 'y', 'z'] });
  assert.equal(r.mainResult, 3);
});

test('interp: Runtime({args}) exposes args and runFile calls main(args)', async () => {
  assert.deepEqual(await evalTel('args', { args: ['a', 'b'] }), ['a', 'b']);
  const dir = mkTmp('tel-main-');
  const file = writeFile(dir, 'main.tel', lines(
    'fn main(a):',
    '  a.len()',
  ));
  const r = await new Runtime({}).runFile(file, { args: ['x', 'y'] });
  assert.equal(r.mainResult, 2);
  assert.ok(r.env.lookup('main').found, 'runFile should keep main in its env');
});

test('interp: import graph via runFile (relative module + std namespace)', async () => {
  const dir = mkTmp('tel-import-');
  writeFile(dir, 'lib.tel', lines(
    'pub fn add(a: Num, b: Num) -> Num = a + b',
    'pub fn greet(name: Str) -> Str = "hi " + name',
    'pub type Vec = {x: Num, y: Num}',
    'fn hidden(): "nope"',
  ));
  const main = writeFile(dir, 'main.tel', lines(
    'import "./lib.tel" as lib',
    'import std.math as m',
    'lib.add(1, 2)',
  ));
  const rt = new Runtime({});
  const r = await rt.runFile(main);
  assert.equal(r.mainResult, 3);
  assert.equal(r.env.get('lib').greet('x'), 'hi x');
  assert.equal(r.env.get('lib').Vec(1, 2).x, 1, 'pub type must be exported (V6)');
  assert.equal(await evalTel(lines('import std.math as m', 'm.floor(2.9)')), 2);
});

test('interp: empty/comment-only programs are valid and yield nil', async () => {
  assert.equal(await evalTel(''), null);
  assert.equal(await evalTel(lines('', '# just a comment', '   # indented comment', '')), null);
  // Block comments are a lexer feature; a multi-line #[ ... ]# must not be parsed as code.
  assert.equal(await evalTel(lines('#[ block', 'comment ]#', 'x = 1', 'x')), 1);
});

test('interp: deep but valid nesting does not hang or crash', async () => {
  const depth = 300;
  const src = 'x = ' + '('.repeat(depth) + '1' + ')'.repeat(depth) + '\nx';
  assert.equal(await evalTel(src), 1);
  const chain = Array.from({ length: 200 }, () => '1').join(' + ');
  assert.equal(await evalTel(chain), 200);
});

test('interp: division by zero is deterministic (Infinity, no hang)', async () => {
  assert.equal(await evalTel('1 / 0'), Infinity);
  assert.equal(await evalTel('-1 / 0'), -Infinity);
});

test('interp: parse errors carry numeric line/col', async () => {
  for (const bad of ['fn f(a:\n', 'x = (1 + \n', 'x = = 1', 'if true\n  x = 1']) {
    assert.throws(() => parse(bad), (e) => {
      assert.ok(e instanceof ParseError, `expected ParseError for ${JSON.stringify(bad)}, got ${e?.name}: ${e?.message}`);
      assert.ok(Number.isInteger(e.line) && e.line >= 1, `line missing for ${JSON.stringify(bad)}`);
      assert.ok(Number.isInteger(e.col) && e.col >= 1, `col missing for ${JSON.stringify(bad)}`);
      return true;
    });
  }
});

test('interp: runtime errors carry file/line/col location', async () => {
  await assert.rejects(
    evalTel('x = missing_name', { file: path.join(ROOT, 'missing.tel') }),
    (e) => {
      assert.equal(e.name, 'TelRuntimeError');
      assert.match(e.message, /undefined name 'missing_name'/);
      assert.ok(e.loc && Number.isInteger(e.loc.line) && Number.isInteger(e.loc.col),
        `runtime error loc should be {line,col}, got ${JSON.stringify(e.loc)}`);
      assert.equal(e.loc.line, 1);
      assert.equal(e.loc.col, 5);
      return true;
    },
  );
});

test('interp: match with no matching arm is a clean located error', async () => {
  await assert.rejects(evalTel(lines('match 3:', '  1: 1')), (e) => {
    assert.match(String(e.message), /no arm matched/);
    assert.ok(e.loc && Number.isInteger(e.loc.line), `no-arm error needs a line, got ${JSON.stringify(e.loc)}`);
    return true;
  });
});

test('interp: top-level ? must not leak the internal Early object', async () => {
  let resolved = false;
  let failure = null;
  try {
    const v = await evalTel(lines('r = Err("x")?', 'r'));
    resolved = true;
    void v;
  } catch (e) {
    failure = e;
  }
  if (failure !== null) {
    assert.notEqual(failure?.constructor?.name, 'Early', 'internal Early escaped to the caller');
    assert.equal(typeof failure?.message, 'string');
    assert.ok(failure.message.length > 0, 'error must carry a message');
    assert.ok(failure instanceof Error, 'top-level ? must reject with an Error, not a bare object');
  }
  void resolved;
});
// ===========================================================================
// 2. CLI surface
// ===========================================================================

test('cli: --version and help', (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  const v = runCli(['--version']);
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, new RegExp(pkg.version.replace(/\./g, '\\.')));
  const h = runCli(['help']);
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, /run/);
  assert.match(h.stdout, /build/);
  assert.match(h.stdout, /eval/);
});

test('cli: run executes a file and exits 0', (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  const dir = mkTmp('tel-cli-run-');
  const file = writeFile(dir, 'ok.tel', lines('print("hello")', 'print(1 + 2)'));
  const r = runCli(['run', file]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'hello\n3\n');
  assert.equal(r.stderr, '');
});

test('cli: run passes args after -- to main', (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  const dir = mkTmp('tel-cli-args-');
  const file = writeFile(dir, 'args.tel', lines('fn main(a):', '  print(a)'));
  const r = runCli(['run', file, '--', 'x', 'y']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '[x, y]');
});

test('cli: eval and -e print a result', (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  for (const args of [['eval', '2 + 3'], ['-e', '2 + 3']]) {
    const r = runCli(args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), '5');
  }
});

test('cli: fmt is a semantic-preserving round-trip and --write is idempotent', (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  const dir = mkTmp('tel-cli-fmt-');
  const messy = writeFile(dir, 'messy.tel', lines(
    '# a comment',
    'x   =   1+2',
    'fn  f( a: Num,b:Num )->Num:   a*b',
    'print(   f(x,4)   )',
  ));
  const before = runCli(['run', messy]);
  assert.equal(before.status, 0, before.stderr);

  const formatted = runCli(['fmt', messy]);
  assert.equal(formatted.status, 0, formatted.stderr);
  const formattedFile = writeFile(dir, 'formatted.tel', formatted.stdout);
  const after = runCli(['run', formattedFile]);
  assert.equal(after.status, 0, after.stderr);
  assert.equal(after.stdout, before.stdout, 'fmt changed program semantics');

  const first = runCli(['fmt', '--write', messy]);
  assert.equal(first.status, 0, first.stderr);
  const content1 = fs.readFileSync(messy, 'utf8');
  const second = runCli(['fmt', '--write', messy]);
  assert.equal(second.status, 0, second.stderr);
  const content2 = fs.readFileSync(messy, 'utf8');
  assert.equal(content2, content1, 'fmt --write is not idempotent');
});

test('cli: tokens counts match the tokenizer (hello world => 2)', async (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  const dir = mkTmp('tel-cli-tokens-');
  const file = writeFile(dir, 't.txt', 'hello world');
  const r = runCli(['tokens', file, '--json']);
  assert.equal(r.status, 0, r.stderr);
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { assert.fail(`tokens --json is not JSON: ${r.stdout}`); }
  const rec = Array.isArray(parsed) ? parsed[0] : (parsed.files?.[0] ?? parsed[0] ?? parsed);
  assert.equal(Number(rec.tokens), 2, `unexpected tokens record: ${r.stdout}`);
  if (hasTokcount) {
    const tok = await import(pathToFileURL(TOKCOUNT).href);
    assert.equal(tok.countTokens('hello world'), 2);
  }
});

test('cli: parse errors print file:line:col + caret and exit 1', (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  const dir = mkTmp('tel-cli-bad-');
  const file = writeFile(dir, 'bad.tel', 'x = (1 + \n');
  const r = runCli(['run', file]);
  assert.notEqual(r.status, 0, 'parse error must exit non-zero');
  assert.equal(r.status, 1);
  const err = stripAnsi(r.stderr + r.stdout);
  assert.match(err, new RegExp(escapeRe(file) + ':\\d+:\\d+:'), 'error must include file:line:col');
  assert.match(err, /\^/, 'error must include a caret line when source is known');
});

test('cli: runtime errors print file:line:col and exit 1', (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  const dir = mkTmp('tel-cli-rt-');
  const file = writeFile(dir, 'rt.tel', 'x = missing_name\n');
  const r = runCli(['run', file]);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
  const err = stripAnsi(r.stderr + r.stdout);
  assert.match(err, /undefined name 'missing_name'/);
  assert.match(err, new RegExp(escapeRe(file) + ':\\d+:\\d+:'), `runtime error lacks file:line:col:\n${err}`);
});

test('cli: missing files and unknown flags exit 2', (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  const missing = runCli(['run', path.join(os.tmpdir(), 'definitely-not-tel-xyz.tel')]);
  assert.equal(missing.status, 2, `missing file should exit 2, got ${missing.status}: ${missing.stderr}`);
  const unknown = runCli(['--definitely-unknown']);
  assert.equal(unknown.status, 2, `unknown flag should exit 2, got ${unknown.status}: ${unknown.stderr}`);
});

test('cli: check reports valid files 0 and bad files 1 with location', (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  const dir = mkTmp('tel-cli-check-');
  const good = writeFile(dir, 'good.tel', lines('fn add(a: Num, b: Num) -> Num = a + b', 'print(add(1, 2))'));
  const ok = runCli(['check', good]);
  assert.equal(ok.status, 0, ok.stderr);
  const bad = writeFile(dir, 'bad.tel', 'x = (\n');
  const no = runCli(['check', bad]);
  assert.equal(no.status, 1, no.stderr);
  assert.match(stripAnsi(no.stderr + no.stdout), new RegExp(escapeRe(bad) + ':\\d+:\\d+:'));
});

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ===========================================================================
// 3. Adversarial CLI / robustness
// ===========================================================================

test('adversarial: malformed programs fail fast with located errors (no hang)', (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  const dir = mkTmp('tel-adv-bad-');
  const cases = {
    'unbalanced.tel': 'x = (1 + \n',
    'unterminated-string.tel': 's = "oops\n',
    'bad-indent.tel': 'x = 1\n  y = 2\n',
    'double-equals.tel': 'x = = 1\n',
    'lone-bracket.tel': 'print(]\n',
    'bad-fn.tel': 'fn (:\n  x\n',
    'bad-block-comment.tel': '#[ never closed\n',
  };
  for (const [name, src] of Object.entries(cases)) {
    const file = writeFile(dir, name, src);
    const r = runCli(['run', file], { timeout: 8000 });
    assert.ok(!r.timedOut, `CLI hung on malformed ${name}`);
    assert.notEqual(r.status, 0, `CLI should reject malformed ${name}, stdout=${JSON.stringify(r.stdout)}`);
    const err = stripAnsi(r.stderr + r.stdout);
    assert.match(err, new RegExp(escapeRe(file) + ':\\d+:\\d+:'), `${name} error lacks file:line:col:\n${err}`);
  }
});

test('adversarial: empty file exits cleanly, deep nesting still runs', (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  const dir = mkTmp('tel-adv-ok-');
  const empty = writeFile(dir, 'empty.tel', '');
  const r0 = runCli(['run', empty], { timeout: 8000 });
  assert.ok(!r0.timedOut);
  assert.equal(r0.status, 0, r0.stderr);
  assert.equal(r0.stdout, '');

  const depth = 500;
  const deep = writeFile(dir, 'deep.tel', 'x = ' + '('.repeat(depth) + '1' + ')'.repeat(depth) + '\nprint(x)\n');
  const r1 = runCli(['run', deep], { timeout: 10000 });
  assert.ok(!r1.timedOut, 'deep nesting hung');
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r1.stdout.trim(), '1');

  const chain = writeFile(dir, 'chain.tel', 'print(' + Array.from({ length: 300 }, () => '1').join(' + ') + ')\n');
  const r2 = runCli(['run', chain], { timeout: 10000 });
  assert.ok(!r2.timedOut);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(r2.stdout.trim(), '300');
});

test('adversarial: undefined identifier is a located runtime error', (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  const dir = mkTmp('tel-adv-undef-');
  const file = writeFile(dir, 'undef.tel', 'x = missing_name\n');
  const r = runCli(['run', file], { timeout: 8000 });
  assert.ok(!r.timedOut);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
  const err = stripAnsi(r.stderr + r.stdout);
  assert.match(err, /undefined name 'missing_name'/);
  assert.match(err, new RegExp(escapeRe(file) + ':1:5:'), `undefined-name error lacks file:1:5:\n${err}`);
  assert.doesNotMatch(err, /undefined: undefined/);
});

test('adversarial: match with no arm is a clean located fatal error', (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  const dir = mkTmp('tel-adv-match-');
  const file = writeFile(dir, 'nomatch.tel', lines('match 3:', '  1: print("one")'));
  const r = runCli(['run', file], { timeout: 8000 });
  assert.ok(!r.timedOut);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
  const err = stripAnsi(r.stderr + r.stdout);
  assert.match(err, /no arm matched/);
  assert.match(err, new RegExp(escapeRe(file) + ':\\d+:\\d+:'), `no-arm error lacks file:line:col:\n${err}`);
  assert.doesNotMatch(err, /undefined: undefined/);
});

test('adversarial: divide by zero and wrong arity terminate', (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  const dir = mkTmp('tel-adv-num-');
  const div = writeFile(dir, 'div.tel', 'print(1 / 0)\n');
  const rd = runCli(['run', div], { timeout: 8000 });
  assert.ok(!rd.timedOut, '1/0 hung');
  const divOk = rd.status === 0 && rd.stdout.trim() === 'Infinity';
  const divErr = rd.status === 1 && new RegExp(escapeRe(div) + ':\\d+:\\d+:').test(stripAnsi(rd.stderr + rd.stdout)) && /zero|division/i.test(rd.stderr);
  assert.ok(divOk || divErr, `1/0 should be Infinity (JS semantics) or a located clean error; got status=${rd.status} stdout=${JSON.stringify(rd.stdout)} stderr=${JSON.stringify(rd.stderr)}`);

  const wrong = writeFile(dir, 'wrongarity.tel', lines('xs = [1, 2, 3]', 'xs.map()'));
  const rw = runCli(['run', wrong], { timeout: 8000 });
  assert.ok(!rw.timedOut, 'wrong arity hung');
  assert.notEqual(rw.status, 0, 'wrong arity should fail');
  const werr = stripAnsi(rw.stderr + rw.stdout);
  assert.match(werr, /not a function|not callable|expected/i, `unhelpful wrong-arity error:\n${werr}`);
  assert.doesNotMatch(werr, /undefined: undefined/);

  const notfn = writeFile(dir, 'notfn.tel', lines('x = 3', 'x()'));
  const rn = runCli(['run', notfn], { timeout: 8000 });
  assert.ok(!rn.timedOut);
  assert.equal(rn.status, 1);
  assert.match(stripAnsi(rn.stderr + rn.stdout), /not a function/);
});

// ===========================================================================
// 4. Compiler: Tel -> standalone JS / web
// ===========================================================================

const PARITY_PROGRAMS = {
  basics: lines(
    'name = "tel"',
    'count = 2',
    'count += 3',
    'print(name + " " + str(count))',
    'print(2 + 3 * 4)',
    'print((2 + 3) * 4)',
    'print(2 ** 3 ** 2)',
    'print("sum={1 + 2}")',
  ),
  control: lines(
    'total = 0',
    'for i in 1..=5:',
    '  if i % 2 == 0: continue',
    '  total += i',
    'print(total)',
    'n = 0',
    'while n < 3:',
    '  n += 1',
    'print(n)',
    'for i in 1..=5:',
    '  if i % 15 == 0: print("FizzBuzz")',
    '  elif i % 3 == 0: print("Fizz")',
    '  elif i % 5 == 0: print("Buzz")',
    '  else: print(i)',
  ),
  collections: lines(
    'xs = [4, 1, 3, 2]',
    'print(xs.sort())',
    'print(xs.filter(_ > 1).map(_ * 10).sum())',
    'print("abc".upper())',
    'r = {name: "x", n: 2}',
    'print(r.name, r["n"] + 1)',
    'print([x * x for x in 1..=5 if x % 2 == 0])',
  ),
  patterns: lines(
    'type Point = {x: Num, y: Num}',
    'p = Point(y=2, x=1)',
    'fn label(v):',
    '  match v:',
    '    {x, y} if x > y: "x"',
    '    {x, y}: "y"',
    'print(label(p))',
    'type Shape = Circle(r: Num) | Rect(w: Num, h: Num)',
    'fn area(s):',
    '  match s:',
    '    Circle(r): 3 * r * r',
    '    Rect(w, h): w * h',
    'print(area(Circle(2)))',
    'print(area(Rect(2, 5)))',
  ),
  functions: lines(
    'fn fact(n: Num):',
    '  if n <= 1: 1',
    '  else: n * fact(n - 1)',
    'print(fact(5))',
    'fn counter():',
    '  c = 0',
    '  () => c += 1',
    'inc = counter()',
    'inc()',
    'inc()',
    'print(inc())',
  ),
  recordtag: lines(
    'type P = {x: Num, y: Num}',
    'print(P(x=4, y=5) is P)',
    'print(P(1, 2) is P)',
    'print(P() is P)',
  ),
  propagation: lines(
    'fn half(n: Num):',
    '  if n % 2 == 1: return Err("odd")',
    '  Ok(n / 2)',
    'fn calc(n: Num):',
    '  v = half(n)?',
    '  v + 1',
    'print(calc(4))',
    'print(calc(5))',
    'try:',
    '  throw "boom"',
    'catch e:',
    '  print("caught", e)',
    'print(nil ?? 5)',
  ),
};

test('compiler: js target builds, node runs it and stdout matches interpreter', { timeout: 240000 }, (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  if (pending(t, hasCodegen, 'task-3')) return;
  const dir = mkTmp('tel-parity-');
  for (const [name, src] of Object.entries(PARITY_PROGRAMS)) {
    const file = writeFile(dir, `${name}.tel`, src + '\n');
    const interp = runCli(['run', file], { timeout: 30000 });
    assert.equal(interp.status, 0, `interpreter failed for ${name}: ${interp.stderr}`);

    const out = path.join(dir, `${name}.mjs`);
    const build = runCli(['build', file, '--target', 'js', '-o', out], { timeout: 30000 });
    assert.equal(build.status, 0, `build failed for ${name}: ${build.stderr}`);
    assert.ok(fs.existsSync(out), `no output written for ${name}`);

    const syntax = spawnNode(['--check', out]);
    assert.equal(syntax.status, 0, `generated ${name}.mjs is not valid JS: ${syntax.stderr}`);

    const run = runNodeFile(out, { timeout: 30000 });
    assert.ok(!run.timedOut, `compiled ${name} hung`);
    assert.equal(run.status, 0, `compiled ${name} exited ${run.status}: ${run.stderr}`);
    assert.equal(run.stdout, interp.stdout, `${name}: compiled stdout != interpreted stdout`);
    assert.doesNotMatch(run.stderr, /is not defined/, `${name}: leaked unresolved runtime name:\n${run.stderr}`);
    assert.doesNotMatch(run.stderr, /\b(__|undefined)\b.*is not defined/, `${name}: unresolved __ runtime name:\n${run.stderr}`);
  }
});

test('compiler: generated JS is self-contained (only relative + node: imports)', { timeout: 60000 }, (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  if (pending(t, hasCodegen, 'task-3')) return;
  const dir = mkTmp('tel-standalone-');
  const file = writeFile(dir, 'prog.tel', lines(
    'type Shape = Circle(r: Num) | Rect(w: Num, h: Num)',
    'fn area(s):',
    '  match s:',
    '    Circle(r): r * r',
    '    Rect(w, h): w * h',
    'print(area(Circle(3)))',
    'print([x for x in 1..=3])',
  ));
  const out = path.join(dir, 'prog.mjs');
  const build = runCli(['build', file, '--target', 'js', '-o', out]);
  assert.equal(build.status, 0, build.stderr);
  const text = fs.readFileSync(out, 'utf8');
  const specs = [...text.matchAll(/^\s*import\s+[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  for (const spec of specs) {
    assert.ok(spec.startsWith('.') || spec.startsWith('node:'), `unexpected non-standalone import ${spec}`);
    if (spec.startsWith('.')) {
      const resolved = path.resolve(path.dirname(out), spec);
      assert.ok(!resolved.startsWith(path.join(ROOT, 'runtime')) && !resolved.startsWith(path.join(ROOT, 'src')),
        `generated code still imports project sources: ${spec}`);
    }
  }
  assert.doesNotMatch(text, /from\s+['"][^'"]*\/(src|runtime)\//, 'generated code references project source paths');
});

test('compiler: multi-file import graph builds and executes', { timeout: 120000 }, (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  if (pending(t, hasCodegen, 'task-3')) return;
  const dir = mkTmp('tel-multifile-');
  writeFile(dir, 'lib.tel', lines(
    'pub fn add(a: Num, b: Num) -> Num = a + b',
    'pub fn square(n: Num) -> Num = n * n',
  ));
  const main = writeFile(dir, 'main.tel', lines(
    'import "./lib.tel" as lib',
    'print(lib.add(2, 3))',
    'print(lib.square(4))',
  ));
  const outdir = path.join(dir, 'dist');
  const build = runCli(['build', main, '--target', 'js', '--outdir', outdir], { timeout: 30000 });
  assert.equal(build.status, 0, build.stderr);
  assert.ok(fs.existsSync(outdir), 'outdir not created');
  const emitted = fs.readdirSync(outdir).filter((f) => f.endsWith('.mjs'));
  const entry = emitted.find((f) => /^main(\.|$)/.test(f)) ?? emitted.find((f) => f.includes('main')) ?? emitted[0];
  assert.ok(entry, `no emitted entry module in ${outdir}: ${JSON.stringify(emitted)}`);

  const interp = runCli(['run', main], { timeout: 30000 });
  assert.equal(interp.status, 0, interp.stderr);
  const run = runNodeFile(path.join(outdir, entry), { timeout: 30000 });
  assert.ok(!run.timedOut, 'multi-file compiled program hung');
  assert.equal(run.status, 0, `multi-file output failed: ${run.stderr}`);
  assert.equal(run.stdout, interp.stdout, 'multi-file compiled stdout != interpreted stdout');
  assert.doesNotMatch(run.stderr, /is not defined/, run.stderr);
});

test('compiler: --quiet build writes output without chatter', (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  if (pending(t, hasCodegen, 'task-3')) return;
  const dir = mkTmp('tel-quiet-');
  const file = writeFile(dir, 'q.tel', 'print(1 + 1)\n');
  const out = path.join(dir, 'q.mjs');
  const r = runCli(['build', file, '--target', 'js', '--quiet', '-o', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', `--quiet should not print stdout: ${JSON.stringify(r.stdout)}`);
  assert.ok(fs.existsSync(out));
});

test('compiler: web target exports __tel and SSR renders without a document', { timeout: 120000 }, async (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  if (pending(t, hasCodegen, 'task-3')) return;
  const dir = mkTmp('tel-web-');
  const file = writeFile(dir, 'web.tel', lines(
    'web fn App():',
    '  div(class="app", h1("hi"))',
  ));
  const out = path.join(dir, 'web.mjs');
  const build = runCli(['build', file, '--target', 'web', '-o', out], { timeout: 30000 });
  assert.equal(build.status, 0, build.stderr);
  const url = pathToFileURL(out).href + `?v=${Date.now()}`;
  const mod = await import(url);
  assert.equal(typeof mod.__tel, 'object', 'web build must export __tel');
  assert.equal(typeof mod.__tel.html, 'function', '__tel.html must exist for SSR');
  assert.equal(typeof mod.App, 'function', 'web build must export top-level App');
  assert.equal(mod.__tel.html(mod.App()), '<div class="app"><h1>hi</h1></div>');

  const counterFile = writeFile(dir, 'counter.tel', lines(
    'web fn Counter():',
    '  n = 0',
    '  div(class="c", button(onclick=() => n += 1, "count {n}"))',
  ));
  const counterOut = path.join(dir, 'counter.mjs');
  const b2 = runCli(['build', counterFile, '--target', 'web', '-o', counterOut], { timeout: 30000 });
  assert.equal(b2.status, 0, b2.stderr);
  const m2 = await import(pathToFileURL(counterOut).href + `?v=${Date.now()}`);
  assert.equal(m2.__tel.html(m2.Counter()), '<div class="c"><button>count 0</button></div>');
});

test('compiler: build rejects malformed input with location and nonzero exit', (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  if (pending(t, hasCodegen, 'task-3')) return;
  const dir = mkTmp('tel-build-bad-');
  const bad = writeFile(dir, 'bad.tel', 'x = (1 + \n');
  const out = path.join(dir, 'bad.mjs');
  const r = runCli(['build', bad, '--target', 'js', '-o', out], { timeout: 15000 });
  assert.ok(!r.timedOut, 'build hung on malformed input');
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
  assert.match(stripAnsi(r.stderr + r.stdout), new RegExp(escapeRe(bad) + ':\\d+:\\d+:'));
});

// ===========================================================================
// 5. Examples end to end
// ===========================================================================

// Examples that are servers/watchers and are expected to keep running.
const NON_TERMINATING_EXAMPLES = new Set(['server.tel']);
// Examples whose emit target is web-only (no Node js run).
const WEB_TARGET_EXAMPLES = new Set(['web.tel']);

test('examples: interpreter runs every example', { timeout: 300000 }, (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  if (!exampleFiles.length) { t.skip('PENDING: task-2'); return; }
  for (const file of exampleFiles) {
    const base = path.basename(file);
    const r = runCli(['run', file], { timeout: NON_TERMINATING_EXAMPLES.has(base) ? 5000 : 30000 });
    if (NON_TERMINATING_EXAMPLES.has(base)) {
      assert.ok(r.timedOut || r.status === 0, `${base} crashed instead of starting: ${r.stderr}`);
      continue;
    }
    assert.ok(!r.timedOut, `${base} hung under interpreter`);
    assert.equal(r.status, 0, `${base} failed:\n${r.stderr}`);
  }
});

test('examples: each terminating example compiles to js with identical stdout', { timeout: 300000 }, (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  if (!exampleFiles.length) { t.skip('PENDING: task-2'); return; }
  if (pending(t, hasCodegen, 'task-3')) return;
  const dir = mkTmp('tel-examples-');
  for (const file of exampleFiles) {
    const base = path.basename(file);
    if (NON_TERMINATING_EXAMPLES.has(base) || WEB_TARGET_EXAMPLES.has(base)) continue;
    const interp = runCli(['run', file], { timeout: 30000 });
    assert.ok(!interp.timedOut, `${base} hung under interpreter`);
    assert.equal(interp.status, 0, `${base} failed under interpreter:\n${interp.stderr}`);

    const out = path.join(dir, `${base}.mjs`);
    const build = runCli(['build', file, '--target', 'js', '-o', out], { timeout: 30000 });
    assert.equal(build.status, 0, `${base} build failed:\n${build.stderr}`);
    const run = runNodeFile(out, { timeout: 30000 });
    assert.ok(!run.timedOut, `compiled ${base} hung`);
    assert.equal(run.status, 0, `compiled ${base} failed:\n${run.stderr}`);
    assert.equal(run.stdout, interp.stdout, `compiled ${base} stdout differs from interpreter`);
    assert.doesNotMatch(run.stderr, /is not defined/, `compiled ${base} leaked runtime name:\n${run.stderr}`);
  }
});

// ===========================================================================
// 6. Token counting
// ===========================================================================

test('tokcount: hand-checked cl100k token counts and countFiles metadata', async (t) => {
  if (pending(t, hasTokcount, 'task-2')) return;
  const tok = await import(pathToFileURL(TOKCOUNT).href + `?v=${Date.now()}`);
  // Independent identity check against the shipped rank table: known cl100k ids.
  const byRank = new Map();
  for (const line of fs.readFileSync(VOCAB, 'utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    byRank.set(Number(line.slice(sp + 1)), Buffer.from(line.slice(0, sp), 'base64').toString('utf8'));
  }
  assert.equal(byRank.get(15339), 'hello');
  assert.equal(byRank.get(1917), ' world');
  assert.equal(byRank.get(9906), 'Hello');

  assert.equal(tok.countTokens(''), 0);
  assert.equal(tok.countTokens('hello'), 1);
  assert.equal(tok.countTokens('hello world'), 2);
  assert.equal(tok.countTokens('Hello world'), 2, 'Hello(9906) + " world"(1917)');

  const dir = mkTmp('tel-tok-');
  const file = writeFile(dir, 'hw.txt', 'hello world');
  const [rec] = tok.countFiles([file]);
  assert.equal(rec.path, file);
  assert.equal(rec.chars, 11);
  assert.equal(rec.bytes, 11);
  assert.equal(rec.tokens, 2);
});

test('tokcount: docs/TOKENS.md claims reproduce for examples tables', async (t) => {
  const doc = path.join(ROOT, 'docs', 'TOKENS.md');
  if (!fs.existsSync(doc)) { t.skip('PENDING: task-2'); return; }
  if (pending(t, hasTokcount, 'task-2')) return;
  const tok = await import(pathToFileURL(TOKCOUNT).href + `?v=${Date.now()}`);
  const text = fs.readFileSync(doc, 'utf8');
  // Match markdown table rows that name an examples/*.tel file and give chars/bytes/tokens.
  const rowRe = /\|\s*`?(examples\/[A-Za-z0-9_./-]+\.tel)`?\s*\|\s*(\d[\d,]*)\s*\|\s*(\d[\d,]*)\s*\|\s*(\d[\d,]*)\s*\|/g;
  let m;
  let checked = 0;
  while ((m = rowRe.exec(text)) !== null) {
    const rel = m[1];
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const n = (s) => Number(s.replace(/,/g, ''));
    const [rec] = tok.countFiles([abs]);
    assert.equal(rec.chars, n(m[2]), `${rel}: chars claim in TOKENS.md`);
    assert.equal(rec.bytes, n(m[3]), `${rel}: bytes claim in TOKENS.md`);
    assert.equal(rec.tokens, n(m[4]), `${rel}: tokens claim in TOKENS.md`);
    checked++;
  }
  assert.ok(checked > 0, 'TOKENS.md has no recognizable examples/*.tel chars/bytes/tokens rows to verify');
});

// ===========================================================================
// 7. v0.2 feature probes (used to skip genuinely missing deliverables)
// ===========================================================================

const CHECKER = path.join(ROOT, 'src', 'check.mjs');
const AGENT_GUIDE = path.join(ROOT, 'docs', 'AGENT-GUIDE.md');
const AGENTS_MD = path.join(ROOT, 'AGENTS.md');
const hasChecker = fs.existsSync(CHECKER);
const hasAgentGuide = fs.existsSync(AGENT_GUIDE);
const hasAgentsMd = fs.existsSync(AGENTS_MD);

let _v02 = null;
async function v02() {
  if (_v02) return _v02;
  const f = { newExpr: false, jsImportKind: false, tsTarget: false };
  try {
    f.newExpr = parseExpression('new Date(0)')?.type === 'New';
  } catch { /* not yet */ }
  try {
    const p = parse(lines('import "node:path" as path', 'path.join("a", "b")'));
    f.jsImportKind = p.body?.[0]?.kind === 'js';
  } catch { /* not yet */ }
  if (hasCodegen) {
    try {
      const { compileProgram } = await import(pathToFileURL(CODEGEN).href);
      const out = compileProgram(parse('print(1)'), { target: 'ts' });
      f.tsTarget = typeof out === 'string' && /tel_runtime/.test(out) && !/@ts-nocheck/.test(out);
    } catch { /* not yet */ }
  }
  _v02 = f;
  return f;
}

async function interopRuntimeReady() {
  try {
    const rt = new Runtime({});
    const a = await rt.runSource(lines('import "node:path" as path', 'path.join("a", "b")'));
    const b = await rt.runSource(lines('d = new Date(0)', 'd.getTime()'));
    return a.value === 'a/b' && b.value === 0;
  } catch {
    return false;
  }
}

function walkDir(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkDir(p));
    else out.push(p);
  }
  return out;
}

function telFences(md) {
  const out = [];
  const re = /```tel[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(md)) !== null) out.push(m[1]);
  return out;
}

const hasTsc = (() => {
  try { return spawnSync('tsc', ['--version'], { encoding: 'utf8' }).status === 0; }
  catch { return false; }
})();

// ===========================================================================
// 8. New in v0.2: tel check
// ===========================================================================

test('v0.2 check: catches static errors with file:line:col + caret', (t) => {
  if (pending(t, hasCli && hasChecker, 'task-1 (checker)')) return;
  const dir = mkTmp('tel-check-bad-');
  const cases = {
    'undefined-name.tel': lines('x = nope + 1'),
    'wrong-arity.tel': lines('fn add(a, b): a + b', 'print(add(1))'),
    'too-many-args.tel': lines('fn add(a, b): a + b', 'add(1, 2, 3)'),
    'break-outside.tel': lines('break'),
    'continue-outside.tel': lines('continue'),
    'duplicate-param.tel': lines('fn f(a, a): a', 'print(f(1, 2))'),
    'return-outside.tel': lines('return 1'),
  };
  const keyword = {
    'undefined-name.tel': /undefined|nope|not defined/i,
    'wrong-arity.tel': /argument|arity|expected|parameter/i,
    'too-many-args.tel': /argument|arity|expected|parameter/i,
    'break-outside.tel': /break/i,
    'continue-outside.tel': /continue/i,
    'duplicate-param.tel': /duplicate|already|redeclar|shadow/i,
    'return-outside.tel': /return/i,
  };
  for (const [name, src] of Object.entries(cases)) {
    const file = writeFile(dir, name, src + '\n');
    const r = runCli(['check', file], { timeout: 15000 });
    assert.ok(!r.timedOut, `check hung on ${name}`);
    assert.equal(r.status, 1, `${name} should fail check, got status ${r.status}: ${r.stderr}${r.stdout}`);
    const err = stripAnsi(r.stderr + r.stdout);
    assert.match(err, keyword[name], `${name}: unhelpful message:\n${err}`);
    assert.match(err, new RegExp(escapeRe(file) + ':\\d+:\\d+:'), `${name}: no file:line:col:\n${err}`);
    assert.match(err, /\^/, `${name}: no caret line:\n${err}`);
  }
});

test('v0.2 check: no false positives on builtins, std and JS imports', (t) => {
  if (pending(t, hasCli && hasChecker, 'task-1 (checker)')) return;
  const f = null; // feature-independent: these forms are valid in v0.1/v0.2 planners
  const dir = mkTmp('tel-check-good-');
  const cases = {
    'builtins.tel': lines('xs = [3, 1, 2]', 'print(xs.sort().map(_ * 2).sum())', 'print(math.floor(2.9))'),
    'std-ns.tel': lines('import std.math as m', 'print(m.floor(1.9))'),
    'user-fn.tel': lines('fn add(a: Num, b: Num) -> Num = a + b', 'print(add(1, 2))'),
    'records.tel': lines('type P = {x: Num, y: Num}', 'p = P(1, 2)', 'print(p.x + p.y)'),
  };
  for (const [name, src] of Object.entries(cases)) {
    const file = writeFile(dir, name, src + '\n');
    const r = runCli(['check', file], { timeout: 15000 });
    assert.ok(!r.timedOut, `check hung on ${name}`);
    assert.equal(r.status, 0, `false positive in ${name}:\n${r.stderr}${r.stdout}`);
  }
  // JS import forms must not be reported as undefined names/namespaces.
  const jsCases = {
    'js-alias.tel': lines('import "node:path" as path', 'print(path.join("a", "b"))'),
    'js-named.tel': lines('import "node:path" {join}', 'print(join("a", "b"))'),
    'js-star.tel': lines('import "node:path" * as pstar', 'print(pstar.join("a", "b"))'),
  };
  for (const [name, src] of Object.entries(jsCases)) {
    const file = writeFile(dir, name, src + '\n');
    const r = runCli(['check', file], { timeout: 15000 });
    assert.ok(!r.timedOut, `check hung on ${name}`);
    assert.equal(r.status, 0, `false positive in ${name}:\n${r.stderr}${r.stdout}`);
  }
  void f;
});

test('v0.2 adversarial: checker does not hang on import cycles', (t) => {
  if (pending(t, hasCli && hasChecker, 'task-1 (checker)')) return;
  const dir = mkTmp('tel-check-cycle-');
  writeFile(dir, 'a.tel', lines('import "./b.tel" as b', 'pub fn fa(): b.fb()'));
  const a = writeFile(dir, 'b.tel', lines('import "./a.tel" as a', 'pub fn fb(): 1'));
  const r = runCli(['check', a], { timeout: 10000 });
  assert.ok(!r.timedOut, 'check hung on an import cycle');
  assert.ok(r.status === 0 || r.status === 1, `unexpected status ${r.status}: ${r.stderr}`);
  if (r.status === 1) {
    assert.match(stripAnsi(r.stderr + r.stdout), new RegExp(escapeRe(a) + ':\\d+:\\d+:'), 'cycle error lacks file:line:col');
  }
});

test('v0.2 adversarial: malformed import/new forms are located parse errors', (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  const dir = mkTmp('tel-adv-import-');
  const cases = {
    'import-bad-spec.tel': 'import 5 as x\n',
    'import-as-missing.tel': 'import "node:path" as\n',
    'new-no-callee.tel': 'x = new\n',
    'new-bad.tel': 'x = new 5\n',
    'import-unbalanced.tel': 'import "node:path" {join\n',
  };
  for (const [name, src] of Object.entries(cases)) {
    const file = writeFile(dir, name, src);
    const r = runCli(['run', file], { timeout: 8000 });
    assert.ok(!r.timedOut, `hung on ${name}`);
    assert.notEqual(r.status, 0, `${name} should be rejected, got status 0: ${r.stdout}`);
    const err = stripAnsi(r.stderr + r.stdout);
    assert.match(err, new RegExp(escapeRe(file) + ':\\d+:\\d+:'), `${name}: no file:line:col:\n${err}`);
  }
});

// ===========================================================================
// 9. New in v0.2: --target ts
// ===========================================================================

test('v0.2 compiler: --target ts emits typed modules with one shared runtime, runnable by node', { timeout: 180000 }, async (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  const f = await v02();
  if (!f.tsTarget) { t.skip('PENDING: task-3 (v0.2 TS emit)'); return; }
  const dir = mkTmp('tel-ts-');
  writeFile(dir, 'lib.tel', lines('pub fn add(a: Num, b: Num) -> Num = a + b'));
  writeFile(dir, 'sub/extra.tel', lines('pub fn inc(n: Num) -> Num = n + 1'));
  const main = writeFile(dir, 'main.tel', lines(
    'import "./lib.tel" as lib',
    'import "./sub/extra.tel" as extra',
    'type P = {x: Num, y: Num}',
    'print(lib.add(2, 3))',
    'print(extra.inc(41))',
    'print(P(x=4, y=5) is P)',
  ));
  const build = runCli(['build', main, '--target', 'ts', '--outdir', dir], { timeout: 60000 });
  assert.equal(build.status, 0, `ts build failed:\n${build.stderr}${build.stdout}`);
  const emitted = walkDir(dir).filter((p) => p.endsWith('.ts'));
  const runtime = emitted.find((p) => path.basename(p) === 'tel_runtime.ts');
  assert.ok(runtime, `no shared tel_runtime.ts emitted; got ${JSON.stringify(emitted)}`);
  const user = emitted.filter((p) => p !== runtime);
  assert.ok(user.length >= 3, `expected entry + 2 modules + runtime, got ${JSON.stringify(emitted)}`);
  for (const file of user) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /@ts-nocheck/, `user module ${file} must not be @ts-nocheck`);
    const m = text.match(/import\s*\{[^}]*\}\s*from\s*['"]([^'"]*tel_runtime\.ts)['"]/);
    assert.ok(m, `user module ${file} does not import the shared runtime`);
    assert.equal(path.resolve(path.dirname(file), m[1]), runtime, `${file} imports a non-shared runtime`);
    assert.doesNotMatch(text, /function\s+matchPat|const\s+__\s*=\s*\(\(\)\s*=>/, `${file} inlines runtime code`);
  }
  const entry = user.find((p) => /main\.ts$/.test(p)) ?? user.find((p) => /main/.test(path.basename(p))) ?? user[0];
  const run = runNodeFile(entry, { timeout: 30000 });
  assert.ok(!run.timedOut, 'node entry.ts hung');
  assert.equal(run.status, 0, `node ${entry} failed:\n${run.stderr}`);
  assert.equal(run.stdout, '5\n42\ntrue\n');

  const interp = runCli(['run', main], { timeout: 30000 });
  assert.equal(interp.status, 0, interp.stderr);
  assert.equal(run.stdout, interp.stdout, 'ts output stdout differs from interpreter');
});

test('v0.2 compiler: ts build handles nested import paths and relative runtime imports', { timeout: 120000 }, async (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  const f = await v02();
  if (!f.tsTarget) { t.skip('PENDING: task-3 (v0.2 TS emit)'); return; }
  const dir = mkTmp('tel-ts-nested-');
  writeFile(dir, 'deep/inner/math.tel', lines('pub fn square(n: Num) -> Num = n * n'));
  const main = writeFile(dir, 'src/main.tel', lines(
    'import "../deep/inner/math.tel" as math',
    'print(math.square(6))',
  ));
  const outdir = path.join(dir, 'out');
  const build = runCli(['build', main, '--target', 'ts', '--outdir', outdir], { timeout: 60000 });
  assert.equal(build.status, 0, `ts nested build failed:\n${build.stderr}${build.stdout}`);
  const emitted = walkDir(outdir).filter((p) => p.endsWith('.ts'));
  const runtime = emitted.find((p) => path.basename(p) === 'tel_runtime.ts');
  assert.ok(runtime, `no shared runtime in nested build: ${JSON.stringify(emitted)}`);
  const users = emitted.filter((p) => p !== runtime);
  assert.ok(users.length >= 2, `missing emitted modules: ${JSON.stringify(emitted)}`);
  for (const file of users) {
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(/from\s*['"]([^'"]*tel_runtime\.ts)['"]/);
    assert.ok(m, `${file}: no runtime import`);
    assert.equal(path.resolve(path.dirname(file), m[1]), runtime, `${file}: wrong relative runtime path ${m[1]}`);
  }
  const entry = users.find((p) => /main\.ts$/.test(p)) ?? users[0];
  const run = runNodeFile(entry, { timeout: 30000 });
  assert.ok(!run.timedOut);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '36\n');
});

test('v0.2 compiler: tsc --noEmit accepts emitted user modules (if tsc present)', { timeout: 120000 }, async (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  const f = await v02();
  if (!f.tsTarget) { t.skip('PENDING: task-3 (v0.2 TS emit)'); return; }
  if (!hasTsc) { t.skip('tsc not on PATH; recorded as residual risk'); return; }
  const dir = mkTmp('tel-ts-tsc-');
  writeFile(dir, 'lib.tel', lines('pub fn add(a: Num, b: Num) -> Num = a + b'));
  const main = writeFile(dir, 'main.tel', lines('import "./lib.tel" as lib', 'print(lib.add(1, 2))'));
  const build = runCli(['build', main, '--target', 'ts', '--outdir', dir], { timeout: 60000 });
  assert.equal(build.status, 0, build.stderr);
  const users = walkDir(dir).filter((p) => p.endsWith('.ts') && path.basename(p) !== 'tel_runtime.ts');
  const r = spawnSync('tsc', ['--noEmit', '--allowImportingTsExtensions', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', ...users], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, `tsc reported errors in user code:\n${r.stdout}\n${r.stderr}`);
});

// ===========================================================================
// 10. New in v0.2: JS/npm interop
// ===========================================================================

function interopProject(dir) {
  writeFile(dir, 'helper.js', lines(
    'export function twice(x) { return x * 2; }',
    'export function applyTwice(fn, v) { return fn(fn(v)); }',
    'export class Counter { constructor() { this.n = 0; } inc() { this.n++; return this; } }',
  ));
  writeFile(dir, 'helper-default.js', 'export default { label: "dflt", triple: (x) => x * 3 };\n');
  writeFile(dir, 'helper-mixed.js', 'export default { label: "mixed" };\nexport function quad(x) { return x * 4; }\n');
  const dataFile = writeFile(dir, 'data.txt', 'interop-data');
  const main = writeFile(dir, 'main.tel', lines(
    'import "node:path" as path',
    'import "node:path" * as pstar',
    'import "node:fs/promises" as fsp',
    'import "./helper.js" as h',
    'import "./helper.js" {twice, applyTwice, Counter}',
    'import "./helper-default.js" as hd',
    'import "./helper-mixed.js" as hm',
    'import "./helper.js" * as hstar',
    'print(path.join("a", "b"))',
    'print(pstar.join("b", "c"))',
    'print(twice(21))',
    'print(applyTwice(x => x + 1, 40))',
    'print(h.twice(5))',
    'print(hstar.twice(6))',
    'print(hd.label, hd.triple(4))',
    'print(hm.label, hm.quad(3))',
    'print(new Date(0).getUTCFullYear())',
    'c = new Counter()',
    'c.inc()',
    'c.inc()',
    'print(c.n)',
    'd = new Date(0)',
    'print(d.getUTCFullYear())',
    'async fn main(a):',
    `  txt = await fsp.readFile(${JSON.stringify(dataFile)}, "utf8")`,
    '  print(txt.trim())',
  ));
  return { main, expected: 'a/b\nb/c\n42\n42\n10\n12\ndflt 12\nmixed 12\n1970\n2\n1970\ninterop-data\n' };
}

test('v0.2 interop: interpreter runs JS imports, new, callbacks and native methods', { timeout: 120000 }, async (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  if (!(await interopRuntimeReady())) { t.skip('PENDING: task-3 (v0.2 runtime interop)'); return; }
  const dir = mkTmp('tel-interop-run-');
  const { main, expected } = interopProject(dir);
  const r = runCli(['run', main], { timeout: 30000 });
  assert.ok(!r.timedOut, 'interop program hung under interpreter');
  assert.equal(r.status, 0, `interpreter interop failed:\n${r.stderr}`);
  assert.equal(r.stdout, expected);
});

test('v0.2 interop: js target preserves JS imports and matches interpreter', { timeout: 180000 }, async (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  if (pending(t, hasCodegen, 'task-3')) return;
  if (!(await interopRuntimeReady())) { t.skip('PENDING: task-3 (v0.2 runtime interop)'); return; }
  const dir = mkTmp('tel-interop-js-');
  const { main, expected } = interopProject(dir);
  const interp = runCli(['run', main], { timeout: 30000 });
  assert.equal(interp.status, 0, interp.stderr);
  const out = path.join(dir, 'main.mjs');
  const build = runCli(['build', main, '--target', 'js', '-o', out], { timeout: 60000 });
  assert.equal(build.status, 0, `js interop build failed:\n${build.stderr}${build.stdout}`);
  const run = runNodeFile(out, { timeout: 30000 });
  assert.ok(!run.timedOut, 'compiled interop js hung');
  assert.equal(run.status, 0, `compiled interop js failed:\n${run.stderr}`);
  assert.equal(run.stdout, expected);
  assert.doesNotMatch(run.stderr, /is not defined/, run.stderr);
});

test('v0.2 interop: ts target preserves JS imports and matches interpreter', { timeout: 180000 }, async (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  const f = await v02();
  if (!f.tsTarget) { t.skip('PENDING: task-3 (v0.2 TS emit)'); return; }
  if (!(await interopRuntimeReady())) { t.skip('PENDING: task-3 (v0.2 runtime interop)'); return; }
  const dir = mkTmp('tel-interop-ts-');
  const { main, expected } = interopProject(dir);
  const interp = runCli(['run', main], { timeout: 30000 });
  assert.equal(interp.status, 0, interp.stderr);
  const build = runCli(['build', main, '--target', 'ts', '--outdir', dir], { timeout: 60000 });
  assert.equal(build.status, 0, `ts interop build failed:\n${build.stderr}${build.stdout}`);
  const entry = walkDir(dir).find((p) => /main\.ts$/.test(p)) ?? walkDir(dir).find((p) => p.endsWith('.ts') && path.basename(p) !== 'tel_runtime.ts');
  const run = runNodeFile(entry, { timeout: 30000 });
  assert.ok(!run.timedOut, 'compiled interop ts hung');
  assert.equal(run.status, 0, `node ${entry} failed:\n${run.stderr}`);
  assert.equal(run.stdout, expected);
  assert.doesNotMatch(run.stderr, /is not defined/, run.stderr);
});

// ===========================================================================
// 11. New in v0.2: AGENTS.md / agent guide
// ===========================================================================

test('v0.2 agents: AGENTS.md is byte-identical to docs/AGENT-GUIDE.md', (t) => {
  if (pending(t, hasAgentGuide && hasAgentsMd, 'task-2')) return;
  const a = fs.readFileSync(AGENTS_MD);
  const g = fs.readFileSync(AGENT_GUIDE);
  assert.ok(a.equals(g), 'root AGENTS.md must be the exact bytes of docs/AGENT-GUIDE.md');
});

test('v0.2 agents: guide budget <= 2200 cl100k tokens', async (t) => {
  if (pending(t, hasAgentsMd, 'task-2')) return;
  if (pending(t, hasTokcount, 'task-2 (tokcount)')) return;
  const tok = await import(pathToFileURL(TOKCOUNT).href + `?v=${Date.now()}`);
  const text = fs.readFileSync(AGENTS_MD, 'utf8');
  const n = tok.countTokens(text);
  assert.ok(n <= 2200, `AGENTS.md is ${n} cl100k tokens (budget 2200)`);
});

test('v0.2 agents: every fenced tel snippet parses, runs and builds', { timeout: 300000 }, (t) => {
  if (pending(t, hasCli && hasAgentGuide, 'task-1 + task-2')) return;
  const md = fs.readFileSync(AGENT_GUIDE, 'utf8');
  const fences = telFences(md);
  assert.ok(fences.length > 0, 'docs/AGENT-GUIDE.md has no ```tel fences');
  const dir = mkTmp('tel-agent-fence-');
  fences.forEach((src, i) => {
    const file = writeFile(dir, `fence-${String(i).padStart(2, '0')}.tel`, src.endsWith('\n') ? src : src + '\n');
    const run = runCli(['run', file], { timeout: 15000 });
    if (run.timedOut) {
      assert.ok(run.stdout.length > 0, `fence ${i} timed out without producing output`);
    } else {
      assert.equal(run.status, 0, `fence ${i} failed to run:\n${run.stderr}`);
    }
  });
  if (hasCodegen) {
    fences.forEach((src, i) => {
      const file = path.join(dir, `fence-${String(i).padStart(2, '0')}.tel`);
      const out = path.join(dir, `fence-${String(i).padStart(2, '0')}.mjs`);
      const build = runCli(['build', file, '--target', 'js', '-o', out], { timeout: 30000 });
      assert.equal(build.status, 0, `fence ${i} failed to build to js:\n${build.stderr}`);
    });
  }
});

test('v0.2 agents: tel guide prints the guide and tel init copies it byte-identically', (t) => {
  if (pending(t, hasCli && hasAgentGuide, 'task-1 + task-2')) return;
  const guideText = fs.readFileSync(AGENT_GUIDE, 'utf8');
  const g = runCli(['guide'], { timeout: 15000 });
  assert.equal(g.status, 0, g.stderr);
  assert.ok(g.stdout === guideText || g.stdout.trimEnd() === guideText.trimEnd(), 'tel guide output differs from docs/AGENT-GUIDE.md');
  const gf = runCli(['guide', '--full'], { timeout: 15000 });
  assert.equal(gf.status, 0, gf.stderr);
  assert.ok(gf.stdout === guideText || gf.stdout.trimEnd() === guideText.trimEnd(), 'tel guide --full output differs');

  if (!hasAgentsMd) return;
  const dir = mkTmp('tel-init-');
  const init = runCli(['init'], { timeout: 15000, cwd: dir });
  assert.equal(init.status, 0, `tel init failed:\n${init.stderr}`);
  const copied = path.join(dir, 'AGENTS.md');
  assert.ok(fs.existsSync(copied), 'tel init did not create AGENTS.md');
  assert.ok(fs.readFileSync(copied).equals(fs.readFileSync(AGENTS_MD)), 'tel init AGENTS.md is not byte-identical');
  assert.ok(fs.existsSync(path.join(dir, 'main.tel')), 'tel init did not create main.tel');
  const run = runCli(['run', 'main.tel'], { timeout: 15000, cwd: dir });
  assert.equal(run.status, 0, `tel init main.tel does not run:\n${run.stderr}`);
});

test('examples: web example builds for web target and SSRs the signal counter', { timeout: 120000 }, async (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  const webFile = exampleFiles.find((p) => path.basename(p) === 'web.tel');
  if (!webFile) { t.skip('PENDING: task-2 (examples/web.tel)'); return; }
  const dir = mkTmp('tel-example-web-');
  const out = path.join(dir, 'web.mjs');
  const build = runCli(['build', webFile, '--target', 'web', '-o', out], { timeout: 30000 });
  assert.equal(build.status, 0, `web example build failed:\n${build.stderr}`);
  const mod = await import(pathToFileURL(out).href + `?v=${Date.now()}`);
  assert.equal(typeof mod.__tel?.html, 'function', 'web example must export __tel.html');
  assert.equal(typeof mod.App, 'function', 'web example must export App');
  assert.equal(mod.__tel.html(mod.App()), '<div class="app"><h1>Counter 0</h1><button>+</button></div>');
});

test('v0.2 examples: Node-runnable examples build to ts and run under plain node', { timeout: 300000 }, (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  const f = null;
  if (!exampleFiles.length) { t.skip('PENDING: task-2'); return; }
  // Gate on the TS target without async: v02() is async, so check synchronously here.
  const dir = mkTmp('tel-example-ts-');
  for (const file of exampleFiles) {
    const base = path.basename(file);
    if (NON_TERMINATING_EXAMPLES.has(base) || WEB_TARGET_EXAMPLES.has(base)) continue;
    const outdir = path.join(dir, base);
    fs.mkdirSync(outdir, { recursive: true });
    const build = runCli(['build', file, '--target', 'ts', '--outdir', outdir], { timeout: 60000 });
    if (build.status !== 0 && /unknown target|not supported|target ts/i.test(build.stderr + build.stdout)) {
      t.skip('PENDING: task-3 (v0.2 TS emit)');
      return;
    }
    assert.equal(build.status, 0, `${base} ts build failed:\n${build.stderr}${build.stdout}`);
    const emitted = walkDir(outdir).filter((p) => p.endsWith('.ts') && path.basename(p) !== 'tel_runtime.ts');
    const entry = emitted.find((p) => new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(p)) ?? emitted[0];
    assert.ok(entry, `${base}: no emitted entry .ts`);
    const run = runNodeFile(entry, { timeout: 30000 });
    assert.ok(!run.timedOut, `${base} ts output hung`);
    assert.equal(run.status, 0, `${base} ts output failed:\n${run.stderr}`);
  }
  void f;
});

// ===========================================================================
// 12. SPEC.md claims (own probes; parser is authoritative)
// ===========================================================================

async function expectTel(src, expected, label) {
  const got = await evalTel(src);
  assert.deepEqual(got, expected, `${label}: ${JSON.stringify(src)}`);
}

test('spec: numeric/string literals, comments and semicolons', async () => {
  await expectTel('42', 42, 'decimal');
  await expectTel('0x2a', 42, 'hex');
  await expectTel('0b1010', 10, 'binary');
  await expectTel('1_000_000', 1000000, 'underscores');
  await expectTel('.25', 0.25, 'leading dot');
  await expectTel('2.5e-2', 0.025, 'exponent');
  await expectTel('0x2a + 0b1010 + 1_000_000 + .25 + 1e3', 1001052.25, 'mixed numerics');
  await expectTel('"\\u0041"', 'A', 'unicode escape');
  await expectTel(lines('name = "x"', "'{name}'"), '{name}', 'single quotes do not interpolate');
  await expectTel(lines('name = "x"', '"\\{name\\}"'), '{name}', 'escaped braces');
  await expectTel('a = 1; b = 2; a + b', 3, 'semicolon separator');
  await expectTel(lines('#[ outer #[ inner ]# still ]#', 'x = 1', 'x'), 1, 'nested block comment (inline)');
  await expectTel(lines('#[ line', 'start ]#', 'x = 1', 'x'), 1, 'line-start block comment (V10 fixed)');
});

test('spec: operators, precedence, in and pipe', async () => {
  await expectTel('1 + 2 * 3', 7, 'precedence');
  await expectTel('2 ** 3 ** 2', 512, 'right assoc');
  await expectTel('7 % 4', 3, 'mod');
  await expectTel('true and "yes"', 'yes', 'and value');
  await expectTel('nil or "fallback"', 'fallback', 'or value');
  await expectTel('not false', true, 'not');
  await expectTel('2 in [1, 2]', true, 'in list');
  await expectTel('"b" in "abc"', true, 'in string');
  await expectTel('"k" in {"k": 1}', true, 'in record');
  await expectTel('[1, 2] == [1, 2]', true, 'structural array eq');
  await expectTel('Ok(1) == Ok(1)', true, 'structural sum eq');
  await expectTel('"big" if 10 > 3 else "small"', 'big', 'conditional expr');
  await expectTel('[3, 1, 2] |> sort |> join("-")', '1-2-3', 'pipe');
});

test('spec: **= compound assignment (BUG-V18)', async () => {
  await expectTel(lines('x = 2', 'x **= 3', 'x'), 8, '**=');
});

test('spec: slices, ranges and comprehensions', async () => {
  const xs = ['xs = [0, 1, 2, 3, 4, 5]'];
  await expectTel(lines(...xs, 'xs[1..4]'), [1, 2, 3], 'slice exclusive');
  await expectTel(lines(...xs, 'xs[..2]'), [0, 1], 'slice open start');
  await expectTel(lines(...xs, 'xs[3..]'), [3, 4, 5], 'slice open end');
  await expectTel(lines(...xs, 'xs[2..=4]'), [2, 3, 4], 'slice inclusive');
  await expectTel(lines(...xs, 'i = 1', 'xs[i + 1..]'), [2, 3, 4, 5], 'slice dynamic bound');
  await expectTel('[n for n in 1..=5]', [1, 2, 3, 4, 5], 'inclusive range');
  await expectTel('[n for n in 5..0]', [5, 4, 3, 2, 1], 'descending exclusive');
  await expectTel('[n for n in 3..=0]', [3, 2, 1, 0], 'descending inclusive');
  await expectTel('range(0, 10, false, 2).map(_).join(",")', '0,2,4,6,8', 'range step');
  await expectTel('{k: k * k for k in [1, 2, 3]}', { k: 9 }, 'map comprehension literal key');
  await expectTel('[1 for _ in [1, 2, 3]].len()', 3, 'wildcard for-pattern');
});

test('spec: types, declarations, is and generics', async () => {
  await expectTel(lines('x: Num = 1', 'x'), 1, 'annotated let');
  await expectTel(lines('flag: Bool = true', 'flag'), true, 'bool annotation');
  await expectTel(lines('maybe: Str? = nil', 'maybe ?? "fallback"'), 'fallback', 'optional type');
  await expectTel(lines('ids: [Num] = [1, 2, 3]', 'ids.sum()'), 6, 'list type');
  await expectTel(lines('table: [Str: Num] = {"a": 1}', 'table["a"]'), 1, 'map type');
  await expectTel(lines('pair: (Num, Str) = (1, "one")', 'pair[1]'), 'one', 'tuple type');
  // Aliases have no runtime representation (SPEC 3.6), so only the annotation is exercised.
  parse('type Row = (Str, Num)');
  parse('type Ids = [Str]');
  await expectTel(lines('type Ids = [Str]', 'i: Ids = ["x"]', 'i.len()'), 1, 'list alias annotation');
  await expectTel(lines('type Box[T] = {v: T}', 'Box(v=3).v'), 3, 'generic record');
  await expectTel(lines('fn id[T](x: T) -> T = x', 'id(5)'), 5, 'generic fn');
  await expectTel(lines('type Shape = Circle(r: Num) | Rect(w: Num, h: Num)', 'Circle(1) is Shape'), true, 'union is');
  await expectTel(lines('type Shape = Circle(r: Num) | Dot', 'str(Dot)'), 'Dot', 'nullary variant str');
  await expectTel('1 is Int', true, 'Int alias');
  await expectTel('nil is Nil', true, 'is Nil');
  await expectTel('1 is Num and "s" is Str and [1] is List and nil is Nil', true, 'is builtins');
  // Dotted annotation names are parse-only.
  parse('fn f(r: url.URL) -> Str = r.toString()');
});

test('spec: lambdas, named-arg limitation, local annotations, defer and spawn', async () => {
  await expectTel(lines('double = x => x * 2', 'double(21)'), 42, 'lambda');
  await expectTel(lines('add = (a, b) => a + b', 'add(2, 3)'), 5, 'lambda params');
  await expectTel(lines('f = async x => x + 1', 'await f(1)'), 2, 'async lambda');
  await expectTel(lines('f = (x) => x + 1', 'f(1)'), 2, 'paren lambda');
  await expectTel(lines('fn f(a): a', 'f(x=1)'), { x: 1 }, 'named args to ordinary fn (documented limitation)');
  await expectTel(lines('p = nil', 'p?.f()'), null, 'optional call short-circuit');
  await expectTel(lines('x = 1', 'fn f():', '  x: Num = 2', '  x', 'f() + x'), 3, 'annotated local scoping');
  await expectTel(lines(
    'order = []',
    'fn f():',
    '  defer order.push(1)',
    '  order.push(2)',
    '  3',
    'f()',
    'order',
  ), [2, 1], 'defer LIFO');
  await expectTel(lines('fn work(): 7', 'p = spawn work()', 'await p'), 7, 'spawn prefix');
});

test('spec: spread, records and tuples', async () => {
  await expectTel(lines('xs = [2, 3]', '[0, 1, ...xs]'), [0, 1, 2, 3], 'spread later');
  await expectTel(lines('xs = [2, 3]', '[...xs, 4]'), [2, 3, 4], 'spread first (V7 fixed)');
  await expectTel('{...{"a": 1}, b: 2}', { a: 1, b: 2 }, 'record spread');
  await expectTel(lines('x = 1', 'y = 2', '{x, y}'), { x: 1, y: 2 }, 'bare record keys');
  await expectTel('{"count": 3}', { count: 3 }, 'string key record');
  await expectTel(lines('t = (1, "two")', 't[1]'), 'two', 'tuple');
  await expectTel(lines('fn add3(a, b, c): a + b + c', 'xs = [1, 2, 3]', 'add3(...xs)'), 6, 'spread call');
  await expectTel('{a: 1}.b', null, 'missing field is nil');
});

test('tokcount: TOKENS.md corpus totals and v0.2 rows reproduce', async (t) => {
  const doc = path.join(ROOT, 'docs', 'TOKENS.md');
  if (!fs.existsSync(doc)) { t.skip('PENDING: task-2'); return; }
  if (pending(t, hasTokcount, 'task-2')) return;
  const bench = path.join(ROOT, 'examples', 'tokenbench');
  if (!fs.existsSync(bench)) { t.skip('PENDING: task-2 (examples/tokenbench)'); return; }
  const tok = await import(pathToFileURL(TOKCOUNT).href + `?v=${Date.now()}`);
  const recs = tok.countFiles(walkDir(bench));
  const byName = Object.fromEntries(recs.map((r) => [path.basename(r.path), r]));
  const sum = (ext) => recs.filter((r) => r.path.endsWith(ext)).reduce((a, r) => a + r.tokens, 0);
  assert.equal(sum('.tel'), 540, 'Tel corpus tokens');
  assert.equal(sum('.py'), 421, 'Python corpus tokens (base three)');
  assert.equal(sum('.ts'), 759, 'TypeScript corpus tokens (all six)');
  const text = fs.readFileSync(doc, 'utf8');
  assert.match(text, /All six programs combined: Tel \*\*540\*\* tokens vs TypeScript \*\*759\*\*/, 'combined claim');
  const rows = [
    ['typed record pipeline', 'typed_pipeline.tel', 'typed_pipeline.ts'],
    ['async load', 'async_load.tel', 'async_load.ts'],
    ['route dispatcher', 'route.tel', 'route.ts'],
  ];
  for (const [label, telFile, tsFile] of rows) {
    const re = new RegExp(`\\|\\s*${label}\\s*\\|\\s*(\\d+)\\s*\\|\\s*(\\d+)\\s*\\|`);
    const m = text.match(re);
    assert.ok(m, `TOKENS.md row missing: ${label}`);
    assert.equal(Number(m[1]), byName[telFile].tokens, `${label}: Tel token claim`);
    assert.equal(Number(m[2]), byName[tsFile].tokens, `${label}: TS token claim`);
  }
});

test('tokcount: TOKENS.md stdout-equivalence claims for benchmark programs', { timeout: 180000 }, (t) => {
  if (pending(t, hasCli, 'task-1')) return;
  const bench = path.join(ROOT, 'examples', 'tokenbench');
  if (!fs.existsSync(bench)) { t.skip('PENDING: task-2 (examples/tokenbench)'); return; }
  const hasPython = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
  const runTel = (name) => runCli(['run', path.join(bench, `${name}.tel`)], { timeout: 30000 });
  for (const name of ['fizzbuzz', 'pipeline']) {
    const tel = runTel(name);
    assert.equal(tel.status, 0, tel.stderr);
    const ts = runNodeFile(path.join(bench, `${name}.ts`), { timeout: 30000 });
    assert.equal(ts.status, 0, ts.stderr);
    assert.equal(ts.stdout, tel.stdout, `${name}: Tel vs TS stdout`);
    if (hasPython) {
      const py = spawnSync('python3', [path.join(bench, `${name}.py`)], { encoding: 'utf8', timeout: 30000 });
      assert.equal(py.status, 0, py.stderr);
      assert.equal(py.stdout, tel.stdout, `${name}: Tel vs Python stdout`);
    }
  }
  for (const name of ['typed_pipeline', 'async_load', 'route']) {
    const tel = runTel(name);
    assert.equal(tel.status, 0, tel.stderr);
    const ts = runNodeFile(path.join(bench, `${name}.ts`), { timeout: 30000 });
    assert.equal(ts.status, 0, ts.stderr);
    assert.equal(ts.stdout, tel.stdout, `${name}: Tel vs TS stdout`);
  }
});

test('v0.2 check: --tsc degrades gracefully without tsc/tsconfig', (t) => {
  if (pending(t, hasCli && hasChecker, 'task-1 (checker)')) return;
  const dir = mkTmp('tel-check-tsc-');
  const file = writeFile(dir, 'ok.tel', lines('fn add(a: Num, b: Num) -> Num = a + b', 'print(add(1, 2))'));
  const noCfg = runCli(['check', file, '--tsc'], { timeout: 30000, cwd: dir });
  assert.equal(noCfg.status, 0, `check --tsc without tsconfig failed:\n${noCfg.stderr}${noCfg.stdout}`);
  assert.match(noCfg.stdout + noCfg.stderr, /tsc|TypeScript/i, 'expected a tsc/TypeScript note');
  writeFile(dir, 'tsconfig.json', '{}\n');
  const withCfg = runCli(['check', file, '--tsc'], { timeout: 30000, cwd: dir });
  assert.equal(withCfg.status, 0, `check --tsc with tsconfig failed:\n${withCfg.stderr}${withCfg.stdout}`);
  assert.match(withCfg.stdout + withCfg.stderr, /tsc|TypeScript/i, 'expected a tsc/TypeScript note');
});
