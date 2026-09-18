# Repository knowledge

A repository is not only its code. The contract lives in `openapi.yaml`, the
schema lives in `database/migrations`, the deployment lives in
`docker-compose.yml`, and the reason for all three lives in the README. A graph
that reads only the TypeScript can answer *what calls what* and cannot answer
*which documented endpoint has no handler*, *which table has no migration*, or
*where is this behaviour explained*.

This document describes the layer that reads the rest, and the rules that keep
it from turning a repository into noise.

## The principle

> **SCIP is the deterministic source of truth for code-level relationships.
> Everything else adds repository knowledge around it.**

SCIP is the compiler's own view: definitions, references, calls,
implementations, imports, containment. Nothing here competes with it, replaces
it, or second-guesses it. The repository analyzers describe what the compiler
never sees, and where the two meet — an operation and the method that serves it
— the join is made by exact match and recorded with evidence.

```
SCIP
  +  AST analyzers          routes, data access, integrations, queues
  +  document parsers       Markdown structure, links, named entities
  +  configuration parsers  JSON, YAML, Dockerfile, environment examples
  +  schema parsers         OpenAPI, and the operations it promises
  +  database analyzers     SQL DDL: tables, columns, keys, indexes
  ▼
One repository knowledge graph
```

## File categories

Everything starts with the scanner deciding what each file *is*. Nine
categories, assigned from the path alone in
`packages/language-detection/src/classify.ts`:

| Category | Holds | Read? |
| --- | --- | --- |
| `code` | `.ts` `.tsx` `.js` `.jsx` `.mts` `.cts` and the other languages the union knows | yes |
| `document` | `.md` `.mdx` `.markdown` | yes |
| `configuration` | `.json` `.yaml` `.yml` `.toml` `.ini`, `Dockerfile`, `.env*` | yes |
| `schema` | `.graphql` `.proto` `.prisma`, and a JSON/YAML file named as a specification | yes |
| `database` | `.sql` `.ddl` `.psql` | yes |
| `generated` | Lock files, `__generated__/`, `*.min.js`, `*.generated.*` | no |
| `vendor` | `vendor/`, `third_party/` | no |
| `binary` | Images, archives, fonts, media, compiled output | no |
| `unknown` | Text with nothing to say about it | no |

Alongside the category, a **role** where the name says one unambiguously:
`readme`, `package-manifest`, `typescript-config`, `dockerfile`, `compose`,
`ci-workflow`, `env-example`, `env`, `api-spec`, `json-schema`, `migration`,
`sql-schema`, `tooling-config`, `lockfile`. A role exists only where some
analyzer changes what it does on seeing it.

Precedence is load-bearing: generated and vendored win over the extension (a
generated `.ts` is not code anyone wrote), then the exact filename (so
`package.json` beats "a JSON file"), then the role patterns, then the extension.

### Classification is by path; refinement is by content

The scan is one directory walk with no file reads — that is what lets a
25,000-file repository be sized up in a second — so the scanner can only use the
name. A file called `openapi.yaml` that holds a Helm chart is not a
specification, and a specification called `contracts/public.yaml` is one. The
OpenAPI analyzer makes the real decision by reading for an `openapi:` version
*and* a `paths` object, and the node it creates records the refined category.

### What is never read

The ignore policy is unchanged and still drops `node_modules`, `.git`, `dist`,
`build`, `coverage`, `.next`, lock files and build output before classification
runs. On top of that:

- A live `.env` is **listed but never read**. Its path is a fact about the
  service; its contents are credentials. `.env.example` and its variants are
  read, and only for variable *names*.
- A promoted configuration property records its value unless the key names a
  credential — `password`, `secret`, `token`, `api_key`, `private_key` and
  friends — in which case the node keeps the name and records `redacted: true`.
- The source loader reads only the categories an analyzer can use, with a per-
  file byte cap, a total byte cap and a file-count cap.

## The parsers

Four, in `packages/analysis/src/parsers/`. Each answers two questions — *what is
in this file* and *where in the file is it* — because an edge whose evidence
cannot name a line is an edge nobody can check.

### Structured documents

`structured.ts` defines one model for JSON and YAML: objects, arrays and
scalars, each with a 1-based line and a 0-based column, and each object entry
carrying the position of its *key* rather than only of its value.

- `json-document.ts` is a hand-written recursive-descent parser. `JSON.parse`
  would be shorter and is not enough: it discards every position, and it rejects
  `tsconfig.json`, which the TypeScript ecosystem has written with comments and
  trailing commas for a decade. This accepts JSON plus `//` and block comments
  plus trailing commas, and rejects everything else with a message naming the
  line. It never throws.
- `yaml-document.ts` wraps the `yaml` package — a real parser, because YAML is
  not a line format — and converts the first document of a stream into the same
  model. A multi-document stream reports how many documents there were, and the
  configuration analyzer says so in its diagnostics rather than pretending the
  first one was the file.

Nothing outside `parsers/` ever sees a `yaml` `Document` or a JSON token.

### Markdown

`markdown.ts` is a focused CommonMark subset: front matter, fenced code blocks,
ATX headings, inline code spans, inline links. Two decisions change what the
graph believes:

- **Fenced code is not prose.** A fence is tracked before anything else, so a
  `# comment` in a shell block is never a heading and a class name in an example
  is never a mention.
- **Setext headings are not supported.** `---` under a line is also a thematic
  break and also closes front matter; a parser that guesses between the three
  will eventually guess wrong. A document using setext has fewer sections rather
  than wrong ones.

### SQL

`sql-schema.ts` recognises the DDL that names things unambiguously — `CREATE
TABLE` and its column bodies, `ALTER TABLE … ADD COLUMN`, `CREATE INDEX`,
`REFERENCES` — and reuses the existing statement detector for reads and writes.
Comments and string literals are blanked to spaces of the same length *and the
same newlines* before anything is matched, which is what keeps every reported
line number correct while making a table name in a comment unmatchable.

It is deliberately not a SQL parser. Anything assembled at runtime produces
nothing.

### OpenAPI

`openapi.ts` works on the structured model, so the same extractor handles
`openapi.json` and `openapi.yaml`. It reads operations with their method, path,
`operationId`, tags, parameters, request and response schema names, and the line
each is written on. A single server with a literal URL contributes its path as a
base path; three servers contribute nothing, because there is no single base
path and picking the first would prefix every route with a staging host.

## Promotion, and why there is so little of it

A Kubernetes manifest has four hundred addressable paths. A graph node for each
is not repository intelligence, it is a YAML file redrawn as a hairball — and
the same is true of every string in a README and every column of a warehouse.

So the configuration analyzer promotes by **profile**, one per recognised kind
of file:

| File | Promoted |
| --- | --- |
| `package.json` | scripts, engine constraints, workspace patterns — **not** dependencies, which the import analyzer already models as `module` nodes with `DEPENDS_ON` edges at a more useful altitude |
| `tsconfig.json` | `extends`, and the eleven compiler options that change what the code *means* |
| `.env.example` | variable names, never values |
| compose | one `container` node per service, with its image, ports and environment variable names |
| `Dockerfile` | base images, exposed ports and build stages, as metadata — a base image is not a thing in this repository |
| CI workflow | job names |
| anything else | scalar paths at most **two** levels deep, at most 25 of them |

And a configuration file gets a node at all only if it is one the file analyzer
already calls configuration, a CI workflow, or a file that lives in a
configuration directory or has `config` in its name. A repository full of JSON
fixtures does not become a graph full of JSON.

The other caps: 400 mentions and 200 sections per document, 200 columns per
table, 500 operations per specification, 60 promoted properties per file.

## Evidence and confidence

See [graph-model.md](graph-model.md#evidence) for the record and the policy.
The two things worth repeating here:

- **The graph can always answer "why do we believe this?"** Every edge names an
  analyzer, a confidence and — for everything read out of a file — the file and
  line to go and check.
- **The confidence policy lives in one file.** A producer names the kind of
  observation it made and gets a level back. It never writes a level and never
  writes a number, which is what keeps `medium` meaning one thing across twelve
  analyzers.

## What it refuses to do

The quality goal is not maximum extraction. Concretely, the pipeline declines
to:

- resolve a prose name that matches more than one node, or that is a single
  English word;
- link a specification operation to a route whose path merely looks similar;
- record a value under a key that names a credential;
- read a live `.env` at all;
- promote a configuration path deeper than its profile allows;
- emit a relationship at `low` confidence;
- invent a node for an edge endpoint that does not exist — the assembler drops
  the edge and counts it.

Each of those is a place where a plausible-looking edge was available and was
not taken. The [benchmark](benchmark.md) is how we find out whether that
restraint costs recall.

## Reading it back

| Question | Where |
| --- | --- |
| What kind of file is this node? | `symbol.fileCategory` on node detail |
| What kind of thing is it? | `symbol.category` and `symbol.family` |
| Why is this relationship here? | `evidence` on a related node or a path step |
| What does the repository say about this class? | the `documentation` section of node detail |
| What declares this, and is it implemented? | the `contracts` section |
| Show me only documentation | `?categories=knowledge` on search |
| Trace the contract to the table | `POST /graph/path` with `projection=cross-source` |
