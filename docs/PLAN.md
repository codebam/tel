# Tel Build Plan — v0.2

Goal: **one language, `tel`**, token-efficient for AI, with its own compiler
(**TypeScript** and JS/Web emit) and interpreter, designed so **using JavaScript/npm
libraries is trivial**. Zero npm deps for the toolchain; Node >= 20.

## v0.2 priorities (supersede v0.1 where they differ)

1. **`--target ts`**: emit typed, runnable TypeScript. Output = `app.ts` (+ imported
   `.ts` modules) + one shared `tel_runtime.ts`. Runnable with `node app.ts`
   (Node type stripping). `--target js|web` remain.
2. **First-class JS/npm interop**: `import "express" as express`,
   `import "node:fs/promises" as fsp`, `import "pkg" {a,b}`, `new Foo(x)`,
   native prototype methods, Tel lambdas as JS callbacks, `await` on Promises,
   optional chaining/nullish. Direct member calls on JS values must preserve
   TypeScript inference (no `any`-erasing dispatcher in TS output for JS roots).
3. **`tel check`**: real checker (undefined names, scopes, arity, return/break/
   continue placement, duplicate bindings, annotation names, import awareness);
   `tel check --tsc` additionally runs TypeScript when available.
4. **`AGENTS.md`**: compact canonical guide shipped with the language. Root
   `AGENTS.md` is generated from `docs/AGENT-GUIDE.md`; `tel init` copies it into
   projects; `tel guide` prints it. Every fenced `tel` snippet must execute;
   whole file budget <= 2200 cl100k tokens (measured with tools/tokcount.mjs).
5. v0.1 acceptance still applies: interpreter, js/web build, examples, tests.

## Stable interfaces

### `src/parser.mjs`
```js
parse(src, {src?, file?}) -> Program       // throws ParseError {message,line,col}
parseExpression(src) -> Expr               // AST nodes carry {line,col}
```
v0.2 additions:
- `new Foo(args)` -> `{type:'New', callee, args}`
- `import "express" as express`, `import "node:fs" {readFile} as fs`:
  Import gets `kind: 'std'|'tel'|'js'` (string ending `.tel` => tel, `std.*` => std,
  anything else => js/npm/URL)
- dotted type names in annotations: `req: express.Request`

### `src/interp.mjs`
```js
new Runtime({file?, args?}) -> rt
rt.runFile(path, {args}) -> Promise<{program, env, value, mainResult}>
rt.runSource(src, {file?, env?}) -> Promise<{program, env, value}>
```
JS imports use dynamic `import()`; alias binds `mod.default ?? mod`; names bind
named exports. Errors expose `{line,col}` via `.loc`.

### `src/codegen.mjs`
```js
compileProgram(program, {
  target = 'js'|'web'|'ts',
  entry = true,
  file = null,
  importSpecifier = (abs) => './x.ts'|'./x.mjs',
  runtimeModule = null,        // ts: specifier of shared runtime, e.g. './tel_runtime.ts'
}) -> string

compileRuntime({ target='js'|'web'|'ts' }) -> string
```
- `js|web`: self-contained single file (runtime inlined), as in v0.1.
- `ts`: user/module files are typed and do not inline the runtime; each starts
  with `import { __ } from "<runtimeModule>";`. `compileRuntime({target:'ts'})`
  returns the shared runtime as `// @ts-nocheck` + `export const __ = ...`.
- TS emit maps annotations: `Num`->`number`, `Str`->`string`, `Bool`->`boolean`,
  `[T]`->`T[]`, `T?`->`T|null`, `{x:T}`->`{x:T}`, function types, unions, generics;
  records become `type`, unions become discriminated `__tag`/`__v` unions.
- Interop rule: a call/member chain rooted at a JS import alias or a `new`-created
  JS value emits a **direct** `.method(...)` call in TS so npm typings and
  contextual callback typing survive. Tel-defined UFCS falls back to
  `__.mcall` (registry shared via `globalThis`).

### `tools/tokcount.mjs`
```js
countTokens(text) -> number
countFiles(paths) -> [{path, chars, bytes, tokens}]
```
Exact cl100k_base via `tools/vocab/cl100k_base.tiktoken`; CLI `node tools/tokcount.mjs FILE... [--json]`.

## JS interop rules (v0.2)

- `import "<spec>" as x` binds default if present else the namespace
  (`mod.default ?? mod`).
- `import "<spec>" {a, b}` binds named exports.
- `new`: `new Date(0)`, `new Map()`, `new Foo(args)`.
- Tel lambda = JS arrow function; pass it anywhere a callback is expected.
- Tel records/arrays/tuples are plain JS objects/arrays; numbers/strings/bools/nil
  are JS primitives. Sum values are `{__tag,__v,__t}` plain objects.
- Native methods win for class/prototype instances; Tel methods win for core
  types (List/Str/Record/Range/Sum) and for UFCS user functions.
- `?` unwraps `Ok(value)`/propagates `Err`; `??` falls back on `Nil`/`Err`.

## AGENTS.md requirements

Sections, in this order: What Tel is + run/build/check commands; 60-second syntax;
types; match/patterns; functions/methods/UFCS; collections; errors/`?`; modules and
JS/npm interop; stdlib cheatsheet; gotchas/unsupported; three copy-paste programs
(CLI tool, HTTP handler, frontend component). Terse tables/examples, no filler.
Every `tel` fence is executed by `test/verify.test.mjs`. Raw JS interop snippets
must be labelled `js` and are checked by inspection/build, not the interpreter.

## Command surface (cli-eng)

```
tel run FILE [-- ARGS...]                 # interpreter
tel build FILE [-o OUT | --outdir DIR] [--target js|web|ts] [--quiet]
tel eval "CODE" | tel -e "CODE"
tel repl
tel check FILE... [--tsc]                 # checker; --tsc also runs tsc if present
tel fmt [--write] FILE...
tel tokens FILE...
tel init                                  # main.tel + AGENTS.md in cwd
tel guide [--full]                        # print docs/AGENT-GUIDE.md
tel test [DIR]
tel help | --version
```
`--target ts`: write `<entry>.ts`, every imported Tel module as `.ts` preserving
paths, and one shared `tel_runtime.ts` in the output dir; import specifiers use
`.ts` extensions so `node <entry>.ts` works.

## Ownership / write scopes
- lead: `src/parser.mjs`, `src/interp.mjs`, `src/codegen.mjs`, `runtime/**`, `docs/PLAN.md`
- cli-eng: `src/cli.mjs`, `src/check.mjs`, `src/fmt.mjs`, `bin/tel.mjs`, `test/cli.test.mjs`
- examples-eng: `AGENTS.md`, `docs/AGENT-GUIDE.md`, `docs/SPEC.md`, `docs/TOKENS.md`, `examples/**`, `tools/tokcount.mjs`
- verify-eng: `test/verify.test.mjs`, `docs/VERIFICATION.md`
One writer per file; message the owner instead of editing their file.

## Rules of engagement
- Zero npm deps for toolchain. No profile installs. Node >= 20.
- Run `node --test test/` and concrete smoke commands before declaring done.
- Every claim needs a command + observed output in the completion report.
