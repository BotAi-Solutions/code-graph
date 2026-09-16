# express-postgres-sample (`users-service`)

A layered Express + PostgreSQL service, used as the fixture for the
architectural analyzers. It is analysed **in place** and never installed: the
ambient declarations in `src/types/vendor.d.ts` are what let it typecheck
without a `node_modules` tree.

## The graph it should produce

```
POST /users ──ROUTES_TO──▶ UserController.create ──CALLS──▶ UserService.create
                                                                │
                              ┌─────────────────────────────────┼───────────────────────┐
                              │                 │               │                       │
                         CALLS│            CALLS│          CALLS│              PUBLISHES│
                              ▼                 ▼               ▼                       ▼
                     UserRepository.create  EmailService   PaymentService      queue welcome-emails
                              │                 │               │                       ▲
                     WRITES_TO│            CALLS│          CALLS│              SUBSCRIBES│
                              ▼                 ▼               ▼                       │
                        table users         SendGrid         Stripe        WelcomeEmailWorker

UserService.create ──PUBLISHES──▶ event user.created ◀──SUBSCRIBES── registerUserCreatedListener
```

plus, from the same analysis:

- `users-service` (a `service` node, named by `package.json`) `DEPENDS_ON`
  express, pg, bullmq and stripe, and `DEPENDS_ON_SERVICE` SendGrid and Stripe
- `users-service` `CONFIGURED_BY` `package.json`, `tsconfig.json`, `.env.example`
- `postgresql` (a `database` node) `CONTAINS` the `users` and `orders` tables
- `GET /users`, `GET /users/:id`, `PATCH /users/:id/verify`, `DELETE /users/:id`
  and `GET /health`, each routed to its handler

## Why each piece is here

| File | Exercises |
| --- | --- |
| `api/user.routes.ts` | Express router, mounted under a prefix in `app.ts` — so route paths have to be resolved across files |
| `api/health.routes.ts` | A router declared at module scope rather than inside a factory |
| `controllers/user.controller.ts` | Handlers reached through an inline arrow wrapper |
| `services/user.service.ts` | Fan-out to repository, two integrations, a queue and an event |
| `services/email.service.ts` | An external service identified by an absolute URL |
| `services/payment.service.ts` | An external service identified by a vendor SDK import |
| `repositories/user.repository.ts` | INSERT / SELECT / UPDATE / DELETE / JOIN, literal and interpolated |
| `events/` | An event bus shared across files: publisher and subscriber never call each other |
| `workers/` | A queue consumer, reachable only through the queue |
| `config/` | Configuration files and a connection pool |

`orders` appears only in a `LEFT JOIN`, which is deliberate: it proves the
analyzer reads joined tables and not just the leading `FROM`.
