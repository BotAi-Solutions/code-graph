# Architecture

## The five things, and why they are different things

The words below get used interchangeably in conversation. They are not the same
and the codebase keeps them apart deliberately.

| Term | What it is | Where it lives |
| --- | --- | --- |
| **SCIP** | An open interchange format for code-intelligence data, and the indexers that emit it. An input we consume. | `packages/scip` |
| **Code knowledge graph** | *Our* normalised model of a codebase: typed nodes and typed relationships. The product. | `packages/graph` |
| **Source analysis** | The second source of facts: AST and framework analysis, for what a compiler has no opinion about. | `packages/analysis` |
| **Graph database** | Where the graph is persisted. Today PostgreSQL. An implementation detail. | `packages/database` |
| **Graph API** | The traversal-first HTTP contract over the graph. | `apps/api` |
| **Graph UI** | The visual explorer. | `apps/web` |

The internal graph is **not** a "Sourcegraph graph". SCIP is a format we read,
the way a compiler reads source. The vocabulary in `packages/graph` is ours: we
choose what a node is, what an edge means, and what identity a symbol has. That
is what made it possible to add the second source of facts — the source
analyzers in `packages/analysis` — without renegotiating the model, and what
will make a third (a runtime tracer, an embedding index) the same kind of
addition.

A compiler can tell you that `UserRepository.create` calls `Pool.query`. It has
no opinion about the fact that `POST /users` reaches that method, or that the
statement it runs writes to a table called `users`. Those are the facts that
turn a symbol graph into a knowledge graph, and they are read from the syntax by
analyzers — never guessed from a file name.

---

## Pipeline

```
Repository (git or local path)
        │
        │  RepositoryLoader          apps/worker/src/services
        ▼
Working tree on disk
        │
        │  LanguageDetectionService  packages/language-detection
        ▼
SupportedLanguage
        │
        │  ScipIndexerRegistry       packages/scip/src/indexers
        ▼
ScipIndexer.index()  ───────────────▶  index.scip
        │
        │  readScipIndexFile         packages/scip/src/parser
        ▼
ScipIndex  (our types — no protobuf)
        │
        │  ScipSymbolRefiner         packages/scip/src/adapters
        ▼
ScipIndex with language-specific kinds recovered
        │
        │  ScipAnalyzer              packages/graph/src/analysis
        │    └─ ScipGraphBuilder     packages/graph/src/builder
        ▼
CodeGraph  { nodes, edges }          — the code-intelligence stage
        │
        │  source analyzers          packages/analysis
        │    file · import · structure · api · database ·
        │    external-service · messaging
        ▼
CodeGraph  + APIs, tables, queues, events, integrations, dependencies
        │
        │  FrameworkAnalyzer         packages/analysis  (classification stage)
        ▼
CodeGraph  + frameworks and class roles
        │
        │  CodeGraphAssembler        packages/graph/src/analysis
        ▼                            — owns identity and the merge rules
CodeGraph  { nodes, edges, stats }
        │
        │  GraphRepository           packages/database
        ▼
PostgreSQL
        │
        │  GraphService              apps/api/src/modules/graph
        ▼
HTTP  ───────────────────────────────▶  React + Cytoscape
```

Each arrow is an interface, not a call into a concrete class. The worker knows
`ScipIndexer`, not `scip-typescript`. The builder knows `ScipSymbolKind`, not
TypeScript. The API knows `GraphStore`, not SQL.

---

## Layers

### `packages/shared`

Types, Zod schemas and constants that more than one package needs: the API
envelope, `CodeNode`/`CodeEdge`, `SupportedLanguage`, analysis statuses, error
codes, environment schemas. It has no workspace dependencies, which is what
keeps the dependency graph a DAG.

`SupportedLanguage` is declared here rather than in `language-detection`,
because the graph, the database and the SCIP layer all speak it and none of them
should have to depend on detection to name a language. `@ckg/language-detection`
re-exports it, so detection remains the single import for callers that do care.

The logger lives on the `@ckg/shared/logger` subpath rather than the package
root, so the browser bundle can import the same types and constants without
pulling in a Node-only dependency.

### `packages/language-detection`

One filesystem walk produces a `RepositoryScan`; each detector is a pure
function over it. Detectors return *evidence* (a score plus human-readable
markers), not a verdict, so the ranking is in one place and a new language is
one class.

### `packages/scip`

Three responsibilities, cleanly separated:

- **`indexers/`** — adapters that run a real SCIP indexer. `ScipIndexer` is the
  seam; `TypeScriptScipIndexer` wraps `scip-typescript`. Process execution goes
  through an injected `CommandRunner`, so tests never spawn anything.
- **`parser/`** — a protobuf wire reader plus decoders for the SCIP messages,
  which produce our own `ScipIndex`/`ScipDocument`/`ScipSymbol` types directly.
  No protobuf value escapes this directory.
- **`adapters/`** — language-specific post-processing. SCIP's
  `SymbolInformation.kind` is optional and scip-typescript sets it on no symbol
  at all, which would leave classes, interfaces, enums and type aliases
  indistinguishable. `TypeScriptSymbolRefiner` recovers the distinction by
  reading the declaring keyword at each definition's exact range. This is the
  only code in the pipeline that knows what `interface` means, and it is behind
  an interface of its own.

Document source text (SCIP field 5) is skipped during parsing. Source code never
enters the graph, the logs or the database.

### `packages/graph`

The domain. `model/` owns identity, `normalizer/` turns SCIP documents into
position-resolved definitions and references, `builder/` assembles the graph,
`analysis/` defines the analyzer seam and the merge, `traversal/` walks the graph
in memory, `serializers/` renders it deterministically.

The builder is language-agnostic by construction: everything it knows about a
symbol arrives as the neutral `ScipSymbolKind` vocabulary. It never inspects a
file extension, a syntax token or a framework convention.

`analysis/` is the extension point. `CodeAnalyzer` is the interface every source
of facts implements — SCIP included — and `CodeGraphAssembler` owns what happens
when two of them describe the same thing. Its rules are short and are the
graph's guarantees: identity decides everything, the first writer wins for
nodes, later analyzers annotate rather than replace, no edge exists without both
endpoints, and every edge carries evidence. `SymbolIndex` is how an analyzer
finds a node to point at, and it only answers questions scoped by file — which
is what keeps resolution from degenerating into name matching.

The whole pipeline is deterministic by construction — content-hash identities,
`Map` accumulators, fixed analyzer order, sorted output. Running it twice over
the same commit produces byte-identical results, which is what makes persistence
an idempotent replace and lets the UI keep its selection across a re-analysis.

See [graph-model.md](graph-model.md).

### `packages/analysis`

The second analysis layer: what the compiler has no opinion about.

- **`source/`** — one pass over the repository, shared by every analyzer: files
  read once, parsed once with the TypeScript compiler's own parser (syntax only,
  no type checker, so a repository whose dependencies are not installed still
  analyses), and one binding table per module recording what every name refers
  to. A live `.env` is listed but never read: its path is a fact about the
  service, its contents are credentials.
- **`detectors/`** — the pattern knowledge, in tables: HTTP methods, SQL
  statement forms, Prisma schema syntax, vendor packages and API hosts,
  frameworks. Data rather than code, so adding a vendor is a line.
- **`analyzers/`** — one analyzer per kind of fact, each returning a description
  of what it observed with the evidence for it, and nothing when the evidence is
  weak.

Parsing rather than pattern-matching text is the basis for the evidence quality
the graph promises: `@Controller('/users')` inside a comment is not a
controller, and a regex cannot tell the difference.

### `packages/database`

The only place with SQL. `Queryable` is the interface repositories depend on, so
a pool and a transaction are interchangeable and nothing above knows about `pg`.

Traversal happens in the database, in a recursive CTE, not in Node: walking two
hops of a large repository must not mean shipping the whole graph to the
application first. `packages/graph/src/traversal` implements the same semantics
in memory, which gives tests something to check the SQL against.

### `apps/api`

Fastify, Zod-validated, OpenAPI-documented. Three strict rules:

1. **Routes are thin.** Validate, delegate, wrap. No branching on domain state.
2. **Services are Fastify-free.** They take plain inputs, return plain values,
   and throw `AppError`. They can be constructed and called from a test with no
   HTTP anywhere.
3. **Services depend on structural store interfaces**, not on the concrete
   `@ckg/database` classes. `apps/api/tests` runs the entire route surface
   against in-memory stores.

Every response — success or failure — leaves through one envelope and one error
handler. See [api.md](api.md).

### `apps/worker`

`AnalyzeRepositoryJob` is the pipeline; `AnalysisProcessor` is the loop that
feeds it; `AnalysisJobQueue` is the seam between them. The MVP claims jobs from
PostgreSQL with `FOR UPDATE SKIP LOCKED`, which is already safe for several
worker processes. Introducing BullMQ means writing one more implementation of
`AnalysisJobQueue` — the job and the processor do not change.

Every dependency is injected, so `apps/worker/tests` runs the whole pipeline
with a fake command runner and in-memory stores.

### `apps/web`

React, Vite, Cytoscape. The UI holds no graph of its own and derives no facts
from the canvas: view state (root, depth, filters) is pushed to the API on every
change, and the inspector shows what the API returns. Filters are applied server
side during traversal — the point is to fetch less, not to hide what was already
fetched.

The UI depends only on the HTTP contract. It has no idea PostgreSQL exists.

---

## Cross-cutting rules

**Configuration.** `process.env` is read in exactly two files: the API's and the
worker's `config/index.ts`. Both validate with Zod at startup and fail with the
offending variable's *name*, never its value.

**Errors.** `AppError` carries a stable `ErrorCode`; `ERROR_CODE_STATUS` maps it
to an HTTP status; one Fastify error handler renders it. Unexpected errors are
logged in full and reported as a generic 500 — internals never reach a client.
Nothing throws a string.

**Logging.** One JSON object per line. Application logs on stdout, `error` and
`fatal` on stderr. Every line carries `time`, `level`, `module` and `msg`;
`jobId` and `projectId` are bound by the pipeline where they apply. Source code,
secrets, tokens and environment variables are never logged — the logger also
redacts a set of well-known keys as defence in depth.

**Asynchrony.** Analysis never runs inside an HTTP request. `POST /analysis`
returns `202` with a `QUEUED` job; the client polls.

**Bounded reads.** The graph API never returns a whole repository. A request
either traverses from a root node with a small default depth, or asks for the
ranked overview. Both are capped, and the response says when it was truncated.
The UI grows a view by expanding one node at a time — the same endpoint at depth
1, merged client-side by id — rather than by fetching more.

**Evidence.** Every edge records what observed it and how much that observer
trusts it. An analyzer that cannot resolve a reference emits nothing rather than
a guess, and the assembler has no way to record an edge without evidence. This
is the property the whole graph's usefulness rests on: a graph you have to
second-guess is worse than a smaller one you can trust.

---

## What this makes possible later

The phases that are explicitly out of scope each attach at an existing seam:

| Later phase | Where it attaches | What changes |
| --- | --- | --- |
| More languages | `ScipIndexerRegistry.register()` | One `ScipIndexer`, optionally one `ScipSymbolRefiner` |
| More frameworks | `createDefaultAnalyzers()` | One `CodeAnalyzer`, or one entry in a detector table |
| BullMQ / distributed workers | `AnalysisJobQueue` | One implementation; the job is untouched |
| Qdrant + embeddings | Beside `GraphRepository` | Node text is already addressable by stable id |
| CodeRAG | Above the graph API | Reads the same traversal contract the UI uses |
| MCP server | Beside `apps/api` | Exposes the existing services; no new domain code |
| Incremental indexing | `ScipGraphBuilder` + `GraphRepository` | Stable ids already make diffing possible |
| Neo4j | `GraphRepository` | Swap the implementation; the interface is already traversal-shaped |

Stable, content-derived node identity is the load-bearing decision here. It is
what lets an embedding, a cached summary or a diff refer to a piece of code and
still mean the same piece of code after the next analysis.
