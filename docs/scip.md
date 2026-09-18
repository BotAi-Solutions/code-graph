# SCIP

[SCIP](https://github.com/sourcegraph/scip) is an open interchange format for
code-intelligence data. An indexer compiles a repository and emits an
`index.scip` — a protobuf file describing every symbol, where it is defined and
everywhere it is referenced.

We consume SCIP. We do not extend it, emit it, or model our graph on it. The
`packages/scip` boundary exists to make sure of that.

## Why SCIP rather than parsing ourselves

A SCIP indexer runs the real compiler. `scip-typescript` uses the TypeScript
compiler API, so it resolves imports, generics, inheritance and re-exports
exactly as `tsc` does. A hand-written parser would have to reimplement a type
checker to get `this.repository.findById(id)` right, and would be wrong in a
different way for every language.

The cost is an external process and a format we have to decode. That is the
trade the `ScipIndexer` and parser boundaries pay for.

## The indexer adapter

```ts
interface ScipIndexer {
  readonly name: string;
  supports(language: SupportedLanguage): boolean;
  index(repositoryPath: string, options?: ScipIndexOptions): Promise<ScipIndexResult>;
}
```

`TypeScriptScipIndexer` is the first implementation. It decides *how to invoke*
`scip-typescript` and nothing else:

```
scip-typescript index --cwd <repo> --output <workspace>/index.scip \
                      --infer-tsconfig --no-progress-bar
```

- `--output` goes to the per-analysis workspace directory, so concurrent
  analyses cannot overwrite each other's index.
- `--infer-tsconfig` keeps plain JavaScript repositories analysable.
- The binary is resolved by walking up `node_modules/.bin` from the process
  working directory before falling back to `PATH`, so it works whether the
  indexer was installed as a workspace dependency or globally.
  `SCIP_TYPESCRIPT_COMMAND` overrides the name or supplies an absolute path.

Process execution goes through an injected `CommandRunner`. Tests substitute a
fake and never spawn anything; `apps/worker/tests` uses one that drops the
checked-in fixture where the indexer would have written it.

Failures are distinguished — non-zero exit, timeout, and "could not execute at
all" each produce a different message, the last one naming the environment
variable to set.

## The parser

`packages/scip/src/parser` decodes `index.scip` **directly into our own types**.
There is no generated protobuf layer and no `ScipProtoDocument` passing through
the application.

- `protobuf.ts` — a wire-format reader for the two wire types SCIP uses, which
  skips unknown fields correctly. An index from a newer indexer still parses.
- `scip-index.ts` — decoders for `Index`, `Metadata`, `Document`, `Occurrence`
  and `SymbolInformation`, producing `ScipIndex` / `ScipDocument` /
  `ScipSymbol` / `ScipOccurrence`.
- `symbol.ts` — a parser for the SCIP symbol grammar.
- `kinds.ts` — normalises symbol kinds into one language-neutral vocabulary.

**Document text is skipped.** SCIP field 5 carries each file's full contents;
the parser steps over it. Source code must never enter the graph, the logs or
the database.

Documents are sorted by path after parsing, because the builder downstream
promises determinism.

### Symbol strings

A SCIP symbol is a structured string, and the only identifier the format
guarantees to be stable across runs:

```
scip-typescript npm typescript-sample 1.0.0 src/services/`user.service.ts`/UserService#getUser().
└──scheme────┘ └┬┘ └──────package───┘ └─ver┘ └──────────── descriptors ─────────────────────────┘
               manager
```

Descriptor suffixes: `/` namespace, `#` type, `.` term, `name().` method,
`[T]` type parameter, `(p)` parameter, `:` meta, `!` macro. Names containing
spaces or punctuation are backtick-escaped, with a doubled backtick as the
literal.

`parseScipSymbol` returns the package header, the descriptor chain, and the
**owner** — the symbol string of the lexically enclosing symbol, computed from
the descriptor offsets rather than by string surgery. The owner is what the
graph builder turns into `CONTAINS` edges, and it works through escaped
segments where naive prefix matching would not.

Malformed symbols degrade to a best-effort identity rather than throwing: an
indexer bug should cost one node, not the whole analysis.

### Symbol kinds, and the gap SCIP leaves

`SymbolInformation.kind` is optional. **scip-typescript 0.4 sets it on no symbol
at all** — every symbol in the sample repository comes back
`UnspecifiedKind`.

So kinds are inferred from the descriptor chain, which is language-neutral and
carries more than the leaf alone:

| Descriptor | Owner | Inferred kind |
| --- | --- | --- |
| `foo().` | a type (`#`) | `method` |
| `foo().` | a namespace | `function` |
| `foo.` | a type (`#`) | `property` |
| `foo.` | a namespace | `variable` |
| `Foo#` | any | `class` (ambiguous — see below) |
| `foo/` | — | `file` when the name looks like a filename, else `namespace` |

That leaves `class`, `interface`, `enum` and `type` indistinguishable, which
matters: it decides whether an inheritance edge is `IMPLEMENTS` or `EXTENDS`.

### Refiners: recovering what the indexer did not say

```ts
interface ScipSymbolRefiner {
  readonly name: string;
  supports(language: SupportedLanguage): boolean;
  refine(index: ScipIndex, context: RefineContext): Promise<ScipIndex>;
}
```

`TypeScriptSymbolRefiner` recovers the distinction. Every definition has an
exact range, so the declaring keyword is whatever precedes the name on that
line, past any modifiers:

```
export abstract class UserController extends BaseController {
                ^^^^^ the keyword at the definition's column
```

It reads that one token — `interface`, `class`, `enum`, `type`, `function`,
`const`, `get`/`set` — and upgrades the kind. Nothing else is read, retained,
logged or stored. A refined kind never overrides structural information the
descriptor chain already established: a `method` stays a method whatever the
line begins with.

This is the *only* code in the pipeline that knows TypeScript syntax, and it is
behind an interface. Languages with no refiner get a no-op.

## Adding a language

1. Implement `ScipIndexer` in `packages/scip/src/indexers` wrapping the official
   indexer (`scip-python`, `scip-go`, `scip-java`, `scip-dart`, `rust-analyzer`).
   Use the injected `CommandRunner`.
2. Add a detector in `packages/language-detection/src/detectors` and register it
   in `createDefaultDetectors()`.
3. Register the indexer in `createDefaultIndexerRegistry()`.
4. If that indexer also leaves `kind` unspecified, add a `ScipSymbolRefiner`.
5. Add the language's extensions to `languageFromPath`.
6. Verify with `pnpm setup:scip`.

Nothing in `packages/graph`, `packages/database`, `apps/api` or `apps/web`
changes. That is the point of the boundary.

## What SCIP is, and is not, responsible for

Worth stating plainly now that the graph reads Markdown, YAML and SQL as well:

**SCIP is the deterministic source of truth for code-level relationships.** A
definition, a reference, a call, an implementation, an import, a containment
chain — if the compiler knows it, SCIP is where the graph gets it, and nothing
else in the pipeline overrides it. `ScipAnalyzer` runs in its own stage, first,
and every later analyzer resolves its findings *against* what SCIP found.

Everything else is repository knowledge: facts a compiler never had an opinion
about, read from declarations by the analyzers in `packages/analysis`. They may
add nodes the compiler did not produce and edges it could not see, and they may
annotate a SCIP node with what they learned — but they never replace one. The
accumulator's first-writer-wins rule is what enforces that, and the stage order
is what makes SCIP the first writer.

See [repository-knowledge.md](repository-knowledge.md).

## Fixtures

`packages/scip/tests/fixtures/*.scip` is real output from scip-typescript 0.4
over the sample repositories in `test-repositories/`. The parser, the builder,
the analyzers, the worker pipeline and the benchmark are all tested against
them, so the suite verifies agreement with a real indexer rather than with our
own encoder.

| Fixture | Sample | Exercises |
| --- | --- | --- |
| `typescript-sample.scip` | a small layered service | the parser and the builder |
| `express-postgres-sample.scip` | Express, SQL, a queue, an event bus, two integrations | the source analyzers |
| `repository-knowledge-sample.scip` | the above plus Markdown, JSON, YAML, OpenAPI and migrations | the repository analyzers and the benchmark |

Regenerate all of them after changing a sample repository:

```bash
pnpm fixtures:build
```

scip-typescript is deterministic over unchanged sources, so a regenerated
fixture is byte-identical unless a sample actually changed — a dirty
`git status` afterwards is the signal to re-check the expectations, including
the benchmark's ground truth.

Hand-built payloads in `packages/scip/tests/helpers/protobuf-writer.ts` cover
what a real indexer will not produce on request: unknown fields, unpacked
repeated values, truncated buffers.
