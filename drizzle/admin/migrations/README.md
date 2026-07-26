# Admin PostgreSQL migrations

Put new reviewed, idempotent admin-schema SQL migrations in this directory.
Apply one file transactionally with:

```bash
npm run admin:sql -- drizzle/admin/migrations/<migration>.sql
```

Then refresh the checked-in Drizzle schema:

```bash
npm run db:pull:admin
```

Historical SQL under `prisma/admin/migrations` and `prisma/admin/sql` is kept
unchanged as the legacy migration record. Do not apply schema changes to MAIN;
`npm run db:pull:main` is introspection-only.
