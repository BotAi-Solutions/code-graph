# Performance benchmark

```bash
pnpm benchmark:perf -- --verify-only                                  # check every pin resolves; no indexing
BENCHMARK_DATABASE_URL=… pnpm benchmark:perf -- --migrate             # the dependency-free series, all defaults
BENCHMARK_DATABASE_URL=… pnpm benchmark:perf -- \
  --manifest benchmarks/repositories.dependency-prepared.json         # the dependency-prepared series (ky)
pnpm benchmark:perf -- --repos express --store in-memory \
  --initial-runs 1 --reindex-runs 1 --query-iterations 0              # smoke, no database
```

The accuracy benchmark (`pnpm benchmark`, [benchmark.md](benchmark.md)) asks
whether the graph is right. This one asks what building and querying it costs,
on pinned public repositories, with the production pipeline. It never changes
the repositories it indexes, commits nothing and deploys nothing.

## What runs

`scripts/perf-benchmark.ts` reads a manifest and, for each repository:

1. **Checks out the pinned commit** into the checkouts directory (default
   `~/.cache/ckg-benchmark/checkouts`). A full 40-character SHA is fetched and
   `HEAD` compared with it; a pin that does not resolve is recorded as
   `checkout_failed` and nothing is substituted. A checkout is reused only when
   it is exactly the pin with nothing added. `--verify-only` resolves every pin
   without checking anything out.
2. **Prepares it**, in the dependency-prepared series only (see *Series*).
3. **Counts what is there**: tracked files under the indexed directory, and
   TypeScript and JavaScript files and lines among them.
4. **Indexes it**: `--initial-runs` initial indexes (default 5), then
   `--reindex-runs` re-indexes (default 5). Each run is a new process
   (`scripts/perf-index-once.ts`) running the real `AnalyzeRepositoryJob`
   against the benchmark database. What differs from production: the SCIP
   indexer is started through `MeasuringCommandRunner` (under `/usr/bin/time`,
   in its own process group); the harness, not a worker, creates and claims the
   job, by its own id; the source-read limits are the pipeline defaults; and
   before every run the checkout is restored to exactly its pin, because
   scip-typescript writes a `tsconfig.json` into a project that has none.
5. **Records the database** before and after each run.
6. **Runs the query workload** against the real API, in `--query-rounds`
   rounds (default 2), each with a freshly started API process.

Every run is kept, whatever its outcome: `failed` (the job threw) and
`harness_error` (the run process produced no result) appear in the JSON, the
CSV and every summary's counts. Timings are summarised over completed runs
only, because a run that failed in 100 ms is not a fast run; completed runs
with known incompleteness are summarised with the rest and counted.

## Initial index and re-index

Runs come in two phases, and each run's *kind* is what the database said:

| | initial phase | re-index phase |
| --- | --- | --- |
| Project | new for every sample; the previous sample's is deleted | the last initial-phase project |
| Database before the run | settled: `VACUUM (ANALYZE)` of the graph tables (unless `--no-settle`) | not settled: dead rows accumulate as they do in use |
| Process, analysis workspace, restored checkout | new | new |
| OS page cache, PostgreSQL buffer cache | **not reset** | **not reset** |

- **initial-index**: the project held no graph, so persistence inserted into an
  empty project.
- **re-index**: the project held the previous run's graph, which persistence
  deleted and replaced.

Every initial-phase run is an initial-index. A re-index-phase run is a
re-index only if the project then held a graph; when indexing failed before
it, it is recorded as `kind: initial-index, phase: reindex`, without a new
project or a settled database, and summarised apart from the initial-phase
samples. Summaries are grouped by repository, kind and phase.

Between repositories, the finished repository's project is deleted and the
tables settled, so each repository starts from a database holding no graph.
Settling reclaims dead rows and refreshes planner statistics; it does not
shrink tables or control when autovacuum runs, so relation sizes still differ
between runs and are recorded with each one. Nothing here is a cold-cache
measurement: dropping the page cache (`sudo purge`, `/proc/sys/vm/drop_caches`)
and restarting PostgreSQL need privileges the harness does not take, and every
record says so in `run.cacheState`. Every run is a new process, so no run
benefits from a warm JIT.

## Checkouts must be outside any Node project

TypeScript loads `@types/*` from every parent directory's `node_modules`. A
checkout inside this workspace is therefore indexed against the workspace's own
`@types/node`. Measured on express at its pinned commit:

| Checkout | References into host `@types/node` | References to symbols the index does not define | Nodes | Edges |
| --- | --- | --- | --- | --- |
| Inside the workspace | 2,791 | 4,151 | 798 | 1,415 |
| Outside, no `node_modules` above | 0 | 890 | 797 | 1,490 |

(The first two columns come from the raw SCIP index; nodes and edges from the
graph. Indexing is deterministic, so these are not run-to-run differences: the
same checkout gave the same counts on every run. These, like the numbers under
*Known costs*, were measured locally on one machine; the result files live under
`.benchmarks/`, which git ignores, and are not part of the repository.) It changes the graph, not
only the counts: 75 more edges without the host types. The harness refuses a checkouts
directory with any `node_modules` above it, and a dependency-free checkout
containing one. Results written before this rule (schema 1, checkouts under
`.benchmarks/checkouts`) were affected and are not comparable with later ones.

## Series

A manifest is one series; the harness refuses a manifest that mixes them, and
every report names its series in `configuration.series`.

- **dependency-free** (`benchmarks/repositories.json`): the checkout as it is,
  as production indexes it. Nothing is installed.
- **dependency-prepared** (`benchmarks/repositories.dependency-prepared.json`):
  a copy of the checkout with **one** package tarball extracted into
  `node_modules/<package>`. The tarball is pinned by exact version and sha512
  integrity, verified before extraction, and extracted with `tar`: nothing is
  installed and no package script runs (`scripts: "never"` is required by the
  manifest schema). The network is used once, to fetch the tarball, which is
  then cached beside the checkouts. The report records the profile, the
  verified integrity, and a sha256 over every prepared file.

## Resources

The worker and the indexer are measured separately and never added together:
their peaks need not have happened at the same moment.

| Process | How | What |
| --- | --- | --- |
| Worker (the run process) | `process.cpuUsage()` over the run; RSS sampled at phase boundaries; `process.resourceUsage().maxRSS` | CPU user/system; `workerLifetimeMaxRssBytes` is the run's true peak, because each run has its own process |
| SCIP indexer | `/usr/bin/time -l -o <file>` (BSD, macOS) or `-v` (GNU, Linux), which reads `wait4()` usage when the indexer exits | wall time, exit status, timeout, CPU user/system, peak RSS of the indexer process |

The indexer runs in its own process group, so a timeout kills it and not only
the `time` wrapper. A killed or unmeasurable run records `null` with a
`measurementError`, never zeros.

## Database state and size

Before each run and around each query workload the report records, per graph
table, `n_live_tup`, `n_dead_tup`, total size and the last (auto)vacuum and
(auto)analyze times; after each run, the database size, table sizes and the
project's own row bytes (`pg_column_size` of its rows, without indexes). Read
`projectRowBytes` for the size of one graph: table sizes include every project
and every dead row.

Use a database that holds nothing else. The harness creates projects named
`perf:<repo>@<sha>`, deletes earlier ones at the start unless
`--keep-previous` (then vacuums), and refuses the application database unless
`--allow-shared-database`. It records the database name, server version and
every applied migration with its checksum, and refuses drifted migrations.

## Queries

Targets are the five most connected classes, functions and methods of the
stored graph, ties broken by type, name and file. Each question has a `key`
built from that identity — never from node ids, which are hashes of a project
created afresh on each invocation — so two invocations over the same
repository revision ask the same questions and can be paired by key. Per
repository:

- **search**: each target's name, a three-letter prefix of the first, and a term
  that matches nothing;
- **node detail** for each target;
- **traversal** from each target at depths 1 to 5 (limit 500, both directions);
- **path** between consecutive targets (`maxDepth` 6).

Before the workload the graph tables are settled. Each round starts a fresh API
process, runs `--query-warmup` passes over the plan (recorded, never
summarised), then `--query-iterations` measured passes, one request at a time.
Every record has a timestamp. Client latency is measured around `fetch`, from
request to body read, over loopback HTTP; server latency comes from the API's
`Server-Timing: app;dur=…` header. Result counts and the API's `truncated` flag
are recorded with each answer.

The summary reports each round separately and, per question, the ratio of the
last round's median server time to the first's (`roundToRoundRatio`): identical
work on one database state, with a fresh API process. It measures
**within-invocation repeatability** and is a lower bound on the noise: it does
not capture differences between invocations (database built afresh, other
processes on the machine, thermal state) or between machines. A difference
between two reports smaller than the spread of these ratios is certainly not a
measured difference; a larger one still needs repeated invocations to be
established.

Indexing and query results are separate records, separate CSV files and
separate summaries.

## Output

`--out` (default `.benchmarks/results/<timestamp>/`, ignored by git):
`report.json`, `runs.csv` (one row per indexing run) and `queries.csv` (one
row per query execution, warm-up included and flagged).

`report.json` is `schema: 2`. Changed from 1:

- run kinds `initial-index` and `re-index` (were `cold` and `warm`), plus a
  `phase`; records carry timestamps, the database state they started from,
  whether it was settled and whether the checkout was pristine;
- query records carry a stable `key` (summaries and CSV group by it, no longer
  by parameters that included node ids), a `round` and a `warmup` flag, and no
  longer have an iteration-0 "first" sample: warm-up passes replace it;
- the query summary is per round, pooled, and with `roundToRoundRatio`; the
  indexing summary is per repository, kind and phase, and adds graph size;
- CSV columns were added (`run_phase`, `run_sample`, `started_at`,
  `checkout_preexisting`, `checkout_pristine`, `database_settled`, database
  state before the run; for queries `key`, `round`, `warmup`, `at`) and
  `os_page_cache_reset` (always `false`) was removed, so column positions
  changed;
- the report records the series, the database, its migrations, any
  preparation, `fatalError`, and a fingerprint of the benchmarked tree's
  uncommitted changes (`environment.toolCommit`).

Schema 1 reports always recorded the PostgreSQL version as null; schema 2
records it.

Summaries give count, minimum, median and maximum. **p95 is withheld below 20
observations**: the 95th percentile of five numbers is their maximum.

## The repositories

| id | pin | tier | series | notes |
| --- | --- | --- | --- | --- |
| `ky` | v2.2.0 | S | dependency-free: **fails** | its tsconfig extends `@sindresorhus/tsconfig`, absent without an install, so scip-typescript indexes nothing |
| `ky` | v2.2.0 | S | dependency-prepared | profile `tsconfig-only`: that one package, so the run indexes |
| `express` | v5.3.0 | S | dependency-free | CommonJS JavaScript without a tsconfig |
| `zod` | v4.6.6 | M | dependency-free | generic-heavy TypeScript monorepo, indexed from its root |
| `realworld-express` | master, 2024-01-04 | S | dependency-free | Express and Prisma service |
| `immich-server` | `a4af862` | L | dependency-free | NestJS and Kysely; `server/` only, sparse checkout |

## Known costs

Traversal walks one hop per query and stops at the first hop that passes the
node limit. It was compared with a single recursive statement returning the
same result and metadata, on 100 queries with alternating paired samples
(`.benchmarks/finalization/fastpath/`):

- **Truncated, deeper traversals:** the walk was 6–20× faster at depths 4–5 on
  the two larger graphs (zod, immich), and about 3–4× faster at depth 3.
- **Where nothing is truncated:** the walk was slower, at every depth on
  realworld-express and at depths 1–3 on express. On express it was also slower
  at depth 4, where most traversals reach the limit, and faster only at depth 5.
  At depths 1–2 the extra cost was about 0.4–0.9 ms.
- **Truncated at depth 2:** the walk was the faster of the two.

Using the single statement as a fast path for depth ≤ 1 or ≤ 2 was judged
against a rule written before measuring. At depth ≤ 1 it saved a median
0.44 ms, below the 1 ms the rule required to justify a second implementation.
At depth 2 it was slower on truncated traversals. Neither was adopted.
