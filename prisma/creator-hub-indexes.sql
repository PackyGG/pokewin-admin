-- ============================================================================
-- CREATOR-HUB — recommended Postgres indexes (OWNER TO RUN on MAIN/prod game DB)
-- ============================================================================
--
-- WHY THIS FILE EXISTS
--   The /creator-hub section was audited against the PostgreSQL index rule
--   (docs/BACKEND_QUERY_SYSTEM.md). Every read is being moved onto exactly one
--   of two paths:
--     • Path 1 (indexed Postgres) — keyed / type-filtered / bounded reads.
--     • Path 2 (bounded aggregate) — the heavy multi-table fan-out aggregates
--                                    (covered-deposit DISTINCT-ON + 7d lateral,
--                                    correlated cohort subqueries). Those do NOT
--                                    need a PG index; they are served from the
--                                    bounded PostgreSQL query path.
--
--   This file contains ONLY the Path-1 indexes the EXPLAIN audit proved are
--   missing. Agents NEVER apply indexes to MAIN (it is strictly read-only) —
--   so these are listed here for the OWNER to run by hand.
--
-- HOW TO RUN (owner, on the MAIN/prod game DB):
--   Run each statement separately. CREATE INDEX CONCURRENTLY cannot run inside
--   a transaction block, so do NOT wrap these in BEGIN/COMMIT and do NOT run
--   them as a single multi-statement batch in some clients.
--
--   psql "$DATABASE_URL" -c "CREATE INDEX CONCURRENTLY ..."   (one at a time)
--
--   CONCURRENTLY keeps the table writable during the build (no app downtime).
--   Each IF NOT EXISTS makes re-runs safe.
--
-- AUDIT EVIDENCE (EXPLAIN on prod, 2026-06-17, read-only):
--   • affiliate_codes WHERE user_id = $1            → Seq Scan (no user_id index)
--   • "user" WHERE referred_by IN (...)             → Seq Scan (no referred_by index)
--   • vouchers WHERE origin = $1 AND created_at >=   → Seq Scan (no (origin,created_at) index)
--   • ledger_transactions (status,type,created_at)  → ALREADY indexed
--       (idx_ledger_tx_status_type_created_at) — creator-cost tips/leaderboard
--       and tips-sponsors ledger SUMs are already Path-1 compliant, NO new index.
-- ============================================================================


-- 1) affiliate_codes(user_id) ------------------------------------------------
--    Serves: creators/[id]/_queries/creator-metadata.ts
--            (SELECT ... FROM affiliate_codes WHERE user_id = $1 ORDER BY created_at)
--    Small table, but the keyed lookup currently seq-scans; this makes it a
--    plain index lookup (Path 1).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_affiliate_codes_user_created_at
  ON affiliate_codes (user_id, created_at DESC);


-- 2) "user"(referred_by) -----------------------------------------------------
--    Serves: _queries/hub-top-creator-meta.ts  (getWindowedSignupsByCreatorIds:
--              "user" WHERE referred_by IN (<=6 creator ids))
--            and the referred_by JOIN legs of the hub cohort / signup reads.
--    Turns the referred-cohort lookups into an index scan instead of a full
--    14.5k-row "user" seq scan. Partial index keeps it small (most rows have a
--    NULL referrer).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_referred_by
  ON "user" (referred_by)
  WHERE referred_by IS NOT NULL;


-- 3) vouchers(origin, created_at) --------------------------------------------
--    Serves: _queries/hub-dashboard-creator-cost.ts  (multiplier-payout leg:
--              vouchers WHERE origin = 'creator_multiplier_payout'
--                            AND created_at >= NOW() - INTERVAL ...)
--            and any other origin+window voucher SUM on the hub.
--    Currently a full 49.8k-row vouchers seq scan; this makes the windowed
--    origin SUM index-served (Path 1).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vouchers_origin_created_at
  ON vouchers (origin, created_at DESC);


-- 4) affiliate_code_usages(UPPER(code)) — functional index ------------------
--    Serves: creators/[id]/_queries/alt-accounts-data.ts (cohort resolution:
--              SELECT DISTINCT referred_user_id FROM affiliate_code_usages
--               WHERE UPPER(code) = ANY($1::text[]))
--    EXPLAIN (prod, 2026-06-17): Parallel Seq Scan over all 153,222 acu rows
--    (~35 MB, growing with every wager/deposit) because no index covers the
--    UPPER(code) expression. The expression index turns it into an index scan.
--    Until applied, the alt-accounts cohort resolution is BLOCKED (Path-2-less
--    seq scan on a growing MAIN table). The rest of alt-accounts is already
--    Path-1 (user_id = ANY(<bounded cohort>) index lookups).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_acu_upper_code
  ON affiliate_code_usages (UPPER(code));


-- ============================================================================
-- AUDIT OUTCOME for the creator-DETAIL reads (EXPLAIN on prod, 2026-06-17):
--   These are per-creator / per-entity scoped reads with 365d-capped lookbacks,
--   NOT global fan-out aggregates — so they stay on Path-1 (indexed Postgres),
--   PostgreSQL-only reads:
--   • getRiskData    — Index Only Scan on idx_ledger_tx_user_type_status_created_at
--                      + idx_acu_referred_user_created_at; ~561 ms for the BUSIEST
--                      creator (11,551 wager usages). Index-backed → Path-1.
--   • getCohortsData — affiliate_user_id = $1 + ledger user_id, capped lookbacks;
--                      same index-backed per-creator shape → Path-1.
--   • getAltAccountsData — user_id = ANY(<bounded cohort>) index lookups → Path-1,
--                      EXCEPT the UPPER(code) cohort resolution above (index #4).
--
-- Heavy PostgreSQL aggregates (Path 2):
--   • getHubCohortWindowed        (_queries/hub-dashboard-cohort.ts)
--   • getHubTopCreatorsByDeposits (_queries/hub-top-creators-query.ts)
--   • getTopSignupLeaders         (_queries/hub-top-creator-meta.ts)
--   • deriveBigFtdAlerts          (alerts/_queries/creator-alerts.ts)
-- These are the hot per-render dashboard fan-out aggregates (covered-deposit
-- DISTINCT-ON + 7d lateral; first-deposit-per-user over all ledger rows);
-- twinned + parity-proven (TZ=UTC, twice), dormant until the owner adds
--
-- DEFERRED — shared (admin)/creators aggregates consumed by /creator-hub but
-- OWNED by the /creators surface (a cross-section HOTSPOT; migrating them must
-- be parity- AND regression-verified on BOTH /creators and /creator-hub, so it
-- belongs to its own focused effort, not the /creator-hub pass):
--   • getAllCreatorsNetGgr     ((admin)/creators/_queries/all-creators-net-pnl.ts)
--   • getAllCreatorsLifetimePnl((admin)/creators/_queries/all-creators-lifetime-pnl.ts)
-- Both are global covering-attribution fan-outs over
-- ledger + inventory + upgrader (same shape as the cohort wager leg already
-- twinned) → Path-2 candidates. getCreatorsGlobalStats (creators-stats.ts) is
-- backend-API-served (no DB scan) and needs no migration.
-- ============================================================================
