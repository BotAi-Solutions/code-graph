# Architecture

## The six things, and why they are different things

The words below get used interchangeably in conversation. They are not the same
and the codebase keeps them apart deliberately.

| Term | What it is | Where it lives |
| --- | --- | --- |
| **SCIP** | An open interchange format for code-intelligence data, and the indexers that emit it. An input we consume. | `packages/scip` |
| **Repository knowledge graph** | *Our* normalised model of a repository: typed nodes and typed relationships, covering its code and everything around it. The product. | `packages/graph` |
| **Source analysis** | The other sources of facts: AST, document, configuration, schema and SQL analysis, for what a compiler has no opinion about. | `packages/analysis` |
| **Graph database** | Where the graph is persisted. Today PostgreSQL. An implementation detail. | `packages/database` |
| **Graph API** | The traversal-first HTTP contract over the graph. | `apps/api` |
| **Graph UI** | The visual explorer. | `apps/web` |
| **Benchmark** | Measured reliability: precision, recall, evidence and path correctness against a hand-written ground truth. | `packages/benchmark` |

The internal graph is **not** a "Sourcegraph graph". SCIP is a format we read,
the way a compiler reads source. The vocabulary in `packages/graph` is ours: we
choose what a node is, what an edge means, and what identity a symbol has. That
is what made it possible to add the second source of facts — the source
analyzers in `packages/analysis` — without renegotiating the model, and what
will make a third (a runtime tracer, an embedding index) the same kind of
addition.

A compiler can tell you that `UserRepository.create` calls `Pool.query`. It has
no opinion about the fact that `POST /users` reaches that method, that the
statement it runs writes to a table called `users`, that the table has nine
columns because a migration says so, that `openapi.yaml` promised the operation
in the first place, or that the README explains why. Those are the facts that
turn a symbol graph into a repository knowledge graph, and every one of them is
read from a declaration — never guessed from a file name.

See [repository-knowledge.md](repository-knowledge.md) for the layer that reads
the non-code half, and [benchmark.md](benchmark.md) for how its reliability is
measured.

---

## Pipeline

```
Local folder
        │
        │  FilesystemService         apps/api/src/modules/filesystem
        │    └─ NativeDirectoryPicker   ── the OS's own dialog
        ▼
{ path, name }  ──▶  project + repository + queued analysis
        │
        │  RepositoryLoader          apps/worker/src/services
        ▼
Working tree on disk
        │
        │  scanProject               packages/language-detection
        │    └─ classifyFile            code · document · configuration ·
        │                               schema · database · generated ·
        │                               vendor · binary · unknown
        ▼
RepositoryScan + ProjectMetadata    ── counts, languages, categories, and
        │                              the denominator every later phase
        │                              reports progress against
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
        │    file · import · structure · api · sql · database ·
        │    configuration · external-service · messaging
        ▼
CodeGraph  + APIs, tables, columns, containers, config properties,
        │    queues, events, integrations, dependencies
        │
        │  classification analyzers  packages/analysis
        │    framework · openapi · document
        ▼                            — the only stage that can see both
CodeGraph  + class roles, API specifications and their endpoints,
        │    documents and their sections, and the cross-source edges
        │    that join a contract to its handler and prose to its subject
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
HTTP  ───────────────────────────────▶  normalizeGraph     apps/web
                                             │
                                             ▼
                                        Graphology → Sigma.js (WebGL)
```

Each arrow is an interface, not a call into a concrete class. The worker knows
`ScipIndexer`, not `scip-typescript`. The builder knows `ScipSymbolKind`, not
TypeScript. The API knows `GraphStore`, not SQL. And every analyzer, from SCIP
to the Markdown reader, enters through the same `CodeAnalyzer` seam — which is
why adding the repository layer changed no phase, no schema column and no
existing analyzer's behaviour.

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

The same walk is the project scanner. `scanProject` resolves and checks the
root, walks it once, and `summarizeScan` — pure, no I/O — turns the result into
`ProjectMetadata`: file and directory counts and a per-language breakdown. One
run walks the tree exactly once: the scan is handed to language detection and
then to `loadSourceFiles`, rather than each of the three walking for itself.

What the walk skips is an `IgnoreRules` policy, not a constant buried in the
loop. It can be extended (`extraIgnoredDirectories`) or replaced outright, which
is what keeps "this language's build output" from being a change to the walk.

`detectLanguage(filePath)` is the per-file question, answered today from the
extension. That it is a function rather than a map at the call sites is what
lets a content sniffer replace it later without touching one of them.

`classifyFile(path)` answers the other per-file question — *what kind of thing
is this* — and is what turned the scan from "code and everything else" into the
nine categories the repository graph is built on. It is deliberately path-only:
the walk opens no files, which is what lets a 25,000-file repository be sized up
in a second, and a category that genuinely needs the contents (a specification
under an unexpected name) is refined later by the analyzer that reads it. The
two questions are orthogonal and both are recorded: `vite.config.ts` is category
`code`, language `typescript`, role `tooling-config`.

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

Every analysis layer that is not the compiler: what a compiler has no opinion
about, and what it never reads at all.

- **`source/`** — one pass over the repository, shared by every analyzer: files
  read once, parsed once with the TypeScript compiler's own parser (syntax only,
  no type checker, so a repository whose dependencies are not installed still
  analyses), and one binding table per module recording what every name refers
  to. A live `.env` is listed but never read: its path is a fact about the
  service, its contents are credentials.
- **`parsers/`** — one per non-code format, each producing positions as well as
  content, because an edge whose evidence cannot name a line is an edge nobody
  can check. `structured.ts` is one model for JSON and YAML, so the OpenAPI
  extractor handles both without knowing which it got; `markdown.ts` is a
  focused CommonMark subset; `sql-schema.ts` reads the DDL that names things
  unambiguously and nothing else. No parser's own representation leaves this
  directory.
- **`detectors/`** — the pattern knowledge, in tables: HTTP methods, SQL
  statement forms, Prisma schema syntax, database drivers, vendor packages and
  API hosts, frameworks. Data rather than code, so adding a vendor is a line.
- **`analyzers/`** — one analyzer per kind of fact, each returning a description
  of what it observed with the evidence for it, and nothing when the evidence is
  weak.

Parsing rather than pattern-matching text is the basis for the evidence quality
the graph promises: `@Controller('/users')` inside a comment is not a
controller, a `# heading` inside a fenced code block is not a section, a table
name inside a SQL comment is not a table, and a regex cannot tell any of those
differences.

Three files are shared factories rather than lookups — `service-node.ts`,
`table-node.ts`, `config-node.ts` — because several analyzers describe the same
service, the same table and the same configuration file. Identity is a content
hash, so building the same draft is how they agree; an edge that relied on
another analyzer having run first is an edge that disappears when the analyzer
set changes.

### `packages/benchmark`

Measured reliability, not asserted reliability. It assembles the fixture graph
from the checked-in SCIP index and the real analyzers, scores it against a
hand-written ground truth, and prints precision, recall, F1, evidence coverage
and path correctness — declining to print precision for any category the dataset
does not enumerate completely.

No database, no subprocess, no network. See [benchmark.md](benchmark.md).

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

`modules/filesystem` is the one exception to "the API owns no I/O", and it is a
deliberate one. Choosing a local folder is filesystem work that has to happen
*somewhere*, and the two alternatives are worse: the browser cannot be trusted
with a recursive walk of someone's disk, and a fourth process would be a second
architecture for three routes. So the API process — which is the local runtime
in a local-first tool — opens the OS dialog and lists directories, behind three
constraints:

- **No route reads a file.** Listings are directories only; the scan counts.
- **No request input reaches a command line.** The dialog runs through
  `execFile` with a constant argument list and no shell.
- **One switch turns it all off.** `LOCAL_FILESYSTEM_ENABLED=false` is what you
  set when the API stops being the user's own machine.

`modules/source` is the second, and narrower, exception. A code explorer that
can show you a symbol's callers but not the symbol has stopped halfway, so the
API reads source — but only ever *inside a repository the user registered for
this project*, addressed by a repository-relative path, and read-only:

- **The root comes from the project, never from the request.** A caller names a
  path within a repository; which disk that is, the repository record decides.
- **The resolved path is checked against that root twice** — after normalising,
  which catches `..` and absolute paths, and again after resolving symlinks,
  because a link inside the tree is an ordinary way out of it.
- **Nothing about the host's layout crosses the wire.** Responses carry the
  repository-relative path. The browser never learns where the repository sits.
- **The same switch turns it off.** Reading the user's working tree is local
  filesystem access, and there is one place to decline it.

### `apps/worker`

`AnalyzeRepositoryJob` is the pipeline; `AnalysisProcessor` is the loop that
feeds it; `AnalysisJobQueue` is the seam between them. The MVP claims jobs from
PostgreSQL with `FOR UPDATE SKIP LOCKED`, which is already safe for several
worker processes. Introducing BullMQ means writing one more implementation of
`AnalysisJobQueue` — the job and the processor do not change.

Progress is a fourth seam. The pipeline reports where it is to an
`AnalysisProgressReporter`, which coalesces those reports and writes them to the
job row; the UI polls the row. The pipeline knows only that it reports progress
somewhere — moving to server-sent events later replaces that one class. Two
rules hold it honest: a phase that cannot count its work publishes `total: 0`
rather than a denominator nobody has, and a failed progress write is logged and
dropped rather than failing a run.

Resilience is the other thing the pipeline owes a real repository. A file that
cannot be read or parsed is recorded as an `IndexingError` and skipped; an
analyzer that throws is recorded and skipped. Both are warnings on a completed
run, not failures of it — a graph of the hundred and eight files that worked is
worth having, and refusing to produce one because of two that did not would be
the wrong trade every time.

Every dependency is injected, so `apps/worker/tests` runs the whole pipeline
with a fake command runner and in-memory stores.

### `apps/web`

React, Vite, Graphology and Sigma.js. The UI holds no graph of its own and
derives no facts it could have asked for: view state (mode, root, depth,
filters) is pushed to the API on every change, and the inspector shows what the
API returns.

There are two features, and the line between them matters. `features/codebase`
is intake — choosing a folder, sizing it up, watching it index, reporting what
the run measured. `features/code-graph` is the graph. Intake knows nothing about
how a graph is drawn; the graph feature knows nothing about where its graph came
from. The only thing that passes between them is a project id.

Within intake, `selectProjectDirectory()` is the whole of what a component knows
about choosing a folder. It resolves every way the attempt can end into three
outcomes — `selected`, `cancelled`, `unavailable` — so no component learns that
a dialog was involved, which platform it belonged to, or that there is a
fallback browser at all.

Inside the graph feature there are two more seams:

**`normalizeGraph`** turns the API's `CodeGraph` into the renderer's own model —
modules, degree, centrality, importance, entry-point status — so the
visualisation can be rebuilt or replaced without touching anything that knows
what SCIP is. It is a pure function and it is where every derived quantity is
defined exactly once.

**`GraphEngine`** owns Graphology, Sigma, the layout and the render state, and
owns them *outside* React. Hovering a node in a graph of ten thousand mutates a
field on that object and asks for one more frame; it does not re-render a
component tree. React keeps the toolbar, filters, search and inspector — the
things it is good at — and never learns where a node is. Nodes and edges are
drawn by a custom WebGL program: one draw call for every silhouette, one for
every halo, no DOM and no SVG.

Filters come in two kinds, deliberately. Node types and relationships are
applied *server side* during traversal — the point of those is to fetch less,
not to hide what was already fetched. Modules, external dependencies, exported
symbols and entry points are properties of the slice that came back, so they are
applied in the browser.

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
1 or 2, merged client-side by id — rather than by fetching more. The same rule
holds for everything added since: the repository tree is fetched one directory
level at a time, source is fetched one bounded window at a time and only when
someone asks to read it, and a path search is bounded twice — by hops and by a
node budget — because a hub node reaches most of a real graph in three hops.

**One traversal, one answer.** Walking the repository graph is the server's job
and happens in exactly one place per question: the recursive CTE for
neighbourhoods, the level-by-level breadth-first search for paths. The client's
own walks (`utils/graph-traversal`) answer only questions about the slice on
screen — what dims when I hover this, what is within two hops of my selection.
Find Path is *not* one of those: a route from a controller to a table runs
through nodes the current projection is very likely not drawing, so asking the
canvas would reliably answer "no route" about a route that plainly exists.

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
| MCP server | *Done* — `apps/mcp` | Beside `apps/api`, over stdio. Reads the same HTTP contract the UI does; no domain code, no database access. See [mcp.md](mcp.md) |
| Incremental indexing | `ScipGraphBuilder` + `GraphRepository` | Stable ids already make diffing possible |
| Neo4j | `GraphRepository` | Swap the implementation; the interface is already traversal-shaped |

Stable, content-derived node identity is the load-bearing decision here. It is
what lets an embedding, a cached summary or a diff refer to a piece of code and
still mean the same piece of code after the next analysis.
