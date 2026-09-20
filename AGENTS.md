# Tel Agent Guide

Tel is a small, token-efficient language with a tree-walk interpreter and a
TS/JS/Web compiler. Python-style layout, zero deps, Node >= 20.

## What Tel is / run, build, check

```bash
node bin/tel.mjs run app.tel -- arg1          # interpreter, calls fn main(args)
node bin/tel.mjs build app.tel --target ts|js|web  # app.ts / app.mjs / bundle
node bin/tel.mjs check app.tel [--tsc]        # static checker
```

## 60-second syntax

```tel
name = "tel"                            # line comments start with #
greeting = "hello, {name}"              # strings interpolate
fn double(x: Num) -> Num = x * 2
fn label(n: Num) -> Str:
  if n < 0: "negative" else: "non-negative"

xs = [1, 2, 3, 4]
squares = [x * x for x in xs if x % 2 == 0]
evens = xs.filter(_ % 2 == 0).map(_ * 10)
for i in 1..=3:
  print(double(i), label(i))
match 3:
  1 | 2: print("small")
  n if n > 2: print("big {n}")
  _: print("other")
```

`name = expr` is an ambient binding, no `let`. `..` is end-exclusive, `..=`
inclusive. `x |> f |> g(1)` means `g(f(x), 1)`; `;` separates statements.

## Types

```tel
type Point = {x: Num, y: Num}
type Ids = [Str]
type Table = [Str: Num]
type Pair = (Num, Num)
type Maybe = Some(Num) | None
enum Color = Red | Green | Blue
type Box[T] = {v: T}
p = Point(x=1, y=2)
```

Builtins: `Num`, `Int`, `Str`, `Bool`, `Nil`, `Any`, `Void`; optional `Str?`.
Annotations are not enforced at runtime (`x is Type` is). Dotted names work:
`fn f(r: url.URL) = r.toString()`.

## Match / patterns

```tel
type Shape = Circle(r: Num) | Rect(w: Num, h: Num)
fn area(s: Shape) -> Num:
  match s:
    Circle(r): 3 * r * r
    Rect(w, h): w * h
fn describe(xs: [Num]) -> Str:
  match xs:
    []: "empty"
    [h, ...t]: "head {h}, tail {t}"
    _: "other"
print(area(Circle(2)), describe([1, 2, 3]))
```

Patterns: literals incl. `nil`, `_`, binding, `(a, b)`, `[h, ...t]`,
`{x: a, ...rest}`, `Variant(x)`, `A | B`, guards `pat if cond`. `match` returns
the arm value; unmatched input raises (no exhaustiveness check).

## Functions, methods, UFCS

```tel
fn add(a: Num, b: Num = 1) -> Num = a + b
fn sumAll(...xs):
  total = 0
  for x in xs: total += x
  total
type Vec = {x: Num, y: Num}
fn Vec.dot(self: Vec, o: Vec) -> Num = self.x * o.x + self.y * o.y
v = Vec(x=1, y=2)
print(add(2), sumAll(1, 2, 3), v.dot(Vec(x=3, y=4)))
```

Lambdas: `x => x * 2`, `(a, b) => a + b`, `x => { print(x); x }`. `_` is a
one-arg lambda inside call args. `Type.name(self, ...)` defines a method callable
`v.name(...)` or `name(v, ...)`. `return`/`break`/`continue`/`defer` work.

## Collections

```tel
xs = [3, 1, 4, 1, 5]
print(xs.filter(_ > 1).map(_ * 10).sort())  # [10, 30, 40, 50]
print(xs.sum(), xs.max())
by = {"a": 1, "b": 2}
print(by.keys().sort(), by.values().sum())
```

Comprehensions: `[e for x in xs if c]` (chained `for`/`if` allowed) and
`{name: e for x in xs}` (literal key). Slices `xs[1..3]`, `xs[..2]`, `xs[2..]`;
negative index `xs[-1]`. Common methods: map filter reduce find some every count
sum min max uniq flat reverse join contains sort sortBy zip enumerate take drop
first last groupBy chunk each len keys values entries get has set push. Strings:
trim upper lower split replace startsWith endsWith includes repeat chars padStart
padEnd lines.

## Errors and `?`

```tel
fn half(n: Num) -> Result:
  if n % 2 == 0: Ok(n / 2) else: Err("odd: {n}")
fn quarter(n: Num):
  h = half(n)?
  h / 2
try:
  print(quarter(8))
  throw "boom"
catch e:
  print("caught {e}")
finally:
  print("done")
print(half(3) ?? 0)
```

`?` unwraps `Ok(v)` and early-returns `Err`/`nil` (inside a function). `a ?? b`
falls back on `nil`/`Err` and unwraps `Ok`. `panic(msg)` throws; `fs` returns
`Result`.

## Modules and JS/npm interop

```tel
import std.{json, math}
import "node:path" {join} as path
import "node:fs" as fs
u = new URL("https://example.com/a?q=1")
print(join("a", "b"), fs.existsSync("package.json"), u.toString())
```

Tel modules: `import "./util.tel" as util`, `import "./util.tel" {f} as util`.
`pub fn`/`pub type` control exports; with no `pub`, all top-level names export.
Std: `import std.http as http`, `import std.{json, math}`. npm uses the same
form (`import "express" as express`; package must be installed) and named JS
imports are `import "node:fs" {readFileSync} as fs`. `import "node:path" * as ns`
binds the real namespace and keeps its typings in `--target ts`. Tel lambdas are JS arrows,
so they pass as callbacks; `await` works on Promises, including top level.
Records/arrays/tuples are plain JS values; sums are `{__tag,__v,__t}`.
`--target ts` keeps real typings for named and `* as` namespace JS imports; a
default alias (`as x`) is typed `any` with namespace hydration.

## Stdlib cheatsheet

| Namespace | Members |
|---|---|
| globals | `print len str int num bool range keys values panic assert` |
| `std.json` | `parse(s)->Result`, `stringify(x[,indent])`, `pretty(x)` |
| `std.math` | `pi e abs floor ceil round sqrt pow sin cos log exp random`; `min(xs)`/`max(xs)` take a collection |
| `std.fs` | `read readBytes write append exists list remove mkdir cwd readJson writeJson` (fallible -> `Result`) |
| `std.http` | `res(status, body, headers)`, `serve(port, handler)`, `get(url)`, `post(url, body)` |
| `std.env` | `get(name[, fallback])`, `set`, `args`, `cwd`, `exit(code)` |
| `std.time` | `now()`, `iso()`, `await sleep(ms)` |

`http.serve` handlers get `{method, path, query, headers, body}` and may be
async; returning an object sends JSON, a string text, `nil` 204.

## Gotchas / unsupported

- `x = 1` mutates the nearest binding; `x: Num = 1` creates a new local.
- Indentation is syntax; inline bodies hold one statement, and `elif`/`else`/
  `catch` may follow on the same line or at the `if` column.
- `_` placeholders only work inside call args; `spawn expr` is a prefix
  (`spawn work()`), not a function call.
- No `let`/`const`, classes, traits, macros, interfaces, or JSX; `match` is
  not exhaustiveness-checked.
- Generics/annotations are parse-time only; `tel check` catches most scope,
  undefined-name, and arity mistakes.

## Copy-paste programs

CLI tool:

```tel
fn main(args):
  name = args[0] ?? "world"
  print("hello, {name}")
```

HTTP JSON API (env/arg port, 0 = ephemeral, prints bound port):

```tel
import std.http as http
async fn handle(req):
  match req.path:
    "/health": {ok: true}
    "/sum": {sum: (0..=int(req.query.n ?? "0")).sum()}
    _: http.res(404, "not found")
async fn main():
  server = await http.serve(int(env.get("PORT", args[0] ?? "0")), req => handle(req))
  print("bound {server.port}")
  server
```

Frontend signal counter (`--target web` mounts `App`):

```tel
web fn App():
  n = 0
  div(class="app",
    h1("Counter ", n),
    button(onclick=() => n += 1, "+"))
```
