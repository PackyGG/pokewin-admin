# pokewin-admin

Admin dashboard for packy.gg. Next.js 15 (App Router) · TypeScript (strict) ·
PostgreSQL + Drizzle ORM · Tailwind + shadcn/ui.

See `CLAUDE.md` for the binding working rules and `ONBOARDING.md` for
architecture/domain context.

## Scripts

```bash
npm run dev     # Next.js dev (Turbopack)
npm run build   # production build — authoritative gate
npm run start   # production server
npm run typecheck
npm run lint    # ESLint
npm run test:guardrails
npm run analyze:dead-code
npm run analyze:cycles
npm run check:antifraud
npm run db:pull:main   # refresh read-only MAIN Drizzle schema snapshot
npm run db:pull:admin  # refresh ADMIN Drizzle schema snapshot
npm run admin:sql -- drizzle/admin/migrations/<file>.sql
```

## Architecture

See `ARCHITECTURE.md` for the application boundaries, data-access layers,
deployment units, and file-placement rules. The repository contains one Next.js
application plus the independently built `services/antifraud-monitor` service.

## Database query layer

The app reads from two PostgreSQL databases: the read-only MAIN game database
and the ADMIN database. Runtime access uses Drizzle ORM, with parameterized
Drizzle `sql` for complex aggregates. The databases remain strictly separated;
cross-database data is fetched in batches and joined in application code.

See `docs/BACKEND_QUERY_SYSTEM.md` for query, indexing, caching, pagination,
pooling, and verification rules.
