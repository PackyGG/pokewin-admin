# Sweepstakes admin — deep review findings

Date: 2026-06-13. Method: a 12-agent read-only workflow (5 review dimensions × fan-out → adversarial
verify → inventory) over the sweepstakes surfaces, then human triage. Each high/critical finding was
re-verified by an independent skeptic agent and then re-checked by hand.

## Summary

| Dimension | Result |
|---|---|
| Env-guard / prod-absence | **CLEAN** — zero unguarded reads |
| Money / wager math | 1 actionable (cent-rounding) — **fixed** |
| Finance colors (house-POV) | 1 HIGH (`Total Claimed` color) — **fixed** |
| Auth / audit / no-MAIN-write | 1 CRITICAL + 2 gate gaps — **flagged** (pre-existing, see below) |
| Perf / active-timeframe | 1 of mine (timeout) — **fixed**; 1 broad pre-existing — **flagged** |

## Fixed in this branch

1. **House-POV color (HIGH, verified).** `src/app/(admin)/rewards/rewards-overview.tsx:14` — the
   "Total Claimed" KPI (rakeback **paid out** to users = house cost) was `emerald`. Changed to `rose`
   per the house-POV rule. Committed `17e33236`.
2. **Money precision (LOW after verify).** `src/lib/queries/users-wager-progress.ts` derived figures
   (per-source contribution, requirement total, remaining, locked total) now round to the cent, so the
   breakdown adds up exactly and never shows a $0.01 float drift. `completed` was already backend-exact.
3. **Query timeout (MEDIUM, mine).** The wager-progress read now runs through `safeQueryOrNull` with
   `USER_DETAIL_QUERY_TIMEOUT_MS`, so a slow read degrades to the muted card instead of hanging the
   Account tab's Suspense.

## Flagged — NOT fixed (pre-existing, out of this PR's scope; owner decision)

These are real observations in **existing** code (not the new wager-progress work). They were verified
but deliberately not changed here because they are pre-existing, broader than this feature, and in two
cases possibly intentional. Each needs an owner call.

1. **`site_config` writes the game DB directly (flagged CRITICAL by the review).**
   `src/app/(admin)/security/actions.ts` `upsertSiteConfig`/`deleteSiteConfig` call
   `db.site_config.upsert/delete` where `db = getDb()` (the **game** DB), unlike the newer wager/reward
   configs which route through the backend API. Whether this is a violation depends on whether the
   **deployed** admin's `DATABASE_URL` is writable (the local one is read-only); if it is, this is the
   long-standing site-config editor working as intended. **Decision needed:** is direct game-DB
   `site_config` writing intended, or should it move to the backend API / admin DB like the newer
   configs? Not changed here — it's a pre-existing core feature and a refactor needs backend work.

2. **`requirePageAccess` missing on rewards/leaderboards server actions (flagged HIGH).**
   `src/app/(admin)/rewards/leaderboards/actions.ts` (9 fns) and `src/app/(admin)/rewards/actions.ts`
   (reward CRUD) call `requireAdmin()` but not `requirePageAccess(...)`, unlike `raffles/actions.ts`
   and the wager-requirement actions. **Reassessed severity: lower than HIGH** — `requireAdmin()`
   already restricts these to the admin role, and admins have unrestricted page access, so there is no
   actual non-admin bypass. The real gap is **consistency / defense-in-depth**. Recommended: add
   `await requirePageAccess("/rewards/leaderboards")` / `("/rewards")` as the first line of each, to
   match the house pattern. Mechanical but touches auth flows in files outside this feature, so left
   for a focused follow-up.

3. **`unstable_cache` env-drift across ~63 `insights-rewards` queries (flagged HIGH).** Cached
   callbacks that call `getDb()` internally can't read the `admin_db_env` cookie (it throws outside
   request scope → falls back to prod), so a **dev-toggled** admin viewing `/insights/rewards/*` sees
   **prod-cached** data. The correct reference is `src/lib/queries/users-detail-cache.ts` (reads env
   outside the cache, only caches on prod). The shared helper `insights-rewards/_cache.ts`
   (`makeCachedPair`) and `_ledger-tx-types.ts` share the pattern. **Impact is debugging-only** (the
   dev toggle is a rare admin affordance; no prod-user or money effect), but it's real and broad
   (~63 files). A fix belongs in its own PR (add env to the cache key / gate caching on prod via the
   shared helper).

4. **`getUserWagerRequirement` (existing override card) has no explicit per-page timeout (MEDIUM).**
   It relies on the backend client's 8s default + `.catch(()=>null)` (safe muted fallback). Bounded
   already; optional to wrap for log-visibility consistency. Left as-is.

## Positive confirmations (no action)

- Env-guard: `users-wager-progress.ts` column probe, the 8 security cards' try/catch→null, challenges
  via backend-API indirection, `filterLedgerTxTypesLive` for unmigrated ledger types, narrowed schema
  selects — all correctly drift-safe.
- Auth: challenges / rewards-analytics / security / users-`[id]` pages all call `requirePageAccess`;
  wager-requirement + weight + challenge + reward mutations all log `createAdminAuditEvent`.
- Perf: Account tab gates wager queries to `initialTab === "account"`; insights + challenges pages key
  Suspense on `tab:period` / `status` and don't preload hidden tabs.

## Note on the parity premise

The review's env-guard dimension was initially briefed (from an earlier discovery agent) that the
sweepstakes schema was "dev-only." Direct probing disproved that — it's present in **both** dbs (see
`dev-admin-verification.md`). The env-guards remain correct as forward-looking drift protection, and
the "zero unguarded reads" conclusion stands regardless.
