# MCP

`apps/mcp` exposes the repository knowledge graph to a local MCP client — an
agent, an editor, a CLI — over stdio.

It is an **adapter and nothing else**. It speaks MCP on one side and the
existing HTTP API on the other:

```
MCP client ──stdio──▶ apps/mcp ──HTTP──▶ apps/api ──▶ services ──▶ PostgreSQL
                                                                      ▲
                                  apps/worker ── claims queued runs ──┘
                                  (SCIP → graph → persisted)
```

A tool is a schema, a request and a rendering. No tool queries the database, and
the app has no database credentials to query it with — `apps/mcp` depends on
`@ckg/shared` and the MCP SDK, and on nothing else in the workspace. That is
structural rather than a convention: if a question cannot be answered through
the HTTP API, the answer is a new API route, not a second path into the data.

## Quick start

### Required services

| Service | What for | Started by |
| --- | --- | --- |
| PostgreSQL | Stores projects, runs and graphs | `docker compose` (or your own server at `DATABASE_URL`) |
| API (`apps/api`) | Every MCP tool calls it | `pnpm --filter @ckg/api dev` |
| Worker (`apps/worker`) | Runs the indexing that `index_project` queues | `pnpm --filter @ckg/worker dev` |
| MCP server (`apps/mcp`) | The tools | Your MCP client launches it — never started by hand |

### One command

```bash
pnpm dev:all             # PostgreSQL + build + migrations + API + worker + web UI
pnpm dev:all --no-web    # the same without the web UI
```

In order, it: uses PostgreSQL if something already listens at `DATABASE_URL`,
otherwise runs `docker compose up -d --wait postgres`; runs `pnpm build:packages`
and `pnpm db:migrate`; starts each service through its package's own `dev`
script with `[api]` / `[worker]` / `[web]` prefixed output; waits for
`/health`; then prints what is running. Any failing step stops it with the
reason, and so does a port already taken by another running copy. A service that exits takes the others down and says which one it was.
Ctrl+C stops the services; PostgreSQL keeps running
(`docker compose stop postgres` stops it).

The existing `pnpm dev`, `pnpm dev:api` and `pnpm dev:worker` are unchanged.

### Connect Claude Code

**In this repository**, nothing to configure: [`.mcp.json`](../.mcp.json)
declares the server, and Claude Code asks once to approve it.

```json
{
  "mcpServers": {
    "code-graph": {
      "command": "node",
      "args": ["${CLAUDE_PROJECT_DIR:-.}/apps/mcp/dist/server.js"]
    }
  }
}
```

It runs the built server (`pnpm dev:all` builds it). It has no `env` block: the
server reads the workspace `.env` itself, so no secrets live in the file.

**From any other repository** — the usual case, since that is the code you want
analysed — register it once at user scope with the absolute path:

```bash
claude mcp add --scope user code-graph -- node /absolute/path/to/code-graph/apps/mcp/dist/server.js
```

That one registration serves every repository: see
[Automatic project registration](#automatic-project-registration) for how the
server learns which one is open.

### Verify it

1. **Start dependencies and CodeRAG:** `pnpm dev:all`. Wait for `CodeRAG is running`.
2. **Connect:** open Claude Code in the repository (approve `code-graph` when asked),
   or run `claude mcp get code-graph`. `Pending approval` means run `claude` and
   approve it. `claude mcp reset-project-choices` re-asks.
3. **Tools visible:** `/mcp` in a session lists `code-graph` with nine tools.
4. **Smoke test:** ask Claude to *"call ensure_project"*. A new repository
   comes back `registered` with a run id; poll `get_index_status` until
   `ready`. Then *"search_graph for AnalysisService"*. (The step-by-step form
   still works: *"resolve_project for this directory, then get_index_status"*.)

`pnpm dev:mcp` runs the server in watch mode against your terminal's stdin,
which is useful for seeing it start and little else — the protocol expects a
client on the other end.

## Configuration

Three variables, all optional, read from the workspace `.env` like everything
else — the server finds that `.env` from its own location, so it is read
whichever repository the client was opened in.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_API_BASE_URL` | `http://localhost:${PORT}` | Where the API is |
| `MCP_REQUEST_TIMEOUT_MS` | `15000` | Ceiling on one call to the API |
| `MCP_AUTO_ENSURE_PROJECT` | `true` | Run `ensure_project` for the current project on startup |

Two more are read from the client's environment, not from `.env`: they name the
current project (see [Automatic project registration](#automatic-project-registration)).

| Variable | Set by | Purpose |
| --- | --- | --- |
| `CLAUDE_PROJECT_DIR` | Claude Code, for every stdio server it launches | The repository the session is open in |
| `CODERAG_PROJECT_DIR` | You, in another client's server config | The same, for clients that do not set `CLAUDE_PROJECT_DIR` |

Left unset, `MCP_API_BASE_URL` follows the API's own `PORT` from the same file,
so moving the API off a busy port needs no second edit — the web dev server's
proxy resolves its target the same way. `HOST` is deliberately not consulted: it
is the address the API *binds* to, commonly `0.0.0.0`, which is not an address
anything can connect to. A value that is not an absolute `http(s)` URL fails at
startup, naming the variable — `localhost:3000` parses as a `localhost:` scheme
and is rejected, because the alternative is every tool call reporting that the
API cannot be reached.

There is no `DATABASE_URL`, and there is no way to add one that would do
anything.

## Automatic project registration

Open any repository in Claude Code (terminal or VS Code) and the graph for it is
there, or on its way, without registering or indexing anything by hand.

### Three separate things

```
MCP registration      Claude Code knows how to launch code-graph        once per machine   (claude mcp add --scope user)
project registration  CodeRAG has a project for this directory          once per repository (API: projects + repositories)
graph indexing        a run has built that project's graph              whenever it is new or stale (worker)
```

They are independent: a registered MCP server can be open in a repository
CodeRAG has never seen, and a registered project can have no graph yet.
`ensure_project` is what connects them — it takes the directory the session is
open in to a registered project with a graph (or a run on its way), using the
same pieces the other tools use and adding no indexing or status logic of its own.

### How the current repository reaches the server

```
VS Code / terminal opens /work/repo-a
        ↓
Claude Code launches the user-scoped server with CLAUDE_PROJECT_DIR=/work/repo-a
        ↓
config.ts reads it  →  project-root.ts validates it  →  ensure_project uses it
```

Claude Code sets `CLAUDE_PROJECT_DIR` in the environment of every stdio server
it starts, and it is the directory the session was opened in — the VS Code
workspace folder, or where `claude` was run. So the *same* registration sees
`repo-a` in one window and `repo-b` in another. Nothing per repository: no
`.mcp.json` to copy, no path to edit.

The working directory is deliberately **not** used as a fallback: Claude Code
starts a user-scoped server in its own configuration directory (`~/.claude`),
not the project. For another MCP client, set `CODERAG_PROJECT_DIR` in its server
configuration instead.

The root is validated on this machine before anything is registered:

| Check | Refused with |
| --- | --- |
| No `rootPath` and no `CLAUDE_PROJECT_DIR` / `CODERAG_PROJECT_DIR` (or a relative value) | `PROJECT_ROOT_UNDETERMINED` |
| Does not exist | `PROJECT_ROOT_NOT_FOUND` |
| Not a directory | `PROJECT_ROOT_NOT_DIRECTORY` |
| No `.git`/`.hg`/`.svn` or project manifest (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, …) at the top, and not inside a git work tree | `PROJECT_ROOT_NOT_A_PROJECT` |
| The filesystem root or the home directory | `PROJECT_ROOT_TOO_BROAD` |

The path is made absolute, normalised and passed through `realpath`, as the API
does, so a symlinked path and its target are one project.

### Project identity

A project is identified by its repository root's canonical path — never by the
directory's name. `/projects/foo/my-app` and `/projects/bar/my-app` are two
projects, both named `my-app`. A session opened in a subdirectory of an
already-registered project (a package in a monorepo) uses that enclosing
project rather than registering the subdirectory; `requestedPath` then differs
from `rootPath`.

### When indexing happens

On startup the server runs `ensure_project` for the current project in the
background — it never waits for it, and the session is usable at once. The
model can call `ensure_project` too; a call made while the startup check is
still running shares its result.

| The project is… | `ensure_project` does | `action` |
| --- | --- | --- |
| Not registered | Registers it and queues its first run | `registered` |
| Registered, never indexed | Queues a run | `started` |
| Indexed but **stale** (files changed since, uncommitted edits included) | Queues a re-index | `started` |
| Being indexed | Nothing — returns the active run's id | `already_indexing` |
| Indexed and current | Nothing | `up_to_date` |
| Indexed, freshness unknown | Nothing (see below) | `none` |
| Last run **failed** | Nothing (see below) | `none` |

So an indexed, current repository is never re-indexed on startup, and a stale
one is re-indexed once: the next session finds the run already going, or the
graph current.

The two "nothing"s are deliberate. The check runs on every session start, so a
state indexing would not reliably fix — a run that keeps failing, a graph whose
freshness cannot be determined (recorded before revisions were tracked) — must
not queue a run each time a window opens. `reason` says which, and
`index_project` (with `force: true` for the unknown case) is the explicit retry.

Stale is decided by the existing freshness check (`GET /projects/:id/freshness`,
see [What STALE means](#what-stale-means)); nothing here has its own idea of it.

### No duplicate registration or runs

- **Across processes** (two windows on one repository, or the startup check in
  each): `POST /api/projects/index` serialises requests for the same directory
  inside the API, so the second request sees the first's project and its active
  run and returns them (`already_indexing`). That serialisation is in-process,
  which matches how the API runs — one process against its database.
- **Within one server**: concurrent `ensure_project` calls for the same root
  share one in-flight check and make one set of API calls.
- The API never queues a second active run for a project, whichever path asks.

### Turning it off, triggering, inspecting

| To… | Do |
| --- | --- |
| Stop the startup check | `MCP_AUTO_ENSURE_PROJECT=false` in the workspace `.env` (`ensure_project` still works when called) |
| Index or re-index by hand | `index_project` with the repository root; `force: true` re-indexes a current graph |
| Retry a failed run | `index_project` with the repository root |
| See the state | `get_index_status` with the `projectId` from `ensure_project` |
| See what the startup check did | The server's stderr (Claude Code's MCP server log): `current project checked` (with `action`, `status`, `indexingJobId`) or `could not check the current project on startup` with the reason |

If the API is not running when the session starts, the startup check logs that
and gives up; calling `ensure_project` once CodeRAG is up does the same work.

### Global Claude Code configuration

Once per machine, with the absolute path to this checkout (build it first:
`pnpm build:packages`, or `pnpm dev:all`):

```bash
claude mcp add --scope user code-graph -- node /absolute/path/to/code-graph/apps/mcp/dist/server.js
```

That writes this to `~/.claude.json`, which can also be edited directly or
passed to `claude mcp add-json --scope user code-graph '<json>'`:

```json
{
  "mcpServers": {
    "code-graph": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/code-graph/apps/mcp/dist/server.js"]
    }
  }
}
```

No `env` block is needed — not for the API address (the server reads this
checkout's `.env`) and not for the project (Claude Code supplies
`CLAUDE_PROJECT_DIR`). `claude mcp get code-graph` shows it; `/mcp` in any
session lists it. Inside this repository the project-scoped
[`.mcp.json`](../.mcp.json) declares the same server name and takes precedence,
which is harmless — it runs the same server.

## stdout belongs to the protocol

Every JSON-RPC frame the client reads comes from this process's stdout. One
stray `console.log` anywhere in this app lands between two frames and the
client's parser gives up — the symptom is a session that dies on connect with
nothing useful said.

So: nothing in `apps/mcp` prints. Logging goes through the shared logger built
with `destination: 'stderr'`, which overrides the usual contract of application
logs on stdout precisely because stdout is not a log stream here. A test spawns
the real process and asserts that every line on stdout parses as JSON-RPC and
that the startup line arrived on stderr instead.

## The workflow

The tools are meant to be used in this order:

```
ensure_project()                  the open repository  →  a projectId, registered and indexing if needed
        ↓   (or, step by step:)
resolve_project(path)             a working directory  →  a projectId
        ↓
get_index_status(projectId)       can that project answer anything, and is it current?
        ↓   never_indexed / stale / no match:
        ↓   index_project(repositoryRoot) → poll get_index_status until ready
        ↓
search_graph(projectId, query)    find candidate nodes  →  a nodeId
        ↓
get_node(projectId, nodeId)       what that node is, and what it connects to
        ↓
trace_path(projectId, a, b)       how one node reaches another
        ↓
search_code(projectId, query)     what the files literally say
        ↓
get_source(projectId, file, …)    the code at a location any of them reported
```

The last one is not a further step so much as the other half. `search_graph`
and `search_code` answer different questions, and an agent that cannot tell them
apart will read one's silence as the other's:

| Tool | Searches | Finds |
| --- | --- | --- |
| `search_graph` | Indexed **names** | Symbols, files, routes, tables — things the indexer recorded |
| `search_code` | Source **text** | Any literal string, including in comments, templates, config values, and languages nothing here parses |
| `get_node` | — | One node's metadata and relationships |
| `trace_path` | — | The route between two known nodes |
| `get_source` | — | The code at a file and line the others reported |

A name that is not indexed is not in the graph; a string that is not written
down is not in the source. Neither absence implies the other.

In full, the way an agent works through it:

1. Resolve the user’s project path.
2. Take the project id from the match that fits — or, with no match, call
   `index_project` on the repository root and take the id it returns.
3. Verify the index status before trusting anything the graph says. `never_indexed`
   or `stale` → `index_project`, then poll `get_index_status` until `ready`.
4. Search for nodes relevant to the question.
5. Pick a node id from the results.
6. Retrieve that node’s detail.
7. Use its relationships and their evidence to decide what to inspect next —
   another `get_node` on a neighbour, or a `trace_path` between two nodes that
   both matter to the question.

`ensure_project` does steps 1–3 in one call for the repository the session is
open in, and the server already runs it on startup. Call it once when it is
unclear whether the repository is ready — not before every query.

Each step exists because the next one cannot be trusted without it:

- **`resolve_project`** converts a filesystem path into an indexed project.
  Everything else in the graph API is addressed by a project id, and an agent
  starts life holding a directory instead.
- **`get_index_status`** says whether that project’s graph is usable — ready,
  stale, still indexing, failed, or never indexed. Skipping it is how an empty
  search result gets misread as "this code does not exist", and how a graph an
  agent's own edits have outdated gets trusted anyway.
- **`index_project`** fixes `never_indexed` and `stale`: it registers the
  directory if needed and queues a run through the existing pipeline, never a
  duplicate.
- **`search_graph`** searches that one project by name, and returns node ids.
- **`get_node`** inspects one of those nodes: what it is, where it is defined,
  and what it is connected to, with the evidence behind each connection.
- **`trace_path`** answers how two known nodes are connected, without an agent
  walking the graph by hand.
- **`search_code`** searches the source text itself, for everything the graph
  does not record.
- **`get_source`** reads the code. Every other tool stops at a coordinate; this
  is what turns one into something a model can read.

**The agent passes the same `projectId` through every call after the first.**
There is no implicit project, no "current" project and no server-side memory of
the last one selected: a tool that needs a project takes it as a required
argument, every time. Two projects in one conversation is an ordinary thing, and
nothing here makes it ambiguous which one an answer came from.

### Index status

`get_index_status` returns one `state`. The docs' names for them are in the
second column:

| `state` | Status | Means | Do |
| --- | --- | --- | --- |
| `ready` | CURRENT | Indexed; the graph matches the files (or freshness could not be determined — then `stale` is `null` and `freshnessReason` says why) | Ask away |
| `stale` | STALE | Indexed, but files changed after the graph was built | See below |
| `indexing` | INDEXING | A run is queued or in progress (`indexingJobId`) | Poll; an earlier graph may still be queryable (`indexed`) |
| `never_indexed` | NOT_INDEXED | No run has ever happened | `index_project` |
| `failed` | ERROR | The latest run failed (`error`) | Fix the cause; an earlier graph may survive (`lastSuccessfulRun`) |

### What STALE means

The latest completed graph was built from files that have since changed. It is
still stored and still answers, but symbols, relationships and line numbers in
or near the changed files may be wrong. `changedFiles` and `changedPaths` say
which files.

What an agent should do: say so when an answer depends on those files, read them
with `get_source` (it always reads the file as it is now), and call
`index_project` when a fresh graph matters. That is usually after a batch of
edits, not after every one.

How it is decided (`GET /api/projects/:projectId/freshness`):

- **Source manifest.** When a run starts, the worker walks exactly the files the
  indexer reads — the scanner's walk (`node_modules`, `dist`, lockfiles, … skipped)
  filtered to the formats the source loader opens — and records a SHA-256 of
  each file's content, keyed by repository-relative path. It is stored with the
  run (`analysis_jobs.source_revision`). A check rebuilds the same map and diffs
  it: **added**, **modified** and **deleted** files, committed or not, tracked
  or untracked. `.gitignore` plays no part: a gitignored file the indexer reads
  is watched, a file the indexer never reads (an image, a `.log`) is not. A live
  `.env` is watched for presence only; its contents are never hashed.
- **Commit.** For git working trees HEAD is recorded too. A HEAD that moved is
  stale on its own, even when no indexed file changed (the reason says so).
  `indexedCommit` / `currentCommit` report HEAD then and now.
- `changedFiles` is a **count** of differing indexed files (added + modified +
  deleted); `changedPaths` is the first 20 of them, sorted; `changes` splits the
  same differences into `added` / `modified` / `deleted` lists.
- The check reads and hashes files but parses nothing, writes nothing and never
  queues a run. About 50 ms for a 750-file repository.
- **Unknown** (`stale: null`): a project indexed from a git URL (no working tree
  left), local filesystem access switched off, or a run recorded before source
  manifests existed. Such a run is still compared the old way (git delta, or
  modification times outside git) and reported stale when that finds a change;
  otherwise it is unknown, never current — re-index once.

## Tools

### `ensure_project`

The current repository, registered and indexed if it needs to be, and its
project id — see [Automatic project registration](#automatic-project-registration)
for the whole lifecycle. It composes existing pieces: `GET /api/projects/resolve`
(as `resolve_project`), the status reading `get_index_status` reports, and
`POST /api/projects/index` (as `index_project`) only when a run is needed.

```
ensure_project({})
  → Registered /work/repo-a with CodeRAG and queued its first indexing run.
       project:   repo-a — projectId: 0b9784ed-…
       status:    indexing
       run:       2d6d7e3e-…
```

**Input**

| Field | Type | Notes |
| --- | --- | --- |
| `rootPath` | string, optional | A repository to ensure instead of the current one. Absolute, or relative to the current project directory. |

**Output** (`structuredContent`)

| Field | Meaning |
| --- | --- |
| `projectId`, `projectName` | The project; pass `projectId` to every other tool |
| `rootPath` | The project's repository root |
| `requestedPath`, `rootSource` | The directory asked about, and where it came from (`argument`, `CLAUDE_PROJECT_DIR`, `CODERAG_PROJECT_DIR`) |
| `action` | `registered` / `started` / `already_indexing` / `up_to_date` / `none` — what this call did |
| `status` | `get_index_status`'s `state` after the call: `ready`, `stale`, `indexing`, `failed`, `never_indexed` |
| `registered`, `projectCreated` | The project is registered; this call created it |
| `indexed`, `indexing`, `indexingJobId`, `indexingStarted` | A graph is stored; a run is active, and which; this call queued it |
| `stale`, `indexedCommit`, `currentCommit`, `changedFiles`, `changedPaths` | Freshness, as `get_index_status` reports it |
| `error`, `reason` | Why the last run failed, when it did; why this call did what it did |

Returns as soon as any run is queued; poll `get_index_status` until `ready`.

**Failures** (`isError: true`): the `PROJECT_ROOT_*` codes above, "could not be
reached — start it with `pnpm dev:all`" when the API is down,
`FILESYSTEM_ACCESS_DISABLED`, and the API's own code for anything else.

### `resolve_project`

Resolves a filesystem path to the indexed projects containing it. It calls
`GET /api/projects/resolve` and holds no resolution logic of its own.

This is the first thing an agent calls and the reason the others can exist:
every other route in the graph API is addressed by a project id, and an agent
starts life holding a working directory instead.

**Input**

| Field | Type | Notes |
| --- | --- | --- |
| `path` | string, required | A directory or a file. Absolute normally; a relative path resolves against the workspace root. Never read, and need not exist. |

**Output** — a text block, and the same facts as `structuredContent`:

```json
{
  "path": "/Users/example/my-app/src/services",
  "matches": [
    {
      "projectId": "892f0987-…",
      "name": "my-app",
      "repositoryRoot": "/Users/example/my-app",
      "relativePath": "src/services",
      "exact": false,
      "nodeCount": 1184,
      "edgeCount": 4102,
      "analysisStatus": "COMPLETED"
    }
  ]
}
```

`relativePath` is the form the other routes speak, so it can be handed straight
to source retrieval or to a search narrowed by file.

The text block is what a model actually reads, so it states what condition each
project is in — `never indexed`, `last indexing run FAILED`, `indexing in
progress`, or a node and edge count — rather than leaving that to be inferred
from a status string. `matches` is ordered by the API, most specific first, and
the text says how to choose: which root is narrower when they are nested, and
which is newer when the same directory was indexed twice.

An empty `matches` is a successful result, not an error. It means nothing
indexed covers that path, and the text says to read the files directly or index
the repository first.

**Failures** come back as `isError: true` with a readable message rather than as
protocol errors, so the model sees them and can act:

- the API refused the request — carries the API's own stable `code`
- the API could not be reached — names the base URL and how to start it
- the response was not this API's envelope — usually a base URL pointing at the
  wrong service

### `get_index_status`

Reports whether a project’s graph is in a state to answer questions, and
whether it still matches the files. It calls
`GET /api/projects/:projectId/analysis` — the existing endpoint that lists a
project’s runs newest first — and, when a graph is stored,
`GET /api/projects/:projectId/freshness`. It adds no state of its own.

Call it after `resolve_project` and before trusting anything the graph says.
Without it an agent has two ways to be confidently wrong: querying a project
that was never indexed and reading "no results" as "no such code", or querying
one mid-re-index and reading a half-written graph as the whole truth.

**Input**

| Field | Type | Notes |
| --- | --- | --- |
| `projectId` | uuid, required | As returned by `resolve_project`. A malformed id is rejected here, without troubling the API. |

**Output** — `state` is the headline, one of five: see
[Index status](#index-status).

`usable` is the other half of the answer, and it is not the same question. The
pipeline replaces a project’s graph in one step at the end of a run, so a
*failed* or *in-flight* run does not remove the previous one: `usable` is true
whenever a completed run has stored a graph that is still there, and
`lastSuccessfulRun` names it. A `failed` project can therefore still answer —
from a graph that predates whatever prompted the run — and the text says so
rather than leaving that to be worked out.

The rest is what changes a decision: `status` (the raw `AnalysisStatus`, so the
four-state simplification hides nothing), `language`, `completedAt`,
`nodeCount` / `edgeCount` as the run recorded them, `error`, and `warningCount`
— files the run could not read or parse. A run completes in spite of those, so
the graph is missing whatever was in them, which is exactly when an *absence*
in the graph should not be read as an absence in the code.

`progress` is present only while a run is in flight, and its percentage comes
from `analysisProgressFraction` in `@ckg/shared` — the same weighting the web
UI’s progress bar uses, rather than a second opinion about the same run. A run
still `QUEUED` 30 seconds after it was created says the worker may not be
running.

Freshness fields, added without changing any of the above:

| Field | Meaning |
| --- | --- |
| `indexed` / `indexing` | A graph is stored / a run is queued or in progress |
| `indexingJobId` | The in-flight run, or null |
| `lastIndexedAt` | When the stored graph was completed |
| `stale` | `true` / `false`, or `null` when undeterminable or no graph |
| `freshness`, `freshnessReason` | `current` / `stale` / `unknown`, and why |
| `indexedCommit`, `currentCommit` | Git HEAD then and now; null outside git |
| `changedFiles`, `changedPaths` | How many files differ, and the first 20 |

If the freshness call fails — an older API without the route, say — the tool
still answers from the run list with `freshness: unknown`.

**Failures** come back as `isError: true`. `PROJECT_NOT_FOUND` gets its own
wording, because it has one obvious cause and one obvious fix: an id that did
not come from `resolve_project`, or one whose project has since been deleted.

### `index_project`

Makes sure a local directory has a current graph. It calls
`POST /api/projects/index`, which composes the existing services: validate the
path as the web intake validates a chosen folder, find the project registered
at exactly that root or create one (`POST /projects` + repository attach), and
queue a run with `AnalysisService.enqueue`, the call the UI makes. The worker
indexes it like any other run. There is no second pipeline.

```
index_project({ "path": "/absolute/path/to/repo" })
  → Registered … as a new project and queued its first indexing run.
       project:   repo — projectId: 0b9784ed-…
       run:       2d6d7e3e-… (QUEUED)
```

**Input**

| Field | Type | Notes |
| --- | --- | --- |
| `path` | string, required | Absolute path to the repository root on the API's machine. Git URLs and relative paths are refused. |
| `force` | boolean, optional | Re-index even if the graph is current. Never duplicates an active run. |

**Outcomes** (`action`)

| Situation | `action` | `jobCreated` |
| --- | --- | --- |
| Directory not registered | `started` (`projectCreated: true`) | true |
| Registered, never indexed / last run failed / stale / freshness unknown | `started` | true |
| A run is already queued or running | `already_indexing` — that run is returned | false |
| Graph matches the files | `up_to_date` (unless `force`) | false |

Two concurrent calls cannot both register the directory or both queue a run:
requests for the same directory are serialised inside the API, so the second
sees the first's project and run and gets them back. If registration succeeds but queuing fails, the new project
is removed again, so a retry starts clean.

It returns as soon as the run is queued. Poll `get_index_status` until
`ready`. If the run stays `QUEUED`, the worker is not running.

Pass the repository root. If `resolve_project` already found an enclosing
project, pass its `repositoryRoot`; a subdirectory becomes a separate project.

**Failures** (`isError: true`), each worded for its fix: `INVALID_PROJECT_PATH`
(relative, a URL, or a file), `DIRECTORY_NOT_FOUND`, `DIRECTORY_NOT_READABLE`,
`FILESYSTEM_ACCESS_DISABLED` (`LOCAL_FILESYSTEM_ENABLED=false`), the API's own
code for anything else, and "could not be reached — start it with
`pnpm dev:all`" when the API is down.

### `search_graph`

Searches one project’s graph for nodes whose name, qualified name or file path
contains a term. It calls `GET /api/projects/:projectId/graph/search` and
performs no search of its own.

**Matching is the API’s and is deliberately literal**: case-insensitive
substring across those three fields, ranked by a fixed ladder so the same term
always produces the same page. There is no embedding, no similarity score and no
interpretation of the query. Search for identifiers you expect to exist —
`UserService`, `user.service.ts`, `src/services`, `POST /users` — not for
concepts: "authentication" finds nothing unless something is literally named
that.

**Input**

| Field | Type | Notes |
| --- | --- | --- |
| `projectId` | uuid, required | From `resolve_project`. No default, and no cross-project search. |
| `query` | string, required | 1–200 characters. A literal substring. |
| `nodeTypes` | string[], optional | Exact node types: `class`, `interface`, `function`, `method`, `variable`, `type`, `enum`, `property`, `file`, `module`, `api`, `table`, `service`, … An unknown type is rejected. |
| `file` | string, optional | Repository-relative **path prefix**: a directory (`src/services`) or a file (`src/services/album.service.ts`). Case-insensitive; not a bare file name. |
| `limit` | integer, optional | 1–50, default 20. |
| `offset` | integer, optional | Skip this many matches, from a previous `nextOffset`. |

`limit` is capped below the API’s own ceiling of 100. These results go into a
model’s context, and fifty nodes is already more than anyone reads before
narrowing the question.

**Filters are the API’s, passed through.** `nodeTypes` and `file` are applied by
the query itself, before paging, so `total` counts what the filters keep and no
match can be hidden behind the first page. Ranking is unchanged; filters only
remove candidates.

**When to filter.** A broad term matches every field, parameter and test helper
that contains it. On Immich, `SharedLink` matches 168 nodes and the service,
controller and repository rank #33–#40. `nodeTypes: ["class"]` returns 12, with
all three in the list. Other common narrowings:

| Question | Call |
| --- | --- |
| "Which modules handle X?" | `query: "X", nodeTypes: ["class"]` |
| "Which routes exist for albums?" | `query: "/albums", nodeTypes: ["api"]` |
| "What is defined in this file?" | `query: "Album", file: "src/services/album.service.ts"` (the query is still required; use a term the names share) |
| "Which tables mention asset?" | `query: "asset", nodeTypes: ["table"]` |

**Output**

```json
{
  "projectId": "892f0987-…",
  "query": "UserService",
  "total": 9,
  "returned": 5,
  "offset": 0,
  "truncated": true,
  "nextOffset": 5,
  "filters": { "nodeTypes": null, "file": null },
  "results": [
    {
      "id": "…",
      "type": "class",
      "name": "UserService",
      "qualifiedName": "UserService",
      "filePath": "src/services/user.service.ts",
      "startLine": 12,
      "endLine": 88
    }
  ]
}
```

`total` is the full match count rather than the page’s, so a caller always knows
what it did not see. `truncated` says the same thing as a boolean, `nextOffset`
continues, and the text block names how many more there are and the offset to
read on from.

The text block is two lines per node — what it is, and where it lives — because
that is what an agent picks from. A node with no file (a table, an event) says so
rather than being given a plausible-looking path.

**An empty result is a successful answer**, never `isError`. The text says what
an empty result does and does not mean: matching is literal, so try a shorter
term — and if the project may not be indexed, `get_index_status` is the tool that
distinguishes "nothing matched" from "nothing was indexed".

**Project isolation.** The id goes in the request *path*, and the API scopes its
SQL by the same id, so there is no request this tool can build that is not
addressed to exactly one project. As a post-condition it also checks that every
node that came back belongs to the project that was asked about; if one did not,
it refuses the whole answer rather than reporting it. That cannot happen while
the API is correct — which is the point of checking: a result set whose project
cannot be trusted is worse than no result set.

**Failures** come back as `isError: true`. `PROJECT_NOT_FOUND` directs the agent
to `resolve_project`; anything else carries the API’s stable code and its
message, and nothing internal.

### `get_node`

Everything the graph knows about one node. It calls
`GET /api/projects/:projectId/graph/nodes/:nodeId` — the endpoint the web
inspector uses — and performs no lookup of its own.

This is where an agent stops matching strings and starts reading structure.

**Input**

| Field | Type | Notes |
| --- | --- | --- |
| `projectId` | uuid, required | From `resolve_project`. |
| `nodeId` | string, required | From `search_graph`, in `results[].id`. |
| `relationship` | enum, optional | Switch to **page mode** for one section: `callers`, `callees`, `references`, `implementations`, `subtypes`, `supertypes`, `dependencies`, `dependents`, `children`, `apis`, `databases`, `documentation`, `contracts`. |
| `limit` | integer, optional | Page size in page mode, 1–100, default 50. |
| `offset` | integer, optional | First entry in page mode, from a previous `nextOffset`. Default 0. |

`projectId` and `nodeId` are required. Node ids happen to be globally unique, but the project stays
explicit: the contract never has an implicit project, and a lookup that carried
one would be a lookup whose scope depended on what happened earlier in the
conversation.

**Output**

```json
{
  "projectId": "2cd2c90a-…",
  "node": {
    "id": "eb245498…", "type": "class", "name": "UserRepository",
    "qualifiedName": "UserRepository",
    "filePath": "src/repositories/user.repository.ts",
    "startLine": 8, "endLine": 64,
    "language": "typescript", "exported": true,
    "role": "repository", "category": "code",
    "signature": null,
    "documentation": ["Persistence for users. …"]
  },
  "relationships": {
    "callers":  { "returned": 20, "total": 67, "hasMore": true, "nextOffset": 20, "items": [ … ] },
    "databases": { "returned": 3, "total": 3, "hasMore": false, "nextOffset": null, "items": [
      { "id": "…", "name": "users", "qualifiedName": "postgresql.users",
        "relationship": "WRITES_TO", "direction": "outgoing",
        "evidence": { "source": "database-analyzer", "confidence": "medium",
                      "method": null, "file": null, "line": 13,
                      "column": null, "matched": null } }
    ] },
    "callees": { … }, "references": { … }, "dependencies": { … },
    "dependents": { … }, "implementations": { … }, "apis": { … },
    "documentation": { … }, "contracts": { … }, "children": { … }
  },
  "parent": { "id": "…", "type": "file", "name": "user.repository.ts", … }
}
```

`signature` and `documentation` come from the node’s own metadata, which the
API’s flattened `symbol` block does not carry — they are the two things worth
reading before opening the file.

**Sections, totals and paging.** Every section carries four facts:

| Field | Meaning |
| --- | --- |
| `total` | The exact size of the section in the graph. `null` only against an API too old to report it; then `returned` is a floor and the text shows `20+`. |
| `returned` | Entries in `items`: at most 20 in the overview. |
| `hasMore` | `total > returned`: the list is **incomplete**. |
| `nextOffset` | Where page mode continues, or `null` when nothing remains. |

The overview's text lists up to 10 entries per section — callers, callees,
references, implementations and inheritance (`← EXTENDS` / `→ IMPLEMENTS`),
members, and the architectural links with their evidence — and, whenever a list
is cut, says so with the exact remainder and the call that reads it:

```
callers: 67   references: 8   implementations: 52
(exact totals)
…
  … showing 10 of 52; 42 more — get_node with relationship "implementations", offset 10
```

**Page mode** reads one section from its own route (`/graph/nodes/:id/<section>`,
which reports `meta.total`) and returns `page: { relationship, total, offset,
limit, returned, hasMore, nextOffset, items }`. Its text ends with either
`Incomplete: N more. Next page: …, offset K.` or `Complete: this is the end of …`.
`subtypes` is what implements or extends the node; `supertypes` is what it
implements or extends; `implementations` is both.

**When to page.** The overview is enough to understand a node and pick what to
open next. Page when the question needs the whole set:

| Question | Call |
| --- | --- |
| "Every class that extends `BaseService`" | `relationship: "subtypes", limit: 100` (51 on Immich, one call) |
| "Everything that calls `getById` before I change it" | `relationship: "callers"` until `nextOffset` is null |
| "All code that reads or writes table X" | `get_node` on the table, then `relationship: "databases"` |

Every section is present even when empty, so a consumer need not branch on
absence.

**Evidence is preserved whole** — `source`, `confidence`, `method`, `file`,
`line`, `column`, `matched` — not reduced to a relationship name. "A `WRITES_TO`
B" is an assertion, and the file and line that produced it are what let it be
checked. The text block renders the architectural links with their evidence for
exactly that reason.

**Project isolation.** Both ids go in the request path and the API scopes its
SQL by the project, so a node id from another project reads as *not found* here
rather than being found. As a post-condition the tool also checks the project id
of the node **and every neighbour** in the response; if any disagrees, it
refuses the whole response rather than pruning it — a backend invariant
violation, not a filtering decision.

**Failures** come back as `isError: true`. A missing node says so and stops:
there is no fallback lookup in another project and no automatic `search_graph`.
`PROJECT_NOT_FOUND` directs the agent to `resolve_project`; anything else
carries the API’s stable code and nothing internal.

### `trace_path`

The shortest route between two nodes in one project — "how does this controller
reach that table". It calls `POST /api/projects/:projectId/graph/path` and does
no traversal of its own.

This is the question `get_node` cannot answer in one call. An agent *could* walk
it by hand, one `get_node` at a time, rebuilding the graph in its own context
and guessing which neighbour to follow; this asks the server, which already
knows, and gets the shortest route rather than the first one that worked.

**A worked example**

```
search_graph(projectId, "UserController")   →  results[0].id  =  19380d2d…
search_graph(projectId, "users")            →  the table node =  8a45bd92…

trace_path(projectId, "19380d2d…", "8a45bd92…")
```

```
Path found: UserController → UserService → UserRepository → postgresql.users

Length: 3 edges

1. UserController  [class]
   src/controllers/user.controller.ts:8

   ↓ CALLS — graph-builder/medium, no location recorded

2. UserService  [class]
   src/services/user.service.ts:21

   ↓ CALLS — graph-builder/medium, no location recorded

3. UserRepository  [class]
   src/repositories/user.repository.ts:8

   ↓ READS_FROM — database-analyzer/medium, line 23

4. postgresql.users  [table]
   no file — this node was derived, not read from source
```

**Input**

| Field | Type | Notes |
| --- | --- | --- |
| `projectId` | uuid, required | From `resolve_project`. Both nodes must belong to it. |
| `fromNodeId` | string, required | Where the route starts. |
| `toNodeId` | string, required | Where the route ends. |
| `maxDepth` | integer, optional | 1–12, default 6. The API’s own range. |

**Output** carries `found`, `depth`, `nodes` (in order), `steps` (the edges
crossed, where `steps[i]` leaves `nodes[i]`), `relationships` (the distinct set
in order of first use — the shape of the trace), plus `undirected`, `truncated`
and `maxDepth`.

**Three answers that are not the same thing.** This is the distinction the tool
exists to keep straight, and an agent that collapsed them would report an
absence the graph never claimed:

| Situation | Result |
| --- | --- |
| A route exists | `found: true` with the nodes and steps |
| Both nodes exist, nothing connects them | `found: false`, **not an error**, and the text says which hop limit that is a statement about |
| The search ran out of its node budget | `found: false` with `truncated: true` — *could not tell*, explicitly not "no route exists" |
| Either endpoint is not a node in this project | `isError: true` |

**`undirected`** means no directed route existed, so the search ignored
direction to find one. Two pieces of code can be genuinely related without one
reaching the other, and the tool says which it found rather than presenting an
undirected route as a flow.

**Bounded by construction.** `maxDepth` caps the route at 12 hops, so a response
is at most 13 nodes and 12 steps — there is nothing here to truncate, and the
tool asks for no more than the API’s own default unless told to.

**Evidence** is preserved per hop, through the same shared renderer `get_node`
uses, so the same edge reads the same way in both tools — including the case
where an analyzer recorded a line but no file, which prints `line 23` rather
than "no location recorded".

**Project isolation.** The project is in the path and both node ids are in the
body; the API resolves each id *within that project* before searching, so a node
id from elsewhere is a not-found rather than a quietly different route. Two
post-conditions then run before anything is reported: every node **and every
edge** must belong to the requested project, and the route must actually start
at `fromNodeId` and end at `toNodeId`. Either failing refuses the whole response
— a route that is subtly not the one that was asked for is worse than no route,
because an agent would act on it with no reason to doubt it.

### `search_code`

Finds literal occurrences of a string in one project’s source files. It calls
`GET /api/projects/:projectId/code/search` and does no searching of its own —
which files are walked, how they are read and what is skipped all live behind
that endpoint (see [api.md](api.md#code-search)).

Reach for it when `search_graph` finds nothing. The graph holds names the
indexer recorded; this reaches comments, template literals, configuration
values, and languages the indexer cannot parse.

**Semantics — literal and case-sensitive.** Not a regular expression, not a
glob, not semantic. `obj.method(arg)` matches those fifteen characters;
`UserRepository` does not match `userRepository`. The query is forwarded
**unchanged** — not trimmed, not lower-cased, not escaped — so leading and
trailing whitespace are part of the term.

**Input**

| Field | Type | Notes |
| --- | --- | --- |
| `projectId` | uuid, required | From `resolve_project`. |
| `query` | string, required | 1–200 characters. A literal string. |
| `limit` | integer, optional | 1–50, default 20. Capped below the API’s own 100. |

**Output**

```json
{
  "projectId": "2cd2c90a…",
  "query": "UserRepository",
  "results": [
    {
      "filePath": "src/app.ts",
      "line": 8,
      "column": 9,
      "match": "UserRepository",
      "lineText": "import { UserRepository } from './repositories/user.repository.js';",
      "lineTruncated": false
    }
  ],
  "meta": {
    "total": 8, "limit": 20, "truncated": false,
    "filesSearched": 19, "filesSkipped": 0, "scanTruncated": false
  }
}
```

`line` is 1-based and `column` is 0-based, exactly as the API reports them and
as `startCharacter` works everywhere else in this graph — neither is shifted
here. One entry per occurrence, ordered by file path, then line, then column;
nothing is deduplicated, merged by line or re-sorted.

**Two kinds of incompleteness, which are not the same thing.** This is the
distinction the tool exists to keep straight:

| | Means | The text says |
| --- | --- | --- |
| `truncated: true` | The search **completed**; more matches exist than were returned | `Showing 20 of 53 matches.` |
| `scanTruncated: true` | The walk **stopped early** — `total` is a floor, not a count | `Showing 20 matches. The repository scan was truncated, so more matches may exist beyond the 53 counted.` |

The tool never says "of 53" when the scan was truncated, because the shortfall
is unknown. `filesSkipped` above zero means files were passed over for exceeding
the backend’s size limit, and is reported with its count for the same reason —
an agent deciding whether an absence is meaningful needs to know what was not
looked at. An empty result whose scan was incomplete says so explicitly rather
than reading as proof the string is absent.

**An empty result is a successful answer**, never `isError`, and the text points
at `search_graph` in case a symbol rather than a string was wanted.

**Source unavailable is not an empty result.** A repository indexed from a git
URL keeps no source on disk, so the API refuses with `SOURCE_NOT_READABLE` and
the tool reports that plainly. There is no fallback to graph search: the two
answer different questions, and quietly substituting one would be worse than
saying so.

**Project isolation.** The project is in the request path and the API resolves
the source root from the project’s own repository record, never from the
request. A code match carries only a repository-relative path and no project
identity, so there is nothing per-result to cross-check and none is invented;
what *is* checked is that the response answers the query that was asked — a
mismatch refuses the whole response.

### `get_source`

Reads a window of one file from an indexed project. It calls
`GET /api/projects/:projectId/source`, which is the one place in this system
that opens a file.

This is the end of every other tool’s sentence. `search_code` gives a file and
a line, `get_node` gives a file and a range, `trace_path` gives a chain of both
— and each stops at a coordinate.

**A worked example**

```
search_code(projectId, "class UserRepository")
  → src/repositories/user.repository.ts:8:7

get_source(projectId, "src/repositories/user.repository.ts", 6, 14)
```

```
src/repositories/user.repository.ts  (lines 6-14 of 55, typescript)

 6 |  * lets an analyzer say which table each method touches.
 7 |  */
 8 | export class UserRepository {
 9 |   constructor(private readonly pool: Pool) {}
10 |
11 |   async create(input: CreateUserInput): Promise<User> {
```

The gutter is not decoration. A model that has just read lines 6 to 14 needs to
be able to say "line 8" and mean the line the file means, and a bare block of
code makes that a counting exercise it will get wrong.

**Input**

| Field | Type | Notes |
| --- | --- | --- |
| `projectId` | uuid, required | From `resolve_project`. |
| `file` | string, required | Repository-relative, exactly as another tool reported it. |
| `startLine` | integer, optional | 1-based, inclusive. Defaults to the start of the file. |
| `endLine` | integer, optional | Inclusive. Defaults to the end of the file. |

Everything is forwarded to the API unchanged. The path is not normalised here
and the range is not adjusted — a window this layer widened would be a window
the caller did not ask for, and whether a path is acceptable is the API’s
judgement, made in one place.

**Pass a range.** With neither bound the whole file comes back, capped at 2000
lines by the API, which reports `truncated` and `totalLines` so a caller always
knows what it did not read.

**Not exposed:** `nodeId` and `context`. The API supports both, but `context`
only widens a range that came from a `nodeId`’s indexed span — in the file-based
flow the API ignores it — so exposing it would be a parameter that silently
does nothing.

**Output** carries `file`, `language`, `startLine`, `endLine`, `totalLines`,
`truncated` and the numbered `lines`. `highlight` is omitted: it is only ever
populated from a `nodeId`, so in this flow it is always null.

**The response is checked, not trusted.** It is parsed against the API’s own
`sourceSchema` before anything is reported, and a body that does not match is
refused. Malformed content reaching a model *as source code* is the one wrong
answer here that would be acted on without question.

**Path safety is the API’s, and is not weakened here.** `../../etc/passwd`,
`/etc/passwd`, a NUL byte and a symlink out of the tree are all refused on the
other side of the boundary, and this tool reports the refusal with the API’s own
code rather than retrying or guessing at a different path. Each failure keeps
its own meaning: a refused path is a mistake in the request, an unreadable
source is a property of the project, a missing file is neither, and none of them
is "the file is empty".

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `claude mcp get code-graph` says *Pending approval* | Run `claude` in the repository and approve it; `claude mcp reset-project-choices` re-asks |
| Server fails to connect; `Cannot find module …/apps/mcp/dist/server.js` | Not built: `pnpm dev:all` or `pnpm build:packages` |
| Server fails with `does not provide an export named …` | Stale build after pulling: `pnpm build:packages` |
| Every tool: *could not be reached* | API not running, or on another port: `pnpm dev:all`, or set `MCP_API_BASE_URL` |
| Run stays `QUEUED`; status says the worker may not be running | Start the worker: `pnpm dev:all` (or `pnpm dev:worker`) |
| `dev:all`: *port … is already in use* | Another `pnpm dev` / `dev:api` / `dev:web` is running. Stop it, or set `PORT`. `dev:all` refuses rather than start beside it. `tsx watch` would otherwise hide the crashed duplicate |
| `dev:all`: *Is Docker running?* | Start Docker Desktop, or run PostgreSQL yourself and point `DATABASE_URL` at it |
| `dev:all`: POSTGRES_PORT and DATABASE_URL disagree | Make the compose port and the URL's port the same in `.env` |
| `stale: null`, reason mentions *before source revisions were recorded* | Graph predates freshness tracking: `index_project` with `force: true` once |
| `index_project`: `FILESYSTEM_ACCESS_DISABLED` | The API has `LOCAL_FILESYSTEM_ENABLED=false`; local indexing needs it on |
| `ensure_project`: `PROJECT_ROOT_UNDETERMINED` | The client did not set `CLAUDE_PROJECT_DIR` (a non-Claude client, or an old Claude Code): pass `rootPath`, or set `CODERAG_PROJECT_DIR` in the server's config |
| `ensure_project`: `PROJECT_ROOT_NOT_A_PROJECT` | The session was opened in a folder with no `.git` or manifest: open the repository root, or pass `rootPath` |
| `ensure_project` returns `none` with a failed run | Not retried automatically: fix the cause (see `error`), then `index_project` |
| `search_graph` finds nothing for code you just wrote | Graph is stale or the file is new: check `get_index_status`, use `search_code`, or re-index |

## Adding a tool

One file under `src/tools/`, registered in `createMcpServer`. It should be a
schema, a call through `ApiClient`, and a rendering. If you find yourself
wanting to join two API calls or filter a result set, that logic belongs behind
a route in `apps/api` where the UI and the benchmark can reach it too.

`ensure_project` is the one deliberate exception: it sequences three existing
calls because the readiness vocabulary it decides from (`ready`, `stale`, …) is
computed by `get_index_status` in this app, and a second copy of that behind a
route would be a second status implementation. Its only decision of its own is
whether to call `POST /api/projects/index`; registration, deduplication and
freshness stay in the API.
