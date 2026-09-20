// CLI tests for Tel. Run with: node --test test/cli.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'tel.mjs');
const CODEGEN = path.join(ROOT, 'src', 'codegen.mjs');
const GUIDE = path.join(ROOT, 'docs', 'AGENT-GUIDE.md');
const AGENTS = path.join(ROOT, 'AGENTS.md');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function mkTmp(prefix = 'tel-cli-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(dir, name, src) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, src);
  return p;
}

function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
    timeout: opts.timeout ?? 20000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error, signal: r.signal };
}

function codegenSupports(target) {
  if (!fs.existsSync(CODEGEN)) return false;
  const src = fs.readFileSync(CODEGEN, 'utf8');
  if (target === 'ts') return /export function compileProgram/.test(src) && /export function compileRuntime/.test(src);
  return /export function compileProgram/.test(src);
}

test('help and --version', () => {
  const v = run(['--version']);
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, new RegExp(PKG.version.replace(/\./g, '\\.')));
  const h = run(['help']);
  assert.equal(h.status, 0, h.stderr);
  for (const word of ['run', 'build', 'eval', 'check', 'fmt', 'tokens', 'init', 'guide', 'repl', 'test']) {
    assert.match(h.stdout, new RegExp(`\\b${word}\\b`), `help missing ${word}`);
  }
});

test('run executes a file and passes args after --', () => {
  const dir = mkTmp('tel-run-');
  const file = writeFile(dir, 'ok.tel', 'print("hi")\nfn main(a):\n  print(a)\n');
  const r = run(['run', file, '--', 'x', 'y']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'hi\n[x, y]\n');
  assert.equal(r.stderr, '');
});

test('eval and -e print a result', () => {
  for (const args of [['eval', '2 + 3'], ['-e', '2 + 3']]) {
    const r = run(args);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '5');
  }
  const bad = run(['eval', 'missing_name']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /missing_name/);
});

test('run parse errors are located with a caret', () => {
  const dir = mkTmp('tel-bad-');
  const file = writeFile(dir, 'bad.tel', 'x = (1 + \n');
  const r = run(['run', file]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+:\\d+:`));
  assert.match(r.stderr, /\^/);
});

test('run runtime errors are located and exit 1', () => {
  const dir = mkTmp('tel-rt-');
  const file = writeFile(dir, 'rt.tel', 'x = missing_name\n');
  const r = run(['run', file]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /undefined name 'missing_name'/);
  assert.match(r.stderr, new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+:\\d+:`));
});

test('missing files and unknown flags exit 2', () => {
  const missing = run(['run', path.join(os.tmpdir(), 'definitely-not-tel-xyz.tel')]);
  assert.equal(missing.status, 2, missing.stderr);
  const unknown = run(['--definitely-unknown']);
  assert.equal(unknown.status, 2, unknown.stderr);
  const noCommandFile = run(['run']);
  assert.equal(noCommandFile.status, 2, noCommandFile.stderr);
});

test('check reports static errors and passes valid files', () => {
  const dir = mkTmp('tel-check-');
  const good = writeFile(dir, 'good.tel', 'fn add(a: Num, b: Num) -> Num = a + b\nprint(add(1, 2))\n');
  assert.equal(run(['check', good]).status, 0, run(['check', good]).stderr);

  const cases = {
    undefined: ['x = nope + 1\n', /undefined|nope/i],
    'wrong arity': ['fn add(a, b): a + b\nprint(add(1))\n', /expects|argument/i],
    'too many args': ['fn add(a, b): a + b\nadd(1, 2, 3)\n', /expects|argument/i],
    'break outside': ['break\n', /break/i],
    'return outside': ['return 1\n', /return/i],
    'duplicate param': ['fn f(a, a): a\nprint(f(1, 2))\n', /duplicate|parameter/i],
  };
  for (const [name, [src, re]] of Object.entries(cases)) {
    const f = writeFile(dir, `${name.replace(/\s+/g, '-')}.tel`, src);
    const r = run(['check', f]);
    assert.equal(r.status, 1, `${name}: ${r.stderr}`);
    assert.match(r.stderr, re, name);
    assert.match(r.stderr, new RegExp(`${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+:\\d+:`), name);
  }
});

test('check is clean for builtins, std and JS imports', () => {
  const dir = mkTmp('tel-check-good-');
  const cases = {
    'builtins.tel': 'xs = [3, 1, 2]\nprint(xs.sort().map(_ * 2).sum())\n',
    'std.tel': 'import std.math as m\nprint(m.floor(1.9))\n',
    'js.tel': 'import "node:path" as path\nprint(path.join("a", "b"))\n',
  };
  for (const [name, src] of Object.entries(cases)) {
    const f = writeFile(dir, name, src);
    const r = run(['check', f]);
    assert.equal(r.status, 0, `${name} false positive:\n${r.stderr}`);
  }
});

test('fmt prints canonical source, --write is idempotent, new forms round-trip', () => {
  const dir = mkTmp('tel-fmt-');
  const messy = writeFile(dir, 'messy.tel', [
    '# a comment',
    'x   =   1+2',
    'fn  f( a: Num,b:Num )->Num:   a*b',
    'print(   f(x,4)   )',
    '',
  ].join('\n'));
  const formatted = run(['fmt', messy]);
  assert.equal(formatted.status, 0, formatted.stderr);
  const formattedFile = writeFile(dir, 'formatted.tel', formatted.stdout);
  assert.equal(run(['run', formattedFile]).status, 0);

  const first = run(['fmt', '--write', messy]);
  assert.equal(first.status, 0, first.stderr);
  const content1 = fs.readFileSync(messy, 'utf8');
  const second = run(['fmt', '--write', messy]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(messy, 'utf8'), content1, 'fmt --write is not idempotent');

  const modern = writeFile(dir, 'modern.tel', [
    'import "node:path" as path',
    'import "./lib.tel" as lib',
    'type P = {x: Num}',
    'pub type Box[T] = {v: T}',
    'd = new Date(0)',
    'ys = [1, 2, 3]',
    'a = ys[1..2]',
    'b = ys[2..]',
    'c = ys[..2]',
    'hit = 2 in ys',
    'print(path, lib, d, a, b, c, hit)',
    '',
  ].join('\n'));
  const once = run(['fmt', modern]);
  assert.equal(once.status, 0, once.stderr);
  const twice = spawnSync(process.execPath, [BIN, 'fmt', '-'], { input: once.stdout, encoding: 'utf8', cwd: ROOT });
  assert.equal(twice.status, 0, twice.stderr);
  assert.equal(twice.stdout, once.stdout, 'fmt not idempotent on modern forms');
});

test('tokens --json matches the cl100k tokenizer on a known string', () => {
  const dir = mkTmp('tel-tokens-');
  const f = writeFile(dir, 'hw.txt', 'hello world');
  const r = run(['tokens', f, '--json']);
  assert.equal(r.status, 0, r.stderr);
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { assert.fail(`tokens --json is not JSON: ${r.stdout}`); }
  const rec = Array.isArray(parsed) ? parsed[0] : (parsed.files?.[0] ?? parsed);
  assert.equal(Number(rec.tokens), 2, r.stdout);
  assert.equal(Number(rec.chars), 11, r.stdout);
  assert.equal(Number(rec.bytes), 11, r.stdout);
  const text = run(['tokens', f]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /TOKENS\tCHARS\tBYTES/);
  assert.match(text.stdout, /\n2\t11\t11\t/);
});

test('build --target js builds a multi-file graph and runs it', { timeout: 60000 }, (t) => {
  if (!codegenSupports('js')) { t.skip('codegen not available yet'); return; }
  const dir = mkTmp('tel-build-js-');
  writeFile(dir, 'lib.tel', 'pub fn add(a: Num, b: Num) -> Num = a + b\n');
  const main = writeFile(dir, 'main.tel', 'import "./lib.tel" as lib\nprint(lib.add(2, 3))\nprint("ok")\n');
  const outdir = path.join(dir, 'dist');
  const quiet = run(['build', main, '--target', 'js', '--outdir', outdir, '--quiet']);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, '', '--quiet must not print');
  assert.ok(fs.existsSync(path.join(outdir, 'main.mjs')), 'entry output missing');
  assert.ok(fs.existsSync(path.join(outdir, 'lib.mjs')), 'module output missing');
  const node = spawnSync(process.execPath, [path.join(outdir, 'main.mjs')], { encoding: 'utf8' });
  assert.equal(node.status, 0, node.stderr);
  assert.equal(node.stdout, '5\nok\n');
});

test('build --target js single file defaults to <name>.mjs and prints it', { timeout: 60000 }, (t) => {
  if (!codegenSupports('js')) { t.skip('codegen not available yet'); return; }
  const dir = mkTmp('tel-build-default-');
  const file = writeFile(dir, 'app.tel', 'print(1 + 2)\n');
  const r = run(['build', file]);
  assert.equal(r.status, 0, r.stderr);
  const out = path.join(dir, 'app.mjs');
  assert.ok(fs.existsSync(out), `expected ${out}: ${r.stdout}`);
  assert.match(r.stdout, /app\.mjs/);
  const node = spawnSync(process.execPath, [out], { encoding: 'utf8' });
  assert.equal(node.stdout, '3\n');
});

test('build --target ts emits typed modules plus one shared runtime', { timeout: 60000 }, (t) => {
  if (!codegenSupports('ts')) { t.skip('codegen not available yet'); return; }
  const dir = mkTmp('tel-build-ts-');
  writeFile(dir, 'lib.tel', 'pub fn add(a: Num, b: Num) -> Num = a + b\n');
  writeFile(dir, 'sub/extra.tel', 'pub fn inc(n: Num) -> Num = n + 1\n');
  const main = writeFile(dir, 'main.tel', [
    'import "./lib.tel" as lib',
    'import "./sub/extra.tel" as extra',
    'print(lib.add(2, 3))',
    'print(extra.inc(41))',
    '',
  ].join('\n'));
  const outdir = path.join(dir, 'out');
  const r = run(['build', main, '--target', 'ts', '--outdir', outdir, '--quiet']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(outdir, 'tel_runtime.ts')), 'shared runtime missing');
  const users = [];
  for (const f of fs.readdirSync(outdir, { recursive: true })) {
    const p = path.join(outdir, String(f));
    if (p.endsWith('.ts') && path.basename(p) !== 'tel_runtime.ts') users.push(p);
  }
  assert.ok(users.length >= 3, `expected entry + modules, got ${JSON.stringify(users)}`);
  for (const p of users) {
    const text = fs.readFileSync(p, 'utf8');
    assert.match(text, /from\s*["'][^"']*tel_runtime\.ts["']/, `${p} does not import the shared runtime`);
  }
  const node = spawnSync(process.execPath, [path.join(outdir, 'main.ts')], { encoding: 'utf8', timeout: 30000 });
  assert.equal(node.status, 0, node.stderr);
  assert.equal(node.stdout, '5\n42\n');
});

test('init copies the guide and gives a runnable starter', (t) => {
  if (!fs.existsSync(GUIDE)) { t.skip('docs/AGENT-GUIDE.md not available yet'); return; }
  const dir = mkTmp('tel-init-');
  const r = run(['init'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'AGENTS.md')));
  assert.ok(fs.readFileSync(path.join(dir, 'AGENTS.md')).equals(fs.readFileSync(GUIDE)), 'init AGENTS.md differs from guide');
  const starter = spawnSync(process.execPath, [BIN, 'run', 'main.tel'], { cwd: dir, encoding: 'utf8' });
  assert.equal(starter.status, 0, starter.stderr);
  assert.match(starter.stdout, /hello from Tel/);
});

test('guide prints docs/AGENT-GUIDE.md', (t) => {
  if (!fs.existsSync(GUIDE)) { t.skip('docs/AGENT-GUIDE.md not available yet'); return; }
  const r = run(['guide']);
  assert.equal(r.status, 0, r.stderr);
  const want = fs.readFileSync(GUIDE, 'utf8');
  assert.ok(r.stdout === want || r.stdout.trimEnd() === want.trimEnd());
  const full = run(['guide', '--full']);
  assert.equal(full.status, 0, full.stderr);
});
