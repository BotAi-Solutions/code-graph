# Architecture

Four layers, each allowed to talk only to the one below it.

## Transport

UserController turns an HTTP request into a call and a response into JSON. It
holds no logic of its own.

## Application

UserService is where the rules live. It is the only layer that may combine two
repositories in one operation.

## Persistence

UserRepository owns every SQL statement in the service. A query written
anywhere else is a bug.

## Storage

PostgreSQL, with the schema in `database/migrations`. See
[the README](../README.md) for how to run it.
