# PostgreSQL container

`docker compose up -d` starts a single PostgreSQL 17 instance.

- Database: `code_knowledge_graph`
- User / password: `ckg` / `ckg`
- Port: `5432`

`initdb/` scripts run once, when the data volume is first created. They only
install extensions; all tables are created by the migrations in
`packages/database/migrations`, applied with `pnpm db:migrate`.

To start from scratch:

```bash
docker compose down -v && docker compose up -d && pnpm db:migrate
```
