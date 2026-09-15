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
  "nodeCount": 76, "edgeCount": 243,
  "nodeTypeCounts": { "class": 6, "interface": 4, "method": 31, "file": 6, "…": 0 }
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
  "stats": { "documentCount": 6, "symbolCount": 63, "nodeCount": 76, "edgeCount": 243, "durationMs": 1002 }
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
| `nodeTypes` | all | CSV or repeated; `class,method` |
| `relationships` | all | CSV or repeated; `CALLS,REFERENCES` |
| `limit` | `500` | Max nodes, 1–2000 |

Two modes, reported in `meta.mode`:

- **`traversal`** — with `rootNodeId`, an undirected walk outward to `depth`
  hops. Filters apply *during* expansion: a filtered traversal never reaches
  through an excluded node. The root is always included.
- **`overview`** — without one, the project's most connected code-bearing nodes
  (`class`, `interface`, `type`, `function`, `method`) and the behavioural edges
  between them. Files and directories are excluded by default because they
  always win a degree contest while saying nothing about behaviour; pass
  `nodeTypes` to include them.

```json
{
  "success": true,
  "data": { "nodes": [], "edges": [] },
  "error": null,
  "meta": {
    "mode": "traversal", "rootNodeId": "a1b2…", "depth": 2,
    "limit": 500, "nodeCount": 11, "edgeCount": 25, "truncated": false
  }
}
```

`truncated: true` means `limit` cut the result short — raise it, narrow the
filters, or reduce the depth.

Edges are the induced subgraph: an edge appears only when both endpoints do.

### `GET /api/projects/:projectId/graph/summary` → `200`

```json
{
  "nodeCount": 76,
  "edgeCount": 243,
  "rootNodeId": "0293…",
  "nodeTypeCounts": { "class": 6, "interface": 4, "method": 31, "file": 6 }
}
```

`nodeCount: 0` means the project has not been analysed yet. `rootNodeId` is the
repository node, the natural starting point for a structural walk.

### `GET /api/projects/:projectId/graph/search` → `200`

Query: `q` (required), `limit` (1–100, default 20). Case-insensitive substring
match on symbol name and file path, shortest names first.

### `GET /api/projects/:projectId/graph/nodes/:nodeId` → `200`

Everything the node inspector needs, in one round trip:

```json
{
  "node": { "id": "…", "type": "class", "name": "UserService",
            "filePath": "src/services/user.service.ts", "startLine": 13, "endLine": 47,
            "metadata": { "scipSymbol": "…", "scipKind": "class", "language": "typescript" } },
  "callers":    [ { "type": "class", "name": "UserController" } ],
  "callees":    [ { "type": "class", "name": "UserRepository" } ],
  "references": [ ]
}
```

- **callers** — incoming `CALLS`
- **callees** — outgoing `CALLS`
- **references** — incoming `REFERENCES`, i.e. what uses this node without
  calling it

Query: `limit` (default 100) caps each list.

### `GET /api/projects/:projectId/graph/nodes/:nodeId/callers` → `200`
### `GET /api/projects/:projectId/graph/nodes/:nodeId/callees` → `200`

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

NODE=$(curl -s "$BASE/api/projects/$PID/graph/search?q=UserService" | jq -r '.data[0].id')
curl -s "$BASE/api/projects/$PID/graph/nodes/$NODE" | jq '.data.callers'
```

## Conventions

- `Content-Type: application/json` on every request with a body.
- Ids in paths are UUIDs, except graph node ids, which are the content hashes
  described in [graph-model.md](graph-model.md).
- Unknown query parameters are ignored; malformed known ones are a `400`.
- There is no authentication. Do not expose this to a network you do not
  control — auth arrives in a later phase.
