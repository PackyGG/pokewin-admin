import { getDb } from "@/lib/db";
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
 */
const PERIODS = ["24h", "3d", "7d", "14d", "30d"] as const;

type PeriodKey = (typeof PERIODS)[number];

const PERIODS_VALUES_SQL = `(VALUES ('24h'),('3d'),('7d'),('14d'),('30d')) AS p(period)`;
const PERIOD_INTERVAL_CASE = `CASE p.period
  WHEN '24h' THEN INTERVAL '24 hours'
  WHEN '3d'  THEN INTERVAL '3 days'
  WHEN '7d'  THEN INTERVAL '7 days'
  WHEN '14d' THEN INTERVAL '14 days'
  WHEN '30d' THEN INTERVAL '30 days'
END`;

// Same period set with the interval inline — used by the per-user
// breakdown queries that cross-join against each window.
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
const COVERING_CREATOR_SQL = `(
  SELECT acu_c.affiliate_user_id
    FROM affiliate_code_usages acu_c
   WHERE acu_c.referred_user_id = lt.user_id
     AND acu_c.created_at <= lt.created_at
     AND acu_c.created_at >= lt.created_at - INTERVAL '7 days'
   ORDER BY acu_c.created_at DESC
   LIMIT 1
)`;

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
const WITHDRAWN_UNITS_SQL = `(
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

export async function getCreatorPnl(userId: string): Promise<CreatorPnlData> {
  const db = await getDb();
  const blacklistAnd = await buildBlacklistAnd();

  // Per-period coverage-attributed deposits. Source: ledger_transactions
  // (the canonical record of every deposit) joined with the COVERING
  // creator at the time of each deposit.
  const depositRowsP = db.$queryRawUnsafe<
    {
      period: string;
      deposits: string;
    }[]
  >(
    `SELECT p.period,
            COALESCE(SUM(CASE
              WHEN lt.created_at >= NOW() - (${PERIOD_INTERVAL_CASE})
                THEN lt.amount::numeric
              ELSE 0
            END), 0)::text AS deposits
       FROM ${PERIODS_VALUES_SQL}
       LEFT JOIN ledger_transactions lt
         ON lt.type = 'deposit'
        AND lt.status = 'completed'
        AND lt.created_at >= NOW() - INTERVAL '30 days'
       LEFT JOIN "user" u ON u.id = lt.user_id
      WHERE lt.id IS NULL OR (
            u.role NOT IN ('admin', 'support', 'creator')
        AND u.id != $1${blacklistAnd}
        AND $1 = ${COVERING_CREATOR_SQL}
      )
      GROUP BY p.period`,
    userId,
  );

  // Per-period wagers — unchanged. acu.wager_amount_usd is correctly
  // attributed at event time by the backend.
  const wagerRowsP = db.$queryRawUnsafe<
    {
      period: string;
      wagered: string;
    }[]
  >(
    `SELECT p.period,
            COALESCE(SUM(CASE
              WHEN acu.created_at >= NOW() - (${PERIOD_INTERVAL_CASE})
                THEN acu.wager_amount_usd::numeric
              ELSE 0
            END), 0)::text AS wagered
       FROM ${PERIODS_VALUES_SQL}
       LEFT JOIN affiliate_code_usages acu
         ON acu.affiliate_user_id = $1
        AND acu.usage_type::text = 'wager'
        AND acu.created_at >= NOW() - INTERVAL '30 days'
       LEFT JOIN "user" u ON u.id = acu.referred_user_id
      WHERE acu.id IS NULL OR (
            u.role NOT IN ('admin', 'support', 'creator')
        AND u.id != $1${blacklistAnd}
      )
      GROUP BY p.period`,
    userId,
  );

  // Per-period card withdrawals — value of physical cards AND
  // session-linked vouchers that left the house in the window via a
  // card_withdrawal_requests row. Sourced from WITHDRAWN_UNITS_SQL
  // which unions inventory items (`cwr.inventory_item_ids`) and
  // session-linked vouchers (`cwr.voucher_ids` for origins
  // `battle_excess_to_voucher`, `pack_borrow_to_voucher`).
  //
  // Each unit must:
  //   • come from a session wagered under this creator's code
  //     (`wu.source_id ∈ creator's acu wager sessions`), AND
  //   • belong to a user who has at least one coverage-attributed
  //     deposit under this creator (depositor filter).
  const cardWdRowsP = db.$queryRawUnsafe<
    {
      period: string;
      card_withdrawals: string;
    }[]
  >(
    `SELECT p.period,
            COALESCE(SUM(CASE
              WHEN wu.withdrawn_at >= NOW() - (${PERIOD_INTERVAL_CASE})
                THEN wu.value
              ELSE 0
            END), 0)::text AS card_withdrawals
       FROM ${PERIODS_VALUES_SQL}
       LEFT JOIN ${WITHDRAWN_UNITS_SQL} wu
         ON wu.withdrawn_at >= NOW() - INTERVAL '30 days'
        AND wu.user_id IN (
          SELECT DISTINCT lt.user_id
            FROM ledger_transactions lt
           WHERE lt.type = 'deposit' AND lt.status = 'completed'
             AND $1 = ${COVERING_CREATOR_SQL}
        )
        AND wu.source_id IN (
          SELECT DISTINCT acu.game_session_id
            FROM affiliate_code_usages acu
            JOIN "user" u ON u.id = acu.referred_user_id
           WHERE acu.affiliate_user_id = $1
             AND acu.usage_type::text = 'wager'
             AND acu.game_session_id IS NOT NULL
             AND u.role NOT IN ('admin', 'support', 'creator')
             AND u.id != $1${blacklistAnd}
        )
      GROUP BY p.period`,
    userId,
  );

  // Lifetime aggregates — same shape as per-period, no window cap.
  const lifetimeRowsP = db.$queryRawUnsafe<
    {
      total_deposits: string;
      total_wagered: string;
      total_card_withdrawals: string;
    }[]
  >(
    `SELECT
        (SELECT COALESCE(SUM(lt.amount::numeric), 0)::text
           FROM ledger_transactions lt
           JOIN "user" u ON u.id = lt.user_id
          WHERE lt.type = 'deposit'
            AND lt.status = 'completed'
            AND u.role NOT IN ('admin', 'support', 'creator')
            AND u.id != $1${blacklistAnd}
            AND $1 = ${COVERING_CREATOR_SQL}
        ) AS total_deposits,
        (SELECT COALESCE(SUM(acu.wager_amount_usd::numeric), 0)::text
           FROM affiliate_code_usages acu
           JOIN "user" u ON u.id = acu.referred_user_id
          WHERE acu.affiliate_user_id = $1
            AND acu.usage_type::text = 'wager'
            AND u.role NOT IN ('admin', 'support', 'creator')
            AND u.id != $1${blacklistAnd}
        ) AS total_wagered,
        (SELECT COALESCE(SUM(wu.value), 0)::text
           FROM ${WITHDRAWN_UNITS_SQL} wu
          WHERE wu.user_id IN (
              SELECT DISTINCT lt.user_id
                FROM ledger_transactions lt
               WHERE lt.type = 'deposit' AND lt.status = 'completed'
                 AND $1 = ${COVERING_CREATOR_SQL}
            )
            AND wu.source_id IN (
              SELECT DISTINCT acu.game_session_id
                FROM affiliate_code_usages acu
                JOIN "user" u ON u.id = acu.referred_user_id
               WHERE acu.affiliate_user_id = $1
                 AND acu.usage_type::text = 'wager'
                 AND acu.game_session_id IS NOT NULL
                 AND u.role NOT IN ('admin', 'support', 'creator')
                 AND u.id != $1${blacklistAnd}
            )
        ) AS total_card_withdrawals`,
    userId,
  );

  // Per-user-per-period coverage-attributed deposits.
  const depositUserRowsP = db.$queryRawUnsafe<
    {
      user_id: string;
      username: string | null;
      image: string | null;
      period: string;
      amount: string;
    }[]
  >(
    `SELECT lt.user_id AS user_id,
            u.username,
            u.image,
            p.period,
            SUM(lt.amount::numeric)::text AS amount
       FROM ledger_transactions lt
       JOIN "user" u ON u.id = lt.user_id
       CROSS JOIN ${PERIODS_WITH_INTERVAL_SQL}
      WHERE lt.type = 'deposit'
        AND lt.status = 'completed'
        AND lt.created_at >= NOW() - INTERVAL '30 days'
        AND lt.created_at >= NOW() - p.intv
        AND u.role NOT IN ('admin', 'support', 'creator')
        AND u.id != $1${blacklistAnd}
        AND $1 = ${COVERING_CREATOR_SQL}
      GROUP BY lt.user_id, u.username, u.image, p.period
     HAVING SUM(lt.amount::numeric) > 0`,
    userId,
  );

  // Per-user-per-period wagers — unchanged from acu.
  const wagerUserRowsP = db.$queryRawUnsafe<
    {
      user_id: string;
      username: string | null;
      image: string | null;
      period: string;
      amount: string;
    }[]
  >(
    `SELECT acu.referred_user_id AS user_id,
            u.username,
            u.image,
            p.period,
            SUM(acu.wager_amount_usd::numeric)::text AS amount
       FROM affiliate_code_usages acu
       JOIN "user" u ON u.id = acu.referred_user_id
       CROSS JOIN ${PERIODS_WITH_INTERVAL_SQL}
      WHERE acu.affiliate_user_id = $1
        AND acu.usage_type::text = 'wager'
        AND acu.created_at >= NOW() - INTERVAL '30 days'
        AND acu.created_at >= NOW() - p.intv
        AND u.role NOT IN ('admin', 'support', 'creator')
        AND u.id != $1${blacklistAnd}
      GROUP BY acu.referred_user_id, u.username, u.image, p.period
     HAVING SUM(acu.wager_amount_usd::numeric) > 0`,
    userId,
  );

  // Per-user-per-period card withdrawals, with coverage-depositor
  // filter for consistency with the headline. Includes both cards
  // and session-linked vouchers via WITHDRAWN_UNITS_SQL.
  const cardWdUserRowsP = db.$queryRawUnsafe<
    {
      user_id: string;
      username: string | null;
      image: string | null;
      period: string;
      amount: string;
    }[]
  >(
    `SELECT wu.user_id AS user_id,
            u.username,
            u.image,
            p.period,
            SUM(wu.value)::text AS amount
       FROM ${WITHDRAWN_UNITS_SQL} wu
       JOIN "user" u ON u.id = wu.user_id
       CROSS JOIN ${PERIODS_WITH_INTERVAL_SQL}
      WHERE wu.withdrawn_at >= NOW() - INTERVAL '30 days'
        AND wu.withdrawn_at >= NOW() - p.intv
        AND wu.user_id IN (
          SELECT DISTINCT lt.user_id
            FROM ledger_transactions lt
           WHERE lt.type = 'deposit' AND lt.status = 'completed'
             AND $1 = ${COVERING_CREATOR_SQL}
        )
        AND wu.source_id IN (
          SELECT DISTINCT acu.game_session_id
            FROM affiliate_code_usages acu
            JOIN "user" u2 ON u2.id = acu.referred_user_id
           WHERE acu.affiliate_user_id = $1
             AND acu.usage_type::text = 'wager'
             AND acu.game_session_id IS NOT NULL
             AND u2.role NOT IN ('admin', 'support', 'creator')
             AND u2.id != $1${blacklistAnd.replace(/\bu\.id\b/g, "u2.id")}
        )
        AND u.role NOT IN ('admin', 'support', 'creator')
        AND u.id != $1${blacklistAnd}
      GROUP BY wu.user_id, u.username, u.image, p.period
     HAVING SUM(wu.value) > 0`,
    userId,
  );

  // Coverage-depositor set — users with at least one coverage-attributed
  // deposit under this creator. Drives the isDepositor flag on popover
  // rows; redefined from the old "any acu deposit row" to align with
  // the new ledger+coverage model.
  const depositorIdsP = db.$queryRawUnsafe<{ user_id: string }[]>(
    `SELECT DISTINCT lt.user_id AS user_id
       FROM ledger_transactions lt
      WHERE lt.type = 'deposit'
        AND lt.status = 'completed'
        AND $1 = ${COVERING_CREATOR_SQL}`,
    userId,
  );

  const [
    depositRows,
    wagerRows,
    cardWdRows,
    lifetimeRows,
    depositUserRows,
    wagerUserRows,
    cardWdUserRows,
    depositorIdRows,
  ] = await Promise.all([
    depositRowsP,
    wagerRowsP,
    cardWdRowsP,
    lifetimeRowsP,
    depositUserRowsP,
    wagerUserRowsP,
    cardWdUserRowsP,
    depositorIdsP,
  ]);

  const depositorIds = new Set(depositorIdRows.map((r) => r.user_id));

  const depositsByPeriod = new Map(
    depositRows.map((r) => [r.period, r.deposits]),
  );
  const wageredByPeriod = new Map(wagerRows.map((r) => [r.period, r.wagered]));
  const cardWdByPeriod = new Map(
    cardWdRows.map((r) => [r.period, r.card_withdrawals]),
  );

  type Bucket = {
    username: string | null;
    image: string | null;
    deposits: number;
    wagered: number;
    cardWithdrawals: number;
  };
  const usersByPeriod = new Map<string, Map<string, Bucket>>();

  function bump(
    period: string,
    userId: string,
    username: string | null,
    image: string | null,
    field: "deposits" | "wagered" | "cardWithdrawals",
    amount: number,
  ) {
    let perPeriod = usersByPeriod.get(period);
    if (!perPeriod) {
      perPeriod = new Map();
      usersByPeriod.set(period, perPeriod);
    }
    let bucket = perPeriod.get(userId);
    if (!bucket) {
      bucket = {
        username,
        image,
        deposits: 0,
        wagered: 0,
        cardWithdrawals: 0,
      };
      perPeriod.set(userId, bucket);
    }
    bucket[field] += amount;
  }

  for (const r of depositUserRows) {
    bump(r.period, r.user_id, r.username, r.image, "deposits", Number(r.amount));
  }
  for (const r of wagerUserRows) {
    bump(r.period, r.user_id, r.username, r.image, "wagered", Number(r.amount));
  }
  for (const r of cardWdUserRows) {
    bump(
      r.period,
      r.user_id,
      r.username,
      r.image,
      "cardWithdrawals",
      Number(r.amount),
    );
  }

  function buildUsers(period: string): CreatorPnlPeriodUser[] {
    const perPeriod = usersByPeriod.get(period);
    if (!perPeriod) return [];
    const rows: CreatorPnlPeriodUser[] = [];
    for (const [userId, b] of perPeriod) {
      const isDepositor = depositorIds.has(userId);
      // Non-depositors (no coverage-attributed deposit under this
      // creator) don't contribute to PnL — the cardWD user query
      // filters them out at the SQL level, so `b.cardWithdrawals` is
      // always 0 for non-depositors. Force pnl=0 explicitly so the
      // popover row reads as "excluded" rather than "happened to
      // net 0".
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
    const deposits = Number(depositsByPeriod.get(period) ?? 0);
    const wagered = Number(wageredByPeriod.get(period) ?? 0);
    const cardWithdrawals = Number(cardWdByPeriod.get(period) ?? 0);
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
