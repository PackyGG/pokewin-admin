# pokewin-admin

Admin dashboard for packy.gg. Next.js 15 (App Router) · TypeScript (strict) ·
Prisma · Tailwind + shadcn/ui.

See `CLAUDE.md` for the binding working rules and `ONBOARDING.md` for
architecture/domain context.

## Scripts

```bash
npm run dev     # Next.js dev (Turbopack) + prisma generate for both DBs
npm run build   # prisma generate (both DBs) + next build — authoritative gate
npm run start   # production server
npm run lint    # ESLint
```

## Edge Config caching

Read-heavy config and feature flags are served from **[Vercel Edge
Config](https://vercel.com/docs/edge-config)** — a globally-replicated,
ultra-low-latency store for values that are read on almost every request but
written rarely (feature flags / kill-switches, tunable thresholds, default
page sizes, small allow/deny lists).

- **Helper:** `src/lib/edge-config.ts`
  - `getCachedConfig<T>(key, fallback?)` — read one typed value; returns
    `fallback` when Edge Config is unset, the key is missing, or the read
    fails.
  - `getFeatureFlag(key, fallback = false)` — read a boolean flag, fail-safe.
  - `isEdgeConfigEnabled()` — whether a connection string is configured.
- **Graceful fallback:** with no `EDGE_CONFIG` set (local dev, or the store not
  yet connected) the helper never constructs a client and every read returns
  the caller's `fallback`. Behavior is identical to having no Edge Config at
  all — always pass the current hard-coded value as the fallback. Reads also
  swallow any SDK error and degrade to the fallback, so the app never crashes.
- **Current usage:** the audit log (`src/app/(admin)/audit/page.tsx`) reads its
  default rows-per-page from key `auditLogDefaultPerPage` with a fallback of
  `20`; an explicit `?perPage=` URL override always wins.

### Setting up the Edge Config store

Edge Config must be created and connected on Vercel before it serves values.
Until then the app uses the fallbacks above (no crash, unchanged behavior).

1. **Create + connect a store** (project `packy-admin-dashboard`):
   - Vercel dashboard → **Storage → Create Database → Edge Config**, then
     connect it to the project; or via CLI:
     ```bash
     npm i -g vercel        # the Vercel CLI may not be installed
     vercel login
     vercel link            # link this repo to the project
     ```
     Create/connect the store in the dashboard (Storage tab). Connecting it
     sets the `EDGE_CONFIG` env var on the project automatically.
2. **Sync the connection string locally:**
   ```bash
   vercel env pull .env.local   # writes EDGE_CONFIG into .env.local
   ```
3. **Add keys** (e.g. `auditLogDefaultPerPage`) to the store via the dashboard
   or `vercel edge-config` — no redeploy required; updates propagate globally.

`.env.example` documents the `EDGE_CONFIG` key. Never commit the real `.env` /
`.env.local`.

### When NOT to use Edge Config

Edge Config is for read-heavy, rarely-written values. For **frequently-mutated**
cache values (per-request memoization of slow / rate-limited upstream work) use
the dormant Upstash Redis read-through layer at `src/lib/cache/redis.ts`
(`cacheGetOrSet`), provisioned via the **Upstash Redis** Vercel Marketplace
integration.

> Note: `@vercel/kv` is **sunset** — do not add it. Use `@vercel/edge-config`
> for config/flags and Upstash Redis (Marketplace) for churny cache values.

## ClickHouse CQRS read engine (admin reads)

Admin **reads** are migrating to a **ClickHouse Cloud** mirror of the prod game
database (`packy_prod`, kept in sync by a PeerDB CDC mirror into `public_*`
tables). Admin **writes** stay on Postgres, which remains the single
source-of-truth — the CQRS split only moves heavy read aggregates off the prod
Postgres, never any mutation. The whole layer is flag-gated and currently
**behavior-neutral**.

### Per-surface read mode

Each admin read surface chooses its engine via `getAdminReadMode(surfaceKey)`
in `src/lib/feature-flags/admin-read-source.ts`. Three modes:

- **`off`** — Postgres only (today's behavior, the default).
- **`comparison`** — serve the Postgres result, run the ClickHouse twin
  side-by-side, and log any drift. Never changes what the user sees.
- **`clickhouse`** — ClickHouse is the sole read path (on failure the caller
  degrades to cached/error — it must not silently re-run the heavy Postgres
  aggregate).

Resolution precedence (first match wins): if ClickHouse is dormant (no creds)
the mode is forced to `off`; otherwise env override
`ADMIN_READ_SOURCE__<SURFACE>` → Edge Config `admin-read-source:<key>` → Edge
Config `admin-read-source:__default` → `off`. The env-var suffix is the surface
key uppercased with every non-`[A-Z0-9]` run replaced by `_` (e.g.
`dashboard_headline_ggr` → `ADMIN_READ_SOURCE__DASHBOARD_HEADLINE_GGR`).

### Current state — comparison only, no cutover

The dashboard headline GGR (`dashboard_headline_ggr`), trend series
(`dashboard_trend_series`), lifetime realized P&L
(`dashboard_realized_pnl_lifetime`) and cash-flow (`dashboard_cashflow`)
surfaces are wired in **`comparison` mode** only. **No** surface defaults to
`clickhouse`, so the live dashboard still serves Postgres; the ClickHouse twins
run purely to log drift, which is proven parity-clean to the cent (money within
half a cent, counts exact).

### Read-only guard + mandatory query shape

The read layer lives under `src/lib/clickhouse/`:

- `client.ts` builds the server-only client with the session setting
  `readonly = 2` (reads + per-query limits, never writes/DDL); it stays dormant
  (returns `null`) whenever the `CLICKHOUSE_*` env is unset.
- `readonly-query.ts` exposes only `query()` — no insert/command/exec path —
  and `guards.ts` rejects any non-read statement before it reaches the server.
- `comparison.ts` holds the never-throw `compareX` hooks; `queries/*` hold the
  ClickHouse twins of the Postgres aggregates.

Every ClickHouse query reads from the CDC mirror as
`FROM packy_prod.public_X FINAL WHERE _peerdb_is_deleted = 0`, and money is read
as Decimal → string → `toNumber()` (never Float).

### CQRS import boundary + tests

ClickHouse modules must **not** import `@/lib/db`, `@/lib/admin-db`, `pg`, or
Prisma (directly or transitively) — a boundary test enforces this. Run the
read-only guard + import-boundary suite with:

```bash
npm run test:parity
```

For background, see `CLICKHOUSE_CQRS_ESCALATIONS.md` (open owner decisions) and
`CLICKHOUSE_CQRS_DB_SAFETY_VERDICT.md` (the "safe to merge" DB-safety verdict).
