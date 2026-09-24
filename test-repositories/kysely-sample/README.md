# kysely-sample

A fixture for the database analyzer's Kysely detector. The repository layer
builds every query with the Kysely query builder, in the shapes a real NestJS
code base uses them (modelled on Immich): plain `selectFrom` / `insertInto` /
`updateTable` / `deleteFrom`, joins, subqueries, CTEs that shadow real table
names, a recursive CTE, and a table named by a variable, which must produce
nothing.

Dependencies are deliberately not installed: the analyzer reads source, and
SCIP indexes the classes and methods without them.
