# Tel Language Specification (v0.2 draft)

Tel is a small, token-efficient language with a tree-walk interpreter and
compilers to JavaScript, browser JavaScript, and TypeScript. This document is
the reference for the language as implemented by `src/parser.mjs`,
`src/interp.mjs`, and `runtime/`. v0.2 adds first-class JS/npm interop and a
TypeScript emit target on top of the v0.1 core.

Reference implementation status: interpreter and parser are authoritative.
Features whose compiler support is still landing are marked *planned*.


## 1. Execution model

A Tel program is a sequence of top-level declarations and statements in one
file. Execution order within a block is:

1. all `import` declarations, in source order;
2. all `fn` declarations are hoisted (recursion and mutual recursion work);
3. all `type`/`enum` declarations are defined;
4. remaining statements run in source order.

`tel run file.tel -- a b` calls `fn main(args)` after the top-level program if
`main` is defined at top level; `args` is the array of trailing CLI arguments.
`main` may be `async`; its result is awaited. Top-level `await` also works in
the interpreter because the top level runs on an async runner.

```tel
print("top-level runs first")

fn main(args):
  print("main gets", args)

fn add(a, b) = a + b
print("add(1, 2) =", add(1, 2))
```

Output when run with `tel run file.tel -- x`: `top-level runs first`, then
`add(1, 2) = 3`, then `main gets [x]`.


## 2. Lexical structure

### 2.1 Source encoding

Source files are UTF-8 text with `.tel` extension. Identifiers are ASCII; string
literals and comments may contain any Unicode. Line endings `\n` and `\r\n` are
both accepted.

### 2.2 Layout, newlines, semicolons

Tel uses Python-style indentation. A newline ends a statement. `:` opens a block
whose body is either

- one statement on the same line: `if x > 0: print(x)`, or
- an indented block on following lines.

An increase in indentation emits an implicit block; a decrease closes it.
`elif`, `else`, `catch`, and `finally` must be either on the same line as the
construct or at the same indentation column as the opening `if`/`try`.
Blank lines and comment-only lines do not affect indentation. Tabs count as four
columns; an inconsistent mix fails to parse. Newlines and indentation are
ignored inside `(...)`, `[...]`, and `{...}`, so literals and calls may span
lines.

A semicolon is a soft statement separator: `a = 1; b = 2` is two statements.

### 2.3 Comments

`#` starts a line comment running to end of line. `#[ ... ]#` is a block comment
and nests: `#[ outer #[ inner ]# still outer ]#`. Block comments may start a
line, span lines, and appear anywhere whitespace is allowed.

### 2.4 Identifiers and keywords

Identifiers match `[A-Za-z_$][A-Za-z0-9_$]*`. Reserved words:

`fn type enum import pub srv cli web async await spawn new if elif else for in
while loop match return break continue throw try catch finally is not and or
true false nil void self as defer`

`srv`, `cli`, `web`, and `pub` are contextual: they behave as ordinary
identifiers unless immediately followed by `fn` (or `type`/`enum` for `pub`).
`_` alone is the placeholder lambda argument.

### 2.5 Numeric literals

Decimal, fractional, and exponent forms: `42`, `1_000_000`, `2.5`, `.25`,
`1e3`, `2.5e-2`. Hex `0x2a`/`0X2A` and binary `0b1010`/`0B1010` are supported.
Underscores may appear between digits. There is no octal literal and no
separate integer type: all numbers are IEEE-754 doubles.

### 2.6 String literals

- `'...'`: raw-with-escapes, no interpolation.
- `"..."`: escapes plus `{expr}` interpolation.
- `"""..."""`: multiline double-quoted strings with interpolation.

Escapes in all forms: `\n`, `\t`, `\r`, `\0`, `\\`, `\"`, `\'`, `\{`, `\}`,
and `\uXXXX`. An unknown escape drops the backslash and keeps the character.
Inside double-quoted strings, `{` starts an interpolation; literal braces must be
escaped (`\{`, `\}`). Interpolated expressions are full Tel expressions;
interpolated values are converted with the same rules as `str`.

```tel
name = "Tel"
n = 3
print('{name} stays literal')
print("hi {name}, n={n}, next={n + 1}")
print("escaped: \{not interpolated\}")
print("""multi
line {n}""")
```

### 2.7 Operators and punctuation

```
( ) [ ] { } , ; : . ? .. ..= ... ?. ??
= += -= *= /= %= **= ??=
|> ?? or || and && not is in
== != < <= > >= + - * / % ** & | ^ << >> ~ !
=> -> @
```

`@` is lexed but has no meaning in v0.2. `::` is lexed but unused.


## 3. Types

### 3.1 Role of types

Type annotations are parsed and used by the TypeScript target, but the
interpreter does not enforce them. `is` provides a runtime check. The static
checker (`tel check`) uses annotations for diagnostics.

### 3.2 Builtin type names

`Num`, `Int` (alias of `Num`), `Str`, `Bool`, `Nil`, `Any`, `Void`, `List`,
`Map`, `Fn`, `Result`, `Error`, `Task`, `Range`. Generic type applications are
written with brackets: `Result`, `[Num]`, `[Str: Num]`. Optional types use a
suffix `?` (`Str?`).

```tel
x: Num = 1
flag: Bool = true
maybe: Str? = nil
ids: [Num] = [1, 2, 3]
table: [Str: Num] = {"a": 1}
pair: (Num, Str) = (1, "one")
mapper: (Num) -> Num = (v) => v * 2
print(x, flag, maybe, ids, table, pair, mapper(3))
```

### 3.3 Record types

`type Name = {field: Type, ...}` defines a record constructor. Fields may be
passed by name or position; missing fields become `nil`.

```tel
type Point = {x: Num, y: Num}
p = Point(x=1, y=2)
q = Point(3, 4)
print(p.x + q.y, p)
```

Records are plain JS objects with a non-enumerable `__t` type tag. Fields are
mutable: `p.x += 1`.

### 3.4 Union types and enums

`type Name = Variant(fields) | Other | ...` and the `enum` synonym define a
tagged union. Nullary variants bind directly to a value; payload variants bind
to a constructor.

```tel
type Shape = Circle(r: Num) | Rect(w: Num, h: Num) | Dot
enum Color = Red | Green | Blue
s = Circle(r=2)
c = Red
print(s, c)
```

Union values are `Sum` values with `__tag`, `__v`, and `__t` fields. Construct
with positional or named arguments: `Rect(1, 2)` or `Rect(w=1, h=2)`.

### 3.5 Generics

Generic parameters are accepted and ignored at runtime:
`type Box[T] = {v: T}`, `fn id[T](x: T) -> T = x`. They inform the TypeScript
emit and checker.

### 3.6 Type aliases

Anything that is not a record literal or a variant list is an alias:
`type Ids = [Str]`, `type Row = (Str, Num)`, `type Cb = (Num) -> Num`.
Aliases have no runtime representation.

### 3.7 Dotted type names

Annotations may name a JS type through an import alias:
`fn render(u: url.URL) -> Str = u.toString()`. Dots inside a type name are
preserved verbatim.

### 3.8 `is`

`expr is Type` performs a runtime type test for builtin and named types.

```tel
type Point = {x: Num, y: Num}
type Shape = Circle(r: Num) | Rect(w: Num, h: Num)
print(1 is Num, "s" is Str, [1] is List, nil is Nil)
print(Circle(1) is Shape, 1 is Int)
```


## 4. Expressions

### 4.1 Primary expressions

Literals (numbers, strings, `true`, `false`, `nil`), identifiers, `self`,
parenthesized expressions, tuples `(a, b)`, arrays `[a, b]`, records
`{key: value, ...}`, lambdas, and `match` expressions.

A parenthesized expression with commas is a tuple (a JS array):
`t = (1, "two")`, `t[1]`.

### 4.2 Arrays, records, spread

Array elements may spread later elements: `[0, ...xs]`; a spread may also be
the first element. Record spread merges objects: `{...base, extra: 1}`. Bare
record keys use the variable name: `{x, y}` is `{x: x, y: y}`. Map-style string
keys are allowed: `{"count": 3}`.

```tel
xs = [2, 3]
print([0, 1, ...xs])
print({...{"a": 1}, b: 2})
x = 1
y = 2
print({x, y})
print({"k": 9})
```

### 4.3 Calls

`f(a, b)`, spread `f(...args)`, and named arguments `f(name=value)`. Named
arguments are primarily for record and union constructors. On ordinary
functions they are collected into one object passed as the first positional
argument (a documented limitation).

Optional calls short-circuit: `p?.f()` returns `nil` when `p` is `nil`.

### 4.4 Member access, indexing, slices

`obj.field`, optional `obj?.field`, `arr[i]`, and slices `arr[a..b]`,
`arr[..b]`, `arr[a..]`, `arr[a..=b]` (end exclusive unless `..=`). Negative
indices count from the end. Slice bounds are also index expressions, so
`xs[i + 1..]` works. Record fields also support `obj["field"]`.

```tel
xs = [0, 1, 2, 3, 4, 5]
print(xs[1], xs[-1])
print(xs[1..4], xs[..2], xs[3..], xs[2..=4])
m = {"a": 1}
print(m["a"])
nilObj = nil
print(nilObj?.missing)
```

### 4.5 Operators and precedence

Lowest to highest:

| Precedence | Operators | Associativity |
|---|---|---|
| 1 | `=` `+=` `-=` `*=` `/=` `%=` `**=` `??=` | right |
| 2 | `a if c else b`, `\|>` | right / left |
| 3 | `??` | right |
| 10 | `or`, `\|\|` | left |
| 20 | `and`, `&&` | left |
| 30 | `==` `!=` `<` `<=` `>` `>=` `is` `in` | left |
| 32-34 | `\|` `^` `&` | left |
| 40 | `<<` `>>` | left |
| 45 | `..` `..=` | left |
| 50 | `+` `-` | left |
| 60 | `*` `/` `%` | left |
| 70 | `**` | right |
| postfix | call `()` index `[]` member `.` `?.` propagate `?` | left |
| prefix | `-` `+` `!` `not` `~` `await` `spawn` `new` | right |

`&&`/`and` and `||`/`or` return the operand values (short-circuit), `not`
coerces with truthiness. `+` concatenates when either operand is a string.
`in` tests containment in lists, strings, and record keys. Comparisons are
value-based for primitives; `==` is structural for arrays, records, and sums.

```tel
print(1 + 2 * 3, 2 ** 3 ** 2, 7 % 4)
print(true and "yes", nil or "fallback", not false)
print(2 in [1, 2], "b" in "abc", "k" in {"k": 1})
print([1, 2] == [1, 2], Ok(1) == Ok(1))
print("big" if 10 > 3 else "small")
print([3, 1, 2] |> sort |> join("-"))
```

### 4.6 Ranges

`a..b` is end-exclusive, `a..=b` end-inclusive. Ranges are lazy `Range`
objects; descending ranges step by -1. The builtin `range(start, end,
inclusive=false, step=undefined)` supports custom steps. Ranges work with
`for` and most collection methods.

```tel
print([n for n in 1..=5])
print([n for n in 5..0])
print([n for n in 3..=0])
print(range(0, 10, false, 2).map(_).join(","))
```

### 4.7 Comprehensions

Array comprehension: `[value for pattern in iterable if condition ...]` with
chained `for` and `if` clauses. Map comprehension: `{key: value for ...}` where
the key is either a bare identifier (treated as a literal key name) or a string
literal.

```tel
xs = [1, 2, 3, 4]
print([x * x for x in xs if x % 2 == 0])
print([x * y for x in [1, 2] for y in [10, 100]])
print({k: k * k for k in [1, 2, 3]})
```

### 4.8 Lambdas and `_`

Lambdas: `x => expr`, `(a, b) => expr`, `(x: Num) -> Num = ...` is *not* a
lambda; use `=>`. A lambda may have a block body: `x => { print(x); x }`.
`async` lambdas are written `async x => expr` or `async (a, b) => expr`.

`_` is a one-argument lambda shorthand and is valid only inside call arguments;
in patterns it is the wildcard. Nested lambdas own their own `_`.

```tel
double = x => x * 2
add = (a, b) => a + b
print(double(21), add(2, 3))
print([1, 2, 3, 4].filter(_ > 2).map(_ * 10))
print([1, 2, 3].map((x) => x + add(1, 2)))
```

### 4.9 `new` and JS values

`new Foo(args)` calls a JS constructor. `new` binds tighter than member access:
`new Map().set("a", 1)` constructs then calls. `new URL(...)`, `new Date(...)`,
`new Map()`, `new Set()`, `new express.Router()` all work when the class is
available through an import or global.

```js
const p = new URL("https://example.com/a?q=1");
```
```js
const d = new Date(0);
```

### 4.10 `?`, `??`, `await`, `spawn`

`expr?` unwraps `Ok(value)`, early-returns `Err`/`nil` from the enclosing
function, and passes other values through. `a ?? b` returns `b` when `a` is
`nil` or `Err`, unwraps `Ok`, and otherwise returns `a`. `??=` only assigns when
the current value is `nil`/`Err`.

`await expr` waits for a promise; it is allowed inside `async fn` and at top
level in the interpreter. `spawn expr` is a prefix operator that starts
evaluating `expr` asynchronously and returns a task (promise):
`task = spawn load(url)`, `result = await task`.


## 5. Statements

### 5.1 Bindings and assignment

`name = expr` is an ambient mutable binding: it updates the nearest existing
binding with that name or creates one in the current scope. `name: Type = expr`
creates a binding local to the current block (the annotation triggers local
scope). Compound assignment supports `+=`, `-=`, `*=`, `/=`, `%=`, `**=`, `??=`.

Destructuring assignment uses patterns: `(a, b) = pair`, `[x, ...rest] = xs`,
`{name, age} = user`.

```tel
count = 0
count += 1
count ??= 9
x: Num = 5
fn local():
  x: Num = 7
  x
print(count, x, local())
(a, b) = (1, 2)
[x, ...rest] = [3, 4, 5]
print(a, b, x, rest)
```

### 5.2 `if`, `while`, `loop`, `for`

`if cond: body elif cond: body else: body`; bodies may be inline or indented.
`while cond:` loops. `loop:` loops forever; use `break`. `for pattern in
iterable:` iterates lists, strings, ranges, records (keys), or any JS iterable.
`break` and `continue` work in all loops.

An `if` statement used as the final statement of a block yields the branch
value; a trailing `if` is therefore a common way to write a function without
`return`.

```tel
fn sign(n: Num) -> Str:
  if n > 0:
    "positive"
  elif n < 0:
    "negative"
  else:
    "zero"

total = 0
for n in 1..=4:
  if n == 2: continue
  total += n
while total < 10:
  total += 1
countdown = 3
loop:
  countdown -= 1
  if countdown == 0: break
print(sign(-2), total, countdown)
```

### 5.3 `match`

`match subject:` followed by indented arms `pattern [if guard]: body`. The
first matching arm wins; its body value is the match value. There is no
compile-time exhaustiveness check; unmatched values raise
`match: no arm matched <value>`.

```tel
type Shape = Circle(r: Num) | Rect(w: Num, h: Num)
fn area(s: Shape) -> Num:
  match s:
    Circle(r): 3 * r * r
    Rect(w, h): w * h
print(area(Circle(2)), area(Rect(3, 4)))
```

### 5.4 `try`, `catch`, `finally`, `throw`

Any value can be thrown. `catch` binds the thrown value to a name or matches a
pattern; multiple catch clauses are allowed. `finally` always runs. `return`,
`break`, `continue`, and `?` early-return pass through `try` (they are not
caught).

```tel
try:
  throw "boom"
catch e:
  print("caught", e)
finally:
  print("cleanup")
```

### 5.5 `return`, `defer`

`return expr` exits the enclosing function with `expr` (or `nil`). `defer expr`
schedules `expr` to run when the current block exits, in LIFO order.

```tel
fn describe(n):
  defer print("leaving describe")
  if n < 0:
    return "negative"
  "non-negative"
print(describe(-1))
```

### 5.6 Declarations

`fn ...` defines functions; `type`/`enum` define types; `import` binds modules.
Declarations are hoisted inside their block. `pub` before `fn`/`type` marks a
module export; `async` marks async functions; `srv`, `cli`, `web` mark a
function surface for future RPC/UI codegen and are otherwise ordinary functions.


## 6. Patterns

Patterns appear in match arms, catch clauses, `for`, comprehensions, bindings,
and destructuring assignment.

| Pattern | Meaning |
|---|---|
| `_` | wildcard, binds nothing |
| `name` | bind (lowercase names) |
| `42`, `"s"`, `true`, `nil`, `-3` | literal equality |
| `Name` / `Name(...)` | union variant (uppercase) |
| `(p1, p2)` | tuple of fixed length |
| `[p1, p2]` | array of fixed length |
| `[p1, ...rest]` | array with rest binding |
| `{x: p, ...rest}` | record fields, bare identifier keys |
| `p1 \| p2` | alternatives (bindings must agree) |
| `p if cond` | guard (guard may reference bindings) |

```tel
fn show(v) -> Str:
  match v:
    0: "zero"
    1 | 2: "one or two"
    [x]: "one-element {x}"
    [h, ...t]: "head {h}, tail {t}"
    (a, b): "pair {a}/{b}"
    {name, ...r}: "name {name}, rest {r}"
    nil: "nil"
    _: "other"

print(show(0), show(2), show([9]), show([1, 2, 3]))
print(show((1, 2)), show({name: "ada", age: 3}), show(nil), show("x"))
```

Array patterns without `...rest` require exact length; record patterns ignore
extra fields unless a `...rest` binding is present. String-literal record keys
are not supported in patterns.


## 7. Functions, methods, and UFCS

Function declaration forms:

- expression body: `fn add(a: Num, b: Num) -> Num = a + b`
- block body: `fn add(a: Num, b: Num) -> Num:` followed by indented statements
- method: `fn Type.name(self: Type, ...) = ...`, called `value.name(...)`

Parameters support type annotations, defaults (`b: Num = 1`), and rest
(`...xs`). Calls support positional, named, and spread arguments.

UFCS (uniform function call syntax): any function `f(x, ...)` may be called
`x.f(...)` when no field/method of that name wins. User methods registered with
`fn Type.name` are also callable as `name(value, ...)`. Builtin collection
methods (section 9) work this way on List, Str, Record, and Range.

```tel
fn add(a: Num, b: Num = 1) -> Num = a + b
fn addAll(...xs):
  total = 0
  for x in xs: total += x
  total
type Vec = {x: Num, y: Num}
fn Vec.dot(self: Vec, o: Vec) -> Num = self.x * o.x + self.y * o.y
v = Vec(x=1, y=2)
print(add(2), addAll(1, 2, 3), v.dot(Vec(x=3, y=4)), dot(v, v))
```

`self` is also recognized implicitly when the first parameter is named `self`.


## 8. Modules and imports

Three import kinds are supported.

**Std modules** (runtime namespaces bundled with Tel):

```tel
import std.http as http
import std.{json, math}
print(math.floor(2.9), json.stringify({"ok": true}))
```

**Tel modules** (relative path ending in `.tel`): `import "./util.tel" as util`
or `import "./util.tel" {helper, Point} as util`. Paths are resolved relative
to the importing file. With no alias, a named list binds exports directly.

**JS/npm modules** (any other specifier, resolved by Node): `import "express"
as express`, `import "node:path" * as ns`, `import "node:fs" {readFileSync} as
fs`. A runnable Node-builtin
```tel
import "node:path" as path
import "node:fs" {readFileSync} as fs
p = path.join("package.json")
print(fs.existsSync(p), path.basename(p), readFileSync(p, "utf8").len() > 0)
```

A JS/default alias (`as x`) binds `mod.default ?? mod`; extra named exports are
hydrated onto the alias object as well, so CJS-style defaults work. The
namespace-star form (`* as ns`) binds the module namespace directly and keeps
its real typings in `--target ts`. Named binding lists bind exports directly. Bare specifiers are resolved relative to
the importing file with `createRequire`, then imported dynamically; `node:`
schemes and relative/absolute paths work without installation, npm packages
must be installed in `node_modules`.

Exports: a Tel module exports `pub fn` and `pub type` declarations. If a module
has no `pub` declaration, every top-level `fn`, `type`, and `enum` is exported
(functions and record constructors by name, union variant constructors by
variant name). `pub type` export includes its variant constructors.

Imports execute once per absolute path and are cached per `Runtime`.

### 8.1 Top-level async

`await` may appear at top level in the interpreter; `runFile` awaits the whole
top-level before calling `main`:

```tel
import "node:fs/promises" as fsp
text = await fsp.readFile("package.json", "utf8")
print("package.json chars:", text.len())
```


## 9. Runtime standard library

The following are available as globals. Methods listed as *UFCS* are callable
both as `f(x, ...)` and `x.f(...)`.

### 9.1 Global functions

`print(...)`, `eprint(...)`, `len(x)`, `str(x)`, `repr(x)`, `int(x)`,
`num(x)`, `bool(x)`, `truthy(x)`, `typeName(x)`, `isType(x, name)`,
`range(start, end, inclusive?, step?)`, `iter(x)`, `at(x, i)`, `slice(x,
start?, end?, inclusive?)`, `get(x, k, fallback?)`, `has(x, k)`, `set(x, k,
v)`, `del(x, k)`, `keys(x)`, `values(x)`, `entries(x)`, `panic(msg)`,
`assert(cond, msg?)`, `noMatch(value)`, `Ok(v)`, `Err(e)`, `Nil` (`nil`),
`q(v)` / `d(a, b)` (underlying operators), `p(fn)` / `pa(fn)` (exception to
Result wrappers).

### 9.2 Collection functions (UFCS)

`map`, `filter`, `reduce`, `find`, `findIndex`, `some`, `every`, `count`,
`sum`, `min`, `max`, `uniq`, `flat`, `reverse`, `join`, `contains`, `sort`,
`sortBy`, `zip`, `enumerate`, `take`, `drop`, `first`, `last`, `groupBy`,
`chunk`, `each`, `push`, `pop`, `shift`, `unshift`.

Notes: `reduce(xs, init, f)` calls `f(acc, value, index)`; call `sum(xs)`,
`min(xs)`, `max(xs)` with a collection. `sort(cmp?)` uses natural ordering or
a comparator returning a number (or truthy for "less than"). `groupBy(key)`
returns a record of arrays keyed by `str(key(v))`.

```tel
xs = [5, 3, 8, 1]
print(xs.sort(), xs.filter(_ > 2).map(_ * 10))
parity = x => ("even" if x % 2 == 0 else "odd")
print(xs.reduce(0, (a, b) => a + b), xs.groupBy(parity))
```
The second `print` in that example uses a ternary whose condition is
`_ % 2 == 0`; placeholders rewrite to one-argument lambdas in call arguments.

### 9.3 String functions (UFCS)

`upper`, `lower`, `trim`, `split(sep)`, `replace(a, b)`, `replaceAll(a, b)`,
`startsWith(p)`, `endsWith(p)`, `includes(p)`, `repeat(n)`, `chars`, `padStart`,
`padEnd`, `lines`. Collection methods `map`, `filter`, `reduce`, `find`, `some`,
`every`, `count`, `sum`, `join`, `contains`, `sort`, `reverse`, `take`, `drop`,
`first`, `last`, `each`, `len` also work on strings.

### 9.4 Runtime namespaces

| Namespace | Exports |
|---|---|
| `std.json` / global `json` | `parse(s) -> Ok(value)/Err(msg)`, `stringify(x[, indent])`, `pretty(x)` |
| `std.math` / global `math` | `pi`, `e`, `abs`, `floor`, `ceil`, `round`, `sqrt`, `pow`, `min(xs)`, `max(xs)`, `sin`, `cos`, `tan`, `log`, `exp`, `random()` |
| `std.fs` / global `fs` | `read(p) -> Result`, `readBytes(p) -> Result`, `write(p, data) -> Result`, `append`, `exists(p)`, `list(p='.') -> Result`, `remove`, `mkdir`, `cwd()`, `readJson -> Result`, `writeJson -> Result` |
| `std.http` / global `http` | `res(status, body, headers)`, `async serve(port, handler[, host]) -> {port, close()}`, `async get(url) -> Result`, `async post(url, body) -> Result` |
| `std.env` / global `env` | `get(name[, fallback])`, `set(name, value)`, `args`, `cwd()`, `exit(code)` |
| `std.time` / global `time` | `now()`, `iso()`, `async sleep(ms)` |
| browser target | HTML/SVG tag functions (`div`, `h1`, `button`, ...), `h`, `frag`, `sig`, `mount`, `html`/`renderToString`, `text` (tag) |

The global array `args` contains CLI arguments passed after `--`.

HTTP handler receives a record `{method, path, query, headers, body}`. Return
an object to send JSON, a string to send text, `nil` for 204, or use
`http.res(status, body, headers)` for explicit control.

```tel
r = json.parse('{"ok": true, "n": 2}') ?? "bad"
print(r, r?.ok)
print(math.floor(math.pi), math.max([2, 9]))
print(env.get("NO_SUCH_ENV_VAR", "fallback"))
print("missing env:", env.get("NO_SUCH_ENV_VAR_123", "unset"))
```


## 10. Code generation targets

`tel build FILE --target T` emits a runnable program.

- **`js`** (default): one self-contained Node ESM file with the runtime inlined;
  runs `main` when present. Node std namespaces (`fs`, `http`, `env`, `time`)
  are available.
- **`web`**: self-contained browser bundle. HTML/SVG tag functions build
  virtual nodes; top-level `x = init` bindings inside `web fn` components
  become reactive signals; `mount(App)` renders into `#app`; `renderToString`
  supports SSR. Program entry is `main`/`App` when `document` exists.
- **`ts`**: typed output. The entry becomes
  `<entry>.ts`, imported Tel modules are emitted as `.ts` preserving paths, and
  one shared `tel_runtime.ts` holds `export const __ = ...` runtime. Output runs
  with `node app.ts` (Node type stripping). Type mapping: `Num`->`number`,
  `Str`->`string`, `Bool`->`boolean`, `[T]`->`T[]`, `T?`->`T|null`,
  `{x: T}`->`{x: T}`, function types, unions as discriminated `__tag`/`__v`
  unions. Calls/member chains rooted at a JS import or `new` emit direct JS
  method calls so npm typings and callback inference survive; Tel UFCS falls
  back to the shared runtime dispatcher.

`web` frontend components use call-style view construction, not JSX:

```tel
web fn App():
  n = 0
  div(class="app",
    h1("Counter ", n),
    button(onclick=() => n += 1, "+"))
```

`tel check FILE...` runs static checks (undefined names, scopes, arity,
`return`/`break`/`continue` placement, duplicate bindings, annotation names,
import awareness). `tel check --tsc` also runs `tsc` when it is installed.


## 11. JS/npm interop semantics

- Tel records, arrays, and tuples are plain JS objects/arrays; numbers,
  strings, booleans, and `nil` are primitives; sums are plain objects with
  `__tag`/`__v`/`__t` (duck-typed, so values survive across module copies).
- `import "spec" as x` binds `mod.default ?? mod`; when the default is an
  object/function, named exports are copied onto it; `__ns` is set so member
  calls dispatch directly. `import "spec" {a, b}` binds named exports.
  `import "spec" * as ns` binds the real module namespace (typed in
  `--target ts`).
- Native JS prototype methods work on class instances (`m.get(k)`,
  `d.toISOString()`, `url.toString()`). Tel core methods win for List, Str,
  Record, Range, and Sum values.
- Tel lambdas are JS arrow functions: pass them to `map`, event handlers,
  Express route callbacks, and other JS APIs.
- `await` handles promises; `try/catch` catches rejected promises when awaited.
- `?` only understands Tel `Ok`/`Err` sums, not rejected promises.

```tel
import "node:path" as path
import "node:url" {pathToFileURL} as url
p = path.join("a", "b", "c")
print(p, pathToFileURL(p).toString())
d = new Date(0)
print(d.toISOString())
```
`pathToFileURL` is a named export of `node:url`; `url` is the namespace alias.


## 12. Current limitations and known gaps

These are real behavior of the v0.2 tree at the time of writing. They are
reported so agent-generated code can avoid them.

1. Named arguments to ordinary functions are collected into an object passed as
   the first positional argument; they are intended for record/union
   constructors. Example: `fn f(a, b)` called `f(b=2, a=1)` receives
   `{b: 2, a: 1}` as `a` and `nil` as `b`.
2. `_` is only a lambda inside call arguments; using it elsewhere raises
   "`_` is only valid as a shorthand lambda argument". In patterns it is the
   wildcard.
3. `spawn` is a prefix keyword, not a function: write `spawn work()`. The JS
   function-call spelling `spawn(...)` groups the expression.
4. `match` has no exhaustiveness checking; a non-matching subject raises
   `match: no arm matched <value>`.
5. Type annotations and generics are not enforced by the interpreter; they are
   metadata for `--target ts` and `tel check`.
6. Map-comprehension keys are literal identifiers or string literals only;
   computed keys (`[expr]: v`) are not supported.
7. There are no classes, traits, interfaces, macros, JSX, or operator
   overloading. Use records + functions, or JS/npm classes via import/`new`.
8. `if` is a statement, not an expression; the conditional expression form is
   `then if cond else other`. A trailing `if`/`match` statement in a function
   body still yields its value.
9. `String` slice bounds are clamped by JS semantics; out-of-range numeric
   indices return `nil` (or `undefined`) rather than raising.
10. Static `tel check` cannot see through dynamic JS imports; interop-heavy
    code may need `Any` annotations.

## 13. Grammar sketch

```
program    := statement*
statement  := import | modifier* fnDecl | typeDecl
            | if | for | while | loop | match | try | return | throw
            | break | continue | defer | binding | exprStmt
fnDecl     := "fn" (Type ".")? name generics? params ("->" type)?
              ("=" expr | ":" block)
typeDecl   := ("type"|"enum") name generics? "=" variantList
            | "type" name generics? "=" ("{" fields "}" | type)
import     := "import" (modulePath ("as" name)? | string ("{" names "}")? ("as" name)?)
binding    := pattern (":" type)? "=" expr
expr       := assignment | ternary | pipeline | binary | unary | postfix
match      := "match" expr ":" block(arm+)
arm        := pattern ("if" expr)? ":" body
```
