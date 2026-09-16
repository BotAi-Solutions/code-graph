# Code Knowledge Graph

Turns a source repository into a queryable graph of its own code.

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
React UI renders with Cytoscape.

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
Git / local repository
        │
        ▼
 Repository analyzer        apps/worker
        │
        ▼
 Language detection         packages/language-detection
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
 Source analyzers           packages/analysis   ──▶  APIs, tables, queues,
        │                                            events, integrations
        ▼
 Graph assembler            packages/graph      ──▶  one graph, merged by
        │                                            identity, every edge evidenced
        ▼
 Code knowledge graph
        │
        ▼
 PostgreSQL                 packages/database
        │
        ▼
 Graph API                  apps/api
        │
        ▼
 React web UI               apps/web
```

Read [docs/architecture.md](docs/architecture.md) for what each stage owns and
why the boundaries fall where they do.

---

## Quick start

Requirements: Node 20.11+, pnpm 9+, Docker (for PostgreSQL).

```bash
pnpm install                 # installs workspace deps, including the SCIP indexer
docker compose up -d         # PostgreSQL on localhost:5432
pnpm db:migrate              # create or update the schema
pnpm dev                     # API :3000, worker, web :5173
```

Then open <http://localhost:5173>.

**The dashboard** (`#/`) lists every project with the size and composition of
its graph, its source repository and the state of its last run, and is where
projects are created and analyses started.

1. **Create and analyse** — the form is pre-filled with the bundled sample at
   `test-repositories/typescript-sample`; for the architectural layer, point it
   at `test-repositories/express-postgres-sample`. The API queues a job and
   returns immediately; the worker runs SCIP, the analyzers and the assembler,
   then writes the graph to PostgreSQL. The card follows the job through
   `QUEUED → INDEXING → PARSING → BUILDING_GRAPH → PERSISTING → COMPLETED` and
   refreshes when it lands.
2. **Explore graph** opens the project workspace (`#/projects/<id>`), which is a
   real URL — reload it, bookmark it, send it to a colleague.
3. The canvas opens on the **Architecture** projection. For the Express sample
   that is exactly its shape:

   ```
   POST /users ──ROUTES_TO──▶ UserController ──CALLS──▶ UserService ──CALLS──▶ UserRepository ──WRITES_TO──▶ users
                                                             │
                                                        CALLS│──▶ SendGrid · Stripe
                                                    PUBLISHES│──▶ welcome-emails · user.created
   ```

   The other projections — Everything, Call graph, Files, Dependencies, Data
   flow — are the same graph under different filters, defined once and shared by
   the API and the UI. The Filters panel exposes every node type and
   relationship, grouped, with the project's own counts beside them.
4. **Click a node** for its type, role, file, line range, callers, callees,
   references, APIs, data stores and dependencies — with the evidence for each.
   **Double-click** (or **Expand**) pulls that node's neighbours onto the canvas
   without disturbing what is already there; **Focus** starts a fresh traversal
   from it; **Open source** opens the exact line in your editor.

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
              logic, no SQL, no SCIP.
  worker/     The analysis pipeline. Claims jobs, runs SCIP, persists graphs.
  web/        React + Vite + Cytoscape. Loads everything from the API.

packages/
  scip/                SCIP indexer adapters, protobuf parser, internal types.
                       Raw protobuf never leaves this package.
  graph/               Graph domain model, deterministic builder, the analyzer
                       seam and the merge, traversal, serialisation.
                       Language-agnostic by construction.
  analysis/            Source analyzers: files, imports, structure, APIs,
                       databases, external services, messaging, frameworks.
                       The only place that reads syntax.
  language-detection/  Repository scan and per-language detectors.
  database/            Pool, migrations, repositories. The only place with SQL.
  shared/              Types, Zod schemas and constants everything else speaks.

test-repositories/
  typescript-sample/           Layered fixture app: controller → service →
                               repository → model.
  express-postgres-sample/     Express + PostgreSQL service: routes, SQL, a
                               queue, an event bus, two integrations.
scripts/                       setup-scip.ts, dev-analysis.ts, build-fixtures.ts
docker/postgres/                       Compose init scripts
docs/                                  Architecture, SCIP, graph model, API
```

---

## Development

```bash
pnpm build          # type-check and emit every package, then build the web app
pnpm typecheck      # type-check only
pnpm test           # the whole suite (Vitest)
pnpm test:watch
```

TypeScript is strict everywhere, ESM throughout, with project references so
`tsc -b` builds in dependency order.

### Tests

345 tests, no database or network required — plus 27 more that run when one is
(see below). `packages/scip/tests/fixtures/`
holds real `index.scip` files produced by scip-typescript from the sample
repositories, so the parser, builder and analyzers are checked against genuine
indexer output rather than a fixture that only agrees with itself. Regenerate
them with `pnpm fixtures:build`; the indexer is deterministic, so a dirty
`git status` afterwards means a sample actually changed.

| Suite | Covers |
| --- | --- |
| `packages/shared` | Env validation, query schemas, logging contract, the graph vocabulary's completeness |
| `packages/language-detection` | TypeScript/JavaScript/mixed repositories |
| `packages/scip` | Protobuf wire format, symbol grammar, parsing, indexer adapter |
| `packages/graph` | Builder (symbols→nodes, references→edges), the assembler's merge rules, symbol index, determinism, traversal |
| `packages/analysis` | Module resolution, bindings, SQL/Prisma/vendor detection, and every analyzer end to end against the Express sample |
| `packages/database` | Migration contract, row mapping, and the graph SQL against a real PostgreSQL |
| `apps/api` | Envelope, every route, projections, direction, search paging, node detail, error codes, OpenAPI |
| `apps/worker` | The pipeline end to end against both fixtures |
| `apps/web` | Graph merging for expand-on-click, projections, the visual language's completeness |

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
queue, event, external-service and config nodes, produced by source analyzers
behind the `CodeAnalyzer` seam — graph projections, and evidence on every edge.

Not implemented, and intentionally so: Qdrant, embeddings, LLM/Claude
integration, MCP, OAuth, authentication, multi-tenancy, Neo4j, distributed
workers, AI summaries, incremental indexing and production deployment. The architecture is arranged so each can be added
without restructuring — see the last section of
[docs/architecture.md](docs/architecture.md).

## Documentation

- [docs/architecture.md](docs/architecture.md) — layers, boundaries, rules
- [docs/graph-model.md](docs/graph-model.md) — nodes, edges, identity
- [docs/scip.md](docs/scip.md) — indexers, parsing, adding a language
- [docs/api.md](docs/api.md) — endpoints, envelope, error codes
