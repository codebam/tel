#!/usr/bin/env node
// Exact cl100k_base BPE counter, zero dependencies.
// Vocab: tools/vocab/cl100k_base.tiktoken (base64 token + rank per line).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_VOCAB = path.join(HERE, 'vocab', 'cl100k_base.tiktoken');

// --- GPT-2 byte <-> unicode mapping ---------------------------------------
// Printable bytes map to themselves; the rest map to U+0100.. so every byte is
// one unicode code point and tokens stay lossless strings.
function buildByteMap() {
  const visible = [];
  for (let b = 0x21; b <= 0x7e; b++) visible.push(b); // '!'..'~'
  for (let b = 0xa1; b <= 0xac; b++) visible.push(b); // '¡'..'¬'
  for (let b = 0xae; b <= 0xff; b++) visible.push(b); // '®'..'ÿ'
  const slot = new Array(256);
  for (const b of visible) slot[b] = b;
  let extra = 0;
  const present = new Set(visible);
  for (let b = 0; b < 256; b++) {
    if (!present.has(b)) slot[b] = 256 + extra++;
  }
  return slot.map((cp) => String.fromCodePoint(cp));
}
const BYTE_TO_UNICODE = buildByteMap();

// --- cl100k_base pretokenization regex ------------------------------------
// JS-compatible form of tiktoken's cl100k pattern. `//iu` is required for
// \p{...}; `i` also covers the contraction alternatives.
export const SPLIT_RE = /'s|'t|'re|'ve|'m|'ll|'d|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/giu;

// --- vocab + BPE -----------------------------------------------------------
let RANKS = null;

export function loadVocab(vocabPath = DEFAULT_VOCAB) {
  if (RANKS && vocabPath === DEFAULT_VOCAB) return RANKS;
  const text = fs.readFileSync(vocabPath, 'utf8');
  const ranks = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const bytes = Buffer.from(line.slice(0, sp), 'base64');
    let token = '';
    for (const b of bytes) token += BYTE_TO_UNICODE[b];
    ranks.set(token, Number(line.slice(sp + 1)));
  }
  if (vocabPath === DEFAULT_VOCAB) RANKS = ranks;
  return ranks;
}

function byteEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  for (const b of bytes) out += BYTE_TO_UNICODE[b];
  return out;
}

// Merge the adjacent pair with the lowest vocab rank until no pair is known.
function bpe(token, ranks) {
  let parts = Array.from(token);
  if (parts.length < 2) return parts;
  for (;;) {
    let best = -1;
    let bestRank = Infinity;
    for (let i = 0; i < parts.length - 1; i++) {
      const rank = ranks.get(parts[i] + parts[i + 1]);
      if (rank !== undefined && rank < bestRank) {
        bestRank = rank;
        best = i;
      }
    }
    if (best < 0) return parts;
    parts = [...parts.slice(0, best), parts[best] + parts[best + 1], ...parts.slice(best + 2)];
  }
}

export function countTokens(text, { vocabPath = DEFAULT_VOCAB } = {}) {
  const ranks = loadVocab(vocabPath);
  const s = String(text);
  let total = 0;
  for (const m of s.matchAll(SPLIT_RE)) {
    total += bpe(byteEncode(m[0]), ranks).length;
  }
  return total;
}

export function countFiles(paths, opts = {}) {
  return paths.map((p) => {
    const text = fs.readFileSync(p, 'utf8');
    return {
      path: p,
      chars: Array.from(text).length,
      bytes: Buffer.byteLength(text, 'utf8'),
      tokens: countTokens(text, opts),
    };
  });
}

// --- CLI -------------------------------------------------------------------
function usage() {
  console.error('usage: node tools/tokcount.mjs FILE... [--json]');
}

function main(argv) {
  const json = argv.includes('--json');
  const paths = argv.filter((a) => a !== '--json');
  if (argv.includes('-h') || argv.includes('--help')) {
    usage();
    return 0;
  }
  if (paths.length === 0) {
    usage();
    return 2;
  }
  for (const p of paths) {
    if (!fs.existsSync(p)) {
      console.error(`tokcount: no such file: ${p}`);
      return 2;
    }
  }
  const rows = countFiles(paths);
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  const width = Math.max(4, ...rows.map((r) => r.path.length));
  console.log(`${'path'.padEnd(width)}  ${'chars'.padStart(8)}  ${'bytes'.padStart(8)}  ${'tokens'.padStart(8)}`);
  for (const r of rows) {
    console.log(`${r.path.padEnd(width)}  ${String(r.chars).padStart(8)}  ${String(r.bytes).padStart(8)}  ${String(r.tokens).padStart(8)}`);
  }
  if (rows.length > 1) {
    const t = rows.reduce((a, r) => ({ chars: a.chars + r.chars, bytes: a.bytes + r.bytes, tokens: a.tokens + r.tokens }), { chars: 0, bytes: 0, tokens: 0 });
    console.log(`${'total'.padEnd(width)}  ${String(t.chars).padStart(8)}  ${String(t.bytes).padStart(8)}  ${String(t.tokens).padStart(8)}`);
  }
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
