# Tel Build Plan — v0.1 (usable today)

Goal: **one language, `tel`, with its own compiler to JavaScript and its own interpreter.**
Backend, frontend and full-stack are just emit modes — not separate languages. Zero npm deps.
Node >= 20. Today's acceptance target: run/build/examples/tests all work end to end.

## Status

| Area | File(s) | Owner | Status |
|---|---|---|---|
| lexer | `src/lexer.mjs` | lead | done |
| parser | `src/parser.mjs` | lead | done |
| core runtime | `runtime/tel_rt.mjs` | lead | done |
| node runtime | `runtime/node_factory.mjs` | lead | done |
| browser runtime | `runtime/web_factory.mjs` | lead | done |
| interpreter (`tel run`) | `src/interp.mjs` | lead | done, hardening |
| JS codegen (`tel build --target js`) | `src/codegen.mjs` | lead | in progress |
| CLI / REPL / fmt / check / tokens | `src/cli.mjs`, `src/fmt.mjs`, `src/check.mjs` | cli-eng | todo |
| examples + spec + token proof | `examples/**`, `docs/SPEC.md`, `docs/TOKENS.md`, `tools/tokcount.mjs` | examples-eng | todo |
| independent verification | `test/verify.test.mjs`, `docs/VERIFICATION.md` | verify-eng | todo |

## Stable module interfaces (do not break)

### `src/parser.mjs`
```js
parse(src, {src?, file?}) -> Program       // throws ParseError {message,line,col}
parseExpression(src) -> Expr
```
AST node field names are consumed by the interpreter and codegen. Read the parser,
do not invent a parallel AST.

### `src/interp.mjs`
```js
new Runtime({file?, args?}) -> rt
rt.runFile(absPathOrRelative, {args}) -> Promise<{program, env, value, mainResult}>
rt.runSource(src, {file?, env?}) -> Promise<{program, env, value}>
createGlobalEnv({args}) -> Env
runSync(gen) / runAsync(gen)
```
`runFile` calls top-level `fn main(args)` if present. `main` may be async.
The REPL should keep one `Runtime` and pass `{env}` to `runSource` for persistence.

### `src/codegen.mjs` (lead is writing this now)
```js
compileProgram(program, {
  target = 'js' | 'web',
  entry = true,
  file = null,                       // absolute source path (for diagnostics)
  importSpecifier = (absPath) => './x.mjs'   // relative module -> emitted specifier
}) -> string                          // complete standalone ESM source
```
Output must be standalone (runtime inlined) and runnable with plain `node out.mjs`.
`--target js`: Node runtime (`fs`, `http`, `env`, `time` std namespaces available).
`--target web`: browser runtime (DOM tag functions, `sig`, `mount`, `html`, `renderToString`).
Every build exports its top-level names; for `web` it also exports `__tel` (the runtime object)
so SSR can be tested with `import {__tel} from './out.mjs'`.
Entry bootstrap: `js` runs `main` if present; `web` mounts `main`/`App` when `document` exists.

### `tools/tokcount.mjs`
```js
countTokens(text) -> number            // cl100k_base using tools/vocab/cl100k_base.tiktoken
countFiles(paths) -> [{path, chars, bytes, tokens}]
```
CLI form: `node tools/tokcount.mjs FILE... [--json]`. Pure Node, no deps.

## Command surface (cli-eng)
```
tel run FILE [-- ARGS...]        # interpreter
tel build FILE [-o OUT] [--outdir DIR] [--target js|web] [--quiet]
tel eval "CODE" | tel -e "CODE"  # interpreter, print result
tel repl                          # persistent env
tel check FILE...                 # parse + light static checks
tel fmt [--write] FILE...         # canonical formatting
tel tokens FILE... [--json]       # exact cl100k token counts
tel test [DIR]                    # run test/*.test.mjs via node --test, pass-through
tel help | --version
```
Errors: print `file:line:col: message`, a caret line when source is known, exit 1.
Unknown flags / missing file: exit 2.

## Language surface (v0.1 — already parsed + interpreted)

```
name = expr                      # ambient mutable binding (no let/const)
count += 1
fn add(a: Num, b: Num) -> Num = a + b
async fn load(url):
  r = await http.get(url)?
  json.parse(r.body)
for i in 1..=n: print(i)         # ranges lazy, inclusive with ..=
xs = [1,2,3]
ys = [x*x for x in xs if x % 2 == 1]
total = xs.filter(_ > 1).map(_ * 10).sum()   # _ = single-arg lambda
type Point = {x: Num, y: Num}
p = Point(x=1, y=2)
type Shape = Circle(r: Num) | Rect(w: Num, h: Num)
match shape:
  Circle(r): pi*r*r
  Rect(w, h): w*h
fn Vec.dot(self: Vec, o: Vec) = self.x*o.x + self.y*o.y   # a.dot(b) via UFCS
try: risky() catch e: print(e)
x = a ?? b                       # nil/Err fallback
data = f()?                      # return early with Err/Nil
pub fn handler(req): ...
```
Frontend view DSL (call style, no JSX):
```
web fn App():
  n = 0
  div(class="app",
    h1("Counter ", n),
    button(onclick=() => n += 1, "+"))
```
In `web` functions, top-level `x = init` becomes a signal: reads re-run the component,
writes update the DOM. `srv`/`cli` modifiers exist in the AST (`surface`) for RPC; for v0.1
`js` treats them as normal functions (full-stack RPC is a stretch goal, not blocking).

## Rules of engagement
- Zero runtime npm deps. Do not add dependencies. No `nix profile install`; Node is present.
- Keep files ASCII, 2-space indent, ES modules (.mjs imports).
- One writer per file (see write scopes). Message the owner instead of editing their file.
- Run `node --test test/` before declaring done. Use `node bin/tel.mjs ...` for smoke tests.
- Report evidence (exact commands + output) in task completion notes.
