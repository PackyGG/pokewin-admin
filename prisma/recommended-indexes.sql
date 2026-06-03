-- =============================================================================
-- Recommended index migrations — MAIN GAME DB (production)
-- =============================================================================
-- Produced by the 2026-05-11 perf audit. DO NOT apply blindly. Review with
-- the DB owner first. Every CREATE statement uses CONCURRENTLY so that
-- production traffic is NOT blocked during creation — this is mandatory
-- on the live ledger / user / inventory tables.
--
-- These indexes are intended for the MAIN game DB (the one packy.gg uses).
-- They do NOT belong in `prisma/schema.prisma` until a maintenance window
-- is scheduled, because Prisma's default migration runner uses plain
-- CREATE INDEX (which takes AccessExclusiveLock). The schema can be
-- updated AFTER each index has been created concurrently, by adding the
-- matching `@@index([...])` declaration and using
-- `prisma migrate resolve --applied <migration_name>` to record it.
--
-- Each section corresponds to a hot query path identified in the audit.
-- Estimated impact ranges assume ledger_transactions of 1M+ rows.
-- Validate row counts in production before scheduling.
--
-- Apply order (suggested): #1 first (biggest dashboard impact), then #2,
-- #3, #4 in order. The rest are lower-priority follow-ups.
-- =============================================================================

-- #1 -----------------------------------------------------------------
-- ledger_transactions composite (status, type, created_at DESC)
-- ===================================================================
-- Hottest table on the entire site. Currently has ZERO indexes besides
-- PK + two unique columns. Every dashboard + analytics query that
-- aggregates by period scans the whole table.
--
-- Accelerates:
--   • src/lib/queries/dashboard.ts getPeriodAggregates() — the 36-column
--     period CTE that runs every dashboard refresh
--   • src/lib/queries/dashboard.ts daily wagers + daily deposits
--   • src/lib/queries/dashboard.ts uniqueDepositorsResult
--   • src/lib/queries/dashboard.ts avgSessionValueResult
--   • src/lib/queries/analytics.ts dailyTx CTE (PERCENTILE_CONT)
--   • src/lib/queries/analytics-revenue.ts daily revenue breakdown
--   • src/lib/queries/analytics-top.ts six leaderboards
--   • src/lib/queries/analytics-heatmap.ts hour-of-week heatmap
--   • src/lib/queries/analytics-cohorts.ts cohort retention
--   • src/lib/queries/analytics-retention.ts retention curve
--   • src/lib/queries/analytics-funnel.ts funnel activity
--   • src/lib/queries/analytics-ltv.ts creator LTV
--   • src/lib/queries/map.ts per-country aggregates
--
-- Expected impact: 50–200× speedup on period-windowed queries.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_tx_status_type_created_at
  ON ledger_transactions (status, type, created_at DESC);

-- #2 -----------------------------------------------------------------
-- ledger_transactions per-user (user_id, type, status, created_at DESC)
-- ===================================================================
-- Accelerates every per-user ledger query.
--
-- Accelerates:
--   • src/lib/queries/users-transactions.ts per-user listing
--   • src/lib/queries/users-financial.ts user PnL breakdown + history
--   • src/lib/queries/users-detail.ts per-user deposit aggregate + wager
--   • src/lib/queries/users-list.ts groupBy user_id for deposit counts
--   • src/lib/queries/creators-pnl.ts referred-user aggregates
--   • src/lib/queries/creators-codes.ts deposit-bonus subqueries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_tx_user_type_status_created_at
  ON ledger_transactions (user_id, type, status, created_at DESC);

-- #3 -----------------------------------------------------------------
-- card_withdrawal_requests (status, completed_at DESC) + (user_id, status)
-- ===================================================================
-- Zero indexes today. Hammered by the withdrawal aggregates on the
-- dashboard, realized PnL snapshot, and the withdrawals page.
--
-- Accelerates:
--   • src/lib/queries/dashboard.ts withdrawals CTE
--   • src/lib/queries/_realized-pnl.ts SUM(total_value_usd) filter
--   • src/lib/queries/analytics-withdrawals.ts per-asset breakdown
--   • src/lib/queries/users-list.ts per-user withdrawal subquery
--   • src/lib/queries/pnl.ts per-user + batch PnL
--   • src/lib/queries/withdrawals.ts /withdrawals list page
--   • src/lib/queries/creators-pnl.ts per-creator card withdrawals
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cwr_status_completed_at
  ON card_withdrawal_requests (status, completed_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cwr_user_id_status
  ON card_withdrawal_requests (user_id, status);

-- #4 -----------------------------------------------------------------
-- user_inventory partial index for the "open inventory" predicate
-- ===================================================================
-- The dashboard's "Users Total Balance" tile + realized PnL snapshot
-- both compute SUM(value_at_obtained) WHERE sold_at IS NULL AND
-- exchanged_at IS NULL — currently a seq scan over the whole table.
-- Partial index keeps the size tiny because most rows are EITHER sold
-- or exchanged. Requires `previewFeatures = ["partialIndexes"]` in
-- prisma/schema.prisma (already enabled).
--
-- Accelerates:
--   • src/lib/queries/dashboard.ts totalInventoryValue aggregate
--   • src/lib/queries/_realized-pnl.ts inventory SUM
--   • src/lib/queries/users-list.ts per-user inventory subquery
--   • src/lib/queries/pnl.ts per-user inventory
--   • src/lib/queries/users-financial.ts inventory breakdown
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_inv_open_by_user
  ON user_inventory (user_id)
  WHERE sold_at IS NULL AND exchanged_at IS NULL;

-- #5 -----------------------------------------------------------------
-- affiliate_code_usages (3 indexes)
-- ===================================================================
-- Zero indexes today. Every creator analytics query scans the full
-- table. The functional UPPER(code) index is the highest-value of the
-- three because every code-driven query uses `UPPER(code) = X`, which
-- bypasses a plain index on `code`.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_acu_affiliate_user_created_at
  ON affiliate_code_usages (affiliate_user_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_acu_referred_user_code_usage
  ON affiliate_code_usages (referred_user_id, code, usage_type);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_acu_upper_code_usage_created_at
  ON affiliate_code_usages (UPPER(code), usage_type, created_at);

-- #5b ----------------------------------------------------------------
-- affiliate_code_usages (referred_user_id, created_at DESC) — COVERAGE
-- ===================================================================
-- Added by the 2026-06-03 /creators-list P&L perf pass.
--
-- The creator coverage-attribution model ("which creator's code covered
-- user U at event time T") probes acu with
--   referred_user_id = U AND created_at <= T AND created_at >= T - 7d
--   ORDER BY created_at DESC LIMIT 1
-- This is the access pattern of:
--   • src/app/(admin)/creators/_queries/all-creators-net-pnl.ts
--     getAllCreatorsNetGgr — the covering-creator LEFT JOIN LATERAL on
--     every ledger / inventory / upgrader event row (Net Code-User GGR tile)
--   • src/app/(admin)/creators/_queries/all-creators-lifetime-pnl.ts
--     getAllCreatorsLifetimePnl — the covered_deposits DISTINCT ON LEFT
--     JOIN (Fill/Multiplier-Segment Net tile)
--   • src/lib/queries/creators-pnl.ts COVERING_CREATOR_SQL — the single-
--     creator detail page (same shape, per-creator)
--
-- #5's idx_acu_referred_user_code_usage leads with referred_user_id but
-- its SECOND column is `code`, not `created_at`, so it can satisfy the
-- equality on referred_user_id but must then scan ALL of that user's acu
-- rows to apply the created_at range + DESC ordering. This index puts
-- created_at DESC immediately after referred_user_id, turning the coverage
-- probe into a bounded index range scan (and the LATERAL's LIMIT 1 / the
-- DISTINCT ON's top-1 into an index seek). Without it, both list tiles run
-- the coverage join as a per-user seq scan of an UNINDEXED table — the
-- reason the cold (uncached) scan can exceed the tile timeout on prod-sized
-- affiliate_code_usages. The set-based rewrite + unstable_cache reduce HOW
-- OFTEN the cold scan runs (once per 5–15 min TTL) and let one pass serve
-- every creator at once, but this index is what makes that single cold pass
-- cheap rather than merely infrequent.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_acu_referred_user_created_at
  ON affiliate_code_usages (referred_user_id, created_at DESC);

-- #6 -----------------------------------------------------------------
-- battles (user_id, status, created_at DESC)
-- ===================================================================
-- Existing schema has (status, created_at) (line 213) — missing the
-- user-driven access pattern. Smaller table than ledger, so impact is
-- lower but still worthwhile.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_battles_user_id_status_created_at
  ON battles (user_id, status, created_at DESC);

-- #7 -----------------------------------------------------------------
-- provably_fair_results FK indexes (game_session_id, battle_id, inventory_item_id)
-- ===================================================================
-- All three FK columns are unindexed. Every JOIN through PF results
-- triggers a seq scan or relies on an index on the OTHER side only.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pf_game_session_id
  ON provably_fair_results (game_session_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pf_battle_id
  ON provably_fair_results (battle_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pf_inventory_item_id
  ON provably_fair_results (inventory_item_id);

-- #8 -----------------------------------------------------------------
-- game_sessions indexes
-- ===================================================================
-- Zero indexes today. game_sessions is the join hub between battles,
-- packs, ledger, and PF results.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gs_user_id_created_at
  ON game_sessions (user_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gs_game_type_created_at
  ON game_sessions (game_type, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gs_game_id
  ON game_sessions (game_id);

-- #9 -----------------------------------------------------------------
-- ledger_transactions functional index on metadata->'affiliate_code'
-- ===================================================================
-- The creators-codes.ts referrals query has a correlated subquery PER
-- OUTER ROW that filters `metadata->>'affiliate_code'` — currently a
-- full ledger scan per row. Partial+functional index makes that a
-- tiny index seek.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_tx_metadata_affiliate_code
  ON ledger_transactions ((UPPER(metadata->>'affiliate_code')))
  WHERE type = 'deposit_bonus';

-- #10 ----------------------------------------------------------------
-- user_inventory.card_id
-- ===================================================================
-- The cards.ts detail page does COUNT(*) FROM user_inventory WHERE
-- card_id = $1 — currently a seq scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_inv_card_id
  ON user_inventory (card_id);

-- #11 ----------------------------------------------------------------
-- ledger_transactions partial (user_id, created_at DESC) WHERE completed
-- ===================================================================
-- Added by the 2026-05-23 query perf pass.
--
-- getUserBalanceHistory (users-financial.ts) runs
--   SELECT DISTINCT ON (DATE(created_at)) ...
--   WHERE user_id = $1 AND status = 'completed'
--   ORDER BY DATE(created_at) ASC, created_at DESC
-- #2 above leads (user_id, TYPE, status, created_at), so with no `type`
-- predicate it can only range-scan on user_id and must then SORT to get
-- created_at / DATE(created_at) order. This partial index returns the
-- user's completed rows already in created_at order, so the DISTINCT ON
-- collapses without a sort and the status filter is satisfied by the
-- partial predicate. Stays small because it only covers completed rows.
--
-- Accelerates:
--   • src/lib/queries/users-financial.ts getUserBalanceHistory
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_tx_user_created_at_completed
  ON ledger_transactions (user_id, created_at DESC)
  WHERE status = 'completed';

-- #12 ----------------------------------------------------------------
-- ledger_transactions (created_at DESC) — unfiltered recency scan
-- ===================================================================
-- Added by the 2026-05-23 query perf pass.
--
-- getRecentActivity (dashboard.ts) pulls the newest N rows with a bare
--   ORDER BY created_at DESC LIMIT N
-- and no WHERE clause. #1 and #2 both lead with status/type/user_id, so
-- neither can serve an unfiltered global recency scan — it falls back to
-- a full scan + top-N sort. A plain (created_at DESC) index turns it into
-- an index-only top-N read. (getRecentActivity's offset is now capped, so
-- this only ever reads the first page-window of the index.)
--
-- Accelerates:
--   • src/lib/queries/dashboard.ts getRecentActivity (ledger side)
--   • any "latest N transactions" global feed
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_tx_created_at
  ON ledger_transactions (created_at DESC);

-- #13 ----------------------------------------------------------------
-- battle_participants (battle_id)
-- ===================================================================
-- Added by the 2026-05-23 query perf pass.
--
-- battle_participants has only PK + a UNIQUE on game_session_id; the
-- battle_id FK column is UNINDEXED (Postgres does not auto-index FKs).
-- The biggest-hit battle sort (battles.ts getBattles, sortBy=hit) joins
--   battles b LEFT JOIN battle_participants bp ON bp.battle_id = b.id
-- across every completed battle, forcing a seq scan / full hash of
-- battle_participants. An index on battle_id makes it a per-battle index
-- lookup. Also helps any per-battle participant fetch.
--
-- Accelerates:
--   • src/lib/queries/battles.ts getBattles biggest-hit multiplier CTE
--   • per-battle participant joins generally
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_battle_participants_battle_id
  ON battle_participants (battle_id);

-- #14 ----------------------------------------------------------------
-- provably_fair_results functional index on result_metadata->>'pack_id'
-- ===================================================================
-- Added by the 2026-05-23 query perf pass (second pass).
--
-- provably_fair_results has ONLY a PK today (the FK indexes in #7 are
-- still recommendations, not applied). Every pack-scoped analytics query
-- filters on the JSON expression `result_metadata->>'pack_id'`, which no
-- plain index can satisfy — so each one seq-scans the entire PF table
-- (one of the largest on the site). A functional B-tree on the extracted
-- text turns the WHERE into an index range scan; adding created_at as the
-- trailing key also serves the per-day GROUP BY and the date ORDER BY of
-- the games listing without a separate sort.
--
-- Accelerates (all in src/lib/queries/packs.ts):
--   • getPackStats   daily-breakdown CTE  (WHERE result_metadata->>'pack_id' = $1, GROUP BY DATE(created_at))
--   • getPackStats   borrow/sponsor breakdown (same WHERE)
--   • getPackGames   COUNT(*) total        (same WHERE)
--   • getPackGames   paginated rows        (same WHERE, ORDER BY created_at)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pf_result_metadata_pack_id_created_at
  ON provably_fair_results ((result_metadata->>'pack_id'), created_at DESC);

-- -------------------------------------------------------------------
-- ADMIN DB (separate database — apply against ADMIN_DATABASE_URL, NOT
-- the main game DB). Lower priority: admin_audit_events is a small
-- staff-action log.
-- -------------------------------------------------------------------
-- getRecentActivity (dashboard.ts) also orders admin_audit_events by
-- created_at DESC with no index on that column. Cheap to add; only worth
-- it once the audit log grows large.
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_admin_audit_created_at
--   ON admin_audit_events (created_at DESC);

-- =============================================================================
-- Verification queries (run AFTER each index creation)
-- =============================================================================
-- 1. Confirm the index exists and is `valid = true`:
--    SELECT indexname, indexdef, valid FROM pg_indexes
--      JOIN pg_class c ON c.relname = indexname
--      JOIN pg_index i ON i.indexrelid = c.oid
--    WHERE schemaname = 'public' AND indexname LIKE 'idx_%';
--
-- 2. Confirm a sample query uses it via EXPLAIN ANALYZE:
--    EXPLAIN ANALYZE
--    SELECT type, status, created_at FROM ledger_transactions
--    WHERE status = 'completed' AND type = 'deposit'
--      AND created_at >= NOW() - INTERVAL '24 hours'
--    LIMIT 100;
--
-- 3. Check row counts before creating any index — if a table is small
--    (< 10k rows) the index overhead may not be worth it:
--    SELECT relname, n_live_tup FROM pg_stat_user_tables
--    WHERE relname IN ('ledger_transactions', 'card_withdrawal_requests',
--                      'user_inventory', 'affiliate_code_usages',
--                      'battles', 'provably_fair_results', 'game_sessions');
