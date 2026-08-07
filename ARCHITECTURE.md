# Repository architecture

This repository has two deployable units: the Next.js admin platform at the
root and the independent Fastify service in `services/antifraud-monitor`. They
share operational contracts, but not a package graph or build output.

## Next.js platform

`src/app` is split by host-facing application, not by arbitrary technical
layers:

- `(admin)` — the main staff dashboard.
- `(creator-hub)` — the Marketing/creator operations webapp.
- `(antifraud)` — the Fraud operations webapp.
- `(pack-studio)` — the Pack Builder webapp.
- `(auth)` — shared authentication routes.
- `api` — HTTP, cron, bot, and service integration boundaries.

Each route owns its page shell, loading state, actions, private components, and
route-specific reads. Private folders such as `_components`, `_queries`, and
`_lib` are intentionally colocated when their code has one feature owner. Move
code to `src/components` or `src/lib` only after it has multiple real consumers.

`src/components/ui` contains the shadcn/base-ui primitives. Higher-level shared
table and presentation infrastructure lives directly under `src/components` or
in a named subfolder such as `data-table`, `entity-surface`, or `ux`.

## Server and domain code

- `src/lib/queries` contains MAIN read models and aggregate queries. MAIN reads
  use mirror-resolving clients and never request a writable primary client.
- `src/lib/metrics` owns canonical customer scope and financial formulas.
- Named domain folders (`antifraud`, `creator-vip`, `permissions`, `packs`,
  `reward-expiry`, and similar) own rules reused by routes or APIs.
- `src/lib/backend-api` contains server-only backend clients. `contracts.ts` is
  the implementation-neutral response model shared by HTTP clients and their
  PostgreSQL read fallbacks; contract modules must not depend on either client.
- `src/lib/db-schema` is generated catalog output. Do not hand-edit it.
- Root-level files under `src/lib` are reserved for genuinely cross-domain
  infrastructure or established public entry points. New feature-specific
  helpers belong with their domain.

Preferred dependency direction:

```text
route/page -> route-private code -> shared domain/query code -> DB or upstream
     |                  |                    |
     +------------> shared components <-----+
```

Types that are shared by two implementations belong in a neutral model or
contract module, not in one implementation importing back from the other.
`npm run analyze:cycles` enforces the current zero-cycle graph.

## Data boundaries

The root application has two PostgreSQL domains:

- MAIN: customer/game data; ordinary reads go through
  `MIRROR_PRODUCTION_DB`/`MIRROR_DEV_DB` and are read-only.
- ADMIN: staff-only state, permissions, audit, workflow, and integration data;
  mutations are allowed through the reviewed Admin migration/action paths.

There are no cross-database joins. Fetch bounded sets independently and merge
them in application code. The Antifraud service has its own database and reads
MAIN through its configured source mirror. See `CLAUDE.md` and
`docs/BACKEND_QUERY_SYSTEM.md` for the binding query rules.

## Antifraud monitor

`services/antifraud-monitor` is a separate Node 22 package with its own lockfile,
TypeScript configuration, tests, Railway configuration, migrations, and build
output. Root TypeScript deliberately excludes it. Validate it with
`npm run check:antifraud`; Railway builds it from its service directory.

## Tests and analysis

- `scripts/__fixtures__` contains fast source-contract and unit guardrails run
  by `npm run test:guardrails` and before every root build.
- Some guardrails inspect tracked files with `readFileSync` or `git ls-files`.
  Those source-contract files are not dead merely because they lack imports.
  `src/lib/queries/insights-rewards/motha/overview.ts` is one such retained
  query contract.
- `e2e` contains Playwright coverage and its own TypeScript config.
- `npm run analyze:dead-code` runs Knip as an audit aid. Framework conventions,
  generated schemas, migrations, deployment files, and filesystem-read test
  contracts must be verified manually before deletion.
- `npm run analyze:cycles` checks the root import graph with Madge.

## Database history and deployment files

- `drizzle/admin/migrations` is the current reviewed Admin migration path.
- `prisma/admin` and `prisma/migrations` retain historical migrations and SQL;
  they are not evidence of a live Prisma runtime.
- `vercel.json` configures root application cron jobs.
- `services/antifraud-monitor/railway.json` configures the independent service.

Do not relocate framework entry files, migrations, generated schemas, scripts,
or deployment configuration solely to make the tree look uniform.
