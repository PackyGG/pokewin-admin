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
