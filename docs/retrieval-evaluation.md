# Retrieval evaluation

A repeatable, deterministic measurement of one thing:

> Given a real code question, can the existing retrieval API put the evidence
> needed to answer it in front of a caller?

Not whether an answer *reads* well. There is no model in this loop, no
embedding, no similarity score and nothing that judges. Every comparison is an
identity check against evidence read out of a real indexed fixture, so two runs
over the same graph produce the same report.

`packages/retrieval-eval` holds the dataset and the runner.

## How it relates to the benchmark

Two evaluation packages, measuring different things at different layers:

| | `@ckg/benchmark` | `@ckg/retrieval-eval` |
| --- | --- | --- |
| Question | Did the pipeline build the **right graph**? | Can the **public API** answer a question? |
| Reaches in through | `@ckg/graph`, `@ckg/scip`, `@ckg/analysis` | HTTP, like any other client |
| Needs | Nothing running | A running API with the fixtures indexed |
| Ground truth | Hand-written node and edge expectations | Questions, and the evidence answering them |

The dependency direction is the point. This package imports **no production
internals** — no graph repository, no source service, no scanner. If a question
cannot be answered through the HTTP API, the evaluation says so, which is
exactly the finding worth having.

## The shape

```
Evaluation case
      ↓
Existing retrieval API   (code search · graph search · node · path · source)
      ↓
Actual evidence
      ↓          ← deterministic comparison, by identity
Expected evidence
      ↓
pass · partial · fail
```

## Running it

The API must be running, with the fixture repositories indexed:

```bash
pnpm dev:api
pnpm evaluate:retrieval
```

```bash
# a different API, one case, a machine-readable report
pnpm evaluate:retrieval -- --api http://localhost:3001
pnpm evaluate:retrieval -- --case flow-request-to-store
pnpm evaluate:retrieval -- --json .workspace/retrieval-evaluation.json
```

`--fail-on-error` exits non-zero when a case could not be *run* — no API, no
indexed fixture. A case that ran and failed never fails the command: failures
here are findings, and the dataset deliberately contains questions retrieval
cannot answer yet.

Reports are not committed. The JSON is the whole run rather than a summary,
because the useful diff between two runs is which case changed, not which
percentage did.

## A case

```ts
{
  id: 'flow-request-to-store',
  category: 'cross_file_flow',
  question: 'How does a POST /users request reach the users table?',
  repository: 'express-postgres-sample',
  probe: { trace: { from: 'POST /users', to: 'postgresql.users' } },
  expected: {
    path: {
      from: 'POST /users',
      to: 'postgresql.users',
      nodes: ['POST /users', 'UserController', 'UserService',
              'UserRepository', 'postgresql.users'],
      relationships: ['ROUTES_TO', 'CALLS', 'READS_FROM'],
    },
  },
}
```

**`repository`, never a project id.** Ids differ per database. The runner
resolves the fixture through `GET /api/projects/resolve`, and the report names
which project it scored.

**`probe` is the retrieval, stated explicitly.** Each field is one call against
the public API, and the runner makes exactly the calls a case names — no more.
There is no workflow language, because the smallest thing that works is a record
of which calls were made.

**`expected` is evidence, never prose.** Nodes are named by qualified name; a
path is the exact ordered sequence; a relationship is a type *and* both
endpoints.

### Fields

| `probe` | Calls |
| --- | --- |
| `codeSearch` | `GET /code/search?q=…` — passed through verbatim |
| `graphSearch` | `GET /graph/search?q=…` |
| `node` | `GET /graph/nodes/:id`, for the node with that qualified name |
| `trace` | `POST /graph/path` between two named nodes |
| `source` | `GET /source` — an explicit range, or a window around a line |

| `expected` | Passes when |
| --- | --- |
| `files` | Every path appears among the code-search results |
| `nodes` | Every qualified name appears among the retrieved nodes |
| `relationships` | Type **and** both endpoints came back |
| `path` | The node sequence matches exactly, in order |
| `noPath` | A bounded search reported no route — and was not truncated |
| `sourceMatches` | The file and line were located, and `contains` is in the window |

An **empty** expectation means *and nothing came back*. `files: []` asserts that
a search found nothing — the other reading would let such a case pass while the
search happily returned results.

## Categories

`symbol_lookup` · `code_lookup` · `call_relationship` · `dependency` ·
`database_access` · `implementation` · `cross_file_flow` · `architecture` ·
`source_context` · `trace_path` · `documentation`

## pass · partial · fail

Per case, from its checks:

- **pass** — every check passed.
- **partial** — some evidence was retrieved and some was not. The most useful
  verdict: the capability exists and something specific is missing.
- **fail** — nothing expected was retrieved, or the case could not run.

There is deliberately **no single score**. A percentage tells you the mood;
`READS_FROM → postgresql.users was not retrieved` tells you what to build.

## Adding a case

1. **Read the evidence first.** Query the running API for the node names,
   relationship types, file paths and line numbers. Never write an expectation
   from reading the fixture's source — that measures the fixture, not retrieval.
2. Add the case to `src/cases.ts`, in its category's section.
3. Run it alone: `pnpm evaluate:retrieval -- --case <id>`.
4. If it fails, decide which it is: a retrieval gap worth recording (add a
   `knownGap` note saying what is missing and how you know the data is there),
   or a wrong expectation. Do not adjust a case to make it green.

## Interpreting a failure

The report names the evidence that was not retrieved, and what was:

```
✗ arch-who-reads-the-table  [database_access]
  What reads from the users table?
  relationships: missing
     - UserRepository READS_FROM postgresql.users
     retrieved: postgresql.users CONTAINS postgresql
```

Read it as: the question was asked of the right project, the node was found, and
the relationship the answer depends on was not among what came back.

---

## Findings, first run

49 cases over three fixtures: **45 pass, 0 partial, 4 fail.**

| Category | |
| --- | --- |
| symbol_lookup | 5/5 |
| code_lookup | 5/5 |
| call_relationship | 5/5 |
| dependency | 3/3 |
| database_access | 4/5 |
| implementation | 2/2 |
| cross_file_flow | 4/4 |
| architecture | 7/10 |
| source_context | 3/3 |
| trace_path | 4/4 |
| documentation | 3/3 |

### All four failures are one gap

**An architectural node carries no relationships of its own.** `get_node` on an
`api`, `queue`, `event` or `table` node returns every section empty, although
the edges are in the graph — a depth-1 traversal from the same node returns
them, and the code-side node shows its half of the same edge.

| Question | What is unanswerable |
| --- | --- |
| Which controller serves `POST /users`? | `POST /users ROUTES_TO UserController` |
| What feeds the `welcome-emails` queue? | `UserService PUBLISHES welcome-emails` |
| What publishes `user.created`? | `UserService PUBLISHES user.created` |
| What reads the `users` table? | `UserRepository READS_FROM postgresql.users` |

The asymmetry is precise, and each direction is confirmed by a passing case:

- `db-user-repository-reads` **passes** — from `UserRepository`, the
  `READS_FROM` is right there in `databases`.
- `arch-who-reads-the-table` **fails** — from `postgresql.users`, nothing.

So code → architecture is retrievable; architecture → code is not. An agent can
answer "what does this repository touch" but not "what touches this table",
which is the more common question when the starting point is a schema, a route
or a queue.

Two observations that bound the problem:

- **The data is there.** `GET /graph?rootNodeId=<api>&depth=1` returns the
  `ROUTES_TO` edge. This is a node-detail assembly gap, not a graph gap.
- **It is not universal.** In `repository-knowledge-sample` the same
  `postgresql.users` node *does* carry `CONTAINS` to its columns and `DEFINES`
  from its migrations — so some sections populate on an architectural node and
  the architectural relationships do not.

### What the passes establish

Worth stating, because the failures are only interesting against them: symbol
and text lookup, call relationships in both directions, interface and
inheritance, multi-hop flows including `POST /users → … → postgresql.users`,
bounded source windows, and the documentation layer (`DOCUMENTS`,
`IMPLEMENTED_BY`, `DEFINES`) all retrieve correctly. Code search is confirmed
case-sensitive, and a one-hop path search is confirmed not to reach a three-hop
route.

**Not fixed here.** Recording what retrieval cannot do was the job; deciding what
to do about it is the next one.
