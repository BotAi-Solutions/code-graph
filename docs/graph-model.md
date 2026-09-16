# Graph model

The code knowledge graph is a directed, typed multigraph. Its vocabulary is
defined in `packages/shared/src/types/graph.ts`, its behaviour — identity,
construction, merging, traversal — in `packages/graph`, and the analyzers that
populate its architectural half in `packages/analysis`.

## Nodes

```ts
interface CodeNode {
  id: string;              // stable content hash — see Identity
  projectId: string;
  type: CodeNodeType;
  name: string;
  qualifiedName?: string;  // dotted name within the file; absent when == name
  filePath?: string;       // repository-relative, POSIX separators
  startLine?: number;      // 1-based, inclusive
  startCharacter?: number; // 0-based, as editors expect
  endLine?: number;
  endCharacter?: number;
  metadata?: Record<string, unknown>;
}
```

### Core code nodes

What a compiler knows about. SCIP-derived.

| `type` | Represents |
| --- | --- |
| `repository` | The analysed repository. Exactly one per project; the traversal root. |
| `directory` | A directory in the source tree. |
| `file` | A source file. Also stands in for the file's own SCIP scope. |
| `module` | A namespace or module scope that is not a file — including an external package, marked `metadata.external`. |
| `class` | A class, struct or equivalent. |
| `interface` | An interface, protocol or trait. |
| `function` | A free function — one not owned by a type. |
| `method` | A member function, constructor or accessor. |
| `variable` | A module-level variable or constant. |
| `property` | A class field, property or enum member. |
| `type` | A type alias or other named type. |
| `enum` | An enum. |
| `parameter` | Declared in the model; not populated by the SCIP layer (see below). |

### Architectural nodes

How the system is put together. No compiler emits these; they come from the
analyzers, each from evidence named in `metadata`.

| `type` | Represents | Typical evidence |
| --- | --- | --- |
| `api` | An HTTP route. `metadata`: `httpMethod`, `path`, `framework`, `handler`, `mountedAt`. | A NestJS route decorator, or a router method call on a router built by express/fastify |
| `service` | The deployable unit this repository is. One per manifest. | `package.json` `name` |
| `database` | A datastore, named by its provider. | A Prisma datasource, a declared driver, a connection scheme in an example env file |
| `table` | A table or collection. No `filePath`: the same table touched from three files is one node. | A SQL statement, a Prisma model, an ORM entity decorator |
| `queue` | A work queue, by its name. | `new Queue('welcome-emails')` from a queue library |
| `event` | A domain event, by its name. | `emitter.emit('user.created')`, `@OnEvent(...)` |
| `external_service` | A third party this code talks to. `metadata`: `vendor`, `category`, `package` or `host`. | A vendor SDK import, or an absolute `https://` URL |
| `config` | A configuration file the compiler does not index. | `package.json`, `tsconfig.json`, `.env*`, a root `*.config.*` |

A configuration file the compiler *does* index — `vite.config.ts` — stays a
`file` node and is annotated with `metadata.configKind` instead, because one
file should not be two nodes.

### Node families

Twenty-one types cannot have twenty-one distinguishable colours, so they are
grouped into six families in two categories, and the UI encodes
**hue = family, silhouette = member, size and glow = importance, label =
identity**. See `packages/shared/src/constants/node-families.ts` for the
grouping, `apps/web/src/features/code-graph/utils/graph-colors.ts` for the
colour reasoning and `.../model/node-types.ts` for the per-type table the
renderer reads.

### Metadata

Symbol nodes carry `scipSymbol` (the audit trail back to the index), `scipKind`,
`language`, and `signature`/`documentation` where the indexer provides them.
Class nodes may also carry `role` and `roleEvidence` — see Roles below.

### What is not a node

Parameters, type parameters, macros and unresolvable symbols are excluded by the
SCIP layer: they multiply node counts without adding anywhere to navigate to,
and scip-typescript emits one symbol per parameter of every signature in the
repository. Local symbols (`local 3`) are file-scoped and not addressable.

Symbols defined **outside** the analysed repository are not nodes either. A
reference to `Error` from `lib.es5.d.ts` resolves to nothing and is counted in
`stats.unresolvedReferenceCount` rather than inventing a node for a dependency
that was never indexed.

Neither is a symbol a declaration file declares on another package's behalf:

```ts
declare module 'pg' { export class Pool { … } }
```

`Pool` is syntactically defined here and semantically a description of `pg`.
Emitting it would make the repository look like it declares a database driver;
the dependency on `pg` is already a `module` node, so nothing is lost.

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

### Core relationships

| `relationship` | Meaning | How it is derived |
| --- | --- | --- |
| `CONTAINS` | Lexical containment | Repository → directory → file → symbol → member, from the SCIP descriptor chain |
| `IMPORTS` | File-level dependency | An import statement, or a cross-file reference |
| `EXPORTS` | What a file offers | An `export` declaration, including re-exports |
| `CALLS` | Invocation | A reference whose target is a function or method, attributed to the definition it sits inside |
| `REFERENCES` | Non-call usage | Same, where the target is a class, interface, type or variable |
| `IMPLEMENTS` | Satisfies an abstraction | A SCIP implementation relationship whose target is an interface or a member |
| `EXTENDS` | Inherits from a class | A SCIP implementation relationship whose target is a class |
| `INSTANTIATES` | Constructs | `new Foo()`, with `Foo` resolved through the file's imports |
| `ACCEPTS` | Takes as a parameter | A named parameter type in a signature |
| `RETURNS` | Gives back | A return type annotation, unwrapping `Promise<T>` and friends |
| `DEPENDS_ON` | Needs a module | A declared dependency, or an import of an external package |

### Architectural relationships

| `relationship` | Meaning | How it is derived |
| --- | --- | --- |
| `ROUTES_TO` | An API dispatches to a handler | The handler argument of a route, resolved through bindings; also lifted to the handler's class |
| `USES` | Uses without calling | An SDK import; an ORM entity's table mapping |
| `READS_FROM` | Reads data | `SELECT`/`JOIN` in a literal statement, or a Prisma read method |
| `WRITES_TO` | Writes data | `INSERT`/`UPDATE`/`DELETE`/`CREATE TABLE`/`TRUNCATE`, or a Prisma write method |
| `PUBLISHES` | Emits | A queue producer, or `emit` on a declared emitter |
| `SUBSCRIBES` | Handles | A queue worker, `on` on a declared emitter, or an event-handler decorator |
| `CONFIGURED_BY` | Is configured by | A configuration file in the repository |
| `AUTHENTICATED_BY` | Is gated by | `@UseGuards(...)` on a route or its controller |
| `VALIDATES` | Validates its input | A decorated DTO reached through `@Body()`, or a schema whose `parse` the handler calls |
| `DEPENDS_ON_SERVICE` | Needs a third party | Any external service the service's code reaches |

Relationships are grouped for display — structure, dependency, behaviour, type,
data — in `packages/shared/src/constants/relationships.ts`, for the same reason
node types are: five edge colours can be told apart, twenty-one cannot.

### Evidence

**Every edge records what observed it.** This is the property that makes a
multi-source graph trustworthy, and it is enforced by the accumulator: there is
no way to add an edge without evidence.

```json
{ "source": "database-analyzer", "confidence": "high", "statement": "INSERT", "occurrences": 1 }
```

| `confidence` | Meaning |
| --- | --- |
| `high` | A compiler fact, or an unambiguous syntactic one: a decorator argument, an import specifier, a resolved call target, a literal SQL statement |
| `medium` | A real observation that needed a resolution step which could in principle be wrong: an aggregate lifted to a container, a statement assembled from a template literal, a package imported but not declared |
| `low` | Reserved. Nothing emits it: a relationship that would only be `low` is not emitted at all |

`source` is one of `scip`, `graph-builder` or the analyzer that found it. Every
edge also carries `metadata.occurrences`: how many source-level occurrences
collapsed into it. Two calls from the same method to the same callee are one
edge with `occurrences: 2`.

When two sources observe the same relationship the stronger evidence wins, so a
SCIP-derived `CALLS` is never downgraded because an analyzer saw it too.

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
call graph's clothes. The analyzers attribute their findings the same way — a
SQL statement belongs to the method it sits inside — using the ranges the
builder already recorded.

### Derived container edges

A call between two methods is also a fact about the classes that own them. For
every `CALLS`/`REFERENCES` edge, the builder also emits the same relationship
between the endpoints' nearest owning class or interface, when those differ,
tagged `metadata.derived = true` at `medium` confidence. The analyzers do the
same for their findings, which is what makes the architecture projection
readable:

```
UserRepository#create() ──WRITES_TO──▶ users    (literal)
UserRepository         ──WRITES_TO──▶ users    (derived)
```

## Identity

Node and edge ids are **content hashes**, never random UUIDs:

```
nodeId = sha256(projectId:repositoryId ⌷ nodeType ⌷ filePath ⌷ symbolKey)[0..32]
edgeId = sha256(projectId:repositoryId ⌷ "edge" ⌷ sourceId ⌷ relationship ⌷ targetId)[0..32]
```

(`⌷` is a NUL separator, which cannot occur in a path or a SCIP symbol.)

`symbolKey` is the SCIP symbol string for a code symbol, the path itself for
files and directories, and a stable natural key for an architectural node:

| Node | `symbolKey` | `filePath` |
| --- | --- | --- |
| `api` | `api:POST /users` | the file declaring the route |
| `service` | `service:users-service` | `package.json` |
| `database` | `database:postgresql` | — |
| `table` | `table:postgresql.users` | — |
| `queue` / `event` | `queue:welcome-emails` / `event:user.created` | — |
| `external_service` | `external-service:stripe` | — |
| `module` (package) | `package:express` | — |

Nothing in a key comes from a counter, a timestamp or iteration order, so
analysing the same commit twice yields identical ids. That buys:

- **Idempotent persistence.** Re-analysis is `DELETE` + `INSERT` in one
  transaction; readers see the old graph or the new one, never a mixture.
- **A UI that keeps its place.** A selected node survives a re-analysis.
- **Cooperation without ordering.** Two analyzers that describe the same thing
  produce the same id and therefore one node — which is why an analyzer never
  has to look up what another one created.
- **A basis for diffing and caching.** Later phases — incremental indexing,
  embeddings, cached summaries — can refer to a piece of code and still mean the
  same piece of code afterwards.

Ids are scoped by project *and* repository, so a project holding several
repositories cannot collide.

## Analyzers

```
SCIP ──▶ code knowledge graph ──▶ source analyzers ──▶ same graph, richer
```

`CodeAnalyzer` is the seam between "something that knows about this repository"
and the graph. SCIP enters through it like everything else, as the
code-intelligence stage; the source analyzers resolve their findings against
what it found; the classification stage reasons about the finished graph.

| Stage | Analyzer | Finds |
| --- | --- | --- |
| code-intelligence | `ScipAnalyzer` | Symbols, definitions, references, calls, implementations, containment |
| source | `FileAnalyzer` | The service, and what configures it |
| source | `ImportAnalyzer` | Imports, exports, package dependencies |
| source | `StructureAnalyzer` | Construction, parameter and return types |
| source | `ApiAnalyzer` | HTTP routes, their handlers, guards and validators |
| source | `DatabaseAnalyzer` | Databases, tables, reads and writes |
| source | `ExternalServiceAnalyzer` | Third-party services, by SDK or URL |
| source | `MessagingAnalyzer` | Queues and events, with publishers and subscribers |
| classification | `FrameworkAnalyzer` | Frameworks in use, and each class's role |

`CodeGraphAssembler` owns the merge, and its rules are the graph's guarantees:
identity decides everything, the first writer wins for nodes, an analyzer
annotates rather than replaces, no edge exists without both endpoints, and every
edge carries evidence.

### Resolution, not name matching

An analyzer that sees `controller.createUser` resolves `controller` through the
file's binding table — a parameter's declared type, a `new UserController()`
initialiser, an import — and asks the symbol index for that member *in that
file*. If the name does not resolve, no edge is emitted.

There is deliberately no fallback that searches the repository for something
plausibly called `UserController`. That fallback is how a graph fills up with
relationships nobody can trust, and a missing edge is recoverable in a way a
wrong one is not.

### Roles

The classification stage annotates classes with `metadata.role` and
`metadata.roleEvidence`, from the shape of the graph rather than from names:

| Role | Evidence |
| --- | --- |
| `controller` | An API route dispatches to it, or it carries `@Controller` |
| `repository` | It reads or writes a table |
| `entity` | It maps to a table |
| `client` | It calls an external service |
| `service` | A controller calls it and it calls a repository, or it carries `@Injectable` |
| `guard` | It is an injectable implementing the framework's guard contract |

A framework decorator is better evidence than any structural inference, so it
wins where present. Nothing is inferred from a file name or a class-name
suffix: in a real codebase `UserService` in `user.service.ts` might be the
controller, and `Helpers` might be the only thing touching the database.

## Determinism

The pipeline is deterministic by construction:

- every identity is a content hash
- accumulation uses `Map`s keyed by those identities
- analyzers run in a fixed order over a path-sorted file list
- both output arrays are sorted by id before returning
- `serializeGraph()` emits fixed key order, so two runs are byte-identical and a
  checksum answers "did this commit change the graph?"

Tested in `packages/graph/tests/scip-graph-builder.test.ts`,
`packages/graph/tests/assembler.test.ts` and
`packages/analysis/tests/analyzers.test.ts`.

## Projections

A projection is a named slice of the one graph: a node-type filter, a
relationship filter and a ranking hint. Defined once, in
`packages/shared/src/constants/projections.ts`, and read by both the API and the
UI — so the "Architecture" button and `?projection=architecture` cannot drift.

| Projection | Answers |
| --- | --- |
| `everything` | No filter |
| `architecture` | APIs, services, data stores and the behaviour between them |
| `calls` | What calls what |
| `files` | The source tree and its file-level dependencies |
| `dependencies` | Libraries and services this one depends on |
| `dataflow` | Request to store: API → service → database, queue, event |

There is one graph and one set of tables. A projection changes which rows are
selected and how they are ranked; it never changes where they come from.

## Traversal semantics

Identical in the recursive CTE (`packages/database`) and in memory
(`packages/graph/src/traversal`), so the two can be checked against each other:

- **Directional or not.** `both` by default — a depth-1 walk from a service
  finds its callers as well as its callees — with `outgoing` and `incoming`
  available. Direction is preserved on each returned edge either way.
- **Relationship filter** applied during expansion.
- **Node-type filter** applied to expansion candidates — a filtered traversal
  never reaches *through* an excluded node. The root is always included.
- **Limit** on node count; the response reports `truncated`.
- **Edges** are the induced subgraph: an edge is returned only when both
  endpoints are.
- **Order** is nearest-first for a traversal, rank-first for an overview.

### Paths

A path query is a separate walk with separate guarantees, and it is also
implemented twice — `GraphRepository.findPath` in SQL,
`findGraphPath` in `packages/graph/src/traversal` in memory — with the same
semantics, so the two can be checked against each other.

- **Breadth-first, level by level**, so the route returned is the one with the
  fewest hops. Deliberately not a single recursive CTE carrying its own path
  array: that is exponential on a graph with cycles, and a hub node in a real
  repository reaches most of the graph within three hops.
- **Bounded twice** — by `maxDepth` (1–12, default 6) and by a node budget
  (20 000). Spending the budget reports `truncated: true` and `found: false`,
  which means *the search could not conclude*, not *there is no route*.
- **Directed first, undirected as a fallback.** `outgoing` asks the question a
  trace usually is. When nothing directed exists the search repeats ignoring
  direction and the answer says `undirected: true`, marking each hop it crossed
  backwards with `reversed: true`.
- **Deterministic predecessors.** Within a level, the node that introduces a
  neighbour is chosen by a total order over
  `(neighbour, reversed, relationship, source, target, edge)` — never by
  whatever the planner returned first. Two runs over the same graph return the
  same route, and so does the in-memory search given the same rows.
- **Relationship and node-type filters** apply to the walk, exactly as they do
  to a traversal.
- **Every hop is an edge that exists**, returned with the evidence and
  confidence it was recorded with. No step of a path is ever inferred.

### Definitions and the source tree

Two things the explorer needs are read off the graph rather than added to it:

- **A definition** is not a separate record, because a node *is* one. SCIP
  reports the range a symbol occupies and the builder stores it as
  `startLine`/`startCharacter`/`endLine`/`endCharacter`, so "where is this
  defined" is the node's own columns plus the id of the `file` node that
  `CONTAINS` it. A node the indexer gave no range reports nulls; nothing is
  reconstructed from a name.
- **The repository tree** is the `directory` and `file` nodes the builder
  already creates for every document, queried one level at a time by path
  prefix. There is no second filesystem walk, which is also why every row of the
  tree carries a node id: a file in the tree and a file in the graph are the
  same thing.

## Worked example

`test-repositories/express-postgres-sample` — a layered Express service —
produces 114 nodes and 407 edges. Its architecture projection is its
architecture:

```
POST /users ──ROUTES_TO──▶ UserController ──CALLS──▶ UserService
                                                        │
                    ┌───────────────┬───────────────────┼──────────────────┐
               CALLS│          CALLS│              CALLS│         PUBLISHES│
                    ▼               ▼                   ▼                  ▼
            UserRepository    EmailService       PaymentService    queue welcome-emails
                    │               │                   │                  ▲
          WRITES_TO │         CALLS │             CALLS │        SUBSCRIBES│
                    ▼               ▼                   ▼                  │
              table users       SendGrid             Stripe      WelcomeEmailWorker

UserService ──PUBLISHES──▶ event user.created ◀──SUBSCRIBES── registerUserCreatedListener
users-service ──DEPENDS_ON──▶ express · pg · bullmq · stripe
users-service ──CONFIGURED_BY──▶ package.json · tsconfig.json · .env.example
```
