# Knowledge Sample

A small service that exists to be indexed. It is deliberately more than its
code: the contract lives in `openapi.yaml`, the schema lives in
`database/migrations`, the deployment lives in `docker-compose.yml`, and this
file explains how they fit together.

See [the architecture notes](docs/architecture.md) for the layering.

## Authentication

Sessions are issued by AuthService, which hashes the presented credentials and
writes a row for each session it grants. Nothing else in the service is allowed
to create a session.

## Users

Registration goes through UserService, which validates the input and hands it
to UserRepository. The repository is the only place a SQL statement is written.

The HTTP surface is served by UserController and declared in `openapi.yaml`.

## Running it

```bash
docker compose up
npm run migrate
```

The `docker compose` command starts the `api` and `postgres` containers
described in [docker-compose.yml](docker-compose.yml).
