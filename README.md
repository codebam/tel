# Tel

**A token-efficient language for AI-authored code.** Tel has a tree-walk
interpreter and compilers to TypeScript, JavaScript, and the browser. It is
designed so an agent can read one compact guide and start writing working
programs immediately — while every JavaScript/npm library stays available.

```tel
import std.http as http

fn route(req):
  match req.path:
    "/": {ok: true, lang: "tel"}
    _: http.res(404, {error: "not found"})

async fn main():
  server = await http.serve(int(env.get("PORT", "8080")), route)
  print("listening on :{server.port}")
```

```bash
node bin/tel.mjs run app.tel
node bin/tel.mjs build app.tel --target ts --outdir out   # typed ESM
node out/app.ts                                           # Node >= 22
```

---

## Start here: point your agent at `AGENTS.md`

`AGENTS.md` is the language's onboarding surface for coding agents. It is a
**2193-token** guide (budgeted to fit comfortably in context), every fenced
snippet executes in CI, and it is byte-identical to `docs/AGENT-GUIDE.md`:

```bash
node bin/tel.mjs guide        # print the guide
node bin/tel.mjs init         # create main.tel + AGENTS.md in the current project
```

### The one prompt that works everywhere

Paste this into your agent before it writes any Tel:

```text
Read AGENTS.md first and follow it. Write new application code in Tel (.tel),
not TypeScript. Use `node bin/tel.mjs run FILE` to execute and
`node bin/tel.mjs check FILE` before you finish. If you need details beyond
AGENTS.md, read docs/SPEC.md.
```

### Make the guide load automatically

Most agents read a conventional file from the repo root. `tel init` already puts
`AGENTS.md` there; wire it into your harness with the one-liner below.

| Harness | One-time setup | Notes |
|---|---|---|
| Codex, opencode, agents with `AGENTS.md` support | nothing | root `AGENTS.md` is ingested automatically |
| Claude Code | `ln -s AGENTS.md CLAUDE.md` | or put `@AGENTS.md` in an existing `CLAUDE.md` |
| Cursor | `mkdir -p .cursor/rules && printf 'Always read and follow AGENTS.md before writing Tel code.\n' > .cursor/rules/tel.mdc` | project rule, always applied |
| Windsurf | `ln -s AGENTS.md .windsurfrules` | or paste its contents |
| Aider | `aider --read AGENTS.md .` | or add `read: AGENTS.md` to `.aider.conf.yml` |
| GitHub Copilot | `mkdir -p .github && ln -s ../AGENTS.md .github/copilot-instructions.md` | repo-wide instructions |
| Anything else | symlink/copy `AGENTS.md` to the file your tool auto-loads | the content is the contract |

In this repository, `AGENTS.md` is already at the root — cloning and opening it
with an AGENTS-aware agent is enough. The same file is what `tel init` installs
into user projects, so agents picking up a Tel codebase get the language guide
without being told.

### Why this works

- **Small enough to always be in context** — 2193 cl100k tokens, measured and
  budgeted at 2200 by `tools/tokcount.mjs`.
- **Executable, not prose** — 10/10 `tel` snippets in the guide and 26/26 in
  `docs/SPEC.md` are run by the test suite, so agents cannot copy stale code.
- **Complete surface in one file** — syntax, types, patterns, UFCS methods,
  collections, errors, stdlib, JS/npm interop, gotchas, and three copy-paste
  programs (CLI, HTTP API, frontend component).
- **Machine-checked feedback loop** — `tel check` and `tel build` give
  agents `file:line:col` diagnostics instead of runtime guesswork.

---

## Install

Requires **Node >= 22** for running `.ts` output directly (Node >= 20 works if
you compile TypeScript with `tsc`). The toolchain has **zero npm dependencies**.

```bash
git clone <this-repo> tel
cd tel
node bin/tel.mjs --version

# optional: put `tel` on PATH
npm link            # or: ln -s "$PWD/bin/tel.mjs" ~/.local/bin/tel
```

## Use it

```bash
tel init                                  # main.tel + AGENTS.md
tel run app.tel -- arg1 arg2              # interpreter, calls fn main(args)
tel build app.tel --target ts --outdir out
tel build app.tel --target js -o app.mjs  # standalone ESM
tel build app.tel --target web -o app.mjs # browser bundle (DOM + signals)
tel check app.tel                         # static checker
tel check --tsc app.tel                   # also run tsc when available
tel fmt --write app.tel                   # canonical formatter
tel tokens app.tel                        # exact cl100k counts
tel guide                                 # print AGENTS.md
tel test                                  # node --test test/
```

## JavaScript and npm interop

```tel
import "node:path" as path
import "node:fs" {readFileSync} as fs
import "node:path" * as nspath

u = new URL("https://example.com/a?q=1")
m = new Map()
m.set("k", 42)
print(path.join("a", "b"), fs.existsSync("package.json"), nspath.basename("/x/y"), u.pathname, m.get("k"))
```

Default, named, and `* as` namespace imports work; `new` chains, native
prototype methods/getters, CJS/ESM/mixed modules, Tel lambdas as callbacks, and
`await` on promises all behave the same under `tel run`, `--target js`, and
`--target ts`. Named and `* as` imports keep real TypeScript typings; a default
alias (`as x`) is typed `any` with `default ?? namespace` hydration.

## Token efficiency

Exact `cl100k_base` counts (`tools/tokcount.mjs`) over six equivalent programs:
**Tel 540 tokens vs TypeScript 759 — 28.9% fewer**, with an HTTP JSON payload
verified byte-identical. Tables and methodology: `docs/TOKENS.md`.

## Documentation

| File | Purpose |
|---|---|
| `AGENTS.md` / `docs/AGENT-GUIDE.md` | the 2193-token agent guide (identical copies) |
| `docs/SPEC.md` | full language reference, grammar, stdlib, targets, limitations |
| `docs/TOKENS.md` | exact token measurements vs Python/TypeScript |
| `docs/VERIFICATION.md` | independent verification report (79 tests, V1–V19) |
| `docs/PLAN.md` | architecture, interfaces, and build status |
| `examples/` | basics, tour, pipeline, algo, server, web, interop, express |

## Project layout

```
bin/tel.mjs        CLI entry
src/lexer.mjs      layout-sensitive lexer
src/parser.mjs     AST parser (+ locations)
src/interp.mjs     tree-walk interpreter
src/check.mjs      static checker
src/codegen.mjs    TS / JS / Web compiler
src/fmt.mjs        canonical formatter
runtime/           shared runtime + Node/browser factories
tools/tokcount.mjs exact cl100k token counter
test/              CLI suite + independent verification suite
```

## Status

v0.2, verified: **94 tests / 93 pass / 0 fail / 1 skip** (`tsc` absent in the
sandbox). All 19 reported bugs are fixed with regression tests. Known residuals
are listed in `docs/VERIFICATION.md`.

## License

MIT (see `package.json`).
