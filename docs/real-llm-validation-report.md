# Real LLM Validation Report

```text
Question:  Can a real coding agent use CodeRAG to understand a real production repository?
Consumer:  Claude Code (headless), choosing its own CodeRAG MCP tools
Target:    immich-app/immich, server/ package, commit a4af862
Date:      2026-09-24
```

This is a baseline, not a benchmark. No production code was changed before,
during or after the runs. Every number below was measured in this run. Where
something could not be measured, the report says so.

---

## Summary

| | |
| --- | --- |
| Questions | 12 (the Q1–Q12 set, asked verbatim) + 1 supplementary stale-index run |
| Result | **12 PASS · 0 PARTIAL · 0 FAIL**; supplementary run also PASS |
| Tool calls | 266 across the 12 questions; 0 tool errors; 0 schema/validation errors |
| Hallucinations | No material ones. Four minor factual slips (miscounts, one over-generalisation), listed per question |
| Cost / time | $8.86 and 18 min wall time for the 12 runs (one session each) |
| Where the graph carried the answer | 7 of 12 graph-led, 2 mixed, 3 text-led (see [§4](#4-question-results)) |

What the scores do and do not mean:

- **Every answer was correct and backed by source evidence.** For 3 of the 12
  (auth, interceptors, jobs), the graph contributed little. The agent got there
  by falling back to `search_code` + `get_source`. The rubric counts that as a
  successful fallback, but it does not show graph value.
- **The known limitations hurt cost, not correctness.** Arrow-function helpers
  (H) and external interfaces (G) never produced a wrong answer. The agent
  always compensated, and did so by reading source. The two questions that
  exercised these gaps were among the most expensive (Q07: 35 calls, $1.28).
  Q04, the most expensive run, hit the arrow-function node-type gap as well.
- **n = 1 per question, one model, built-in tools disabled.** See
  [§1 Method](#method) for why that matters.

---

## 1. Environment

| Property | Value |
| --- | --- |
| CodeRAG commit | `01dd70643978a31c7ecc24615b2a591d5070f408` (`dev`, clean working tree) |
| Immich commit | `a4af86282d13354bd21bbaf7a2ffb7fae15e8cf2`, same snapshot as [real-repository-validation-report.md](real-repository-validation-report.md) |
| Immich snapshot | Shallow sparse clone of `server/`. 728 tracked files, 674 source files (TS 671, JS 3), 113,604 lines of TS/JS, 6.0 MB on disk |
| Index | Analysis `8476a090…`, completed 2026-09-24 08:26 UTC, state `current`, 0 changed files. Kysely detector present in the index (508 `WRITES_TO`, 960 `READS_FROM` edges) |
| Graph nodes | 9,395 |
| Graph edges | 52,324 (REFERENCES 26,474 · CONTAINS 9,283 · CALLS 6,280 · IMPORTS 3,993 · DEPENDS_ON 1,869 · EXPORTS 1,634 · READS_FROM 960 · ROUTES_TO 606 · WRITES_TO 508 · …) |
| Index size | ~3.8 MB of node rows + ~13 MB of edge rows for this project (`pg_column_size`). The whole database is 238 MB across all projects |
| MCP server | The existing [`.mcp.json`](../.mcp.json): `node ${CLAUDE_PROJECT_DIR:-.}/apps/mcp/dist/server.js`, stdio, built `apps/mcp/dist` |
| Services | Existing API on `:3001` (healthy, DB ok), PostgreSQL on `:5433`, worker started with `pnpm dev:worker`. `pnpm dev:all` was not re-run because an API was already bound to `:3001`, and a second one would conflict |
| Agent | Claude Code CLI `2.1.278`, headless (`claude -p`), model reported by the session as `claude-opus-5[1m]` |

### Method

Each question ran in a **fresh, independent Claude Code session**:

```bash
cd <immich>/server
CLAUDE_PROJECT_DIR=/Users/akash/Documents/ProjectX/code-graph \
claude -p "<question verbatim>" \
  --mcp-config /Users/akash/Documents/ProjectX/code-graph/.mcp.json --strict-mcp-config \
  --tools "" --allowedTools "mcp__code-graph__*" \
  --disable-slash-commands --no-session-persistence \
  --output-format stream-json --verbose
```

- **The prompt is the question text only.** It gives no tool names, hints,
  expected answers or system-prompt additions. The session's working directory
  was the Immich `server/` directory, so the agent knew where it was the same
  way any Claude Code session does.
- **`--tools ""` disables Claude Code's built-in tools** (Read, Grep, Bash, …).
  The CodeRAG MCP tools were the only way to see the code, so every piece of
  evidence in every answer came through CodeRAG. This is a deliberate choice.
  In a normal session, an agent with Grep and Read available may skip CodeRAG
  entirely. **That behaviour was not measured.**
- **`--strict-mcp-config` + `--disable-slash-commands`** keep the user's other
  MCP servers and skills out of the session. Some of those skills mention a
  different code-graph tool, which would have contaminated the tool choice.
- **`CLAUDE_PROJECT_DIR` was set in the launch environment** because the
  existing `.mcp.json` resolves the server path relative to it (see
  [§3](#3-mcp-connectivity)). The file itself was not changed.
- Runs were 4-way parallel. Full stream-json transcripts were captured for
  every run, including every tool input and result. The tool-call sequences
  are reproduced in [Appendix A](#appendix-a--tool-call-sequences).
- Scoring used ground truth taken independently from the database and from
  the Immich source: edges queried directly in PostgreSQL, symbols and lines
  checked in the snapshot. Specific claims in the long answers (line numbers,
  counts, constraint names, the plaintext password comparison, the
  column-list-less inserts) were spot-checked against the source.

---

## 2. Baseline

| Check | Before | After |
| --- | --- | --- |
| `pnpm typecheck` | exit 0 | exit 0 |
| `pnpm test` | 1312 passed, 73 skipped (1385) | 1312 passed, 73 skipped (1385); 56 files passed, 2 skipped |
| `pnpm evaluate:retrieval --api http://localhost:3001` | 49/49 pass, 0 partial, 0 fail | 49/49 pass |
| Immich index | `current`, indexed commit = current commit = `a4af862`, 0 changed files | `current` (after the supplementary run was reverted), 0 changed files |
| Analysis jobs | 19 COMPLETED, none pending | 19 COMPLETED, none pending. The agent never called `index_project` |

---

## 3. MCP Connectivity

| Check | Result |
| --- | --- |
| First connection, cwd = Immich | **Failed.** Session init reported `code-graph: failed`. `${CLAUDE_PROJECT_DIR:-.}` resolved to the Immich directory, where `apps/mcp/dist/server.js` does not exist. The model then said it had no code-graph tools. |
| With `CLAUDE_PROJECT_DIR` pointed at CodeRAG | **Connected.** `code-graph: connected` in every one of the 13 runs |
| Tools discovered | All 8: `resolve_project`, `get_index_status`, `index_project`, `search_graph`, `get_node`, `trace_path`, `search_code`, `get_source` |
| Schemas visible to the model | Asked to reproduce them, the model listed all 8 tools with every parameter, type, enum and description, verbatim (it miscounted them as "seven" in its opening line). `tools/list` from the server matches: `search_graph` exposes `query/limit/offset/nodeTypes/file`, `get_node` exposes `relationship/limit/offset`, `search_code` exposes `query/limit` only |
| Tool calls executing | 266/266 succeeded; 0 `is_error` results; 0 input-validation rejections |

Observations:

- **Connection from another repo is already documented.** [docs/mcp.md](mcp.md)
  (lines 70–74) says to register the server at user scope with an absolute path
  (`claude mcp add --scope user …`). The failure above came from using this
  repository's `.mcp.json` from another directory, which this validation
  required. The problem is that the failure is **silent** to the model: it saw
  zero tools and said so, with nothing pointing at the cause. This is a P3.
- **The model receives `structuredContent`, not the text rendering.** Every tool
  returns both. The result sizes in the transcripts match the JSON exactly
  (e.g. `get_node AlbumRepository` = 13,928 chars JSON vs 3,720 chars text), so
  the hand-written text form, including its paging hints such as
  `… showing 10 of 40; 30 more — get_node with relationship "callers", offset 10`,
  is never shown to Claude Code. Measured JSON/text ratios: `get_node` 3.7×,
  `search_graph` 2.5×, `search_code` 1.6×, `get_source` 1.4×.

---

## 4. Question Results

"Graph role" is how much of the evidence path ran through graph relationships
(`get_node` sections, `trace_path`, typed `search_graph`), as opposed to
literal search and file reading.

| ID | Question | Result | Graph role | Tools Used (calls) | Main Evidence | Main Gap |
|----|----------|--------|------------|--------------------|---------------|----------|
| Q1 | POST /api/albums flow | PASS | Graph-led | search_graph 3, get_node 4, get_source 8, search_code 2 | Route node → `AlbumController.createAlbum` → callees of `AlbumService.create` → 3 `WRITES_TO` edges from `AlbumRepository.create` (album :325, album_user :328, album_asset :342) | Did not use `trace_path`; walked the chain by hand |
| Q2 | Tables written by AlbumService.create | PASS | Graph-led | get_node 6, get_source 3, search_graph 2, search_code 1 | `databases` section per callee: 3 writes + reads (`user`, `user_metadata`), with evidence lines | Event → handler hop (`AlbumInvite` → `NotificationService.onAlbumInvite`) found only by `search_code` |
| Q3 | Callers of AlbumService.create | PASS | Graph-led | get_node 1, get_source 8, search_code 4 | `callers` = 3 (controller, `WorkflowExecutionService.onPluginLoad`, spec file), complete | Callers carry no call-site line; `search_code` was needed to locate each call |
| Q4 | Authentication architecture | PASS | **Text-led** | get_source 23, search_code 19, search_graph 3 | `search_graph` found both guard classes; everything else came from reading whole files | No `get_node` or `trace_path` at all. `nodeTypes:["function"]` returned 0 for `src/utils/access.ts` (its helpers are `variable` nodes). Most expensive run: 48 turns, $1.93 |
| Q5 | Implementations of BaseService | PASS | Graph-led | get_node 1 (`subtypes`, limit 100), get_source 6, search_code 6, search_graph 3 | All 51 `EXTENDS` in one page; counts cross-checked with `search_code` totals | — |
| Q6 | Classes implementing NestInterceptor | PASS | Text-led (expected: G) | search_graph 1 (0 results), search_code 7, get_source 4 | All 4 local implementers; stated that `NestInterceptor` is external and not a graph node; triple cross-check | Empty `search_graph` result gave no hint that external symbols aren't indexed |
| Q7 | Asset creation flow | PASS | Mixed | get_source 22, search_code 6, search_graph 3, get_node 2 | Complete `callees` of `AssetMediaService.uploadAsset` (14 methods), `AssetRepository.create` → `asset` | Helpers `onBeforeLink`, `isAssetChecksumConstraint`, `mimeTypes`, `requireUploadAccess` found only by reading source. The graph's callees list said `total 14, hasMore false` |
| Q8 | Impact of changing AlbumRepository.create | PASS | Graph-led | get_node 6, get_source 5, search_code 4, search_graph 2 | Callers (2) → their callers (controller, plugin host, 16 medium specs) → 3 `WRITES_TO` | — |
| Q9 | Background job registration → handler | PASS | **Text-led** | get_source 10, search_code 5, search_graph 2, get_node 1 | Only graph hop: callers of `JobRepository.setup` (= `QueueService.onBootstrap`). Chain rebuilt from source | Graph breaks at `emit('JobRun')` → `@OnEvent` handler and at `handlers[name].handler(data)` |
| Q10 | SharedLink persistence | PASS | Mixed | get_source 8, search_code 4, get_node 3, search_graph 2 | `shared_link` table node + its `databases` edges; callers of repository methods | Broad `search_graph "SharedLink"` ranked controller/service/repository at #38/#33/#40 of 168 |
| Q11 | Album layering | PASS | Graph-led | get_source 12, get_node 3, search_code 2, search_graph 2, trace_path 1 | `trace_path` AlbumController → AlbumService → AlbumRepository → `album_asset` (READS_FROM :109); class-level callers/callees/databases | Two minor factual slips (see §5) |
| Q12 | Debugging POST /api/albums DB error | PASS | Graph-led | search_graph 5, search_code 6, get_source 6, get_node 3, trace_path 1 | `trace_path` route → repository; `WRITES_TO` list; 2 callers of `AlbumRepository.create` used as a diagnostic signal | — |
| S1 | Q2 re-asked with `album.repository.ts` edited (uncommitted) | PASS | Graph-led | get_index_status → stale, 1 changed path | Detected stale file, re-read it, reported shifted lines correctly (325→327), asked before re-indexing | — |

### Per-question records

```json
[
 {"question":"Q1","answer_summary":"Controller createAlbum (album.controller.ts:40-49) → AlbumService.create (album.service.ts:101-138, 7 steps) → AlbumRepository.create (album.repository.ts:311-359, 3 chained CTEs) → album/album_user/album_asset; table schema album.table.ts:16-53","code_rag_tools_used":["resolve_project","get_index_status","search_graph","get_node","get_source","search_code"],"relevant_nodes_found":["POST /api/albums","AlbumController.createAlbum","AlbumService.create","AlbumRepository.create","postgresql.album","album_user","album_asset"],"relevant_edges_found":["ROUTES_TO","CALLS x2","WRITES_TO x3"],"source_locations_found":true,"correct":true,"partial":false,"failed":false,"hallucinations":[],"missing_evidence":[],"notes":"trace_path not used"},
 {"question":"Q2","answer_summary":"album (:325), album_user (:328), album_asset (:342) in one CTE statement; reads user/user_metadata; AlbumInvite is async","code_rag_tools_used":["resolve_project","get_index_status","search_graph","get_node","get_source","search_code"],"relevant_nodes_found":["AlbumService.create","AlbumRepository.create","UserRepository.get","UserRepository.getMetadata","NotificationService.onAlbumInvite"],"relevant_edges_found":["CALLS","WRITES_TO x3","READS_FROM x2"],"source_locations_found":true,"correct":true,"partial":false,"failed":false,"hallucinations":[],"missing_evidence":[],"notes":"used get_node relationship=databases on each callee"},
 {"question":"Q3","answer_summary":"3 callers: AlbumController.createAlbum, WorkflowExecutionService.onPluginLoad (plugin host function via wrap), album.service.spec.ts create tests","code_rag_tools_used":["resolve_project","get_index_status","search_graph","get_node","get_source","search_code"],"relevant_nodes_found":["AlbumController.createAlbum","WorkflowExecutionService.onPluginLoad","album.service.spec.ts"],"relevant_edges_found":["CALLS x3"],"source_locations_found":true,"correct":true,"partial":false,"failed":false,"hallucinations":["says 'Four unit tests' then lists five (miscount)"],"missing_evidence":[],"notes":"verified graph callers with search_code 'albumService.create' (matches exactly)"},
 {"question":"Q4","answer_summary":"No Passport; AuthGuard (auth.guard.ts:90) and MaintenanceAuthGuard (:19) as APP_GUARD; @Authenticated metadata; AuthService.authenticate → validate with 4 credential branches; isGranted/requireAccess; OAuth; websocket and maintenance paths; CI invariants in controllers/index.spec.ts","code_rag_tools_used":["resolve_project","get_index_status","search_graph","get_source","search_code"],"relevant_nodes_found":["AuthGuard","MaintenanceAuthGuard","AuthService","OAuthRepository","access.ts helpers"],"relevant_edges_found":[],"source_locations_found":true,"correct":true,"partial":false,"failed":false,"hallucinations":[],"missing_evidence":["no graph relationships used"],"notes":"47 calls, 162,592 chars of tool results, $1.93"},
 {"question":"Q5","answer_summary":"All 51 subclasses; common traits: no own constructor, inherited 55-param DI constructor, BaseService.create cloning, requireAccess idiom, @OnEvent (86)/@OnJob (66), newTestService","code_rag_tools_used":["resolve_project","get_index_status","search_graph","get_node","get_source","search_code"],"relevant_nodes_found":["BaseService","51 subclasses"],"relevant_edges_found":["EXTENDS x51"],"source_locations_found":true,"correct":true,"partial":false,"failed":false,"hallucinations":[],"missing_evidence":[],"notes":"counts verified: 86 @OnEvent, 66 @OnJob, 54 classes, 3 constructors"},
 {"question":"Q6","answer_summary":"4 local implementers (AssetUpload, Error, FileUpload, Logging interceptors); NestInterceptor is from @nestjs/common and not a graph node; answer scoped to server/","code_rag_tools_used":["resolve_project","get_index_status","search_graph","search_code","get_source"],"relevant_nodes_found":["4 interceptor classes"],"relevant_edges_found":[],"source_locations_found":true,"correct":true,"partial":false,"failed":false,"hallucinations":[],"missing_evidence":["IMPLEMENTS edges (external target not indexed)"],"notes":"did not claim graph completeness; explained the limitation unprompted"},
 {"question":"Q7","answer_summary":"POST /api/assets → AssetUploadInterceptor/FileUploadInterceptor → AssetMediaController.uploadAsset → AssetMediaService.uploadAsset (11-step table) → AssetRepository.create (asset) + upserts; helpers onBeforeLink, isAssetChecksumConstraint, requireUploadAccess, mapToUploadFile; async job chain","code_rag_tools_used":["resolve_project","get_index_status","search_graph","get_node","get_source","search_code"],"relevant_nodes_found":["AssetMediaController.uploadAsset","AssetMediaService.uploadAsset","AssetRepository.create","postgresql.asset"],"relevant_edges_found":["CALLS x14 (callees)","WRITES_TO asset"],"source_locations_found":true,"correct":true,"partial":false,"failed":false,"hallucinations":[],"missing_evidence":["helper calls absent from graph callees"],"notes":"did not claim a complete call graph; got helpers by reading the method body"},
 {"question":"Q8","answer_summary":"2 direct callers (AlbumService.create, MediumTestContext.newAlbum) → controller, plugin host, spec assertions, 16 medium specs; downstream 3 table writes, SQL snapshot, mapAlbum return shape, owner invariant","code_rag_tools_used":["resolve_project","get_index_status","search_graph","get_node","get_source","search_code"],"relevant_nodes_found":["AlbumRepository.create","AlbumService.create","MediumTestContext.newAlbum","AlbumController.createAlbum","WorkflowExecutionService.onPluginLoad"],"relevant_edges_found":["CALLS (2 levels)","WRITES_TO x3"],"source_locations_found":true,"correct":true,"partial":false,"failed":false,"hallucinations":[],"missing_evidence":[],"notes":""},
 {"question":"Q9","answer_summary":"@OnJob (decorators.ts:158) → QueueService.onBootstrap → JobRepository.setup (handler map, startup invariants) → startWorkers (BullMQ Worker emits JobRun) → EventRepository → JobService.onJobRun → JobRepository.run → handler","code_rag_tools_used":["resolve_project","get_index_status","search_graph","get_node","get_source","search_code"],"relevant_nodes_found":["OnJob","JobRepository.setup","QueueService.onBootstrap","JobRepository.startWorkers","JobService.onJobRun","JobRepository.run"],"relevant_edges_found":["CALLS QueueService.onBootstrap→JobRepository.setup"],"source_locations_found":true,"correct":true,"partial":false,"failed":false,"hallucinations":[],"missing_evidence":["emit→@OnEvent edge","run→@OnJob handler edge"],"notes":"did not say where the graph stopped helping; fell back silently"},
 {"question":"Q10","answer_summary":"SharedLinkController → SharedLinkService → SharedLinkRepository + SharedLinkAssetRepository → shared_link, shared_link_asset; create/update/remove/addAssets paths with lines; auth reads via getByKey/getBySlug","code_rag_tools_used":["resolve_project","get_index_status","search_graph","get_node","get_source","search_code"],"relevant_nodes_found":["shared_link table","SharedLinkRepository.*","SharedLinkService.*","SharedLinkController"],"relevant_edges_found":["WRITES_TO/READS_FROM shared_link*","CALLS"],"source_locations_found":true,"correct":true,"partial":false,"failed":false,"hallucinations":[],"missing_evidence":[],"notes":"plaintext password comparison claim verified (shared-link.service.ts:39)"},
 {"question":"Q11","answer_summary":"Controller holds only AlbumService; service owns auth/rules/mapping; AlbumRepository (Kysely, 23 members, 0 callees) and AlbumUserRepository; AccessRepository; tables album/album_asset/album_user","code_rag_tools_used":["resolve_project","get_index_status","search_graph","get_node","get_source","trace_path","search_code"],"relevant_nodes_found":["AlbumController","AlbumService","AlbumRepository","AlbumUserRepository","album tables"],"relevant_edges_found":["CALLS","READS_FROM","WRITES_TO"],"source_locations_found":true,"correct":true,"partial":false,"failed":false,"hallucinations":["'~40-parameter' BaseService constructor (actual ~56)","'its 11 callers are all services' — list includes MediumTestContext (test factory)"],"missing_evidence":[],"notes":"only run besides Q12 to use trace_path"},
 {"question":"Q12","answer_summary":"Graph-derived chain route→controller→service→repository→3 tables; start from generated SQL snapshot; failure modes: column-list-less CTE inserts, unnest casts, thumbnail FK, non-DB throws; medium tests via newAlbum as a signal","code_rag_tools_used":["resolve_project","get_index_status","search_graph","get_node","trace_path","get_source","search_code"],"relevant_nodes_found":["POST /api/albums","AlbumRepository.create","MediumTestContext.newAlbum"],"relevant_edges_found":["ROUTES_TO","CALLS","WRITES_TO x3"],"source_locations_found":true,"correct":true,"partial":false,"failed":false,"hallucinations":[],"missing_evidence":[],"notes":"'insert without column list' verified in src/queries/album.repository.sql"}
]
```

---

## 5. Detailed Findings

### Q1 — POST /api/albums flow · PASS · graph-led

- **What it did:** found the route with `search_graph "albums" nodeTypes:[api]`,
  then the controller class. It read the controller, then called
  `get_node relationship:"callees"` on `AlbumService.create`. That exposed
  `AlbumRepository.create`, and `get_node` on the repository method returned the
  three `WRITES_TO` edges with lines. It confirmed each step with `get_source`.
- **Graph evidence:** `POST /api/albums` ROUTES_TO `AlbumController.createAlbum`;
  CALLS `AlbumService.create` → `AlbumRepository.create`; WRITES_TO
  `album`(:325), `album_user`(:328), `album_asset`(:342).
- **Answer quality:** complete. It also covered DTO validation, the access
  filter that silently drops assets, and column defaults.
- **Missing / hallucinated:** nothing material. `trace_path` was not used even
  though it fits the question exactly. Walking by hand still worked.

### Q2 — Tables written by AlbumService.create · PASS · graph-led

- **What it did:** `get_node` on the service method, then
  `get_node relationship:"databases"` on each of four callees, so the
  tables came from the graph rather than from reading SQL.
  It then used `search_code "onAlbumInvite"` to follow the emitted event.
- **Answer quality:** exact tables, lines and statement types. It separated the
  reads from the writes and the synchronous path from the async one.
- **Root cause of the one gap:** the event bus is string-keyed
  (`emit('AlbumInvite')` → `@OnEvent({ name: 'AlbumInvite' })`), and the graph
  does not link it (A). `search_code` filled the gap correctly.

### Q3 — Callers of AlbumService.create · PASS · graph-led

- **What it did:** one `get_node relationship:"callers"` returned the complete
  set of 3. It then verified with `search_code "albumService.create"`, which
  returned the same two production sites, and read each caller.
- **Notable:** the graph found `WorkflowExecutionService.onPluginLoad`, a call
  made *inside an arrow callback* passed to `this.wrap(...)`. So calls
  *from within* arrow functions are attributed correctly. The known H
  limitation concerns calls *to* `export const f = () => …` helpers.
- **Slip:** says "Four unit tests", then lists five.
- **Friction:** `callers` items give the caller's definition line, not the call
  site. Finding `workflow-execution.service.ts:78` took `get_source` on a
  50-line window plus two `search_code` calls (B).

### Q4 — Authentication architecture · PASS · text-led

- **What it did:** `search_graph "auth" nodeTypes:[file]` and
  `search_graph "Guard" nodeTypes:[class,interface]`. The rest was 23
  `get_source` calls (including the whole 38 KB `auth.service.ts`) and
  19 `search_code` calls. It never used `get_node` or `trace_path`.
- **Answer quality:** high and verified: both guards and their `APP_GUARD`
  registration, the decorator metadata layer, the four credential branches in
  `AuthService.validate`, API-key permission scoping, object-level `requireAccess`,
  OAuth, WebSocket and maintenance paths, and the CI invariants in
  `controllers/index.spec.ts`. The spot-checked claims (guard lines, the
  shared-link allowlist test) hold.
- **Why graph use was low:**
  - `search_graph file:"src/utils/access.ts" nodeTypes:["function"]` returned
    **0 results**. That file defines `isGranted`, `requireAccess`, `checkAccess`
    and `requireUploadAccess`, all `export const … = () =>`, and all indexed as
    `variable` (H, surfaced as a node-type problem). The agent switched to
    `search_code` for the rest of the run.
  - The auth wiring is decorator metadata (`@Authenticated` →
    `Reflector.get(MetadataKey.AuthRoute)`) and DI registration
    (`{ provide: APP_GUARD, useClass: AuthGuard }`). Neither is a relationship
    the graph models (A).
  - Nothing in the tool descriptions suggests `get_node` on a class as a
    starting point for architecture questions (F). The agent treated the
    question as a reading task.
- **Cost:** 48 turns, $1.93, 192 s, 162,592 chars of tool results. The next most
  expensive run was Q7 at $1.28.

### Q5 — Implementations of BaseService · PASS · graph-led

- **What it did:** `get_node relationship:"subtypes" limit:100` returned all 51
  in one page (`hasMore:false`). It then read `base.service.ts` and used
  `search_code` totals to back the "in common" claims.
- **Verified:** 86 `@OnEvent`, 66 `@OnJob`, 54 classes under `src/services`,
  and only `BaseService`, `ApiService` and `DatabaseBackupService` declare
  constructors. All match the source.
- **Pagination:** the agent used `limit:100` up front instead of paging, which
  is the right call for a completeness question.

### Q6 — NestInterceptor implementations · PASS · text-led (expected, G)

- **What it did:** `search_graph "NestInterceptor"` → `total:0`. It moved
  straight to `search_code "implements NestInterceptor"`, then cross-checked with
  `search_code "NestInterceptor"` (all 8 hits = 4 imports + 4 implements) and
  `search_code "intercept("` (4 definitions). It also searched for subclasses.
- **Limitation handling (the point of Q6):**
  - *Explains that external symbols are unavailable:* yes, unprompted: "comes from
    `@nestjs/common`, so it isn't a node in the knowledge graph — the graph can't
    answer this by implementation edges".
  - *Finds local implementations:* yes, all 4, which matches `grep`.
  - *Claims completeness incorrectly:* no. It scoped the claim to the indexed
    `server` project and justified it with three independent literal checks.
- **Gap:** the empty result gave no hint why. The agent inferred it (P3).

### Q7 — Asset creation flow · PASS · mixed (exercises H)

- **What it did:** `search_graph "asset" nodeTypes:[api]`, then
  `search_graph "asset-media"`, then read the controller. `get_node` on
  `AssetMediaService.uploadAsset` returned **14 callees,
  `hasMore:false`**. It then read the full 186-line method body and the
  interceptors, used `search_graph "onBeforeLink"` and
  `search_code "isAssetChecksumConstraint"` to find the helpers, and followed
  the async job/event chain with `search_code`.
- **Limitation handling:**
  - *Finds the main flow:* yes, including both interceptors, the 11-step service
    body and all repository writes.
  - *Misses helper calls:* the graph did. The 14 callees contain no
    `onBeforeLink`, `isAssetChecksumConstraint` or `mimeTypes.assetType`. Those
    are stored as outgoing REFERENCES, and `get_node` has no section that shows
    outgoing references. The `references` section is incoming-only
    (`graph.repository.ts:860`, `neighbours(…, 'incoming', ['REFERENCES'])`),
    so for `uploadAsset` it read `total: 0`.
  - *Compensates:* yes. Reading the method body surfaced every helper.
  - *Claims a complete call graph:* no. It never asserted that the callee list
    was exhaustive.
- **Other gap observed:** `search_graph "asset" nodeTypes:[api]` returned
  `POST /api`, `POST /api/jobs` and `POST /api/bulk-upload-check` for routes
  that are really `POST /api/assets…`. `AssetMediaController` is declared
  `@Controller(RouteKey.Asset)` (an enum constant), and the route extractor
  does not resolve it. `POST /api/albums` is correct because
  `@Controller('albums')` is a literal. The agent was not misled because it read
  the decorators, and it answered `POST /api/assets` (A).

### Q8 — Change impact of AlbumRepository.create · PASS · graph-led

- **What it did:** `get_node` on the method gave callers (2, complete) and
  `WRITES_TO` (3). It then called `get_node` on each caller for the next level.
  It ran two `search_code` checks for literal call sites, one for spec
  assertions, read the SQL snapshot, and ran `search_graph "mapAlbum"` for the
  return-shape consumer.
- **Answer quality:** a real impact analysis. It covers callers up two levels
  (including 16 medium specs via `MediumTestContext.newAlbum`), the table writes,
  the `@GenerateSql` snapshot, the `mapAlbum`/OpenAPI return-shape coupling and
  the owner invariant, ranked by risk.

### Q9 — Background jobs · PASS · text-led

- **What it did:** `search_graph "JobRepository"`, `search_code "OnJob"`, then
  it read `job.repository.ts` and `decorators.ts`. The only graph relationship
  it used was `get_node relationship:"callers"` on `JobRepository.setup`, which
  gave `QueueService.onBootstrap`. The rest came from `search_code "JobRun"` and
  file reading.
- **Answer vs ground truth:** complete and correct:
  `@OnJob` → `QueueService.onBootstrap` → `JobRepository.setup` (handler map,
  two startup invariants) → `startWorkers` (BullMQ `Worker` processor emits
  `JobRun`) → `EventRepository` → `JobService.onJobRun` → `JobRepository.run` →
  `handlers[name].handler(data)`. It also covers enqueue (`queueAll`, queue
  resolved from the decorator) and the `onDone` chaining.
- **Where the graph breaks** (checked directly in the database):
  1. `JobRepository.startWorkers` CALLS `EventRepository.emit`. Nothing
     connects `emit('JobRun')` to `JobService.onJobRun`, whose only graph
     caller is `job.service.spec.ts`.
  2. `JobRepository.run` has only a REFERENCE to the property
     `JobMapItem.handler`. There is no edge to any `@OnJob` method. For example,
     `AssetService.handleAssetDeletion` is called only by two spec files in the
     graph.
  3. `@OnJob({ name: JobName.X })` is stored as a reference to the `OnJob`
     variable. The job name ↔ handler association is not modelled.
- **Reasoning quality:** the agent did not say where the graph stopped helping.
  It switched to source silently and correctly. No hallucination.

### Q10 — SharedLink persistence · PASS · mixed

- **What it did:** `search_graph "SharedLink" limit:50`, then
  `search_graph "shared_link" nodeTypes:[table]`, then `get_node` on the table
  (incoming READS_FROM/WRITES_TO with lines). It read the repository, service,
  controller and table files, and used `get_node relationship:"callers"` for two
  writers.
- **Answer quality:** complete. It lists every write path with lines matching
  the database edges (create → shared_link :186 / shared_link_asset :193,
  update :203/:211, remove :220, addAssets :230), the read paths used by auth,
  the FK cascades, and the slug-collision handling. The flagged plaintext
  password comparison (`shared-link.service.ts:39`, `password !== dto.password`)
  is accurate.
- **Ranking (E):** among the 168 matches for `SharedLink`, the first 20 were a
  type, a test factory method, type-literal fields and an enum member.
  `SharedLinkService` ranked #33, `SharedLinkController` #38 and
  `SharedLinkRepository` #40. The agent asked for `limit:50` on its first call.
  With the default limit of 20 it would have seen none of them. It then
  narrowed with `nodeTypes:[table]`, which worked.

### Q11 — Album layering · PASS · graph-led

- **What it did:** `search_graph` by class and by table, `get_node` on
  controller, service and repository (class level), and `trace_path`
  `AlbumController` → `album_asset` (3 hops: CALLS, CALLS, READS_FROM with
  evidence line 109). It read the source for each layer.
- **Answer quality:** evidence-based and well structured. It used class-level
  `callees` (controller → service only; repository → none) to back the claim
  "each layer knows only the one below it".
- **Slips:**
  - "~40-parameter injected constructor". The actual constructor has ~56
    parameters, and Q5 got it right.
  - "its 11 callers are all services … never a controller". The list includes
    `MediumTestContext`, a test factory. The "never a controller" part is true.

### Q12 — Debugging a DB error in POST /api/albums · PASS · graph-led

- **What it did:** found the route and repository method, then ran `trace_path`
  route → `AlbumRepository.create` and `get_node` on the repository method
  (writes) and the `album` table. It read the repository, service, controller,
  SQL snapshot and table schema, and used `search_code` to find the test
  commands.
- **Answer quality:** specific to this code, not generic advice. The claim that
  the child CTEs "insert without a column list", which makes column order load
  bearing, is verified in `src/queries/album.repository.sql`
  (`insert into "album_user" select …`). It also used the graph's second caller
  (`MediumTestContext.newAlbum`) as a diagnostic: broad medium-test setup
  failures point back at this method.

### S1 (supplementary) — stale index · PASS

- **Setup:** two comment lines were prepended to
  `src/repositories/album.repository.ts` in the snapshot (uncommitted, so every
  line shifts by 2), Q2 was re-asked verbatim, and the file was reverted with
  `git checkout`.
- **What it did:** `get_index_status` → `state:"stale"`,
  `changedPaths:["src/repositories/album.repository.ts"]`. It still used the
  graph for structure (`get_node` callees, `databases`), but took the line
  numbers from `get_source` on the changed file. It reported `album` at :327
  (correct after the shift) and closed with: *"The index is stale —
  `src/repositories/album.repository.ts` has uncommitted edits … The graph still
  reports `AlbumRepository.create` at line 304; it's actually at 313. I read the
  file directly … Want me to re-index?"*
- It did **not** call `index_project` on its own. It asked first.
- After the revert, freshness returned to `current` and no analysis job had
  been queued.

---

## 6. Tool Selection Analysis

Tool usage across the 12 questions (266 calls):

| Tool | Calls | Share | Used in |
| --- | ---: | ---: | --- |
| get_source | 115 | 43% | 12/12 |
| search_code | 66 | 25% | 12/12 |
| search_graph | 29 | 11% | 12/12 |
| get_node | 30 | 11% | 10/12 (not Q4, Q6) |
| resolve_project | 12 | 5% | 12/12 |
| get_index_status | 12 | 5% | 12/12 |
| trace_path | 2 | 1% | Q11, Q12 |
| index_project | 0 | — | never (index was current) |

Patterns:

1. **The start-up protocol was followed every time.** Every run began with
   `resolve_project` → `get_index_status`, as the server instructions ask.
   No run tried a projectId without resolving one first, and none mistook an
   empty result for "code does not exist" (Q6 explicitly did not).
2. **Graph first, then source, as intended.** In all 12 runs the first search
   was `search_graph` (always call #3), before any `search_code`. Q6 and Q9
   switched to `search_code` immediately after (call #4). Graph-led answers
   used `get_node` for the relationships and `get_source` to verify.
3. **`get_source` verification is heavy.** Every claimed location was read back.
   That is why the answers had no line-number hallucinations. It is also 43% of
   all calls and most of the tokens. 24 of the 115 reads fetched a whole file
   with no range: Q4 6, Q10 6, Q5 4, Q11 3, Q7 2, and 1 each in Q1, Q9 and Q12.
4. **`get_node relationship:` is used correctly for completeness.**
   Q2 (`databases` per callee), Q3 (`callers`), Q5 (`subtypes limit:100`) and
   Q9/Q10 (`callers`) all asked for the one section they needed.
5. **The agent never paged.** No `offset` appears in any of the 266 calls.
   Of the 21 results where more existed than was returned (`search_graph` 20/37,
   50/168; `get_node` sections 20/46, 20/29; truncated `search_code`), the agent
   either had what it needed on the first page, used `total` as a count
   (Q5: "`@OnJob` (66)"; "54 classes total"), or narrowed the query (Q10 →
   `nodeTypes:[table]`). Totals and `hasMore` were never misread. No answer
   treated a first page as the whole set.
6. **`trace_path` is under-used.** Its description says "Prefer this over
   walking the graph with repeated get_node calls". Q1, Q2 and Q8 were natural
   fits and walked the chain by hand. Walking worked in all three, so this is a
   cost issue, not a correctness one.
7. **Fallback to `search_code` was always appropriate.** It was used for
   literal patterns (`implements NestInterceptor`, `@OnEvent({ name: 'AssetCreate'`,
   `albumService.create`), for event/job wiring the graph lacks, and to find
   call sites. Queries were precise and case-correct: the case-sensitive
   semantics in the description were understood.
8. **Stale-index information was understood** (S1): it named the stale file,
   trusted the graph for structure but not for line numbers, and asked before
   re-indexing.
9. **No hallucination when CodeRAG lacked information.** In Q6, Q7 and Q9 the
   graph was missing relationships, and the agent's claims were backed by
   source it had read. The only errors are the four minor slips listed in §5.

---

## 7. Graph vs Text

**Where the graph won** (answers a text search could not produce as cheaply or
reliably):

- **Callers/callees of a method.** In Q3 and Q8, one call returned a complete,
  exact caller set. That includes a call inside an arrow callback
  (`onPluginLoad`) that a `search_code "albumService.create"` does find, but
  only if you already know the variable name.
- **Table access with attribution.** In Q1, Q2, Q8, Q10 and Q12, `databases` and
  table-node sections gave table + statement + line in one call. The CTE
  inserts would take careful reading to enumerate by hand.
- **Inheritance.** In Q5, all 51 subclasses came in one page with `hasMore:false`.
- **Multi-hop route → table.** In Q11 and Q12, `trace_path` returned the route
  with per-hop evidence.
- **Freshness.** In S1, the stale file was named, which no amount of text
  search would reveal.

**Where text won** (the graph had nothing to offer):

- **External interfaces** (Q6): `implements NestInterceptor` via `search_code`.
- **Decorator/metadata/DI wiring** (Q4, Q9): `APP_GUARD`, `@Authenticated`,
  `@OnJob`/`@OnEvent`, reflection over handlers.
- **String-keyed event bus** (Q2, Q7, Q9): `emit('X')` → `@OnEvent({ name: 'X' })`.
- **Arrow-function helpers** (Q4, Q7): not in `callees`, and not found by
  `nodeTypes:["function"]`.
- **Call-site lines**: `callers` gives the caller's definition, not the line of
  the call.

**Where graph + text worked best:** every graph-led answer (Q1, Q2, Q3, Q5, Q8,
Q11, Q12). The graph produced the set (callers, subclasses, tables) and
`get_source` confirmed each location. That combination is why the answers
contain no location hallucinations.

---

## 8. Known Limitations

| Limitation | Exercised by | Observed effect | Answer impact |
| --- | --- | --- | --- |
| **Arrow-function helper CALLS (H)** | Q7, Q4 | (1) `uploadAsset` callees omit `onBeforeLink`, `isAssetChecksumConstraint`, `mimeTypes`. The list reports `total:14, hasMore:false`, which reads as complete. (2) Outgoing REFERENCES, where these calls live, are not exposed by any `get_node` section. (3) Arrow helpers are `variable` nodes, so `nodeTypes:["function"]` returns 0 for `src/utils/access.ts` | None on correctness. The agent read the source. Higher cost (Q7 35 calls; Q4 switched to text for the whole run) |
| **External interfaces / node_modules (G)** | Q6 | `search_graph "NestInterceptor"` → 0 | None. The limitation was explained unprompted, local implementers were found via `search_code`, and completeness was not over-claimed |
| **Background jobs** | Q9 | Graph stops at `startWorkers → EventRepository.emit` and at `JobRepository.run → JobMapItem.handler` (reference only); `@OnJob` handlers have no production callers in the graph | None. The chain was rebuilt from source, but the agent did not report where the graph ended |
| **Event bus (string-keyed)** | Q2, Q7, Q9 | No edge from `emit('AlbumInvite')` / `emit('AssetCreate')` / `emit('JobRun')` to the `@OnEvent` handlers | None. Found via `search_code "@OnEvent({ name: 'AssetCreate'"` etc. |
| **Dynamic database access** | — | Not exercised by this set. Every table touched by the questions was reached through static Kysely calls, which the detector covered | — |
| **Controller prefix from a constant** (newly observed) | Q7 | `@Controller(RouteKey.Asset)` routes are stored as `POST /api`, `POST /api/bulk-upload-check`, etc., rather than `/api/assets…` | None here (the agent read the decorator). A route-first question such as "what handles POST /api/assets" would get no `search_graph` hit |
| **Broad-term ranking (E)** | Q10 | Primary classes ranked #33–#40 of 168, behind type-literal fields | None, because the agent requested `limit:50` |

---

## 9. MCP UX Findings

Every finding below comes from these transcripts. No P0 was found: nothing in
the MCP surface prevented useful repository reasoning.

### P1 — materially reduces answer quality or graph usefulness

1. **Outgoing REFERENCES are invisible in `get_node`.** The `references`
   section is "nodes that reference this node" (incoming only;
   `graph.repository.ts:860`), and the tool description doesn't say so.
   For a caller, the helpers it uses through REFERENCES (every arrow-function
   helper, per H) appear in no section. Evidence: Q7 `get_node uploadAsset` →
   `references.total: 0`, while the database holds 41 outgoing REFERENCES from
   it, including the three helpers. The practical effect is that `callees`
   looks complete (`hasMore:false`) when it is not.
2. **`nodeTypes:["function"]` silently misses `export const f = () => …`.**
   The schema lists `function` and `variable` with no note that arrow-function
   exports are `variable`. Evidence: Q4 #12 returned 0 results for
   `src/utils/access.ts` (4 such helpers). The agent drew its conclusion and
   switched to `search_code` for the remaining 35 calls.

### P2 — usability; costs turns and tokens

3. **The model gets `structuredContent`, which is 1.4–3.7× the size of the text
   rendering, and the text's paging hints are lost.** Every `get_node` JSON
   includes all 11 relationship sections even when most are empty. For example,
   `uploadAsset` returns 9 sections of `{"returned":0,"hasMore":false,"total":0,…}`.
   Tool results totalled 821,562 chars over 12 runs. Q4 alone was 162,592.
4. **`callers`/`callees`/`references` items carry no call-site location.** The
   `get_node` description says "Each connection carries the evidence it was
   derived from". That is true for `databases`/`implementations` but not for
   call edges, whose items give only the other node's definition line.
   Evidence: Q3 needed `search_code "albumService.create"` and two `get_source`
   windows to cite `workflow-execution.service.ts:78`. Q8 needed
   `search_code "albumRepository.create"` for `album.service.ts:121`.
5. **`search_code` cannot be paged.** It has `limit` ≤ 50 and no `offset`, so
   matches past 50 are unreachable: `constructor(` 160, `OnJob` 90,
   `newTestService` 89, `@OnEvent({ name:` 86. The agent used `meta.total` as a
   count, which was correct here, but it could not list the rest.
6. **Broad-term `search_graph` ranking** (see §8). The description's advice to
   narrow with `nodeTypes` worked when followed (Q10 `nodeTypes:[table]`). The
   first call without it needed `limit:50` to reach the classes.
7. **`get_source` payloads are `{"line":N,"text":…}` per line**, about 20 chars
   of JSON per source line. That makes this tool's JSON 1.4× the size of its
   text rendering. It matters because `get_source` is 43% of calls.

### P3 — cosmetic / documentation

8. **Empty `search_graph` gives no hint for likely-external names.**
   Q6 `NestInterceptor` → `total:0` with no hint. The agent inferred the
   external-package explanation itself. A short `note` for zero results would
   make that explicit.
9. **Class-level `callers` semantics are unexplained.** `BaseService` has
   "callers: 40", which are the subclasses and DI users. `AlbumRepository` has
   11 "callers", which are classes whose methods call it, including a test
   factory. Q11 read these as "all services", which was slightly wrong.
10. **`trace_path` is rarely chosen** (2/12) despite "Prefer this over walking
    the graph". Nothing broke, but Q1, Q2 and Q8 would have been shorter.
11. **`.mcp.json` fails silently from another working directory.** Session
    init shows `failed`, and the model sees no tools and no reason. The
    user-scope setup is documented ([docs/mcp.md](mcp.md), lines 70–74). The
    silence is the issue.

Things that worked and should not change: the start-up protocol in the server
instructions, `get_index_status` freshness fields (`changedPaths` was used
directly in S1), exact `total`/`hasMore`/`nextOffset` metadata (never misread),
`get_node relationship` + `limit` for completeness (Q5 in one call), and
`search_code`'s documented case-sensitivity (queries were correct every time).

---

## 10. Recommended Next Work

Only changes the transcripts support. They are ordered by expected impact.

### R1 — Record calls to arrow-function helpers as CALLS (and make them findable as functions)

> **Implemented.** See [Arrow Function CALLS Follow-up](#arrow-function-calls-follow-up).

- **Problem:** calls to `export const f = (…) => …` are REFERENCES, and the
  helper node is a `variable`.
- **Evidence:** Q7 callees of `uploadAsset` omit 3 helpers while reporting
  `hasMore:false`. Q4 `nodeTypes:["function"]` → 0 for a file with 4 helpers,
  after which the agent abandoned the graph for the run. The prior validation
  measured 34% of this repo's exported functions as arrow functions.
- **Why it matters:** this is the one place where the graph *looks* complete
  and is not. A less careful agent, or one given a smaller budget, would report
  the 14 callees as the full call set. Today's answers survived only because the
  agent re-read the method body.
- **Proposed solution:** when the referenced symbol's initializer is an arrow
  function or function expression and the reference is in call position, emit
  CALLS. Give such variables a discoverable function-like type, or have
  `nodeTypes:["function"]` include them.
- **Why not "just expose outgoing REFERENCES"?** Measured on `uploadAsset`, 3 of
  its 41 outgoing references are helpers. The rest are DTO types, enum members
  and type-literal fields. As a list, it would be 93% noise.
- **Expected impact:** Q7-style flows resolved from `get_node` instead of ~20
  `get_source` calls. Q4-style `search_graph` filters work.
- **Risk:** changes CALLS counts repo-wide, and caller/callee totals shift for
  existing clients. Function *values* passed around, not called, must stay
  REFERENCES.
- **Verification:** re-run Q4 and Q7 unchanged and check that
  `onBeforeLink`/`isAssetChecksumConstraint` appear in `uploadAsset` callees
  and that `get_source` calls drop. Add retrieval-eval cases for an arrow
  helper's callers/callees. Re-check the S1/Q3 `callers` totals.

### R2 — Tool-description corrections (no contract change)

- **Problem:** three descriptions led, or could lead, the model wrong:
  `references` has no direction stated, `nodeTypes` doesn't say arrow exports
  are `variable`, and `get_node` says every connection carries evidence when
  call edges don't carry a call site.
- **Evidence:** Q4 #12 (0 results with `function`); Q7 (`references: 0`
  on a method that references 41 nodes); Q3/Q8 (`search_code` needed to find
  call lines).
- **Why it matters:** the model reads these descriptions literally and
  otherwise used every tool correctly. These are the only places where the text
  misled it.
- **Proposed solution:** state "`references`: nodes that reference this one
  (incoming)". Add "arrow-function exports are `variable`" to `nodeTypes`
  (until R1 lands). Say which sections carry evidence.
- **Expected impact:** fewer dead-end searches (Q4 #12) and no misreading of
  empty `references`.
- **Risk:** negligible.
- **Verification:** re-run Q4 and Q7, and check that the agent includes
  `variable` or doesn't rely on `references` for outgoing use.

### R3 — Link string-keyed events and job handlers

- **Problem:** `emit('Name')` / `@OnEvent({ name: 'Name' })` and
  `@OnJob({ name: JobName.X })` handlers are not connected.
- **Evidence:** Q9 (graph stops at `EventRepository.emit` and at
  `JobMapItem.handler`; `JobService.onJobRun` and
  `AssetService.handleAssetDeletion` have only spec callers). Q2 and Q7 needed
  `search_code` for the `AlbumInvite` and `AssetCreate` listeners.
- **Why it matters:** this repo has 86 `@OnEvent` and 66 `@OnJob` handler
  methods, and no edge connects any of them to its dispatcher. The two checked
  (`onJobRun`, `handleAssetDeletion`) have only spec callers. That misleads
  impact and dead-code questions, and it made Q9 entirely text-led.
- **Proposed solution:** a NestJS-aware detector that emits an edge from the
  emit site (with the literal event name) to each `@OnEvent` handler of that
  name. For jobs, an edge from `@OnJob` handlers to their `JobName` member.
  This is new relationship data, so it needs its own design review.
- **Expected impact:** Q9 answerable from `trace_path`. Correct callers for
  about 150 handler methods.
- **Risk:** name resolution through enums and constants. False edges when names
  are computed.
- **Verification:** re-run Q9 unchanged and check whether it uses `trace_path`
  or `get_node`. Check that `onJobRun` and `handleAssetDeletion` gain
  production callers.

### R4 — Reduce structured payload size

- **Problem:** Claude Code consumes `structuredContent`, which is 1.4–3.7× the
  text rendering and carries every empty section.
- **Evidence:** §3 measurements. 821,562 chars of tool results across 12 runs.
  Q4 used 162,592 chars and cost $1.93.
- **Why it matters:** cost and context, not correctness. No answer failed for
  lack of context.
- **Proposed solution:** measure first. Omit empty sections from `get_node`
  structured output, keeping `totals` so absence stays explicit. Consider
  compact `get_source` lines. Keep the fields the agent actually used
  (`total`, `hasMore`, `nextOffset`, evidence).
- **Expected impact:** an estimated 30–60% fewer result characters on
  `get_node`-heavy runs. This is an estimate, not measured.
- **Risk:** it is an output-shape change for structured consumers, so it needs
  versioning or a compatibility note.
- **Verification:** replay the 12 questions and compare total result chars,
  cost and scores.

### R5 — Resolve controller prefixes given as constants

- **Problem:** `@Controller(RouteKey.Asset)` yields `POST /api` rather than
  `POST /api/assets`.
- **Evidence:** Q7 `search_graph nodeTypes:[api]` results (`POST /api`,
  `POST /api/jobs`, `POST /api/bulk-upload-check` for asset routes).
- **Why it matters:** route-first questions ("what handles POST /api/assets?")
  would find nothing. Q7 only avoided this because it started from file names.
- **Proposed solution:** resolve string-enum and const initializers in
  controller and method route decorators.
- **Risk:** low, provided unresolvable expressions stay as they are today.
- **Verification:** `search_graph "POST /api/assets" nodeTypes:[api]` returns
  `AssetMediaController.uploadAsset`. Add a retrieval-eval case.

**Not recommended on this evidence:**

- **Indexing node_modules / external interface support:** Q6 was answered
  correctly, with an accurate limitation statement, via `search_code`. The
  cheap P3 hint (finding 8) covers the remaining gap.
- **Pagination redesign:** the metadata was never misread.
- **Changing `search_code` paging (finding 5):** no answer was harmed.
- **Ranking work:** Q10 shows the problem, but the existing `nodeTypes` filter
  worked when used. Revisit if a smaller-model or default-limit run fails on it.

---

## Arrow Function CALLS Follow-up

R1, implemented after the baseline above. Measured on the same Immich snapshot
(`a4af862`) and the same CodeRAG base commit (`01dd706`), with the working-tree
changes listed below. Nothing was committed.

### Original problem

- `AssetMediaService.uploadAsset` reported **14 callees, `hasMore: false`**.
  The list left out `onBeforeLink` and `isAssetChecksumConstraint`, which it
  calls. Both are `export const f = (…) => …`, stored as `variable` nodes, so
  each call was a `REFERENCES` edge that no callers or callees list shows.
- `search_graph "access" nodeTypes:["function"] file:"src/utils/access.ts"`
  returned **0**. Every helper in that file was a `variable`.

### Implementation approach

Two facts SCIP does not carry, recovered from syntax by the TypeScript refiner
and applied by the builder:

1. **Which variables are functions.** A `const` binding one name to an arrow
   function or function expression (optionally in parentheses) becomes a
   `function` node, with `metadata.functionValue`. `let`/`var`, destructuring,
   casts, factory results and objects of functions stay `variable`.
2. **Which references are calls.** An occurrence that is the callee of a call
   expression is marked `isCall`: `f()`, `await f()`, `f?.()`, `f<T>()`,
   `ns.f()`, `@f()`. For a function-valued variable, only these become `CALLS`,
   located at the first call site (`file`, `line`, `column`, `high`). Every
   other use (`register(f)`, `const g = f`, `f.bind()`, `[f]`) stays
   `REFERENCES`.

Declared functions and methods keep their existing rule: every reference is
`CALLS`. The parse is syntax only, with no type checker, so it also works when
dependencies are not installed. The rules and their limits are in
[graph-model.md → Function-valued variables](graph-model.md#function-valued-variables).

### Affected files

| File | Why |
| --- | --- |
| `packages/scip/src/adapters/typescript-function-values.ts` (new) | The syntax scan: function-valued `const` declarations and callee positions |
| `packages/scip/src/adapters/typescript-symbol-refiner.ts` | Runs the scan on the text it already reads, sets `kind: function` + `functionValue`, marks `isCall` occurrences |
| `packages/scip/src/types/index.ts` | `ScipSymbol.functionValue`, `ScipOccurrence.isCall` (both optional) |
| `packages/scip/src/adapters/index.ts` | Exports the scanner |
| `packages/scip/package.json`, `pnpm-lock.yaml` | `typescript ~5.9.3` as a dependency of `@ckg/scip`. It is already the version `@ckg/analysis` uses, so nothing new was downloaded |
| `packages/graph/src/normalizer/document-normalizer.ts` | Carries `isCall` and the reference position to the builder |
| `packages/graph/src/builder/scip-graph-builder.ts` | Invocation-only `CALLS` for function values; call-site evidence; stable identity |
| `packages/graph/src/builder/node-accumulator.ts` | Optional `identityType`, so a node can keep the id it had |
| `packages/graph/src/model/identity.ts` | Documents the identity exception |
| `scripts/build-fixtures.ts` | Adds the new sample |
| `test-repositories/function-values-sample/` (new), `packages/scip/tests/fixtures/function-values-sample.scip` (new) | Fixture: every declaration form, every call and value-use form, and the Immich `access.ts` and upload shapes |
| `packages/scip/tests/typescript-function-values.test.ts`, `packages/graph/tests/function-values.test.ts`, `apps/api/tests/function-value-callees.test.ts` (new) | 32 tests (below) |
| `docs/graph-model.md` | Classification, what counts as `CALLS`, what stays `REFERENCES`, limits, identity exception |

No MCP tool, API route, schema, ranking, database edge, Kysely extraction or
other analyzer changed. Regenerating the fixtures left the four existing
`.scip` files byte-identical.

### Node identity impact

Node type is part of the id hash (`scope ⌷ type ⌷ path ⌷ symbolKey`), so a
plain `variable` → `function` switch would have renamed every reclassified node
and every edge touching it. Instead, a function-valued variable is hashed as
`variable`, the type it had before, while its `type` is `function`.

Measured on Immich: **0 node ids changed, 0 nodes added or removed, 420 nodes
retyped in place, 0 duplicate declarations.** Database edges, imports and every
other relationship have identical ids before and after. Nothing else recomputes
a code symbol's id: `NodeAccumulator` is the only place ids are made. The one
analyzer that computes an id itself (`configuration.analyzer.ts`) does so for
`config` nodes.

### Before / after — Immich `a4af862`

| Metric | Before | After | Δ |
| --- | ---: | ---: | ---: |
| Nodes | 9,395 | 9,395 | 0 |
| `function` nodes | 301 | 721 | +420 |
| `variable` nodes | 2,310 | 1,890 | −420 |
| Edges | 52,324 | 52,619 | +295 |
| `CALLS` | 6,280 | 8,659 | +2,379 |
| `REFERENCES` | 26,474 | 24,390 | −2,084 |
| All other relationships | — | — | 0 added, 0 removed |
| Index time | 13.3 s | 14.8 s | +1.5 s |
| `uploadAsset` callees | 14 | 16 (+ `onBeforeLink`, `isAssetChecksumConstraint`), `hasMore:false` | +2 |
| `access.ts` `nodeTypes:["function"]` search | 0 | 7 (every exported helper in the file) | +7 |
| `onBeforeLink` callers | 0 | 2 (`AssetMediaService.uploadAsset`, `AssetService.update`) | +2 |

Where the 2,379 new `CALLS` edges came from:

- **Every one replaces or joins an existing `REFERENCES` pair.** No
  relationship was invented between nodes that were not already connected.
  2,084 pairs moved entirely to `CALLS`. 295 pairs now have both, because the
  code both calls the helper and uses it as a value. 24,390 `REFERENCES` edges
  are untouched.
- **1,167 are helper calls** (379 distinct helpers), for example `asUuid` (49),
  `mapAlbum`, `withAlbumUsers` and `onBeforeLink`.
- **1,212 are decorator factories** declared as arrows: `GenerateSql` 360,
  `Authenticated` 294, `Endpoint` 276, `OnEvent` 86, `OnJob` 66, `ExtraModel`
  40. A decorator call is attributed to the member it decorates. That matches
  existing behaviour: calls inside decorator arguments (`HistoryBuilder.added`
  in `@Endpoint(…)`) and decorators declared with `function` (`@Chunked`) were
  already `CALLS` from the member. A side effect is that the callers of
  `OnJob`/`OnEvent` are now their 66/86 handlers.
- **390** come from spec and test files.

`mimeTypes` was **not** reclassified. It is `export const mimeTypes = { image,
profile, …, assetType(…) }`, an object, not a callable declaration.
scip-typescript emits no graph symbol for its members, so `mimeTypes.assetType()`
stays a `REFERENCES` edge to `mimeTypes`. That is correct: nothing in the graph
is the function being called.

### False-positive audit

Done independently of the graph: the Immich SCIP index was regenerated with the
pipeline's own command, and every occurrence of every reclassified symbol was
checked against the raw source line.

| Check | Result |
| --- | --- |
| Reclassified declarations that do not syntactically assign an arrow or `function` | **0** of 420 (all 420 are arrows; Immich has no `const f = function` declarations) |
| Occurrences marked as a call but not followed by `(` (allowing `<…>` / `?.`) | **0** of 4,278 |
| Occurrences not marked as a call but followed by `(` (missed calls) | **0** of 1,042 |
| Remaining non-call occurrences, by context | 945 import/export lists, 36 passed as an argument (`.then(asStreamableFile)`, `.select(withSharedLink)`), 13 property values (`createAlbum: dummy`), 13 member accesses (`X.PreviewProps = …`), 7 `typeof f`, 28 other (JSX `<ImmichButton …>`) |

All 1,042 non-call occurrences are value uses. None of them became `CALLS`.

### Test results

| Suite | Result |
| --- | --- |
| New: `packages/scip/tests/typescript-function-values.test.ts` | 7 passed. Scanner on inline source (every declaration and call form, every non-callable), refiner on the fixture |
| New: `packages/graph/tests/function-values.test.ts` | 21 passed. Tests 1–8 of the spec, id stability, unchanged declared functions, `uploadAsset`-shape callees |
| New: `apps/api/tests/function-value-callees.test.ts` | 4 passed. Test 9 through the routes `get_node` reads: callees `total:4, nextOffset:null` including the helpers, overview totals, helper callers, `nodeTypes=function` search |
| `pnpm test` | **1344 passed, 73 skipped** (was 1312 + 32 new). No existing test changed |
| `pnpm typecheck` | exit 0 |
| `pnpm evaluate:retrieval --api http://localhost:3001` | **49/49**, after re-indexing all three sample projects with the new code. Their graphs came out identical: they contain no function-valued `const`s |

### Real-LLM re-run (Q3, Q7, Q8)

Same harness as the baseline (headless Claude Code, CodeRAG tools only), same
questions verbatim, one run each.

| | Before | After | Notes |
| --- | --- | --- | --- |
| Q3 callers of `AlbumService.create` | PASS · 16 calls · $0.44 | PASS · 14 calls · $0.40 | Same 3 callers; "the list is complete (no further pages)" |
| Q7 asset creation flow | PASS · 35 calls · $1.28 | PASS · 41 calls · $1.56 | Now cites "The graph lists 16 callees for this method", helpers included. Still read the method body first and used `search_code` to locate three helper definitions before calling `get_node` (#24) |
| Q8 impact of `AlbumRepository.create` | PASS · 19 calls · $0.53 | PASS · 23 calls · $0.66 | Used the new edges: `mapAlbum`'s 7 callers (an arrow helper) for the return-shape risk, and `withAlbumUsers` among the callees |

What this does and does not show:

- **The graph gap is closed.** The callees list is now complete for the
  asset-upload flow, and the model relied on it: it quoted the graph's count
  rather than inferring the helpers.
- **A cost saving is not shown.** With one run per question, the call counts
  moved both ways. Q7's strategy of reading the 100-line service body before
  asking the graph did not change. Its remaining `search_code` calls looked up
  where helpers are *defined*, which the callee entries already carry
  (`filePath`, `startLine`). That is a tool-selection pattern (cause C in §7),
  not missing graph data.

### Remaining limitations

- **Declared functions still treat every reference as `CALLS`,** including
  `register(namedFunction)`. Function-valued variables now distinguish calls
  from value uses, and declared functions do not. Making them consistent would
  change existing edges, so it is left for a separate decision.
- **Syntax only:** `const f: Handler = makeHandler()`, `const f = g as H`,
  `let f = () => …` and class-property arrows are not functions.
- **Dynamic dispatch is not traced:** `handlers[name]()`, `this.handlers[x].handler()`
  (the Q9 job dispatch), callbacks invoked by their receiver.
- **Object-literal members are not nodes:** `mimeTypes.assetType()` resolves no
  further than `mimeTypes`.
- **Decorator calls are attributed to the decorated member.** This is correct
  syntactically and consistent with existing behaviour, but a member's callees
  now include `Authenticated`/`Endpoint`/`GenerateSql`, which run when the class
  is defined, not when the member runs.
- **TypeScript/JavaScript only.** No other language has a refiner that marks
  calls.
- **`get_node` still gives call edges no call-site location in its lists** (§9
  finding 4). The new `CALLS` edges store one, but the MCP contract was left
  unchanged, so it is visible only through `trace_path` evidence.

# Follow-up Validation — Arrow Function CALLS

A second real-LLM run of all 12 questions, after
[Arrow Function CALLS](#arrow-function-calls-follow-up) was implemented. Its only
purpose was measurement: no production code, graph data, ranking or MCP
contract changed for it.

> **How to read the numbers.** This is an observational before/after
> comparison with **one run per question** in each round. It is not a
> controlled experiment. On an identical graph, the same question varied by up
> to 31% in cost between two runs (Q7: $1.56 vs $1.08, see
> [Run-to-run spread](#run-to-run-spread)). Deltas smaller than that are not
> evidence of anything.

## Executive Summary

- **Score: 12 PASS · 0 PARTIAL · 0 FAIL**, the same as the baseline. No material
  hallucination. Spot-checked claims held (Q4 "~111" `requireAccess` call sites
  vs 109 actual; Q12's snapshot and constraint claims were verified in source).
- **Graph completeness improved and was used.** Q7 received all 16
  `uploadAsset` callees, including `onBeforeLink` and
  `isAssetChecksumConstraint`, with `hasMore:false`. Q8 inspected the arrow
  helpers `mapAlbum` and `withAlbumUsers` directly as graph nodes. Q4's first
  `search_graph` now returned 23 function nodes, where the baseline's
  function-filtered search returned 0.
- **Aggregate cost and call count barely moved:** 266 → 263 calls, $8.87 → $8.52.
  Both are within run-to-run noise.
- **The dominant remaining inefficiency is the agent, not the graph.** It still
  reads source before asking the graph, and it hunts for definitions with
  `search_code "export const X"` (17 such lookups). 8 of those targeted arrow
  helpers that are now `function` nodes one `search_graph` away.
- **The only graph gap that still forces a whole question into text is
  event/job wiring** (Q9, both rounds). It cost calls, not correctness.
- **Recommendation: no graph/retrieval implementation change is justified yet.
  Collect more real-LLM evidence** ([below](#recommended-next-task)).

## Environment

| Property | Value |
| --- | --- |
| Date | 2026-09-24 |
| CodeRAG | `01dd706` plus the arrow-function working-tree changes (staged, uncommitted). Production code unchanged for this run |
| Immich | `server/` at `a4af86282d13354bd21bbaf7a2ffb7fae15e8cf2`, working tree clean |
| Index | Analysis `51634ba2…` (the arrow-function re-index), state `current`, 0 changed files. 9,395 nodes; 721 `function`, 1,890 `variable`, 420 carrying `metadata.functionValue`; 8,659 `CALLS`, 24,390 `REFERENCES` |
| Pre-run graph checks (through MCP) | `uploadAsset` callees **16**, `hasMore:false`, `onBeforeLink` ✓, `isAssetChecksumConstraint` ✓. `onBeforeLink` callers **2** (`AssetMediaService.uploadAsset`, `AssetService.update`). `search_graph "access" nodeTypes:[function] file:src/utils/access.ts` → **7** |
| Agent | Claude Code CLI `2.1.278`, model `claude-opus-5[1m]`, the same as the baseline |
| Harness | Identical to the baseline: fresh headless session per question, the question text verbatim (same files), cwd = Immich `server/`, the existing `.mcp.json` with `CLAUDE_PROJECT_DIR` set, `--tools ""` (no Read/Grep/Bash), `--strict-mcp-config`, `--disable-slash-commands`, stream-json transcripts, 4-way parallel |
| MCP | `code-graph` connected in 12/12 sessions; 0 tool errors |
| Output consumed | JSON (`structuredContent`) for **263/263** results, as in the baseline (266/266) |

Baseline checks before the run: `pnpm typecheck` exit 0; `pnpm test` 1,344
passed / 73 skipped; `pnpm evaluate:retrieval --api http://localhost:3001`
49/49.

## Before/After Results

"Previous" is the baseline run in §1–§10 of this report, on the pre-change graph.
Every figure in both columns was computed by the same script from the raw
transcripts. It reproduces the baseline's published totals exactly: 266 calls,
821,562 result chars. The baseline's $8.86 was a truncation of $8.865.

| Metric | Previous | Current | Delta |
|---|---:|---:|---:|
| Questions | 12 | 12 | 0 |
| PASS | 12 | 12 | 0 |
| PARTIAL | 0 | 0 | 0 |
| FAIL | 0 | 0 | 0 |
| MCP calls | 266 | 263 | −3 (−1%) |
| Total cost | $8.87 | $8.52 | −$0.35 (−4%) |
| Tool-result chars consumed | 821,562 | 789,912 | −31,650 (−4%) |
| Final-answer chars | 61,826 | 57,969 | −3,857 |
| Output tokens | 75,931 | 77,366 | +1,435 |
| Turns | 278 | 275 | −3 |
| Wall time (sum) | 1,083 s | 1,052 s | −31 s |
| Average calls/question | 22.2 | 21.9 | −0.3 |
| Graph calls (`search_graph`/`get_node`/`trace_path`) | 61 | 71 | +10 |
| Text calls (`search_code`/`get_source`) | 181 | 168 | −13 |
| `get_node` | 30 | 32 | +2 |
| `search_code` | 66 | 62 | −4 |
| `get_source` | 115 | 106 | −9 |
| `trace_path` | 2 | 2 | 0 |
| Definition lookups via `search_code` | 13 | 17 | +4 |
| Q7 calls | 35 | 37 | +2 |
| Q7 cost | $1.28 | $1.08 | −$0.20 |
| Q4 calls | 47 | 37 | −10 |
| Q4 cost | $1.93 | $1.40 | −$0.53 |
| Graph-first questions (first investigative call was a graph tool) | 12 | 12 | 0 |
| Text-first questions | 0 | 0 | 0 |
| Dominant evidence GRAPH / MIXED / TEXT | 7 / 2 / 3 | 6 / 3 / 3 | Q11 GRAPH → MIXED |

The single post-implementation re-run in
[Arrow Function CALLS Follow-up](#real-llm-re-run-q3-q7-q8) measured Q7 at 41
calls / $1.56. That run and this one used the same graph.

### Run-to-run spread

Q3, Q7 and Q8 have been run twice on the *same* new graph: the follow-up
re-run, then this run.

| | Follow-up re-run | This run | Spread |
| --- | --- | --- | --- |
| Q3 | 14 calls · $0.40 | 14 calls · $0.44 | +10% cost |
| Q7 | 41 calls · $1.56 | 37 calls · $1.08 | −31% cost |
| Q8 | 23 calls · $0.66 | 20 calls · $0.58 | −12% cost |

Identical graph, identical prompt, same model: up to 31% apart. That bounds
what any single-run delta in this report can mean.

## Per-Question Comparison

"Graph contribution" uses one of: *found directly* · *narrowed the search* ·
*confirmed a text-derived answer* · *bypassed* · *misleading/incomplete* ·
*sufficient but not used*.

| ID | Previous | Current | Calls | Cost | Dominant | Graph contribution | Fallback behaviour | Notable |
|----|----------|---------|------:|-----:|----------|--------------------|--------------------|---------|
| Q1 | PASS | PASS | 19 → 19 | $0.49 → $0.48 | GRAPH | Found directly: route → `callees` → `WRITES_TO` ×3 | `search_code` ×3 for DTO schema and global prefix | Same chain and lines as before |
| Q2 | PASS | PASS | 14 → 19 | $0.29 → $0.46 | GRAPH | Found directly: `databases` on each callee | `search_code` ×3 to follow `AlbumInvite` → job | Went further: found the async `notification` write via `NotificationRepository.create`'s `databases` section |
| Q3 | PASS | PASS | 16 → 14 | $0.44 → $0.44 | GRAPH | Found directly: 3 callers, complete | `search_code "albumService.create"` to confirm; source to explain | Flagged a pre-existing false `IMPLEMENTS` edge (`AlbumService.create` → static `BaseService.create`) as a name collision |
| Q4 | PASS | PASS | 47 → 37 | $1.93 → $1.40 | TEXT | Narrowed: first search returned guards and arrow helpers (`Authenticated`, `getAuthTokens`, `MaintenanceRoute`); then bypassed | 20 `get_source`, 12 `search_code` | Baseline's 0-result dead end did not recur. Still the costliest question |
| Q5 | PASS | PASS | 18 → 23 | $0.81 → $0.98 | GRAPH | Found directly: 51 `subtypes` in one page | `search_code` counts for the "in common" section | Used `search_graph` to count constructors |
| Q6 | PASS | PASS | 14 → 10 | $0.23 → $0.20 | TEXT | Confirmed: 4 `Interceptor` classes, no subtypes | `search_code "NestInterceptor"` (8 hits = 4 imports + 4 implements) | States `NestInterceptor` is external and not a node; scopes completeness to `server/` |
| Q7 | PASS | PASS | 35 → 37 | $1.28 → $1.08 | MIXED | Sufficient but not used first: 16/16 callees fetched at call #29 of 37 | 19 `get_source`, 7 `search_code` (4 were definition lookups) | See [Arrow Function Impact](#arrow-function-impact) |
| Q8 | PASS | PASS | 19 → 20 | $0.53 → $0.58 | GRAPH | Found directly: 2-level callers, `WRITES_TO`, arrow helpers `mapAlbum` and `withAlbumUsers` | `search_code` ×4, mostly call-site lines | New: `withAlbumUsers` "shared with `getById`, `getByAssetId`, `getAll`, `update`", from its graph callers |
| Q9 | PASS | PASS | 20 → 22 | $0.66 → $0.65 | TEXT | Narrowed (`search_graph "OnJob"`, enums); then bypassed | 8 `get_source`, 8 `search_code` | Correct chain; still silent about where the graph stopped helping |
| Q10 | PASS | PASS | 19 → 15 | $0.73 → $0.61 | MIXED | Narrowed: `shared_link` table node (19 `databases` edges) | 6 whole-file reads | `SharedLink` ranking unchanged (#33/#38/#40), absorbed by `limit:50` |
| Q11 | PASS | PASS | 22 → 30 | $0.85 → $1.13 | MIXED | Narrowed/confirmed: class-level `get_node` ×2, `trace_path` controller → `album` | 13 `get_source`, 9 `search_code` (5 hunting `requireAccess`/`mapAlbum` definitions) | Graph-available definitions searched as text |
| Q12 | PASS | PASS | 23 → 17 | $0.62 → $0.50 | GRAPH | Found directly: `trace_path`, `WRITES_TO`, callers | 1 `search_code` | Verified in source: CTE inserts without column lists; snapshot inserts only `albumName` |

## Arrow Function Impact

**Did graph completeness improve?** Yes, measurably. It was checked before the
run and seen in the transcripts. Q7's `get_node uploadAsset` returned 16/16
callees with the two helpers, each carrying `filePath` and `startLine`.
`search_graph "onBeforeLink"` returned a `function` node. Q8's callee lists
surfaced `withAlbumUsers` and `mapAlbum`.

**Did agent behaviour improve?** In places, not overall.

- *Where it changed:*
  - Q8 opened `mapAlbum` and `withAlbumUsers` as graph nodes and used
    `withAlbumUsers`'s callers for its "shared helper" risk.
  - Q4's first search was `nodeTypes: ["class","interface","function"]` and
    returned the arrow helpers, so the baseline's zero-result dead end did not
    recur.
  - Q7 located `onBeforeLink` with `search_graph`, not `search_code`.
- *Where it did not:* the dominant strategy is unchanged. The agent reads the
  method body, then locates each helper's definition, often with
  `search_code "export const X"`. Definition lookups via `search_code` went
  13 → 17, and 8 of the 17 targeted helpers that are now `function` nodes.

**Q7 specifically:**

| Question | Answer |
| --- | --- |
| Retrieved `uploadAsset`? | Yes: `get_node` overview at call #29 (of 37) |
| Complete 16 callees? | Yes: 16/16, `hasMore:false`, helpers with `filePath`/`startLine` |
| Recognised the arrow helpers? | Yes: `onBeforeLink`, `isAssetChecksumConstraint`, plus `requireUploadAccess` and `mapToUploadFile` on neighbouring methods |
| Used the graph evidence? | Partly. The callee list arrived after the helpers had been found from the source body, so it confirmed rather than discovered |
| Still searched for helper definitions? | Yes: `search_graph "onBeforeLink"` (#11), `search_code` for `isAssetChecksumConstraint` (#24), `mapToUploadFile` (#25, #27), `requireUploadAccess` (#34) |
| Why? | **C — model preference / tool selection**, with **D — source verification** (it read every helper's body to describe it, which it needed anyway). Not **A**: the graph held the data. Not **B**: callee entries carry each definition's `filePath` and `startLine`. The searches before #29 happened before it asked. The ones after (#34) targeted callees of `canUploadFile`/`getFiles`, whose `get_node` it never requested |

**Q8 specifically:** it used `withAlbumUsers` (as a callee, then its callers) and
`mapAlbum` (as a node; the answer names it as the return-shape consumer).
Unlike the follow-up re-run, it did not enumerate `mapAlbum`'s 7 callers this
time. That is a single-run difference in what it chose to mention.

**Did tool-call count improve?** 266 → 263 (−1%). Not distinguishable from noise.

**Did cost improve?** $8.87 → $8.52 (−4%). Not distinguishable from noise: the
same-graph Q7 spread is 31%.

**Did source-search fallback decrease?** Slightly. Text calls went 181 → 168,
graph calls 61 → 71, `get_source` 115 → 106, `search_code` 66 → 62. The direction
is consistent with the change, but the size is within noise.

**Did new false positives appear?** None observed. Decorator factories
(`GenerateSql`, `Authenticated`, `Endpoint`, `OnEvent`) appeared in callee lists
in 4 sessions (Q1, Q2, Q8, Q12). No answer presented one as a runtime call. Q8
and Q12 described `@GenerateSql` correctly as the SQL-snapshot generator.

### Job/event gap (Q9)

| Question | Answer |
| --- | --- |
| Still mostly text? | Yes: 16 of 22 calls were `get_source`/`search_code`; 0 `get_node` |
| Understood the limitation? | Not stated. It fell back silently, as in the baseline |
| Correct? | Yes: `@OnJob` → `QueueService.onBootstrap` → `JobRepository.setup` → `startWorkers` (Worker emits `JobRun`) → `JobService.onJobRun` → `JobRepository.run` → `handlers[name].handler(data)` → e.g. `MediaService.handleGenerateThumbnails` |
| Extra calls | 22 vs 20 in the baseline. About 8 `search_code` calls follow wiring the graph does not model (`jobRepository.setup`, `startWorkers`, `setServices`, `MetadataKey.EventConfig`, a specific `@OnJob`) |
| Graph useful anywhere? | Narrowing only: `search_graph "OnJob"` found the decorator, and the enum searches found `QueueName`/`JobName`. `OnJob` now has its 66 handlers as callers (a side effect of the change), but the question asks about the dispatch path and the agent did not look |

Event hops were also followed by text in Q2 (`'AlbumInvite'` → `NotifyAlbumInvite`,
3 `search_code`) and Q7 (`'AssetCreate'`, `JobName.AssetExtractMetadata`, 2
`search_code`). None of these affected correctness.

### External dependency gap (Q6)

Correct (4 of 4), with a clear local/external distinction. There was no
unsupported completeness claim: it scoped the answer to the indexed `server`
project and said it did not search sibling workspaces. It took 10 calls and
$0.20, cheaper than the baseline. **Kept as a documented limitation.** No
change is justified.

### Call-site evidence (Q3, Q7, Q8)

The new `CALLS` edges store call-site locations, but `get_node` lists do not
expose them. Calls whose aim was a call-site line:

| Question | Calls | Note |
| --- | ---: | --- |
| Q3 | 1 | `search_code "albumService.create"`, also used as a completeness check |
| Q7 | 0 | Call sites came from the service body it read anyway |
| Q8 | 3–4 | `search_code` for `AlbumRepository.create`, `albumRepository.create`, `albumService.create`, plus one `get_source` window around `MediumTestContext.newAlbum` |

About 5 calls across three questions, each returning ~400 chars. They are real
but small, and they double as completeness verification, which the agent does
regardless.

## MCP Presentation Analysis

| # | Issue | Status | Evidence in this run | Materially affected performance? |
|---|---|---|---|---|
| 1 | Bulky JSON instead of compact text | OBSERVED | 263/263 results were JSON; 789,912 chars | UNCERTAIN. It is a cost factor, but no answer was affected, and its share of cost was not isolated |
| 2 | Text-form paging hints not exposed | NOT OBSERVED as a problem | 0 uses of `offset` in either round. 9 `search_graph` and 2 `get_node` results had more pages; the agent used totals or narrowed. No first page was treated as the whole set | No |
| 3 | Caller/callee entries lack call-site lines | OBSERVED | ~5 lookups in Q3/Q8 (above) | Minor |
| 4 | `references` direction confusing | NOT OBSERVED | The `references` section was never requested in either round | No |
| 5 | `SharedLink` classes below default top 20 | OBSERVED | Same ranks (#33/#38/#40); the agent asked for `limit:50` on its first call, as before | No: absorbed both times |
| 6 | `get_node` lists expose no call-site evidence | OBSERVED | Same as #3 | Minor |

## Remaining Bottlenecks

Evidence-backed only, in order of observed cost:

1. **The agent under-uses graph data it already has (tool selection).**
   - 17 definition lookups via `search_code`, 8 of them for arrow helpers that
     are graph `function` nodes.
   - Q7 fetched the complete callee list at call #29 of 37.
   - Q11 spent 5 calls hunting `requireAccess`/`mapAlbum` definitions.
   - `trace_path` was used in only 2/12 sessions in both rounds.

   This is agent behaviour, not a graph gap, and it did not cost correctness.
2. **Event/job wiring is not in the graph.** Q9 was text-led in both rounds,
   and event hops cost text searches in Q2 and Q7. The cost is roughly 10
   calls across the run; the correctness cost is none.
3. **Payload size.** Every result is JSON; 789,912 chars in total. Its effect
   on cost was not separated from everything else.
4. **Newly observed, pre-existing graph imprecision.** There are 15
   `IMPLEMENTS` edges from subclasses' instance `create` methods to the
   *static* `BaseService.create`, unchanged by the arrow-function work. Q3's
   agent noticed one and dismissed it correctly. No answer was harmed.

## Candidate assessment

| | Candidate | Evidence from this run | Impact | Confidence | Implementation risk |
|---|---|---|---|---|---|
| A | Event/job relationship extraction | Q9 text-led both rounds (16/22 text calls); event hops by `search_code` in Q2, Q7 | ~10 calls/run, 0 correctness | Medium: the gap is certain, the benefit to *this* agent is not | Medium–high: string-keyed names through enums/constants |
| B | MCP call-site evidence | ~5 small lookups in Q3/Q8 that double as verification | Low | Medium | Low–medium (contract change) |
| C | JSON payload reduction | 789,912 chars, all JSON; no answer affected | Unknown | Low: not isolated | Medium (output-shape change) |
| D | MCP description improvements | 17 text definition lookups (8 graph-available); late `get_node` in Q7; `trace_path` 2/12 | Unknown: targets the largest pattern, but only indirectly | Low–medium | Low |
| E | Ranking for broad names | Same ranks; absorbed by `limit:50` twice | None observed | High (that it doesn't matter for this agent) | Medium |
| F | External dependency metadata | Q6 correct, cheaper, well-caveated | None | High | High (node_modules scope) |
| G | Declared-function CALLS semantics | No answer touched it | None observed | High | Medium (changes existing edges) |
| H | Dynamic dispatch | Only `handlers[name].handler` in Q9 (part of A) | Subsumed by A | Medium | High |
| I | Nothing yet | 24/24 answers PASS across two rounds; aggregate deltas inside the measured 31% spread; no remaining gap caused a wrong answer | — | — | — |

## Recommended Next Task

**No graph/retrieval implementation change is justified yet; collect more real-LLM evidence.**

Why: across two full rounds (24 answers), every answer passed. None of the
remaining gaps produced a wrong or materially incomplete answer. The one
measurable cost of each gap is a few tool calls, which is smaller than the
31% cost spread between identical runs. Choosing among A–H on this data would
mean ranking by intuition.

The evidence that would settle it (measurement, not implementation):

1. **Repeat each question ≥3 times** per condition, so a delta can be told apart
   from noise.
2. **Add questions that depend on the remaining gaps**, e.g. "what runs when
   `AssetCreate` is emitted?", "which handlers process the thumbnail queue?",
   "what breaks if `JobRepository.run` changes?". The current set was written
   before those gaps were known and touches them only in Q9.
3. **Run a smaller model** (and one session with built-in Read/Grep enabled).
   Tool-selection weaknesses that Opus absorbs by reading more source may become
   failures there. That is where B/C/D would show value if they have any.

If (2) shows event/job questions failing or costing substantially more across
repetitions, **A is the first candidate**: it is the only remaining graph gap
that forced the same question into text in both rounds.

## Verification

| Check | Before the run | After the run |
| --- | --- | --- |
| `pnpm typecheck` | exit 0 | exit 0 |
| `pnpm test` | 1,344 passed, 73 skipped | 1,344 passed, 73 skipped |
| `pnpm evaluate:retrieval --api http://localhost:3001` | 49/49 | 49/49 |

Production code unchanged. The only file changed by this run is this report.
Raw transcripts are in the session scratchpad (`…/scratchpad/v2/runs/Q01–Q12.jsonl`),
and every tool call is in [Appendix B](#appendix-b--follow-up-tool-call-sequences).

## Appendix A — Tool-call sequences

Every tool call from every run, in order. `projectId` is omitted (always
`d459a880-…`), and paths under the Immich snapshot are shortened. The size is
the length of the result as the model received it. Full stream-json transcripts
were captured in the session scratchpad
(`…/scratchpad/runs/Q01.jsonl` … `Q12.jsonl`, `Q02S.jsonl`, `p2-connectivity.jsonl`).

### Q01

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "albums", "nodeTypes": ["api"]}  → 2650 chars
#4 search_graph {"query": "album", "nodeTypes": ["class"]}  → 3759 chars
#5 get_node {"nodeId": "a4e0a278b2e81f27b6ca24e57becfd5f"}  → 2232 chars
#6 get_source {"file": "src/controllers/album.controller.ts", "startLine": 1, "endLine": 60}  → 3764 chars
#7 search_graph {"query": "create", "nodeTypes": ["method"], "file": "src/services/album.service.ts"}  → 410 chars
#8 get_source {"file": "src/services/album.service.ts", "startLine": 1, "endLine": 40}  → 2519 chars
#9 get_source {"file": "src/services/album.service.ts", "startLine": 101, "endLine": 140}  → 2469 chars
#10 get_node {"nodeId": "c5f19208ef8178ee1567da5ad21c8e08", "relationship": "callees"}  → 1671 chars
#11 get_source {"file": "src/repositories/album.repository.ts", "startLine": 295, "endLine": 375}  → 4488 chars
#12 get_node {"nodeId": "ab1bf2941962012558f50870f6814d5b"}  → 3091 chars
#13 get_source {"file": "src/schema/tables/album.table.ts"}  → 2569 chars
#14 search_code {"query": "class CreateAlbumDto"}  → 398 chars
#15 search_code {"query": "const CreateAlbumSchema"}  → 360 chars
#16 get_source {"file": "src/dtos/album.dto.ts", "startLine": 20, "endLine": 60}  → 2293 chars
#17 get_source {"file": "src/services/base.service.ts", "startLine": 280, "endLine": 305}  → 1613 chars
#18 get_source {"file": "src/repositories/album.repository.ts", "startLine": 85, "endLine": 95}  → 904 chars
#19 get_node {"nodeId": "5895149169315df7c5dbad5e5d9a9392"}  → 9894 chars
```

### Q02

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "AlbumService", "nodeTypes": ["class", "method"]}  → 3058 chars
#4 get_node {"nodeId": "c5f19208ef8178ee1567da5ad21c8e08"}  → 3594 chars
#5 get_source {"file": "src/services/album.service.ts", "startLine": 95, "endLine": 140}  → 2678 chars
#6 get_node {"nodeId": "ab1bf2941962012558f50870f6814d5b"}  → 3091 chars
#7 get_source {"file": "src/repositories/album.repository.ts", "startLine": 295, "endLine": 365}  → 4003 chars
#8 get_node {"nodeId": "a91b6aefaccf309120d248cb72498c68", "relationship": "databases"}  → 571 chars
#9 get_node {"nodeId": "14c77e2d479e817a882d55b2f9122670", "relationship": "databases"}  → 598 chars
#10 get_node {"nodeId": "a67e940158a93f8c9f41e51f64053263", "relationship": "databases"}  → 222 chars
#11 get_node {"nodeId": "cc917d77f9d32233ddacf34c751b5dac", "relationship": "databases"}  → 222 chars
#12 search_code {"query": "onAlbumInvite"}  → 797 chars
#13 search_graph {"query": "onAlbumInvite", "nodeTypes": ["method"]}  → 418 chars
#14 get_source {"file": "src/services/notification.service.ts", "startLine": 230, "endLine": 240}  → 841 chars
```

### Q03

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "AlbumService", "nodeTypes": ["class", "method"]}  → 3058 chars
#4 get_node {"nodeId": "c5f19208ef8178ee1567da5ad21c8e08", "relationship": "callers"}  → 1006 chars
#5 get_source {"file": "src/services/album.service.ts", "startLine": 101, "endLine": 138}  → 2332 chars
#6 get_source {"file": "src/controllers/album.controller.ts", "startLine": 30, "endLine": 50}  → 1477 chars
#7 get_source {"file": "src/services/workflow-execution.service.ts", "startLine": 55, "endLine": 105}  → 3536 chars
#8 search_code {"query": "createAlbum,", "limit": 20}  → 351 chars
#9 search_code {"query": "sut.create(", "limit": 30}  → 6490 chars
#10 get_source {"file": "src/services/album.service.spec.ts", "startLine": 205, "endLine": 380}  → 10709 chars
#11 get_source {"file": "src/services/workflow-execution.service.ts", "startLine": 106, "endLine": 140}  → 2021 chars
#12 get_source {"file": "src/services/workflow-execution.service.ts", "startLine": 440, "endLine": 517}  → 4080 chars
#13 search_code {"query": "albumService.create", "limit": 20}  → 467 chars
#14 search_code {"query": "  private wrap<", "limit": 5}  → 432 chars
#15 get_source {"file": "src/services/workflow-execution.service.ts", "startLine": 169, "endLine": 205}  → 2407 chars
#16 get_source {"file": "src/controllers/album.controller.ts", "startLine": 1, "endLine": 29}  → 1832 chars
```

### Q04

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "auth", "nodeTypes": ["file"], "limit": 40}  → 5855 chars
#4 search_graph {"query": "Guard", "nodeTypes": ["class", "interface"], "limit": 30}  → 1295 chars
#5 get_source {"file": "src/middleware/auth.guard.ts"}  → 7082 chars
#6 get_source {"file": "src/maintenance/maintenance-auth.guard.ts"}  → 2589 chars
#7 get_source {"file": "src/services/auth.service.ts"}  → 38334 chars
#8 search_code {"query": "APP_GUARD", "limit": 20}  → 1119 chars
#9 search_code {"query": "requireSetupAvailable", "limit": 20}  → 2379 chars
#10 get_source {"file": "src/app.module.ts", "startLine": 30, "endLine": 140}  → 6489 chars
#11 get_source {"file": "src/dtos/auth.dto.ts", "startLine": 1, "endLine": 80}  → 4682 chars
#12 search_graph {"query": "access", "nodeTypes": ["function"], "file": "src/utils/access.ts", "limit": 20}  → 218 chars
#13 search_code {"query": "export enum ImmichHeader", "limit": 5}  → 350 chars
#14 get_source {"file": "src/enum.ts", "startLine": 1, "endLine": 70}  → 3494 chars
#15 search_code {"query": "export const isGranted", "limit": 5}  → 398 chars
#16 get_source {"file": "src/utils/access.ts", "startLine": 1, "endLine": 90}  → 5021 chars
#17 search_code {"query": "export type AuthUser", "limit": 5}  → 344 chars
#18 get_source {"file": "src/database.ts", "startLine": 15, "endLine": 75}  → 2723 chars
#19 get_source {"file": "src/controllers/auth.controller.ts"}  → 10584 chars
#20 search_code {"query": "getAuthenticatedOptions", "limit": 20}  → 1075 chars
#21 get_source {"file": "src/controllers/oauth.controller.ts"}  → 7645 chars
#22 get_source {"file": "src/controllers/index.spec.ts", "startLine": 60, "endLine": 160}  → 4669 chars
#23 search_code {"query": "async authenticate(", "limit": 20}  → 847 chars
#24 get_source {"file": "src/maintenance/maintenance-worker.service.ts", "startLine": 225, "endLine": 290}  → 3445 chars
#25 get_source {"file": "src/repositories/websocket.repository.ts", "startLine": 85, "endLine": 150}  → 2627 chars
#26 get_source {"file": "src/services/auth-admin.service.ts"}  → 714 chars
#27 get_source {"file": "src/services/base.service.ts", "startLine": 240, "endLine": 330}  → 4936 chars
#28 get_source {"file": "src/repositories/oauth.repository.ts", "startLine": 1, "endLine": 120}  → 6424 chars
#29 search_code {"query": "hasElevatedPermission", "limit": 20}  → 4500 chars
#30 search_code {"query": "shared-links/login", "limit": 10}  → 359 chars
#31 search_code {"query": "expiresAt", "limit": 15}  → 2871 chars
#32 get_source {"file": "src/controllers/index.spec.ts", "startLine": 1, "endLine": 66}  → 3719 chars
#33 search_code {"query": "getByToken", "limit": 10}  → 1675 chars
#34 get_source {"file": "src/repositories/session.repository.ts", "startLine": 30, "endLine": 90}  → 3420 chars
#35 search_code {"query": "SharedLinkToken", "limit": 15}  → 1017 chars
#36 get_source {"file": "src/controllers/shared-link.controller.ts", "startLine": 25, "endLine": 100}  → 4519 chars
#37 search_code {"query": "requireUploadAccess", "limit": 10}  → 1104 chars
#38 search_code {"query": "export enum Permission", "limit": 5}  → 345 chars
#39 search_code {"query": "async login(auth: AuthDto", "limit": 5}  → 405 chars
#40 get_source {"file": "src/enum.ts", "startLine": 112, "endLine": 150}  → 2152 chars
#41 get_source {"file": "src/services/shared-link.service.ts", "startLine": 20, "endLine": 80}  → 3554 chars
#42 search_code {"query": "ApiKeySecurity", "limit": 10}  → 707 chars
#43 search_code {"query": "getKey(hashedToken", "limit": 10}  → 371 chars
#44 get_source {"file": "src/utils/misc.ts", "startLine": 320, "endLine": 360}  → 2265 chars
#45 get_source {"file": "src/repositories/api-key.repository.ts", "startLine": 25, "endLine": 60}  → 1973 chars
#46 search_code {"query": "passport", "limit": 10}  → 191 chars
#47 search_code {"query": "CanActivate", "limit": 15}  → 935 chars
```

### Q05

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "BaseService", "nodeTypes": ["class"]}  → 551 chars
#4 get_node {"nodeId": "6b130b75db8258d219624819ca7e343e", "relationship": "subtypes", "limit": 100}  → 17022 chars
#5 get_source {"file": "src/services/base.service.ts"}  → 20712 chars
#6 get_source {"file": "src/services/activity.service.ts"}  → 4244 chars
#7 search_code {"query": "extends BaseService {", "limit": 50}  → 9572 chars
#8 search_code {"query": "  constructor(", "limit": 50}  → 8814 chars
#9 search_code {"query": "  @OnEvent({ name: ", "limit": 50}  → 9526 chars
#10 get_source {"file": "src/services/database-backup.service.ts", "startLine": 1, "endLine": 60}  → 4309 chars
#11 search_graph {"query": "constructor", "file": "src/services/", "limit": 50}  → 814 chars
#12 search_graph {"query": "Service", "file": "src/services/", "nodeTypes": ["class"], "limit": 50}  → 8994 chars
#13 get_source {"file": "src/services/index.ts"}  → 7065 chars
#14 search_code {"query": "BaseService.create(", "limit": 20}  → 830 chars
#15 get_source {"file": "src/services/view.service.ts"}  → 1188 chars
#16 get_source {"file": "src/services/library.service.ts", "startLine": 39, "endLine": 80}  → 2340 chars
#17 search_code {"query": "  @OnJob({ name: ", "limit": 15}  → 3495 chars
#18 search_code {"query": "newTestService", "limit": 5}  → 1164 chars
```

### Q06

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "NestInterceptor"}  → 202 chars
#4 search_code {"query": "implements NestInterceptor", "limit": 50}  → 1052 chars
#5 search_code {"query": "NestInterceptor", "limit": 50}  → 1862 chars
#6 search_code {"query": "intercept(", "limit": 50}  → 1051 chars
#7 get_source {"file": "src/middleware/asset-upload.interceptor.ts", "startLine": 1, "endLine": 30}  → 1935 chars
#8 get_source {"file": "src/middleware/error.interceptor.ts", "startLine": 1, "endLine": 35}  → 2114 chars
#9 get_source {"file": "src/middleware/file-upload.interceptor.ts", "startLine": 35, "endLine": 90}  → 3219 chars
#10 get_source {"file": "src/middleware/logging.interceptor.ts", "startLine": 15, "endLine": 45}  → 1772 chars
#11 search_code {"query": "extends FileUploadInterceptor"}  → 212 chars
#12 search_code {"query": "extends ErrorInterceptor"}  → 207 chars
#13 search_code {"query": "extends LoggingInterceptor"}  → 209 chars
#14 search_code {"query": "extends AssetUploadInterceptor"}  → 213 chars
```

### Q07

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "asset", "nodeTypes": ["api"], "limit": 50}  → 7893 chars
#4 search_graph {"query": "asset-media", "limit": 30}  → 6288 chars
#5 get_source {"file": "src/controllers/asset-media.controller.ts", "startLine": 1, "endLine": 95}  → 5401 chars
#6 get_node {"nodeId": "9c1232ebcc9f8d9e17381ce8f2725e70"}  → 4993 chars
#7 get_source {"file": "src/services/asset-media.service.ts", "startLine": 44, "endLine": 230}  → 10434 chars
#8 get_source {"file": "src/services/asset-media.service.ts", "startLine": 340, "endLine": 420}  → 1899 chars
#9 get_source {"file": "src/repositories/asset.repository.ts", "startLine": 440, "endLine": 470}  → 2010 chars
#10 get_source {"file": "src/middleware/asset-upload.interceptor.ts"}  → 1935 chars
#11 get_source {"file": "src/middleware/file-upload.interceptor.ts"}  → 9258 chars
#12 get_source {"file": "src/repositories/asset.repository.ts", "startLine": 175, "endLine": 200}  → 1589 chars
#13 search_code {"query": "@OnEvent({ name: 'AssetCreate'"}  → 582 chars
#14 search_code {"query": "JobName.AssetExtractMetadata,", "limit": 20}  → 2669 chars
#15 get_source {"file": "src/services/user.service.ts", "startLine": 236, "endLine": 255}  → 1230 chars
#16 get_source {"file": "src/services/metadata.service.ts", "startLine": 225, "endLine": 330}  → 6271 chars
#17 get_source {"file": "src/services/metadata.service.ts", "startLine": 330, "endLine": 440}  → 6451 chars
#18 search_graph {"query": "onBeforeLink"}  → 368 chars
#19 get_source {"file": "src/utils/asset.util.ts", "startLine": 100, "endLine": 200}  → 5483 chars
#20 search_code {"query": "isAssetChecksumConstraint"}  → 1382 chars
#21 get_source {"file": "src/utils/database.ts", "startLine": 60, "endLine": 110}  → 2760 chars
#22 get_source {"file": "src/repositories/asset.repository.ts", "startLine": 380, "endLine": 400}  → 1342 chars
#23 get_source {"file": "src/repositories/asset.repository.ts", "startLine": 650, "endLine": 700}  → 3083 chars
#24 get_source {"file": "src/repositories/asset.repository.ts", "startLine": 1010, "endLine": 1040}  → 1673 chars
#25 search_code {"query": "'AssetMetadataExtracted' })"}  → 804 chars
#26 get_source {"file": "src/services/workflow-execution.service.ts", "startLine": 300, "endLine": 325}  → 1670 chars
#27 get_source {"file": "src/services/storage-template.service.ts", "startLine": 130, "endLine": 175}  → 3092 chars
#28 get_source {"file": "src/services/job.service.ts", "startLine": 80, "endLine": 175}  → 5756 chars
#29 get_source {"file": "src/services/job.service.ts", "startLine": 175, "endLine": 240}  → 4655 chars
#30 get_node {"nodeId": "09abf440bbfa943dcd4265eb7f43e366", "relationship": "databases"}  → 575 chars
#31 search_code {"query": "const requireUploadAccess"}  → 406 chars
#32 get_source {"file": "src/utils/access.ts", "startLine": 25, "endLine": 45}  → 1377 chars
#33 get_source {"file": "src/services/base.service.ts", "startLine": 280, "endLine": 300}  → 1299 chars
#34 search_code {"query": "static getNestedFolder"}  → 428 chars
#35 get_source {"file": "src/cores/storage.core.ts", "startLine": 348, "endLine": 365}  → 1141 chars
```

### Q08

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "AlbumRepository"}  → 4458 chars
#4 get_node {"nodeId": "ab1bf2941962012558f50870f6814d5b"}  → 3091 chars
#5 get_source {"file": "src/repositories/album.repository.ts", "startLine": 300, "endLine": 362}  → 3544 chars
#6 get_node {"nodeId": "c5f19208ef8178ee1567da5ad21c8e08"}  → 3594 chars
#7 get_node {"nodeId": "210cde94d07a58393be91930d3d65f6d"}  → 2595 chars
#8 get_node {"nodeId": "e147728194473070d6c2417bc136cc08"}  → 5735 chars
#9 get_node {"nodeId": "1b09eb37cfaa750644680d5d9788a652"}  → 4193 chars
#10 get_source {"file": "src/services/album.service.ts", "startLine": 101, "endLine": 138}  → 2332 chars
#11 search_code {"query": "AlbumRepository.create", "limit": 30}  → 368 chars
#12 search_code {"query": "albumRepository.create", "limit": 30}  → 393 chars
#13 get_source {"file": "test/medium.factory.ts", "startLine": 228, "endLine": 275}  → 3306 chars
#14 search_code {"query": "mocks.album.create", "limit": 20}  → 1962 chars
#15 search_graph {"query": "mapAlbum"}  → 2723 chars
#16 search_code {"query": "albumService.create", "limit": 20}  → 467 chars
#17 get_source {"file": "src/dtos/album.dto.ts", "startLine": 216, "endLine": 250}  → 1946 chars
#18 get_source {"file": "src/queries/album.repository.sql", "startLine": 320, "endLine": 360}  → 1922 chars
#19 get_node {"nodeId": "45a933030fec443e5fa347c087147ff7", "relationship": "callers"}  → 523 chars
```

### Q09

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "JobRepository"}  → 4063 chars
#4 search_code {"query": "OnJob", "limit": 20}  → 4227 chars
#5 get_source {"file": "src/repositories/job.repository.ts", "startLine": 1, "endLine": 160}  → 8989 chars
#6 get_source {"file": "src/decorators.ts", "startLine": 120, "endLine": 175}  → 3178 chars
#7 get_node {"nodeId": "a332bc9421449ec884c26e466c9f8394", "relationship": "callers"}  → 461 chars
#8 search_code {"query": "JobRun", "limit": 20}  → 1745 chars
#9 get_source {"file": "src/services/queue.service.ts", "startLine": 60, "endLine": 120}  → 3515 chars
#10 get_source {"file": "src/services/job.service.ts", "startLine": 1, "endLine": 140}  → 7922 chars
#11 get_source {"file": "src/repositories/job.repository.ts", "startLine": 194, "endLine": 250}  → 3465 chars
#12 search_code {"query": "setServices(", "limit": 10}  → 540 chars
#13 get_source {"file": "src/app.module.ts"}  → 10234 chars
#14 get_source {"file": "src/repositories/job.repository.ts", "startLine": 256, "endLine": 298}  → 2438 chars
#15 search_code {"query": "queues: ", "limit": 10}  → 917 chars
#16 search_graph {"query": "EventRepository", "file": "src/repositories/event.repository.ts", "nodeTypes": ["method"]}  → 1234 chars
#17 get_source {"file": "src/repositories/event.repository.ts", "startLine": 165, "endLine": 245}  → 4198 chars
#18 search_code {"query": "export type JobItem =", "limit": 5}  → 341 chars
#19 get_source {"file": "src/services/asset.service.ts", "startLine": 270, "endLine": 320}  → 3436 chars
#20 get_source {"file": "src/types.ts", "startLine": 325, "endLine": 360}  → 1916 chars
```

### Q10

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "SharedLink", "limit": 50}  → 9565 chars
#4 search_graph {"query": "shared_link", "nodeTypes": ["table"], "limit": 20}  → 898 chars
#5 get_node {"nodeId": "2ec37c219ba465aaf330550343f78e97"}  → 10257 chars
#6 get_source {"file": "src/repositories/shared-link.repository.ts"}  → 15263 chars
#7 get_source {"file": "src/services/shared-link.service.ts"}  → 13817 chars
#8 get_source {"file": "src/schema/tables/shared-link.table.ts"}  → 2798 chars
#9 get_source {"file": "src/schema/tables/shared-link-asset.table.ts"}  → 958 chars
#10 get_source {"file": "src/controllers/shared-link.controller.ts"}  → 10261 chars
#11 get_source {"file": "src/repositories/shared-link-asset.repository.ts"}  → 2113 chars
#12 get_source {"file": "src/database.ts", "startLine": 170, "endLine": 196}  → 1400 chars
#13 get_node {"nodeId": "2a8a78802a77504c96a8875934f3cda5", "relationship": "callers"}  → 480 chars
#14 search_code {"query": "\"shared_link\" (", "limit": 10}  → 200 chars
#15 search_code {"query": "shared_link_slug_uq", "limit": 10}  → 941 chars
#16 search_code {"query": "CREATE TABLE \"shared_link\"", "limit": 10}  → 211 chars
#17 search_code {"query": "SharedLinkTable", "limit": 20}  → 3168 chars
#18 get_node {"nodeId": "7fc18f35f6e02647c0bba9e3b3339c4f", "relationship": "callers"}  → 794 chars
#19 get_source {"file": "src/services/auth.service.ts", "startLine": 490, "endLine": 540}  → 3057 chars
```

### Q11

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "album", "nodeTypes": ["class"], "limit": 30}  → 5495 chars
#4 search_graph {"query": "album", "nodeTypes": ["table"], "limit": 30}  → 2274 chars
#5 get_node {"nodeId": "cf79913e3d8129b5e73d6cf58449d1ff"}  → 9954 chars
#6 get_node {"nodeId": "6232d5e7b6925ee2fd36ddef711f2180"}  → 8048 chars
#7 get_node {"nodeId": "4a31b1685051dc944235f999732fd272"}  → 13928 chars
#8 get_source {"file": "src/controllers/album.controller.ts", "startLine": 1, "endLine": 75}  → 4595 chars
#9 get_source {"file": "src/services/album.service.ts", "startLine": 1, "endLine": 145}  → 9035 chars
#10 get_source {"file": "src/schema/tables/album.table.ts"}  → 2569 chars
#11 get_source {"file": "src/repositories/album.repository.ts", "startLine": 1, "endLine": 130}  → 7562 chars
#12 get_source {"file": "src/repositories/album.repository.ts", "startLine": 289, "endLine": 400}  → 6279 chars
#13 get_source {"file": "src/repositories/album-user.repository.ts"}  → 2549 chars
#14 trace_path {"fromNodeId": "cf79913e3d8129b5e73d6cf58449d1ff", "toNodeId": "2944f8a82c68b5aaab0720930224c977"}  → 1908 chars
#15 search_code {"query": "protected albumRepository"}  → 392 chars
#16 search_code {"query": "album: AlbumTable"}  → 340 chars
#17 get_source {"file": "src/schema/index.ts", "startLine": 196, "endLine": 220}  → 1311 chars
#18 get_source {"file": "src/services/base.service.ts", "startLine": 126, "endLine": 145}  → 1489 chars
#19 get_source {"file": "src/schema/tables/album-asset.table.ts"}  → 2127 chars
#20 get_source {"file": "src/services/album.service.ts", "startLine": 261, "endLine": 358}  → 5914 chars
#21 get_source {"file": "src/repositories/access.repository.ts", "startLine": 60, "endLine": 140}  → 4794 chars
#22 get_source {"file": "src/schema/tables/album-user.table.ts", "startLine": 20, "endLine": 50}  → 1701 chars
```

### Q12

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "albums", "nodeTypes": ["api"]}  → 2650 chars
#4 search_graph {"query": "AlbumRepository", "nodeTypes": ["class"]}  → 388 chars
#5 search_graph {"query": "create", "nodeTypes": ["method"], "file": "src/repositories/album.repository.ts"}  → 427 chars
#6 get_node {"nodeId": "a4e0a278b2e81f27b6ca24e57becfd5f"}  → 2232 chars
#7 trace_path {"fromNodeId": "a4e0a278b2e81f27b6ca24e57becfd5f", "toNodeId": "ab1bf2941962012558f50870f6814d5b"}  → 1894 chars
#8 get_node {"nodeId": "ab1bf2941962012558f50870f6814d5b"}  → 3091 chars
#9 get_source {"file": "src/repositories/album.repository.ts", "startLine": 296, "endLine": 362}  → 3817 chars
#10 get_source {"file": "src/services/album.service.ts", "startLine": 95, "endLine": 140}  → 2678 chars
#11 get_source {"file": "src/controllers/album.controller.ts", "startLine": 38, "endLine": 50}  → 905 chars
#12 get_node {"nodeId": "5895149169315df7c5dbad5e5d9a9392"}  → 9894 chars
#13 search_code {"query": "albumRepository.create"}  → 393 chars
#14 search_code {"query": "AlbumRepository.create"}  → 368 chars
#15 search_graph {"query": "album", "nodeTypes": ["file"]}  → 4656 chars
#16 get_source {"file": "src/queries/album.repository.sql", "startLine": 323, "endLine": 375}  → 2385 chars
#17 get_source {"file": "src/schema/tables/album.table.ts"}  → 2569 chars
#18 search_code {"query": "describe('create'", "limit": 15}  → 2746 chars
#19 search_graph {"query": "withAlbumUsers"}  → 383 chars
#20 search_code {"query": "sql:generate"}  → 195 chars
#21 search_code {"query": "test:medium"}  → 371 chars
#22 get_source {"file": "package.json", "startLine": 12, "endLine": 45}  → 3003 chars
#23 search_code {"query": "src/queries"}  → 357 chars
```

### Q02S

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 745 chars
#3 search_graph {"query": "AlbumService", "nodeTypes": ["class"]}  → 375 chars
#4 search_graph {"query": "create", "nodeTypes": ["method"], "file": "src/services/album.service.ts"}  → 410 chars
#5 get_node {"nodeId": "c5f19208ef8178ee1567da5ad21c8e08"}  → 3594 chars
#6 get_source {"file": "src/services/album.service.ts", "startLine": 95, "endLine": 145}  → 2995 chars
#7 search_code {"query": "  async create(", "limit": 30}  → 4474 chars
#8 get_source {"file": "src/repositories/album.repository.ts", "startLine": 295, "endLine": 380}  → 4763 chars
#9 get_node {"nodeId": "ab1bf2941962012558f50870f6814d5b", "relationship": "databases"}  → 1316 chars
#10 get_source {"file": "src/repositories/user.repository.ts", "startLine": 44, "endLine": 70}  → 1515 chars
#11 search_code {"query": "'AlbumInvite'", "limit": 20}  → 1978 chars
#12 get_source {"file": "src/services/notification.service.ts", "startLine": 230, "endLine": 275}  → 2934 chars
```

## Appendix B — Follow-up tool-call sequences

The follow-up validation run, in the same format as Appendix A.

### Q01 (follow-up)

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "albums", "nodeTypes": ["api"], "limit": 30}  → 2650 chars
#4 search_graph {"query": "album", "nodeTypes": ["class"], "limit": 30}  → 5495 chars
#5 get_node {"nodeId": "a4e0a278b2e81f27b6ca24e57becfd5f"}  → 2232 chars
#6 get_source {"file": "src/controllers/album.controller.ts", "startLine": 1, "endLine": 60}  → 3764 chars
#7 search_graph {"query": "create", "nodeTypes": ["method"], "file": "src/services/album.service.ts"}  → 410 chars
#8 get_source {"file": "src/services/album.service.ts", "startLine": 1, "endLine": 40}  → 2519 chars
#9 get_source {"file": "src/services/album.service.ts", "startLine": 101, "endLine": 140}  → 2469 chars
#10 get_node {"nodeId": "c5f19208ef8178ee1567da5ad21c8e08", "relationship": "callees"}  → 2103 chars
#11 get_source {"file": "src/repositories/album.repository.ts", "startLine": 296, "endLine": 360}  → 3680 chars
#12 get_node {"nodeId": "ab1bf2941962012558f50870f6814d5b"}  → 3409 chars
#13 get_source {"file": "src/schema/tables/album.table.ts"}  → 2569 chars
#14 search_code {"query": "export class CreateAlbumDto"}  → 412 chars
#15 search_code {"query": "CreateAlbumSchema"}  → 542 chars
#16 get_source {"file": "src/repositories/album.repository.ts", "startLine": 80, "endLine": 95}  → 1177 chars
#17 get_source {"file": "src/dtos/album.dto.ts", "startLine": 20, "endLine": 60}  → 2293 chars
#18 search_code {"query": "setGlobalPrefix"}  → 369 chars
#19 get_source {"file": "src/repositories/album.repository.ts", "startLine": 20, "endLine": 60}  → 2426 chars
```

### Q02 (follow-up)

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "AlbumService", "nodeTypes": ["class", "method"]}  → 3058 chars
#4 get_node {"nodeId": "c5f19208ef8178ee1567da5ad21c8e08"}  → 3902 chars
#5 get_source {"file": "src/services/album.service.ts", "startLine": 101, "endLine": 138}  → 2332 chars
#6 get_node {"nodeId": "ab1bf2941962012558f50870f6814d5b"}  → 3409 chars
#7 get_source {"file": "src/repositories/album.repository.ts", "startLine": 295, "endLine": 365}  → 4003 chars
#8 get_node {"nodeId": "a91b6aefaccf309120d248cb72498c68", "relationship": "databases"}  → 571 chars
#9 get_node {"nodeId": "14c77e2d479e817a882d55b2f9122670", "relationship": "databases"}  → 598 chars
#10 get_node {"nodeId": "a67e940158a93f8c9f41e51f64053263", "relationship": "databases"}  → 222 chars
#11 search_code {"query": "'AlbumInvite'"}  → 1978 chars
#12 get_source {"file": "src/services/notification.service.ts", "startLine": 234, "endLine": 285}  → 3305 chars
#13 search_code {"query": "JobName.NotifyAlbumInvite }"}  → 210 chars
#14 search_code {"query": "JobName.NotifyAlbumInvite"}  → 1320 chars
#15 search_graph {"query": "handleAlbumInvite", "nodeTypes": ["method"]}  → 430 chars
#16 get_node {"nodeId": "248b338033b459c9fb6d33d9aca912a0", "relationship": "databases"}  → 222 chars
#17 get_source {"file": "src/services/notification.service.ts", "startLine": 325, "endLine": 373}  → 2933 chars
#18 search_graph {"query": "NotificationRepository.create", "nodeTypes": ["method"]}  → 428 chars
#19 get_node {"nodeId": "2b1f9541a85b5033f7d644429414716f", "relationship": "databases"}  → 602 chars
```

### Q03 (follow-up)

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "AlbumService", "nodeTypes": ["class"]}  → 375 chars
#4 search_graph {"query": "AlbumService.create"}  → 390 chars
#5 get_node {"nodeId": "c5f19208ef8178ee1567da5ad21c8e08"}  → 3902 chars
#6 get_source {"file": "src/services/album.service.ts", "startLine": 95, "endLine": 140}  → 2678 chars
#7 get_source {"file": "src/controllers/album.controller.ts", "startLine": 30, "endLine": 50}  → 1477 chars
#8 get_source {"file": "src/services/workflow-execution.service.ts", "startLine": 1, "endLine": 120}  → 7239 chars
#9 get_source {"file": "src/services/workflow-execution.service.ts", "startLine": 117, "endLine": 180}  → 3878 chars
#10 search_code {"query": "sut.create(", "limit": 50}  → 11070 chars
#11 get_source {"file": "src/services/album.service.spec.ts", "startLine": 205, "endLine": 375}  → 10438 chars
#12 get_source {"file": "src/services/workflow-execution.service.ts", "startLine": 180, "endLine": 225}  → 2679 chars
#13 search_code {"query": "albumService.create"}  → 467 chars
#14 get_source {"file": "src/services/base.service.ts", "startLine": 196, "endLine": 210}  → 940 chars
```

### Q04 (follow-up)

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "auth", "nodeTypes": ["class", "interface", "function"], "limit": 50}  → 9157 chars
#4 search_graph {"query": "guard", "limit": 30}  → 5801 chars
#5 get_source {"file": "src/middleware/auth.guard.ts"}  → 7082 chars
#6 get_source {"file": "src/maintenance/maintenance-auth.guard.ts"}  → 2589 chars
#7 get_source {"file": "src/services/auth.service.ts", "startLine": 1, "endLine": 120}  → 7087 chars
#8 search_code {"query": "  async authenticate("}  → 662 chars
#9 get_source {"file": "src/services/auth.service.ts", "startLine": 215, "endLine": 300}  → 5045 chars
#10 search_code {"query": "private async validate"}  → 1114 chars
#11 get_source {"file": "src/services/auth.service.ts", "startLine": 480, "endLine": 620}  → 7933 chars
#12 get_source {"file": "src/dtos/auth.dto.ts", "startLine": 1, "endLine": 60}  → 3418 chars
#13 search_code {"query": "APP_GUARD"}  → 1119 chars
#14 get_node {"nodeId": "fbd1d7db020f3233434f835d82c73b20"}  → 3208 chars
#15 get_source {"file": "src/app.module.ts", "startLine": 30, "endLine": 140}  → 6489 chars
#16 search_code {"query": "enum ImmichHeader"}  → 337 chars
#17 get_source {"file": "src/enum.ts", "startLine": 1, "endLine": 75}  → 3744 chars
#18 search_code {"query": "export const isGranted"}  → 399 chars
#19 get_source {"file": "src/utils/access.ts", "startLine": 1, "endLine": 70}  → 3955 chars
#20 search_code {"query": "hasElevatedPermission"}  → 4500 chars
#21 search_code {"query": "requireAccess(", "limit": 5}  → 1305 chars
#22 get_source {"file": "src/maintenance/maintenance-worker.service.ts", "startLine": 230, "endLine": 285}  → 3010 chars
#23 get_source {"file": "src/controllers/auth.controller.ts"}  → 10584 chars
#24 search_code {"query": "export const respondWithCookie"}  → 450 chars
#25 search_code {"query": "getAuthenticatedOptions"}  → 1075 chars
#26 get_source {"file": "src/controllers/oauth.controller.ts", "startLine": 1, "endLine": 133}  → 7645 chars
#27 get_source {"file": "src/controllers/index.spec.ts", "startLine": 60, "endLine": 140}  → 4669 chars
#28 get_source {"file": "src/services/auth.service.ts", "startLine": 613, "endLine": 679}  → 3784 chars
#29 search_code {"query": "requireSetupAvailable"}  → 2379 chars
#30 search_code {"query": "  protected requireAccess"}  → 208 chars
#31 get_source {"file": "src/services/base.service.ts", "startLine": 270, "endLine": 340}  → 3603 chars
#32 get_source {"file": "src/controllers/shared-link.controller.ts", "startLine": 25, "endLine": 80}  → 3301 chars
#33 get_source {"file": "src/services/auth-admin.service.ts"}  → 714 chars
#34 search_code {"query": "export enum Permission {"}  → 350 chars
#35 get_source {"file": "src/enum.ts", "startLine": 112, "endLine": 140}  → 1645 chars
#36 get_source {"file": "src/database.ts", "startLine": 180, "endLine": 215}  → 1745 chars
#37 get_source {"file": "src/services/auth.service.ts", "startLine": 465, "endLine": 483}  → 1084 chars
```

### Q05 (follow-up)

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "BaseService", "nodeTypes": ["class"]}  → 551 chars
#4 get_node {"nodeId": "6b130b75db8258d219624819ca7e343e", "relationship": "subtypes", "limit": 100}  → 17022 chars
#5 get_source {"file": "src/services/base.service.ts"}  → 20712 chars
#6 get_source {"file": "src/services/activity.service.ts", "startLine": 1, "endLine": 60}  → 3483 chars
#7 search_code {"query": "  constructor(", "limit": 50}  → 8814 chars
#8 search_code {"query": "extends BaseService", "limit": 50}  → 9470 chars
#9 search_code {"query": "Service extends BaseService {", "limit": 10}  → 2157 chars
#10 get_source {"file": "src/services/index.ts"}  → 7065 chars
#11 search_code {"query": "> extends BaseService", "limit": 15}  → 204 chars
#12 get_source {"file": "src/services/api.service.ts", "startLine": 1, "endLine": 40}  → 2574 chars
#13 get_source {"file": "src/services/database-backup.service.ts", "startLine": 1, "endLine": 40}  → 3177 chars
#14 search_code {"query": "extends BaseService implements", "limit": 15}  → 213 chars
#15 search_graph {"query": "BaseService"}  → 4048 chars
#16 search_code {"query": "T extends BaseService", "limit": 15}  → 1238 chars
#17 get_source {"file": "test/utils.ts", "startLine": 290, "endLine": 330}  → 2929 chars
#18 search_code {"query": "@Injectable()", "limit": 50}  → 7625 chars
#19 get_source {"file": "src/services/view.service.ts"}  → 1188 chars
#20 search_code {"query": "  @OnJob({", "limit": 50}  → 10461 chars
#21 get_node {"nodeId": "e747edfe56609be0854659fd522a0d45", "relationship": "callers", "limit": 30}  → 770 chars
#22 search_code {"query": "super(", "limit": 30}  → 3482 chars
#23 search_graph {"query": "constructor", "file": "src/services/", "limit": 30}  → 814 chars
```

### Q06 (follow-up)

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "NestInterceptor"}  → 202 chars
#4 search_code {"query": "NestInterceptor", "limit": 50}  → 1862 chars
#5 search_graph {"query": "Interceptor", "nodeTypes": ["class"], "limit": 50}  → 955 chars
#6 get_source {"file": "src/middleware/asset-upload.interceptor.ts", "startLine": 1, "endLine": 30}  → 1935 chars
#7 get_node {"nodeId": "5089fef2fdbeb4a6db4bd5d2edf2f7e5", "relationship": "subtypes"}  → 221 chars
#8 get_source {"file": "src/middleware/error.interceptor.ts", "startLine": 1, "endLine": 39}  → 2220 chars
#9 get_source {"file": "src/middleware/logging.interceptor.ts", "startLine": 19, "endLine": 47}  → 1715 chars
#10 get_source {"file": "src/middleware/file-upload.interceptor.ts", "startLine": 36, "endLine": 80}  → 2712 chars
```

### Q07 (follow-up)

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "asset", "nodeTypes": ["api"], "limit": 50}  → 7893 chars
#4 search_graph {"query": "asset-media", "limit": 30}  → 6288 chars
#5 get_source {"file": "src/controllers/asset-media.controller.ts", "startLine": 1, "endLine": 95}  → 5401 chars
#6 get_source {"file": "src/services/asset-media.service.ts", "startLine": 1, "endLine": 240}  → 13309 chars
#7 search_graph {"query": "create", "file": "src/repositories/asset.repository.ts", "limit": 20}  → 859 chars
#8 get_source {"file": "src/middleware/file-upload.interceptor.ts"}  → 9258 chars
#9 get_source {"file": "src/repositories/asset.repository.ts", "startLine": 430, "endLine": 470}  → 2610 chars
#10 get_source {"file": "src/middleware/asset-upload.interceptor.ts"}  → 1935 chars
#11 search_graph {"query": "onBeforeLink", "limit": 10}  → 368 chars
#12 search_graph {"query": "upsertExif", "limit": 10}  → 1682 chars
#13 search_graph {"query": "requireQuota", "limit": 10}  → 406 chars
#14 search_graph {"query": "getUploadAssetIdByChecksum", "limit": 10}  → 681 chars
#15 get_source {"file": "src/utils/asset.util.ts", "startLine": 100, "endLine": 175}  → 4115 chars
#16 get_source {"file": "src/services/asset-media.service.ts", "startLine": 340, "endLine": 373}  → 1899 chars
#17 get_source {"file": "src/repositories/asset.repository.ts", "startLine": 675, "endLine": 700}  → 1608 chars
#18 search_code {"query": "'AssetCreate'", "limit": 30}  → 1824 chars
#19 search_code {"query": "JobName.AssetExtractMetadata", "limit": 30}  → 4579 chars
#20 get_source {"file": "src/services/user.service.ts", "startLine": 238, "endLine": 255}  → 1130 chars
#21 get_source {"file": "src/services/workflow-execution.service.ts", "startLine": 303, "endLine": 320}  → 1296 chars
#22 get_source {"file": "src/services/metadata.service.ts", "startLine": 228, "endLine": 250}  → 1602 chars
#23 get_node {"nodeId": "09abf440bbfa943dcd4265eb7f43e366"}  → 2488 chars
#24 search_code {"query": "export const isAssetChecksumConstraint", "limit": 5}  → 423 chars
#25 search_code {"query": "export const mapToUploadFile", "limit": 5}  → 210 chars
#26 get_source {"file": "src/utils/database.ts", "startLine": 95, "endLine": 115}  → 1375 chars
#27 search_code {"query": "mapToUploadFile", "limit": 10}  → 956 chars
#28 get_source {"file": "src/repositories/asset.repository.ts", "startLine": 181, "endLine": 230}  → 3231 chars
#29 get_node {"nodeId": "9c1232ebcc9f8d9e17381ce8f2725e70"}  → 5316 chars
#30 get_source {"file": "src/utils/asset.util.ts", "startLine": 188, "endLine": 215}  → 1641 chars
#31 get_source {"file": "src/repositories/asset.repository.ts", "startLine": 252, "endLine": 310}  → 3857 chars
#32 get_source {"file": "src/repositories/asset.repository.ts", "startLine": 386, "endLine": 412}  → 1552 chars
#33 get_source {"file": "src/repositories/asset.repository.ts", "startLine": 1016, "endLine": 1040}  → 1441 chars
#34 search_code {"query": "export const requireUploadAccess", "limit": 5}  → 419 chars
#35 search_code {"query": "static getNestedFolder", "limit": 5}  → 427 chars
#36 get_source {"file": "src/utils/access.ts", "startLine": 28, "endLine": 45}  → 1205 chars
#37 get_source {"file": "src/cores/storage.core.ts", "startLine": 348, "endLine": 368}  → 1342 chars
```

### Q08 (follow-up)

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "AlbumRepository"}  → 4458 chars
#4 search_graph {"query": "create", "file": "src/repositories/album.repository.ts"}  → 421 chars
#5 get_node {"nodeId": "ab1bf2941962012558f50870f6814d5b"}  → 3409 chars
#6 get_source {"file": "src/repositories/album.repository.ts", "startLine": 300, "endLine": 360}  → 3407 chars
#7 get_node {"nodeId": "c5f19208ef8178ee1567da5ad21c8e08"}  → 3902 chars
#8 get_node {"nodeId": "210cde94d07a58393be91930d3d65f6d"}  → 2902 chars
#9 get_node {"nodeId": "1b09eb37cfaa750644680d5d9788a652"}  → 4338 chars
#10 get_node {"nodeId": "e147728194473070d6c2417bc136cc08"}  → 5735 chars
#11 get_source {"file": "src/services/album.service.ts", "startLine": 101, "endLine": 138}  → 2332 chars
#12 search_code {"query": "AlbumRepository.create", "limit": 30}  → 368 chars
#13 get_source {"file": "test/medium.factory.ts", "startLine": 230, "endLine": 270}  → 2847 chars
#14 get_node {"nodeId": "fb83bf24abf186751270c822bb65ee96"}  → 3648 chars
#15 get_node {"nodeId": "72a532ed546799e267db57b4e71108f9"}  → 3285 chars
#16 get_node {"nodeId": "a4e0a278b2e81f27b6ca24e57becfd5f"}  → 2232 chars
#17 search_code {"query": "albumRepository.create", "limit": 30}  → 393 chars
#18 get_source {"file": "src/queries/album.repository.sql", "startLine": 320, "endLine": 340}  → 1002 chars
#19 search_code {"query": "albumService.create", "limit": 10}  → 467 chars
#20 search_code {"query": "mocks.album.create", "limit": 20}  → 1962 chars
```

### Q09 (follow-up)

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "job", "nodeTypes": ["file"], "limit": 40}  → 3267 chars
#4 search_graph {"query": "OnJob"}  → 3862 chars
#5 get_source {"file": "src/decorators.ts", "startLine": 100, "endLine": 200}  → 5260 chars
#6 get_source {"file": "src/services/job.service.ts", "startLine": 1, "endLine": 130}  → 7302 chars
#7 get_source {"file": "src/repositories/job.repository.ts"}  → 16168 chars
#8 search_code {"query": "jobRepository.setup"}  → 377 chars
#9 search_code {"query": "startWorkers"}  → 673 chars
#10 get_source {"file": "src/services/queue.service.ts", "startLine": 55, "endLine": 130}  → 4242 chars
#11 search_code {"query": "setServices"}  → 537 chars
#12 search_code {"query": "MetadataKey.EventConfig"}  → 652 chars
#13 get_source {"file": "src/repositories/event.repository.ts", "startLine": 160, "endLine": 260}  → 4408 chars
#14 get_source {"file": "src/app.module.ts", "startLine": 55, "endLine": 120}  → 3572 chars
#15 search_code {"query": "@OnJob({ name: JobName.AssetGenerateThumbnails"}  → 733 chars
#16 search_code {"query": "queues: Object.values(QueueName)"}  → 433 chars
#17 get_source {"file": "src/services/media.service.ts", "startLine": 60, "endLine": 100}  → 2742 chars
#18 get_source {"file": "src/services/media.service.ts", "startLine": 190, "endLine": 215}  → 2043 chars
#19 search_code {"query": "export const getMethodNames"}  → 387 chars
#20 search_graph {"query": "QueueName", "nodeTypes": ["enum"]}  → 350 chars
#21 search_graph {"query": "JobName", "nodeTypes": ["enum", "type"]}  → 670 chars
#22 search_code {"query": "export type JobOf"}  → 360 chars
```

### Q10 (follow-up)

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "SharedLink", "limit": 50}  → 9565 chars
#4 search_graph {"query": "shared_link", "nodeTypes": ["table", "api", "file"], "limit": 50}  → 6007 chars
#5 get_source {"file": "src/controllers/shared-link.controller.ts"}  → 10261 chars
#6 get_source {"file": "src/repositories/shared-link.repository.ts"}  → 15263 chars
#7 get_source {"file": "src/services/shared-link.service.ts"}  → 13817 chars
#8 get_source {"file": "src/schema/tables/shared-link.table.ts"}  → 2798 chars
#9 get_source {"file": "src/schema/tables/shared-link-asset.table.ts"}  → 958 chars
#10 get_source {"file": "src/repositories/shared-link-asset.repository.ts"}  → 2113 chars
#11 get_source {"file": "src/database.ts", "startLine": 170, "endLine": 196}  → 1400 chars
#12 search_code {"query": "sharedLinkRepository: SharedLinkRepository"}  → 437 chars
#13 search_code {"query": "shared_link_slug_uq", "limit": 10}  → 941 chars
#14 get_node {"nodeId": "c46a5eb6613613120c9335f97bf5d066"}  → 9672 chars
#15 search_code {"query": "sharedLinkRepository.get", "limit": 20}  → 855 chars
```

### Q11 (follow-up)

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "album", "nodeTypes": ["class"], "limit": 30}  → 5495 chars
#4 search_graph {"query": "album", "nodeTypes": ["table"], "limit": 30}  → 2274 chars
#5 search_graph {"query": "album", "nodeTypes": ["api"], "limit": 40}  → 2649 chars
#6 get_source {"file": "src/controllers/album.controller.ts"}  → 11811 chars
#7 get_node {"nodeId": "6232d5e7b6925ee2fd36ddef711f2180"}  → 8048 chars
#8 get_source {"file": "src/services/album.service.ts", "startLine": 1, "endLine": 200}  → 12143 chars
#9 get_node {"nodeId": "4a31b1685051dc944235f999732fd272"}  → 13928 chars
#10 get_source {"file": "src/repositories/album.repository.ts", "startLine": 1, "endLine": 130}  → 7562 chars
#11 get_source {"file": "src/schema/tables/album.table.ts"}  → 2569 chars
#12 get_source {"file": "src/repositories/album.repository.ts", "startLine": 300, "endLine": 400}  → 5641 chars
#13 get_source {"file": "src/services/base.service.ts", "startLine": 120, "endLine": 200}  → 5446 chars
#14 get_source {"file": "src/services/album.service.ts", "startLine": 261, "endLine": 358}  → 5914 chars
#15 get_source {"file": "src/repositories/album-user.repository.ts"}  → 2549 chars
#16 get_source {"file": "src/schema/tables/album-user.table.ts"}  → 3718 chars
#17 get_source {"file": "src/schema/tables/album-asset.table.ts"}  → 2127 chars
#18 get_source {"file": "src/repositories/access.repository.ts", "startLine": 60, "endLine": 145}  → 5066 chars
#19 search_code {"query": "album: AlbumTable"}  → 340 chars
#20 get_source {"file": "src/schema/index.ts", "startLine": 196, "endLine": 220}  → 1311 chars
#21 search_code {"query": "controllers,", "limit": 10}  → 195 chars
#22 search_code {"query": "controllers:", "limit": 10}  → 680 chars
#23 search_code {"query": "AlbumController", "limit": 10}  → 1316 chars
#24 get_source {"file": "src/app.module.ts", "startLine": 85, "endLine": 118}  → 1874 chars
#25 trace_path {"fromNodeId": "cf79913e3d8129b5e73d6cf58449d1ff", "toNodeId": "5895149169315df7c5dbad5e5d9a9392"}  → 1889 chars
#26 search_code {"query": "  protected async requireAccess"}  → 214 chars
#27 search_code {"query": "export const mapAlbum"}  → 415 chars
#28 search_code {"query": "requireAccess(", "limit": 5}  → 1305 chars
#29 search_code {"query": "requireAccess = ", "limit": 5}  → 407 chars
#30 search_code {"query": "requireAccess(this.accessRepository", "limit": 5}  → 422 chars
```

### Q12 (follow-up)

```text
#1 resolve_project {"path": "<immich>/server"}  → 463 chars
#2 get_index_status {}  → 709 chars
#3 search_graph {"query": "/albums", "nodeTypes": ["api"]}  → 2651 chars
#4 search_graph {"query": "AlbumRepository", "nodeTypes": ["class"]}  → 388 chars
#5 search_graph {"query": "create", "nodeTypes": ["method"], "file": "src/repositories/album.repository.ts"}  → 427 chars
#6 get_node {"nodeId": "a4e0a278b2e81f27b6ca24e57becfd5f"}  → 2232 chars
#7 trace_path {"fromNodeId": "210cde94d07a58393be91930d3d65f6d", "toNodeId": "ab1bf2941962012558f50870f6814d5b"}  → 1402 chars
#8 get_node {"nodeId": "ab1bf2941962012558f50870f6814d5b"}  → 3409 chars
#9 get_source {"file": "src/repositories/album.repository.ts", "startLine": 296, "endLine": 362}  → 3817 chars
#10 get_source {"file": "src/services/album.service.ts", "startLine": 101, "endLine": 140}  → 2469 chars
#11 search_code {"query": "AlbumRepository.create", "limit": 20}  → 368 chars
#12 get_node {"nodeId": "5895149169315df7c5dbad5e5d9a9392"}  → 9894 chars
#13 get_source {"file": "src/queries/album.repository.sql", "startLine": 325, "endLine": 375}  → 2317 chars
#14 get_source {"file": "src/schema/tables/album.table.ts"}  → 2569 chars
#15 search_graph {"query": "album", "nodeTypes": ["file"]}  → 4656 chars
#16 get_node {"nodeId": "c5f19208ef8178ee1567da5ad21c8e08", "relationship": "callers"}  → 1006 chars
#17 get_source {"file": "src/services/workflow-execution.service.ts", "startLine": 60, "endLine": 95}  → 2492 chars
```
