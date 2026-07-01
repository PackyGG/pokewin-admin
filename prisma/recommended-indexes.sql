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
  WHERE sold_at IS NULL AND exchanged_at IS NULL AND withdrawal_locked_at IS NULL;

-- #4b ----------------------------------------------------------------
-- vouchers partial index for unclaimed balance aggregates
-- ===================================================================
-- users-list ranking (netHoldings), pnl batch, and dashboard liability
-- tiles all SUM(v.value) WHERE claimed_at IS NULL grouped by user_id.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vouchers_unclaimed_by_user
  ON vouchers (user_id)
  WHERE claimed_at IS NULL;

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
-- Added by the 2026-06-03 creator P&L perf pass (list + detail).
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
--     creator detail page Affiliates P&L scan (same shape, per-creator;
--     evaluated in the 30-day window block AND the 365-day lifetime block)
--
-- #5's idx_acu_referred_user_code_usage leads with referred_user_id but
-- its SECOND column is `code`, not `created_at`, so it can satisfy the
-- equality on referred_user_id but must then scan ALL of that user's acu
-- rows to apply the created_at range + DESC ordering. This index puts
-- created_at DESC immediately after referred_user_id, turning the coverage
-- probe into a bounded index range scan (and the LATERAL's LIMIT 1 / the
-- DISTINCT ON's top-1 into an index seek). Without it, both list tiles AND
-- the per-creator detail panel run the coverage join as a per-user seq scan
-- of an UNINDEXED table — the reason the cold (uncached) scan can exceed the
-- tile / panel timeout on prod-sized affiliate_code_usages. The set-based
-- rewrites + unstable_cache reduce HOW OFTEN the cold scan runs (once per
-- 5–15 min TTL) and, for the list, let one pass serve every creator at once,
-- but this index is what makes that single cold pass cheap rather than
-- merely infrequent.
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

-- #15 ----------------------------------------------------------------
-- /users page SEARCH — prefix (text_pattern_ops) + substring (pg_trgm)
-- ===================================================================
-- Added by the 2026-06-05 /users search perf pass.
--
-- The /users search (src/lib/queries/users-list.ts) used to OR four
-- `ILIKE '%term%'` predicates across username / display_username / name
-- / email on every keystroke. A LEADING `%` is not sargable, so each
-- keystroke was a FULL sequential scan of the whole `user` table
-- (~7,800 rows and growing). The query was rewritten to PREFIX matching
-- by default — `LOWER(col) LIKE lower('term') || '%'` (raw-SQL ranking
-- path) / Prisma `startsWith` + `mode:"insensitive"` (list path) — which
-- IS sargable. But a default-collation btree (incl. the existing
-- user_username_unique / user_email_unique uniques) does NOT serve
-- `LIKE 'x%'`; Postgres needs an index built with the *_pattern_ops
-- operator class (or a `C`-collation index). These functional
-- lower(col) text_pattern_ops indexes are what turn the new default
-- prefix search into an index RANGE scan instead of a seq scan.
--
-- WITHOUT these, prefix search still works and is already much cheaper
-- than the old `%term%` (Postgres can short-circuit a left-anchored
-- compare per row), but it remains a seq scan. WITH them it is a true
-- index range scan — the "feels instant" target.
--
-- Match the indexed expression to the query EXACTLY: lower(col) with
-- text_pattern_ops. (username/email are also UNIQUE, but those uniques
-- are plain btrees on the raw value and cannot serve a lowered LIKE.)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_lower_username_prefix
  ON "user" (LOWER(username) text_pattern_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_lower_email_prefix
  ON "user" (LOWER(email) text_pattern_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_lower_name_prefix
  ON "user" (LOWER(name) text_pattern_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_lower_display_username_prefix
  ON "user" (LOWER(display_username) text_pattern_ops);

-- pg_trgm GIN indexes back the OPT-IN substring search (`?match=contains`
-- → `LOWER(col) LIKE '%term%'`), the one case prefix matching cannot
-- cover. A trigram GIN index is the only thing that makes a
-- leading-wildcard `%term%` an index scan. Requires the pg_trgm
-- extension (one-time, superuser):
--   CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- Built on lower(col) so the case-insensitive `%term%` is sargable.
-- gin_trgm_ops handles both LIKE '%x%' and ILIKE.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_lower_username_trgm
  ON "user" USING gin (LOWER(username) gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_lower_name_trgm
  ON "user" USING gin (LOWER(name) gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_lower_display_username_trgm
  ON "user" USING gin (LOWER(display_username) gin_trgm_ops);

-- #16 ----------------------------------------------------------------
-- user (role, status) — the /users ranking WHERE filter
-- ===================================================================
-- Added by the 2026-06-05 /users search perf pass.
--
-- The computed-sort ranking (computeRankedUserIds) now applies the
-- search/role/status WHERE FIRST in a `filtered` CTE before joining the
-- per-user aggregates (filter → hydrate). The role / status filters
-- (u.role = X, u.is_banned / u.is_locked) drive that CTE; today they
-- have no supporting index, so a role-only or status-only filter scans
-- the whole user table to build the candidate set. `status` in the UI is
-- derived from the two booleans is_banned / is_locked, so the composite
-- covers all three toolbar filter combinations (role, role+status,
-- status). The PK already covers the search-by-id leg and the prefix
-- indexes (#15) cover search-by-handle, so this completes index coverage
-- for the filter-first candidate stage.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_role_banned_locked
  ON "user" (role, is_banned, is_locked);

-- #17 ----------------------------------------------------------------
-- /crm Player-CRM snapshot — NO new index recommended (documented finding)
-- ===================================================================
-- Added by the 2026-06-17 Index-or-ClickHouse compliance pass for
-- src/lib/queries/crm.ts (computeCrmRowsPg).
--
-- The CRM snapshot is a 365-day, cross-customer per-user aggregate over
-- ledger_transactions (deposits / withdrawals / wager / gaming-payout) +
-- user_inventory (pack/battle payout) + upgrader_games, joined to "user".
-- EXPLAIN ANALYZE on prod (2026-06-17): Planning 21ms, Execution ~1.45s.
--
-- Every leg is a PARALLEL SEQ SCAN — and that is the planner's OPTIMAL
-- choice, NOT a missing index:
--   • ledger_transactions: index #1 (status, type, created_at DESC) EXISTS,
--     but a 365-day window matches too large a fraction of the table, so the
--     planner correctly rejects the index for a parallel seq scan (a narrow
--     window WOULD use #1 — verified on the dashboard period legs).
--   • user_inventory: source_type IN ('pack','battle') + obtained_at >= 365d
--     is likewise low-selectivity over a lifetime window — a
--     (source_type, obtained_at) index would not be chosen and is NOT added.
--   • "user" role NOT IN ('admin','support','creator') is ~all rows (low
--     selectivity) → seq scan optimal; #16 does not help a NOT IN.
--   • non_borrow_battle_sessions is a FULL non-borrow scan (no date bound) by
--     design → inherently a scan.
--
-- Compliance posture (Index-or-ClickHouse): this read is NOT index-fixable;
-- it is served from indexed Postgres behind (a) shell-first <Suspense>
-- streaming so it never blocks first paint, (b) a 300s unstable_cache so the
-- ~1.45s cold aggregate runs at most once per 5 min, and (c) a safeQuery
-- timeout. The cent/count-exact ClickHouse twin
-- (src/lib/clickhouse/queries/crm.ts, surface `crm_snapshot`) is wired via
-- resolveAdminRead and parity-proven (TZ=UTC, run twice: 3387/3387 users,
-- every total Δ=0.00) — it stays dormant until ClickHouse creds + an
-- explicit Edge-Config/cutover flip, then offloads this scan to the columnar
-- mirror. Same reasoning as the `dashboard_stats` note in
-- src/lib/feature-flags/admin-read-source.ts.

-- #18 ----------------------------------------------------------------
-- user_inventory partial index for the 2-NULL "owned" predicate
-- ===================================================================
-- Added by the 2026-06-17 Speed-Insights perf pass (top route /users/[id],
-- the #1-traffic page).
--
-- #4 (idx_user_inv_open_by_user) is a partial index whose predicate is
-- (sold_at IS NULL AND exchanged_at IS NULL AND withdrawal_locked_at IS NULL)
-- — THREE nulls. Postgres can only use a partial index when the query's
-- WHERE *implies* the index predicate, so a query that filters on only the
-- first TWO nulls (sold_at IS NULL AND exchanged_at IS NULL, WITHOUT the
-- withdrawal_locked_at clause) CANNOT use #4 and falls back to a parallel
-- seq scan of the whole table (~636k rows on prod, EXPLAIN cost ≈ 19,939).
--
-- Two hot per-user reads on /users/[id] use exactly that 2-null predicate
-- and therefore seq-scan on essentially every (per-user-cold) load:
--   • src/lib/queries/users-detail.ts  getUserDetail → inventoryCount
--       db.user_inventory.count({ where:{ user_id, sold_at:null, exchanged_at:null } })
--     (AWAITED in the streamed body gate → directly gates the body's LCP)
--   • src/lib/queries/users-financial.ts getUserPnlBreakdown → inventoryValue
--       db.user_inventory.aggregate({ where:{ user_id, sold_at:null, exchanged_at:null }, _sum:{ value_at_obtained } })
--
-- These two intentionally include withdrawal-locked items (the header count
-- and getUserPnlBreakdown's unrealized-liability lens both count a card that
-- is locked for an in-flight withdrawal as still-held), so they deliberately
-- do NOT carry the withdrawal_locked_at clause that calculateUserPnl uses.
-- That means the fix is an INDEX, not a query change — changing the query to
-- add the 3rd null would alter a displayed count / P&L number.
--
-- EXPLAIN against prod (2026-06-17, read-only, no ANALYZE):
--   2-null predicate, no index  → Parallel Seq Scan, cost 0..18,939 (636k rows)
--   same query once this exists  → Index Scan, cost ≈ 12   (≈1,600× cheaper)
--
-- Partial, so it stays tiny (only not-sold-and-not-exchanged rows ≈ 13k).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_inv_owned_by_user
  ON user_inventory (user_id)
  WHERE sold_at IS NULL AND exchanged_at IS NULL;

-- #19 ----------------------------------------------------------------
-- ledger_transactions (user_id, created_at DESC) — NON-PARTIAL, all statuses
-- ===================================================================
-- Added by the 2026-06-21 /users/[id] transaction-feed perf pass (top-traffic
-- page). HIGH PRIORITY — directly fixes the "Gaming / Deposits transactions
-- take ages" complaint for high-activity users.
--
-- The per-user transaction listings (src/lib/queries/users-transactions.ts
-- getUserTransactions) run, for the Gaming / Finances / Overview tabs:
--   SELECT * FROM ledger_transactions
--   WHERE user_id = $1 AND type = ANY($2::ledger_transaction_type[])
--   ORDER BY created_at DESC LIMIT n      -- NO status predicate
-- (and a user_id-only variant for the unfiltered feed).
--
-- None of the EXISTING ledger indexes serve this:
--   • #2  (user_id, type, status, created_at DESC) — orders by
--     (type, status, created_at) WITHIN a user, so with type = ANY(4-6 vals)
--     and ORDER BY created_at DESC the planner would have to gather + sort all
--     matching rows; it estimates that as costlier than the global scan and
--     skips it.
--   • #11 (user_id, created_at DESC) WHERE status='completed' — PARTIAL, so it
--     can only be used when the query pins status='completed'. These listings
--     intentionally have NO status filter (they MUST show pending/failed rows,
--     e.g. a pending withdrawal), so the partial index is not usable.
--   • #12 (created_at DESC) — the global recency index. With a small LIMIT the
--     planner PICKS THIS, then filters out every other user's rows.
--
-- EXPLAIN (ANALYZE, BUFFERS) against MAIN (read-only, 2026-06-21) for the
-- highest-activity user (14,938 ledger rows; 14,937 completed, 1 failed):
--   Gaming page-1 (current, no status, native enum):
--     Index Scan using idx_ledger_tx_created_at
--     Rows Removed by Filter: 187,424   Buffers: ~75k   Execution: 66 ms
--   Finances page-1 (current):
--     Index Scan using idx_ledger_tx_created_at
--     Rows Removed by Filter: 188,228   Buffers: ~75k   Execution: 40 ms
--   PROOF the (user_id, created_at DESC) SHAPE is the right one — the SAME
--   queries WITH status='completed' (so the partial #11 becomes usable):
--     Gaming page-1:  Index Scan using idx_ledger_tx_user_created_at_completed
--                     Rows Removed by Filter: 1,231   Buffers: 598   Execution: 1.1 ms
--     user_id-only:   Index Scan using idx_ledger_tx_user_created_at_completed
--                     Buffers: 8   Execution: 0.04 ms
--
-- A NON-partial (user_id, created_at DESC) gives that same ~60-470x win to the
-- real (no-status) listings: the planner walks ONLY this user's rows already in
-- created_at order, filters type inline, and stops at LIMIT — instead of
-- scanning ~187k newer rows from OTHER users. Warm it is the difference between
-- 66 ms and ~1 ms; cold + under the MAIN max:3 pool with several /users/[id]
-- tabs open it is the difference between "loads" and "takes ages / times out".
--
-- The Gaming first page is ALSO prod-only cached (15s) so repeat/auto-refresh
-- loads skip the enrichment fan-out, but the index is what makes the cold
-- first load cheap rather than merely infrequent.
--
-- APPLIED (2026-06-21, valid) — owner applied this index; re-verified
-- read-only against prod (same highest-activity user): all three real
-- listings now run `Index Scan using idx_ledger_tx_user_created_at`:
--   Gaming page-1 (no status):  Rows Removed by Filter: 64    Buffers: 53   Execution: 0.46 ms
--   Finances page-1 (no status):Rows Removed by Filter: 1,583 Buffers: 831  Execution: 2.0 ms
--   user_id-only page-1:        Buffers: 8                    Execution: 0.06 ms
-- (was 66 / 40 / 18.9 ms with ~75k/75k/31k buffers and 187k/188k rows filtered.)
--
-- Accelerates:
--   • src/lib/queries/users-transactions.ts getUserTransactions (every tab)
--   • the fetchUserTransactions server action (pagination / filtering / load-more)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_tx_user_created_at
  ON ledger_transactions (user_id, created_at DESC);

-- ===================================================================
-- FINDING (2026-06-22, read-only EXPLAIN sweep) — getUserDetail aggregate:
-- NO MISSING INDEX. Documented here so a future pass doesn't re-investigate.
-- ===================================================================
-- Profiled every heavy leg of getUserDetail + calculateUserPnl + getUserTips
-- against MAIN (read-only) for the highest-activity user (14,938 ledger rows).
-- ALL legs already hit an index and run sub-millisecond — there is nothing to
-- add an index for:
--   • user_inventory count (user_id, sold_at IS NULL, exchanged_at IS NULL)
--       → Index Only Scan idx_user_inv_owned_by_user           0.045 ms
--   • user_inventory P&L (3-null + role<>'creator' semijoin)
--       → Bitmap idx_user_inv_open_by_user + user_pkey semijoin 0.40 ms
--   • vouchers unclaimed (user_id, claimed_at IS NULL)
--       → Index Scan idx_vouchers_unclaimed_by_user            0.12 ms
--   • card_withdrawal_requests aggregate (user_id, status IN …)
--       → Bitmap idx_cwr_user_id_status                        0.40 ms
--   • affiliate live aggregate (UPPER(code) IN owned-codes)
--       → Index Scans idx_acu_upper_code + idx_affiliate_codes_user_created_at  0.34 ms
--   • creator_tip feed (user_id, type, ORDER BY created_at DESC)
--       → Bitmap idx_ledger_tx_user_type_status_created_at      0.57 ms
-- CONCLUSION: the aggregate's perceived "slow first load" is NOT a query/index
-- problem — it is the COUNT of round-trips (~34 tiny queries across the three
-- helpers) funnelled through the MAIN max:3 connection pool on a cold cache.
-- The 25s detail cache (getUserDetailCached) absorbs this on repeat loads. The
-- only remaining lever is a MEASURED pool-size increase (db.ts max:3) — an
-- owner decision, deliberately NOT changed here. Adding any further index
-- would be cargo-culting; these legs are already optimal.

-- -------------------------------------------------------------------
-- ADMIN DB (separate database — apply against ADMIN_DATABASE_URL, NOT
-- the main game DB).
-- -------------------------------------------------------------------
-- A1 ----------------------------------------------------------------
-- admin_audit_events single-column indexes
-- ===================================================================
-- LANDED 2026-06-03 via migration 20260603000000_admin_audit_events_indexes.
-- Kept here as documentation for the audit / cost-of-each-index trail.
--
-- Existing composites (from 20260429100000_perf_indexes):
--   • (admin_user_id, created_at DESC)
--   • (event_type, created_at DESC)
-- Neither satisfies a bare unfiltered ORDER BY created_at DESC scan
-- (no leading filter), nor any access by target_user_id (totally
-- uncovered before this migration).
--
-- The /audit viewer (src/lib/queries/audit.ts getAuditEvents) orders by
-- created_at DESC and filters by event_type / admin_user_id /
-- target_user_id from the toolbar; the /audit Event Types KPI runs a
-- groupBy on event_type. Each of these indexes serves at least one of
-- those access patterns when its leading key isn't covered by a
-- composite.
CREATE INDEX CONCURRENTLY IF NOT EXISTS admin_audit_events_created_at_idx
  ON admin_audit_events (created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS admin_audit_events_event_type_idx
  ON admin_audit_events (event_type);

CREATE INDEX CONCURRENTLY IF NOT EXISTS admin_audit_events_admin_user_id_idx
  ON admin_audit_events (admin_user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS admin_audit_events_target_user_id_idx
  ON admin_audit_events (target_user_id);

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
--    For the /users PREFIX search (#15), confirm an index range scan
--    (not Seq Scan) — note the literal must be lower-cased to match the
--    lower(col) index, exactly as the app sends it:
--    EXPLAIN ANALYZE
--    SELECT id FROM "user" WHERE LOWER(username) LIKE 'jo' || '%' LIMIT 20;
--
--    For the OPT-IN substring search, confirm the pg_trgm GIN index is
--    used (Bitmap Index Scan on idx_user_lower_username_trgm):
--    EXPLAIN ANALYZE
--    SELECT id FROM "user" WHERE LOWER(username) LIKE '%' || 'oh' || '%' LIMIT 20;
--
-- 3. Check row counts before creating any index — if a table is small
--    (< 10k rows) the index overhead may not be worth it. (The `user`
--    table is ~7,800 rows today, so the search indexes (#15/#16) help
--    most as it grows; on a table this small a seq scan is fast but the
--    prefix index still removes per-keystroke CPU. The big wins remain
--    the multi-million-row ledger / inventory aggregates above.):
--    SELECT relname, n_live_tup FROM pg_stat_user_tables
--    WHERE relname IN ('ledger_transactions', 'card_withdrawal_requests',
--                      'user_inventory', 'affiliate_code_usages',
--                      'battles', 'provably_fair_results', 'game_sessions',
--                      'user');

-- =============================================================================
-- pack_cards floor subquery (getPacksPoolComposition extension) — NO NEW INDEX NEEDED
-- =============================================================================
-- src/lib/queries/packs.ts getPacksPoolComposition was extended (additively)
-- with weightedSqSum, winWeight, nearMissWeight, maxValue, and a correlated
-- floorValue subquery:
--   SELECT c2.price FROM pack_cards pc2 JOIN cards c2 ON c2.id = pc2.card_id
--   WHERE pc2.pack_id = p.id ORDER BY pc2.weight DESC, c2.price ASC LIMIT 1
--
-- EXPLAIN (ANALYZE, BUFFERS) against MAIN (read-only, 2026-06-21) for the
-- in-scope set (active official packs, price > 0; 183 packs, 2343 pack_cards
-- rows, 50920 cards) shows the floor subquery is ALREADY index-served — it is
-- NOT a seq scan on pack_cards:
--
--   SubPlan 1 -> Limit (cost=110.31..110.31 rows=1)
--     -> Sort (Sort Key: pc2.weight DESC, c2.price)  [top-N heapsort, 10 rows]
--       -> Nested Loop
--         -> Bitmap Heap Scan on pack_cards pc2
--              Recheck Cond: (pack_id = p.id)
--           -> Bitmap Index Scan on pack_cards_pack_id_card_id_unique
--                Index Cond: (pack_id = p.id)        <-- leading key of the
--                                                        existing composite
--                                                        unique index serves
--                                                        the per-pack lookup
--         -> Index Scan using cards_pkey on cards c2 (Index Cond: id = pc2.card_id)
--
-- Whole extended query Execution Time: ~37 ms. The main GROUP BY join still
-- seq-scans pack_cards/cards (the pre-existing, unchanged LEFT-JOIN behaviour
-- of the original query over the full small pool), which is optimal at this
-- size — the planner reads the entire ~2.3k-row pack_cards table once anyway.
--
-- A dedicated CREATE INDEX CONCURRENTLY idx_pack_cards_pack_id_weight
--   ON pack_cards (pack_id, weight DESC)
-- would only let the floor subquery skip the ~10-row top-N heapsort per pack;
-- with ~10 cards/pack across 183 packs that saves nothing measurable, and the
-- existing (pack_id, card_id) unique index already covers the pack_id lookup.
-- => No new index recommended. Re-evaluate only if pack_cards grows by orders
--    of magnitude (e.g. > ~500k rows) or packs-per-scan rises sharply.

-- =============================================================================
-- provably_fair_results.result_metadata card-id reference check
--   (card-delete safety hardening — src/app/(admin)/cards/actions.ts)
-- =============================================================================
-- checkCardReferences() must answer "is this card id referenced inside any
-- provably_fair_results.result_metadata JSON blob" before a card may be
-- deleted. A card id can appear there two ways:
--   - top level   result_metadata->>'card_id'         (pack/battle rolls)
--   - nested      result_metadata->>'target_card_id'  (upgrader rolls)
--
-- EXPLAIN (ANALYZE, BUFFERS) against MAIN (read-only, 2026-06-21) on the
-- combined single-pass query the action runs (one scan for the whole candidate
-- id set, NOT one per id) shows a full Parallel Seq Scan over the whole table:
--
--   provably_fair_results rows: 3,367,535 with metadata
--   ->  Parallel Append
--         Parallel Seq Scan on provably_fair_results
--           Filter: (result_metadata ->> 'card_id') = ANY (...ids...)
--           Rows Removed by Filter: ~1.12M  Buffers: read=356,730
--         Parallel Seq Scan on provably_fair_results
--           Filter: (result_metadata ->> 'target_card_id') = ANY (...ids...)
--           Rows Removed by Filter: ~1.68M  Buffers: read=356,918
--   Execution Time: ~1.0–1.1 s  (per bulk-delete call, regardless of id count)
--
-- The only existing expression index on this column is for pack_id
-- (idx_pf_result_metadata_pack_id_created_at) — nothing serves card_id /
-- target_card_id. The action keeps a SINGLE bounded scan per delete (it never
-- issues a per-id query), so this is one ~1s read at the moment an admin
-- confirms a delete — acceptable but not ideal on a 3.4M-row prod table.
--
-- APPLIED (2026-06-21, valid) — a jsonb_path_ops GIN index lets the containment
-- form (result_metadata @> '{"card_id":"…"}') become an index lookup:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pf_result_metadata_gin
--     ON provably_fair_results USING gin (result_metadata jsonb_path_ops);
--
-- jsonb_path_ops is the smaller/faster GIN opclass and supports @> containment,
-- which covers BOTH the top-level card_id and the nested target_card_id lookups
-- (each issued as one @> probe per id). The owner applied this index (2026-06-21,
-- valid) and `checkCardReferences()` now issues the `@>` containment form, so the
-- card-delete reference check is served by this GIN (Bitmap Index Scan) instead
-- of the ~1s Parallel Seq Scan documented above (kept here as historical context
-- for why the index exists). The action still degrades gracefully if the index is
-- ever dropped (single scan, admin-gated, one-shot).

-- #20 ----------------------------------------------------------------
-- balances.locked_balance — /users list "Top vault / locked" sort
-- ===================================================================
-- Added by the 2026-06-30 vault-features pass for the new
-- `sortBy=lockedBalance` shortcut on /users (see SortByLockedBalanceButton
-- + computeRankedUserIds → buildRankingOrderExpr branch).
--
-- The ranking CTE filter-firsts the `user` table into `filtered` (a few
-- hundred to a few thousand ids), LEFT JOINs `balances`, and ORDER BYs
-- `COALESCE(b.locked_balance::numeric, 0) DESC NULLS LAST` before LIMIT/
-- OFFSET. The LEFT JOIN itself is served by the existing
-- `balances_user_id_unique` constraint, so the join is index-served per
-- row — no extra index is needed for the JOIN.
--
-- A partial index on locked_balance (WHERE locked_balance > 0) would
-- accelerate the ORDER BY IF we ever moved this sort to a global scan
-- instead of the filter-first CTE shape. Today the filter-first shape
-- keeps the rows-to-sort tiny (≤ candidate cohort), so locked_balance
-- ordering is essentially free; flagging the partial index here so the
-- owner can apply it later if the user base grows past ~50k actives:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_balances_locked_balance_nz
--     ON balances (locked_balance DESC) WHERE locked_balance > 0;
--
-- NOT APPLIED — flagged only. At today's prod size (~761 users,
-- 2026-06-11) the filter-first CTE measures ~11 ms; this index would
-- shave milliseconds and is not worth the write-amplification on the hot
-- `balances` table. Reassess if /users grows past ~50k or the cold
-- "Top vault / locked" click becomes user-visible slow.

-- #21 ----------------------------------------------------------------
-- affiliate_codes.code — /insights/affiliate-codes code-PREFIX search
-- ===================================================================
-- Added by the 2026-06-30 Affiliate Codes page. The page's primary code
-- lookup is EXACT (`code = $1`), which already hits the existing
-- `affiliate_codes_code_unique` btree (Index Scan, EXPLAIN-proven). But a
-- code PREFIX search (`code LIKE 'ABC%'`) CANNOT use that default-collation
-- index — EXPLAIN shows a Seq Scan. Per the Index-or-ClickHouse rule the
-- prefix path is therefore DISABLED in code today
-- (`CODE_PREFIX_INDEX_APPLIED = false` in
-- src/lib/queries/affiliate-codes-lookup.ts); only exact-code + owner
-- (username/email exact + username prefix, all already indexed) ship.
--
-- To enable code-prefix search, create a text_pattern_ops btree (the same
-- shape `idx_user_lower_username_prefix` uses for username prefix), then
-- flip CODE_PREFIX_INDEX_APPLIED to true:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_affiliate_codes_code_prefix
--     ON affiliate_codes (code text_pattern_ops);
--
-- NOT APPLIED — flagged only. At today's prod size (~1,006 affiliate_codes
-- rows, 2026-06-30) a Seq Scan for prefix is sub-millisecond, so this is
-- low priority; it is flagged to keep the page strictly index-served and
-- to let the prefix feature turn on cleanly once the table grows.

-- #22 ----------------------------------------------------------------
-- battle_double_down_offers.created_at — /insights/double-down windowed
-- aggregate + audit log ORDER BY, and the per-user history time-sort
-- ===================================================================
-- Added by the 2026-06-30 Double Down tracking pages. The tables live ONLY
-- on the live prod game DB (the local schema is stale; reads are hand-written
-- read-only SELECTs via getDb()). EXPLAIN against prod (read-only) shows:
--   • the per-user lookup `WHERE user_id = $1 ORDER BY created_at DESC`
--     → Bitmap Index Scan on idx_battle_double_down_offers_user_status
--       (the existing (user_id,status) index) — already INDEXED. ✓
--   • the GLOBAL windowed aggregate `WHERE created_at >= $1` and the audit
--     log `WHERE created_at >= $1 ORDER BY created_at DESC LIMIT/OFFSET`
--     → Seq Scan + Sort. There is NO created_at index on the table
--       (PK(id) · UNIQUE(battle_id,user_id) · (status,expires_at) ·
--        (user_id,status) only).
--
-- At today's prod size (~14 rows, 2026-06-30 — the feature is brand new) the
-- planner correctly chooses a Seq Scan and the page is instant; the global
-- reads are ALSO cached (unstable_cache, period-keyed) + timeout-wrapped and
-- the lifetime window is bounded (365d), so no unbounded scan ships. Per the
-- Index-or-ClickHouse rule the missing index is flagged so the global
-- window/log stays index-served as the table grows:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bdd_offers_created_at
--     ON battle_double_down_offers (created_at DESC);
--
--   -- optional, narrows the status-filtered window/log variants:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bdd_offers_status_created_at
--     ON battle_double_down_offers (status, created_at DESC);
--
-- NOT APPLIED — flagged only (MAIN is strictly read-only; agents never apply
-- indexes). Apply the created_at index once the table grows past a few
-- thousand rows so the windowed aggregate + audit-log ORDER BY stop
-- seq-scanning under real volume.
--
-- DASHBOARD game-type aggregate (DEV's canonical method, added 2026-06-30):
-- `game_sessions WHERE game_type='battle_double_down' JOIN game_id → offers`.
-- EXPLAIN (read-only) shows the planner correctly drives from the TINY
-- battle_double_down_offers table (Seq Scan, dozens of rows) and probes the
-- ~653k-row game_sessions via the existing `idx_gs_game_id` (Index Scan on
-- game_id) — so the LARGE table is already index-served and NO
-- game_sessions(game_type) index is required at this shape. Reassess only if
-- battle_double_down_offers grows large enough that filtering game_sessions by
-- game_type FIRST becomes the better plan; in that case flag:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gs_game_type
--     ON game_sessions (game_type);
-- (NOT recommended yet — a low-cardinality game_type index on a 653k hot table
-- is write-amplifying and the current offers-driven plan is optimal.)

-- =============================================================================
-- #23+ — 2026-07-01 full-audit sweep (parallel per-surface EXPLAIN findings)
-- MAIN is read-only; agents NEVER apply — owner applies these CONCURRENTLY.
-- Each was read-only EXPLAIN-verified as a seq-scan on the current prod DB
-- unless noted. Reads are cache+timeout+safeQuery protected in the meantime.
-- =============================================================================

-- #23 cards list — set_id/created_at (50.5k-row cards table seq-scans on the
-- list order-by + per-set count + rarity groupBy; only PK/tcgplayer/card_number
-- /type indexes exist). Also serves /cards?set=<uuid> filtering.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cards_set_id_created_at
  ON cards (set_id, created_at DESC);

-- #24 deposits list — partial on type='deposit' (getDepositTransactions scans
-- ~855k-1.08M ledger rows via idx_ledger_tx_created_at filtering type inline;
-- #1 leads with status so cannot serve `type='deposit' ORDER BY created_at`).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_tx_deposit_created_at
  ON ledger_transactions (created_at DESC)
  WHERE type = 'deposit';

-- #25 transaction detail fan-out (getTransactionDetail) — three FK legs seq-scan:
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_tx_game_session_id
  ON ledger_transactions (game_session_id);     -- related-tx leg
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vouchers_origin_id
  ON vouchers (origin_id);                       -- session-voucher leg
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_game_sessions_bet_ledger_tx_id
  ON game_sessions (bet_ledger_tx_id);           -- upgrader canonical-session leg

-- #26 rain tips — rain_id FK is unindexed (Postgres doesn't auto-index FKs);
-- getRainTips does WHERE rain_id = $1 → seq-scan as rain_tips grows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS rain_tips_rain_id_idx
  ON rain_tips (rain_id);

-- #27 insights-rewards daily-packs giveaway — the reward-cost join drives a full
-- user_inventory scan filtered on obtained_at >= now()-365d; an obtained_at index
-- bounds it to a range scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_inventory_obtained_at
  ON user_inventory (obtained_at);

-- #28 creators-analytics PG-degradation fallback (computeAffiliateAnalytics
-- signup/usage/daily legs) filter/group affiliate_code_usages by referred_user_id
-- / created_at, but the only relevant index leads with affiliate_user_id → seq-scan.
-- (Only bites when ClickHouse is down and the surface degrades to Postgres.)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_affiliate_code_usages_referred_created
  ON affiliate_code_usages (referred_user_id, created_at);

-- #29 (LOWER PRIORITY) insights-rewards 365d-capped reward sweeps
-- (stacking/top-recipients/geo-source/retention-lift) filter ledger_transactions
-- by type + created_at without a status predicate; #1 leads with status. A
-- (type, created_at) composite would help, but the 365d cap already bounds these
-- and they are cached — evaluate only if they become user-visible slow.
--   CREATE INDEX CONCURRENTLY idx_ledger_tx_type_created_at
--     ON ledger_transactions (type, created_at DESC);

-- NOTE (2026-07-01): idx_pf_result_metadata_pack_id_created_at (#14) is CONFIRMED
-- PRESENT + index-served on the current prod DB (packs stats/games EXPLAIN);
-- idx_user_inv_card_id (#10) is CONFIRMED APPLIED (Index Only Scan). No action.
