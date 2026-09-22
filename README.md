# Repository Knowledge Graph

Turns a repository into a queryable graph of everything in it — its code, and
the documentation, configuration, contracts and schema around the code.

SCIP is the deterministic source of truth for code-level relationships. Markdown,
JSON, YAML, OpenAPI and SQL analyzers add the rest, every relationship carries
the evidence it was derived from, and a benchmark measures how much of it is
right.

## Run it

```bash
cp .env.example .env  # first time only — DATABASE_URL has no default
pnpm install          # first time only
docker compose up -d  # PostgreSQL
pnpm db:migrate       # create or update the schema
pnpm dev              # API, worker and web, in watch mode
```

Then open **<http://localhost:5173>** and click **Select project**.

After the first run, `pnpm dev` on its own is enough — as long as Docker is
still up. Ports come from `.env`; the web dev server reads the API's `PORT` from
there and proxies to it, so you only ever open 5173.

<details>
<summary>Other commands</summary>

```bash
pnpm dev:api      # just the API        → /docs for the OpenAPI UI
pnpm dev:worker   # just the worker
pnpm dev:web      # just the web app
pnpm dev:mcp      # just the MCP server (an MCP client normally launches it)
pnpm test         # the whole suite
pnpm typecheck    # type-check everything
pnpm build        # type-check, emit packages, build the web app
pnpm db:status    # applied / pending migrations
docker compose down          # stop PostgreSQL, keep the data
docker compose down -v       # stop it and throw the data away
```

</details>

---

A repository is indexed with [SCIP](https://github.com/sourcegraph/scip) for its
compiler-level facts, read again by source analyzers for the facts no compiler
has an opinion about, and normalised into one language-neutral **code knowledge
graph**:

- **code** — classes, interfaces, functions, methods, files, and the `CALLS`,
  `REFERENCES`, `IMPLEMENTS`, `EXTENDS`, `IMPORTS`, `EXPORTS`, `INSTANTIATES`,
  `ACCEPTS`, `RETURNS`, `CONTAINS` relationships between them
- **architecture** — API routes, the service itself, databases, tables, queues,
  events, external services and configuration, joined by `ROUTES_TO`, `USES`,
  `READS_FROM`, `WRITES_TO`, `PUBLISHES`, `SUBSCRIBES`, `CONFIGURED_BY`,
  `AUTHENTICATED_BY`, `VALIDATES`, `DEPENDS_ON`, `DEPENDS_ON_SERVICE`

It is stored in PostgreSQL and served through a traversal-first HTTP API that a
React UI renders in WebGL with Sigma.js and Graphology.

Every edge records **what observed it and how much that observer trusts it**. An
analyzer that cannot resolve a reference emits nothing rather than a guess: a
graph you have to second-guess is worse than a smaller one you can trust.

The graph is the product. SCIP is one way to populate it, PostgreSQL is one way
to store it, and the API is one way to read it — each is replaceable without
touching the others. That separation is what let the architectural layer be
added as seven analyzers behind one interface, and what will let a CodeRAG/MCP
layer be added later without restructuring anything.

> **Status: foundation.** The pipeline works end to end for TypeScript and
> JavaScript. Other languages, vector search, RAG and MCP are deliberately not
> implemented — see [Scope](#scope).

---

## What it does

```
Local folder  (native picker)   apps/api/src/modules/filesystem
        │
        ▼
Git / local repository
        │
        ▼
 Repository analyzer        apps/worker
        │
        ▼
 Project scanner            packages/language-detection
 Language detection         ──▶  code · document · configuration ·
 File classification             schema · database · generated · …
        │
        ▼
 SCIP indexer               packages/scip  ──▶  index.scip
        │
        ▼
 SCIP parser                packages/scip/src/parser
        │
        ▼
 Graph builder              packages/graph      ──▶  symbols, calls, references
        │
        ▼
 Source analyzers           packages/analysis   ──▶  APIs, tables, columns,
        │                                            containers, config, queues,
        │                                            events, integrations
        ▼
 Classification analyzers   packages/analysis   ──▶  API specifications,
        │                                            documents, class roles,
        │                                            cross-source relationships
        ▼
 Graph assembler            packages/graph      ──▶  one graph, merged by
        │                                            identity, every edge evidenced
        ▼
 Repository knowledge graph
        │
        ├──▶ PostgreSQL             packages/database
        │         │
        │         ▼
        │    Graph API              apps/api
        │         │
        │         ▼
        │    React web UI           apps/web
        │
        └──▶ Benchmark              packages/benchmark  ──▶  precision, recall,
                                                             evidence, paths
```

Read [docs/architecture.md](docs/architecture.md) for what each stage owns and
why the boundaries fall where they do, and
[docs/repository-knowledge.md](docs/repository-knowledge.md) for the layer that
reads the non-code half.

---

## Quick start

Requirements: Node 20.11+, pnpm 9+, Docker (for PostgreSQL). The commands are at
the [top of this file](#run-it); what follows is what to do once it is running.

**The dashboard** (`#/`) leads with **Select project**, and lists every project
already indexed with the size and composition of its graph, its source
repository and the state of its last run.

1. **Select a project** — the button opens your operating system's own folder
   dialog, driven by the API process, which is the only part of the system that
   touches the filesystem. Nothing recursive happens in the browser, and no path
   has to be typed. On a host with no dialog to show — a container, a remote
   machine — the same button opens an in-app directory browser served by
   `GET /api/filesystem/directories`, which lists directories and never files.

   The folder is then scanned before anything else happens, so the card shows
   how many files and which languages are in it. Picking the wrong folder costs
   a second, not a full run.

2. **Index project** — the API queues a job and returns immediately; the worker
   scans, runs SCIP, the analyzers and the assembler, then writes the graph to
   PostgreSQL. The page follows the job through
   `scanning → indexing → parsing → resolving → building_graph → persisting`,
   with real counts: files parsed out of files found, symbols and relationships
   as they accumulate. A phase that cannot count its work — a filesystem walk,
   an external indexer — says so rather than inventing a percentage.

   A file that cannot be read or parsed does not end the run. It is recorded
   against the job, and the finished project reports *Indexed with warnings*
   alongside the files it could not read.

   To index a path relative to the repository root, or a git URL, use
   **Index a path or a git URL instead** under the button — that is where the
   bundled samples live (`test-repositories/typescript-sample`, and
   `test-repositories/express-postgres-sample` for the architectural layer).
   A card's **Delete** removes the project and its graph after a confirmation
   on the card itself. It never touches the analysed source on disk.
3. **The project page** (`#/projects/<id>`) is a real URL — reload it, bookmark
   it, send it to a colleague. It shows the run's progress while it runs, then
   what the run measured — files, directories, classes, functions, interfaces,
   relationships and the language breakdown, every figure counted by the
   pipeline and none derived — and then the graph.
4. The canvas opens on the **Architecture** mode. For the Express sample that is
   exactly its shape:

   ```
   POST /users ──ROUTES_TO──▶ UserController ──CALLS──▶ UserService ──CALLS──▶ UserRepository ──WRITES_TO──▶ users
                                                             │
                                                        CALLS│──▶ SendGrid · Stripe
                                                    PUBLISHES│──▶ welcome-emails · user.created
   ```

   The other modes — Universe, Call graph, Files, Dependencies, Data flow — are
   the same graph under different filters, defined once as *projections* and
   shared by the API and the UI. Each mode also sets how the view is drawn: how
   firmly modules are separated, how many labels the view can afford, and which
   node types stay in scope when you zoom out.

   Nodes are laid out as a galaxy: clustered by source directory, placed by a
   force simulation, and sized and lit by importance — degree, centrality, node
   type, entry-point and exported status. Zoom is *semantic*: far out you see
   architecture, close in you see symbols. The Filters panel exposes every node
   type and relationship, grouped with the project's own counts, plus the
   module, external-dependency and entry-point filters that apply to the view
   you are looking at.
5. **Hover a node** for a tooltip — what it is, where it lives, how connected it
   is — while the rest of the graph dims. **Click** it for the full inspector:
   type, role, file, line range, members, callers, callees, references, APIs,
   data stores and dependencies, with the evidence for each. **Double-click**
   (or **Expand**) pulls that node's neighbours onto the canvas without
   disturbing what is already there; **Focus** isolates it and its
   neighbourhood at depth 1, 2 or 3; **Re-root here** starts a fresh server-side
   traversal from it; **Open source** opens the exact line in your editor.
6. **Find path** answers "how does a request get from here to there" by walking
   the graph on screen and lighting the route, with everything else dimmed.

To check the analysis half of the system without the browser:

```bash
pnpm analyze:sample                                         # the small sample
pnpm analyze:sample test-repositories/express-postgres-sample
```

It creates a project, attaches the repository, runs the full pipeline and prints
the node composition and the architecture projection.

---

## Setup in detail

### Install the SCIP indexers

`@sourcegraph/scip-typescript` is a workspace dev dependency, so `pnpm install`
is all that is normally needed. Verify it:

```bash
pnpm setup:scip
# ok  typescript  .../node_modules/.bin/scip-typescript (0.4.0)
```

If you would rather use a globally installed or differently located binary, set
`SCIP_TYPESCRIPT_COMMAND` to its name or absolute path. The worker resolves a
bare command by walking up `node_modules/.bin` before falling back to `PATH`.

Adding another language means adding an indexer — see [docs/scip.md](docs/scip.md).

### Run PostgreSQL

```bash
docker compose up -d          # postgres:17-alpine, database code_knowledge_graph
pnpm db:migrate               # apply migrations
pnpm db:status                # show applied / pending
```

Migrations are forward-only `.sql` files in `packages/database/migrations`,
recorded with a checksum so an edited migration is reported rather than
silently diverging.

To start over: `docker compose down -v && docker compose up -d && pnpm db:migrate`.

Already running PostgreSQL elsewhere? Point `DATABASE_URL` at it and skip
Compose; nothing else in the stack cares.

### Run the services

```bash
pnpm dev          # all three, in parallel
pnpm dev:api      # API only          → http://localhost:3000  (docs at /docs)
pnpm dev:worker   # worker only
pnpm dev:web      # web only          → http://localhost:5173
```

`pnpm dev` builds the workspace packages first, then starts the three apps in
watch mode. The web dev server proxies `/api`, `/health` and `/docs` to the API,
so the browser never needs to know about ports or CORS — and it reads `PORT`
from `.env`, so moving the API off a busy port needs no other change.

Both defaults are commonly taken on a developer machine. If `3000` or `5432` is
already in use, set `PORT` and `POSTGRES_PORT` in `.env` (keeping `DATABASE_URL`
in step) and everything follows.

The worker is a separate process on purpose: indexing a large repository takes
minutes, and no HTTP request should wait on it.

---

## Configuration

Copy `.env.example` to `.env`. Every variable is validated at startup with Zod
(`packages/shared/src/schemas/env.schema.ts`); a missing or malformed one fails
the process immediately with the variable's name — never its value. Nothing in
the codebase reads `process.env` outside `apps/*/src/config`.

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | all | Runtime mode |
| `LOG_LEVEL` | `info` | all | `trace`…`fatal` |
| `PORT` | `3000` | api | HTTP port |
| `HOST` | `0.0.0.0` | api | Bind address |
| `CORS_ORIGIN` | `http://localhost:5173` | api | Comma-separated allowed origins |
| `LOCAL_FILESYSTEM_ENABLED` | `true` | api | Whether the API may list local directories and open the host's folder dialog. Set `false` when the API is not on the user's own machine |
| `DIRECTORY_PICKER_TIMEOUT_MS` | `300000` | api | Ceiling on one unanswered folder dialog |
| `POSTGRES_PORT` | `5432` | compose | Host port the Compose database publishes on |
| `DATABASE_URL` | — | api, worker | **Required.** PostgreSQL connection string |
| `DATABASE_POOL_MAX` | `10` | api, worker | Pool size |
| `SCIP_TYPESCRIPT_COMMAND` | `scip-typescript` | worker | Indexer command or path |
| `SCIP_INDEX_TIMEOUT_MS` | `600000` | worker | Hard ceiling on one indexer run |
| `ANALYSIS_WORKSPACE_DIR` | `./.workspace` | worker | Per-analysis scratch space |
| `WORKER_POLL_INTERVAL_MS` | `1000` | worker | Queue poll interval |
| `WORKER_CONCURRENCY` | `1` | worker | Reserved for the queue backend |
| `WORKER_RUN_ONCE` | `false` | worker | Drain the queue, then exit |

---

## Repository layout

```
apps/
  api/        Fastify + Zod + OpenAPI. Routes validate and delegate; no business
              logic, no SQL, no SCIP. Owns the one filesystem boundary the
              browser can reach: the folder dialog, directory listings and the
              pre-index scan.
  worker/     The analysis pipeline. Claims jobs, runs SCIP, persists graphs.
  web/        React + Vite + Sigma.js/Graphology (WebGL). Loads everything
              from the API and owns none of the graph.
  mcp/        MCP server over stdio. An adapter and nothing else: it holds no
              domain logic and no database credentials, and reaches the graph
              through the same HTTP API the web client uses.

packages/
  scip/                SCIP indexer adapters, protobuf parser, internal types.
                       Raw protobuf never leaves this package.
  graph/               Graph domain model, deterministic builder, the analyzer
                       seam and the merge, traversal, serialisation.
                       Language-agnostic by construction.
  analysis/            Analyzers and parsers: files, imports, structure, APIs,
                       SQL schemas, databases, configuration, external services,
                       messaging, frameworks, OpenAPI, documents. The only place
                       that reads syntax, and the only place a Markdown, JSON,
                       YAML or SQL parser exists.
  language-detection/  Project scanner (one walk, extensible ignore policy),
                       per-language detectors and file classification.
  database/            Pool, migrations, repositories. The only place with SQL.
  benchmark/           Precision, recall, evidence and path correctness against
                       a hand-written ground truth. Runs the real pipeline.
  retrieval-eval/      Whether the *public API* can retrieve the evidence real
                       code questions need. An HTTP client, no internals.
  shared/              Types, Zod schemas and constants everything else speaks,
                       including the confidence policy.

test-repositories/
  typescript-sample/           Layered fixture app: controller → service →
                               repository → model.
  express-postgres-sample/     Express + PostgreSQL service: routes, SQL, a
                               queue, an event bus, two integrations.
  repository-knowledge-sample/ The above plus Markdown, JSON, YAML, an OpenAPI
                               contract and two migrations — the benchmark's
                               fixture, with known cross-source relationships.
scripts/                       setup-scip.ts, dev-analysis.ts, build-fixtures.ts
docker/postgres/                       Compose init scripts
docs/                                  Architecture, graph model, repository
                                       knowledge, benchmark, SCIP, API
```

---

## Development

```bash
pnpm build          # type-check and emit every package, then build the web app
pnpm typecheck      # type-check only
pnpm test           # the whole suite (Vitest)
pnpm test:watch
pnpm benchmark      # score the pipeline against the golden fixture
pnpm evaluate:retrieval   # score the retrieval API against real questions
                          # (needs `pnpm dev:api` and the fixtures indexed)
```

TypeScript is strict everywhere, ESM throughout, with project references so
`tsc -b` builds in dependency order.

### Tests

777 tests, no database or network required — plus 51 more that run when one is
(see below). `packages/scip/tests/fixtures/` holds real `index.scip` files
produced by scip-typescript from the sample repositories, so the parser,
builder, analyzers and benchmark are checked against genuine indexer output
rather than a fixture that only agrees with itself. Regenerate them with
`pnpm fixtures:build`; the indexer is deterministic, so a dirty `git status`
afterwards means a sample actually changed.

| Suite | Covers |
| --- | --- |
| `packages/shared` | Env validation, query schemas, logging contract, the graph vocabulary's completeness |
| `packages/language-detection` | TypeScript/JavaScript/mixed repositories; the project scanner against real directory trees — nesting, ignored directories, lock files, unsupported types, empty projects, determinism |
| `packages/scip` | Protobuf wire format, symbol grammar, parsing, indexer adapter |
| `packages/graph` | Builder (symbols→nodes, references→edges), the assembler's merge rules, symbol index, determinism, traversal |
| `packages/analysis` | Module resolution, bindings, SQL/Prisma/vendor detection, the Markdown/JSON/YAML/SQL/OpenAPI parsers, every analyzer end to end against the Express and mixed-format samples, and what happens when one file cannot be read or parsed |
| `packages/benchmark` | The metric arithmetic, the evaluator against synthetic graphs where the answer is obvious, ground-truth validation, and the real pipeline against the golden fixture |
| `packages/retrieval-eval` | The matchers at their edges — the right relationship between the wrong nodes, the right nodes in the wrong order — aggregation, project isolation, and the dataset's own invariants |
| `packages/database` | Migration contract, row mapping, and the graph SQL against a real PostgreSQL |
| `apps/api` | Envelope, every route, projections, direction, search paging, node detail, error codes, OpenAPI, and the local-folder intake boundary |
| `apps/worker` | The pipeline end to end against both fixtures, including phase-by-phase progress, the statistics it records, and a run surviving a broken analyzer |
| `apps/mcp` | Tool metadata, all seven tools against a stub API, every index state, project isolation and result bounding, path and no-path semantics, evidence preservation, literal-query forwarding, result versus scan truncation, source-window validation, config resolution, and one real process handshaking over stdio |
| `apps/web` | Graph merging for expand-on-click, projections, the visual language's completeness, and the folder-picker abstraction's three outcomes |

The `packages/database` integration suite skips itself when no database is
reachable and runs when one is:

```bash
docker compose up -d postgres
pnpm test                       # the integration suite now executes too
```

It exists because a fake cannot reproduce SQL: one bug it caught — a count
query reusing a predicate whose parameters it did not pass — passed every
in-memory test and failed on the first live request.

---

## Scope

Implemented: the TypeScript/JavaScript pipeline, the graph model and builder,
PostgreSQL persistence, the traversal API, and the React UI.

Implemented since: the architectural layer — API, service, database, table,
queue, event and external-service nodes, produced by source analyzers behind the
`CodeAnalyzer` seam — graph projections, and evidence on every edge.

Implemented since that: the repository layer. File classification, Markdown,
JSON, YAML, OpenAPI and SQL parsers, document / section / config / config
property / API spec / endpoint / column / container nodes, four cross-source
relationships joining a contract to its handler and prose to its subject, a
central confidence policy, evidence carrying a file and a line, and a benchmark
that scores all of it against a hand-written ground truth.

Implemented since that: path resolution — `GET /api/projects/resolve` turns a
directory into the projects indexed from it — and an **MCP server**
(`apps/mcp`) over stdio, exposing seven tools: `resolve_project` turns a working
directory into a project id, `get_index_status` says whether that project is
ready, indexing, failed or never indexed, `search_graph` searches that one
project, `get_node` inspects one node with its relationships and the evidence
behind them, `trace_path` finds the shortest route between two of them,
`search_code` searches the source text itself, and `get_source` reads the code
at any location the others report. The same project id is passed through every
call; there is no implicit project.

Not implemented, and intentionally so: Qdrant, embeddings, LLM/Claude
integration, the rest of the MCP tool surface, OAuth, authentication,
multi-tenancy, Neo4j, distributed workers, AI summaries, incremental indexing
and production deployment. The architecture is arranged so each can be added
without restructuring — see the last section of
[docs/architecture.md](docs/architecture.md).

The graph is shaped so that a future context engine can ask it: search entities,
get source, find references, find callers and callees, find dependencies, find a
path, trace an API to its storage, trace data flow, find documentation, find
configuration, and retrieve the evidence behind any of those. All of those are
queries against what is there today.

## Documentation

- [docs/architecture.md](docs/architecture.md) — layers, boundaries, rules
- [docs/graph-model.md](docs/graph-model.md) — nodes, edges, evidence, confidence, identity
- [docs/repository-knowledge.md](docs/repository-knowledge.md) — file categories, parsers, cross-source relationships, what the pipeline refuses to do
- [docs/benchmark.md](docs/benchmark.md) — ground truth, metrics, CI
- [docs/retrieval-evaluation.md](docs/retrieval-evaluation.md) — retrieval cases, pass/partial/fail, and what retrieval cannot answer yet
- [docs/retrieval-evaluation-report.md](docs/retrieval-evaluation-report.md) — baseline results (45/49), the one gap the four failures shared, and the post-fix re-measurement (49/49)
- [docs/scip.md](docs/scip.md) — indexers, parsing, adding a language
- [docs/api.md](docs/api.md) — endpoints, envelope, error codes (including code search)
- [docs/mcp.md](docs/mcp.md) — the MCP server, its one tool, and why it holds no logic
