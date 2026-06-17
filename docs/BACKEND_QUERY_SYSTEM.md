# Backend Query System — Guide for Agents

How data is read, cached, streamed, and (optionally) served from ClickHouse in
`pokewin-admin`. Read this before adding or optimizing any admin page or query.
Everything here is enforced by `CLAUDE.md` / `AGENTS.md`; this doc is the
practical "how to actually do it".

---

## ⚖️ THE HARD RULE — Index-or-ClickHouse (2026-06-17)

The backend was fully reworked. **Every read is served by exactly one of two
paths — there is no third way:**

> **A read either hits a confirmed Postgres index OR runs through ClickHouse.
> No unindexed read, no full-table / seq-scan on MAIN — ever, not even
> "just once" or "just quickly".**

- **Indexed Postgres** = live / per-user / money-exact reads. The query MUST be
  `EXPLAIN ANALYZE`-proven to hit an index (read-only probe). MAIN is read-only,
  so agents **never apply an index** — add the `CREATE INDEX CONCURRENTLY` to
  `prisma/recommended-indexes.sql` and flag the owner. A read that can only
  seq-scan is **BLOCKED**, not "done".
- **ClickHouse** = heavy aggregate / analytics / fan-out, wired through
  `resolveAdminRead` (§6).
- **New queries MUST follow this construct; the old plain Prisma/PG query layer
  is legacy.** No new unindexed PG queries. Touching/extending a read or
  building a new page → bring it onto a confirmed index or a CH twin. A query
  that serves neither is wrong and must not ship.
- This does **not** loosen the MAIN read-only rule (§1).

---

## 0. TL;DR decision tree

When you add or touch a read:

1. **Which DB?** Game/user data → `getDb()` (MAIN, prod, **read-only**). Admin
   panel data → `adminDb` (ADMIN DB, read/write OK). Never cross-join; query
   each and merge in code.
2. **Is it a heavy aggregate / fan-out?** → wrap it in the **prod-only
   env-keyed `unstable_cache` pattern** (§2).
3. **Does it block first paint?** → move it behind its **own `<Suspense>`** so
   the shell paints instantly (§3).
4. **Is there a period/tab selector?** → load **only the active window/tab**
   (§4).
5. **Can it hang?** → wrap in **`safeQuery` with a timeout** (§5).
6. **Is it an analytics surface with a ClickHouse twin?** → route it through
   **`resolveAdminRead`** (§6). Otherwise ignore CH entirely.
7. **Showing money?** → **House-POV colors** (§7).

---

## 1. The two databases

| | MAIN (game) | ADMIN (panel) |
|---|---|---|
| Client | `getDb()` / `getProdDb()` (`src/lib/db.ts`) | `adminDb` (`src/lib/admin-db.ts`) |
| Schema | `prisma/schema.prisma` | `prisma/admin/schema.prisma` |
| Access | **READ-ONLY** (SELECT + schema inspection only) | full read/write |
| Holds | users, balances, ledger, packs, cards, battles, rewards, vouchers, gift_cards, affiliates … | admin_users, admin_sessions, admin_audit_events, creator_deals, expenses, salaries … |

- **MAIN is live production.** No writes, no DDL, no `prisma migrate/db push`,
  no `$executeRaw` mutations — ever, under any instruction.
- `getDb()` resolves the per-admin `admin_db_env` cookie (prod vs dev). This is
  why caching needs the prod-only guard in §2.
- Cross-DB data (e.g. an audit event's `target_user_id`) is fetched **batched**
  from the other DB with a single `findMany({ where: { id: { in: [...] } } })`
  — never per-row (no N+1).

---

## 2. The dominant pattern: prod-only, env-keyed `unstable_cache`

`unstable_cache` is a **cross-request, cross-instance** server cache (Next data
cache). It is the single biggest lever for both latency and concurrency: 10
concurrent dashboard loads collapse onto one warmed cache entry instead of 10
DB scans.

### The rules (all four matter)

1. **Resolve `cookies()` / `getDb()` env OUTSIDE the cache callback.**
   `unstable_cache` runs its callback outside the request's dynamic scope, so a
   `cookies()` read inside throws. Read the env first, pass it as an argument.
2. **Cache ONLY on prod.** A dev-toggled admin must bypass the cache and read
   live (otherwise they'd be served prod data).
3. **Version the key parts.** The Vercel data cache persists entries **across
   deploys** (key = static keyParts + closure hash, not deploy id). When you
   change a query's shape or fix its math, **bump the version suffix**
   (`...-v2`) or stale values keep being served stale-while-revalidate.
4. **Tag it, and `revalidateTag` on mutation.** `revalidatePath` does **not**
   bust tagged data-cache entries. Any action that changes the underlying data
   must call `revalidateTag(THE_TAG)`.

### Canonical recipe

Reference: `src/lib/queries/users-detail-cache.ts`,
`src/lib/queries/battles-cache.ts`, `src/app/(admin)/rewards/shards/shard-packs-cache.ts`.

```ts
import { unstable_cache } from "next/cache";
import { readDbEnv } from "@/lib/db-env";

const cachedThing = unstable_cache(
  (userId: string) => getThing(userId),   // pure: no cookies() inside
  ["thing-aggregate-v1"],                  // bump -v1 → -v2 on shape/math change
  { revalidate: 60, tags: ["thing"] },     // 60s live-ish; 300s for lifetime
);

export async function getThingCached(userId: string) {
  const env = await readDbEnv();           // cookie read OUTSIDE the cache
  if (env !== "prod") return getThing(userId); // dev bypass → live
  return cachedThing(userId);
}
```

For period/scope-keyed analytics, also pass `(period, sortedBlacklist)` as
arguments so they become cache-key dimensions (see
`src/lib/queries/analytics.ts` and `insights-rewards/_period.ts`). Use 60s for
short windows, 300s for lifetime windows.

On mutation:
```ts
import { revalidateTag } from "next/cache";
revalidatePath("/thing");        // refreshes the route's RSC payload
revalidateTag("thing");          // REQUIRED to bust the data-cache entry
```

### When NOT to cache
Live, mutation-sensitive lists (audit feed, admin-users list, salaries/shifts
boards) — caching them serves stale state right after an edit. Cache the
read-mostly aggregates, not the live operational lists.

---

## 3. Stream the shell first (per-section `<Suspense>`)

A page must paint its `PageHero` + chrome **instantly** and stream heavy
sections in. Do **not** `await` heavy reads at the top of the page component.

```tsx
export default async function Page() {
  await requirePageAccess("/thing");      // cheap gate only
  return (
    <div>
      <PageHero ... />                      {/* paints immediately */}
      <Suspense fallback={<KpiStripSkeleton count={4} />}>
        <KpiSection />                       {/* async server component, streams */}
      </Suspense>
      <Suspense fallback={<TableSkeleton />}>
        <ListSection page={page} />
      </Suspense>
    </div>
  );
}
```

### Suspense keying rules (critical — this is a recurring bug class)

- **Summary / KPI boxes must NOT re-key on pagination/filter/tab.** Put them in
  their own boundary keyed only on what they actually depend on
  (e.g. `key={`kpi-${set}`}`), NEVER including `page`/`sort`/`search`. If the
  KPI boundary sits inside a parent boundary that re-keys on `page`, the KPIs
  re-skeleton on every page change. (Fixed examples: `/packs`, `/cards`,
  `/rewards/shard-opens`, `/rain/[id]`.)
- The **paginated list** gets its own boundary keyed on the full filter set
  (`key={`${page}|${sort}|${search}`}`) — it *should* re-fetch on those.
- Every admin route also has (or inherits) a `loading.tsx` so navigation
  commits to a skeleton instantly. Add one for any new route.

---

## 4. Active-Timeframe-Only

If a page offers periods (3h/24h/7d/30d/lifetime) or tabs:

- Initial render loads **only the active window + active tab**. Never preload
  all periods or hidden tabs.
- A new period is fetched on `?period=` change via a `<Suspense key={`${tab}-${period}`}>` boundary.
- Hidden tabs, drawers, modals, expanded rows: no heavy query until opened.
- **Bound lifetime windows.** No unbounded all-time scans — use
  `windowDateFilterCapped` / `INSIGHTS_LIFETIME_LOOKBACK_DAYS` (365d).
  **Exception:** if a cap would change a displayed *money-exact* number, leave
  it uncapped, rely on cache + timeout, and flag it for owner sign-off.

Reference: `src/lib/queries/insights-rewards/_period.ts`.

---

## 5. `safeQuery` — never let a scan hang the page

Wrap heavy reads so a slow/failed query degrades to a fallback instead of
throwing up the route error boundary (which white-screens the page).

```ts
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";

const { data, error, kind } = await safeQuery(
  () => getHeavyThing(),
  fallbackValue,            // served if it fails/times out
  "page.heavyThing",        // log label
  REWARD_QUERY_TIMEOUT_MS,  // wall-clock budget (15s)
);
if (error || !data) return <TileErrorFallback ... />;
```

---

## 6. CQRS: ClickHouse read-source switch (analytics only)

Heavy analytics surfaces (`/insights/*`, `/analytics/*`, creators/rewards
analytics, most dashboard legs) have a **ClickHouse twin** and are routed
through a per-surface switch. **Live/per-user/money-exact pages stay on indexed
Postgres** — do not give them CH twins.

### How it resolves — `getAdminReadMode(surfaceKey)`
`src/lib/feature-flags/admin-read-source.ts`. Precedence (first match wins):

0. **Hard safety:** ClickHouse dormant (no creds) ⇒ `"off"` (always Postgres).
1. Env override `ADMIN_READ_SOURCE__<SURFACE>`.
2. Edge Config `admin-read-source:<surface>`.
3. Edge Config `admin-read-source:__default`.
4. Hardcoded cutover set `CUTOVER_DEFAULT_CLICKHOUSE` ⇒ `"clickhouse"`.
5. `"off"`.

Modes: `"off"` = Postgres only · `"comparison"` = serve Postgres, log CH drift ·
`"clickhouse"` = CH is the sole path (on failure it THROWS so the caller's
cache/`safeQuery` degrades — it must **not** silently re-run the heavy PG
aggregate).

### How to wire a surface — `resolveAdminRead`
`src/lib/clickhouse/resolve-read.ts`:

```ts
return resolveAdminRead("my_surface_key", {
  pg: () => getThingFromPostgres(period),   // runs in off/comparison
  ch: () => getThingFromClickHouse(period), // runs in clickhouse mode
  compare: (pg) => compareThing(pg),        // optional drift logger
});
```

### ⚠️ Current production reality (2026-06-16)
**ClickHouse credentials are NOT set on Vercel prod** (`CLICKHOUSE_URL` absent).
So the hard-safety guard forces **every** surface to `"off"` → the entire
ClickHouse cutover is **DORMANT in production**; all analytics run on Postgres.
That is why insights/analytics are the slow pages, and why optimization work
targets the **Postgres (`pg()`) path**.

To activate the CH speedup the owner adds the four `CLICKHOUSE_*` vars
(`CLICKHOUSE_URL/HOST`, `USERNAME/USER`, `PASSWORD/TOKEN`, `DATABASE/DB`) to
Vercel. Then ~60 surfaces in `CUTOVER_DEFAULT_CLICKHOUSE` auto-cut-over, with
instant rollback per surface via Edge Config (`admin-read-source:<surface>` =
`off`). CH carries a 1–2 min CDC lag, which is acceptable for analytics but not
for money-exact headlines (those stay on PG by design — e.g. `dashboard_stats`).

---

## 7. House-POV financial colors (strict, site-wide)

Every money value, badge, chart, cell. **Never** user-perspective.

> User gains/profits → 🔴 **rose** · User loses money → 🟢 **emerald** · Neutral (signup, info) → 🔵 **blue**

Because every dollar the user holds is a dollar we owe. Quick test before
commit: "if the user would celebrate this event, is it rose?" Yes → correct.

Common mapping: deposit/wager/bet = emerald · withdrawal/win/rain prize/tip
received/bonus/rakeback/affiliate claim = rose · P&L/GGR positive = emerald,
negative = rose · signup = blue. A **voucher == a card** (same item); redeem/
exchange is **neutral** (not a house loss).

---

## 8. Indexes, concurrency, keep-warm

- **Index strategy:** recommended prod indexes live in
  `prisma/recommended-indexes.sql` (13 applied, EXPLAIN-validated). MAIN is
  read-only, so **agents do not apply indexes** — add the `CREATE INDEX
  CONCURRENTLY` statement to that file and flag it for the owner. Validate with
  read-only `EXPLAIN` probes (temp `node --env-file=.env` + `pg`, uncommitted,
  no secrets printed, deleted after).
- **Pool:** `getDb()` is `max: 3` per warm instance to stay under the shared
  prod cap. Don't raise it — the real fix is an owner-side pooler
  (PgBouncer/Accelerate). Caching (§2) is how we survive concurrency: shared
  warm entries mean concurrent renders don't each hit the pool.
- **Keep-warm:** `/api/cron/warm` (vercel.json, every 5 min, `CRON_SECRET`-gated)
  pings PG (and CH when configured) so caches/connections stay warm and cold
  starts don't show up as the 5s first-load.

---

## 9. Checklist for a new admin page

1. `page.tsx` is an async Server Component; first line is `requirePageAccess(key)` (or the right DAL guard).
2. `PageHero` renders immediately; heavy sections stream behind their own `<Suspense>`.
3. Heavy aggregates use the §2 cache; live lists are left uncached.
4. KPI/summary boundaries do **not** re-key on page/sort/search/tab.
5. Period/tab pages load only the active window/tab; lifetime scans bounded.
6. Every heavy read is `safeQuery`-wrapped with a timeout.
7. A `loading.tsx` exists for instant nav.
8. Money uses House-POV colors and Decimal-safe formatting (`@/lib/utils/format`).
9. Only serializable props cross the RSC boundary (no function props).
10. `tsc --noEmit` + `npm run lint` + `npm run build` all green before push.

---

## 10. Key files

| Purpose | Path |
|---|---|
| Read-source switch | `src/lib/feature-flags/admin-read-source.ts` |
| CH serve resolver | `src/lib/clickhouse/resolve-read.ts` |
| CH client (dormant w/o creds) | `src/lib/clickhouse/client.ts`, `env.ts` |
| Canonical cache pattern | `src/lib/queries/users-detail-cache.ts` |
| Period/scope cache pattern | `src/lib/queries/insights-rewards/_period.ts` |
| safeQuery | `src/lib/errors/safe-query.ts` |
| Customer scope / exclusions | `src/lib/metrics/scope.ts`, `src/lib/queries/_blacklist.ts` |
| DB clients | `src/lib/db.ts` (MAIN), `src/lib/admin-db.ts` (ADMIN) |
| Recommended indexes | `prisma/recommended-indexes.sql` |
| Keep-warm cron | `src/app/api/cron/warm/route.ts` + `vercel.json` |
