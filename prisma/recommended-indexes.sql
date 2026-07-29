-- =============================================================================
-- Recommended index migrations — MAIN GAME DB (production)
-- =============================================================================
-- Produced by the 2026-05-11 perf audit. DO NOT apply blindly. Review with
-- the DB owner first. Every CREATE statement uses CONCURRENTLY so that
-- production traffic is NOT blocked during creation — this is mandatory
-- on the live ledger / user / inventory tables.
--
-- These indexes are intended for the MAIN game DB (the one packy.gg uses).
-- MAIN is strictly read-only from this repository. The database owner must
-- review and apply selected statements outside an application transaction,
-- then refresh the checked-in Drizzle snapshot with `npm run db:pull:main`.
--
-- Each section corresponds to a hot query path identified in the audit.
-- Estimated impact ranges assume ledger_transactions of 1M+ rows.
-- Validate row counts in production before scheduling.
--
-- Apply order (suggested): #1 first (biggest dashboard impact), then #2,
-- #3, #4 in order. The rest are lower-priority follow-ups.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- APPLIED STATUS (2026-07-10, owner-run + read-only pg_index/EXPLAIN verify):
-- EVERY active recommendation in this file is now LIVE on prod. The owner
-- applied the final 13 missing statements this date — all 13 valid=true:
--   idx_battles_user_id_status_created_at (#6) · idx_pf_inventory_item_id (#7c)
--   idx_gs_user_id_created_at (#8a) · idx_gs_game_type_created_at (#8b)
--   idx_ledger_tx_metadata_affiliate_code (#9) · idx_battle_participants_battle_id (#13)
--   idx_cards_set_id_created_at (#23) · idx_ledger_tx_deposit_created_at (#24)
--   idx_ledger_tx_game_session_id (#25a) · idx_vouchers_origin_id (#25b)
--   idx_game_sessions_bet_ledger_tx_id (#25c) · rain_tips_rain_id_idx (#26)
--   idx_user_inventory_obtained_at (#27)
-- EXPLAIN spot-checks (read-only): #24 deposits list, #6 battles per-user and
-- #13 participants-by-battle all plan onto their new index; #27 index-only-scans
-- 7d/30d windows while the 365d window correctly stays a seq scan (planner-
-- optimal low selectivity, same class as the #17 CRM finding — cached anyway).
-- Four recommendations are covered by PRE-EXISTING differently-named indexes
-- (do not re-create): #5c → idx_acu_upper_code · #7a → idx_pf_results_game_session_id
-- · #7b → idx_pf_results_battle_id · #28 → idx_acu_referred_user_created_at (#5d,
-- DESC btree serves the ASC range via backward scan).
-- STILL INTENTIONALLY NOT APPLIED (deferred by their own sections — do not
-- apply without re-reading them): #20 · #21 · #29 · #22 pair (table ~14 rows)
-- · the three #15 pg_trgm GIN indexes (pg_trgm extension NOT installed; only
-- back the opt-in ?match=contains path). #5a/#5b remain optional (leading-
-- column coverage exists via idx_affiliate_code_usages_affiliate_referred /
-- idx_acu_referred_user_created_at).
-- ═══════════════════════════════════════════════════════════════════════════
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
-- ⚠️ ESCALATION (2026-07-08, read-only EXPLAIN ANALYZE re-audit) — HIGHEST
-- PRIORITY unapplied recommendation on this page. Re-read before deferring.
--
-- The closing note at the bottom of this section ("Prod is 761 rows...
-- small enough that the scan itself is cheap today") is STALE. The `user`
-- table has grown to 15,562 rows (2026-07-08, vs. 761–7,800 when this
-- section and the row-count note at the bottom of this file were written —
-- roughly 2–20x growth). Querying `pg_indexes` on prod confirms only TWO
-- of the FOUR recommended prefix indexes below actually exist:
--   • idx_user_lower_username_prefix       — EXISTS
--   • idx_user_lower_email_prefix          — EXISTS
--   • idx_user_lower_name_prefix           — MISSING (never applied)
--   • idx_user_lower_display_username_prefix — MISSING (never applied)
-- This is not a low-value gap: `name` and `display_username` are populated
-- on virtually every row today (15,562/15,562 and 15,560/15,562
-- non-null/non-empty).
--
-- CORRECTION (2026-07-08, second pass) — the EXPLAIN below in an earlier
-- version of this note was mislabeled: it described a Prisma `where.OR`
-- branch (username/display_username/name/email `startsWith` ORed together)
-- as THE query the default search path runs. That branch exists in
-- getUsers but is DEAD CODE for free-form terms: `isFreeFormTextSearch`
-- (set whenever the term isn't a UUID/email/Discord-snowflake shape) always
-- routes to `fetchColumnSortUserIds` → `cachedFilteredColumnSortUserIds`
-- FIRST (see the `if (isFreeFormTextSearch || ...)` branch ahead of the
-- plain Prisma path), which builds its WHERE via
-- `buildUserListWhereClause` — a raw-SQL UNION-per-column construct, NOT a
-- single ORed filter:
--   u.id IN (
--     SELECT id FROM (
--       SELECT id FROM "user" WHERE LOWER(username) LIKE $1 ESCAPE '\'
--       UNION SELECT id FROM "user" WHERE LOWER(display_username) LIKE $1 ESCAPE '\'
--       UNION SELECT id FROM "user" WHERE LOWER(name) LIKE $1 ESCAPE '\'
--       UNION SELECT id FROM "user" WHERE LOWER(email) LIKE $1 ESCAPE '\'
--       UNION SELECT id FROM "user" WHERE LOWER(id) LIKE $1 ESCAPE '\'
--       UNION SELECT id FROM "user" WHERE LOWER(id) = $2
--     ) matched
--   )
-- This UNION shape was deliberately chosen (2026-06-05 pass) so each column
-- gets its OWN per-leg plan instead of one mixed BitmapOr — i.e. the
-- indexed legs already run as index scans today; they don't need to "wait"
-- on the missing ones.
--
-- Live EXPLAIN ANALYZE (read-only, prod, 2026-07-08) of this EXACT
-- reconstructed query (term "jo", default sort, page 1) confirms precisely
-- that: a Hash Join / Append over the six UNION legs, where the
-- username and email legs ALREADY hit their indexes and the other four do
-- not —
--   Append (six UNION legs, 750 rows before de-dup)
--     -> Bitmap Heap Scan on "user"  (username leg)
--          Filter: lower(username) ~~ 'jo%'   -> Bitmap Index Scan idx_user_lower_username_prefix   (0.166 ms)
--     -> Seq Scan on "user"  (display_username leg)
--          Filter: lower(display_username) ~~ 'jo%'   Rows Removed by Filter: 15,405   (11.4 ms)
--     -> Seq Scan on "user"  (name leg)
--          Filter: lower(name) ~~ 'jo%'                Rows Removed by Filter: 15,405   (6.8 ms)
--     -> Bitmap Heap Scan on "user"  (email leg)
--          Filter: lower(email) ~~ 'jo%'    -> Bitmap Index Scan idx_user_lower_email_prefix        (0.114 ms)
--     -> Seq Scan on "user"  (id LIKE leg — no lower(id) index exists or is proposed)
--          Filter: lower(id) ~~ 'jo%'                  Rows Removed by Filter: 15,543   (5.4 ms)
--     -> Seq Scan on "user"  (id = leg, exact-partial-id fallback)
--          Filter: lower(id) = 'jo'                     Rows Removed by Filter: 15,565   (4.7 ms)
--   -> Hash Join back to "user" u for the outer SELECT + ORDER BY created_at DESC LIMIT 20
--   Execution Time: 36.19 ms   (page-slice query)
--   (the parallel exact-count query over the same UNION shape: 19.10 ms —
--    runs concurrently via Promise.all, so wall-clock ≈ the slower of the
--    two, not their sum)
-- Root cause: NOT a BitmapOr/planner problem (the UNION design already
-- avoids that) — it is simply that 2 of the 6 UNION legs (display_username,
-- name) have no supporting index and each independently pays a full
-- Seq Scan, together accounting for ~18 ms of the ~36 ms total. This is the
-- direct, provable consequence of the two missing indexes, and applying
-- them converts those two legs into Bitmap Index Scans matching the
-- username/email legs already shown above.
--
-- Secondary, SEPARATE finding (not fixed by the two indexes above): the two
-- `id`-shaped legs (LIKE and exact `=`) together cost another ~10 ms and
-- always run a full Seq Scan regardless — no `lower(id)` prefix index is
-- recommended here (id is the primary key; a short free-form term rarely
-- if ever matches a random nanoid prefix, and a full-id paste is already
-- routed to the dedicated `isExactId` fast path earlier in getUsers, which
-- never reaches this UNION at all). Worth a follow-up look at whether these
-- two legs are pulling their weight for the cost they add, but that is a
-- QUERY-SHAPE question, not an indexing one, so it is flagged here rather
-- than acted on.
--
-- CLOSING NOTE (2026-07-08, second follow-up, read-only re-verify) — acted
-- on the finding above. `buildUserListWhereClause` (users-list.ts) now:
--   - removes the `LOWER(id) = $2` leg entirely (provably unreachable —
--     this branch only runs when the term already failed the same
--     isUserId shape check every real id satisfies).
--   - gates the `LOWER(id) LIKE $1` leg behind a length>=8 + id-charset
--     guard (`looksLikePartialId`), so it's omitted from the UNION for
--     short/non-id-shaped terms instead of merely returning nothing.
-- QUERY-SHAPE fix only — no `lower(id)` index is needed or recommended
-- here: short searches skip the leg entirely, so there is no scan left to
-- speed up for them, and a genuine 8+ char partial-id paste is rare
-- enough that a dedicated index isn't warranted.
--
-- Why this now outranks every other unapplied recommendation in this file:
-- this query runs on the DEFAULT /users search path (not the `?match=
-- contains` opt-in), on every debounced free-form keystroke, for every
-- admin using the page. 35 ms/keystroke is a real, measured, growing cost
-- today — not a someday-if-it-grows concern. Applying the two missing
-- CREATE INDEX CONCURRENTLY statements below (idx_user_lower_name_prefix,
-- idx_user_lower_display_username_prefix) is the single highest-value
-- unapplied index on this page.
--
-- The opt-in substring search (`?match=contains`) was also re-measured
-- (2026-07-08): still a Seq Scan, 2.08 ms at today's size — lower priority
-- than the above because it is opt-in, not the default path, but the three
-- pg_trgm GIN indexes below (idx_user_lower_username_trgm /
-- idx_user_lower_name_trgm / idx_user_lower_display_username_trgm) remain
-- unapplied too and should follow once the four prefix indexes land.
--
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
--
-- ADDITIONAL CONSUMER (2026-07-29): searchMainSiteUsers in
-- src/app/(admin)/admin-users/[id]/actions.ts (the creator→main-user link
-- picker) was rewritten from a per-keystroke leading-wildcard ILIKE OR to
-- this exact prefix shape (`LOWER(username/email) LIKE 'term%' ESCAPE '\'`),
-- so it rides the two EXISTING username/email prefix indexes below —
-- re-verified live that day: both exist, pg_trgm still NOT installed.
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
-- Added by the 2026-06-17 PostgreSQL index compliance pass for
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
-- Compliance posture: this read is not index-fixable;
-- it is served from indexed Postgres behind (a) shell-first <Suspense>
-- streaming so it never blocks first paint, (b) a 300s unstable_cache so the
-- ~1.45s cold aggregate runs at most once per 5 min, and (c) a safeQuery
-- timeout. The cent/count-exact PostgreSQL query is parity-proven
-- (TZ=UTC, run twice: 3387/3387 users, every total Δ=0.00).
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
--
-- ⚠️ ESCALATION (2026-07-08, read-only EXPLAIN re-audit) — re-measured at
-- today's row count. The `user` table has grown to 15,562 rows (from ~761
-- when the ~11 ms baseline above was measured). The Top vault/locked sort
-- (SortByLockedBalanceButton, sortBy=lockedBalance) now measures 26.9 ms
-- total: a full Hash Left Join of `user` (Seq Scan, all 15,562 rows) to
-- `balances` (Seq Scan, all rows), then a top-N sort. So the "filter-first
-- CTE keeps rows-to-sort tiny" assumption in the paragraph above is ALSO
-- now stale — verify the current query shape before trusting that framing
-- (see judgement call below).
--
-- Judgement call: DEFER, do not apply yet, but for a different reason than
-- "not worth it" — the partial index alone would not fix this even if
-- applied. `idx_balances_locked_balance_nz` only helps a query that scans
-- `balances` ORDER BY locked_balance DESC and joins outward to `user`; the
-- current implementation (src/lib/queries/users-list.ts, search for
-- buildRankingOrderExpr / computeRankedUserIds / RAW_SQL_SORTS) drives the
-- opposite direction — it scans `user` first (via the filtered CTE) and
-- LEFT JOINs `balances` in, so a `balances`-side index cannot be seeked
-- into by that plan shape. Getting the index's benefit would require BOTH
-- the partial index AND restructuring the query to be driven from
-- `balances` (index range-scan on locked_balance DESC LIMIT n, joined back
-- to `user`) — a real query rewrite, not just an index add.
--
-- That rewrite is NOT done in this pass: this sort is a manual button
-- click (not on every page load / not on every keystroke, unlike #15
-- above), and 26.9 ms is not itself slow in absolute terms — there is no
-- user-visible complaint and no PostgreSQL index-policy violation (the read is
-- fully indexed-table Seq Scan at a size where Seq Scan is still a
-- reasonable planner choice, not an unindexed hot path). Re-escalate to an
-- actual code change if /users approaches the ~50k mark this section
-- already flagged, or if the click becomes perceptibly slow — until then,
-- documenting the current 15,562-row / 26.9 ms reality (replacing the
-- stale 761-row / ~11 ms assumption) is the proportional response.

-- #21 ----------------------------------------------------------------
-- affiliate_codes.code — /insights/affiliate-codes code-PREFIX search
-- ===================================================================
-- Added by the 2026-06-30 Affiliate Codes page. The page's primary code
-- lookup is EXACT (`code = $1`), which already hits the existing
-- `affiliate_codes_code_unique` btree (Index Scan, EXPLAIN-proven). But a
-- code PREFIX search (`code LIKE 'ABC%'`) CANNOT use that default-collation
-- index — EXPLAIN shows a Seq Scan. Per the PostgreSQL index rule the
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
-- PostgreSQL index rule the missing index is flagged so the global
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
-- Required for the PostgreSQL serving path.
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

-- =============================================================================
-- #30 -- 2026-07-10 "/users/[id] click takes ages" bug report
-- MAIN is read-only; agents NEVER apply — owner applies these CONCURRENTLY.
-- =============================================================================

-- #30 -----------------------------------------------------------------
-- user_inventory (user_id, obtained_at) + vouchers (user_id) — NON-PARTIAL,
-- backing getUserTransactions' full-lifetime "held value" sweep
-- ===================================================================
-- getUserTransactions (src/lib/queries/users-transactions.ts) is the
-- enrichment fan-out behind the Gaming tab — one of the TWO tabs kicked by
-- DEFAULT on every /users/[id] load (Overview always sets wantsGamingTx).
-- For every gaming-type call it reads the user's ENTIRE historical
-- inventory + voucher ledger (not just currently-held items) to reconstruct
-- a per-transaction "held value" sweep (worth-before/worth-after per row):
--
--   allInventory: user_inventory.findMany({ where: { user_id, obtained_at: { lte: maxTxTs } } })
--   allVouchers:  vouchers.findMany({ where: { user_id } })
--
-- Both are UNFILTERED by sold_at/exchanged_at/claimed_at — the sweep needs
-- every acquire AND every dispose/claim event over the user's lifetime to
-- compute the running held-value total, so a disposed/claimed row is just
-- as necessary as a currently-open one. Neither existing partial index can
-- serve that:
--   • idx_user_inv_open_by_user / idx_user_inv_owned_by_user — WHERE sold_at
--     IS NULL AND exchanged_at IS NULL (± withdrawal_locked_at) — excludes
--     every disposed row, which this query also needs.
--   • idx_vouchers_unclaimed_by_user — WHERE claimed_at IS NULL — excludes
--     every claimed voucher, which this query also needs.
--
-- EXPLAIN (ANALYZE, BUFFERS) against prod (read-only, 2026-07-10), a
-- representative top-inventory user (13,915 of that user's 797,673-row
-- user_inventory total; 452 of 60,465-row vouchers total):
--
--   allInventory (obtained_at <= now(), i.e. the full page-1 bound):
--     Gather (Parallel Seq Scan on user_inventory, 2 workers)
--       Rows Removed by Filter: 261,253   Buffers: hit=3,545 read=16,888
--     Execution Time: 50.8 ms
--
--   allVouchers (user_id = $1, no other predicate):
--     Seq Scan on vouchers
--       Rows Removed by Filter: 60,013    Buffers: read=3,911
--     Execution Time: 23.0 ms
--
-- Neither number is catastrophic in isolation, but this PAIR of full-table
-- scans (797k + 60k rows) runs on every COLD Gaming/Overview tab load for
-- EVERY user — the #1-traffic route's default tab — competing for the MAIN
-- `max: 3` connection-pool slots (db.ts) alongside the rest of the
-- ~19-round-trip detail aggregate. Buffers are mostly `read` (disk), not
-- `hit` (cache) — under concurrent admin traffic this is exactly the
-- "click a user, takes ages" failure mode: two large disk-bound seq scans
-- queueing behind an undersized pool instead of resolving as sub-ms index
-- seeks. The 15s cache (getUserGamingTransactionsCached) only helps a
-- REPEAT visit to the SAME user within the window — the first click on any
-- user (or any click after a 15s gap) pays the full scan cost fresh.
--
-- A non-partial composite on user_inventory and a non-partial single-column
-- index on vouchers turn both into user_id-scoped index (range) scans — the
-- same class of fix that already cured idx_ledger_tx_user_created_at (#19:
-- "no existing index covers an ALL-STATUSES per-user scan", same file, same
-- page, same "takes ages" symptom — 66ms/187k-rows-removed down to
-- 0.46ms/64-rows-removed once applied).
--
-- NOT APPLIED — flagged only (MAIN is read-only; agents never apply).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_inventory_user_id_obtained_at
  ON user_inventory (user_id, obtained_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vouchers_user_id
  ON vouchers (user_id);

-- #31 ----------------------------------------------------------------
-- affiliate_codes.code — /users free-form search "find a code's owner" leg
-- ===================================================================
-- Added by the 2026-07-10 /users search extension (users-list.ts): a
-- free-form search term that exactly (case-insensitively) matches an
-- affiliate_codes.code row now surfaces that code's OWNER, via a new
-- UNION leg in buildUserListWhereClause's free-form branch —
--   SELECT user_id AS id FROM affiliate_codes WHERE UPPER(code) = $N
-- — and the mirrored Prisma `{ affiliate_codes: { some: { code: {
-- equals, mode:"insensitive" } } } }` leg in getUsers' (dead-for-free-form,
-- kept-in-sync per this file's own documented invariant, see #15) plain
-- `where.OR`.
--
-- UPPER() is required, not optional: a read-only check against prod
-- (2026-07-10) shows 1,024 of 1,036 affiliate_codes rows are already
-- canonical-uppercase, but 12 are NOT — a plain `code = UPPER($N)`
-- equality (skipping the SQL-side UPPER(code)) would silently miss those
-- 12 real codes whenever an admin doesn't paste the exact stored casing.
-- Same case-fold convention #5's idx_acu_upper_code already established
-- for affiliate_code_usages.code.
--
-- EXPLAIN ANALYZE (read-only, prod, 2026-07-10) confirms `code`'s ONLY
-- existing index — `affiliate_codes_code_unique`, a plain default-collation
-- unique btree — does NOT serve `UPPER(code) = $N` (functional/expression
-- lookups need a matching expression index; a plain btree on the raw
-- column cannot):
--   Seq Scan on affiliate_codes  (cost=0.00..32.52 rows=5 width=33)
--     Filter: (upper(code) = '...'::text)
--     Rows Removed by Filter: 1036
--   Execution Time: 0.970 ms
-- (A bare `code = $N`, no UPPER(), DOES hit `affiliate_codes_code_unique`
-- as an Index Scan — same finding #21 already made for that page's exact-
-- code lookup — but that's the wrong semantics here, per the correctness
-- note above.)
--
-- NOT APPLIED — flagged only. At today's prod size (1,036 affiliate_codes
-- rows) the Seq Scan is sub-millisecond and does not make the pre-existing
-- outer `user`-table scan in this same free-form branch (documented at #15)
-- any worse — confirmed via EXPLAIN ANALYZE on the full combined free-form
-- WHERE shape with this leg included. Per the PostgreSQL index rule this
-- specific leg is BLOCKED from being a true index-backed read until the
-- owner applies the statement below; ship the feature now (correct,
-- negligible-cost, and consistent with #21/#22/#29's precedent for a small,
-- flagged, currently-cheap Seq Scan) and re-verify once applied:
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_affiliate_codes_upper_code
  ON affiliate_codes (UPPER(code));

-- #32 ----------------------------------------------------------------
-- affiliate_codes.code — /users "Affiliate code only" search (code PREFIX)
-- ===================================================================
-- Added by the 2026-07-12 /users code-search toggle (the "Affiliate code
-- only" toolbar checkbox → getUsers `codeSearch`). In that mode
-- buildUserListWhereClause matches the term against affiliate_codes.code by
-- case-insensitive PREFIX and returns the code owners:
--   SELECT user_id FROM affiliate_codes WHERE UPPER(code) LIKE $N ESCAPE '\'
-- (pattern = uppercased+escaped term + '%').
--
-- Neither existing/recommended affiliate_codes index serves this:
--   • #31 idx_affiliate_codes_upper_code = a PLAIN btree on UPPER(code) — it
--     serves `UPPER(code) = $N` (exact) but NOT a `LIKE 'X%'` prefix (a
--     default-collation btree cannot do left-anchored pattern matching).
--   • #21 idx_affiliate_codes_code_prefix = text_pattern_ops but on the RAW
--     `code`, not `UPPER(code)`, so it can't serve the case-folded prefix.
-- To make the code-PREFIX search a true index range scan, the indexed
-- expression must match the query EXACTLY: UPPER(code) with text_pattern_ops
-- (same shape idx_user_lower_username_prefix (#15) uses for handle prefixes,
-- just UPPER instead of LOWER to match this file's code case-fold convention):
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_affiliate_codes_upper_code_prefix
--     ON affiliate_codes (UPPER(code) text_pattern_ops);
--
-- NOT APPLIED — flagged only. EXPLAIN ANALYZE (read-only, prod 2026-07-12) of
-- the exact code-only prefix leg is a Seq Scan over 1,040 rows at 0.44 ms —
-- sub-millisecond at today's size, so the feature ships now (correct,
-- negligible-cost, consistent with the #21/#31 precedent). Per the
-- PostgreSQL index rule this leg is BLOCKED from being a true index-backed
-- read until the owner applies the statement above; re-verify once applied.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_affiliate_codes_upper_code_prefix
  ON affiliate_codes (UPPER(code) text_pattern_ops);

-- #33 -----------------------------------------------------------------
-- chat_messages (created_at, user_id) — Players → Top Chatters (2026-07-15)
-- ===================================================================
-- New admin page: a live leaderboard of the most active packy chat senders
-- for the CURRENT UTC calendar day (getTopChattersToday in
-- src/lib/queries/chat.ts). Query shape:
--   SELECT cm.user_id, COUNT(*) FROM chat_messages cm
--   WHERE cm.is_deleted = false
--     AND cm.created_at >= <today 00:00 UTC> AND cm.created_at < <tomorrow 00:00 UTC>
--   GROUP BY cm.user_id ORDER BY COUNT(*) DESC
--
-- chat_messages has NO index on user_id or created_at alone — only
-- idx_chat_messages_embed_battle_id_created_at (embed_battle_id, created_at)
-- and a partial index on reply_to_id (both pre-existing, unrelated to this
-- query). This is a genuinely new access pattern: no prior query in this
-- codebase grouped/ranked chat_messages by sender over a date range.
--
-- EXPLAIN ANALYZE (read-only, prod, 2026-07-15). chat_messages is small
-- today: 60,834 rows total, 16 MB (pg_class.reltuples / pg_total_relation_size,
-- catalog-only, no scan). The planner actually picks an Index Scan on the
-- EXISTING (embed_battle_id, created_at) index for the today-window query
-- (0.71ms) simply because it's narrower than the full row — but that's
-- coincidental, not a real created_at-leading index. Forcing a genuine Seq
-- Scan baseline (`SET LOCAL enable_indexscan/bitmapscan/indexonlyscan = off`,
-- rolled back, no schema/data change) gives the true cost:
--   Seq Scan on chat_messages  (cost=0.00..3076.83 rows=1 width=33)
--     (actual time=17.630..17.631 rows=0 loops=1)
--     Filter: ((NOT is_deleted) AND (created_at >= ...) AND (created_at < ...))
--     Rows Removed by Filter: 61175
--   Execution Time: 17.838 ms
--
-- APPLIED (2026-07-15, valid) — owner applied this index same-day; re-verified
-- read-only against prod (pg_indexes/pg_index.indisvalid = true). The today-
-- window query now plans as `Index Only Scan using
-- idx_chat_messages_created_at_user_id` (Heap Fetches: 0 — the partial index
-- fully covers user_id + the is_deleted predicate):
--   cost=8.49 (was cost=3076.83 forced-Seq-Scan baseline)
--   Execution Time: 0.458 ms (was 17.838 ms)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_messages_created_at_user_id
  ON chat_messages (created_at, user_id) WHERE is_deleted = false;

-- ─────────────────────────────────────────────────────────────────────────────
-- Creator VIP rewards — first-time-deposit lossback (2026-07-23)
--
-- The FTD-lossback leg needs a player's FIRST (and second) completed deposit:
--
--   SELECT amount, created_at FROM ledger_transactions
--    WHERE user_id = $1 AND type = 'deposit' AND status = 'completed'
--    ORDER BY created_at ASC LIMIT 2
--
-- MEASURED against prod 2026-07-23 (EXPLAIN ANALYZE, read-only):
--   Limit -> Sort (top-N heapsort) -> user_id index
--   Execution Time: 7.956 ms
--   Buffers: shared hit=37 read=724      <- 724 pages fetched from disk
--
-- It is not a Seq Scan, but the user_id index alone can't satisfy the ORDER BY:
-- Postgres fetches EVERY ledger row for that user (a heavy player has
-- thousands, on a 1.27M-row / 675 MB table) and top-N sorts them, just to
-- return 2. This partial index makes it a 2-row index scan with no sort.
--
-- Partial on purpose: deposits are a small slice of ledger_transactions, so the
-- index stays tiny and the predicate matches the query exactly.
--
-- APPLIED 2026-07-23 by the owner; re-verified read-only (pg_index.indisvalid
-- = true, 704 kB).
--
-- IMPORTANT FOLLOW-UP FOUND ON VERIFICATION: the index was initially unused
-- (idx_scan = 0) because the query compared `type::text = 'deposit'`. Casting
-- an indexed column makes it non-sargable, so Postgres could not match this
-- index — nor any of the three pre-existing (user_id, created_at) indexes —
-- and fell back to fetching every ledger row for the user plus a top-N sort.
-- The cast was removed in src/lib/creator-vip/ftd-lossback.ts. Measured on the
-- same row and user:
--
--   type::text = 'deposit'   6.092 ms   2564 buffers   no index   + sort
--   type = 'deposit'::enum   0.087 ms      8 buffers   this index, no sort
--
-- Lesson worth keeping: the `::text` enum-comparison convention used elsewhere
-- in this codebase (to survive prod enums lagging the client) silently
-- disables index usage. Apply it only where the enum member genuinely may not
-- exist, never on a hot indexed predicate.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_user_deposit_created
  ON ledger_transactions (user_id, created_at)
  WHERE type = 'deposit' AND status = 'completed';

-- ─────────────────────────────────────────────────────────────────────────────
-- promo_codes.code_hash — UNIQUE (currently only a plain index, 0140)
--
-- A code hash IS the identity of a code: redeem resolves a row by hash and
-- takes the first match. Nothing today stops two rows sharing one hash.
--
-- The admin's reward campaigns derive each code from (campaign, user), check
-- `code_hash IN (...)` and insert only what's missing — safe when batches run
-- sequentially, which is how the composer drives them. Two operators starting
-- the SAME campaign at the same moment could both see "not present" and both
-- insert, leaving a duplicate row that shadows the other. A unique index makes
-- that physically impossible rather than merely unlikely.
--
-- Check for existing duplicates before applying — this fails if any exist:
--   SELECT code_hash, count(*) FROM promo_codes
--    GROUP BY code_hash HAVING count(*) > 1;
--
-- NOT APPLIED — MAIN is read-only for the admin dashboard. Owner to apply.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS promo_codes_code_hash_unique
  ON promo_codes (code_hash);

-- =============================================================================
-- #31+ — 2026-07-26 PostgreSQL-only analytics migration
-- MAIN is read-only; these statements are recommendations for owner execution.
-- =============================================================================

-- #31 reward analytics now reads every rakeback dashboard directly from
-- PostgreSQL. Windowed totals filter by claimed_at and consume user_id plus the
-- two numeric measures. The partial covering shape keeps unclaimed rows out and
-- avoids heap reads for the common date-window aggregates.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rakeback_claims_claimed_at_cover
  ON rakeback_claims (claimed_at, user_id)
  INCLUDE (rakeback_amount_usd, wagered_amount_usd)
  WHERE claimed_at IS NOT NULL;

-- #32 cohort, cadence, lapsed-user, and top-claimer queries start from a user
-- and walk that user's claims chronologically. The unique business key begins
-- with user_id but cannot provide claimed_at order, so this complementary
-- partial index removes repeated sorts and bounded nested scans.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rakeback_claims_user_claimed_at
  ON rakeback_claims (user_id, claimed_at)
  WHERE claimed_at IS NOT NULL;

-- #33 the former secondary analytics path is gone, so type/date reward and
-- ledger aggregates always execute on PostgreSQL. This composite is now a
-- required primary-path index instead of the previously deferred fallback
-- recommendation.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_tx_type_created_at
  ON ledger_transactions (type, created_at DESC);

-- #34 card-payment list pagination orders by newest intent with a stable id
-- tie-breaker. Read-only catalog verification on 2026-07-26 found only 39
-- rows, so two list-only indexes would currently cost more write/storage
-- overhead than the tiny in-memory sort they avoid. Reconsider the following
-- shapes only after the table grows materially (for example, >50k rows):
--   (created_at DESC, id DESC)
--   (status, created_at DESC, id DESC)

-- #35 deposit-bonus detail resolves a provider transaction id from JSON for a
-- single user. The partial expression index is limited to the exact completed
-- bonus rows read by that workflow.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_bonus_fireblocks_user
  ON ledger_transactions (user_id, (metadata->>'fireblocks_tx_id'))
  WHERE type = 'deposit_bonus' AND status = 'completed';

-- #36 provably-fair history is a per-user newest-first bounded page.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_seed_rotation_user_rotated
  ON seed_rotation_history (user_id, rotated_at DESC);

-- #37 sold inventory history pages by user and sale time and renders the card
-- and obtained value. The partial covering shape excludes live inventory.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_inventory_sold_user_time_cover
  ON user_inventory (user_id, sold_at DESC)
  INCLUDE (id, card_id, value_at_obtained)
  WHERE sold_at IS NOT NULL;

-- #38 open vouchers are fetched newest-first per user. Include the displayed
-- monetary fields so the common page can remain index-only.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vouchers_open_user_created_cover
  ON vouchers (user_id, created_at DESC)
  INCLUDE (value, origin, description)
  WHERE claimed_at IS NULL;

-- #39 backend-monitor pages recent signups by newest account with id as the
-- stable tie-breaker. This shape serves both the initial page and its keyset
-- cursor without a sequential scan plus sort.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_created_at
  ON public."user" (created_at DESC, id DESC);

-- #40 backend-monitor resolves the newest fingerprint evidence for each
-- signup. Keep this recommendation with the MAIN owner-applied index catalog;
-- the read-only monitor service intentionally carries no executable DDL.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fingerprints_user_id_created_at
  ON public.fingerprints (user_id, created_at DESC);
