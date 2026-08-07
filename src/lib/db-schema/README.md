# Drizzle schema snapshots

`main/` and `admin/` are generated from the live PostgreSQL catalogs with
`drizzle-kit introspect`. The SQL files are baselines for schema review, not
migrations to run against databases that already contain these objects.

Refresh the snapshots with:

```sh
npm run db:pull:main
npm run db:pull:admin
```

MAIN remains read-only for agents. Admin changes are authored as reviewed SQL
under `drizzle/admin/migrations`, applied with `npm run admin:sql -- <file>`,
then reflected here with `npm run db:pull:admin`.

The pull scripts also normalize two drizzle-kit introspection gaps: PostgreSQL
empty-array defaults and unsupported `bytea`/`oid` generated types. Do not run
the bare drizzle-kit command or hand-edit these generated artifacts.
