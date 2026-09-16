# API

Base URL `http://localhost:3000`. Interactive OpenAPI at `/docs`, the raw
document at `/docs/json`.

## Response envelope

Every response — success or failure, every route — has the same shape.

**Success**

```json
{ "success": true, "data": { }, "error": null, "meta": { } }
```

**Failure**

```json
{
  "success": false,
  "data": null,
  "error": { "code": "PROJECT_NOT_FOUND", "message": "Project abc was not found" },
  "meta": { "requestId": "0f9c…" }
}
```

`error.code` is a stable identifier to branch on; `error.message` is for humans
and may change. Validation failures add `error.details`, one entry per field:

```json
"details": [{ "path": "name", "message": "Too small: expected string to have >=1 characters" }]
```

`meta` carries whatever is useful for the route — pagination totals, traversal
mode and depth, a request id on errors.

## Error codes

| Code | Status | When |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | A body, query or path parameter failed its schema |
| `BAD_REQUEST` | 400 | Malformed request Fastify rejected before routing |
| `UNSUPPORTED_LANGUAGE` | 400 | A language with no registered indexer was forced |
| `NOT_FOUND` | 404 | Unknown route |
| `PROJECT_NOT_FOUND` | 404 | No such project |
| `REPOSITORY_NOT_FOUND` | 404 | The project has no repository configured |
| `ANALYSIS_NOT_FOUND` | 404 | No such analysis *in this project* |
| `NODE_NOT_FOUND` | 404 | No such graph node in this project |
| `REPOSITORY_PATH_NOT_FOUND` | 404 | The worker could not read the repository path |
| `CONFLICT` | 409 | Generic state conflict |
| `ANALYSIS_ALREADY_RUNNING` | 409 | A non-terminal analysis already exists for the project |
| `REPOSITORY_NOT_CONFIGURED` | 409 | An operation needs a repository that is not attached |
| `LANGUAGE_DETECTION_FAILED` | 422 | No supported language found in the repository |
| `SCIP_INDEXER_NOT_FOUND` | 422 | No indexer registered for the detected language |
| `SCIP_INDEX_FAILED` | 422 | The indexer exited non-zero or timed out |
| `SCIP_PARSE_FAILED` | 422 | `index.scip` could not be decoded |
| `GRAPH_BUILD_FAILED` | 422 | The builder could not assemble a graph |
| `DATABASE_ERROR` | 500 | The database rejected an operation |
| `CONFIGURATION_ERROR` | 500 | Invalid configuration detected at runtime |
| `INTERNAL_ERROR` | 500 | Anything unexpected — details are logged, never returned |

The `SCIP_*`, `GRAPH_BUILD_FAILED` and `LANGUAGE_DETECTION_FAILED` cases happen
in the worker, so they surface as the `error` field of a `FAILED` analysis job
rather than as an HTTP status.

An analysis belonging to another project reads as `ANALYSIS_NOT_FOUND`, not
`403` — existence is not leaked.

---

## Health

### `GET /health`

`200` when the database answers, `503` with `status: "degraded"` when it does
not. Outside `/api` because that is where orchestrators look.

```json
{ "status": "ok", "uptimeSeconds": 42, "checks": { "database": "ok" } }
```

---

## Projects

### `POST /api/projects` → `201`

```json
{ "name": "my-service", "description": "optional" }
```

### `GET /api/projects` → `200`

The dashboard listing. Each row is a project **plus** its repository, its most
recent run and the size and composition of its graph — assembled in one SQL
statement with lateral joins, so a dashboard of fifty projects is one query and
not fifty-one.

```json
{
  "id": "…", "name": "typescript-sample", "description": null,
  "createdAt": "…", "updatedAt": "…",
  "repository": { "sourceType": "local", "sourcePath": "test-repositories/typescript-sample", "commitHash": null },
  "latestAnalysis": { "id": "…", "status": "COMPLETED", "language": "typescript",
                      "startedAt": "…", "completedAt": "…", "error": null },
  "nodeCount": 79, "edgeCount": 247,
  "nodeTypeCounts": { "class": 6, "interface": 4, "method": 31, "file": 6, "service": 1, "…": 0 }
}
```

`repository` and `latestAnalysis` are `null` for a project that has neither;
such a project is still listed, with zero counts. Query: `limit` (1–100, default
50), `offset` (default 0). Newest first. `meta` carries
`{ total, limit, offset }`.

### `GET /api/projects/:projectId` → `200`

---

## Repositories

A project has **at most one** source repository; posting again replaces it.

### `POST /api/projects/:projectId/repository` → `201`

```json
{ "sourceType": "local", "sourcePath": "test-repositories/typescript-sample" }
```

`sourceType` is `local` or `git`. For `local`, the path is resolved by the
**worker** process, which may not share a filesystem with the API — so it is
stored as given and validated when the analysis runs. A relative path resolves
against the monorepo root (not the worker's working directory), so
`test-repositories/typescript-sample` means the same thing however the worker
was started. For `git`, `sourcePath` is
a clone URL and an optional `commitHash` is checked out after a shallow clone.

### `GET /api/projects/:projectId/repository` → `200`

---

## Analysis

### `POST /api/projects/:projectId/analysis` → `202`

```json
{ "language": "typescript" }
```

`language` is optional and forces a specific indexer; omit it to detect.

Returns a `QUEUED` job immediately — indexing a repository takes minutes and no
HTTP request waits on it. Poll the job.

`409 ANALYSIS_ALREADY_RUNNING` if a non-terminal analysis already exists for the
project. `404 REPOSITORY_NOT_FOUND` if none is attached.

### `GET /api/projects/:projectId/analysis/:analysisId` → `200`

```json
{
  "id": "…", "projectId": "…", "repositoryId": "…",
  "status": "COMPLETED",
  "language": "typescript",
  "startedAt": "2026-09-15T14:31:41.500Z",
  "completedAt": "2026-09-15T14:31:42.514Z",
  "error": null,
  "stats": { "documentCount": 6, "symbolCount": 63, "nodeCount": 79, "edgeCount": 247, "durationMs": 1002 }
}
```

States: `QUEUED → INDEXING → PARSING → BUILDING_GRAPH → PERSISTING → COMPLETED`,
or `FAILED` from any of them with `error` set.

### `GET /api/projects/:projectId/analysis` → `200`

Recent runs, newest first.

---

## Graph

### `GET /api/projects/:projectId/graph` → `200`

The main read. **It never returns the whole graph.**

| Parameter | Default | Notes |
| --- | --- | --- |
| `rootNodeId` | — | Omit for the overview |
| `depth` | `2` | 0–5 |
| `projection` | — | `everything`, `architecture`, `calls`, `files`, `dependencies`, `dataflow` |
| `nodeTypes` | projection's, else all | CSV or repeated; `class,method` |
| `relationships` | projection's, else all | CSV or repeated; `CALLS,ROUTES_TO` |
| `direction` | `both` | `both`, `outgoing`, `incoming` |
| `limit` | `500` | Max nodes, 1–2000 |

Two modes, reported in `meta.mode`:

- **`traversal`** — with `rootNodeId`, a walk outward to `depth` hops.
  `direction` decides which end of an edge the walk may arrive from; `both` is
  the default because a depth-1 walk from a service should find its callers as
  well as its callees. Filters apply *during* expansion: a filtered traversal
  never reaches through an excluded node. The root is always included.
- **`overview`** — without one, the project's most connected nodes and the
  behavioural edges between them. Containment is excluded from the ranking
  because a file CONTAINs everything in it and would win every degree contest
  while saying nothing about behaviour.

Nodes come back in the order they were selected — nearest-first for a traversal,
highest-ranked first for an overview — so reading the first few means reading
the most relevant few.

#### Projections

A projection is a named slice: a node-type filter, a relationship filter and a
ranking hint, defined once in `@ckg/shared` and read by both the API and the UI.
It is not a separate graph, a separate table or a separate code path.

| `projection` | Answers |
| --- | --- |
| `everything` | No filter at all |
| `architecture` | How is this system put together — APIs, services, data stores, queues, events, and the behaviour between them |
| `calls` | What calls what |
| `files` | The source tree and its file-level dependencies |
| `dependencies` | What this service depends on: libraries and other services |
| `dataflow` | Request to store: API → service → database, queue, event |

An explicit `nodeTypes` or `relationships` always wins over the projection's
default, and the two are independent — overriding the relationships keeps the
projection's node-type filter. `meta` reports what was actually applied.

```json
{
  "success": true,
  "data": { "nodes": [], "edges": [] },
  "error": null,
  "meta": {
    "mode": "traversal", "rootNodeId": "a1b2…", "depth": 2, "direction": "both",
    "projection": "architecture",
    "nodeTypes": ["api", "service", "…"], "relationships": ["ROUTES_TO", "…"],
    "limit": 500, "nodeCount": 11, "edgeCount": 25, "truncated": false
  }
}
```

`truncated: true` means `limit` cut the result short — raise it, narrow the
filters, or reduce the depth.

Edges are the induced subgraph: an edge appears only when both endpoints do.

#### Expand-on-click

There is no separate expansion endpoint: the UI's expand action is this route
with `rootNodeId` set to the clicked node and `depth=1`, merged client-side into
what is already displayed. One contract, one set of filter semantics.

### `GET /api/projects/:projectId/graph/summary` → `200`

```json
{
  "nodeCount": 114,
  "edgeCount": 407,
  "rootNodeId": "0293…",
  "nodeTypeCounts": { "class": 10, "method": 41, "api": 6, "table": 2, "service": 1 },
  "relationshipCounts": { "CALLS": 106, "ROUTES_TO": 10, "WRITES_TO": 4 }
}
```

`nodeCount: 0` means the project has not been analysed yet. `rootNodeId` is the
repository node, the natural starting point for a structural walk.
`relationshipCounts` is what lets a client dim a filter the project has no edges
for rather than offering a chip that can only return nothing.

### `GET /api/projects/:projectId/graph/search` → `200`

Query: `q` (required), `nodeTypes` (CSV or repeated), `limit` (1–100, default
20), `offset` (default 0).

Case-insensitive substring match on **name**, **qualified name** and **file
path**, which between them cover every way a person refers to a piece of code:

| Term | Finds |
| --- | --- |
| `UserService` | the class |
| `UserService.getUser` | the method |
| `user.service.ts` | the file |
| `src/services` | everything under the directory |
| `POST /users` | the API route |
| `table` | every node of that type |

Exact matches rank first, then prefix matches, then the rest, shortest names
first. `meta` carries `{ total, limit, offset }`; `total` is the full match
count, not the page, so a client can say "showing 15 of 42" rather than
silently truncating.

### `GET /api/projects/:projectId/graph/nodes/:nodeId` → `200`

Everything the node inspector needs, in one round trip — and one database
query, not one per section:

```json
{
  "node": { "id": "…", "type": "class", "name": "UserRepository",
            "qualifiedName": "UserRepository",
            "filePath": "src/repositories/user.repository.ts",
            "startLine": 8, "startCharacter": 13, "endLine": 55, "endCharacter": 1,
            "metadata": { "scipSymbol": "…", "role": "repository",
                          "roleEvidence": "it reads or writes a database table" } },
  "callers":      [ { "type": "class", "name": "UserService" } ],
  "callees":      [ ],
  "references":   [ { "type": "method", "name": "create" } ],
  "dependencies": [ ],
  "dependents":   [ ],
  "apis":         [ ],
  "databases":    [ { "type": "table", "name": "users", "relationship": "WRITES_TO",
                      "direction": "outgoing", "confidence": "high",
                      "evidenceSource": "database-analyzer" } ]
}
```

- **callers** — incoming `CALLS`
- **callees** — outgoing `CALLS`
- **references** — incoming `REFERENCES`, i.e. what uses this node without
  calling it
- **dependencies** / **dependents** — outgoing / incoming `DEPENDS_ON`,
  `DEPENDS_ON_SERVICE`, `IMPORTS`, `USES`
- **apis** — `api` nodes that `ROUTES_TO` this node
- **databases** — `database`, `table`, `queue` and `event` nodes this node
  `READS_FROM`, `WRITES_TO`, `PUBLISHES` or `SUBSCRIBES`

The first three keep the plain node shape they have always had. The sections
added since carry `relationship`, `direction` and the edge's evidence with each
entry, because "depends on" covers four different relationships and a client
should be able to say which. A section with nothing in it is `[]`, never absent.

Query: `limit` (default 100) caps each list.

### `GET /api/projects/:projectId/graph/nodes/:nodeId/callers` → `200`
### `GET /api/projects/:projectId/graph/nodes/:nodeId/callees` → `200`
### `GET /api/projects/:projectId/graph/nodes/:nodeId/references` → `200`

The same lists on their own routes, for clients that want one of them.

---

## Worked flow

```bash
BASE=http://localhost:3000

PID=$(curl -s -X POST $BASE/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"name":"sample"}' | jq -r .data.id)

curl -s -X POST $BASE/api/projects/$PID/repository \
  -H 'Content-Type: application/json' \
  -d '{"sourceType":"local","sourcePath":"test-repositories/typescript-sample"}' > /dev/null

AID=$(curl -s -X POST $BASE/api/projects/$PID/analysis \
  -H 'Content-Type: application/json' -d '{}' | jq -r .data.id)

# poll until COMPLETED
until [ "$(curl -s $BASE/api/projects/$PID/analysis/$AID | jq -r .data.status)" = COMPLETED ]; do
  sleep 1
done

curl -s "$BASE/api/projects/$PID/graph" | jq '.meta'

curl -s "$BASE/api/projects/$PID/graph?projection=architecture" | jq '.meta'

NODE=$(curl -s "$BASE/api/projects/$PID/graph/search?q=UserService" | jq -r '.data[0].id')
curl -s "$BASE/api/projects/$PID/graph/nodes/$NODE" | jq '.data.callers, .data.databases'
```

## Conventions

- `Content-Type: application/json` on every request with a body.
- Ids in paths are UUIDs, except graph node ids, which are the content hashes
  described in [graph-model.md](graph-model.md).
- Unknown query parameters are ignored; malformed known ones are a `400`.
- There is no authentication. Do not expose this to a network you do not
  control — auth arrives in a later phase.
