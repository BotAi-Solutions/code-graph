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
| `INVALID_PROJECT_PATH` | 400 | The path exists but is a file, not a project folder |
| `FILESYSTEM_ACCESS_DISABLED` | 403 | `LOCAL_FILESYSTEM_ENABLED=false` on this server |
| `DIRECTORY_NOT_READABLE` | 403 | Permission denied on the project directory |
| `SOURCE_PATH_NOT_ALLOWED` | 403 | A source path resolved outside the project's repository |
| `SOURCE_NOT_READABLE` | 403 | Permission denied on a source file, or the repository is a git clone |
| `NOT_FOUND` | 404 | Unknown route |
| `PROJECT_NOT_FOUND` | 404 | No such project |
| `REPOSITORY_NOT_FOUND` | 404 | The project has no repository configured |
| `ANALYSIS_NOT_FOUND` | 404 | No such analysis *in this project* |
| `NODE_NOT_FOUND` | 404 | No such graph node in this project |
| `REPOSITORY_PATH_NOT_FOUND` | 404 | The worker could not read the repository path |
| `DIRECTORY_NOT_FOUND` | 404 | No such directory on the machine running the API |
| `SOURCE_FILE_NOT_FOUND` | 404 | No such file in the project's repository |
| `CONFLICT` | 409 | Generic state conflict |
| `ANALYSIS_ALREADY_RUNNING` | 409 | A non-terminal analysis already exists for the project |
| `REPOSITORY_NOT_CONFIGURED` | 409 | An operation needs a repository that is not attached |
| `LANGUAGE_DETECTION_FAILED` | 422 | No supported language found in the repository |
| `SCIP_INDEXER_NOT_FOUND` | 422 | No indexer registered for the detected language |
| `SCIP_INDEX_FAILED` | 422 | The indexer exited non-zero or timed out |
| `SCIP_PARSE_FAILED` | 422 | `index.scip` could not be decoded |
| `GRAPH_BUILD_FAILED` | 422 | The builder could not assemble a graph |
| `NO_SOURCE_FILES` | 422 | The chosen folder holds nothing in a language we support |
| `SOURCE_FILE_TOO_LARGE` | 422 | The file is larger than source retrieval will read |
| `DIRECTORY_PICKER_UNAVAILABLE` | 501 | This host has no native folder dialog to open |
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

## Local project intake

Three routes, and the only ones in the API that touch the filesystem. They exist
because the browser must not: a tab cannot be trusted with a recursive walk of
someone's disk, and `showDirectoryPicker()` returns a handle rather than a path
in any case. The API process is the local runtime, so the API process does it.

None of these reads a file. The only thing that opens source is the worker, on a
directory the user picked and explicitly asked to index.

All three return `403 FILESYSTEM_ACCESS_DISABLED` when `LOCAL_FILESYSTEM_ENABLED`
is false — which is what you set when the API is not on the user's own machine.

### `POST /api/filesystem/select-directory` → `200`

Opens the host's own folder dialog (`osascript` on macOS, PowerShell's
`FolderBrowserDialog` on Windows, `zenity` on Linux) and blocks until it is
answered.

```json
{ "path": "/Users/example/projects/my-app", "name": "my-app" }
```

`data: null` means the dialog was dismissed. That is a success, not an error —
the UI stays where it was.

`501 DIRECTORY_PICKER_UNAVAILABLE` where there is no dialog to show: a
container, an SSH session, a Linux host with no display. Fall back to the
browser below.

### `GET /api/filesystem/directories?path=…` → `200`

The in-app folder browser. `path` defaults to the home directory of the user
running the API.

```json
{
  "path": "/Users/example/projects",
  "parentPath": "/Users/example",
  "isProjectRoot": false,
  "entries": [
    { "name": "my-app", "path": "/Users/example/projects/my-app", "isProjectRoot": true }
  ],
  "truncated": false
}
```

**Directories only.** Files are never listed, at any depth. `isProjectRoot`
means a manifest was found there — `package.json`, `go.mod`, `pyproject.toml`
and so on — so the folder you want is marked before you open it.

### `GET /api/filesystem/project?path=…` → `200`

One walk of the directory, no file reads: what is in this folder, before
committing to indexing it.

```json
{
  "rootPath": "/Users/example/projects/my-app",
  "name": "my-app",
  "totalFiles": 110,
  "sourceFiles": 104,
  "languages": { "typescript": 82, "javascript": 14, "python": 8 },
  "fileCategories": { "code": 104, "document": 3, "configuration": 2, "database": 1 },
  "directories": 24,
  "truncated": false
}
```

`sourceFiles` keeps its original meaning — files an indexer could compile — and
`fileCategories` says what the rest are, which is what turns "110 files, 104 of
them source" from an alarming sentence into a descriptive one. Both come from
the same walk and neither costs a file read.

`truncated` means the walk hit its file cap; the counts are a lower bound.
`422 NO_SOURCE_FILES` when nothing in the folder is in a language we detect.

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

### `DELETE /api/projects/:projectId` → `200`

Removes the project, its repository record, every analysis run and the whole
stored graph — one statement, cascaded by the database.

Returns the standard envelope with `data: null` rather than a bodiless `204`:
every other response this API gives is `{ success, data, error, meta }`, and the
web client parses that shape unconditionally.

`404 PROJECT_NOT_FOUND` when there is no such project, which is also what a
second delete of the same project returns.

Not blocked while an analysis is running. A worker that dies mid-run leaves a
job that never reaches a terminal state, and refusing to delete until it does
would strand exactly the project most likely to need deleting; the run is
orphaned instead. **Irreversible.** The analysed source on disk is never
touched — this deletes what was derived from it.

### `GET /api/projects/:projectId` → `200`

### `GET /api/projects/resolve?path=…` → `200`

The inverse of the intake flow, and the way in for anything holding a working
directory rather than a project id. Intake starts from a folder and creates a
project; this starts from a folder and asks which project was already created
from it.

```json
{
  "path": "/Users/example/projects/my-app/src/services",
  "matches": [
    {
      "project": { "id": "…", "name": "my-app", "nodeCount": 1184, "edgeCount": 4102,
                   "repository": { "sourceType": "local", "sourcePath": "/Users/example/projects/my-app", "commitHash": null },
                   "latestAnalysis": { "status": "COMPLETED", "…": null },
                   "nodeTypeCounts": { "class": 61, "method": 402 } },
      "repositoryRoot": "/Users/example/projects/my-app",
      "relativePath": "src/services",
      "exact": false
    }
  ]
}
```

`relativePath` is what the path is called *inside* that repository — the form
every other route speaks, so it can be handed straight to
`/source?file=…` or to `/graph/search?file=…`. It is `""` when the request named
the repository root itself, which is also when `exact` is true. `meta` carries
`{ total, path }`.

**A list, not a project.** In a monorepo the repository root and a package
inside it may both have been indexed, and the same directory may have been
indexed twice under two projects. Every project covering the path is returned,
most specific first. Choosing between them needs to know what the caller is for
— whether a half-indexed duplicate beats none, whether the outer project or the
inner one is the subject — so each match carries the full dashboard row and the
caller decides. This API does not guess.

Ordering is total and derived only from what the caller can see: a deeper
`repositoryRoot` first, then the newer project, then the id. The same request
twice returns the same order.

**No match is an answer.** A path no project covers returns `matches: []` and a
`200`, the way a dismissed folder dialog returns `data: null`. "Nothing here is
indexed" is a fact a caller acts on — by indexing it, or by reading the files
directly — not a failure it should have to catch. There is no `404` on this
route.

**The path is never read.** Nothing here opens, lists or stats the directory, so
it need not exist: a repository record may still name a path that has since been
deleted, and the API may be answering about a machine it cannot see. Two
consequences follow:

- A relative path is resolved against the same base directory a stored relative
  `sourcePath` is, not against the API process's working directory. So
  `?path=test-repositories/typescript-sample` finds the project registered under
  exactly that path.
- Symlinks are resolved only when `LOCAL_FILESYSTEM_ENABLED` is true — that is
  the flag that says the API shares a filesystem with whoever is asking. When it
  is false, paths are compared as written, which is the only thing that can mean
  anything across two machines. `repositoryRoot` and `relativePath` always
  compose back to `path`, whichever form matched.

A repository with `sourceType: git` never matches: its `sourcePath` is a clone
URL, and the worker deletes the clone when the run finishes, so there is no
directory for a path to be inside of.

`400 VALIDATION_ERROR` for a missing, empty or over-long path, or one containing
a NUL byte.

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
  "stats": {
    "documentCount": 6, "symbolCount": 63, "nodeCount": 79, "edgeCount": 247,
    "durationMs": 1002,
    "fileCount": 9, "sourceFileCount": 6, "directoryCount": 4,
    "classCount": 4, "functionCount": 18, "interfaceCount": 2,
    "languages": { "typescript": 6 },
    "parseErrorCount": 0
  },
  "progress": {
    "phase": "completed", "current": 1, "total": 1,
    "message": "Indexing complete",
    "files": 6, "symbols": 63, "relationships": 247, "errors": 0
  },
  "errors": []
}
```

States: `QUEUED → INDEXING → PARSING → BUILDING_GRAPH → PERSISTING → COMPLETED`,
or `FAILED` from any of them with `error` set.

`progress` is finer than `status`: the phase the pipeline is in plus how far
through that phase's own work it is. Phases are `queued`, `scanning`,
`indexing`, `parsing`, `resolving`, `building_graph`, `persisting`, `completed`
and `failed`.

**`total: 0` means the phase cannot count its work** — a filesystem walk does
not know how many files it will find, and an external indexer is one opaque
subprocess. Render that as indeterminate; do not divide by it. `files`,
`symbols` and `relationships` are counts of things that exist, absent until
there is something to count.

`errors` lists files that could not be read or parsed, capped at 100. These are
*warnings*: the run completed in spite of them, and `error` — the run's own
failure — is still null. A job recorded before progress existed has
`progress: null` and `errors: []`.

The statistics beyond the first five are optional for the same reason: a run
that did not measure them does not report them, and nothing derives them.

### `POST /api/projects/index` → `202` / `200`

Register-if-needed and index, in one call — what the MCP `index_project` tool
uses. Body: `{ "path": "/absolute/dir", "force"?: false }`. Validates the path
like the intake flow, finds the project registered at exactly that root or
creates one, and queues a run through the same service as
`POST /api/projects/:projectId/analysis`. Returns `action`: `started` (202),
`already_indexing` (200, the active run is returned; no duplicate is queued) or
`up_to_date` (200, the graph matches the files; nothing queued unless `force`).
Refuses relative paths and URLs (`INVALID_PROJECT_PATH`), missing or unreadable
directories, and everything when `LOCAL_FILESYSTEM_ENABLED=false`.

### `GET /api/projects/:projectId/freshness` → `200`

Whether the latest completed graph still matches the files: `state` is
`current`, `stale`, `unknown` (with `reason`) or `not_indexed`, with
`indexedCommit`, `currentCommit`, `changedFiles` (a count), up to 20
`changedPaths`, and `changes` (`added` / `modified` / `deleted`). Every file the
indexer reads is compared by content hash against the manifest recorded when the
run started (uncommitted and untracked files included); a moved HEAD is stale
too. See [mcp.md — What STALE means](mcp.md#what-stale-means).

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

Query: `q` (required), `nodeTypes` (CSV or repeated), `categories` (CSV or
repeated: `code`, `architecture`, `knowledge`), `file` (a repository-relative
path prefix, case-insensitive, applied in the query before paging so `total`
counts only what it keeps), `limit` (1–100, default 20), `offset` (default 0).

Case-insensitive substring match on **name**, **qualified name** and **file
path**, which between them cover every way a person refers to anything in the
repository:

| Term | Finds |
| --- | --- |
| `UserService` | the class |
| `UserService.getUser` | the method |
| `user.service.ts` | the file |
| `src/services` | everything under the directory |
| `POST /users` | the API route, and the endpoint a specification declares |
| `README.md#login-flow` | the document section |
| `package.json#scripts.build` | the configuration property |
| `postgresql.users.email` | the table column |
| `table` | every node of that type |

The three narrowings compose, and a node has to satisfy all of them:

- `nodeTypes` is exact.
- `categories` is the question a person actually asks — "only documentation" —
  without having to know that documentation means `document` and
  `document_section`. `meta.nodeTypes` reports which types it resolved to.
- `file` keeps results under a path prefix.

Given `nodeTypes=class&categories=knowledge` the intersection is empty and the
response is empty, rather than quietly widening to everything — which would be
the opposite of what was asked.

Ranking is a fixed ladder, so the same term always produces the same page:

| Rank | Match |
| --- | --- |
| 0 | the symbol's own name, exactly (`UserService`) |
| 1 | its qualified name, exactly (`UserService.getUser`) |
| 2 | a file, by full path or by file name (`user.service.ts`) |
| 3 | a name prefix |
| 4 | a qualified-name prefix |
| 5 | a path prefix |
| 6 | a dotted token of a qualified name (`getUser` inside `X.getUser`) |
| 7 | anything else containing the term |

Ties break on name length, then name, then id — so nothing a caller can see is
decided by the query planner's row order. `meta` carries
`{ total, limit, offset, query }` plus whichever narrowings were applied;
`total` is the full match count, not the page, so a client can say "showing 15
of 42" rather than silently truncating.

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
  "symbol":       { "name": "UserRepository", "qualifiedName": "UserRepository",
                    "type": "class", "language": "typescript",
                    "filePath": "src/repositories/user.repository.ts",
                    "startLine": 8, "startCharacter": 13, "endLine": 55, "endCharacter": 1,
                    "exported": null, "visibility": null, "module": "src/repositories",
                    "framework": null, "apiRoute": null, "databaseResource": null,
                    "externalService": null, "messagingResource": null,
                    "scipSymbol": "…", "role": "repository",
                    "category": "code", "family": "types", "fileCategory": null },
  "definition":   { "nodeId": "…", "name": "UserRepository",
                    "qualifiedName": "UserRepository", "type": "class",
                    "language": "typescript",
                    "filePath": "src/repositories/user.repository.ts",
                    "startLine": 8, "startCharacter": 13,
                    "endLine": 55, "endCharacter": 1, "fileNodeId": "…" },
  "callers":      [ { "type": "class", "name": "UserService" } ],
  "callees":      [ ],
  "references":   [ { "type": "method", "name": "create" } ],
  "dependencies": [ ],
  "dependents":   [ ],
  "apis":         [ ],
  "databases":    [ { "type": "table", "name": "users", "relationship": "WRITES_TO",
                      "direction": "outgoing", "confidence": "high",
                      "evidenceSource": "database-analyzer",
                      "evidence": { "source": "database-analyzer", "confidence": "high",
                                    "method": "ast", "file": "src/repositories/user.repository.ts",
                                    "line": 13, "matched": "users" } } ],
  "documentation":[ { "type": "document_section", "name": "Persistence",
                      "qualifiedName": "docs/architecture.md#persistence",
                      "relationship": "DOCUMENTS", "direction": "incoming",
                      "confidence": "medium",
                      "evidence": { "source": "document-analyzer", "confidence": "medium",
                                    "method": "markdown", "file": "docs/architecture.md",
                                    "line": 17, "matched": "UserRepository" } } ],
  "contracts":    [ ],
  "implementations": [ { "type": "interface", "name": "UserStore",
                         "relationship": "IMPLEMENTS", "direction": "outgoing" } ],
  "parent":       { "type": "file", "name": "user.repository.ts" },
  "children":     [ { "type": "method", "name": "findById" } ],
  "totals":       { "callers": 1, "callees": 0, "references": 1, "dependencies": 0,
                    "dependents": 0, "apis": 0, "databases": 1, "documentation": 1,
                    "contracts": 0, "implementations": 1, "children": 1 }
}
```

- **symbol** — the node's metadata, read into named fields. Every value is
  copied, never inferred; a property no analyzer recorded is `null`. `module` is
  the one computed field, and only from a fact the indexer stored: the directory
  the file sits in. `exported` is `true` when an `EXPORTS` edge points at the
  node and `null` otherwise — never `false` from absence, which would claim
  every symbol in an un-analysed project is private.

  Three fields are *derived from the node type* and therefore always present:
  `category` (`code`, `architecture` or `knowledge`) and `family`, which are how
  the UI groups and colours, and `fileCategory` — what kind of file this is, for
  a node standing for a whole one, and `null` for everything else. They are
  derived rather than stored so they cannot disagree with the type.
- **definition** — where the symbol is written, plus the id of the `file` node
  that contains it. `null` for a node with no file (a table, an external
  package); null coordinates for one the indexer gave no range.
- **callers** — incoming `CALLS`
- **callees** — outgoing `CALLS`
- **references** — incoming `REFERENCES`, i.e. what uses this node without
  calling it
- **dependencies** / **dependents** — outgoing / incoming `DEPENDS_ON`,
  `DEPENDS_ON_SERVICE`, `IMPORTS`, `USES`
- **apis** — `api` nodes that `ROUTES_TO` this node
- **databases** — `database`, `table`, `queue` and `event` nodes this node
  `READS_FROM`, `WRITES_TO`, `PUBLISHES` or `SUBSCRIBES`
- **documentation** — both directions of `DOCUMENTS` and `LINKS_TO`: the
  sections that describe this node, and for a document, what it describes and
  links to
- **contracts** — both directions of `DEFINES` and `IMPLEMENTED_BY`: the
  specification that promises an endpoint, the migration that creates a table,
  the compose file that defines a container, and the code that keeps a promise
- **implementations** — both directions of `IMPLEMENTS` and `EXTENDS`.
  `direction: incoming` is something that implements or extends this node;
  `outgoing` is what this node implements or extends.
- **parent** / **children** — the `CONTAINS` edge either way: the class a method
  belongs to, the members of a class, the symbols of a file.

`callers`, `callees` and `references` keep the plain node shape they have always
had. The sections carrying a relationship add `relationship`, `direction`,
`confidence`, `evidenceSource` and the full `evidence` record to each entry,
because "depends on" covers four different relationships and a client should be
able to say which — and because an inferred edge is only useful if a reader can
go and check it. A section with nothing in it is `[]`, never absent.

`evidence` is `null` for an edge stored before evidence was recorded. Its shape:

| Field | Meaning |
| --- | --- |
| `source` | which analyzer observed it |
| `confidence` | `high`, `medium` or `low` |
| `method` | the kind of artefact: `scip`, `ast`, `markdown`, `json`, `yaml`, `sql`, `openapi`, `configuration`, `graph` |
| `file`, `line`, `column` | where to check. Absent for a compiler fact, which is located by its endpoints |
| `matched` | the entity the producer matched |

Query: `limit` (default 100) caps each list. **`totals`** is the exact size of
every section before that cap, counted with the same bucketing rules, so a list
shorter than its total is known to be incomplete; its route below pages through
the rest. Each section is capped on its own — a crowded section cannot use up
another's share.

### `GET /api/projects/:projectId/graph/nodes/:nodeId/callers` → `200`
### `GET /api/projects/:projectId/graph/nodes/:nodeId/callees` → `200`
### `GET /api/projects/:projectId/graph/nodes/:nodeId/references` → `200`
### `GET /api/projects/:projectId/graph/nodes/:nodeId/dependencies` → `200`
### `GET /api/projects/:projectId/graph/nodes/:nodeId/dependents` → `200`
### `GET /api/projects/:projectId/graph/nodes/:nodeId/implementations` → `200`
### `GET /api/projects/:projectId/graph/nodes/:nodeId/children` → `200`
### `GET /api/projects/:projectId/graph/nodes/:nodeId/apis` → `200`
### `GET /api/projects/:projectId/graph/nodes/:nodeId/databases` → `200`
### `GET /api/projects/:projectId/graph/nodes/:nodeId/documentation` → `200`
### `GET /api/projects/:projectId/graph/nodes/:nodeId/contracts` → `200`

The same lists on their own routes, paged, for clients that want one of them —
or all of one. `callers`, `callees`, `references` and `children` return plain
nodes; the rest return the related-node shape with its evidence.

Query: `limit` (default 100), `offset` (default 0); `implementations` also takes
`direction` (`both`, default, `incoming` — what implements or extends this node —
or `outgoing`). The order is total and stable (name then id; source order for
`children`; direction, relationship, name for the related sections), so an
offset addresses the same entry on every request. `data` is the page; `meta` is
`{ total, limit, offset, hasMore, nextOffset }`, where `total` is the full
section count, never the page size.

### `GET /api/projects/:projectId/graph/nodes/:nodeId/definition` → `200`

Where the node is written down, as the `definition` block above — or `null`.

There is no separate definition *record* in this graph, and there should not be:
a node **is** a definition. SCIP recorded the range it occupies and the builder
stored it, so this route reports the node's own coordinates rather than
resolving anything.

### `GET /api/projects/:projectId/graph/nodes/:nodeId/parents` → `200`

The containment chain above the node, nearest first — method → class → file →
directory → repository. `limit` (default 100) caps how far up the chain is
walked.

### `GET /api/projects/:projectId/graph/tree` → `200`

One level of the repository tree, derived from the path nodes the pipeline
already produced. Query: `path` (repository-relative; omit for the root),
`limit` (1–2000, default 500).

The tree is built from `directory` plus every node type that stands for a whole
file — `file`, `document`, `config` and `api_spec` — so a README, a compose file
and an OpenAPI contract appear beside the source. `type` on the wire stays
`directory` or `file`, because that is the distinction a tree row needs; a
client wanting to know a file is a document reads the node.

```json
{
  "path": "src",
  "parentPath": "",
  "entries": [
    { "path": "src/services", "name": "services", "type": "directory", "nodeId": "…" },
    { "path": "src/app.ts", "name": "app.ts", "type": "file", "nodeId": "…" }
  ],
  "truncated": false
}
```

Directories come before files, each alphabetically. One level per request, not
a whole tree: a mid-sized repository has thousands of path nodes, and shipping
all of them to draw twelve rows would be the most expensive thing on the screen.
Every entry carries its `nodeId`, so a row in the tree is also a node on the
graph — opening a file can select it.

Paths are always repository-relative. The API never returns an absolute path.

### `POST /api/projects/:projectId/graph/path` → `200`

The shortest route between two nodes, walked breadth-first on the server.

**Request**

```json
{
  "from": "0293…",
  "to": "77ab…",
  "maxDepth": 6,
  "direction": "outgoing",
  "relationships": ["ROUTES_TO", "CALLS", "WRITES_TO"],
  "nodeTypes": ["api", "class", "table"],
  "projection": "dataflow"
}
```

Only `from` and `to` are required. `maxDepth` is 1–12 (default 6). `direction`
is `outgoing` (default) or `both`. `relationships` and `nodeTypes` narrow which
edges and nodes the walk may cross; `projection` supplies both when neither is
given, and an explicit filter always wins.

**Response**

```json
{
  "found": true,
  "from": "0293…", "to": "77ab…",
  "depth": 4,
  "undirected": false,
  "truncated": false,
  "nodes": [ /* in order, from `from` to `to` */ ],
  "edges": [ /* in the order they are crossed */ ],
  "steps": [
    { "edgeId": "…", "sourceNodeId": "…", "targetNodeId": "…",
      "relationship": "ROUTES_TO", "reversed": false,
      "confidence": "high", "evidenceSource": "api-analyzer",
      "evidence": { "source": "api-analyzer", "confidence": "high" } }
  ],
  "relationships": ["ROUTES_TO", "CALLS", "READS_FROM"]
}
```

`steps[i]` is the hop *out of* `nodes[i]`, so the last node has none.
`relationships` is the distinct set in order of first use — the shape of the
trace, without repeating `CALLS` four times for a four-hop call chain.

`direction: outgoing` asks the question a trace usually is: how does a request
get from the controller to the table. When no directed route exists the search
is repeated ignoring direction and the answer comes back with
`undirected: true` and `reversed: true` on the hops it crossed backwards — two
pieces of code can be genuinely related without one reaching the other, and
reporting that is more useful than reporting nothing.

`found: false` with `truncated: true` means the search spent its node budget
before it could conclude, **not** that no route exists.

Nothing is inferred: every hop is an edge that is in the graph, with the whole
evidence record it was written with — so a trace from an OpenAPI operation to a
database column can be checked hop by hop, each against the file and line that
produced it. A trace is worth no more than its weakest hop, and `steps` is where
that is visible.

---

## Source

### `GET /api/projects/:projectId/source` → `200`

A window onto one file in the project's repository. Read-only; there is no
write counterpart and no other route in the API opens a file.

Every textual resource the graph indexes is readable this way, not only code: a
`nodeId` naming a `document_section` opens the README at the heading, one naming
an `api_endpoint` opens `openapi.yaml` at the operation, and a `config_property`
opens `package.json` at the key. The node supplies the range, so "show me this"
is one request whatever kind of thing it is.

Query — one of `file` or `nodeId` is required:

| Parameter | Meaning |
| --- | --- |
| `file` | repository-relative path |
| `nodeId` | a graph node, whose indexed range becomes the window and the highlight |
| `startLine`, `endLine` | 1-based, inclusive; honoured exactly as given |
| `context` | lines either side of a symbol range (0–200, default 12); ignored for an explicit range |

```json
{
  "file": "src/services/user.service.ts",
  "language": "typescript",
  "startLine": 39,
  "endLine": 47,
  "totalLines": 68,
  "truncated": false,
  "highlight": { "nodeId": "…", "startLine": 41, "startCharacter": 2,
                 "endLine": 45, "endCharacter": 3 },
  "lines": [
    { "line": 39, "text": "  }" },
    { "line": 41, "text": "  async getUser(id: string): Promise<User> {" }
  ]
}
```

`highlight` is the symbol range that motivated the window, so a viewer can
scroll to it and mark it; `null` when the request named a file rather than a
node, or when the indexer recorded no range. `truncated` is true when the
requested range exceeded the 2000-line response ceiling.

#### The sandbox

Source retrieval is the most sensitive route in the API, and four things keep
it narrow:

1. **The root comes from the project, never the request.** A caller says
   `src/services/user.service.ts`; which disk that lands on is decided by the
   repository record attached to the project.
2. **The path is checked twice** — once after normalising, which catches `..`
   and absolute paths, and again after resolving symlinks, because a link inside
   the tree is an ordinary way to point at `/etc/passwd`. Both return
   `403 SOURCE_PATH_NOT_ALLOWED`.
3. **Nothing about the host's layout is returned.** Responses carry the
   repository-relative path, so the browser never learns where the repository
   sits on disk.
4. **`LOCAL_FILESYSTEM_ENABLED=false` disables it entirely**, with
   `403 FILESYSTEM_ACCESS_DISABLED`.

A repository with `sourceType: git` returns `403 SOURCE_NOT_READABLE`: the
worker shallow-clones it into scratch space and deletes it when the run
finishes, so there is nothing left to read, and saying so is better than reading
whatever happens to sit at that path now.

---

## Code search

### `GET /api/projects/:projectId/code/search?q=…&limit=…` → `200`

Finds literal occurrences of a string in a project’s source files.

Deliberately a different thing from `/graph/search`, which matches the *names*
of things the indexer recorded. This matches the characters in the files, so it
finds a string in a comment, in a template literal, in a YAML value and in a
language nothing in this system can parse — none of which is in the graph.

```
GET /api/projects/2cd2c90a…/code/search?q=UserRepository&limit=20
```

```json
{
  "success": true,
  "data": [
    {
      "filePath": "src/app.ts",
      "line": 8,
      "column": 9,
      "match": "UserRepository",
      "lineText": "import { UserRepository } from './repositories/user.repository';",
      "lineTruncated": false
    }
  ],
  "error": null,
  "meta": {
    "total": 8, "limit": 20, "truncated": false, "query": "UserRepository",
    "filesSearched": 19, "filesSkipped": 0, "scanTruncated": false
  }
}
```

| Parameter | Default | Notes |
| --- | --- | --- |
| `q` | — | **Required.** 1–200 characters. A literal string. |
| `limit` | `20` | 1–100. Matches one response carries. |

#### Semantics

**Literal and case-sensitive.** Not a regular expression, not a glob, not a
pattern of any kind. `obj.method(arg)` matches those fifteen characters and
nothing else; `.` is a full stop and `(` is a parenthesis. `UserRepository` does
not match `userRepository`.

**Nothing is executed.** There is no subprocess, no `grep`, no shell — the query
reaches a string comparison and goes no further, so there is no argument or
interpolation to get wrong.

**One result per occurrence, not per line.** `foo(foo, foo)` searched for `foo`
is three results at columns 0, 4 and 9. Overlaps are counted the way every other
literal search counts them: `aa` occurs once in `aaa`, because the scan moves
past what it matched.

**Coordinates match the rest of this API**: `line` is 1-based, `column` is
0-based — the same convention as `startLine` and `startCharacter` on a graph
node.

**Ordering is `filePath`, then `line`, then `column`**, ascending. No relevance
scoring: the same query over the same tree always produces the same page.

**`lineText` is windowed** when a line is longer than 200 characters — a
minified bundle is one line of two megabytes. The window follows the match, so
the match is always visible in it, and `lineTruncated` says when it happened.

#### Which files are searched

The file list comes from the same walk the indexer uses, so the ignore policy is
the project’s own rather than a second list that would drift from it:
`node_modules`, `dist`, `build`, `.git`, `coverage`, lock files and the rest are
already excluded, and symlinks are not followed.

Of what survives that walk, the categories the pipeline treats as analysable are
searched — **code, documents, configuration, schemas and SQL**. `binary` is
excluded by classification rather than by an extension blacklist, and
`generated` and `vendor` are excluded because a match in a bundle or a
checked-in dependency answers nobody’s question.

A file larger than the source-retrieval ceiling (4 MB) is skipped rather than
read.

#### What the counts mean

`total` is the number of occurrences across every file searched — not the size
of `data`, and not a count of matching lines. The scan keeps counting after the
page is full, and stops *collecting*, so the count stays exact while the
response stays bounded. `truncated` is `total > data.length`.

Two fields say when `total` is a floor rather than an exact figure, so an
understated count is never silent:

- `filesSkipped` — files passed over for being too large.
- `scanTruncated` — the walk stopped early (a repository beyond 25,000 files or
  24 directories deep).

`filesSearched` is how many files were actually read.

#### Failures

Source access is the same boundary `/source` sits behind, and this route
inherits all of it:

| Code | Status | When |
| --- | --- | --- |
| `PROJECT_NOT_FOUND` | 404 | No such project — checked before anything touches a disk |
| `REPOSITORY_NOT_FOUND` | 404 | The project has no repository attached |
| `REPOSITORY_PATH_NOT_FOUND` | 404 | The registered directory is no longer readable |
| `SOURCE_NOT_READABLE` | 403 | `sourceType: git` — the worker deletes its shallow clone, so there is nothing left to search |
| `FILESYSTEM_ACCESS_DISABLED` | 403 | `LOCAL_FILESYSTEM_ENABLED=false` |
| `VALIDATION_ERROR` | 400 | Missing, empty or over-long `q`, or a `limit` outside 1–100 |

**No match is not a failure.** `data: []` with `total: 0` and a `200` means the
string is not in the project’s source — which is a different statement from the
source being unreadable, and the two never look alike.

**Project isolation.** The root comes from the project’s own repository record,
never from the request, so a search reads one project’s tree and no other. A
query is never joined to a path, so `../../etc/passwd` is a string to look for,
not a place to look in.

---

## Worked flow

```bash
BASE=http://localhost:3000

# What the "Select project" button does, when there is a dialog to open.
# (Scriptable alternative: skip it and use a path you already know.)
DIR=$(curl -s -X POST $BASE/api/filesystem/select-directory | jq -r '.data.path // empty')
DIR=${DIR:-test-repositories/typescript-sample}

# Size it up before committing to a run.
curl -s "$BASE/api/filesystem/project?path=$DIR" | jq '.data'

PID=$(curl -s -X POST $BASE/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"name":"sample"}' | jq -r .data.id)

curl -s -X POST $BASE/api/projects/$PID/repository \
  -H 'Content-Type: application/json' \
  -d "{\"sourceType\":\"local\",\"sourcePath\":\"$DIR\"}" > /dev/null

AID=$(curl -s -X POST $BASE/api/projects/$PID/analysis \
  -H 'Content-Type: application/json' -d '{}' | jq -r .data.id)

# poll until COMPLETED, printing where the pipeline has got to
until [ "$(curl -s $BASE/api/projects/$PID/analysis/$AID | jq -r .data.status)" = COMPLETED ]; do
  curl -s $BASE/api/projects/$PID/analysis/$AID \
    | jq -r '.data.progress | "\(.phase) \(.current)/\(.total) \(.message)"'
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
