// src/cli.mjs — Tel command line interface.
//
// Commands: run, build (js|web|ts), eval/-e, repl, check, fmt, tokens, init,
// guide, test, help, --version. Every module interface (codegen) is imported
// lazily so the rest of the CLI works while the compiler lands.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Runtime } from './interp.mjs';
import { repr } from '../runtime/tel_rt.mjs';
import { parse } from './parser.mjs';
import { formatSource } from './fmt.mjs';
import { checkSource } from './check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); }
  catch { return { version: '0.0.0' }; }
})();

class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; }
}

class BuildModuleError extends Error {
  constructor(message, { file = null, src = '', line = null, col = null } = {}) {
    super(message);
    this.name = 'BuildModuleError';
    this.file = file;
    this.src = src;
    if (Number.isInteger(line)) this.line = line;
    if (Number.isInteger(col)) this.col = col;
  }
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const ctx = {
    cwd: io.cwd ?? process.cwd(),
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    stdin: io.stdin ?? process.stdin,
  };
  try {
    return await dispatch([...argv], ctx);
  } catch (e) {
    if (e instanceof UsageError) {
      ctx.stderr.write(`tel: ${e.message}\n`);
      ctx.stderr.write("Try 'tel help' for usage.\n");
      return 2;
    }
    ctx.stderr.write((e && e.stack ? e.stack : String(e)) + '\n');
    return 1;
  }
}

async function dispatch(args, ctx) {
  if (!args.length) { printHelp(ctx); return 0; }
  const cmd = args.shift();
  switch (cmd) {
    case 'help': case '--help': case '-h':
      printHelp(ctx); return 0;
    case '--version': case '-v': case 'version':
      ctx.stdout.write(`tel ${PKG.version}\n`); return 0;
    case 'run': return cmdRun(args, ctx);
    case 'build': return cmdBuild(args, ctx);
    case 'eval': case '-e': case '--eval': return cmdEval(args, ctx);
    case 'repl': return cmdRepl(args, ctx);
    case 'check': return cmdCheck(args, ctx);
    case 'fmt': return cmdFmt(args, ctx);
    case 'tokens': return cmdTokens(args, ctx);
    case 'test': return cmdTest(args, ctx);
    case 'init': return cmdInit(args, ctx);
    case 'guide': return cmdGuide(args, ctx);
    default:
      if (cmd.startsWith('-')) throw new UsageError(`unknown option '${cmd}'`);
      throw new UsageError(`unknown command '${cmd}'`);
  }
}

// --- diagnostics ------------------------------------------------------------
export function formatDiagnostic(d, src) {
  const file = d.file || '<input>';
  const line = Number.isInteger(d.line) ? d.line : 1;
  const col = Number.isInteger(d.col) && d.col > 0 ? d.col : 1;
  let out = `${file}:${line}:${col}: ${d.message}`;
  if (src !== null && src !== undefined) {
    const text = String(src).split(/\r?\n/)[line - 1];
    if (text !== undefined) {
      const num = String(line);
      const pad = ' '.repeat(num.length);
      const caret = ' '.repeat(Math.max(0, col - 1));
      out += `\n  ${num} | ${text}\n  ${pad} | ${caret}^`;
    }
  }
  return out;
}

export function formatError(err, file, src) {
  const loc = err && typeof err === 'object' ? err.loc : null;
  const line = Number.isInteger(err?.line) ? err.line : (Number.isInteger(loc?.line) ? loc.line : null);
  if (line === null) {
    const message = err && err.message ? err.message : String(err);
    return `${file || '<input>'}: ${message}`;
  }
  const col = Number.isInteger(err?.col) ? err.col : (Number.isInteger(loc?.col) ? loc.col : 1);
  const message = err && err.message ? err.message : String(err);
  return formatDiagnostic({ file: file || '<input>', line, col, message }, src);
}

function writeError(ctx, file, src, err) {
  ctx.stderr.write(formatError(err, file, src) + '\n');
}

function ioError(ctx, file, err) {
  ctx.stderr.write(`${file}: ${err && err.message ? err.message : String(err)}\n`);
  return 1;
}

function missingFile(ctx, file) {
  ctx.stderr.write(`${file}: No such file or directory\n`);
  return 2;
}

function displayPath(ctx, abs) {
  const rel = path.relative(ctx.cwd, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
}

function isMissingModule(err, needle) {
  if (!err) return false;
  const code = err.code;
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') return false;
  return needle ? String(err.message).includes(needle) : true;
}

function readSource(file) {
  return fs.readFileSync(file, 'utf8');
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); }
  catch { return ''; }
}

// Read all of a context's stdin. Pipes can be non-blocking, so prefer the
// stream's async iterator over fs.readFileSync(0).
async function readInput(ctx) {
  const input = ctx.stdin;
  if (typeof input === 'string') return input;
  if (input && typeof input[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const c of input) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    return Buffer.concat(chunks).toString('utf8');
  }
  return readStdin();
}

// --- help / init / guide ----------------------------------------------------
function printHelp(ctx) {
  ctx.stdout.write([
    'tel — token-efficient language for AI',
    '',
    'Usage:',
    '  tel run FILE [-- ARGS...]',
    '  tel build FILE [-o OUT | --outdir DIR] [--target js|web|ts] [--quiet]',
    '  tel eval "CODE"            (also: tel -e "CODE")',
    '  tel repl',
    '  tel check FILE... [--tsc]',
    '  tel fmt [--write] FILE...',
    '  tel tokens FILE... [--json]',
    '  tel init',
    '  tel guide [--full]',
    '  tel test [DIR]',
    '  tel help | --version',
    '',
  ].join('\n'));
}

const INIT_MAIN = [
  '# Tel starter — run with: tel run main.tel',
  '',
  'fn main():',
  '  print("hello from Tel")',
  '',
].join('\n');

function cmdInit(args, ctx) {
  if (args.length) throw new UsageError('init: takes no arguments');
  const guidePath = guideFile();
  if (!guidePath) {
    ctx.stderr.write('init: docs/AGENT-GUIDE.md not available yet\n');
    return 1;
  }
  const mainPath = path.join(ctx.cwd, 'main.tel');
  const agentsPath = path.join(ctx.cwd, 'AGENTS.md');
  if (!fs.existsSync(mainPath)) {
    fs.writeFileSync(mainPath, INIT_MAIN);
    ctx.stdout.write(`created ${path.relative(ctx.cwd, mainPath) || 'main.tel'}\n`);
  } else {
    ctx.stdout.write('init: main.tel already exists; left unchanged\n');
  }
  fs.writeFileSync(agentsPath, fs.readFileSync(guidePath, 'utf8'));
  ctx.stdout.write(`created ${path.relative(ctx.cwd, agentsPath) || 'AGENTS.md'}\n`);
  return 0;
}

function guideFile() {
  const candidates = [path.join(ROOT, 'docs', 'AGENT-GUIDE.md'), path.join(ROOT, 'AGENTS.md')];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

function cmdGuide(args, ctx) {
  for (const a of args) {
    if (a !== '--full' && a !== '-f') throw new UsageError(`guide: unknown option '${a}'`);
  }
  const p = guideFile();
  if (!p) {
    ctx.stderr.write('guide: docs/AGENT-GUIDE.md not available yet\n');
    return 1;
  }
  ctx.stdout.write(fs.readFileSync(p, 'utf8'));
  return 0;
}

// --- run / eval / repl ------------------------------------------------------
async function cmdRun(args, ctx) {
  let file = null;
  const programArgs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { programArgs.push(...args.slice(i + 1)); break; }
    if (a.startsWith('-') && a !== '-') throw new UsageError(`run: unknown option '${a}'`);
    if (file === null) file = a;
    else programArgs.push(a);
  }
  if (file === null) throw new UsageError('run: missing FILE');
  const abs = path.resolve(ctx.cwd, file);
  if (!fs.existsSync(abs)) return missingFile(ctx, file);
  let src;
  try { src = readSource(abs); } catch (e) { return ioError(ctx, file, e); }
  try {
    const rt = new Runtime({ file: abs, args: programArgs });
    await rt.runFile(abs, { args: programArgs });
    return 0;
  } catch (e) {
    // Errors raised inside imported modules carry that module's line/col.
    writeError(ctx, abs, src, e);
    return 1;
  }
}

async function cmdEval(args, ctx) {
  if (!args.length) throw new UsageError('eval: missing CODE argument');
  if (args.length > 1) throw new UsageError(`eval: unexpected extra argument '${args[1]}'`);
  const code = args[0];
  try {
    const rt = new Runtime({ args: [] });
    const r = await rt.runSource(code, { file: '<eval>' });
    if (r.value !== null && r.value !== undefined) ctx.stdout.write(repr(r.value) + '\n');
    return 0;
  } catch (e) {
    ctx.stderr.write(formatError(e, '<eval>', code) + '\n');
    return 1;
  }
}

function isIncomplete(e) {
  if (!e || (e.name !== 'ParseError' && e.name !== 'LexError')) return false;
  const m = String(e.message || '');
  return /unterminated|end of file|expected indent|unexpected indent/i.test(m);
}

async function cmdRepl(args, ctx) {
  if (args.length) throw new UsageError('repl: takes no arguments');
  const terminal = Boolean(ctx.stdin && ctx.stdin.isTTY);
  const rl = readline.createInterface({ input: ctx.stdin, output: ctx.stdout, terminal, prompt: 'tel> ' });
  const rt = new Runtime({ args: [] });
  let env = null;
  let buf = '';
  const writeResult = (v) => { if (v !== null && v !== undefined) ctx.stdout.write(repr(v) + '\n'); };
  const prompt = () => { if (terminal) ctx.stdout.write(buf ? '... ' : 'tel> '); };

  const runBuf = async () => {
    try {
      const r = await rt.runSource(buf, env ? { env } : {});
      env = r.env;
      writeResult(r.value);
    } catch (e) {
      ctx.stderr.write(formatError(e, '<repl>', buf) + '\n');
    }
    buf = '';
  };

  try {
    prompt();
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!buf && (trimmed === '.exit' || trimmed === '.quit')) break;
      if (!buf && trimmed === '.help') {
        ctx.stdout.write('REPL: .exit/.quit to leave; .help for help. Multi-line blocks continue on indent.\n');
        prompt();
        continue;
      }
      if (!buf && !trimmed) { prompt(); continue; }
      buf = buf ? buf + '\n' + line : line;
      let incomplete = false;
      try { parse(buf, { src: buf, file: '<repl>' }); }
      catch (e) { incomplete = isIncomplete(e); }
      if (incomplete) { prompt(); continue; }
      await runBuf();
      prompt();
    }
    if (buf.trim()) await runBuf();
  } finally {
    rl.close();
  }
  return 0;
}

// --- check ------------------------------------------------------------------
function runTsc(ctx) {
  const tsconfig = path.join(ctx.cwd, 'tsconfig.json');
  if (!fs.existsSync(tsconfig)) {
    ctx.stderr.write('check: --tsc: no tsconfig.json in cwd; skipped TypeScript check\n');
    return 0;
  }
  const r = spawnSync('tsc', ['--noEmit', '--project', '.'], { cwd: ctx.cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) {
    ctx.stderr.write(`check: --tsc: tsc could not run (${r.error.code || r.error.message}); skipped TypeScript check\n`);
    return 0;
  }
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0) {
    if (out.trim()) ctx.stdout.write(out);
    return 0;
  }
  if (/TS18003|No inputs were found/i.test(out)) {
    ctx.stderr.write('check: --tsc: no TypeScript inputs found; skipped TypeScript check\n');
    return 0;
  }
  if (out) ctx.stderr.write(out);
  return r.status ?? 1;
}

async function cmdCheck(args, ctx) {
  let tsc = false;
  const files = [];
  for (const a of args) {
    if (a === '--tsc') tsc = true;
    else if (a.startsWith('-') && a !== '-') throw new UsageError(`check: unknown option '${a}'`);
    else files.push(a);
  }
  if (!files.length) throw new UsageError('check: missing FILE...');
  let failed = false;
  let missing = false;
  for (const file of files) {
    const stdinMode = file === '-';
    const abs = stdinMode ? '<stdin>' : path.resolve(ctx.cwd, file);
    let src;
    if (stdinMode) {
      src = await readInput(ctx);
    } else if (!fs.existsSync(abs)) {
      ctx.stderr.write(`${file}: No such file or directory\n`);
      missing = true;
      continue;
    } else {
      try { src = readSource(abs); } catch (e) { ioError(ctx, file, e); failed = true; continue; }
    }
    let diags;
    try {
      diags = checkSource(src, { file: stdinMode ? null : abs });
    } catch (e) {
      ctx.stderr.write(formatError(e, abs, src) + '\n');
      failed = true;
      continue;
    }
    for (const d of diags) ctx.stderr.write(formatDiagnostic(d, src) + '\n');
    if (diags.length) failed = true;
  }
  if (tsc && runTsc(ctx) !== 0) failed = true;
  if (missing) return 2;
  return failed ? 1 : 0;
}

// --- fmt --------------------------------------------------------------------
async function cmdFmt(args, ctx) {
  let write = false;
  const files = [];
  for (const a of args) {
    if (a === '--write' || a === '-w') write = true;
    else if (a.startsWith('-') && a !== '-') throw new UsageError(`fmt: unknown option '${a}'`);
    else files.push(a);
  }
  if (!files.length) throw new UsageError('fmt: missing FILE...');
  if (write && files.includes('-')) throw new UsageError("fmt: cannot use --write with '-' (stdin)");
  let failed = false;
  let missing = false;
  for (const file of files) {
    const stdinMode = file === '-';
    const abs = stdinMode ? '<stdin>' : path.resolve(ctx.cwd, file);
    let src;
    if (stdinMode) src = await readInput(ctx);
    else if (!fs.existsSync(abs)) { ctx.stderr.write(`${file}: No such file or directory\n`); missing = true; continue; }
    else { try { src = readSource(abs); } catch (e) { ioError(ctx, file, e); failed = true; continue; } }
    let out;
    try { out = formatSource(src, { src, file: abs }); }
    catch (e) { ctx.stderr.write(formatError(e, abs, src) + '\n'); failed = true; continue; }
    if (write) {
      if (out !== src) fs.writeFileSync(abs, out);
    } else {
      ctx.stdout.write(out);
    }
  }
  if (missing) return 2;
  return failed ? 1 : 0;
}

// --- tokens -----------------------------------------------------------------
let tokcountPromise = null;
function loadTokcount() {
  if (!tokcountPromise) {
    tokcountPromise = import('../tools/tokcount.mjs').catch((e) => {
      if (isMissingModule(e, 'tools/tokcount.mjs')) return null;
      throw e;
    });
  }
  return tokcountPromise;
}

async function tokensForFile(ctx, file) {
  if (file === '-') {
    const src = await readInput(ctx);
    return { path: '-', chars: src.length, bytes: Buffer.byteLength(src, 'utf8'), tokens: countTokensFallback(src) };
  }
  const abs = path.resolve(ctx.cwd, file);
  if (!fs.existsSync(abs)) {
    const err = new Error('No such file or directory');
    err.code = 'ENOENT';
    throw err;
  }
  const tool = await loadTokcount();
  if (tool && typeof tool.countFiles === 'function') {
    const [rec] = tool.countFiles([abs]);
    if (rec) return { path: rec.path ?? file, chars: rec.chars, bytes: rec.bytes, tokens: rec.tokens };
  }
  const src = readSource(abs);
  return { path: file, chars: src.length, bytes: Buffer.byteLength(src, 'utf8'), tokens: countTokensFallback(src) };
}

async function cmdTokens(args, ctx) {
  let json = false;
  const files = [];
  for (const a of args) {
    if (a === '--json') json = true;
    else if (a.startsWith('-') && a !== '-') throw new UsageError(`tokens: unknown option '${a}'`);
    else files.push(a);
  }
  if (!files.length) throw new UsageError('tokens: missing FILE...');
  const entries = [];
  for (const file of files) {
    try { entries.push(await tokensForFile(ctx, file)); }
    catch (e) {
      if (e && e.code === 'ENOENT') { ctx.stderr.write(`${file}: No such file or directory\n`); return 2; }
      ctx.stderr.write(`${file}: ${e.message || e}\n`);
      return 1;
    }
  }
  if (json) {
    ctx.stdout.write(JSON.stringify(entries, null, 2) + '\n');
    return 0;
  }
  const total = entries.reduce((acc, e) => ({ chars: acc.chars + e.chars, bytes: acc.bytes + e.bytes, tokens: acc.tokens + e.tokens }), { chars: 0, bytes: 0, tokens: 0 });
  ctx.stdout.write('TOKENS\tCHARS\tBYTES\tPATH\n');
  for (const e of entries) ctx.stdout.write(`${e.tokens}\t${e.chars}\t${e.bytes}\t${e.path}\n`);
  if (entries.length > 1) ctx.stdout.write(`${total.tokens}\t${total.chars}\t${total.bytes}\tTOTAL\n`);
  return 0;
}

// cl100k_base BPE fallback, used until tools/tokcount.mjs exists.
const VOCAB_PATH = path.join(ROOT, 'tools', 'vocab', 'cl100k_base.tiktoken');
const CL100K_SOURCE = "'(?:s|t|re|ve|m|ll|d)|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+";
let rankCache;
function loadRanks() {
  if (rankCache !== undefined) return rankCache;
  try {
    const text = fs.readFileSync(VOCAB_PATH, 'utf8');
    const map = new Map();
    for (const line of text.split('\n')) {
      if (!line) continue;
      const sp = line.indexOf(' ');
      if (sp < 0) continue;
      map.set(Buffer.from(line.slice(0, sp), 'base64').toString('latin1'), Number(line.slice(sp + 1)));
    }
    rankCache = map;
  } catch {
    rankCache = null;
  }
  return rankCache;
}

function bpeCount(piece, ranks) {
  if (!piece) return 0;
  const parts = [...Buffer.from(piece, 'utf8').toString('latin1')];
  while (parts.length > 1) {
    let bestIdx = -1;
    let bestRank = Infinity;
    for (let i = 0; i < parts.length - 1; i++) {
      const r = ranks.get(parts[i] + parts[i + 1]);
      if (r !== undefined && r < bestRank) { bestRank = r; bestIdx = i; }
    }
    if (bestIdx < 0) break;
    parts.splice(bestIdx, 2, parts[bestIdx] + parts[bestIdx + 1]);
  }
  return parts.length;
}

export function countTokensFallback(text) {
  const ranks = loadRanks();
  if (!ranks) throw new Error('tokenizer unavailable (tools/vocab/cl100k_base.tiktoken missing)');
  const s = String(text);
  if (!s) return 0;
  const re = new RegExp(CL100K_SOURCE, 'giu');
  let total = 0;
  for (const m of s.matchAll(re)) total += bpeCount(m[0], ranks);
  return total;
}

// --- test -------------------------------------------------------------------
function cmdTest(args, ctx) {
  const nodeArgs = args.length ? args : ['test'];
  const r = spawnSync(process.execPath, ['--test', ...nodeArgs], { cwd: ctx.cwd, stdio: 'inherit' });
  if (r.error) {
    ctx.stderr.write(`test: ${r.error.message}\n`);
    return 1;
  }
  return r.status ?? 1;
}

// --- build ------------------------------------------------------------------
async function loadCodegen() {
  let mod;
  try { mod = await import('./codegen.mjs'); }
  catch (e) {
    if (isMissingModule(e, 'codegen.mjs')) throw new UsageError('codegen not available yet (src/codegen.mjs is missing)');
    throw e;
  }
  if (typeof mod.compileProgram !== 'function') {
    throw new UsageError('codegen not available yet (src/codegen.mjs does not export compileProgram)');
  }
  return mod;
}

async function cmdBuild(args, ctx) {
  let file = null;
  let out = null;
  let outdir = null;
  let target = 'js';
  let quiet = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '--out' || a === '--output') {
      if (i + 1 >= args.length) throw new UsageError(`build: ${a} requires a path`);
      out = args[++i];
    } else if (a === '--outdir' || a === '-d') {
      if (i + 1 >= args.length) throw new UsageError('build: --outdir requires a directory');
      outdir = args[++i];
    } else if (a === '--target' || a === '-t') {
      if (i + 1 >= args.length) throw new UsageError('build: --target requires js, web or ts');
      target = args[++i];
      if (!['js', 'web', 'ts'].includes(target)) throw new UsageError(`build: --target must be js, web or ts, got '${target}'`);
    } else if (a === '--quiet' || a === '-q') {
      quiet = true;
    } else if (a.startsWith('-') && a !== '-') {
      throw new UsageError(`build: unknown option '${a}'`);
    } else if (file === null) {
      file = a;
    } else {
      throw new UsageError(`build: unexpected extra argument '${a}'`);
    }
  }
  if (file === null) throw new UsageError('build: missing FILE');
  if (out && outdir) throw new UsageError('build: cannot combine -o and --outdir');
  const entryAbs = path.resolve(ctx.cwd, file);
  if (!fs.existsSync(entryAbs)) return missingFile(ctx, file);

  let codegen;
  try { codegen = await loadCodegen(); }
  catch (e) {
    if (e instanceof UsageError) { ctx.stderr.write(e.message + '\n'); return 1; }
    throw e;
  }
  if (target === 'ts' && typeof codegen.compileRuntime !== 'function') {
    ctx.stderr.write('codegen not available yet (src/codegen.mjs does not export compileRuntime; --target ts unavailable)\n');
    return 1;
  }

  let modules;
  try { modules = collectModules(entryAbs); }
  catch (e) {
    if (e instanceof BuildModuleError) { writeError(ctx, e.file, e.src, e); return 1; }
    throw e;
  }

  const ext = target === 'ts' ? '.ts' : '.mjs';
  const outputs = planOutputs(entryAbs, modules, { out, outdir, ext, ctx });
  try {
    checkOutputCollisions(outputs, ctx);
  } catch (e) {
    if (e instanceof BuildModuleError) { ctx.stderr.write(e.message + '\n'); return 1; }
    throw e;
  }

  const runtimeOut = target === 'ts' ? runtimeOutputPath(entryAbs, { out, outdir, ctx }) : null;
  for (const m of modules) {
    const outPath = outputs.get(m.abs);
    try {
      const opts = {
        target,
        entry: m.abs === entryAbs,
        file: m.abs,
        importSpecifier: makeImportSpecifier(m.abs, outputs, ext),
      };
      if (target === 'ts') opts.runtimeModule = relativeSpecifier(path.dirname(outPath), runtimeOut);
      const text = codegen.compileProgram(m.program, opts);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, text.endsWith('\n') ? text : text + '\n');
      if (!quiet) ctx.stdout.write(displayPath(ctx, outPath) + '\n');
    } catch (e) {
      writeError(ctx, m.abs, m.src, e);
      return 1;
    }
  }

  if (target === 'ts') {
    try {
      const text = codegen.compileRuntime({ target: 'ts' });
      fs.mkdirSync(path.dirname(runtimeOut), { recursive: true });
      fs.writeFileSync(runtimeOut, text.endsWith('\n') ? text : text + '\n');
      if (!quiet) ctx.stdout.write(displayPath(ctx, runtimeOut) + '\n');
    } catch (e) {
      writeError(ctx, entryAbs, modules.find((m) => m.abs === entryAbs)?.src ?? '', e);
      return 1;
    }
  }
  return 0;
}

function importFileSpec(st) {
  if (st.kind === 'std') return null;
  if (st.kind === 'js') return null;
  if (st.kind === 'tel') return st.file ?? st.spec ?? null;
  // Older ASTs without `kind`.
  if (st.file && String(st.file).endsWith('.tel')) return st.file;
  if (st.path && !String(st.path).startsWith('std')) return st.path;
  return null;
}

function collectImportNodes(program) {
  const out = [];
  const seen = new WeakSet();
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    if (n.type === 'Import') { out.push(n); return; }
    for (const [k, v] of Object.entries(n)) {
      if (k === 'line' || k === 'col' || k === 'raw' || k === 'start' || k === 'end') continue;
      if (v && typeof v === 'object') walk(v);
    }
  })(program);
  return out;
}

function collectModules(entryAbs) {
  const seen = new Set();
  const modules = [];
  const queue = [entryAbs];
  while (queue.length) {
    const abs = queue.shift();
    if (seen.has(abs)) continue;
    seen.add(abs);
    let src = '';
    try { src = fs.readFileSync(abs, 'utf8'); }
    catch (e) { throw new BuildModuleError(e.message, { file: abs, src: '' }); }
    let program;
    try { program = parse(src, { src, file: abs }); }
    catch (e) { throw new BuildModuleError(e.message, { file: abs, src, line: e.line, col: e.col }); }
    modules.push({ abs, src, program });
    for (const st of collectImportNodes(program)) {
      const spec = importFileSpec(st);
      if (!spec) continue;
      const depAbs = path.resolve(path.dirname(abs), spec);
      if (!fs.existsSync(depAbs)) {
        throw new BuildModuleError(`cannot find module '${spec}'`, { file: abs, src, line: st.line, col: st.col });
      }
      queue.push(depAbs);
    }
  }
  return modules;
}

function relToOutput(rel, ext) {
  const dir = path.dirname(rel);
  const base = path.basename(rel, path.extname(rel)) + ext;
  return dir === '.' ? base : path.join(dir, base);
}

function planOutputs(entryAbs, modules, { out, outdir, ext, ctx }) {
  const map = new Map();
  const entryDir = path.dirname(entryAbs);
  if (out) {
    const outAbs = path.resolve(ctx.cwd, out);
    map.set(entryAbs, outAbs);
    for (const m of modules) {
      if (m.abs === entryAbs) continue;
      let rel = path.relative(entryDir, m.abs);
      if (rel.startsWith('..')) rel = path.basename(m.abs);
      map.set(m.abs, path.resolve(path.dirname(outAbs), relToOutput(rel, ext)));
    }
    return map;
  }
  const dir = outdir ? path.resolve(ctx.cwd, outdir) : null;
  for (const m of modules) {
    if (!dir) { map.set(m.abs, path.join(path.dirname(m.abs), path.basename(m.abs, path.extname(m.abs)) + ext)); continue; }
    let rel = path.relative(entryDir, m.abs);
    if (rel.startsWith('..')) rel = path.basename(m.abs);
    map.set(m.abs, path.resolve(dir, relToOutput(rel, ext)));
  }
  return map;
}

function runtimeOutputPath(entryAbs, { out, outdir, ctx }) {
  if (out) return path.join(path.dirname(path.resolve(ctx.cwd, out)), 'tel_runtime.ts');
  if (outdir) return path.join(path.resolve(ctx.cwd, outdir), 'tel_runtime.ts');
  return path.join(path.dirname(entryAbs), 'tel_runtime.ts');
}

function checkOutputCollisions(outputs, ctx) {
  const byOut = new Map();
  for (const [src, out] of outputs) {
    if (byOut.has(out) && byOut.get(out) !== src) {
      const a = displayPath(ctx, byOut.get(out));
      const b = displayPath(ctx, src);
      throw new BuildModuleError(`output collision: '${a}' and '${b}' both map to '${displayPath(ctx, out)}'`);
    }
    byOut.set(out, src);
  }
}

function relativeSpecifier(fromDir, toFile) {
  let rel = path.relative(fromDir, toFile).split(path.sep).join('/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

function makeImportSpecifier(curAbs, outputs, ext) {
  const curOut = outputs.get(curAbs);
  return (p) => {
    let abs = String(p);
    if (!path.isAbsolute(abs)) abs = path.resolve(path.dirname(curAbs), abs);
    let target = outputs.get(abs);
    if (!target) {
      const base = path.basename(abs, path.extname(abs)) + ext;
      target = path.join(path.dirname(curOut), base);
    }
    return relativeSpecifier(path.dirname(curOut), target);
  };
}
