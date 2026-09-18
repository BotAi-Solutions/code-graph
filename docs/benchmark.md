# Benchmark

```bash
pnpm benchmark                       # print the report
pnpm benchmark -- --json out.json    # also write the machine-readable one
pnpm benchmark -- --fail-on-regression
```

A knowledge graph is only worth what it is right about. The benchmark is how
that stops being an opinion: a fixture repository, a hand-written ground truth,
and a score computed from the two.

## What it runs

`packages/benchmark` assembles the fixture's graph from the **checked-in SCIP
index** and the **real analyzers** — no database, no subprocess, no network. The
indexer is the one genuinely external step in the pipeline and is already pinned
as a binary fixture, so everything the benchmark scores is code that ships.

The identity scope is fixed rather than random, which matters twice: node ids
are content hashes of it, so a run is byte-reproducible, and a reproducible run
is what lets two results be compared at all.

## What it measures

| Measure | Question |
| --- | --- |
| Node precision / recall / F1 | Did the pipeline find the entities? |
| Edge precision / recall / F1, per relationship | Did it find the relationships? |
| Confidence agreement | Did the policy assign the level the dataset expects? |
| Evidence attribution | Can every edge name an analyzer and a confidence? |
| Evidence location | Does every edge read out of a file carry a file and a line? |
| Path correctness | Can the graph actually be traversed the way a reader would? |

The last two are the ones a precision/recall score would miss. A graph can score
perfectly on nodes and edges and still be useless if its edges point the wrong
way, so the path check walks it with the **same breadth-first search the
database uses** and asks whether the trace exists.

## Closed and open categories

Recall is easy: of the things the ground truth says should be there, how many
are? Precision is the hard one, because its denominator is *everything the
extractor produced*, and that is only comparable to ground truth if the ground
truth enumerates every correct answer.

For some categories it does. Every `api_endpoint`, `container`, `table`,
`column`, `document_section` and `config_property` in the fixture is written
down, so anything else the pipeline produces in those categories is a false
positive and precision is a real measurement. Those categories are **closed**.

For others it does not, and could not usefully. Nobody is going to enumerate
every `REFERENCES` edge a compiler emits, and a ground truth that tried would be
wrong within a week. Those categories are **open**, and for them the benchmark
reports recall and **prints `n/a` for precision** rather than computing a number
whose denominator is a list of examples.

> A benchmark that prints 34% precision because its ground truth is a sample is
> worse than one that prints "open set": the first number will be quoted.

The aggregate follows the same rule — only closed categories contribute to
aggregate precision, while recall spans every expectation.

Which categories are closed is declared in the dataset itself, in
`closedTypes` and `closedRelationships`.

## The ground truth

`packages/benchmark/ground-truth/<fixture>/` holds three files:

```
nodes.json   what should be in the graph, and which types are enumerated fully
edges.json   which relationships, with the confidence and evidence expected
paths.json   which traces a reader should be able to follow
```

Everything is addressed by **type and qualified name**, never by node id. Ids
are content hashes of a project scope: a dataset written in ids would be
unreadable, unreviewable, and invalid the moment the fixture was analysed under
a different project.

Every term is validated against the shared vocabulary on load, and a duplicate
entry is an error — a typo in a node type would otherwise show up as a recall
failure and be blamed on the pipeline.

### Path expectations constrain the search

`viaRelationships` is passed *into* the search rather than checked against its
answer. "Is there a route from the contract to the table made only of
implementation, call and write edges" is a claim about the repository; "the
shortest route happened to use these" is a claim about the search. A graph
usually holds several correct routes between two nodes at different altitudes,
and the breadth-first search is entitled to return whichever is shortest.

This is also exactly what the graph API does when a projection is applied, so a
benchmark pass is a statement about the product feature.

### Writing an expectation

Read the fixture. Write what you believe should be there. Run the benchmark.
When the two disagree, exactly one of them is wrong and the point of the
exercise is to find out which — the ground truth is edited about as often as the
pipeline is.

Closing a category is a commitment: an improvement to extraction will show up as
a false positive until the dataset is updated. That is intended. It is what
makes the dataset a review checkpoint rather than a rubber stamp.

## The fixture

`test-repositories/repository-knowledge-sample` is built to exercise the joins,
not to look impressive:

```
README.md              names AuthService in prose; links to the notes and to compose
docs/architecture.md   names the three layers; links back
package.json           scripts, engines, two dependencies
tsconfig.json          the compiler options that matter
config/app.config.json a plain settings file, two levels deep, with a secret in it
.env.example           three variables, one of them a secret
Dockerfile             two stages, one exposed port
docker-compose.yml     api and postgres, with depends_on and a postgres image
openapi.yaml           POST /users, GET /users/{id}, and POST /sessions
database/migrations/   two tables, eleven columns, one foreign key, two indexes
src/                   controller → service → repository → SQL, plus AuthService
```

The deliberate omissions are as important as the contents:
`POST /sessions` is declared and **not** implemented, so the graph has to be
able to say so; the specification writes `{id}` where the router writes `:id`,
so the match has to erase parameter names; `session.secret` is a value that must
not be recorded.

## In CI

The default is to report rather than to fail. A benchmark that fails CI on its
first bad day gets disabled on its second, so the numbers go to stdout, the JSON
goes to an artefact, and a human decides whether a drop in documentation recall
is a regression or a better fixture.

`--fail-on-regression` turns that off and exits non-zero on any unmet
expectation. There is no threshold flag on purpose: a threshold is a number
somebody picks to make a build green, and the expectations in the ground truth
are the thresholds.

The machine-readable report is versioned (`schema: 1`) and carries every score,
every ratio and every named failure, so a job can diff two runs and say what
changed.

```json
{
  "schema": 1,
  "generatedAt": "…",
  "fixtures": [
    {
      "fixture": "repository-knowledge-sample",
      "passed": true,
      "graph": { "nodes": 126, "edges": 291 },
      "nodes": { "precision": 1, "recall": 1, "f1": 1, "closed": true, "…": "…" },
      "edgeCategories": { "IMPLEMENTED_BY": { "…": "…" } },
      "evidence": { "validRatio": 1, "locatedRatio": 1, "…": "…" },
      "paths": { "total": 7, "correct": 7, "ratio": 1, "failures": [] },
      "failures": { "missingNodes": [], "unexpectedEdges": [], "…": [] }
    }
  ],
  "totals": { "fixtures": 1, "passed": 1 }
}
```

## Adding a fixture

1. Put the repository under `test-repositories/`.
2. Add it to `SAMPLES` in `scripts/build-fixtures.ts` and run
   `pnpm fixtures:build` to produce its SCIP index.
3. Write `packages/benchmark/ground-truth/<name>/{nodes,edges,paths}.json`.
4. Add it to `BENCHMARK_FIXTURES` in `packages/benchmark/src/graph-source.ts`.

The tests in `packages/benchmark/tests` check the evaluator against small
synthetic graphs where the answer is obvious — a missing node, an extra one, a
wrong confidence, a reversed path — and then run the real thing.
