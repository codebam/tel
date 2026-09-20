# Tel token-efficiency measurements

Exact cl100k_base BPE counts for equivalent Tel, Python, and TypeScript
programs. Generated with `node tools/tokcount.mjs FILE... [--json]`, which uses
`tools/vocab/cl100k_base.tiktoken` and the GPT-2 byte encoder + cl100k
pretokenization regex + rank-based merges.

- `chars` = Unicode code points; `bytes` = UTF-8 bytes; `tokens` = cl100k_base.
- Tokenizer: OpenAI `cl100k_base` (GPT-4 family). `countTokens("hello world")`
  is 2 and `countTokens("tiktoken is great!")` is 6, matching upstream.
- Corpus: `examples/tokenbench/`. Python 3.14, Node 26 (`.ts` run via Node type
  stripping). All programs were executed and their outputs compared.

## Example files (exact counts)

Every `.tel` file under `examples/` (excluding `examples/tokenbench/`), measured
with `node tools/tokcount.mjs examples/*.tel --json`:

| File | chars | bytes | tokens |
|---|---:|---:|---:|
| examples/algo.tel | 2362 | 2362 | 857 |
| examples/basics.tel | 1997 | 1997 | 713 |
| examples/express.tel | 541 | 541 | 138 |
| examples/interop.tel | 832 | 832 | 259 |
| examples/pipeline.tel | 2096 | 2096 | 667 |
| examples/server.tel | 708 | 708 | 235 |
| examples/tour.tel | 4116 | 4116 | 1450 |
| examples/web.tel | 457 | 457 | 125 |

## Base programs (Tel / Python / TypeScript)

| Program | Language | chars | bytes | tokens |
|---|---|---:|---:|---:|
| fizzbuzz | Tel | 136 | 136 | **58** |
| | Python | 142 | 142 | 59 |
| | TypeScript | 188 | 188 | 74 |
| list pipeline | Tel | 228 | 228 | **78** |
| | Python | 268 | 268 | 98 |
| | TypeScript | 296 | 296 | 100 |
| HTTP JSON handler | Tel | 327 | 327 | **104** |
| | Python | 976 | 976 | 264 |
| | TypeScript | 676 | 676 | 210 |
| **base total** | **Tel** | **691** | **691** | **240** |
| | Python | 1386 | 1386 | 421 |
| | TypeScript | 1160 | 1160 | 384 |

Ratios: Tel uses **57.0%** of the Python token count and **62.5%** of the
TypeScript count on these three programs (43% / 37.5% fewer tokens). By
characters it uses 49.9% of Python and 59.6% of TypeScript.

The fizzbuzz and list-pipeline gap is small because the programs are dominated
by control flow and builtins both languages share. The HTTP handler gap is
large because Tel's `std.http` is part of the language's runtime while the
Python and TypeScript versions assemble stdlib boilerplate by hand.

## v0.2 rows (Tel / TypeScript)

These target the v0.2 interop/type story: typed records, async loading, and
route dispatch.

| Program | Tel tokens | TypeScript tokens | Tel/TS | Tel savings |
|---|---:|---:|---:|---:|
| typed record pipeline | 89 | 124 | 71.8% | 28.2% |
| async load | 47 | 52 | 90.4% | 9.6% |
| route dispatcher | 164 | 199 | 82.4% | 17.6% |
| **total** | **300** | **375** | **80.0%** | **20.0%** |

All six programs combined: Tel **540** tokens vs TypeScript **759** tokens
(71.1%, 28.9% fewer). Note that the Tel files include their own entry points
and imports; most of the win comes from a higher-level stdlib and from
annotations that double as types without a separate `type` block.

## AGENTS.md budget

The `AGENTS.md` onboarding guide is contract-tested and budgeted at 2200
cl100k tokens. Measured at the final revision:

```
$ node tools/tokcount.mjs AGENTS.md docs/AGENT-GUIDE.md
path                    chars     bytes    tokens
AGENTS.md                6673      6673      2164
docs/AGENT-GUIDE.md      6673      6673      2164
total                   13346     13346      4328
```

`AGENTS.md` is an exact copy of `docs/AGENT-GUIDE.md`; both are 2164/2200
tokens (98.4% of budget) and all 10 fenced `tel` snippets execute under
`Runtime.runSource`.

## Exact commands

```bash
# counts for the corpus
node tools/tokcount.mjs examples/tokenbench/fizzbuzz.tel \
  examples/tokenbench/fizzbuzz.py examples/tokenbench/fizzbuzz.ts \
  examples/tokenbench/pipeline.tel examples/tokenbench/pipeline.py \
  examples/tokenbench/pipeline.ts examples/tokenbench/http_json.tel \
  examples/tokenbench/http_json.py examples/tokenbench/http_json.ts \
  examples/tokenbench/typed_pipeline.tel examples/tokenbench/typed_pipeline.ts \
  examples/tokenbench/async_load.tel examples/tokenbench/async_load.ts \
  examples/tokenbench/route.tel examples/tokenbench/route.ts

# guide budget
node tools/tokcount.mjs AGENTS.md
```

Observed totals for that corpus: chars 5379, bytes 5379, tokens 1720; Tel 540,
Python 421 (base three only), TypeScript 759.

## Equivalence checks

- `fizzbuzz.tel|py|ts`, `pipeline.tel|py|ts`, `typed_pipeline.tel|ts`,
  `async_load.tel|ts`, and `route.tel|ts` produce identical stdout for each
  program (`diff` clean after stripping the interpreter's `MAIN:` line).
- The HTTP programs were each started on a fixed localhost port and answered
  `/health`, `/sum?n=5`, `/sum?n=-2` with equal parsed JSON and `/nope` with
  404. Python emits its default `json.dumps` spacing (`{"n": 5, ...}`), so the
  output bytes differ while the JSON payloads are equal.

## Caveats

- cl100k_base is one tokenizer, not a universal measure. BPE rewards common
  identifiers and substrings; different tokenizers (and different model
  families) would shift the ratios.
- "Equivalent" means same observable behavior for the program's sampled
  execution, not a formal proof. The Python HTTP handler uses `http.server`,
  the TypeScript one uses `node:http`, and the Tel one uses `std.http`; these
  are comparable but not identical libraries.
- Formatting was normalized: 2-space indentation, no comments or blank filler,
  no golfing. Formatting alone can move token counts by several percent.
- Python is only measured for the three base programs; the v0.2 rows are
  Tel/TS by design because they exercise Tel's type annotation and interop
  syntax directly.
- The corpus is ASCII, so chars and bytes coincide. Non-ASCII source would make
  bytes the larger number.
- A language's token count only approximates agent cost: tool calls, edit
  diffs, generated output, and error recovery are not counted here.
