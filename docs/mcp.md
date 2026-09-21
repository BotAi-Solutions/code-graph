# MCP

`apps/mcp` exposes the repository knowledge graph to a local MCP client — an
agent, an editor, a CLI — over stdio.

It is an **adapter and nothing else**. It speaks MCP on one side and the
existing HTTP API on the other:

```
MCP client ──stdio──▶ apps/mcp ──HTTP──▶ apps/api ──▶ services ──▶ PostgreSQL
```

A tool is a schema, a request and a rendering. No tool queries the database, and
the app has no database credentials to query it with — `apps/mcp` depends on
`@ckg/shared` and the MCP SDK, and on nothing else in the workspace. That is
structural rather than a convention: if a question cannot be answered through
the HTTP API, the answer is a new API route, not a second path into the data.

## Running it

The API must be running; the MCP server reads the graph through it.

```bash
pnpm dev:api          # the MCP server has nothing to talk to without this
```

An MCP client launches the server process itself. Point it at the entry file:

```json
{
  "mcpServers": {
    "code-graph": {
      "command": "npx",
      "args": ["tsx", "apps/mcp/src/server.ts"],
      "cwd": "/absolute/path/to/code-graph"
    }
  }
}
```

Or, after `pnpm build`:

```json
{
  "mcpServers": {
    "code-graph": {
      "command": "node",
      "args": ["/absolute/path/to/code-graph/apps/mcp/dist/server.js"]
    }
  }
}
```

`pnpm dev:mcp` runs it in watch mode against your terminal's stdin, which is
useful for seeing it start and little else — the protocol expects a client on
the other end.

## Configuration

Two variables, both optional, read from the workspace `.env` like everything
else.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_API_BASE_URL` | `http://localhost:${PORT}` | Where the API is |
| `MCP_REQUEST_TIMEOUT_MS` | `15000` | Ceiling on one call to the API |

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

Three tools, and they are meant to be used in this order:

```
resolve_project(path)             a working directory  →  a projectId
        ↓
get_index_status(projectId)       can that project answer anything?
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
2. Take the project id from the match that fits.
3. Verify the index status before trusting anything the graph says.
4. Search for nodes relevant to the question.
5. Pick a node id from the results.
6. Retrieve that node’s detail.
7. Use its relationships and their evidence to decide what to inspect next —
   another `get_node` on a neighbour, or a `trace_path` between two nodes that
   both matter to the question.

Each step exists because the next one cannot be trusted without it:

- **`resolve_project`** converts a filesystem path into an indexed project.
  Everything else in the graph API is addressed by a project id, and an agent
  starts life holding a directory instead.
- **`get_index_status`** says whether that project’s graph is usable — ready,
  still indexing, failed, or never indexed. Skipping it is how an empty search
  result gets misread as "this code does not exist".
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

## Tools

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

Reports whether a project’s graph is in a state to answer questions. It calls
`GET /api/projects/:projectId/analysis` — the existing endpoint that lists a
project’s runs newest first — and adds no state of its own.

Call it after `resolve_project` and before trusting anything the graph says.
Without it an agent has two ways to be confidently wrong: querying a project
that was never indexed and reading "no results" as "no such code", or querying
one mid-re-index and reading a half-written graph as the whole truth.

**Input**

| Field | Type | Notes |
| --- | --- | --- |
| `projectId` | uuid, required | As returned by `resolve_project`. A malformed id is rejected here, without troubling the API. |

**Output** — `state` is the headline, and there are four because there are four
different things to do next:

| `state` | Means | Do |
| --- | --- | --- |
| `ready` | The most recent run completed | Ask away |
| `indexing` | A run is in flight | Wait and retry; `progress` says how far |
| `failed` | The most recent run failed | Do not trust the graph; `error` says why |
| `never_indexed` | There has never been a run | Nothing to query — read files, or index first |

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
UI’s progress bar uses, rather than a second opinion about the same run.

**Failures** come back as `isError: true`. `PROJECT_NOT_FOUND` gets its own
wording, because it has one obvious cause and one obvious fix: an id that did
not come from `resolve_project`, or one whose project has since been deleted.

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
| `limit` | integer, optional | 1–50, default 20. |

`limit` is capped below the API’s own ceiling of 100. These results go into a
model’s context, and fifty nodes is already more than anyone reads before
narrowing the question.

**Output**

```json
{
  "projectId": "892f0987-…",
  "query": "UserService",
  "total": 9,
  "returned": 5,
  "truncated": true,
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
what it did not see; `truncated` says the same thing as a boolean, and the text
block names how many more there are.

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

Both are required. Node ids happen to be globally unique, but the project stays
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
    "callers":  { "returned": 1, "hasMore": false, "items": [ … ] },
    "databases": { "returned": 3, "hasMore": false, "items": [
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

**Bounding.** The API applies a `limit` per relationship section and defaults to
100, which is right for a panel someone scrolls and wrong for a model’s context:
a hub node would arrive as a thousand neighbours across eleven sections. The
tool asks for **21 per section and keeps 20**.

That extra one is the point. The node-detail endpoint reports **no totals**, so
asking for exactly twenty would make a section of twenty indistinguishable from
a section of two hundred. Asking for one more makes `hasMore` a fact:

```
callers: 20+   references: 5   databases: 3
(a "+" means more than 20 exist; the number shown is a floor)
```

So `returned` is never mistakable for a total. Every section is present even
when empty, so a consumer need not branch on absence.

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

## Adding a tool

One file under `src/tools/`, registered in `createMcpServer`. It should be a
schema, a call through `ApiClient`, and a rendering. If you find yourself
wanting to join two API calls or filter a result set, that logic belongs behind
a route in `apps/api` where the UI and the benchmark can reach it too.
