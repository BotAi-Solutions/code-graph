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
| Build diagnostics | Did the build drop edges, lose an analyzer, fail a read or hit a size cap? |
| Agreement with SCIP | Does the graph still say what the raw index said? (see below) |

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

### Counting

Every produced item in a closed category is counted exactly once: as a true
positive while the ground truth still expects one at its address, otherwise as
a false positive. So `truePositives + falsePositives = produced`, and two nodes
that share a name are not silently collapsed into one. Where two distinct
declarations legitimately share an address (a static and an instance method),
the expectation says so with `"count": 2`.

Precision is `TP / (TP + FP)`, recall `TP / (TP + FN)`, F1 their harmonic mean,
and the aggregate is micro-averaged.

### Known gaps

A defect that has been confirmed, and traced to its cause, is recorded rather
than either fixed in the dataset or left to fail every run:

- `"knownGap": "<reason>"` on an expected node or edge: the pipeline is known not
  to produce it.
- `"knownFalsePositives": [...]` in `nodes.json` or `edges.json`: things a closed
  category produces that are known to be wrong.

Both are **scored**: a known gap lowers recall, a known false positive lowers
precision. Neither fails the run. Once the pipeline stops exhibiting one, the
run fails until the marker is removed, so a fix can never land unnoticed and
the numbers can never improve silently. Known gaps are listed in their own
section of both reports.

A known gap is not a place to put an expectation the pipeline happens not to
meet. Each one in the bundled datasets names the cause, checked against the
raw SCIP index.

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

## Code relationships

`call-semantics-sample` is the golden fixture for code relationships. It is
small enough that every `CALLS`, `REFERENCES`, `IMPORTS`, `EXTENDS` and
`IMPLEMENTS` relationship in it is written down, so all five are closed and
precision is a real measurement for each. `typescript-sample` closes `CALLS`,
`IMPORTS`, `EXTENDS` and `IMPLEMENTS` on a layered application; its
`REFERENCES` (about a hundred type and property uses) stays open.

The rules both datasets follow:

- **Source.** A code edge starts at the innermost function, method, class or
  interface the occurrence sits in. Module-level code, including the
  initialiser of a module-level variable, belongs to the file; a field
  initialiser belongs to its class.
- **CALLS** is an invocation: `f()`, `ns.f()`, `obj.m()`, and `new C()` when `C`
  declares a constructor. Class-level summaries (one per pair of classes where
  a member of the first calls a member of the second) are part of the
  documented model, at medium confidence.
- **REFERENCES** is any other use of a declared name, heritage clauses included.
- **Import and export specifiers** are neither: `import { f }` only makes the
  file depend on another file.
- **IMPORTS** joins two files when one imports or re-exports from the other, or
  refers to something declared in it. That second half is the documented
  contract, so IMPORTS is "depends on", not "has an import statement for".
- **EXTENDS** targets a class. **IMPLEMENTS** targets an interface or a member,
  and is transitive: a class implements every interface it satisfies through
  its base classes, as SCIP reports it. An interface extending an interface is
  IMPLEMENTS in this model.
- External symbols (the standard library, dependencies) are not nodes and have
  no edges.

## Against the raw SCIP index

`scip-baseline.ts` compares every fixture's graph with the index it was built
from, joined by the SCIP symbol each symbol node keeps in
`metadata.scipSymbol`. It needs no ground truth, so it runs on every fixture,
and the tests run it on all six checked-in indexes.

| Check | Meaning of a disagreement |
| --- | --- |
| Definitions | A symbol defined in the index has no node, and no documented reason (parameter, type parameter, ambient module) explains it |
| Identity | One symbol became several nodes |
| Locations | A node's start or end line differs from its definition's range |
| Uses | A `(scope, target)` pair SCIP supports is missing from `CALLS` ∪ `REFERENCES`, or the graph holds one SCIP does not support |
| Inheritance | Same, for SCIP implementation relationships against `EXTENDS` ∪ `IMPLEMENTS` |
| Unresolved | The graph's `unresolvedReferenceCount` is not external references plus references to unmodelled symbols |

Scope attribution is computed independently of the builder, so agreement is
evidence that normalisation kept what the index said. It is a consistency
measurement, not a correctness one: where the index itself is wrong, the graph
agrees with it, and only the ground truth notices.

What cannot be compared directly, and is scored only by the ground truth:

- **CALLS vs REFERENCES.** SCIP has no call role; uses are compared as pairs.
- **IMPORTS.** SCIP has an import role, but scip-typescript never sets it.
- **EXTENDS vs IMPLEMENTS.** SCIP reports both with one flag.
- **Derived class-level edges and analyzer edges.** Not SCIP facts.
- **Individual reference sites.** The graph collapses repeated uses into one
  edge with an occurrence count.

## The fixtures

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

The machine-readable report is versioned (`schema: 2`) and carries every score,
every ratio and every named failure, so a job can diff two runs and say what
changed.

```json
{
  "schema": 2,
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
      "failures": { "missingNodes": [], "unexpectedEdges": [], "staleKnownGaps": [], "…": [] },
      "knownGaps": { "missingEdges": [], "unexpectedEdges": [], "…": [] },
      "diagnostics": { "unresolvedReferences": 200, "droppedEdges": 0, "truncated": false, "…": 0 },
      "scipBaseline": { "uses": { "scip": 50, "graph": 50, "both": 50, "…": "…" }, "consistent": true, "…": "…" }
    }
  ],
  "totals": { "fixtures": 1, "passed": 1 }
}
```

Schema 2 adds `knownGaps`, `staleKnownGaps`, `diagnostics` and `scipBaseline`,
and counts duplicates in a closed category as false positives instead of
collapsing them by name. Every field of schema 1 is still present.

## Adding a fixture

1. Put the repository under `test-repositories/`.
2. Add it to `SAMPLES` in `scripts/build-fixtures.ts` and run
   `pnpm fixtures:build` to produce its SCIP index.
3. Write `packages/benchmark/ground-truth/<name>/{nodes,edges,paths}.json`.
4. Add it to `BENCHMARK_FIXTURES` in `packages/benchmark/src/graph-source.ts`.

The tests in `packages/benchmark/tests` check the evaluator against small
synthetic graphs where the answer is obvious — a missing node, an extra one, a
wrong confidence, a reversed path — and then run the real thing.
