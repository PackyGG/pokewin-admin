# Codex Database Rules

Database permissions are strict.

## Admin database

FULL ACCESS.

Codex may:

* read and write data
* modify schema
* create and modify indexes
* merge/consolidate redundant indexes
* create migrations
* optimize queries
* perform admin-database maintenance

Verify schema changes before applying them.

## Production PostgreSQL

STRICTLY READ ONLY.

Codex may:

* run SELECT queries
* inspect schema
* inspect indexes
* inspect query plans

Codex must NEVER:

* INSERT
* UPDATE
* DELETE
* ALTER
* DROP
* TRUNCATE
* CREATE indexes
* run migrations
* push schema changes
* modify permissions
* modify production data

Never run schema-push tooling against production PostgreSQL.

## Production mirror database

This is the preferred source for production data reads.

* Prefer the mirror for analytics and heavy reads.
* Avoid unnecessary load on production PostgreSQL.
* Treat the mirror as read-only unless its configured permissions explicitly allow writes.
* Never perform destructive operations without explicit authorization.

## Antifraud database

FULL ACCESS.

Codex may:

* read and write data
* modify schema
* create migrations
* create and modify indexes
* merge/consolidate indexes
* optimize queries
* perform maintenance

Preserve data integrity and antifraud behavior.

## General safety

Before any database-changing command:

* identify the exact target database
* verify that writes are allowed
* inspect the relevant schema/migrations
* understand the impact
* use the least destructive approach

Never guess which database a connection string targets.

Never expose or commit:

* database URLs
* passwords
* API keys
* tokens
* other secrets
