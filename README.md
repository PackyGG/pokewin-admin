# pokewin-admin

Admin dashboard for packy.gg. Next.js 15 (App Router) · TypeScript (strict) ·
PostgreSQL + Drizzle ORM · Tailwind + shadcn/ui.

Codex contributors must read `AGENTS.md` and `.codex/RULES.md` first. See
`ONBOARDING.md` for architecture/domain context.

## New-device setup

Prerequisites: Git, Node.js 24 (the production runtime), npm, GitHub access to
`PackyGG/pokewin-admin`, and access to the `packy-gg1` Vercel team.

```bash
git clone https://github.com/PackyGG/pokewin-admin.git
cd pokewin-admin
nvm install
nvm use
npm ci

# Restore the existing Vercel project link and local development variables.
npx vercel link --scope packy-gg1 --project packy-admin-dashboard
npx vercel env pull .env --environment=development

npm run typecheck
npm run lint
npm run dev
```

`.env` and `.vercel/` are intentionally local and gitignored. Never commit
downloaded credentials. If the development environment does not contain the
integration you need, request the specific variable from an owner rather than
copying production secrets into source control.

The default branch is `main`; normal GitHub pushes deploy the Admin app through
the existing Vercel integration. Database permissions and deployment rules are
defined in `.codex/rules/DATABASE.md` and `.codex/rules/INFRA.md`.

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
