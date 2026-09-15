# Code Knowledge Graph

Turns a source repository into a queryable graph of its own code.

A repository is indexed with [SCIP](https://github.com/sourcegraph/scip), the
index is normalised into a language-neutral **code knowledge graph** (classes,
interfaces, functions, methods, files — and the `CALLS`, `REFERENCES`,
`IMPLEMENTS`, `EXTENDS`, `IMPORTS`, `CONTAINS` relationships between them),
stored in PostgreSQL, and served through a traversal-first HTTP API that a React
UI renders with Cytoscape.

The graph is the product. SCIP is one way to populate it, PostgreSQL is one way
to store it, and the API is one way to read it — each is replaceable without
touching the others. That separation is what will let a CodeRAG/MCP layer be
added later without restructuring anything.

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
 Graph builder              packages/graph
        │
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
pnpm db:migrate              # create the schema
pnpm dev                     # API :3000, worker, web :5173
```

Then open <http://localhost:5173>.

**The dashboard** (`#/`) lists every project with the size and composition of
its graph, its source repository and the state of its last run, and is where
projects are created and analyses started.

1. **Create and analyse** — the form is pre-filled with the bundled sample at
   `test-repositories/typescript-sample`. The API queues a job and returns
   immediately; the worker runs SCIP, builds the graph and writes it to
   PostgreSQL. The card follows the job through `QUEUED → INDEXING → PARSING →
   BUILDING_GRAPH → PERSISTING → COMPLETED` and refreshes when it lands.
2. **Explore graph** opens the project workspace (`#/projects/<id>`), which is a
   real URL — reload it, bookmark it, send it to a colleague.
3. The canvas opens on the **Architecture** view: types and the behaviour
   between them. For the sample repository that is exactly its shape:

   ```
   UserController ──CALLS──▶ UserService ──CALLS──▶ UserRepository ──REFERENCES──▶ User
   ```

   The other presets — Everything, Call graph, Files — are the same filters
   under different names, and the Filters panel exposes all of them.
4. **Click a node** for its file, line range, callers, callees and references.
   **Double-click** to re-root the traversal on it.

To check the analysis half of the system without the browser:

```bash
pnpm analyze:sample
```

It creates a project, attaches the sample repository, runs the full pipeline and
prints the resulting overview edges.

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
  graph/               Graph domain model, deterministic builder, traversal,
                       serialisation. Language-agnostic by construction.
  language-detection/  Repository scan and per-language detectors.
  database/            Pool, migrations, repositories. The only place with SQL.
  shared/              Types, Zod schemas and constants everything else speaks.

test-repositories/typescript-sample/   Layered fixture app used end to end.
scripts/                               setup-scip.ts, dev-analysis.ts
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

157 tests, no database or network required. `packages/scip/tests/fixtures/`
holds a real `index.scip` produced by scip-typescript from the sample
repository, so the parser and builder are checked against genuine indexer
output rather than a fixture that only agrees with itself.

| Suite | Covers |
| --- | --- |
| `packages/shared` | Env validation, query schemas, logging contract |
| `packages/language-detection` | TypeScript/JavaScript/mixed repositories |
| `packages/scip` | Protobuf wire format, symbol grammar, parsing, indexer adapter |
| `packages/graph` | Builder (symbols→nodes, references→edges), determinism, traversal |
| `packages/database` | Migration contract, row mapping |
| `apps/api` | Envelope, every route, error codes, OpenAPI |
| `apps/worker` | The pipeline end to end against the fixture |

---

## Scope

Implemented: the TypeScript/JavaScript pipeline, the graph model and builder,
PostgreSQL persistence, the traversal API, and the React UI.

Not implemented, and intentionally so: Qdrant, embeddings, LLM/Claude
integration, MCP, OAuth, authentication, multi-tenancy, Neo4j, distributed
workers, AI summaries, AST framework analyzers, incremental indexing and
production deployment. The architecture is arranged so each can be added
without restructuring — see the last section of
[docs/architecture.md](docs/architecture.md).

## Documentation

- [docs/architecture.md](docs/architecture.md) — layers, boundaries, rules
- [docs/graph-model.md](docs/graph-model.md) — nodes, edges, identity
- [docs/scip.md](docs/scip.md) — indexers, parsing, adding a language
- [docs/api.md](docs/api.md) — endpoints, envelope, error codes
