/**
 * Cross-request cache for the two heaviest reads behind /battles —
 * the list query (`getBattles`, which fans battles → participants →
 * game_sessions → provably_fair_results → user_inventory plus a cards
 * price lookup, and on `sortBy=hit` also runs a multiplier CTE) and the
 * detail query (`getBattleDetail`, a deeply-nested per-battle include).
 *
 * On prod the ClickHouse path is dormant, so every list page / detail
 * page repays the full Postgres scan cost on each load. Memoizing the
 * existing query results keyed on the (serializable) URL params means a
 * given view's scan runs at most once per `REVALIDATE_SECONDS`; repeat
 * loads and in-segment navigation resolve from the warmed entry.
 *
 * The numbers are UNCHANGED — this only memoizes the existing query
 * outputs. Same pattern as `users-detail-cache.ts`.
 *
 * DB-env correctness (prod-only cache)
 * ────────────────────────────────────
 * `getBattles` / `getBattleDetail` each call `getDb()` internally, which
 * resolves the per-admin `admin_db_env` cookie. `unstable_cache` runs its
 * callback OUTSIDE the request's dynamic scope, so a `cookies()` read
 * inside it throws and `readDbEnv` falls back to "prod" — the cached
 * callback therefore always queries the PROD client. To avoid serving
 * prod data to a dev-toggled admin we resolve the env OUTSIDE the cache
 * and only memoize when the request is on prod (the default). A
 * dev-toggled admin bypasses the cache and runs the query directly so
 * they always see live dev data.
 */
