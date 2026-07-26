import { queryMainRows } from "@/lib/drizzle-query";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { escapeBlacklistIds } from "./_blacklist";
import { WITHDRAWAL_LIABILITY_STATUSES } from "./pnl";
import type {
  CreatorLifetimePnl,
  CreatorPnlData,
  CreatorPnlPeriod,
  CreatorPnlPeriodUser,
} from "./creators-types";

// card_withdrawal_requests statuses that count as a house liability —
// the SAME set the per-user / lifetime balance-sheet P&L uses
// (`WITHDRAWAL_LIABILITY_STATUSES` in pnl.ts): pending + processing
// (in-flight) plus shipped + completed (done). Counting in-flight
// withdrawals keeps the creator P&L (deposits − cardWithdrawals)
// CONTINUOUS across the withdrawal lifecycle — previously only
// completed/shipped counted, so a pending withdrawal's value vanished
// from the creator's books until it shipped (the same pending-WD hole the
// per-user P&L was fixed for). Rendered once as a quoted SQL list; the
// values are hardcoded enum-ish strings (no external input).
const WD_LIABILITY_STATUS_SQL = `(${WITHDRAWAL_LIABILITY_STATUSES.map(
  (s) => `'${s}'`,
).join(", ")})`;

/**
 * Per-creator House P&L with **coverage-aware code attribution**.
 *
 *   pnl = deposits − cardWithdrawals
 *
 * Why coverage attribution: the backend only writes an
 * `affiliate_code_usages` row of `usage_type = 'deposit'` on the
 * user's FIRST-EVER deposit (see fireblocks webhook.service:
 * `if (depositCount !== 1) return`). Every subsequent deposit a user
 * makes — even while still inside the same code's 7-day coverage
 * window — is invisible to the acu attribution model. That made the
 * old "sum acu.deposit_amount_usd" approach systematically
 * under-count, and creators looked falsely negative when a user came
 * back, deposited again (no code applied), played, and withdrew
 * cards — the cards landed on the creator's books via the wager-session
 * chain but the matching deposits weren't on the books to balance them.
 *
 * Reconstruction model:
 *   A ledger deposit at time T by user U is attributed to creator A if
 *   U has at least one `acu` row under creator A's code with
 *   `created_at <= T AND created_at >= T - 7 days`. When U has multiple
 *   acu rows in that window under different creators (code-switching),
 *   the MOST RECENT acu row wins — that's the code that was active when
 *   the deposit happened.
 *
 * Card withdrawals stay matched via `inventory_item_ids` →
 * `user_inventory.source_id` → acu wager session. Restricted to
 * coverage-depositors (users with at least one coverage-attributed
 * deposit under this creator) — keeps users who only wagered under the
 * code without ever depositing during its coverage from dragging the
 * P&L down via cardWD.
 *
 * Wagered is sourced unchanged from `acu.wager_amount_usd` —
 * `recordWagerUsage` is called on every wager that happens while a
 * code is active, so wagers don't suffer the depositCount bug.
 *
 * Referred-user pool excludes admin / support / creator role accounts,
 * the creator's own user_id, and the motha-managed blacklist.
 *
 * House POV: positive (emerald) = we kept value, negative (rose) =
 * physical cards out exceeded cash deposited under coverage.
 *
 * ─── PERF SHAPE (2026-06-03 set-based rewrite) ──────────────────────────
 *
 * The previous incarnation fired EIGHT raw queries, and the dominant cost
 * — the correlated `COVERING_CREATOR_SQL` coverage subquery — was
 * re-evaluated in SIX of them (per-period deposits, per-user deposits, the
 * two card-WD depositor sub-selects, the depositor-id scan, and twice in
 * the lifetime aggregate). On a prod main DB with no supporting index that
 * is the scan that blows past the safeQuery timeout and degrades the panel.
 *
 * This version reconstructs the cohort ONCE per scan via CTEs and derives
 * everything from them:
 *   • the 30-day window block is now a SINGLE query that materializes the
 *     attributed deposits / wagers / withdrawn-units once, then GROUP BYs
 *     them per user × period. The five PER-PERIOD HEADLINE totals are
 *     summed in JS from the (SQL-uncapped) per-user rows — the same filters
 *     drive both, so the headline is identical to the old separate
 *     per-period queries, just without re-scanning.
 *   • the 365-day lifetime block is a SINGLE query that materializes the
 *     same shapes over the wider window and returns the lifetime sums PLUS
 *     the coverage-depositor id set (for the popover's isDepositor flag) in
 *     one row — folding the old standalone depositor-id scan in.
 * Result: 2 scans instead of 8, and the coverage subquery is evaluated
 * once per deposit row per scan instead of six times. Numbers / scope /
 * attribution are unchanged — speed only.
 *
 * The function runs behind `getCreatorPnlCached` (unstable_cache, prod-
 * pinned) and a raised per-statement timeout so the COLD populating scan
 * completes and warms the cache instead of falling back to "timed out".
 */
const PERIODS = ["24h", "3d", "7d", "14d", "30d"] as const;

type PeriodKey = (typeof PERIODS)[number];

// Period set with the interval inline — the per-user breakdown query
// cross-joins each row against every window so a single event lands in
// every window it qualifies for.
const PERIODS_WITH_INTERVAL_SQL = `(VALUES
  ('24h', INTERVAL '24 hours'),
  ('3d',  INTERVAL '3 days'),
  ('7d',  INTERVAL '7 days'),
  ('14d', INTERVAL '14 days'),
  ('30d', INTERVAL '30 days')
) AS p(period, intv)`;

// Hard cap on rows surfaced in the per-period hover popover.
const USERS_PER_PERIOD_CAP = 50;

// SQL fragment: for a ledger row aliased `lt`, returns the
// affiliate_user_id of the creator whose code's 7-day coverage window
// covered the deposit at `lt.created_at`. Returns NULL if no covered
// code (deposit happened outside any coverage window).
//
// "Most recent acu row before the deposit, within 7 days" matches the
// backend's coverage semantics: `useAffiliateCode` sets
// expires_at = NOW + 7d, so a code applied at T is covering through
// T + 7d. The latest acu row picks the code-of-record at deposit time
// when a user has switched codes.
//
// ── PERF / INDEX NOTE (the dominant remaining unlock) ──────────────────
// This correlated subquery runs once per candidate ledger row (now once
// per deposit row in the `attr_dep` CTE, not six times across the call).
// Its access pattern is `referred_user_id = ? AND created_at <range>
// ORDER BY created_at DESC LIMIT 1`. The form is already SARGABLE — the
// bottleneck is the MISSING index. VERIFIED against live prod 2026-06-11:
// `affiliate_code_usages` carries ONLY its primary key — NO secondary
// indexes at all (the two ACU indexes in the checked-in MAIN schema,
// idx_acu_referred_user_code_usage and idx_acu_affiliate_user_created_at,
// do NOT exist on prod; an earlier revision of this comment wrongly
// claimed they did). Every acu predicate in this module therefore
// seq-scans today. The index that turns the coverage probe into a single
// backward index seek (stop at the first row) is:
//   CREATE INDEX CONCURRENTLY idx_acu_referred_user_created_at
//     ON affiliate_code_usages (referred_user_id, created_at DESC);
// (In prisma/recommended-indexes.sql §5 — applying it on prod, plus the
// two schema-declared acu indexes above, is an OWNER task: prod DDL is
// forbidden for agents. This is the dominant unlock for the ~5s cold
// creator-PnL transaction.)
export const COVERING_CREATOR_SQL = `(
  SELECT acu_c.affiliate_user_id
    FROM affiliate_code_usages acu_c
   WHERE acu_c.referred_user_id = lt.user_id
     AND acu_c.created_at <= lt.created_at
     AND acu_c.created_at >= lt.created_at - INTERVAL '7 days'
   ORDER BY acu_c.created_at DESC
   LIMIT 1
)`;

// Lifetime-lookback cap (days) for the "All-time" aggregate query.
//
// The per-PERIOD query bounds its scan to the widest displayed window
// (30 days), so it never touches old rows. The "All-time" aggregate, by
// contrast, had NO lower bound — it scanned the ENTIRE
// `ledger_transactions` deposit history and the full
// `affiliate_code_usages` / withdrawn-unit history for every render. On
// prod that is a full-history table scan and is the dominant cost of the
// `getCreatorPnl` call that the /creators/[userId] PnL panel awaits.
//
// We cap that scan at 365 days — the SAME lifetime guard the reward-insights
// lifetime queries use (`LIFETIME_PAIRING_LOOKBACK_DAYS` in the deposit-bonus
// `_shared.ts`). The affiliate / creator program is recent enough that a
// rolling 365-day window covers effectively all real attributed activity,
// so the displayed figure is unchanged in practice; the UI labels the hero
// "Lifetime (capped)" with the exact window so the bound is never silent.
//
// NOTE the `COVERING_CREATOR_SQL` correlated subquery only ever looks 7
// days back from each event, so it is already bounded per-row — capping the
// OUTER scan is what removes the full-history seq-scan without changing
// which creator a covered deposit attributes to.
const LIFETIME_LOOKBACK_DAYS = 365;
const LIFETIME_LOOKBACK_INTERVAL = `INTERVAL '${LIFETIME_LOOKBACK_DAYS} days'`;

// Per-statement timeout (ms) for the COLD populating scan. The global
// pool statement_timeout (db.ts) is 30s, which aborts a cold uncached
// scan before it can finish and warm the cache — so it would degrade to
// "timed out" forever. These reads run at most once per cache TTL, so a
// generous budget is safe: we raise the per-statement timeout to 55s via
// `SET LOCAL` inside the transaction (LOCAL = reverts on commit, never
// leaks to other pool users). The app-level safeQuery wrapper around the
// panel uses a matching budget so it doesn't cut the populating scan off
// early. Genuine failures still surface; the happy path now completes.

// "Withdrawn unit" derived table: emits one row per value-unit (card
// OR session-linked voucher) leaving the house via a
// `card_withdrawal_requests` that is a HOUSE LIABILITY — in-flight
// (pending/processing) OR done (shipped/completed), per
// WITHDRAWAL_LIABILITY_STATUSES. Counting in-flight requests closes the
// pending-WD hole (the creator P&L stays continuous across the withdrawal
// lifecycle, matching the per-user balance-sheet P&L). Used in place of
// `JOIN user_inventory` throughout the cardWD queries so vouchers
// contribute to the same total as physical cards.
//
// Two sources, both UNNEST'd from the cwr array columns and joined on
// equality to their parent table — much faster than the equivalent
// `JOIN ... ON id = ANY(array)` shape, which forces sequential scans
// because Postgres can't use a B-tree index on the right side of
// `ANY(array)`. UNNEST turns the array into rows the planner can
// hash-join or nested-loop on the indexed primary key column.
//
//   • Cards: `cwr.inventory_item_ids` → `user_inventory.id` where
//     `source_type IN ('pack','battle')`. Per-card valuation uses
//     `value_at_obtained` (canonical).
//   • Session-linked vouchers: `cwr.voucher_ids` → `vouchers.id`
//     where `origin IN ('battle_excess_to_voucher',
//     'pack_borrow_to_voucher')`. Both origins set `origin_id` to the
//     producing `game_session_id`, so the same `source_id` joining
//     pattern as cards works against creator acu wager sessions.
//
// `exchange_excess_to_voucher` is excluded — its `origin_id` points to
// an exchange session, not a wager session, so it doesn't appear in
// acu wager rows and can't be code-attributed via the session chain.
// `creator_fill_conversion` is excluded — those are creator's own deal
// commission, unrelated to referrer attribution.
//
// `withdrawn_at` is the lifecycle timestamp the value left / became a
// liability: COALESCE(shipped_at, completed_at, processing_at,
// requested_at). The processing_at / requested_at fallbacks are NEW — a
// pending/processing request has no shipped_at/completed_at yet, so
// without them its value would have a NULL `withdrawn_at` and silently
// drop out of every rolling-period window. Falling back to processing_at
// (processing) / requested_at (pending) buckets in-flight requests at the
// moment they were made, so the per-period figures are continuous too
// (shipped/completed rows are unchanged — shipped_at/completed_at win).
export const WITHDRAWN_UNITS_SQL = `(
  SELECT cwr_unnested.withdrawn_at,
         ui.user_id, ui.source_id, ui.value_at_obtained::numeric AS value
    FROM (
      SELECT COALESCE(cwr.shipped_at, cwr.completed_at, cwr.processing_at, cwr.requested_at) AS withdrawn_at,
             UNNEST(cwr.inventory_item_ids) AS item_id
        FROM card_withdrawal_requests cwr
       WHERE cwr.status IN ${WD_LIABILITY_STATUS_SQL}
    ) cwr_unnested
    JOIN user_inventory ui ON ui.id = cwr_unnested.item_id
   WHERE ui.source_type::text IN ('pack', 'battle')
  UNION ALL
  SELECT cwr_unnested.withdrawn_at,
         v.user_id, v.origin_id AS source_id, v.value::numeric AS value
    FROM (
      SELECT COALESCE(cwr.shipped_at, cwr.completed_at, cwr.processing_at, cwr.requested_at) AS withdrawn_at,
             UNNEST(cwr.voucher_ids) AS voucher_id
        FROM card_withdrawal_requests cwr
       WHERE cwr.status IN ${WD_LIABILITY_STATUS_SQL}
    ) cwr_unnested
    JOIN vouchers v ON v.id = cwr_unnested.voucher_id
   WHERE v.origin::text IN ('battle_excess_to_voucher', 'pack_borrow_to_voucher')
)`;

async function buildBlacklistAnd(): Promise<string> {
  const excluded = await getExcludedUserIds();
  // Leading space is intentional — call sites concatenate this directly
  // after another condition (e.g. `... AND u.id != $1${blacklistAnd}`).
  return excluded.length > 0
    ? ` AND u.id NOT IN (${escapeBlacklistIds(excluded)})`
    : "";
}

type PerUserPeriodRow = {
  user_id: string;
  username: string | null;
  image: string | null;
  period: string;
  deposits: string;
  wagered: string;
  card_withdrawals: string;
};

type PeriodCardWdRow = {
  period: string;
  card_withdrawals: string;
};

type LifetimeRow = {
  total_deposits: string;
  total_wagered: string;
  total_card_withdrawals: string;
  depositor_ids: string[] | null;
};

export async function getCreatorPnl(userId: string): Promise<CreatorPnlData> {
  const blacklistAnd = await buildBlacklistAnd();

  // ── 30-day WINDOW block ──────────────────────────────────────────────
  //
  // Materializes the attributed deposits / wagers / withdrawn-units ONCE
  // (each CTE scans its source once; the coverage subquery runs once per
  // deposit row), then GROUP BYs per user × period for the popover rows.
  //
  // HEADLINE derivation (numbers byte-identical to the old per-period
  // queries):
  //   • deposits + wagers headlines are summed in JS from the (SQL-uncapped)
  //     per-user rows — the old per-period and per-user deposit/wager
  //     queries used IDENTICAL filters, so Σ(per-user) ≡ the old headline.
  //   • card-withdrawals headline is NOT derived from the per-user rows: the
  //     old per-period cardWD query had NO staff/blacklist filter on the
  //     WITHDRAWING user, while the per-user cardWD query DID. To preserve
  //     the exact displayed number we keep a dedicated `cardWdHeadlineSql`
  //     that mirrors the old per-period cardWD filters verbatim (no outer
  //     user filter), and use the per-user cardWD rows only for the popover.
  //
  //   attr_dep30 — ledger deposits whose covering creator at deposit time
  //                is THIS creator, last 30d, staff/blacklist-excluded.
  //   creator_wager30 — this creator's acu wager rows, last 30d.
  //   wd_sessions — distinct non-null game_session_id from ALL of this
  //                 creator's wager rows (UNBOUNDED, matching the old
  //                 per-period cardWD session sub-select which had no lower
  //                 bound — the session a withdrawn card traces to may be
  //                 older than 30d even when the withdrawal is recent).
  //   wd_depositors — distinct coverage-depositor ids (UNBOUNDED outer
  //                   scan, 7d-per-row coverage), matching the old
  //                   per-period cardWD depositor sub-select exactly.
  //   attr_wd30 — withdrawn units in the last 30d belonging to a
  //               coverage-depositor AND one of this creator's sessions.
  //   events — UNION of the three contribution streams per user/event time,
  //            cross-joined against every window so each event lands in all
  //            windows it qualifies for, then summed per user × period.
  //
  // NB the cardWD filter sets (wd_sessions / wd_depositors) are
  // deliberately UNBOUNDED to preserve the OLD numbers exactly — the old
  // 30-day-window cardWD query bounded only the withdrawal event
  // (`wu.withdrawn_at >= NOW() - 30d`), never the depositor or session
  // membership sub-selects. The supporting acu indexes
  // (idx_acu_affiliate_user_created_at, idx_acu_referred_user_created_at)
  // keep these unbounded membership scans fast; materializing them ONCE
  // here (instead of re-running the sub-select per period as the old code
  // did) is the speed win.
  const perUserSql = `WITH attr_dep30 AS (
       SELECT lt.user_id, u.username, u.image, lt.created_at,
              lt.amount::numeric AS amount
         FROM ledger_transactions lt
         JOIN "user" u ON u.id = lt.user_id
        WHERE lt.type::text = 'deposit'
          AND lt.status = 'completed'
          AND lt.created_at >= NOW() - INTERVAL '30 days'
          AND u.role NOT IN ('admin', 'support', 'creator')
          AND u.id != $1${blacklistAnd}
          AND $1 = ${COVERING_CREATOR_SQL}
     ),
     creator_wager30 AS (
       SELECT acu.referred_user_id AS user_id, u.username, u.image,
              acu.created_at, acu.wager_amount_usd::numeric AS amount
         FROM affiliate_code_usages acu
         JOIN "user" u ON u.id = acu.referred_user_id
        WHERE acu.affiliate_user_id = $1
          AND acu.usage_type::text = 'wager'
          AND acu.created_at >= NOW() - INTERVAL '30 days'
          AND u.role NOT IN ('admin', 'support', 'creator')
          AND u.id != $1${blacklistAnd}
     ),
     wd_sessions AS (
       SELECT DISTINCT acu.game_session_id
         FROM affiliate_code_usages acu
         JOIN "user" u ON u.id = acu.referred_user_id
        WHERE acu.affiliate_user_id = $1
          AND acu.usage_type::text = 'wager'
          AND acu.game_session_id IS NOT NULL
          AND u.role NOT IN ('admin', 'support', 'creator')
          AND u.id != $1${blacklistAnd}
     ),
     wd_depositors AS (
       SELECT DISTINCT lt.user_id
         FROM ledger_transactions lt
        WHERE lt.type::text = 'deposit' AND lt.status = 'completed'
          AND $1 = ${COVERING_CREATOR_SQL}
     ),
     attr_wd30 AS (
       SELECT wu.user_id, u.username, u.image, wu.withdrawn_at AS created_at,
              wu.value AS amount
         FROM ${WITHDRAWN_UNITS_SQL} wu
         JOIN "user" u ON u.id = wu.user_id
        WHERE wu.withdrawn_at >= NOW() - INTERVAL '30 days'
          AND wu.user_id IN (SELECT user_id FROM wd_depositors)
          AND wu.source_id IN (SELECT game_session_id FROM wd_sessions)
          AND u.role NOT IN ('admin', 'support', 'creator')
          AND u.id != $1${blacklistAnd}
     ),
     events AS (
       SELECT user_id, username, image, created_at,
              amount AS dep, 0::numeric AS wag, 0::numeric AS cwd
         FROM attr_dep30
       UNION ALL
       SELECT user_id, username, image, created_at,
              0::numeric AS dep, amount AS wag, 0::numeric AS cwd
         FROM creator_wager30
       UNION ALL
       SELECT user_id, username, image, created_at,
              0::numeric AS dep, 0::numeric AS wag, amount AS cwd
         FROM attr_wd30
     )
     SELECT e.user_id AS user_id,
            MAX(e.username) AS username,
            MAX(e.image) AS image,
            p.period,
            COALESCE(SUM(e.dep), 0)::text AS deposits,
            COALESCE(SUM(e.wag), 0)::text AS wagered,
            COALESCE(SUM(e.cwd), 0)::text AS card_withdrawals
       FROM events e
       CROSS JOIN ${PERIODS_WITH_INTERVAL_SQL}
      WHERE e.created_at >= NOW() - p.intv
      GROUP BY e.user_id, p.period
     HAVING SUM(e.dep) > 0 OR SUM(e.wag) > 0 OR SUM(e.cwd) > 0`;

  // Per-period card-withdrawal HEADLINE — mirrors the OLD per-period cardWD
  // query verbatim (the displayed cardWithdrawals number). Unbounded
  // depositor + session membership sets (only the withdrawal event is 30d-
  // bounded), and — matching the old per-period query — NO staff/blacklist
  // filter on the withdrawing user. Shares the same membership-set shape as
  // the popover's `wd_depositors` / `wd_sessions`, materialized once.
  const cardWdHeadlineSql = `WITH wd_sessions AS (
       SELECT DISTINCT acu.game_session_id
         FROM affiliate_code_usages acu
         JOIN "user" u ON u.id = acu.referred_user_id
        WHERE acu.affiliate_user_id = $1
          AND acu.usage_type::text = 'wager'
          AND acu.game_session_id IS NOT NULL
          AND u.role NOT IN ('admin', 'support', 'creator')
          AND u.id != $1${blacklistAnd}
     ),
     wd_depositors AS (
       SELECT DISTINCT lt.user_id
         FROM ledger_transactions lt
        WHERE lt.type::text = 'deposit' AND lt.status = 'completed'
          AND $1 = ${COVERING_CREATOR_SQL}
     )
     SELECT p.period,
            COALESCE(SUM(CASE
              WHEN wu.withdrawn_at >= NOW() - p.intv THEN wu.value
              ELSE 0
            END), 0)::text AS card_withdrawals
       FROM ${PERIODS_WITH_INTERVAL_SQL}
       LEFT JOIN ${WITHDRAWN_UNITS_SQL} wu
         ON wu.withdrawn_at >= NOW() - INTERVAL '30 days'
        AND wu.user_id IN (SELECT user_id FROM wd_depositors)
        AND wu.source_id IN (SELECT game_session_id FROM wd_sessions)
      GROUP BY p.period`;

  // ── 365-day LIFETIME block (single scan) ─────────────────────────────
  //
  // Same shapes over the wider window, returning the lifetime sums PLUS the
  // coverage-depositor id set (drives the popover isDepositor flag) in ONE
  // row — folding in the old standalone depositor-id scan.
  //
  // Faithful-numbers note: the old lifetime query used TWO different
  // depositor sets — `total_deposits` summed the STAFF-EXCLUDED cohort
  // (`attr_dep` here), whereas the cardWD depositor membership AND the
  // standalone depositor-id scan used a NO-staff-filter 365d set
  // (`cov_depositors_raw` here). We keep both distinct so every figure
  // matches byte-for-byte. The cardWD sum (`attr_wd`) has no outer-user
  // staff filter either, exactly like the old lifetime cardWD sub-select.
  const lifetimeSql = `WITH attr_dep AS (
       SELECT lt.amount::numeric AS amount
         FROM ledger_transactions lt
         JOIN "user" u ON u.id = lt.user_id
        WHERE lt.type::text = 'deposit'
          AND lt.status = 'completed'
          AND lt.created_at >= NOW() - ${LIFETIME_LOOKBACK_INTERVAL}
          AND u.role NOT IN ('admin', 'support', 'creator')
          AND u.id != $1${blacklistAnd}
          AND $1 = ${COVERING_CREATOR_SQL}
     ),
     cov_depositors_raw AS (
       SELECT DISTINCT lt.user_id
         FROM ledger_transactions lt
        WHERE lt.type::text = 'deposit' AND lt.status = 'completed'
          AND lt.created_at >= NOW() - ${LIFETIME_LOOKBACK_INTERVAL}
          AND $1 = ${COVERING_CREATOR_SQL}
     ),
     creator_wager AS (
       SELECT acu.wager_amount_usd::numeric AS amount
         FROM affiliate_code_usages acu
         JOIN "user" u ON u.id = acu.referred_user_id
        WHERE acu.affiliate_user_id = $1
          AND acu.usage_type::text = 'wager'
          AND acu.created_at >= NOW() - ${LIFETIME_LOOKBACK_INTERVAL}
          AND u.role NOT IN ('admin', 'support', 'creator')
          AND u.id != $1${blacklistAnd}
     ),
     creator_sessions AS (
       SELECT DISTINCT acu.game_session_id
         FROM affiliate_code_usages acu
         JOIN "user" u ON u.id = acu.referred_user_id
        WHERE acu.affiliate_user_id = $1
          AND acu.usage_type::text = 'wager'
          AND acu.created_at >= NOW() - ${LIFETIME_LOOKBACK_INTERVAL}
          AND acu.game_session_id IS NOT NULL
          AND u.role NOT IN ('admin', 'support', 'creator')
          AND u.id != $1${blacklistAnd}
     ),
     attr_wd AS (
       SELECT wu.value AS amount
         FROM ${WITHDRAWN_UNITS_SQL} wu
        WHERE wu.withdrawn_at >= NOW() - ${LIFETIME_LOOKBACK_INTERVAL}
          AND wu.user_id IN (SELECT user_id FROM cov_depositors_raw)
          AND wu.source_id IN (SELECT game_session_id FROM creator_sessions)
     )
     SELECT
       (SELECT COALESCE(SUM(amount), 0)::text FROM attr_dep)         AS total_deposits,
       (SELECT COALESCE(SUM(amount), 0)::text FROM creator_wager)    AS total_wagered,
       (SELECT COALESCE(SUM(amount), 0)::text FROM attr_wd)          AS total_card_withdrawals,
       (SELECT COALESCE(ARRAY_AGG(user_id), ARRAY[]::text[]) FROM cov_depositors_raw) AS depositor_ids`;

  // Run the three scans inside ONE interactive transaction with the per-
  // statement timeout raised via `SET LOCAL` so the COLD populating scan
  // can complete instead of being killed by the 30s global pool timeout.
  // `SET LOCAL` reverts on commit, so it never leaks to other pool users.
  // The scans run back-to-back on the single tx connection, but each is now
  // a single-pass set-based scan (the coverage subquery is evaluated once
  // per deposit row per scan instead of six times across the call), so the
  // total stays well within the raised budget — and after the first run the
  // 5-min cache serves every subsequent load.
  const [perUserRows, cardWdHeadlineRows, lifetimeRows] = await Promise.all([
    queryMainRows<PerUserPeriodRow[]>(perUserSql, userId),
    queryMainRows<PeriodCardWdRow[]>(cardWdHeadlineSql, userId),
    queryMainRows<LifetimeRow[]>(lifetimeSql, userId),
  ]);

  return assemble(perUserRows, cardWdHeadlineRows, lifetimeRows);
}

function assemble(
  perUserRows: PerUserPeriodRow[],
  cardWdHeadlineRows: PeriodCardWdRow[],
  lifetimeRows: LifetimeRow[],
): CreatorPnlData {
  const depositorIds = new Set(lifetimeRows[0]?.depositor_ids ?? []);

  type Bucket = {
    username: string | null;
    image: string | null;
    deposits: number;
    wagered: number;
    cardWithdrawals: number;
  };
  const usersByPeriod = new Map<string, Map<string, Bucket>>();

  // Per-period deposits + wagered HEADLINE totals, summed across ALL users.
  // The per-user rows are SQL-uncapped (the 50-row cap is applied later in
  // buildUsers), and the old per-period deposit/wager queries used filters
  // IDENTICAL to the per-user ones, so these sums match the old headline
  // exactly. (Card-withdrawals headline does NOT come from here — see below.)
  const headline = new Map<string, { deposits: number; wagered: number }>();

  for (const r of perUserRows) {
    const deposits = Number(r.deposits);
    const wagered = Number(r.wagered);
    const cardWithdrawals = Number(r.card_withdrawals);

    let perPeriod = usersByPeriod.get(r.period);
    if (!perPeriod) {
      perPeriod = new Map();
      usersByPeriod.set(r.period, perPeriod);
    }
    perPeriod.set(r.user_id, {
      username: r.username,
      image: r.image,
      deposits,
      wagered,
      cardWithdrawals,
    });

    let h = headline.get(r.period);
    if (!h) {
      h = { deposits: 0, wagered: 0 };
      headline.set(r.period, h);
    }
    h.deposits += deposits;
    h.wagered += wagered;
  }

  // Card-withdrawals HEADLINE — from its dedicated query, which mirrors the
  // old per-period cardWD filters verbatim (no staff filter on the
  // withdrawing user), so the displayed number is byte-identical.
  const cardWdByPeriod = new Map(
    cardWdHeadlineRows.map((r) => [r.period, Number(r.card_withdrawals)]),
  );

  function buildUsers(period: string): CreatorPnlPeriodUser[] {
    const perPeriod = usersByPeriod.get(period);
    if (!perPeriod) return [];
    const rows: CreatorPnlPeriodUser[] = [];
    for (const [userId, b] of perPeriod) {
      const isDepositor = depositorIds.has(userId);
      // Non-depositors (no coverage-attributed deposit under this
      // creator) don't contribute to PnL — the cardWD CTE filters them
      // out at the SQL level, so `b.cardWithdrawals` is always 0 for
      // non-depositors. Force pnl=0 explicitly so the popover row reads as
      // "excluded" rather than "happened to net 0".
      const pnl = isDepositor ? b.deposits - b.cardWithdrawals : 0;
      rows.push({
        userId,
        username: b.username,
        image: b.image,
        deposits: b.deposits,
        wagered: b.wagered,
        cardWithdrawals: b.cardWithdrawals,
        pnl,
        isDepositor,
      });
    }
    rows.sort((a, b) => {
      const d = Math.abs(b.pnl) - Math.abs(a.pnl);
      if (d !== 0) return d;
      const dep = b.deposits - a.deposits;
      if (dep !== 0) return dep;
      const wag = b.wagered - a.wagered;
      if (wag !== 0) return wag;
      return (a.username ?? "").localeCompare(b.username ?? "");
    });
    return rows.slice(0, USERS_PER_PERIOD_CAP);
  }

  const byPeriod: CreatorPnlPeriod[] = PERIODS.map((period: PeriodKey) => {
    const h = headline.get(period);
    const deposits = h?.deposits ?? 0;
    const wagered = h?.wagered ?? 0;
    const cardWithdrawals = cardWdByPeriod.get(period) ?? 0;
    return {
      period,
      deposits,
      wagered,
      cardWithdrawals,
      pnl: deposits - cardWithdrawals,
      users: buildUsers(period),
    };
  });

  const lr = lifetimeRows[0];
  const totalDeposits = Number(lr?.total_deposits ?? 0);
  const totalWagered = Number(lr?.total_wagered ?? 0);
  const totalCardWithdrawals = Number(lr?.total_card_withdrawals ?? 0);
  const lifetime: CreatorLifetimePnl = {
    totalDeposits,
    totalWagered,
    totalCardWithdrawals,
    pnl: totalDeposits - totalCardWithdrawals,
  };

  return { byPeriod, lifetime };
}
