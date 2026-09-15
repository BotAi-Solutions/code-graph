# Graph model

The code knowledge graph is a directed, typed multigraph. It is defined in
`packages/shared/src/types/graph.ts` (the vocabulary) and built in
`packages/graph` (the behaviour).

## Nodes

```ts
interface CodeNode {
  id: string;             // stable content hash — see Identity
  projectId: string;
  type: CodeNodeType;
  name: string;
  filePath?: string;      // repository-relative, POSIX separators
  startLine?: number;     // 1-based, inclusive
  endLine?: number;       // 1-based, inclusive
  metadata?: Record<string, unknown>;
}
```

| `type` | Represents |
| --- | --- |
| `repository` | The analysed repository. Exactly one per project; the traversal root. |
| `directory` | A directory in the source tree. |
| `file` | A source file. Also stands in for the file's own SCIP scope. |
| `module` | A namespace or module scope that is not a file. |
| `class` | A class, struct or equivalent. |
| `interface` | An interface, protocol or trait. |
| `function` | A free function — one not owned by a type. |
| `method` | A member function, constructor or accessor. |
| `variable` | A module-level variable, constant, property, field or enum member. |
| `type` | A type alias, enum or other named type. |

Line numbers are **1-based**, converted at the builder boundary from SCIP's
0-based positions, because 1-based is what an editor and a reviewer mean by
"line 42". Where the indexer supplies an enclosing range, `startLine`/`endLine`
span the whole declaration; otherwise they span the name.

### Metadata

Symbol nodes carry:

- `scipSymbol` — the originating SCIP symbol string, the audit trail back to
  the index
- `scipKind` — the normalised kind before it was mapped to a `CodeNodeType`
- `language` — resolved per document
- `signature`, `documentation` — when the indexer provides them

### What is not a node

Parameters, type parameters, macros and unresolvable symbols are excluded: they
multiply node counts without adding anywhere to navigate to. Local symbols
(`local 3`) are file-scoped and not addressable, so they are skipped too.

Symbols defined **outside** the analysed repository are not nodes either.
A reference to `Error` from `lib.es5.d.ts` resolves to nothing and is counted in
`stats.unresolvedReferenceCount` rather than inventing a node for a dependency
that was never indexed.

## Edges

```ts
interface CodeEdge {
  id: string;
  projectId: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationship: CodeRelationship;
  metadata?: Record<string, unknown>;
}
```

| `relationship` | Meaning | How it is derived |
| --- | --- | --- |
| `CONTAINS` | Lexical containment | Repository → directory → file → symbol → member, from the SCIP descriptor chain |
| `IMPORTS` | File-level dependency | A file references a symbol defined in another file |
| `CALLS` | Invocation | A reference whose target is a function or method, attributed to the definition it sits inside |
| `REFERENCES` | Non-call usage | Same, where the target is a class, interface, type or variable |
| `IMPLEMENTS` | Satisfies an abstraction | A SCIP implementation relationship whose target is an interface or a member |
| `EXTENDS` | Inherits from a class | A SCIP implementation relationship whose target is a class |

Every edge carries `metadata.occurrences`: how many source-level occurrences
collapsed into it. Two distinct calls from the same method to the same callee
are one edge with `occurrences: 2`, not two edges.

### Call attribution

SCIP reports *occurrences*: a symbol, a range, and whether it is a definition.
It does not say "A calls B". The builder derives that:

1. Collect every definition in a document that has an `enclosing_range` — the
   span of the whole declaration, not just its name.
2. Sort those scopes innermost-first.
3. For each non-definition occurrence, find the innermost scope containing its
   position. That definition is the source of the edge.
4. Occurrences at top level fall back to the file node, so nothing is dropped.

This is why `enclosing_range` matters: without it, every call would be
attributed to its file and the graph would be a file-dependency graph wearing a
call graph's clothes. scip-typescript emits it for every class, method and
function.

`IMPORTS` exists because SCIP does not mark import occurrences —
`SymbolRole.Import` is unset in practice. A cross-file reference is the reliable
signal that one file depends on another. A reference whose target is a *file*
node is a module specifier (`from './user.service.js'`); it produces the
`IMPORTS` edge only, since a second `REFERENCES` edge would say the same thing.

### Derived container edges

A call between two methods is also a fact about the classes that own them. For
every `CALLS`/`REFERENCES` edge, the builder also emits the same relationship
between the endpoints' nearest owning class or interface, when those differ,
tagged `metadata.derived = true`.

This is what makes the graph readable at an architectural altitude:

```
UserController#getUser() ──CALLS──▶ UserService#getUser()      (literal)
UserController           ──CALLS──▶ UserService                (derived)
```

The derivation is deterministic, based purely on graph containment, and can be
switched off with `deriveContainerEdges: false`. Files are not containers for
this purpose — a file-level aggregate is already `IMPORTS`.

## Identity

Node and edge ids are **content hashes**, never random UUIDs:

```
nodeId = sha256(projectId:repositoryId ⌷ nodeType ⌷ filePath ⌷ symbolKey)[0..32]
edgeId = sha256(projectId:repositoryId ⌷ "edge" ⌷ sourceId ⌷ relationship ⌷ targetId)[0..32]
```

(`⌷` is a NUL separator, which cannot occur in a path or a SCIP symbol.)

`symbolKey` is the SCIP symbol string for a code symbol and the path itself for
files and directories. SCIP symbol strings are the one identifier the format
guarantees to be stable across runs, which makes them the right backbone.

Analysing the same commit twice therefore yields identical ids. That buys:

- **Idempotent persistence.** Re-analysis is `DELETE` + `INSERT` in one
  transaction; readers see the old graph or the new one, never a mixture.
- **A UI that keeps its place.** A selected node survives a re-analysis.
- **A basis for diffing and caching.** Later phases — incremental indexing,
  embeddings, cached summaries — can refer to a piece of code and still mean the
  same piece of code afterwards.

Ids are scoped by project *and* repository, so a project holding several
repositories cannot collide.

## Determinism

`ScipGraphBuilder` is deterministic by construction:

- every identity is a content hash
- accumulation uses `Map`s keyed by those identities
- both output arrays are sorted by id before returning
- `serializeGraph()` emits fixed key order, so two runs are byte-identical and a
  checksum answers "did this commit change the graph?"

Tested in `packages/graph/tests/scip-graph-builder.test.ts`.

## Traversal semantics

Identical in the recursive CTE (`packages/database`) and in memory
(`packages/graph/src/traversal`), so the two can be checked against each other:

- **Undirected.** A depth-1 walk from a service finds both its callers and its
  callees. Direction is preserved on each returned edge.
- **Relationship filter** applied during expansion.
- **Node-type filter** applied to expansion candidates — a filtered traversal
  never reaches *through* an excluded node. The root is always included.
- **Limit** on node count; the response reports `truncated`.
- **Edges** are the induced subgraph: an edge is returned only when both
  endpoints are.

## Worked example

The bundled sample repository produces 76 nodes and 243 edges. The overview —
top-degree code nodes and the behavioural edges between them — is its
architecture:

```
UserController ──CALLS──────▶ UserService ──CALLS──────▶ UserRepository
      │                            │                          │
   EXTENDS                    REFERENCES                  REFERENCES
      ▼                            ▼                          ▼
BaseController                    User                       User
```

with `UserRepository ──IMPLEMENTS──▶ UserStore` and file-level `IMPORTS` beneath.
