# CodeRAG Real-Repository Validation Report

```text
Target:        immich-app/immich — server/ package
Commit:        a4af86282d13354bd21bbaf7a2ffb7fae15e8cf2 (2026-09-24)
Date:          2026-09-24
CodeRAG state: working tree after the MCP operational layer (index_project, freshness, dev:all), uncommitted
Method:        real MCP client over stdio, launching apps/mcp/dist/server.js exactly as .mcp.json does
```

This is a validation, not a benchmark. The retrieval code was not changed
during it. Sections up to Known Limitations are the baseline as measured; the
re-run after the MCP output changes is recorded separately in
[Re-run after MCP surface changes](#re-run-after-mcp-surface-changes). Every number here was measured in this run. Where something could
not be measured it says so.

---

## Executive Summary

CodeRAG indexed a real production NestJS codebase in **6.6 s** and produced
**9,394 nodes and 51,391 edges** from 674 source files. It had **no parse
errors and no failed analyzers**. Every graph query answered in under 120 ms.

Of **23 objectively checkable questions** asked through MCP:

| Outcome | Count |
| --- | ---: |
| Correct | 13 |
| Partial | 8 |
| Fail | 2 |

These counts come from a 23-question test set written by the evaluator. They
are not a general accuracy rate.

What worked well:

- **Method-level call graph for class methods.** Callers were complete in every
  case checked. Multi-hop traces (guard → service → repository) were exact.
- **Inheritance.** All 51 of 51 `extends BaseService` edges were stored.
- **Route → handler mapping.** 303 routes were found, each mapped to its handler.
- **Freshness.** Uncommitted edits, commits, additions, deletions and ignored
  paths were all handled correctly. The re-index lifecycle
  (STALE → INDEXING → CURRENT) worked end to end.

The partials and failures cluster into four causes:

1. **The MCP text output hides data the graph already has.** `get_node` prints
   only the top 5 callers and callees. It prints no list at all for
   references, implementations or dependents, and caps every section at 20.
   This one cause explains 5 of the 8 partials.
2. **Missing relationships**:
   - Kysely query-builder calls (`db.insertInto('album')`) produce no
     reads/writes edge.
   - Calls to `export const fn = () => …` helpers are stored as `REFERENCES`,
     not `CALLS`. These are 34% of this repo's exported functions.
   - The `@OnJob` handler ↔ job-name link is not modelled.
3. **Ranking.** For a broad query (`SharedLink`), the primary classes ranked
   #33–#40 behind type-literal fields and test factories.
4. **Environment.** The repo was indexed without `node_modules`, so external
   interfaces (e.g. `NestInterceptor`) have no node to connect to.

**Recommended next priority:** MCP tool output design (`get_node` section
completeness and paging, plus exposing the existing search filters). It
accounts for the largest share of observed partials. It needs no change to
the graph. The data is already stored and was verified complete in every case
checked. Relationship extraction (Kysely, arrow-function calls) comes second.

---

## Repository Tested

| Property | Value |
| --- | --- |
| Repository | [immich-app/immich](https://github.com/immich-app/immich), `server/` package |
| Why this one | Real production code. Layered NestJS architecture (82 controller, 102 service, 62 repository files). Kysely data access, BullMQ-style jobs, heavy cross-file imports, inheritance. |
| Acquisition | Shallow sparse clone (`--depth 1 --filter=blob:none`, sparse `server/`) into a scratch directory. Nothing outside the clone was modified. |
| Language | TypeScript (671 files), JavaScript (3) |
| Files scanned | 728 (674 source, 36 SQL, 8 config, 10 other), 31 directories |
| Tracked `.ts` files | 662 (171 of them `*.spec.ts`) |
| Size on disk | 6.0 MB |
| Dependencies | **Not installed** (no `node_modules`), as in a fresh checkout. See Known Limitations. |
| Graph | 9,394 nodes / 51,391 edges |
| Node mix | 641 classes, 147 interfaces, 2,526 functions + methods |

---

## Indexing Results

Measured from the worker's own log records for the run (`d6da4e01`):

| Phase | Duration |
| --- | ---: |
| Source revision capture (git) | 0.16 s |
| Scan + language detection | 0.01 s |
| SCIP indexing (`scip-typescript`) | 3.02 s |
| SCIP parse (671 documents, 50,321 symbols) | 0.23 s |
| Graph build (12 analyzers) | 0.85 s |
| Persist | 2.33 s |
| **Total (claim → completed)** | **6.59 s** |

- **Throughput:** about 102 source files/s end to end, and about 220 files/s
  for the SCIP stage.
- **Warnings and errors:** 0 parse errors, 0 failed analyzers, 0 dropped edges,
  0 unreadable files.
- **Analyzer output:**
  - 303 API routes (0 unresolved handlers), 47 controllers, 111 services,
    68 entities, 2 guards, 5 frameworks
  - 91 external packages, 1,636 exports
  - 122 tables counted by the database analyzer (134 table nodes found by
    search; see Failures)
  - 20 external services, **0 queues, 0 events**

---

## MCP Validation

All steps went through the MCP server over stdio. No internal service was
called to get an answer. The API was read directly only to *verify* the
completeness of what MCP returned. Those checks are labelled "store" below.

| Step | Tool | Result |
| --- | --- | --- |
| Resolve the unindexed path | `resolve_project` | "No indexed project contains …" (57 ms) |
| Register and queue | `index_project` | `started`, `projectCreated: true`, run QUEUED (17 ms) |
| Wait, then check | `get_index_status` | `ready`, freshness `current`, 9,394 nodes / 51,391 edges, indexed commit `a4af862…` |
| Re-request when current | `index_project` | `up_to_date`, `jobCreated: false` |

**How the questions were driven.** The evaluator acted as the agent: it picked
each tool call and read each response, through a scripted MCP client. This
tests the tools and their output. It does **not** test how a model in an
interactive Claude Code session would choose tools on its own. That is listed
under Known Limitations.

---

## Question Evaluation

Correctness was checked against the source, by grep and by reading the code.

- **Correct:** the right answer was available in the tool's text output.
- **Partial:** the answer was incomplete in the text output, or needed data
  that appears only in `structuredContent`.

Tool-call counts include the `search_graph` lookups used to obtain node ids.

| # | Cat | Question | Tools used (≈calls) | Correct | Relevant context | Notes |
|---|---|---|---|---|---|---|
| A1 | A | Where is `AlbumService` implemented? | search_graph (1) | ✅ | Class plus methods, file:line | — |
| A2 | A | Where is `AuthGuard` and its `canActivate`? | search_graph (1) | ✅ | Also returned `MaintenanceAuthGuard` (relevant sibling) | — |
| A3 | A | Which handler serves `POST /albums`? | search_graph ×3, get_node (4) | ✅ | Route → `AlbumController.createAlbum` (high confidence) | First query `POST /albums` found nothing: routes carry the global `/api` prefix and matching is literal |
| A4 | A | What does `AuthService.validateApiKey` do? | search_graph, get_node, get_source (3) | ✅ | Callees `ApiKeyRepository.getKey`, `CryptoRepository.hashSha256` match lines 528–529 | — |
| B1 | B | What calls `AlbumService.create`? | search_graph, get_node (2) | ✅ | `AlbumController.createAlbum`, `WorkflowExecutionService.onPluginLoad` (inside a closure), one spec file. Complete. | Also listed a false "implementation": `BaseService.create` (a static factory with the same name) |
| B2 | B | Where is `AssetRepository.getById` used? | search_graph, get_node (2) | ⚠️ Partial | Text shows 5 of 14 callers (2 of them spec files) | Store has all 8 non-test call sites, matching grep, including `this.getById` inside `AssetRepository.update` |
| B3 | B | What calls `AuthService.authenticate`? | search_graph, get_node (2) | ✅ | `AuthGuard.canActivate`, `BaseModule.onModuleInit`. Complete. | — |
| B4 | B | Which classes use `AlbumRepository`? | search_graph, get_node (2) | ⚠️ Partial | Text shows 5 of 11 | Store: all 10 services plus a test context, matching grep |
| C1 | C | Trace `POST /api/albums` to the `album` table | search_graph ×2, trace_path, get_node (4) | ⚠️ Partial | Path found, but at class level: route → `AlbumController` → `AlbumService` → `AlbumRepository` → `AlbumTable` → table | No method-level path, because `AlbumRepository.create` has no write edge (Kysely) |
| C2 | C | Trace `AuthGuard.canActivate` to the session lookup | search_graph ×2, trace_path (3) | ✅ | Exact 4-hop chain via `authenticate` → `validate` → `validateSession` → `SessionRepository.getByToken` (all scip/high) | — |
| C3 | C | What is involved in `PUT /api/albums/:id/assets`? | search_graph ×3, get_node ×3 (6) | ⚠️ Partial | Route → controller → `AlbumService.addAssets` → `requireAccess`, `findOrFail`, `AlbumRepository.update`, `EventRepository.emit` | Missing the call to the `addAssets` util (arrow const), which does the actual bulk insert |
| C4 | C | Which code writes the `album` table? | get_node (1) | ❌ Fail | Only generated `src/queries/*.sql` snapshots and migration `up`/`down` | No repository method. `AlbumRepository.create` writes via `insertInto('album')`, which is not detected |
| D1 | D | How does authentication work? | search_graph ×2, get_node ×2, get_source (5) | ✅ | Guard → `authenticate` → `validate` dispatch: shared-link key/slug → session → API key | Graph lists 6 strategies; text shows 5 (the 5-item cap hides `validateSharedLinkSlug`). Source read filled the gap. |
| D2 | D | Which modules handle shared links? | search_graph ×3 (3) | ⚠️ Partial | Needed an exact-name query | For `SharedLink`, the service, controller and repository ranked #33, #38 and #40 of 50, behind type-literal fields, enum members and test factories |
| D3 | D | Which method handles the `AssetGenerateThumbnails` job? | search_graph ×2, get_node (3) | ⚠️ Partial | Text: "references: 10", with no list | `structuredContent` references include `MediaService.handleGenerateThumbnails`, mixed with producers. There is no handler relationship. |
| E1 | E | What is affected if `BaseService` changes? | search_graph, get_node (2) | ⚠️ Partial | Text shows `implementations: 20+` and 5 callers | Store: 51 of 51 `EXTENDS`, matching grep. MCP caps sections at 20 and has no paging. |
| E2 | E | What implements `IBulkAsset`? | search_graph, get_node (2) | ⚠️ Partial | Text: "implementations: 1", with no name | `structuredContent`: `MemoryRepository IMPLEMENTS IBulkAsset`, which is correct |
| E3 | E | Which classes implement `NestInterceptor`? | search_graph ×2, get_node (3) | ❌ Fail | No `NestInterceptor` node exists | External interface. Dependencies were not installed. Four implementers exist in source. |
| E4 | E | What is affected if `SessionRepository.getByToken` changes? | search_graph, get_node (2) | ✅ | Exactly 1 caller (`AuthService.validateSession`), matching grep | — |
| F1 | F | Verify `AlbumService.create` calls `AlbumRepository.create` | trace_path, search_code (2+2) | ✅ | Direct scip/high edge. Text search located the call site (line 121). | Call edges carry no location, so the line came from text search |
| F2 | F | Show the source that inserts a new album | get_source (1) | ✅ | Lines 304–330, including the `insertInto('album')` CTE | Node range starts at the `@GenerateSql` decorator (304), not the signature (311) |
| F3 | F | Verify `AssetService.getStatistics` calls `AssetRepository.getStatistics` | trace_path (1+2) | ✅ | Direct edge, scip/high | — |
| F4 | F | Does `AuthGuard.canActivate` call `SessionRepository.getByToken` directly? | trace_path, `maxDepth: 1` (1+2) | ✅ | "No path within 1 hop". Correct negative, consistent with the 4-hop path in C2. | — |

**Context size.** The median text response per tool was 200–440 characters for
graph tools and about 1,050 for `get_source`. The largest single response was
4,862 characters (`search_code` for `extends BaseService`, 50 matches). No
response came close to straining context.

**Irrelevant information retrieved.**
- D2: type-literal and test nodes.
- A1/D2: synthetic nodes such as
  `SharedLinkService.asToken.sharedLink.typeLiteral24.id`.
- Callees included decorator-builder calls (`HistoryBuilder.added/beta/stable`)
  for every controller method.
- Spec files appear among callers, mixed in with production callers.

---

## Graph Relationship Coverage

| Relationship | Result | Evidence |
| --- | --- | --- |
| Imports | PASS | `src/services/album.service.ts` has `IMPORTS` edges to `src/utils/access.ts`, `src/dtos/album.dto.ts`, … (scip/high). One false positive: `DEPENDS_ON src`, where the import analyzer treats the `src/…` path alias as a package. |
| References | PASS | `JobName.AssetGenerateThumbnails` has 10 references, including the `@OnJob` handler and the producers. `IBulkAsset` has 5. Not listed in the text output. |
| Calls (class methods) | PASS | C2: 4 hops, all scip/high. F1 and F3: direct edges. |
| Calls (`export const fn = () =>` helpers) | FAIL | `mapAlbum`, `getPreferences` and the `addAssets` util are `variable` nodes. Their call sites are `REFERENCES`, not `CALLS`. 139 of 407 exported top-level functions use this style. `export function` helpers (e.g. `withExif`) do get `CALLS`. |
| Callers | PASS (store) / PARTIAL (MCP text) | B1, B3, E4 complete. B2 and B4 complete in the store but truncated to 5 in the text. |
| Callees | PARTIAL | `AlbumService.create`: all 6 method calls found; 2 arrow-const helper calls missing. |
| Inheritance (`extends`) | PASS (store) / PARTIAL (MCP) | 51 of 51 `EXTENDS` for `BaseService`. MCP shows 20+ with no paging. |
| Implementations (internal interface) | PASS (structured) | `MemoryRepository IMPLEMENTS IBulkAsset`. The text gives the count only. |
| Implementations (external interface) | FAIL (environment) | No node for `NestInterceptor`, `CanActivate` or `OnModuleInit`, because dependencies were not installed |
| Implementations (false positive) | Observed | `AlbumService.create` → "implementation of" `BaseService.create`, a static factory with the same name |
| Cross-file dependencies | PASS | C2 spans `middleware/` → `services/` → `repositories/`. C1 spans route → table. |
| Module relationships | PASS | 91 external packages as `module` nodes (e.g. `kysely`, 20+ dependents). File → package `DEPENDS_ON`. |
| Route → handler | PASS | 303 routes, 0 unresolved. `POST /api/albums` → `AlbumController.createAlbum` (high). |
| Data access (Kysely query builder) | FAIL | No `READS_FROM`/`WRITES_TO` from repository methods. Detected only from raw SQL in migrations and `.sql` snapshots. |
| Job/queue handling (`@OnJob`) | FAIL | `messaging.queueCount = 0`. The handler is reachable only as a generic reference. |

---

## Graph vs Text Search

Each row asks the same question both ways, through MCP. "Text" means
`search_code` (plus `get_source` where needed). "Graph" means
`search_graph`/`get_node`/`trace_path`.

| Question | Text search | Graph retrieval | Observed difference |
| --- | --- | --- | --- |
| T1: Where is `AlbumService`? | `class AlbumService`: 1 hit, correct | 1 call, correct | Equal |
| T2: What calls `AlbumService.create`? | `AlbumService.create`: 0 hits. `albumService.create(`: 1 hit (workflow only). **Missed the controller**, which calls `this.service.create(…)`. | Both production callers, 2 calls | Graph found a caller that text could not, because the receiver variable name is arbitrary |
| T3: What calls `AuthService.authenticate`? | `.authenticate(`: 26 matches, including 3 unrelated `authenticate` methods and specs | Exactly the 2 real callers | Graph produced far less irrelevant context |
| T4: Usages of `AssetRepository.getById` | 7 matches, missing `this.getById` inside the repository | 8 of 8 in the store, but text shows 5 | Store more complete; MCP text less complete than text search |
| T5: Handler of `POST /albums` | `@Controller('albums')`: 1 hit, then the file must be read to find `@Post()` | Route node → handler in 2 calls, once the `/api` prefix is known | Graph gave the exact method; text gave the file |
| T6: Guard → session lookup flow | 6 calls, about 4.8k chars, 602 ms total | About 3 calls, about 1.7k chars, trace itself 62 ms | Graph needed fewer calls and less context, and showed the chain directly |
| T7: What extends `BaseService`? | 50 of 56 matches shown, complete enough to count | 20+ shown (capped) | Text search more complete through MCP |
| T8: What implements `IBulkAsset`? | 1 hit, correct | Count in text, name only in `structuredContent` | Text clearer in the text channel |
| T9: What writes the `album` table? | `insertInto('album')`: 1 hit, `AlbumRepository.create:325` | Only `.sql` snapshots and migrations | **Text found the implementation; graph did not** (Kysely gap) |
| T10: Handler for `AssetGenerateThumbnails` | `name: JobName.AssetGenerateThumbnails,`: 20 matches (producers, specs, handler). Needs the exact `@OnJob(` form to isolate the handler. | References (structured only) include the handler, mixed with producers | Neither isolates the handler in one call |
| T11: What does `AlbumService.create` call? | `get_source` of the method shows all 8 calls, as text | 6 resolved targets, typed to their classes; 2 helpers missing | Graph resolved *which* `create` is called; text was complete but unresolved |

What these cases show:
- The graph was clearly ahead when receiver names were arbitrary (T2), when
  method names were shared (T3), and for multi-hop flows (T6).
- Text search was ahead for Kysely data access (T9), and whenever the MCP
  output capped or omitted a section the store had (T7, T8).

---

## Freshness Validation

Run on the real clone through `get_index_status` and `index_project`. Every
change was reverted, and the clone's `git status` was clean at the end.

| Scenario | Observed |
| --- | --- |
| Baseline | `ready`, `stale=false`, `changedFiles=0` |
| Uncommitted edit (new method in `album.service.ts`) | `stale`, 1 file, `changedPaths=[src/services/album.service.ts]` |
| → `index_project` | `started`, `freshness=stale`, `changedFiles=1` |
| → immediately after | `indexing` |
| → wait | `ready`, `stale=false`, after ≈12 s |
| → query the changed code | `search_graph validationProbe` → `AlbumService.validationProbe` at line 101. `get_node` → callee `AlbumRepository.getById`. |
| Revert the edit, re-index | `stale` → re-index → `ready` |
| Committed edit | `stale`, 1 file, indexed `a4af862…`, current `e7fe027…` |
| `git reset --hard` back to the indexed commit | `ready` with **no re-index** (content-based comparison) |
| Commit, re-index, then rewind history | `stale`, indexed `9f1c7b8…`, current `a4af862…`, 1 file. Re-index → `ready`. |
| Untracked file added | `stale`, `changedPaths=[src/services/validation-added.service.ts]`. Removed → `ready`. |
| File deleted (`src/utils/preferences.ts`) | `stale`, 1 file. Restored → `ready`. |
| Change under `node_modules/` | `ready` (ignored, as designed) |

All scenarios behaved as specified.

---

## Performance

Latency was measured client-side by the MCP client, per tool call, over the
whole session. It includes MCP stdio framing and the HTTP round trip, but not
process start-up.

| Tool | n | min | median | p90 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| `search_graph` | 45 | 34 ms | 42 ms | 73 ms | 113 ms |
| `get_node` | 23 | 9 ms | 40 ms | 59 ms | 71 ms |
| `trace_path` | 5 | 30 ms | 37 ms | 99 ms | 99 ms |
| `get_source` | 7 | 3 ms | 11 ms | 23 ms | 23 ms |
| `search_code` | 14 | 128 ms | 133 ms | 238 ms | 255 ms |
| `get_index_status` (includes freshness check) | 56 | 102 ms | 129 ms | 154 ms | 232 ms |
| `index_project` | 5 | 17 ms | 167 ms | 202 ms | 202 ms |

**Indexing** (from worker logs):

| Run | Total | SCIP | Persist |
| --- | ---: | ---: | ---: |
| First index | 6.6 s | 3.0 s | 2.3 s |
| Re-index (4 runs) | 10.9–11.5 s | 2.9–3.1 s | ≈6.8 s |

- Every re-index rebuilds the whole graph. A one-line change costs the same
  as a full rebuild (about 11 s here).
- Persisting a *replacement* graph (delete, then insert about 51k edges) took
  about 3× longer than the first insert.

**Not measured:** memory use, performance with dependencies installed (SCIP
type resolution would do more work), concurrent clients, and repositories
larger than this one.

---

## Failures

| ID | Failure | Where observed |
| --- | --- | --- |
| F-1 | `get_node` text shows only the top 5 callers and callees. It prints no list for references, implementations or dependents. Every section is capped at 20, with no paging or section parameter. | B2, B4, D1, D3, E1, E2 |
| F-2 | `search_graph` doesn't expose the API's `nodeTypes`, `categories` or `file` filters. A `types` argument was silently ignored. | A3, D2 |
| F-3 | Broad queries rank primary classes below type-literal, enum and test nodes | D2 |
| F-4 | Substring matching misses routes without the global prefix (`POST /albums` vs `POST /api/albums`) | A3 |
| F-5 | Kysely query-builder table access is not detected, so repository methods have no reads/writes edges | C1, C4, T9 |
| F-6 | Calls to arrow-function consts are stored as `REFERENCES`, not `CALLS` | C3, B1 callees |
| F-7 | `@OnJob` job → handler link is not modelled (0 queues, 0 events) | D3, T10 |
| F-8 | No node for external interfaces when dependencies are not installed | E3 |
| F-9 | False `implementation` edge between an instance method and a same-named static method on the base class | B1 |
| F-10 | 66 spurious or historical table nodes: pre-rename migration tables (`albums`, `assets`), SQL artifacts (`OLD`, `cte`, `inserted_rows`, `columns`). All 68 real tables present. | C1 lookup, table search |
| F-11 | `DEPENDS_ON src`: the path alias is recorded as an external package | Imports check |
| F-12 | Call edges carry no call-site location, so the exact line needs text search | F1 |
| F-13 | Re-indexing is a full rebuild, and persistence of the replacement graph is ~6.8 s | Freshness runs |

---

## Root Cause Classification

| ID | Class | Reasoning |
| --- | --- | --- |
| F-1 | 5 — MCP interface problem | The data is complete in the store (verified 8/8, 11/11, 51/51). Only the tool's rendering and limits hide it. |
| F-2 | 5 — MCP interface problem | The API route supports the filters; the tool does not pass them through |
| F-3 | 4 — Retrieval/ranking problem | Plain substring matches on synthetic child nodes outrank the declarations they belong to |
| F-4 | 4 — Retrieval/ranking problem | Literal matching; no route-path normalisation |
| F-5 | 3 — Missing relationship | The database analyzer covers SQL strings, Prisma and `@Entity`/`@Table`. It does not cover Kysely builder calls, even with literal table names. |
| F-6 | 2 — Graph construction limitation | SCIP reports the symbol as a variable, and the graph builder only emits `CALLS` for function/method symbols |
| F-7 | 3 — Missing relationship (10 — repository-specific pattern) | Immich uses its own `@OnJob` decorator plus a `JobName` enum. The messaging analyzer doesn't recognise it. |
| F-8 | 10 — Repository/environment issue | Indexed without `node_modules`; not a CodeRAG defect as such |
| F-9 | 2 — Graph construction limitation | A SCIP override/implementation relationship is taken at face value for a static/instance name clash |
| F-10 | 1 — Parser limitation (SQL) + 2 — graph construction | CTE and pseudo-table names are parsed as tables. Migration history isn't reduced to the current schema. |
| F-11 | 2 — Graph construction limitation | The import analyzer doesn't consult tsconfig `paths` |
| F-12 | 2 — Graph construction limitation | SCIP-derived edges don't retain occurrence ranges |
| F-13 | 8 — Performance problem | No incremental indexing; bulk delete and re-insert on every run |

**Not observed:**
- **6 — Context problem.** No response exceeded about 4.9k characters.
- **7 — Staleness problem.** Every freshness scenario was correct.
- **9 — LLM/tool-selection problem.** Not testable in this setup; see Known
  Limitations.

---

## Recommended Next Engineering Work

Ranked by observed impact in this test.

1. **MCP tool output design** (F-1, F-2). This caused 5 of the 8 partials, and
   in each of them the graph already held the complete, correct answer.
   - `get_node`: render the references, implementations and dependents lists
     in the text.
   - Let the caller ask for one section with paging, e.g. all 51 subclasses.
   - Expose `nodeTypes`/`file` on `search_graph`.
   - Show spec-file callers separately from production callers.

   This changes presentation, not retrieval, so the retrieval evaluation
   should stay at 49/49.
2. **Relationship extraction** (F-5, F-6, F-7).
   - Kysely builder table access and arrow-const `CALLS` would have turned C1,
     C3 and C4 into correct answers, and they generalise beyond Immich:
     query builders and `export const fn = () =>` are common in modern TS.
   - `@OnJob`-style job handlers are more repository-specific; handle them
     after the other two.
3. **Ranking** (F-3, F-4): prefer declarations (classes, methods, routes) over
   synthetic type-literal members for broad queries. This was observed once
   (D2), with a clear cause.
4. **Performance / incremental indexing** (F-13): an 11 s re-index is
   acceptable at this size but scales with the graph. Lower priority until a
   larger repo shows it hurting.

**Not recommended on this evidence:**
- **Semantic/vector retrieval.** No failure here was caused by a vocabulary
  mismatch that embeddings would fix. Every failure had a structural or
  interface cause.
- **Multi-language support.** Out of scope for a single-language repo.
- **Context optimisation.** Responses were small.

---

## Known Limitations

- **One repository**, one commit, one language. The results may not
  generalise to other frameworks or larger monorepos.
- **Dependencies were not installed.** This removes external-type nodes (F-8)
  and probably makes SCIP faster than in a developer checkout.
- **Tool selection was performed by the evaluator**, through a scripted MCP
  client, not by a model in an interactive Claude Code session. So tool
  *choice* by an LLM (category 9) is untested. "Correct" means the tools
  returned the information needed, which an evaluator then verified.
- **Whether a client shows `structuredContent` to the model** decides whether
  D3 and E2 are partial or correct in practice. They are counted as partial.
- **23 questions** written by the evaluator after surveying the code.
  Coverage reflects what was asked.
- **Latency is from a single local machine**, with the API and Postgres local
  and one client. There were no concurrent-load or memory measurements.
- **The clone was sparse and partial** (`--filter=blob:none`). Freshness git
  operations worked unchanged, but a full clone was not tested.
- **The validation project** (`server`, id `d459a880-…`) is still registered
  in the local dev database, pointing at the scratch clone. Delete it from the
  web UI or with `DELETE /api/projects/:id` once it's no longer needed.

---

## Re-run after MCP surface changes

```text
Snapshot:     same clone, commit a4af86282d13…, working tree clean, same project id
Graph:        9,394 nodes / 51,391 edges, freshness current (unchanged)
Questions:    the same 23, the same first tool calls, the same scoring rule
Change under test: MCP output only — get_node totals + paging, search_graph filters
Unchanged:    graph construction, ranking, node identity, edge semantics, trace_path
```

**Scoring rule, unchanged:** *Correct* means the answer was available in the
tool's **text** output, verified against the source. Where the new output told
the agent more existed and how to fetch it, the agent followed that pointer; the
extra calls are counted.

### What changed in the surface

- `get_node` reports the **exact total** of every section, lists up to 10
  entries of every section in the text (references, implementations, members
  and all architectural links included), and states "showing N of M" with the
  follow-up call whenever a list is cut.
- `get_node` has a **page mode** (`relationship`, `limit`, `offset`) backed by
  per-section API routes that now page and report a true `meta.total`.
- `search_graph` exposes the API's `nodeTypes` and `file` filters, and `offset`.
- Two API defects found in the audit were fixed, because they would otherwise
  have made the new surface lie:
  - the search `file` filter was applied to the fetched page only, then
    reported as the total;
  - node detail capped all sections under one shared row budget, so a crowded
    relationship could empty later ones. Now each section is capped on its own;
    the rows returned are identical whenever nothing was starved.

### Before / after

| # | Before | After | Calls after | Reason for change |
|---|---|---|---:|---|
| A1–A4 | ✅ | ✅ | same | — |
| B1 | ✅ | ✅ | same | `total: 3` now stated |
| B2 | ⚠️ 5 of 14 callers visible | ✅ all 14, including all 8 non-test call sites | 2 | Exact total, then one page from the offset given |
| B3 | ✅ | ✅ | same | — |
| B4 | ⚠️ 5 of 11 | ✅ 11 of 11 | 2 | Same |
| C1 | ⚠️ class-level path | ⚠️ unchanged | same | Relationship gap (Kysely), not output |
| C2 | ✅ | ✅ | same | — |
| C3 | ⚠️ util call missing | ⚠️ unchanged | same | Relationship gap (arrow-const calls), not output |
| C4 | ❌ | ❌ unchanged | 1 | All 15 data links now visible; none is a repository method (Kysely gap) |
| D1 | ✅, one strategy hidden by the 5-item cap | ✅, all 6 callees in the graph output | 1 (was 3 with source read) | Preview is 10, with the total |
| D2 | ⚠️ primary classes ranked #33–#40 | ✅ service #4, controller #9, repository #10 of 12 | 1 | `nodeTypes: ["class"]`. Ranking unchanged. |
| D3 | ⚠️ references only in structured output | ✅ handler visible in the text references; `get_source` confirms `@OnJob` | 3 | References now listed. The graph still has no handler relationship. |
| E1 | ⚠️ 20+ of 51 | ✅ 51 of 51, identical to grep | 2 | Exact total, then one `subtypes` page |
| E2 | ⚠️ count only | ✅ `MemoryRepository ← IMPLEMENTS` in the text | 1 | Implementations listed |
| E3 | ❌ | ❌ unchanged | same | Environment (no `node_modules`) |
| E4, F1–F4 | ✅ | ✅ | same | — |

| Outcome | Before | After |
| --- | ---: | ---: |
| Correct | 13 | 19 |
| Partial | 8 | 2 |
| Fail | 2 | 2 |

Same 23 questions, same snapshot, same scoring rule. This is a count on this
test set, not an accuracy rate.

**All six partials attributed to MCP output are resolved:** B2, B4, D2, D3, E1
and E2. D1 was already correct and no longer needs a source read. The remaining
four (C1, C3, C4, E3) are the relationship-extraction and environment gaps
identified in the baseline; the new output shows their absence plainly (C4 lists
all 15 data links, none from a repository method) instead of hiding it.

### Cost

| Measure | Before | After |
| --- | ---: | ---: |
| `get_node` overview, median text size | 453 chars | 829 chars |
| `get_node` overview, largest (`BaseService`) | 1,000 chars | 3,801 chars |
| `get_node` overview, median latency | 40 ms | 34 ms |
| `get_node` page (up to 100 entries), median latency | — | 56 ms |
| `search_graph`, median latency | 42 ms | 39 ms |

### Relationship extraction — investigation only, nothing implemented

**Kysely** (C1, C4, T9):
- **Scale:** about 729 builder call sites in this repo carry a literal table
  name (359 `selectFrom`, 74 `insertInto`, 65 `updateTable`, 60 `deleteFrom`,
  171 joins) across 41 files, 38 of them in `repositories/`. That is essentially
  the whole data-access layer, and today the graph sees none of it.
- **Fit:** the database analyzer already turns each detected access
  (table, read/write, file, line) into `READS_FROM`/`WRITES_TO` edges from the
  enclosing method, plus derived class-level edges, with evidence. A Kysely
  detector would only produce those access records. No new node type, edge type
  or schema change is needed.
- **Care needed:**
  - `.with('album', …)` CTE aliases (31 here) must not become tables;
  - `'album as a'` aliases must be stripped;
  - matches should be restricted to known tables, or the 66 spurious table
    nodes already seen will grow.

**Arrow-function helpers** (C3, incomplete callees in B1):
- **Where it happens:** `CALLS` vs `REFERENCES` is decided in
  `scip-graph-builder.ts` purely by the target's node type (`function`/`method`).
  `export const fn = () =>` is kind `variable`, so all its uses become
  `REFERENCES`.
- **Fit:** the TypeScript refiner already re-reads declarations to correct
  kinds. It could recognise arrow/function-expression initialisers.
- **Catch:** node type is part of node identity (`model/identity.ts`).
  Re-typing about 139 helpers would change their ids once on re-index. The
  alternative is to keep the type and mark them callable in metadata.

**Recommendation: Kysely extraction next.** On this evidence it closes one fail
and one partial directly, and it lights up a whole question class ("what
touches table X", "trace a route to its writes") across about 729 call sites.
The arrow-function change fixes one partial, and needs a node-identity decision
first.

---

# Kysely Database Access Extraction

```text
Snapshot:   same clone, commit a4af86282d13…, working tree clean, same project id
Change:     a Kysely detector feeding the existing database analyzer
Unchanged:  MCP output, ranking, node identity, node types, edge types,
            arrow-function handling (export const fn = () => … is still a variable)
```

## Motivation

After the MCP surface work, two benchmark questions still failed for one
reason. C1 (route → table) and C4 (what writes a table) both depend on
repository methods having `READS_FROM` / `WRITES_TO` edges. In Immich those
methods build every query with Kysely (`this.db.insertInto('album')`), which the
database analyzer did not recognise. The graph could reach `postgresql.album`
only through SQL snapshot files, migrations and a class-level `USES` edge.

## Existing Database Access Model

Reused as it was:

1. **Access record.** A detector produces
   `{ table, access: read|write, statement, file, line }`, the same record the
   SQL-string and Prisma detectors produce.
2. **Read/write.** `read` becomes `READS_FROM`, `write` becomes `WRITES_TO`.
   `metadata.statement` carries `SELECT` / `INSERT` / `UPDATE` / `DELETE` /
   `JOIN`, in the SQL detector's vocabulary, and `metadata.detector` names the
   detector.
3. **Evidence.** The existing `EdgeEvidence` record: `source: database-analyzer`,
   `method: ast`, `file`, `line`, `column`, `matched: <table>`. The existing
   basis `astDirect` ("an unambiguous syntactic fact", high confidence) is used.
4. **Table names.** The SQL detector's normaliser, now exported and shared: it
   strips quotes and schema prefixes and validates identifiers. Aliases
   (`'album as a'`) are stripped first.
5. **Nodes and edges.** Through `tableDraft()`, so a table reached by SQL and by
   Kysely is **one node**; a test asserts this. Plus the existing derived
   class-level edge. Duplicate accesses merge into one edge with `occurrences`.

The only new code is `packages/analysis/src/detectors/kysely.ts` and about 60
lines in `database.analyzer.ts` that call it.

## Supported Kysely Patterns

The methods were chosen from what Immich actually calls, not from Kysely's whole
API. A module is only scanned when it imports `kysely` (or `kysely-*` /
`nestjs-kysely`); all 41 production files with builder calls do.

| Kysely Pattern | Detected | Table Relationship | Evidence | Notes |
|---|---|---|---|---|
| `selectFrom('t')` | ✅ | `READS_FROM` (SELECT) | file, line, column of the literal | also `selectFrom(['a', 'b'])`, each literal |
| `insertInto('t')` | ✅ | `WRITES_TO` (INSERT) | same | |
| `updateTable('t')` | ✅ | `WRITES_TO` (UPDATE) | same | |
| `deleteFrom('t')` | ✅ | `WRITES_TO` (DELETE) | same | |
| `innerJoin('t', …)` / `leftJoin` / `crossJoin` | ✅ | `READS_FROM` (JOIN) | same | a subquery in the table position is scanned, not treated as a table |
| `'t as alias'`, `'schema.t'` | ✅ | as above, on `t` | same | normalised like SQL |
| `with('name', …)` / `withRecursive` | CTE scope | **none** | — | the name is query-scoped, see below |
| `selectFrom(variable)`, `(call())`, `` (`${x}_t`) `` | ❌ by design | none | — | counted as non-literal, never guessed |
| `.from('t')`, `.table('t')`, `.using('x')` | ❌ by design | none | — | in Immich these are UPDATE…FROM (5 uses, one a CTE), `eb.table()` row references and index methods (`gist`, `gin`) |

## CTE Handling

A CTE name is scoped to its query, following the builder chain:

- **After the link.** The name enters scope *after* its `with(...)` link, so a
  non-recursive CTE's own body still means the physical table. This is exactly
  Immich's `.with('album', (db) => db.insertInto('album'))`, which writes the
  real `album`.
- **Visibility.** It stays visible to later links, and to subqueries built
  inside those links' callbacks.
- **Recursive CTEs.** `withRecursive` puts the name in scope inside its own body.
- **Column lists.** `with('ranked(id, rank)', …)` is recognised.
- **No leakage.** The name never reaches an unrelated query elsewhere in the
  file; there is no file-wide set.
- **Through variables.** A builder carried through a variable
  (`let query = db.with('deleted_ocr', …); query = query.with(…)`) keeps its CTE
  names within the same function. This can only suppress edges, never create
  one.
- **Unreadable names.** If a CTE name isn't a literal, every reference it could
  shadow is skipped, not guessed.

**Attribution.** Accesses are attributed to the enclosing declaration read from
the AST (method, function, constructor, accessor, or function-valued variable),
matched to the graph node spanning exactly those lines. The first end-to-end
test found why this is needed. SCIP emits a node for the shorthand property in
`.set({ albumName })`, and the shared line-based lookup attributed the one-line
`update()` method's write to that synthetic node. Where no node spans the
declaration, the existing `attribute()` is used unchanged.

## Evidence

Every Kysely edge carries `source: database-analyzer`, `confidence: high`,
`method: ast`, the file, the **line and column of the table literal**, and
`matched`. Derived class-level edges carry `derivedFromContainer` (medium), as
for SQL. For example, `AlbumRepository.create → WRITES_TO album` points at
`src/repositories/album.repository.ts:325`, the `insertInto('album')` inside the
first CTE.

## Tests

`packages/analysis/tests/kysely.test.ts`, 29 tests:

- **Detector, 19 tests:**
  - each statement kind (1–4), several tables, joins and long chains (5–7);
  - aliases and schema prefixes, and literal arrays;
  - dynamic names ignored (8);
  - one CTE (9), several CTEs (10), a CTE shadowing a real table (11);
  - CTE confined to its own query; recursive CTE; column-list CTE; CTE carried
    through a variable; unreadable CTE name skipped;
  - nested subqueries inheriting scope (12);
  - look-alike methods ignored;
  - literal line and column (14);
  - duplicates reported per occurrence (15).
- **Pipeline, 10 tests,** over the new `test-repositories/kysely-sample` with a
  real SCIP index (`packages/scip/tests/fixtures/kysely-sample.scip`), going
  through the real refiner, builder and analyzers:
  - only the existing `table` node type, no CTE-named tables;
  - the correct enclosing method (13), including a one-line method;
  - writes, not reads, for a table-shadowing CTE;
  - a table named by a variable produces nothing;
  - duplicates merge into one edge with `occurrences: 2`;
  - the evidence record;
  - the class-level derived edges;
  - one table node shared with the SQL detector;
  - controller → service → repository → table through the call graph.

The three retrieval-evaluation fixtures are untouched.

## Immich Validation

Re-indexed through `index_project` (forced) at `a4af862`.

| Measure | Before | After |
|---|---:|---:|
| Nodes | 9,394 | 9,395 |
| Edges | 51,391 | 52,324 |
| `READS_FROM` edges | 280 | 960 |
| `WRITES_TO` edges | 256 | 508 |
| Table nodes | 134 | 135 |

| Kysely detection | Count |
|---|---:|
| Table accesses detected (occurrences) | 827 (718 in 41 production files, 669 of them in 38 files under `repositories/`; 109 in 21 test files) |
| CTE references correctly not treated as tables | 22 |
| Non-literal table arguments ignored (variable, call, subquery) | 32 |
| Skipped as undetermined (unreadable CTE name in scope) | 3 |
| Method-level edges | 687 (621 methods, 36 functions, 30 function-valued variables) — no edge on a synthetic node |
| Class-level derived edges | 245 |
| Distinct tables reached | 53 |

**Cross-check.** Grep finds 741 production calls of the seven supported methods
with a literal first argument. 718 detected + 22 CTE references + 3 undetermined
= 743. The investigation estimated about 729 call sites across 41 files; the
detector found 41 production files. Test-file accesses mostly sit in `it(...)`
callbacks with no declaration node, so they produce no method edge, as for SQL.

**One overlap, not a loss.** In `AssetRepository.getByDayOfYear`, a raw SQL
fragment (`` sql`… from asset` ``) and `selectFrom('asset')` both reach `asset`.
They merge into one `READS_FROM` edge with `occurrences: 2`, labelled by the
first detector. The graph does not distinguish where an edge came from.

**Verified examples against the source:**

| Statement | Edge | Source |
|---|---|---|
| INSERT | `AlbumRepository.create → WRITES_TO album` | `album.repository.ts:325` `insertInto('album')` inside `.with('album', …)` |
| UPDATE | `AlbumRepository.update → WRITES_TO album` | `album.repository.ts:363` `updateTable('album')` |
| DELETE | `AlbumRepository.delete → WRITES_TO album` | `album.repository.ts:373` `deleteFrom('album')` |
| SELECT / JOIN | `AssetRepository.getByDayOfYear → READS_FROM asset_job_status, asset_file` | lines 483, 490, inside a lateral-join subquery of a CTE |
| CTE shadowing | `AlbumRepository.create` has no `READS_FROM album` | the later `selectFrom('album')` reads the CTE, correctly not the table |

**C1:**
```
POST /api/albums →ROUTES_TO→ AlbumController.createAlbum →CALLS→ AlbumService.create
  →CALLS→ AlbumRepository.create →WRITES_TO→ postgresql.album
  (database-analyzer/high, album.repository.ts:325)
```

**C4:** `get_node(postgresql.album, relationship: "databases")` returns 46 links.
The code writers are the seven `AlbumRepository` methods (`create`, `update`,
`delete`, `deleteAll`, `restoreAll`, `softDeleteAll`, `updateThumbnails`) —
exactly the seven `insertInto` / `updateTable` / `deleteFrom('album')` sites
grep finds in `album.repository.ts` — plus migration `up`/`down` functions and
one test helper. 15 code readers are listed alongside.

## False Positive Audit

- **Declared tables.** Of the 53 tables reached by Kysely edges, 52 are declared
  `@Table`s. The 53rd, `kysely_migrations`, is physical: Kysely's migration
  table, declared in `DB` (`schema/index.ts:202`) and read by
  `DatabaseRepository` (`database.repository.ts:271`). It is the only new table
  node (134 → 135).
- **CTE names.** Immich has 28 distinct CTE names. 4 coincide with real tables
  (`album`, `album_asset`, `album_user`, `asset`). **None of the 24 CTE-only
  names is reached by a Kysely edge.**
- **Pre-existing CTE-named nodes.** 11 table nodes named like CTEs (`agg`,
  `cte`, `res`, `today`, …) exist. All of them existed before this change, from
  the SQL analyzer reading `src/queries/*.sql`. They carry no Kysely detector
  and are the baseline's F-10, unchanged.
- **Other names.** No query alias (`as a`), temporary name or migration-only
  name was introduced by the Kysely detector. All 68 declared tables are still
  present.

**False positives introduced: 0.**

## Performance

| Metric | Before | After | Notes |
|---|---:|---:|---|
| `database-analyzer` duration (median of 3, controlled harness) | 54 ms | 91 ms | the only measured cost of the detector |
| All analyzers (assembler, median of 3) | 932 ms | 830 ms | within run-to-run noise |
| First index, total (new project, fresh insert) | 6.6 s | 8.0 s | SCIP 3.0 → 3.6 s and persist 2.3 → 2.9 s account for the difference; neither runs the detector |
| Persist, fresh insert, same DB conditions | 2.4–2.8 s (without Kysely edges) | 2.4–2.9 s (with) | persist-bench, 2 rounds each |
| Persist, replace, same DB conditions | 10.1–11.7 s (without) | 10.6–15.2 s (with) | replace cost is dominated by database state, not by the 933 extra edges |

Re-indexing this project took 13.3–14.5 s during this work, against 11 s
earlier. The controlled persist benchmark shows the replace path costs about
10 s with or without the Kysely edges, so the increase is database state (many
delete-and-reinsert cycles of about 52k edges today), not this change. That is
the baseline's F-13 (no incremental indexing), unchanged.

## MCP Benchmark Before/After

The same 23 questions, the same snapshot, the same calls, the same scoring rule
(the answer must be in the tool's text output, verified against the source).

| Metric | Before | After |
|---|---:|---:|
| Correct | 19 | 21 |
| Partial | 2 | 1 |
| Failed | 2 | 1 |

| # | Before | After | Reason |
|---|---|---|---|
| C1 | ⚠️ class-level path, no data edge from any method | ✅ method-level chain to `WRITES_TO album` (high) | Kysely extraction |
| C4 | ❌ only SQL snapshots and migrations | ✅ all 7 repository writers, plus migrations and one test helper | Kysely extraction |
| All others | unchanged | unchanged | 21 re-checked programmatically |

## Remaining Failures

- **C3 (partial):** calls to `export const addAssets = (…) =>` are stored as
  `REFERENCES`, so the helper that does the bulk insert is missing from
  `AlbumService.addAssets`'s callees. Deliberately untouched in this change:
  fixing it involves node identity (see the previous section).
- **E3 (fail):** `NestInterceptor` has no node because the repository was
  indexed without `node_modules`. This is environment, not extraction.
- **Kysely patterns left out on purpose:**
  - `.from('t')` (UPDATE…FROM: 4 uses — 2 in `person.repository`, 1 in
    `duplicate.repository`, 1 in a migration — plus 1 on a CTE);
  - `eb.table('t')` (a row reference to a table already in scope);
  - table names passed through variables (32 non-literal arguments);
  - accesses inside helper functions that receive a builder whose CTEs were
    defined by the caller — not observed in Immich, but out of the detector's
    lexical view.
