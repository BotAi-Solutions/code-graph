# CodeRAG Retrieval Evaluation — Baseline Report

```text
Version:          Baseline v0.1
Evaluation type:  Deterministic retrieval evaluation
Generated:        2026-09-22
Run timestamp:    2026-09-22T07:21:12.473Z
Commit:           f6060ac
```

This report records what the retrieval interface could and could not retrieve on
the date above. It is a baseline measurement, not a benchmark result and not a
statement about answer quality. Nothing was changed to improve it.

**Sections 1–19 and Appendix A–B are the historical baseline and are left as
they were measured.** The defect they identify was subsequently fixed; see
[§20 Post-Fix Validation](#20-post-fix-validation) for the re-measured result.

The system under evaluation is described in
[docs/retrieval-evaluation.md](retrieval-evaluation.md); this document describes
the results of running it.

---

## 1. Executive summary

| Metric | Result |
| --- | ---: |
| Total cases | 49 |
| Passed | 45 |
| Partial | 0 |
| Failed | 4 |
| Pass rate | 91.8% |

Pass rate is `passed / total × 100` = `45 / 49 × 100` = 91.8% (1 d.p.).

**The four failures are one defect, not four.** Every one of them is a question
asked *from* an architectural node — an `api`, `queue`, `event` or `table` — and
every one of them fails in the same way: `get_node` returns an empty
relationship section although the edge the question depends on is present in the
graph and is returned by a depth-1 traversal of the very same node.

> The underlying graph contains the relationships. `get_node` does not project
> them onto the result when the architectural node is the starting node.

The asymmetry is exact and is demonstrated by passing cases in the same dataset:
`get_node("UserService")` returns `PUBLISHES → welcome-emails` and passes, while
`get_node("welcome-emails")` returns nothing and fails — the same edge, read from
the other end. This is a **retrieval directionality gap in node-detail
assembly**, not a missing edge, and not four independent retrieval defects.

---

## 2. System under evaluation

The evaluation exercises the **public retrieval interface** over HTTP. It
imports no production internals — no graph repository, no source service, no
scanner — so what it measures is what any other consumer of the interface gets.

| Capability | HTTP endpoint | Purpose |
| --- | --- | --- |
| `search_code` | `GET /api/projects/:id/code/search` | Deterministic literal source-text retrieval |
| `search_graph` | `GET /api/projects/:id/graph/search` | Symbol / node discovery |
| `get_source` | `GET /api/projects/:id/source` | Bounded source retrieval |
| `get_node` | `GET /api/projects/:id/graph/nodes/:nodeId` | Node metadata, relationships and evidence |
| `trace_path` | `POST /api/projects/:id/graph/path` | Graph path discovery between two nodes |

The capability names are the MCP tool names. Each MCP tool is a thin wrapper
over exactly the endpoint in the middle column and adds no retrieval of its own
(see [apps/mcp/src/tools/](../apps/mcp/src/tools/)), so a finding about these
endpoints is a finding about the agent-facing surface as well.

Graph construction, SCIP indexing, the analyzers and the worker pipeline are
**not** under evaluation here. They are measured separately by `@ckg/benchmark`.

---

## 3. Evaluation architecture

```mermaid
flowchart TD
    A[Evaluation Dataset] --> B[Retrieval Evaluation Runner]

    B --> C[search_code]
    B --> D[search_graph]
    B --> E[get_source]
    B --> F[get_node]
    B --> G[trace_path]

    C --> H[Actual Retrieved Evidence]
    D --> H
    E --> H
    F --> H
    G --> H

    H --> I[Deterministic Comparison]
    J[Expected Evidence] --> I

    I --> K[PASS / PARTIAL / FAIL]
```

Each case names the retrieval calls to make and the evidence those calls must
produce. The runner makes exactly the calls the case names — no more — collects
what came back, and compares it against the expected evidence by identity. The
verdict is derived from the per-check results, not from a score.

---

## 4. Methodology

### 4.1 Dataset

49 cases across three indexed fixture repositories.

### 4.2 Evidence-based evaluation

The evaluator does not read, generate or judge a natural-language answer. It
verifies concrete retrieved evidence:

| Evidence kind | Passes when |
| --- | --- |
| `files` | Every expected repository-relative path appears among the code-search results |
| `nodes` | Every expected qualified name appears among the retrieved nodes |
| `relationships` | The relationship **type and both endpoints** came back |
| `path` | The node sequence matches exactly, in order |
| `noPath` | A bounded search reported no route — and was not truncated |
| `sourceMatches` | The file and line were located, and `contains` is present in the retrieved window |

### 4.3 Deterministic comparison

Every comparison is an identity check
([packages/retrieval-eval/src/match.ts](../packages/retrieval-eval/src/match.ts)).
There is no LLM judge, no embedding, no vector search, no semantic similarity
and no fuzzy or case-normalising match anywhere in the loop. Two runs over the
same graph produce the same report.

Specific consequences of that strictness, each covered by a test:

- Files are compared as whole paths, not suffixes, because `user.repository.ts`
  exists in three fixtures.
- A relationship needs all three parts. "`UserRepository` is connected to
  `postgresql.users` somehow" does not satisfy "`UserRepository READS_FROM
  postgresql.users`".
- A path is the exact ordered sequence. Reaching the right destination through
  the wrong middle is a wrong answer and reads as one.
- A node search for `UserService` does not accept `UserService.create` as a
  match.

### 4.4 Project isolation

Every case names a fixture by directory, never a project id — ids differ per
database. The runner resolves the fixture once through
`GET /api/projects/resolve` and every request for that case carries only the
project id that resolution returned. A node, file or edge from another project
cannot satisfy a case, and the dataset is tested to contain no hard-coded UUID.

### 4.5 Projects scored in this run

| Fixture | Resolved project | Project id | Nodes | Cases |
| --- | --- | --- | ---: | ---: |
| `express-postgres-sample` | `express-sample` | `2cd2c90a…` | 114 | 35 |
| `repository-knowledge-sample` | `rkg-e2e` | `d0852899…` | 126 | 10 |
| `typescript-sample` | `ts-sample` | `2b1a938a…` | 79 | 4 |

---

## 5. Dataset composition and results by category

Counts are taken from the run's own aggregation, in the category vocabulary's
declared order. Only categories actually present in the dataset are listed.

| Category | Cases | Passed | Partial | Failed |
| --- | ---: | ---: | ---: | ---: |
| `symbol_lookup` | 5 | 5 | 0 | 0 |
| `code_lookup` | 5 | 5 | 0 | 0 |
| `call_relationship` | 5 | 5 | 0 | 0 |
| `dependency` | 3 | 3 | 0 | 0 |
| `database_access` | 5 | 4 | 0 | 1 |
| `implementation` | 2 | 2 | 0 | 0 |
| `cross_file_flow` | 4 | 4 | 0 | 0 |
| `architecture` | 10 | 7 | 0 | 3 |
| `source_context` | 3 | 3 | 0 | 0 |
| `trace_path` | 4 | 4 | 0 | 0 |
| `documentation` | 3 | 3 | 0 | 0 |
| **Total** | **49** | **45** | **0** | **4** |

The failures are concentrated in two categories, and that concentration is
itself a symptom rather than a cause: `architecture` and `database_access` are
the only categories that contain cases probing an architectural node directly.

---

## 6. Overall results

| Metric | Result |
| --- | ---: |
| Total cases | 49 |
| Passed | 45 |
| Partial | 0 |
| Failed | 4 |
| Pass rate | 91.8% |

Zero partial results is worth noting. `partial` means some expected evidence was
retrieved and some was not. Each of the four failures has exactly one check, and
that check retrieved none of the evidence it expected, so each scores `fail`
rather than `partial`.

---

## 7. How to read the pass rate

> This percentage represents performance on the current evaluation dataset and
> its retrieval assertions. It is not a general benchmark of code intelligence,
> repository understanding, or RAG quality.

The dataset is:

- **project-specific** — three fixture repositories, all TypeScript, indexed on
  one machine;
- **deterministic** — identity comparisons only, so it measures retrieval, not
  interpretation;
- **relatively small** — 49 cases, 35 of which use a single fixture;
- **manually constructed** — every expectation was read out of the running API
  by a person before it was written down;
- **evidence-oriented** — it asks whether facts can be retrieved, not whether an
  answer built from them would be good.

A 91.8% pass rate is therefore a **baseline for this dataset**, useful for
detecting change between runs and for naming what is missing. It is not an
industry benchmark figure and should not be compared with one.

---

## 8. Failure analysis

All four failures are reproduced below from the evaluator's own output. Each
question is quoted exactly as the dataset asks it.

### 8.1 `arch-route-to-controller` — API route relationship

```text
Question: Which controller serves POST /users?
Probe:    get_node("POST /users")
Category: architecture     Fixture: express-postgres-sample

Expected:   POST /users  ──ROUTES_TO──>  UserController
Retrieved:  POST /users  ──CONTAINS──>   src/api/user.routes.ts
```

Only the containment relationship to the owning file came back. The
`ROUTES_TO` edge did not.

### 8.2 `arch-queue-consumer` — queue publishing

```text
Question: What publishes to, or consumes, the welcome-emails queue?
Probe:    get_node("welcome-emails")
Category: architecture     Fixture: express-postgres-sample

Expected:   UserService  ──PUBLISHES──>  welcome-emails
Retrieved:  nothing
```

Every relationship section on the queue node is empty.

### 8.3 `arch-event-subscribers` — event publishing

```text
Question: What publishes the user.created event?
Probe:    get_node("user.created")
Category: architecture     Fixture: express-postgres-sample

Expected:   UserService  ──PUBLISHES──>  user.created
Retrieved:  nothing
```

Every relationship section on the event node is empty. This case shares its
question text with the passing case `arch-event-publisher`; the two differ only
in which node the retrieval starts from, which is precisely the point.

### 8.4 `arch-who-reads-the-table` — database table reader

```text
Question: What reads from the users table?
Probe:    get_node("postgresql.users")
Category: database_access  Fixture: express-postgres-sample

Expected:   UserRepository  ──READS_FROM──>  postgresql.users
Retrieved:  postgresql.users  ──CONTAINS──>  postgresql
```

Only the containment relationship to the parent database came back.

### 8.5 The shared shape

| Failing case | Probe node | Node type | Missing relationship |
| --- | --- | --- | --- |
| `arch-route-to-controller` | `POST /users` | `api` | `ROUTES_TO` |
| `arch-queue-consumer` | `welcome-emails` | `queue` | `PUBLISHES` |
| `arch-event-subscribers` | `user.created` | `event` | `PUBLISHES` |
| `arch-who-reads-the-table` | `postgresql.users` | `table` | `READS_FROM` |

Four node types, three relationship types, one failure mode: a relationship
whose *other* endpoint is a code node is not projected onto an architectural
node's detail.

---

## 9. Root cause analysis

### 9.1 Symptom versus cause

The symptom is four failing assertions about missing relationships. The cause is
a single bucketing rule in node-detail assembly.

```text
Graph traversal                     get_node(architectural node)
      ↓                                       ↓
 edge is read                           edge is read
      ↓                                       ↓
 edge is returned                    relationship projection
      ↓                                       ↓
   ✓ present                         no bucket accepts it
                                              ↓
                                       empty sections
```

The edge is read from the database in both paths. It is discarded in one of
them.

### 9.2 Where

`getNodeDetail` ([apps/api/src/modules/graph/graph.service.ts:244](../apps/api/src/modules/graph/graph.service.ts#L244))
assembles its result from four store reads, the largest being
`nodeRelations` ([packages/database/src/repositories/graph.repository.ts:643](../packages/database/src/repositories/graph.repository.ts#L643)).

That query is direction-neutral. It reads both directions in one statement —
`source_node_id = $2` UNION ALL `target_node_id = $2` — so the incoming
`UserService PUBLISHES welcome-emails` row **is fetched** when the subject is
`welcome-emails`. The loss happens afterwards, when rows are assigned to
sections:

```ts
// packages/database/src/repositories/graph.repository.ts:708
if (API_RELATIONSHIPS.includes(relationship) && related.type === 'api') { … }

// packages/database/src/repositories/graph.repository.ts:713
if (DATA_RELATIONSHIPS.includes(relationship) && DATA_NODE_TYPES.includes(related.type)) { … }
```

Both predicates test `related.type` — the type of the node at the **other** end
of the edge. The sections are named from a code node's point of view: `apis` is
"which APIs reach this node", `databases` is "which data stores does this node
touch". That framing holds when the subject is a class or a method, and inverts
when the subject is the API or the data store itself:

| Subject | Other endpoint | `related.type` | Predicate | Outcome |
| --- | --- | --- | --- | --- |
| `UserRepository` (class) | `postgresql.users` | `table` | `DATA_NODE_TYPES` ✓ | bucketed into `databases` |
| `postgresql.users` (table) | `UserRepository` | `class` | `DATA_NODE_TYPES` ✗ | falls through |
| `UserService` (class) | `welcome-emails` | `queue` | `DATA_NODE_TYPES` ✓ | bucketed into `databases` |
| `welcome-emails` (queue) | `UserService` | `class` | `DATA_NODE_TYPES` ✗ | falls through |
| `POST /users` (api) | `UserController` | `class` | `related.type === 'api'` ✗ | falls through |

A row that falls through every bucket is dropped. There is no fallback: the last
predicate tests `DEPENDENCY_RELATIONSHIPS`, which is `DEPENDS_ON`,
`DEPENDS_ON_SERVICE`, `IMPORTS`, `USES` — and contains none of `ROUTES_TO`,
`READS_FROM`, `WRITES_TO`, `PUBLISHES` or `SUBSCRIBES`.

This is a **projection gap**: the retrieval read the right data and then failed
to place it in the response.

---

## 10. Graph data versus node detail — direct evidence

The claim that the data is present was verified against the same running API and
the same project, outside the evaluator.

### 10.1 `POST /users`

```text
GET /api/projects/2cd2c90a…/graph?rootNodeId=ceda611d98159eac3409ae92e805a02b&depth=1
```

```text
src/api/user.routes.ts [file]  --CONTAINS-->    POST /users [api]
POST /users [api]              --ROUTES_TO-->   UserController [class]
POST /users [api]              --ROUTES_TO-->   UserController.create [method]
src/api/user.routes.ts [file]  --REFERENCES-->  UserController [class]
UserController [class]         --CONTAINS-->    UserController.create [method]
```

```text
GET /api/projects/2cd2c90a…/graph/nodes/ceda611d98159eac3409ae92e805a02b
```

```text
callers []   callees []   references []   dependencies []   dependents []
apis    []   databases []  documentation []  contracts []   implementations []
children []  parent src/api/user.routes.ts
```

### 10.2 The other three, same method

| Node | Depth-1 traversal returns | `get_node` returns |
| --- | --- | --- |
| `welcome-emails` | `UserService PUBLISHES welcome-emails`, `UserService.welcomeQueue PUBLISHES welcome-emails`, `startWelcomeEmailWorker SUBSCRIBES welcome-emails` | every section empty |
| `user.created` | `UserService PUBLISHES user.created`, `UserService.create PUBLISHES user.created`, `registerUserCreatedListener SUBSCRIBES user.created` | every section empty |
| `postgresql.users` | `UserRepository READS_FROM`, `WRITES_TO`, plus five method-level `READS_FROM`/`WRITES_TO` edges | `parent: postgresql` only |

### 10.3 Conclusion

```text
Graph data exists                    ✓
Graph traversal works                ✓
Node-detail relationship assembly    ✗
```

The defect is in node-detail assembly. No graph edge is missing.

### 10.4 Counterexample — the gap is specific, not universal

An architectural node *can* carry relationship sections. In
`repository-knowledge-sample`, `get_node("postgresql.users")` returns:

```text
children    postgresql.users.id, .email, .display_name, .role,
            .verified_at, .created_at, .last_seen_at        (7 columns)
contracts   DEFINES → database/migrations/0001_create_users.sql
            DEFINES → database/migrations/0002_add_last_seen.sql
references  postgresql.sessions
databases   (empty)
```

```text
table  ──CONTAINS──>  columns      ✓ retrievable
migration ──DEFINES──> table       ✓ retrievable
repository ──READS_FROM──> table   ✗ not retrievable from the table
```

This is consistent with the root cause and confirms it. `children` is fetched by
a separate query that is not part of the bucketing, and the `contracts` and
`documentation` predicates
([graph.repository.ts:718](../packages/database/src/repositories/graph.repository.ts#L718),
[:723](../packages/database/src/repositories/graph.repository.ts#L723)) carry
**no node-type guard** at all — so a `DEFINES` edge from a migration file lands
in its section regardless of which end the subject is.

The failure is therefore specific to the two type-guarded buckets, `apis` and
`databases`, not a universal limitation of architectural nodes.

The same node also shows the gap reproducing outside the fixture the failing
cases use. A depth-1 traversal of `postgresql.users` in
`repository-knowledge-sample` returns `UserRepository READS_FROM postgresql.users`
and `UserRepository.create WRITES_TO postgresql.users`, yet the `databases`
section of its node detail is empty — the same edges, the same emptiness, a
different repository. The defect is a property of node-detail assembly, not of
`express-postgres-sample`. No dataset case asserts this, so it is reported here
as direct observation rather than as a measured failure.

---

## 11. Directionality analysis

The same edge is retrievable from one end and not the other. Each direction is
confirmed by a case in this run.

```text
UserRepository  ──READS_FROM──>  postgresql.users
```

```text
get_node("UserRepository")            get_node("postgresql.users")
        ↓                                      ↓
 databases: READS_FROM →              databases: (empty)
            postgresql.users
        ↓                                      ↓
 db-user-repository-reads  PASS       arch-who-reads-the-table  FAIL
```

| Edge | Retrieved from the code node | Retrieved from the architectural node |
| --- | --- | --- |
| `UserRepository READS_FROM postgresql.users` | ✓ `db-user-repository-reads` | ✗ `arch-who-reads-the-table` |
| `UserService PUBLISHES welcome-emails` | ✓ `arch-queue-publisher` | ✗ `arch-queue-consumer` |
| `UserService PUBLISHES user.created` | ✓ `arch-event-publisher` | ✗ `arch-event-subscribers` |
| `POST /users ROUTES_TO UserController` | — (no case probes from `UserController`) | ✗ `arch-route-to-controller` |

Code → architecture is retrievable. Architecture → code is not. The evaluator's
relationship matcher accepts a relationship stated in either direction relative
to the subject, so this asymmetry is a property of the system, not of the
assertions: the same expectation string passes from one end and fails from the
other.

This matters because the starting node is chosen by the caller, not by the
graph. "What does this repository touch?" and "what touches this table?" are the
same edge, and only the first is answerable today.

---

## 12. Evaluator correctness improvements

Two evaluator defects were found and corrected during the first run. Both would
have made the report less trustworthy in ways that are hard to notice.

### 12.1 Empty expectation could pass vacuously

`code-case-sensitivity` asserts that a lower-cased query finds nothing, because
code search is literal and case-sensitive:

```ts
probe:    { codeSearch: 'userrepository' }
expected: { files: [] }
```

Under the original matcher, "every expected file is among the results" is
trivially true of an empty expectation — so the case would have passed **whether
or not** the search returned results, including in the exact scenario it exists
to catch.

The comparison in
[packages/retrieval-eval/src/match.ts:36](../packages/retrieval-eval/src/match.ts#L36)
now gives an empty expectation an explicit meaning:

> An empty expectation asserts that the result contains **no** matching
> evidence. It passes only when nothing came back.

**Why it matters.** A vacuous pass is worse than a missing case. It occupies a
row in the report, contributes to the pass rate, and reports green for a
capability that was never checked. Negative assertions are the ones most likely
to be written as empty expectations, and they are also the ones whose silent
failure is least visible.

### 12.2 Negative path assertion reported correct behaviour as a failure

`trace-bounded-depth` asserts that `UserController` is **not** within one hop of
`postgresql.users` — the real route is three hops, so a one-hop search must
report no path rather than reaching for a longer one.

Expressing that as an unreachable positive `path` expectation and reading its
failure as success made the report print `✗` beside the system behaving
correctly. The dataset now states it as the negative it is:

```ts
probe:    { trace: { from: 'UserController', to: 'postgresql.users', maxDepth: 1 } }
expected: { noPath: true }
```

`checkNoPath`
([match.ts:230](../packages/retrieval-eval/src/match.ts#L230)) additionally
distinguishes two outcomes that a naive check would conflate:

```text
path.found === false                →  PASS   no route exists within the bound
path.truncated === true             →  FAIL   the search spent its node budget;
                                              the absence was never proven
```

**Why it matters.** "No route exists" and "the search gave up before it could
tell" are different facts, and only the first is evidence. Crediting a
truncated search with proving absence would let a bounded-search regression —
a budget set too low — register as a pass. And a report that marks correct
behaviour with a failure mark trains its reader to ignore the failure column,
which is the only column in this report that matters.

---

## 13. Evaluation reliability

### 13.1 Verification state of the repository at the time of this run

| Check | Command | Result |
| --- | --- | --- |
| Full test suite | `DATABASE_URL=… pnpm test` | **1206 passed, 0 skipped** (49 test files) |
| Full test suite, no database | `pnpm test` | 1148 passed, 58 skipped (2 files skipped) |
| Type check | `pnpm typecheck` | passes |
| Build | `pnpm build` | passes |
| Evaluator suite | `npx vitest run packages/retrieval-eval` | **43 passed** |

The 58 skipped tests are the database-backed integration suites. They skip when
no reachable `DATABASE_URL` is configured in the environment and run when one
is; with this repository's Postgres (`localhost:5433`) exported, the suite is
1206 passed and 0 skipped.

### 13.2 What the 43 evaluator tests cover

Verified by reading the suite, not inferred:

| Area | Examples |
| --- | --- |
| Near-miss relationships | right type to the wrong endpoint; wrong type between the right endpoints |
| Relationship subject | a relationship about a different subject cannot satisfy a case; an incoming relationship stated the other way round is matched |
| Wrong path order | right endpoints reached through a different middle fails |
| Path negatives | no route found; exhausted search distinguished from a missing route; the bound is not credited when the search was truncated |
| Cross-fixture file matching | whole paths compared, not suffixes |
| Node matching | a member is not accepted for its class |
| Source matching | line inside/outside the window; right window that does not contain the answer; a code-search hit as locating evidence |
| Verdicts | pass / partial / fail derivation, including a case with no checks |
| Aggregation | counts by category in declared order; empty categories omitted |
| Runner behaviour | resolves and scores; records a retrieval error against the case rather than aborting; a repository resolving to no project does not throw; runs only the retrieval a case names; honours `--case` |
| Project isolation | the runner never asks about a project other than the case's own |
| Dataset invariants | unique ids; only fixtures that exist; every case has a probe and an expectation; every case asks a real question |
| No hard-coded project ids | the dataset is asserted to contain no UUID |
| Report generation | leads with failures and names the missing evidence; states plainly when everything passed |

No claim is made about coverage beyond this table.

---

## 14. Reproducibility

### 14.1 Environment required

The evaluator is an HTTP client. It needs:

1. **PostgreSQL running** — `docker compose up -d postgres` (this repository maps
   it to `localhost:5433`).
2. **The API running** — `pnpm dev:api`.
3. **The three fixture repositories indexed** in that database. This run scored
   the projects listed in §4.5.

### 14.2 Commands

The CLI defaults to `http://localhost:${PORT ?? 3000}` read from the *process*
environment. It does not load `.env`, and this repository's `.env` sets
`PORT=3001` — so a bare `pnpm evaluate:retrieval` fails here with
`http://localhost:3000 could not be reached`. Point it at the API explicitly:

```bash
# full run
pnpm evaluate:retrieval --api http://localhost:3001

# equivalently, via the environment
RETRIEVAL_EVAL_API_URL=http://localhost:3001 pnpm evaluate:retrieval

# a single case
pnpm evaluate:retrieval --case arch-who-reads-the-table --api http://localhost:3001

# machine-readable report — --json takes a file path
pnpm evaluate:retrieval --api http://localhost:3001 --json .workspace/retrieval-evaluation.json
```

A `--` separator before the flags (`pnpm evaluate:retrieval -- --case …`) also
works; both forms were exercised. All commands above were run against the state
of the repository described in this report.

### 14.3 Flags

| Flag | Effect |
| --- | --- |
| `--api <url>` | API base URL. Default `http://localhost:${PORT ?? 3000}` |
| `--case <id>` | Run only this case. Repeatable |
| `--json <file>` | Write the whole run as JSON to this path |
| `--fail-on-error` | Exit non-zero when a case could not be **run** |

`--fail-on-error` covers a broken invocation — no API, no indexed fixture. A case
that ran and failed never fails the command: failures here are findings, and the
dataset deliberately contains questions retrieval cannot answer yet.

### 14.4 Verification commands

```bash
DATABASE_URL=postgresql://ckg:ckg@localhost:5433/code_knowledge_graph pnpm test
pnpm typecheck
pnpm build
```

---

## 15. Baseline findings

### 15.1 Working

Each item below is supported by at least one passing case in this run; see the
appendix for which.

| Capability | Evidence |
| --- | --- |
| Symbol discovery | 5/5 `symbol_lookup`, including lookup by qualified member name |
| Literal code search | 5/5 `code_lookup`, including a confirmed case-sensitive negative |
| Bounded source retrieval | 3/3 `source_context`, including find-then-read |
| Call relationships, both directions | 5/5 `call_relationship` — callers and callees |
| Node retrieval for code-side relationships | `databases`, `apis`, `contracts` and `documentation` sections populate correctly when the subject is a code node |
| Interface and inheritance | 2/2 `implementation` — `IMPLEMENTS` and `EXTENDS` |
| Dependencies | 3/3 `dependency` — packages and external services |
| Graph path tracing | 4/4 `cross_file_flow` and 4/4 `trace_path`, including the five-node `POST /users → UserController → UserService → UserRepository → postgresql.users` route |
| Bounded search negatives | a one-hop search confirmed not to reach a three-hop route |
| Repository knowledge | 3/3 `documentation` — `DOCUMENTS`, `IMPLEMENTED_BY`, `DEFINES` |
| Project isolation | verified by test, and by every case resolving its own project |

### 15.2 Known gap

**Architectural-node relationship projection.**

| Node type | Relationship not projected | Confirmed by |
| --- | --- | --- |
| `api` | `ROUTES_TO` | `arch-route-to-controller` |
| `queue` | `PUBLISHES` (and `SUBSCRIBES`, present in the graph, untested by a case) | `arch-queue-consumer` |
| `event` | `PUBLISHES` (and `SUBSCRIBES`, present in the graph, untested by a case) | `arch-event-subscribers` |
| `table` | `READS_FROM` (and `WRITES_TO`, present in the graph, untested by a case) | `arch-who-reads-the-table` |

`WRITES_TO` and `SUBSCRIBES` are listed as affected because they are handled by
the same type-guarded predicate as `READS_FROM` and `PUBLISHES` and were
observed in the depth-1 traversals in §10. No case asserts them, so they are
reported as inferred from the mechanism and the traversal output, not as
measured failures.

---

## 16. Impact on CodeRAG

The current evaluation is deterministic retrieval evaluation. It does not
measure agent behaviour, and nothing here demonstrates an agent failure. What it
establishes is a property of the evidence an agent would be working from.

An agent asking:

```text
What handles POST /users?
```

may reasonably begin retrieval at the API node it just found through
`search_graph`. The graph knows:

```text
POST /users  ──ROUTES_TO──>  UserController
```

but `get_node("POST /users")` returns no relationships, so an agent that treats
node detail as the authoritative view of a node's neighbourhood has no evidence
of the handler. The same applies to:

```text
What reads the users table?
```

which requires the edge `UserRepository → postgresql.users` to be readable from
the `postgresql.users` end.

The evidence *is* reachable — a depth-1 traversal from the same node returns it —
so this is a gap in which retrieval call surfaces the fact, not in whether the
system holds it. The practical consequence is that the answer depends on which
call an agent happens to make, and on which node it happens to start from.

The design principle the finding points at:

> Retrieval should preserve useful evidence regardless of which relevant node
> becomes the starting point.

Questions whose natural starting point is a schema, a route, a queue or an event
are common precisely when the caller does not yet know the code-side answer —
which is when retrieval is most needed.

---

## 17. Recommended next step

**Step 9C — Fix architectural node relationship projection.**

Narrowly scoped, and deliberately not a redesign:

1. Inspect `get_node` relationship assembly — `getNodeDetail`
   ([graph.service.ts:244](../apps/api/src/modules/graph/graph.service.ts#L244))
   and `nodeRelations`
   ([graph.repository.ts:643](../packages/database/src/repositories/graph.repository.ts#L643)).
2. Compare it with depth-1 graph traversal output for the same node, which is
   already known to return the missing edges (§10).
3. Identify the missing projection: the `apis` and `databases` buckets select on
   `related.type`, which only holds when the subject is a code node
   ([:708](../packages/database/src/repositories/graph.repository.ts#L708),
   [:713](../packages/database/src/repositories/graph.repository.ts#L713)).
4. Fix the generic projection mechanism so a row is bucketed by relationship
   and direction rather than by the other endpoint's type — not by
   special-casing four node types. Note that `documentation` and `contracts`
   already work this way and are the working precedent.
5. Add regression tests at the layer the defect lives in: repository-level tests
   for `nodeRelations` from both ends of the same edge, and API-level node-detail
   tests.
6. Rerun the complete 49-case evaluation and record the new baseline.

**Explicitly not recommended yet:** semantic search, embeddings, vector
retrieval, an LLM judge, or any RAG answer-quality work. The evaluation has
identified a concrete, reproducible, deterministic retrieval defect with a known
location and a known correct behaviour. Layering retrieval strategies on top of
a projection that silently drops edges would make the defect harder to see, not
easier.

---

## 18. Limitations

**Dataset size.** 49 cases. Large enough to localise a defect, too small for a
pass rate to carry statistical meaning.

**Dataset construction.** Every case is manually authored from evidence read out
of a running, indexed fixture. That is what keeps it honest — an expectation
written from the fixture's source would measure the fixture, not retrieval — and
it also means coverage reflects what an author thought to ask.

**Fixture concentration.** 35 of 49 cases use `express-postgres-sample`. All
four failures come from that fixture, because it is the one with routes, queues,
events and tables. §10.4 records the same gap reproducing in
`repository-knowledge-sample`, so it is not a property of one fixture — but the
measurement itself rests largely on one repository.

**Scope.** The evaluation measures deterministic retrieval correctness. It does
not measure natural-language answer quality, LLM reasoning, agent planning,
semantic search, or RAG answer quality. None of those are in the loop.

**Generalisation.** All three fixtures are TypeScript, small (79–126 nodes), and
purpose-built. Results do not automatically generalise to other languages,
frameworks, repository sizes or architectures.

**Performance.** The evaluator does not measure latency and this report makes no
performance claim. The 30-second per-request client timeout is a guard, not a
measurement.

**Freshness.** The evaluation does not establish that the indexed graph matches
the current state of the fixture on disk. It scores whatever the resolved
project contains. A stale index would be scored as though it were current.

**Project resolution.** Where a repository has been indexed more than once, the
API's first-ranked match is taken. The report names the project id it scored
(§4.5) so a reader can confirm which graph produced these numbers.

---

## 19. Future benchmark dimensions

Listed as **future work**. None of these are implemented and no values are
claimed for any of them.

```text
Retrieval correctness
    precision
    recall
    evidence coverage

Source quality
    correct file
    correct line
    sufficient context

Graph quality
    relationship coverage
    directionality
    path accuracy

Performance
    search latency
    source latency
    node latency
    trace latency

Scale
    repository size
    file count
    node count
    edge count
```

Directionality is the dimension this baseline most directly argues for: the
current dataset found the gap only because two cases happened to ask the same
question from opposite ends. Making that a systematic dimension — for every
asserted edge, is it retrievable from both endpoints? — would have found it by
construction.

---

## 20. Post-Fix Validation

```text
Validation of:    Step 9C — architectural node relationship projection
Fix commit range: working tree, on top of f6060ac
Re-measured:      2026-09-22
Evaluator:        unchanged (no dataset, matcher or threshold was modified)
```

The baseline above is left exactly as measured. This section records the result
of re-running the same 49 cases against the fixed system.

### 20.1 Result

| Metric | Baseline v0.1 | Post-fix | Change |
| --- | ---: | ---: | ---: |
| Total cases | 49 | 49 | — |
| Passed | 45 | 49 | +4 |
| Partial | 0 | 0 | — |
| Failed | 4 | 0 | −4 |
| Pass rate | 91.8% | 100% | +8.2pp |

By category, every category is now complete:

| Category | Baseline | Post-fix |
| --- | ---: | ---: |
| `database_access` | 4/5 | 5/5 |
| `architecture` | 7/10 | 10/10 |
| all nine others | unchanged | unchanged |

A case-by-case diff of the two machine-readable runs confirms the change is
confined to the four known failures:

```text
same case set:           true
arch-route-to-controller   fail → pass
arch-queue-consumer        fail → pass
arch-event-subscribers     fail → pass
arch-who-reads-the-table   fail → pass
regressions:             none
```

### 20.2 What was wrong

The baseline traced all four failures to §9: `nodeRelations` sectioned each
relationship row by the **node type of the opposite endpoint**.

```ts
if (API_RELATIONSHIPS.includes(relationship) && related.type === 'api')
if (DATA_RELATIONSHIPS.includes(relationship) && DATA_NODE_TYPES.includes(related.type))
```

The query already read both directions, so the row was fetched. But when the
node being inspected *is* the API, queue, event or table, the neighbour is a
class or a method — `related.type` is `class`, not `api` or a data type — so the
row matched no section, fell past every later predicate (`ROUTES_TO`,
`READS_FROM`, `WRITES_TO`, `PUBLISHES` and `SUBSCRIBES` are in none of the
documentation, contract or dependency sets) and was silently discarded.

### 20.3 The fix

Both predicates now section by **relationship alone**, with the existing
`direction` field carrying which end the inspected node is:

```ts
if (API_RELATIONSHIPS.includes(relationship))
if (DATA_RELATIONSHIPS.includes(relationship))
```

This is the mechanism `documentation`, `contracts` and `implementations` already
used — the three sections the baseline found working, and whose predicates carry
no node-type guard (§10.4). It is generic, not a list of exceptions:

- No relationship type is named anywhere in the fix. The four affected
  relationships are not special-cased, and neither is any node type.
- The seven relationship sets are disjoint, so the relationship alone determines
  the section. Adding a future relationship to `DATA_RELATIONSHIPS` or
  `API_RELATIONSHIPS` makes it work from both ends automatically.
- `DATA_NODE_TYPES`, which existed only to serve the removed guard, is gone.

One production file changed:
[packages/database/src/repositories/graph.repository.ts](../packages/database/src/repositories/graph.repository.ts).
The `NodeDetail` response shape, the section names and the evidence fields are
untouched.

The in-memory store in `apps/api/tests/helpers/` reproduced the same bug, so the
API-level suite would have agreed with a defect production no longer had. It was
corrected to hold the same invariant.

### 20.4 Evidence, re-measured

The four cases now retrieve the evidence they expect. Retrieved relationships,
from the evaluator's own output:

| Case | Retrieved |
| --- | --- |
| `arch-route-to-controller` | `POST /users ROUTES_TO UserController`, `… ROUTES_TO UserController.create` |
| `arch-queue-consumer` | `UserService PUBLISHES welcome-emails`, `UserService.welcomeQueue PUBLISHES …`, `startWelcomeEmailWorker SUBSCRIBES …` |
| `arch-event-subscribers` | `UserService PUBLISHES user.created`, `UserService.create PUBLISHES …`, `registerUserCreatedListener SUBSCRIBES …` |
| `arch-who-reads-the-table` | `UserRepository READS_FROM postgresql.users` plus four method-level `READS_FROM`/`WRITES_TO` edges |

The directionality table from §11 now reads:

| Edge | From the code node | From the architectural node |
| --- | --- | --- |
| `UserRepository READS_FROM postgresql.users` | ✓ | ✓ |
| `UserService PUBLISHES welcome-emails` | ✓ | ✓ |
| `UserService PUBLISHES user.created` | ✓ | ✓ |
| `POST /users ROUTES_TO UserController` | ✓ | ✓ |

The counterexample node from §10.4 keeps everything it had and gains the section
it was missing — `get_node("postgresql.users")` in `repository-knowledge-sample`
still returns its 7 `children` columns, its 2 `DEFINES` contracts and its
`references`, and now also returns `READS_FROM`/`WRITES_TO` under `databases`.

### 20.5 Graph traversal unchanged

The fix touches node-detail assembly only. Depth-1 traversals of all four nodes
return byte-identical results to the baseline recording in §10:

| Root node | Nodes | Edges |
| --- | ---: | ---: |
| `POST /users` | 4 | 5 |
| `welcome-emails` | 4 | 4 |
| `user.created` | 4 | 4 |
| `postgresql.users` | 9 | 15 |

### 20.6 Regression tests added

19 tests, at the two layers the defect spans. Each was confirmed to fail against
the pre-fix code and pass after — a regression test that passes either way would
not be one.

| Layer | File | Tests | Fail on pre-fix code |
| --- | --- | ---: | ---: |
| Database (`nodeRelations`) | `packages/database/tests/graph-repository.integration.test.ts` | 9 | 6 |
| API (`get_node` route) | `apps/api/tests/api.test.ts` | 10 | 5 |

The tests that pass in both states are the deliberate guards on the direction
that always worked: inspecting the controller, the service and the repository.
Coverage includes, at both layers:

- all four shapes read from the architectural end — API, queue, event, table;
- the same four read from the code end, to catch a fix that merely inverted the
  bug;
- `SUBSCRIBES` as well as `PUBLISHES`, and `WRITES_TO` as well as `READS_FROM`;
- **near-miss endpoints** — a second repository, table, queue, route and
  controller in the same graph, asserting that `OrderRepository READS_FROM
  postgresql.orders` never surfaces on `postgresql.users`, and that
  `password-resets` never surfaces on `welcome-emails`;
- evidence preservation (`confidence`, `evidenceSource`, `direction`) on an
  entry read from the architectural end;
- an empty section for a node with no such relationship;
- **project isolation** — the database suite builds a second project with a
  same-shaped graph, so a query leaking across projects would return something
  plausible rather than nothing;
- graph traversal from an architectural node, asserted unchanged.

The database suite uses its own project rather than extending the shared
fixture, which several existing cases assert exact traversal and composition
results against.

### 20.7 Verification

| Check | Command | Result |
| --- | --- | --- |
| Full suite, database reachable | `DATABASE_URL=… pnpm test` | **1225 passed, 0 skipped** (49 files) |
| Full suite, no database | `pnpm test` | 1158 passed, **67 skipped** (2 files skipped) |
| Type check | `pnpm typecheck` | passes |
| Build | `pnpm build` | passes |
| Retrieval evaluation | `pnpm evaluate:retrieval --api http://localhost:3001` | **49/49** |

Baseline was 1206 tests; the 19 new regression tests bring the total to 1225.
The skipped 67 are the database-backed integration suites, which skip when no
reachable `DATABASE_URL` is configured — 58 at baseline plus the 9 added here.
They are reported as skipped, not as passed.

### 20.8 What this does and does not establish

It establishes that the four questions the baseline could not answer are now
answerable through `get_node`, and that no other case in the dataset changed.

It does not establish that retrieval is directionally complete in general. The
dataset asserts four architectural edges from both ends; the fix is generic and
should hold for any relationship in these sets, but "should hold" is an argument
about the mechanism, not a measurement. §19 still names directionality — for
every asserted edge, is it retrievable from both endpoints? — as the benchmark
dimension that would check this by construction rather than by four examples.

The limitations in §18 are otherwise unchanged: same three TypeScript fixtures,
same 49 manually authored cases, still no latency measurement, still no
freshness guarantee. A 100% pass rate on this dataset means the dataset has
stopped finding defects, not that there are none left to find.

---

## Appendix A — Complete case results

All 49 cases, in dataset order, generated from the machine-readable output of
the run recorded in this report. Fixture names are abbreviated
(`express-postgres` = `express-postgres-sample`, `typescript` =
`typescript-sample`, `repository-knowledge` = `repository-knowledge-sample`).

| # | Case ID | Category | Fixture | Question | Retrieval probe | Status | Missing evidence |
| --: | --- | --- | --- | --- | --- | --- | --- |
| 1 | `symbol-user-repository` | `symbol_lookup` | express-postgres | Where is UserRepository defined? | `search_graph("UserRepository") + get_node("UserRepository")` | PASS | — |
| 2 | `symbol-user-service` | `symbol_lookup` | express-postgres | Where is UserService defined? | `search_graph("UserService")` | PASS | — |
| 3 | `symbol-method-by-qualified-name` | `symbol_lookup` | express-postgres | Where is UserRepository.markVerified defined? | `search_graph("UserRepository.markVerified")` | PASS | — |
| 4 | `symbol-interface` | `symbol_lookup` | express-postgres | Where is the User model defined? | `search_graph("User")` | PASS | — |
| 5 | `symbol-auth-service` | `symbol_lookup` | repository-knowledge | Where is AuthService defined? | `search_graph("AuthService") + get_node("AuthService")` | PASS | — |
| 6 | `code-user-repository-mentions` | `code_lookup` | express-postgres | Where does the code mention UserRepository? | `search_code("UserRepository")` | PASS | — |
| 7 | `code-class-declaration` | `code_lookup` | express-postgres | Where is the UserService class declared, textually? | `search_code("class UserService")` | PASS | — |
| 8 | `code-sql-insert` | `code_lookup` | express-postgres | Where is a row inserted into the users table? | `search_code("INSERT INTO users")` | PASS | — |
| 9 | `code-external-service-config` | `code_lookup` | express-postgres | Where is SendGrid configured? | `search_code("sendgrid")` | PASS | — |
| 10 | `code-case-sensitivity` | `code_lookup` | express-postgres | Does a lower-cased query find the class? (it must not: search is literal) | `search_code("userrepository")` | PASS | — |
| 11 | `calls-who-calls-user-service` | `call_relationship` | express-postgres | Who calls UserService? | `get_node("UserService")` | PASS | — |
| 12 | `calls-what-user-service-calls` | `call_relationship` | express-postgres | What does UserService call? | `get_node("UserService")` | PASS | — |
| 13 | `calls-who-calls-user-repository` | `call_relationship` | express-postgres | Who calls UserRepository? | `get_node("UserRepository")` | PASS | — |
| 14 | `calls-controller-members` | `call_relationship` | express-postgres | What methods does UserController contain? | `get_node("UserController")` | PASS | — |
| 15 | `calls-ts-sample-layers` | `call_relationship` | typescript | Who calls UserRepository in the plain TypeScript sample? | `get_node("UserRepository")` | PASS | — |
| 16 | `db-user-repository-reads` | `database_access` | express-postgres | Where does UserRepository read from the database? | `get_node("UserRepository")` | PASS | — |
| 17 | `db-user-repository-writes` | `database_access` | express-postgres | Where does UserRepository write to the database? | `get_node("UserRepository")` | PASS | — |
| 18 | `db-second-table` | `database_access` | express-postgres | Does UserRepository touch any table other than users? | `get_node("UserRepository")` | PASS | — |
| 19 | `db-session-repository` | `database_access` | repository-knowledge | Which table does SessionRepository use? | `get_node("SessionRepository")` | PASS | — |
| 20 | `impl-user-store` | `implementation` | typescript | What implements the UserStore interface? | `get_node("UserRepository")` | PASS | — |
| 21 | `impl-base-controller` | `implementation` | typescript | What does UserController extend? | `get_node("UserController")` | PASS | — |
| 22 | `arch-route-to-controller` | `architecture` | express-postgres | Which controller serves POST /users? | `get_node("POST /users")` | **FAIL** | `POST /users ROUTES_TO UserController` |
| 23 | `arch-queue-publisher` | `architecture` | express-postgres | What publishes to the welcome-emails queue? | `get_node("UserService")` | PASS | — |
| 24 | `arch-event-publisher` | `architecture` | express-postgres | What publishes the user.created event? | `get_node("UserService")` | PASS | — |
| 25 | `arch-external-service` | `architecture` | express-postgres | Which external service does EmailService use? | `get_node("EmailService")` | PASS | — |
| 26 | `arch-routes-listed` | `architecture` | express-postgres | What HTTP routes does this service expose? | `search_graph("users")` | PASS | — |
| 27 | `arch-queue-consumer` | `architecture` | express-postgres | What publishes to, or consumes, the welcome-emails queue? | `get_node("welcome-emails")` | **FAIL** | `UserService PUBLISHES welcome-emails` |
| 28 | `arch-event-subscribers` | `architecture` | express-postgres | What publishes the user.created event? | `get_node("user.created")` | **FAIL** | `UserService PUBLISHES user.created` |
| 29 | `arch-who-reads-the-table` | `database_access` | express-postgres | What reads from the users table? | `get_node("postgresql.users")` | **FAIL** | `UserRepository READS_FROM postgresql.users` |
| 30 | `arch-service-dependencies` | `dependency` | express-postgres | What does the service itself depend on? | `get_node("users-service")` | PASS | — |
| 31 | `arch-table-columns` | `architecture` | repository-knowledge | Which columns does the users table have? | `get_node("postgresql.users")` | PASS | — |
| 32 | `arch-openapi-endpoints` | `architecture` | repository-knowledge | Which operations does the OpenAPI specification declare? | `search_graph("users")` | PASS | — |
| 33 | `arch-config-properties` | `architecture` | repository-knowledge | How is the database connection configured? | `search_graph("database")` | PASS | — |
| 34 | `flow-controller-to-repository` | `cross_file_flow` | express-postgres | How does UserController reach UserRepository? | `trace_path("UserController" → "UserRepository")` | PASS | — |
| 35 | `flow-controller-to-table` | `cross_file_flow` | express-postgres | How does UserController reach the users table? | `trace_path("UserController" → "postgresql.users")` | PASS | — |
| 36 | `flow-request-to-store` | `cross_file_flow` | express-postgres | How does a POST /users request reach the users table? | `trace_path("POST /users" → "postgresql.users")` | PASS | — |
| 37 | `flow-rkg-controller-to-table` | `cross_file_flow` | repository-knowledge | How does UserController reach the users table in the knowledge fixture? | `trace_path("UserController" → "postgresql.users")` | PASS | — |
| 38 | `trace-service-to-queue` | `trace_path` | express-postgres | How does UserService reach the welcome-emails queue? | `trace_path("UserService" → "welcome-emails")` | PASS | — |
| 39 | `trace-ts-sample-layers` | `trace_path` | typescript | How does UserController reach UserRepository in the plain sample? | `trace_path("UserController" → "UserRepository")` | PASS | — |
| 40 | `trace-auth-to-session-store` | `trace_path` | repository-knowledge | How does AuthService reach the sessions table? | `trace_path("AuthService" → "postgresql.sessions")` | PASS | — |
| 41 | `trace-bounded-depth` | `trace_path` | express-postgres | Is UserController within one hop of the users table? (it is not) | `trace_path("UserController" → "postgresql.users", depth 1)` | PASS | — |
| 42 | `source-class-body` | `source_context` | express-postgres | Show me the UserRepository class definition. | `get_source(src/repositories/user.repository.ts)` | PASS | — |
| 43 | `source-sql-statement` | `source_context` | express-postgres | Show me the INSERT statement UserRepository.create runs. | `get_source(src/repositories/user.repository.ts)` | PASS | — |
| 44 | `source-found-then-read` | `source_context` | express-postgres | Find where the welcome-email worker is defined and read it. | `search_code("welcome-emails") + get_source(src/workers/welcome-email.worker.ts)` | PASS | — |
| 45 | `docs-what-documents-the-repository` | `documentation` | repository-knowledge | What does the repository say about UserRepository? | `get_node("UserRepository")` | PASS | — |
| 46 | `docs-contract-implemented-by` | `documentation` | repository-knowledge | Which specification does UserController implement? | `get_node("UserController")` | PASS | — |
| 47 | `docs-migration-defines-table` | `documentation` | repository-knowledge | Which migration creates the users table? | `get_node("postgresql.users")` | PASS | — |
| 48 | `dep-service-packages` | `dependency` | express-postgres | Which third-party packages does this service depend on? | `search_graph("module")` | PASS | — |
| 49 | `dep-payment-external` | `dependency` | express-postgres | Which external service does PaymentService talk to? | `get_node("PaymentService")` | PASS | — |

### Appendix A notes

- `#` is dataset order, which is also the order the runner executes in.
- The **Retrieval probe** column names the calls the runner actually made for
  that case, using the capability names from §2.
- **Missing evidence** is the evaluator's own `missing` list for any failing
  check, verbatim.
- Cases 23/27, 24/28 and 16/29 each assert the same edge from opposite ends,
  and in each pair the code-side probe passes while the architecture-side probe
  fails. Reading those pairs side by side is the clearest single view of the
  directionality gap.

---

## Appendix B — Raw evaluator output

Reproduced verbatim from the run recorded in this report, for verification.

```text
CodeRAG Retrieval Evaluation
────────────────────────────────────────────────────────────────

express-postgres-sample  →  express-sample (2cd2c90a…, 114 nodes)
repository-knowledge-sample  →  rkg-e2e (d0852899…, 126 nodes)
typescript-sample  →  ts-sample (2b1a938a…, 79 nodes)

Cases: 49    Pass: 45    Partial: 0    Fail: 4

By category:
  symbol_lookup      5/5
  code_lookup        5/5
  call_relationship  5/5
  dependency         3/3
  database_access    4/5  (1 failed)
  implementation     2/2
  cross_file_flow    4/4
  architecture       7/10  (3 failed)
  source_context     3/3
  trace_path         4/4
  documentation      3/3

Failures
────────────────────────────────────────────────────────────────

✗ arch-route-to-controller  [architecture]
  Which controller serves POST /users?
  relationships: missing
     - POST /users ROUTES_TO UserController
     retrieved: POST /users CONTAINS src/api/user.routes.ts
  known: The ROUTES_TO edge is in the graph — a depth-1 traversal from this node returns it — but node detail reports no relationships for an api node.

✗ arch-queue-consumer  [architecture]
  What publishes to, or consumes, the welcome-emails queue?
  relationships: missing
     - UserService PUBLISHES welcome-emails
     retrieved: nothing
  known: Asked from the queue, nothing comes back. The PUBLISHES edge is only visible from UserService, so "what feeds this queue" is unanswerable without already knowing the answer.

✗ arch-event-subscribers  [architecture]
  What publishes the user.created event?
  relationships: missing
     - UserService PUBLISHES user.created
     retrieved: nothing
  known: Same shape as the queue: an event node carries no relationships of its own.

✗ arch-who-reads-the-table  [database_access]
  What reads from the users table?
  relationships: missing
     - UserRepository READS_FROM postgresql.users
     retrieved: postgresql.users CONTAINS postgresql
  known: The reverse of db-user-repository-reads, which passes. Code → table is retrievable; table → code is not.
```

The `known:` lines are `knownGap` notes carried in the dataset. They record what
was already understood about each failure before this run, so a failure that is
old news reads differently from one that is new. All four were already
understood; none is new as of this report.
