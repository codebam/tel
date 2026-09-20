# Tel v0.1 + v0.2 — Independent Verification Report

- Verifier: **verify-eng** (shared task `task-4`)
- Date: 2026-09-20
- Product tree verified: commit `ae2ed95` (`main`), Node **v26.9.0**, Linux x86_64, Python 3 (for the token-benchmark equivalence checks)
- Verifier artifacts: `test/verify.test.mjs` (independent suite, **79 tests**) and this report
- Method: read `docs/PLAN.md` (v0.2), `docs/SPEC.md`, `docs/AGENT-GUIDE.md` and the product sources; authored fresh programs in temp dirs (never copied from `examples/`); compared interpreter, `--target js`, `--target web` and `--target ts`; probed adversarial inputs; measured every numeric claim with `tools/tokcount.mjs`; recorded command + raw output/exit code for each claim. No product files were modified by the verifier.

## 0. Bottom line

| Check | Result |
|---|---|
| Full project suite `node --test test/` | **94 tests, 93 pass, 0 fail, 1 skip** (`tsc` not installed) |
| Independent suite `node --test test/verify.test.mjs` | **79 tests, 78 pass, 0 fail, 1 skip** (`tsc` not installed) |
| PLAN v0.1 acceptance commands | **PASS** |
| PLAN v0.2 acceptance criteria (task-4 items 1–5) | **PASS**, except the `tsc --noEmit` sub-check, which is **BLOCKED** (no `tsc` on PATH; cannot provision it in this sandbox) |
| Bugs filed by verifier | **19** (V1–V19): 18 product bugs, 1 docs/impl mismatch; **all fixed/amended and regression-tested; 0 open** |
| Adversarial checks (malformed input, cycles, deep nesting) | **PASS** — no hangs; malformed input exits non-zero with `file:line:col` + caret |

## 1. Test suite results (raw)

```
$ node --test test/
...
ℹ tests 94
ℹ suites 0
ℹ pass 93
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 35667.965733

$ node --test test/verify.test.mjs
...
ℹ tests 79
ℹ suites 0
ℹ pass 78
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 35718.468928
```

The single skip is `v0.2 compiler: tsc --noEmit accepts emitted user modules (if tsc present)` — see §6.1. Everything else executes.

## 2. v0.1 acceptance (PLAN, still applicable)

| Criterion | Evidence (exact commands run) | Result |
|---|---|---|
| `tel run` executes examples; `main(args)` + `--` args | `node bin/tel.mjs run examples/basics.tel`, `algo`, `pipeline`, `tour`, `interop` all exit 0; `examples/server.tel` prints `tel api listening on http://127.0.0.1:46661` then stays up (killed by design); `examples/express.tel` prints the documented skip because express is not installed, exit 0 | PASS |
| Interpreter public API (`new Runtime`, `runSource`, `runFile`) | `test/verify.test.mjs`: arithmetic/precedence, strings/interpolation, ambient bindings/compound assignment, arrays/records/slices, destructuring, match/guards/patterns, types/unions/generics/`is`, `_` lambdas + UFCS, `?`, try/catch/finally, ranges/comprehensions, recursion/closures, explicit `return`, `??`/`??=`, optional chains, async/await + async `main`, args, relative imports + `std` namespaces, empty/deep programs | PASS |
| CLI surface and exit codes | `--version` (exit 0, `tel 0.1.0`), `help`, `run`, `eval`/`-e`, `repl` (piped `1 + 2` → `3`), `fmt` round-trip + `--write` idempotence, `tokens`, `check`, `test` pass-through, `init`, `guide`; missing file/unknown flag → exit 2; parse/runtime error → exit 1; parse errors print `file:line:col` + caret | PASS |
| `build --target js` output is standalone and matches interpreter stdout | Built every Node-runnable example and each of 8 authored parity programs, ran with plain `node`, diffed stdout against `tel run`: identical; generated JS only imports `node:*` or relative emitted modules and never the project’s `src/`/`runtime/` | PASS |
| `build --target web` exports `__tel`, SSR works, no document needed | `node bin/tel.mjs build examples/web.tel --target web -o /tmp/web.mjs` then `__tel.html(App())` → `<div class="app"><h1>Counter 0</h1><button>+</button></div>`; importing the module in Node does not attempt to mount | PASS |
| Multi-file import graph | Authored `lib.tel` + `main.tel` in `/tmp`, built with `--target js`, ran plain `node`, stdout matched interpreter (`5`/`16`); relative modules emitted/imported correctly | PASS |
| Token counter exactness | Independently decoded `tools/vocab/cl100k_base.tiktoken` and checked ranks `hello`=15339, ` world`=1917, `Hello`=9906; `countTokens('hello world')===2`, `''===0`, `'hello'===1`, `'Hello world'===2`; `countFiles` chars/bytes/tokens exact | PASS |
| Error formatting / no hangs | Malformed programs (unbalanced, unterminated string, bad indent, bad block comment, `x = = 1`, unbalanced imports, bad `new`) all exit non-zero with `file:line:col` + caret and no timeout; empty file exit 0; 500-deep parens and 300-term chains run; undefined name, no-arm `match` and non-function calls are clean located errors | PASS |
| Zero toolchain deps | `package.json` has no dependencies; runtime uses only `node:` builtins | PASS |

Representative raw outputs:

```
$ node bin/tel.mjs run examples/basics.tel
== functions ==
add(2, 3) = 5
describe(7) = odd
...
[exit=0]

$ node bin/tel.mjs build examples/basics.tel --target js -o /tmp/basics.mjs
/tmp/basics.mjs
[exit=0]
$ node /tmp/basics.mjs        # byte-identical stdout to the interpreter run above
[exit=0]

$ node bin/tel.mjs check examples/basics.tel examples/tour.tel examples/algo.tel
[exit=0]

$ node bin/tel.mjs tokens examples/basics.tel AGENTS.md
TOKENS  CHARS   BYTES   PATH
713     1997    1997    .../examples/basics.tel
2193    6778    6778    .../AGENTS.md
2906    8775    8775    TOTAL
[exit=0]
```

## 3. v0.2 acceptance (task-4 criteria)

### 3.1 `tel check` is a real checker — PASS

Catches all required classes, with `file:line:col` and caret, exit 1:

```
$ node bin/tel.mjs check undefined.tel
/tmp/.../undef.tel:1:1: undefined identifier 'nope'
  1 | x = nope + 1
    | ^
[exit=1]

$ node bin/tel.mjs check arity.tel
/tmp/.../arity.tel:2:7: fn 'add' expects 2 argument(s), got 1
  2 | print(add(1))
    |       ^
[exit=1]

$ node bin/tel.mjs check break.tel
/tmp/.../break.tel:1:1: break outside of a loop
...
$ node bin/tel.mjs check dup.tel
/tmp/.../dup.tel:1:1: duplicate parameter 'a'
...
$ node bin/tel.mjs check ret.tel
/tmp/.../ret.tel:1:1: return outside of a function
[exit=1 each]
```

No false positives: builtins/`std.math`/record types, JS alias imports, JS named imports and `import "node:path" * as ns` all pass `tel check` with exit 0. Import cycles (`a.tel ↔ b.tel`) return within the 10 s timeout, status 0/1. Malformed import/`new` forms are located parse errors.
`tel check --tsc` degrades cleanly without `tsc`: `check: --tsc: no tsconfig.json in cwd; skipped TypeScript check` / `tsc not found on PATH; skipped TypeScript check`, exit 0.

### 3.2 `--target ts` typed, runnable, one shared runtime — PASS (with `tsc` sub-check blocked)

```
$ node bin/tel.mjs build examples/basics.tel --target ts --outdir /tmp/telts
/tmp/telts/basics.ts
/tmp/telts/tel_runtime.ts
[exit=0]
$ node /tmp/telts/basics.ts     # stdout byte-identical to `tel run examples/basics.tel`
[exit=0]
```

- A 3-module project (`main.tel` importing `./lib.tel` and `./sub/extra.tel`), built to an outdir, runs with plain `node main.ts` (Node type stripping) and matches the interpreter (`5`/`42`/`true`).
- Every emitted user module contains exactly one `import ... from ".../tel_runtime.ts"` that resolves to the single shared `tel_runtime.ts`; no user module contains `// @ts-nocheck`, no user module inlines runtime code.
- Nested import paths resolve (`../tel_runtime.ts`), and all six Node-runnable examples build to TS and run under plain `node`.
- `tsc --noEmit` was **not** run: `tsc` is absent from PATH and cannot be provisioned (see §6.1). This is the one blocked sub-criterion.

### 3.3 JS/npm interop — PASS

One authored project is run under `tel run`, `--target js` and `--target ts` with identical stdout `a/b / b/c / 42 / 42 / 10 / 12 / dflt 12 / mixed 12 / 1970 / 2 / 1970 / interop-data`:

```
$ node bin/tel.mjs run /tmp/.../main.tel
a/b
42 d
1970
[exit=0]
$ node bin/tel.mjs build main.tel --target js -o main.mjs && node main.mjs
a/b
42 d
1970
[exit=0]
$ node bin/tel.mjs build main.tel --target ts --outdir . && node main.ts
a/b
42 d
1970
[exit=0]
```

Covered: `import "node:path"` alias/named/`* as`; `import "node:fs/promises"` + `await`; local `./helper.js` with named-only, default-only and default+named exports; `new Date(0)` + native prototype methods (`d.getUTCFullYear()`); `new Counter().inc()` chains; `new URLSearchParams` callback + `forEach`; Tel lambdas passed into JS `applyTwice`; optional chaining on JS values; record constructors tag `__t` (`P(x=4,y=5) is P` → true) in interpreter/js/ts.

### 3.4 AGENTS.md — PASS

- Root `AGENTS.md` is byte-identical to `docs/AGENT-GUIDE.md` (`cmp` clean).
- Budget: `node tools/tokcount.mjs AGENTS.md docs/AGENT-GUIDE.md` → `AGENTS.md 6778 chars / 2193 tokens` (budget 2200).
- All **10/10** fenced `tel` snippets parse, execute through `tel run` (the HTTP program is allowed to keep serving after printing its bound port) and build to js.
- `tel guide` (and `--full`) prints the guide; `tel init` in a fresh temp dir creates `main.tel` + byte-identical `AGENTS.md`, and the starter runs.

### 3.5 Adversarial — PASS

| Check | Observation |
|---|---|
| Checker import cycle | returns < 10 s, clean status, no hang |
| Nested TS import paths | correct relative runtime imports, plain `node` run |
| Malformed `import`/`new` forms | non-zero exit with `file:line:col` + caret for `import 5 as x`, `import "node:path" as`, `x = new`, `x = new 5`, `import "node:path" {join` |
| Fence/execute | 10/10 AGENT fences, 26/26 SPEC snippets run clean (per examples-eng harness, re-checked in project suite) |
| No unresolved runtime names | compiled JS/TS stderr clean of `is not defined`; `tour.tel` regression fixed |

## 4. Bug list (all reported by verify-eng; all fixed and regression-tested)

| ID | Sev | File (owner) | Symptom / repro | Regression test |
|---|---|---|---|---|
| V1 | HIGH | `src/interp.mjs` (lead) | explicit `return` leaked internal `ReturnSignal`, crashing `runSource`/`runFile` | `interp: explicit return exits a function with its value` |
| V2 | HIGH | `runtime/tel_rt.mjs` | array patterns without rest threw `TypeError: tail is not iterable` | `interp: destructuring patterns`, `interp: structural patterns` |
| V3 | HIGH | `src/parser.mjs` | `xs[1..3]` parsed as index-by-Range, silently returned first element | `interp: arrays, indexing, slices and records` |
| V4 | MED | `src/parser.mjs` / `src/interp.mjs` | runtime `.loc` was the AST node; no `{line,col}`; no-arm match plain Error; top-level `?` leaked `Early` | `runtime errors carry ... location`, `match with no matching arm`, `top-level ? must not leak ...` |
| V5 | LOW | `src/interp.mjs` | map comprehension evaluated literal key string as AST → “cannot evaluate undefined” | `spec: slices, ranges and comprehensions` |
| V6 | LOW | `src/parser.mjs` | `pub type X = ...` failed with “expected fn after modifiers” | `interp: import graph via runFile` asserts `pub type Vec` export |
| V7 | LOW | `src/parser.mjs` | first-element array spread `[...a, 3]` failed to parse | `spec: spread, records and tuples` |
| V8 | LOW | `runtime/tel_rt.mjs` | `catch e: print(e)` for a JS `Error` printed `{}` | `interp: try/catch/throw and finally` asserts `e.message` → `oops` |
| V9 | LOW | `src/interp.mjs` | missing record field returned the UFCS dispatcher (`<fn>`) | `spec: spread, records and tuples` (missing field is nil) |
| V10 | MED | `src/lexer.mjs` | `#[ ... ]#` at line start was treated as a line comment; body parsed as code | `spec: ... comments` (line-start block comment → 1) |
| V11 | LOW | `src/parser.mjs` | `(x):` pattern parsed as 1-tuple, so `match 1` never matched and `catch (e)` never caught | `interp: structural patterns` |
| V12 | HIGH | `src/parser.mjs` | `new Date(0).getUTCFullYear()` parsed `new (Date(0).getUTCFullYear)()` → “not a constructor” | v0.2 interop tests (`print(new Date(0).getUTCFullYear())` → 1970 in run/js/ts) |
| V13 | HIGH | `src/interp.mjs` | alias import of a default-less ESM module threw `Cannot redefine property: __ns` (frozen namespace) | `v0.2 interop: interpreter ...` |
| V14 | HIGH | `src/codegen.mjs` | js target emitted `import h from "..."` for `as h`, breaking default-less ESM | `v0.2 interop: js target ...` |
| V15 | HIGH | `src/codegen.mjs` | js target emitted `__.pa` but prelude omitted `pa` → async tour crashed | `compiler: js target ...`, `examples: each terminating example ...` |
| V16 | HIGH | `src/codegen.mjs` | web target’s `<p>` tag shadowed core wrapper `__.p`; SSR wrapped output in `<p>` | `compiler: web target exports __tel ...` |
| V17 | HIGH | `src/codegen.mjs` | TS target still emitted default imports for aliases (V14 fix was js-only) | `v0.2 interop: ts target ...` |
| V18 | MED | `src/lexer.mjs` | `**=` absent from OPS despite parser/SPEC support; `x **= 3` parse error | `spec: **= compound assignment` |
| V19 | LOW | `docs/SPEC.md` (examples-eng) | SPEC §4.8 claimed `_` works in comprehension values; parser rejects it (AGENTS already said call-args only) | SPEC amended; `spec: slices/ranges/comprehensions` covers wildcard `for _` pattern |

Additional verifier-found issues fixed during the same period: `srv`/`cli`/`web`/`pub` as ordinary identifiers, `runFile` mistaking a `<main>` HTML tag for `main`, `in` operator, `nil` pattern only matching `nil`, one-line `try`/`catch` and `if`/`elif` chains (fixed by lead from bug report #1/#2 context and covered by the suite).

## 5. Token benchmark claims (`docs/TOKENS.md`) — PASS

All numeric claims were recomputed with the shipped tokenizer and independently matched:

```
$ node tools/tokcount.mjs examples/*.tel --json
# every examples/*.tel row matches docs/TOKENS.md exactly
# (algo 857, basics 713, express 138, interop 259, pipeline 667, server 235, tour 1450, web 125)
$ node tools/tokcount.mjs examples/tokenbench/* --json
# totals: Tel 540, Python 421 (base 3), TypeScript 759  — matches doc
# v0.2 rows: typed_pipeline 89/124, async_load 47/52, route 164/199 — matches doc
```

Stdout equivalence claims were executed, not just inspected: Tel vs Python vs Node/TS outputs were byte-identical for `fizzbuzz`, `pipeline`, `typed_pipeline`, `async_load`, `route`; the three HTTP handlers answered `/health`, `/sum?n=5`, `/sum?n=-2`, `/nope` with identical statuses and parsed JSON bodies (Tel/TS/Python). AGENTS.md budget: 2193/2200 tokens.

## 6. Residual risks / not verified

### 6.1 `tsc` is unavailable (sub-criterion BLOCKED)

`tsc` is not on PATH. Provisioning was attempted and denied by the sandbox:

```
$ nix shell nixpkgs#typescript -c tsc --version
error: experimental Lix feature 'nix-command' is disabled...
$ nix --extra-experimental-features 'nix-command flakes' shell nixpkgs#typescript -c tsc --version
error: remounting /nix/store writable: Operation not permitted
```

Therefore `tsc --noEmit` on emitted output is **not independently confirmed** in this environment, and `tel check --tsc` was only verified to degrade gracefully (both with and without a `tsconfig.json`) and exit 0. Running `nix shell`/`tsc` later is the only missing evidence.

### 6.2 Third-party npm package (`express`) not installed

`examples/express.tel` correctly detects the missing package and exits 0 with `express not installed; skipped (...)`; the npm interop path is verified against Node builtins and local ESM/CJS-style helpers, but a real third-party bare specifier was not exercised. Install `express` locally to test that one example.

### 6.3 Raw JS sibling imports + `--outdir`

A Tel file that imports a raw sibling `./helper.js` keeps that specifier relative to the emitted file. With `--outdir other/`, the helper is not copied, so `node other/main.ts` cannot resolve it unless the helper is copied next to the output or `-o` is placed alongside it. This is a documented layout caveat, not a mismatch in the verified layouts (tests build into the project dir or copy the helper).

### 6.4 Interpreter vs compiled typing nuance

For a call/member chain rooted at a JS import or `new` value, the TS target emits a direct `.method(...)` call so native typings/contextual callbacks survive; Tel-defined UFCS falls back to `__.mcall`. Runtime behavior was verified identical for the tested programs, but code relying on Tel method semantics on a JS-rooted value should be reviewed (documented in PLAN §Stable interfaces).

### 6.5 Other limits (by design / documented)

- `tel repl` was smoke-tested with piped input only; interactive TTY editing/session persistence was not exercised.
- `tel test` pass-through was verified on a temporary one-test directory; the full `test/` directory is exercised via `node --test test/`.
- Named arguments on ordinary functions are collected into a single object (documented limitation; covered by `spec: lambdas ...`).
- `match` is not exhaustiveness-checked (unmatched → located runtime error); divide-by-zero yields `Infinity` (JS semantics; deterministic, no hang); `Map`/map comprehensions use a literal key; `x = 1` mutates the nearest binding by design.
- `--version` still reports `tel 0.1.0` while docs describe v0.2 (cosmetic; `package.json` version was not bumped).
- Performance/scale was not benchmarked: deep valid nesting (500 parens, 300-term chains) and 20k-line-free test suite run in ~36 s; very deep recursion can hit JS stack limits.
- Verification environment was Node v26.9.0; PLAN lower bound is Node >= 20, but `node entry.ts` type stripping requires Node >= 22, so TS emit was not tested on Node 20.

## 7. How to re-run

```bash
node --test test/                                    # full suite (expect 93 pass / 1 skip / 0 fail)
node --test test/verify.test.mjs                     # verifier suite (expect 78 pass / 1 skip / 0 fail)
node bin/tel.mjs run examples/basics.tel
node bin/tel.mjs build examples/basics.tel --target js -o /tmp/out.mjs && node /tmp/out.mjs
node bin/tel.mjs build examples/basics.tel --target ts --outdir /tmp/telts && node /tmp/telts/basics.ts
node bin/tel.mjs build examples/web.tel --target web -o /tmp/web.mjs
node --input-type=module -e "const m=await import('file:///tmp/web.mjs'); console.log(m.__tel.html(m.App()))"
node bin/tel.mjs check examples/*.tel
node tools/tokcount.mjs AGENTS.md docs/AGENT-GUIDE.md
cmp AGENTS.md docs/AGENT-GUIDE.md
```

Raw transcripts backing every output above are in `/tmp/final_full_test.log`, `/tmp/final_verify_only.log`, `/tmp/final_acceptance.log`, `/tmp/extra.log` from the verification run (ephemeral).
