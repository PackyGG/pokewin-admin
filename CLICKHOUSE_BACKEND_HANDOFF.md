# ClickHouse Read-Engine Backend Migration — Agent Handoff

> **Status as of 2026-06-15.** Self-contained handoff for the next agent. Pairs with the full design at `.claude/plans/gentle-knitting-star.md`. Read `CLAUDE.md` (binding rules) + this file before touching anything.

---

## 0. TL;DR / current state

- **Goal:** CQRS rebuild — admin **reads → ClickHouse Cloud** (CDC-fed from Postgres), admin **writes → Postgres** (unchanged). Reason: dashboard sections were timing out (`Couldn't load this section`) on heavy Postgres aggregations + connection-pool starvation.
- **Hard rule:** reads→ClickHouse, writes→Postgres. ClickHouse is **read-only** from app code. No silent heavy-Postgres fallback after a surface is cut over.
- **Shipped & LIVE in prod:**
  - **Phase 0** — ClickHouse client + read-only guard + typed query helper + env + per-surface feature flag + boundary tests. (PR #57, merge `8916fb41`)
  - **Phase 1** — Dashboard **cash-flow KPIs (Deposits + Withdrawals)** ClickHouse path, wired in **`comparison` mode** (serves Postgres, logs drift). Owner enabled `ADMIN_READ_SOURCE__DASHBOARD_CASHFLOW=comparison` on Vercel prod. Parity proven 0.00 drift.
- **Shipped DORMANT on `main` (commit `07164997`):** Phase 2A read modules — `window-metrics.ts` (**parity-proven to the cent**), `trend-series.ts`, `realized-pnl.ts`. **Not wired into any surface yet** → zero behavior change until comparison hooks are added + flags flipped.
- **No surface is cut over to `clickhouse` mode yet.** Everything live is either `off` or `comparison` (still serving Postgres).

---

## 1. The architecture & the rule

```
ADMIN DASHBOARD (Next.js, server-only)
   READS  → getX() ── per-surface flag ──► comparison: run CH side-by-side, serve PG, log drift
                                          ► clickhouse: serve CH only; on CH error → cached/degraded/error (NEVER heavy PG)
                                          ► off (default): Postgres
   WRITES → getDb()/getProdDb() (game Postgres) + adminDb (admin Postgres) + creatorsApi (backend)  ── UNCHANGED
ClickHouse Cloud (packy_prod mirror) ◄── PeerDB/ClickPipes CDC ◄── Postgres (game/dev/admin), self-hosted on VPS/Coolify
```

- **Per-surface flag** (`src/lib/feature-flags/admin-read-source.ts`): `getAdminReadMode(surfaceKey)` → `"off" | "comparison" | "clickhouse"`.
  - Resolution precedence: env `ADMIN_READ_SOURCE__<SURFACE>` → Edge Config `admin-read-source:<surfaceKey>` → Edge Config `admin-read-source:__default` → `"off"`.
  - **Forced `off` whenever ClickHouse is dormant** (no `CLICKHOUSE_*` env) — so an unconfigured env is a guaranteed no-op.
  - `<SURFACE>` env-name mangling: uppercase, non-alphanumerics → `_`. e.g. surface `dashboard_cashflow` → `ADMIN_READ_SOURCE__DASHBOARD_CASHFLOW`.
- **Comparison mode = the safety net.** Build a CH module → wire an additive, fire-and-forget `compareX(...)` hook into the existing exported PG function (serve PG, log `[ch-compare]` drift) → soak in prod → only then flip to `clickhouse`.
- **Cutover criteria (owner-locked):** no persistent drift after CDC catches up · no ClickHouse errors · dashboard renders normally · **no heavy Postgres fallback** after cutover (CH failure → cached/degraded/error tile).

---

## 2. ClickHouse Cloud — connection & mirror schema

**Env vars (server-only, NEVER `NEXT_PUBLIC`, never commit values):**
```
CLICKHOUSE_URL          # https endpoint
CLICKHOUSE_USERNAME
CLICKHOUSE_PASSWORD
CLICKHOUSE_DATABASE=packy_prod
```
Set in local `.env` (owner) AND on Vercel prod (owner). Read via `src/lib/clickhouse/env.ts` (`resolveClickHouseConfig`) — dormancy-gated (returns null → flag off).

**Mirror layout (probed 2026-06-15):**
- **PROD game mirror = database `packy_prod`**, every table **prefixed `public_`** (PeerDB flattened the Postgres `public` schema). e.g. `packy_prod.public_ledger_transactions` (889k), `public_user` (14,479), `public_balances`, `public_user_inventory` (617k), `public_game_sessions` (552k), `public_battles`, `public_battle_participants`, `public_packs`, `public_vouchers`, `public_upgrader_games`, `public_card_withdrawal_requests`, `public_user_statistics`, `public_provably_fair_results` (3M), etc.
- **`default` database** = a SECOND mirror: bare-named game tables (~170 users — this is **dev/old, DO NOT use for prod numbers**) PLUS the **admin-DB mirror** (`public_admin_*`, `public_excluded_users`, `public_creator_*`, `public_salary_*`).
- **CDC tool = PeerDB / ClickPipes** (`_peerdb_raw_mirror_*` staging tables present).
- **Engine = `SharedReplacingMergeTree`**, `ORDER BY`/`PRIMARY KEY = id`, no partition key.
- **CDC metadata columns on every mirror table:**
  - `_peerdb_version` (UInt64) — version for ReplacingMergeTree dedup
  - `_peerdb_is_deleted` (UInt8) — soft-delete flag
  - `_peerdb_synced_at` (DateTime64(9)) — freshness/lag
- **Reading correctly (MANDATORY in every CH query):** `FROM packy_prod.public_X FINAL WHERE _peerdb_is_deleted = 0` (FINAL dedups latest version per id; the flag drops soft-deletes). Currently raw==deduped (no dupes yet) but REQUIRED for correctness as CDC emits updates/deletes.
- **Types:** money = `Decimal(20,2)` (parity-clean — keep as Decimal: `toString(sum(...))` in SQL → `toNumber()` in TS, **never Float**). Timestamps `DateTime64(6)` UTC. `public_user.id` = String (TEXT). `ledger.user_id` = String. `metadata` = `Nullable(String)` JSON → use `JSONExtractString(metadata,'key')` (CH analogue of PG `metadata->>'key'`). `balances.version` Int32 is the app's optimistic-lock version, **not** `_peerdb_version`.

---

## 3. Vercel / deploy info

- **Vercel project:** `packy-admin-dashboard`
- **Production branch:** `main` → **push to `main` = auto production deploy.** Live URL: **https://pokewin-admin.vercel.app**
- **Feature branches = preview deploys only.**
- **Vercel build:** `prisma generate && prisma generate --schema=prisma/admin/schema.prisma --config=prisma/admin/prisma.config.ts && next build --turbopack`. (Vercel regenerates Prisma clients fresh — so the local stale-admin-client issue in §7 does NOT affect prod.)
- **Push policy (owner, 2026-06-15):** push **directly to `main`, no PR, no approval, no asking**. After each impl + passing gate (tsc + lint + build + parity), commit + push to main immediately; report only after push (hash/files/build/parity/risks). Because main=prod, **keep unproven reads flag-gated/dormant** so a push is behavior-neutral.
- **Env vars to set on Vercel (Production scope) when enabling a surface:** the four `CLICKHOUSE_*` (above) + `ADMIN_READ_SOURCE__<SURFACE>=comparison` (then later `=clickhouse` for cutover). Redeploy after setting. Currently set: `CLICKHOUSE_*` + `ADMIN_READ_SOURCE__DASHBOARD_CASHFLOW=comparison`.
- **Flag flips with no deploy:** create + connect a Vercel **Edge Config** store (env `EDGE_CONFIG`) and set keys `admin-read-source:<surface>`. Edge Config is currently **dormant** (unset) → flags are controlled via the `ADMIN_READ_SOURCE__*` env vars (which need a redeploy). `src/lib/edge-config.ts` already graceful-degrades.
- **Watch logs:** Vercel → Logs (or `vercel logs`; CLI not installed — `npm i -g vercel`), filter `[ch-compare]` (drift lines) and `[clickhouse]` (slow/errors).
- Related: standalone `backend-monitor` Railway service surfaced at `/system/monitor` via `MONITOR_API_URL`/`MONITOR_API_TOKEN` (separate concern).

---

## 4. Key files

**ClickHouse infra (`src/lib/clickhouse/`):**
- `env.ts` — `resolveClickHouseConfig()` (dormancy-gated env read)
- `client.ts` — `getClickHouseClient()` / `isClickHouseEnabled()` — server-only singleton, `readonly=2` session setting
- `guards.ts` — `assertReadOnlySql()` — rejects writes/DDL/multi-statement (pure, unit-tested)
- `readonly-query.ts` — `clickhouseRead.query<T>({queryName, sql, params, timeoutMs})` — guard + timeout + typed JSONEachRow + logging; throws `ClickHouseUnavailableError` (dormant) / `ClickHouseQueryError`
- `comparison.ts` — `computeDrift()`, `logComparison()`, `compareDashboardCashflow()` (add `compareWindowMetrics` etc. here, append-only)
- `queries/dashboard-cashflow.ts` — **template** (Phase 1, wired+live in comparison)
- `queries/window-metrics.ts` — **Phase 2A, parity-proven, NOT wired**
- `queries/trend-series.ts`, `queries/realized-pnl.ts` — **Phase 2A, built, parity NOT verified, NOT wired**

**Feature flag:** `src/lib/feature-flags/admin-read-source.ts`

**Canonical Postgres "money source" (the twins to replicate — reuse their pure helpers/constants):**
- `src/lib/metrics/queries.ts` — `getWindowMetrics`, `getGamingLegs`, `getRewardCost`, `getDailyGamingMetrics`, `upgraderMetrics`, `sumLedgerTypes(Grouped)`
- `src/lib/metrics/ledger-sets.ts` — `WAGER_TYPES`, `GAMING_PAYOUT_TYPES`, `REWARD_PAYOUT_TYPES`, `NEUTRAL_TYPES`, `RESIDUAL_TYPES`, `ledgerTypesToSqlList` (pure, safe to import into CH modules)
- `src/lib/metrics/gaming-sql.ts` — `WAGER_LEG_FILTER`, `PAYOUT_LEG_FILTER`, `REWARD_PACK_SESSIONS` (PG-dialect; CH modules INLINE CH-dialect equivalents)
- `src/lib/metrics/formulas.ts` — `ggr`, `ngr`, `gamingPayoutTotal`, `resolveRainHouseCost`, `empiricalRtp`, `empiricalHouseEdge` (pure — import + reuse so math is byte-identical)
- `src/lib/metrics/scope.ts` — `getMetricsScope()`, `CUSTOMER_EXCLUDED_ROLES = ['admin','support','creator']`. **CRITICAL: `userScopeSql` drops creators WHOLESALE; the session-window predicate is a proven REDUNDANT no-op** → CH modules use a wholesale `role NOT IN ('admin','support','creator')` `real_users` CTE and OMIT the session-window CTE (this is what decouples reads from the backend 429-storm — see §6).
- `src/lib/balance-adjustment-categories.ts` — `countedAdjustmentSqlPredicate()`, `COUNTED_ADJUSTMENT_CATEGORY_KEYS`, `officialStreamAdjustmentSqlPredicate()`
- `src/lib/queries/dashboard.ts`, `dashboard-trend-series.ts`, `dashboard-period.ts` (cutoff helpers: `kpiWindowToCutoff`/`periodToCutoff`/`utcStartOfDay`), `ggr.ts` (`ggrWindowToMetricWindow`, `GGR_LIFETIME_LOOKBACK_DAYS=365`), `_realized-pnl.ts`, `period-window-kpis.ts`
- `src/lib/excluded-users/fetch.ts` — `getExcludedUserIds()` (blacklist; admin DB, React-cached). **CH modules take `blacklist: string[]` as a PARAMETER** — the caller/comparison hook fetches it; the CH module never imports a Postgres client.
- Scope source-of-truth & gotchas also in `.claude` memory + `ONBOARDING.md`/`AGENT_HANDOFF.md`.

**Guardrails / tests:** `eslint.config.mjs` (boundary: `src/lib/clickhouse/**` may not import `@/lib/db`/`@/lib/admin-db`/`pg`/prisma) · `scripts/__fixtures__/clickhouse-guard.test.ts` + `clickhouse-boundary.test.ts` (run `npm run test:parity` or `npx tsx --test scripts/__fixtures__/clickhouse-*.test.ts`).

---

## 5. Migration map (50 read paths — from the emergency audit)

Full detail in `.claude/plans/gentle-knitting-star.md`. Priority waves:

- **2A — failing dashboard critical path** (IN PROGRESS): `getWindowMetrics` (Platform KPIs/GGR — **module done, parity-proven**), `getGamingLegs`/`getRewardCost`/`getDailyGamingMetrics` (same module), `getDashboardTrendSeries`+FTD (Trends — **module built, unverified**), `getRealizedPnlSnapshot` (lifetime P&L — **module built, unverified**), `getDashboardCashflow` (deposits/withdrawals — **DONE, live comparison**). **KEEP on Postgres** (bounded+cached, point-lookup): P&L Today, Reward/Creator Costs Today, Chat Today, Avg P&L 7d (but ADD a `safeQuery` wrapper — currently unwrapped → can blank the KPI strip), user-count/depositor/RTP snapshots. Observability bundle ships with 2A.
- **2B — insights/analytics:** cost-breakdown, real-numbers, overview, cohorts, LTV, retention, funnel, wager-attribution, period aggregates, leaderboards, audit display hydration (admin rows stay on admin DB). Needs rollup/denormalized MVs (reuse 2A daily-metric shapes).
- **2C — heavy list pages:** Users, Transactions, Ledger, Withdrawals, Balances, Packs, Cards, Battles, Upgrader, Creators, Affiliates, XP-sales, exports. `*_mirror_v1` denormalized read models; keyset (not OFFSET) pagination.
- **2D — cleanup / keep-PG confirmations:** deposit-bonus/rakeback overviews, wager-liability, gift-cards, admin-DB-only surfaces (changelog/sessions/blacklist — **never mirror admin DB**), pure-code modules. Remove dead PG read paths after soak; enforce import boundaries.

---

## 6. Why the dashboard was failing (root cause)

The error tile (`TileErrorFallback`) fires when `safeQuery` times out (15s) or throws. The killer was **not** one slow query: `getCreatorSessionWindowsCte` (`src/lib/queries/creator-session-windows.ts`) builds a `session_windows` CTE from **per-creator backend-API HTTP calls** (measured **263× HTTP 429 + 451 timeouts**), injected into 15+ ledger queries. While it stalls, those queries **hold a Postgres pool slot** (pool `max:3`, `statement_timeout:30s`) → pool starvation → cascade of timeouts. **The CH modules omit that session-CTE entirely** (creators already dropped wholesale by role — proven equivalent by the to-the-cent parity), which is what fixes it once cut over.

---

## 7. Gotchas (will bite you)

1. **Stale generated admin Prisma client (LOCAL only).** Commit `24b6f76f` untracked `src/generated/admin-prisma` (now gitignored). A local checkout predating it keeps old files on disk, and `prisma generate` then REFUSES (`exists and is not empty but doesn't look like a generated Prisma Client`) → bare `npx tsc` shows ~280 FALSE errors in admin-DB code. **FIX:** `rm -rf src/generated/admin-prisma && npx prisma generate --schema=prisma/admin/schema.prisma --config=prisma/admin/prisma.config.ts && npx prisma generate`. Vercel (fresh clone) is unaffected.
2. **Timezone / `timestamp without time zone`.** Prod `ledger_transactions.created_at` is `timestamp WITHOUT time zone`. A windowed `created_at >= <JS Date>` param via node-pg does the implicit `timestamp`↔`timestamptz` cast in the **client process's local TZ** → a non-UTC host shifts the "today" boundary (gave 103 vs CH's correct UTC 107 locally). **Vercel runs `TZ=UTC`, so prod is correct = CH.** ALWAYS run parity harnesses with `TZ=UTC`. CH cutoffs are always UTC (`toISOString`).
3. **Shared checkout / concurrent owner session.** The owner (`motha`) runs a CONCURRENT session on this same `.git` (e.g. committed+pushed packs work `fd8c6d56` + reconciled origin's opposing packs refactor `1c9077f3` mid-stream). **Do NOT do aggressive git surgery** (rebase/cherry-pick) here — leftover sequencer state caused a tangle. To land NEW files on main: cherry-pick onto an isolated branch off `origin/main`, verify it's exactly your files, then push; never clobber the owner's unpushed commits.
4. **`unstable_cache` stringifies Dates/Decimals.** Cached payloads JSON-serialize → `Date` returns as string, money stays string. Keep CH money as strings → `toNumber()`; coerce dates `new Date(v)`.
5. **Never commit:** `.env`/secrets, `src/generated/*`, `src/lib/changelog/recent-pushes.json`, `scripts/_probe-*` / `scripts/_compare-*` (read-only probes/harnesses, intentionally uncommitted).
6. **MAIN game Postgres is read-only to the AGENT** (no migrations/DDL/ad-hoc DML). The deployed APP does perform sanctioned runtime writes (balance adj+ledger, bans, limits) via `getDb()` — that's fine; the rule constrains the agent's dev-time DB access, not the app's shipped writes.

---

## 8. Parity methodology (how each surface is verified before cutover)

Uncommitted read-only harnesses (run with `TZ=UTC node --env-file=.env scripts/<file>`):
- `_probe-clickhouse-discover.mjs` / `_probe-clickhouse-prod.mjs` — schema/engine/column discovery
- `_compare-dashboard-cashflow.mjs` — Phase 1 deposits/withdrawals PG-vs-CH (today/7d/lifetime)
- `_compare-window-metrics.mjs` — Phase 2A window-metrics PG-vs-CH legs + GGR/NGR (7d/30d/365d) — **all Δ=0.00**
- `_probe-tz.mjs` / `_probe-pgboundary.mjs` / `_probe-prisma-boundary.mts` — the TZ-boundary diagnosis (gotcha #2)

**Gate:** money to the cent (`<0.01`), counts exact. Each harness fetches the blacklist from the admin DB once and feeds the IDENTICAL scope + cutoff to both PG and CH so any drift is pure engine/CDC-lag, not a definition mismatch. The in-app `comparison` mode is the production-traffic equivalent (logs `[ch-compare]`).

---

## 9. NEXT STEPS (do these, push each to main per §3 policy)

1. **Parity-verify `trend-series.ts` + `realized-pnl.ts`** — write `_compare-trend-series.mjs` / `_compare-realized-pnl.mjs` harnesses replicating the PG twins (`dashboard-trend-series.ts` / `_realized-pnl.ts`), run `TZ=UTC`, require to-the-cent parity. Fix the CH modules until 0 drift. (Note: `realized-pnl` must replicate the `official_stream` + `remove_locked_balance` carve-outs exactly.)
2. **Wire additive `comparison` hooks** (serve PG, fire-and-forget CH, log drift — NO cutover branch) into `getWindowMetrics` (surface `dashboard_headline_ggr`), `getDashboardTrendSeries` (`dashboard_trend_series`), `getRealizedPnlSnapshot` (`dashboard_realized_pnl_lifetime`). Add `compareWindowMetrics`/`compareTrendSeries`/`compareRealizedPnl` to `comparison.ts`. Flag off = byte-identical to today.
3. **Observability bundle** (owner's explicit ask): in `src/lib/errors/safe-query.ts` + `logger.ts`, log `query name + source + duration_ms + kind + underlying error` on every failure (already partially: context+kind; ADD duration). `TileErrorFallback` → distinct timeout-vs-error copy. Wrap currently-unprotected dashboard legs (`getAvgPnl7d`, trend series, wager attribution) in `safeQuery`.
4. **Build/test gate + push each unit to main.**
5. **Cutover (owner flips flag, per §1 criteria):** `comparison` soak → `ADMIN_READ_SOURCE__<SURFACE>=clickhouse`. After cutover, CH failure must degrade (cached/error), never silent heavy PG. Rollback = flip flag back to `comparison` (no deploy if via Edge Config; redeploy if via env).
6. Then **2B → 2C → 2D** per §5.

---

## 10. Git / commit reference

- Phase 0: `f69e063c` · Phase 1: `e7dabaf0` · merged via PR #57 = `8916fb41`.
- Phase 2A modules on `main`: **`07164997`** (window-metrics/trend-series/realized-pnl, 3 new files, dormant).
- `main` HEAD also carries the owner's concurrent packs reconciliation (`fd8c6d56`).
- Deprecated branches (work already on main): `feat/clickhouse-read-engine`, `feat/clickhouse-dashboard-2a`.
- Memory (`.claude/.../memory/`): `clickhouse-read-engine-project.md`, `app-writes-game-db-runtime.md`, `push-direct-to-main-policy.md`, `stale-local-dev-db.md`, `never-touch-prod-db.md`.
