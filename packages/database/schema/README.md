# schema/

`schema.sql` is a **reference snapshot** of the current database shape, kept for
reading and for diffing during review. It is never executed by the application.

The authoritative definition is the ordered set of files in `../migrations`,
applied by `pnpm db:migrate`. When you add a migration, regenerate this snapshot:

```bash
cat migrations/*.sql > schema/schema.sql
```
