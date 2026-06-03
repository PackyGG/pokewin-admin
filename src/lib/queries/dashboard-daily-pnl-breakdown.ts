import "server-only";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { blacklistNotInClause } from "./_blacklist";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

/**
 * dashboard-daily-pnl-breakdown.ts — the click-to-load drilldown behind ONE
 * bar of the dashboard's Daily P&L (30-day) chart.
 *
 * ─── IT MIRRORS getDailyPnl (src/lib/queries/pnl.ts) EXACTLY ───────────────
 *
 * The Daily-P&L bar for a UTC calendar day D is built by `getDailyPnl` as the
 * per-day form of the canonical windowed formula:
 *
 *   pnl(D) = deposits(D)
 *          − ( |manualWd(D)| + cardWd(D) )
 *          − balanceChange(D)
 *          − inventoryChange(D)
 *          − voucherChange(D)
 *
 * with the SAME scope (`role NOT IN ('admin','support')` + the admin-managed
 * excluded-users blacklist — NOT the creator-dropping `getMetricsScope`),
 * the SAME per-component event-date bucketing, and the SAME ledger event
 * types.
 *
 * This module re-expresses that math for a SINGLE day D so the modal's
 * summary RECONCILES to the bar height by construction:
 *
 *   • Bucketing: `getDailyPnl` groups by `DATE(<eventCol>)` and keys the
 *     accumulator with `new Date(date).toISOString().slice(0,10)` — a UTC
 *     date string. We select exactly the rows that fell into day D by
 *     filtering `DATE(<eventCol>) = $1::date` on the SAME event column per
 *     component. Both queries hit the same DB session, so `DATE()` buckets
 *     identically and the row set for D is identical.
 *
 * NOT cached and NOT called on the dashboard's initial render — it runs ONLY
 * when an admin clicks a bar (the modal fires a server action that calls
 * this), per CLAUDE.md's active-timeframe / lazy rule. The dashboard streams
 * the 30 daily points; this single-day drill is strictly click-to-load.
 *
 * House-POV colouring is applied at the call site (the modal): a deposit /
 * wager is the house taking the user's money (🟢 emerald); a withdrawal,
 * balance credit, inventory win or voucher issue is the user gaining (🔴
 * rose) — see CLAUDE.md.
 *
 * ─── ROW CAPS ──────────────────────────────────────────────────────────────
 *
 * The SUMMARY totals are computed by un-capped `SUM(...)` aggregates (the
 * identical math `getDailyPnl` uses) so the headline always reconciles to the
 * bar — independent of how many underlying rows there are. The per-component
 * RECORD lists below them are capped (ROW_CAP, ordered by magnitude DESC) so
 * a very busy day can't ship tens of thousands of rows across the RSC
 * boundary. When a component is truncated the response carries the true total
 * count + the capped flag so the modal can note "showing top N of M".
 */

/**
 * Max rows returned per component record list. The balance-change ledger feed
 * is the only one that can realistically be large on a busy day (every
 * completed ledger row for the day, all users in scope); the others are far
 * smaller. Ordered by |contribution| DESC inside the query so the loudest
 * movements always surface even when truncated. The summary totals are
 * un-capped, so a truncated list never breaks reconciliation.
 */
export const DAILY_PNL_BREAKDOWN_ROW_CAP = 200;

/** Hard clamp on the SQL LIMIT regardless of caller input (defence-in-depth). */
const MAX_ROW_CAP = 500;

/** One per-component summary figure (matches a getDailyPnl term). */
export type DailyPnlBreakdownSummary = {
  /** YYYY-MM-DD (UTC) — the calendar day this drill covers. */
  date: string;
  /** Σ completed deposits credited that day (House-POV emerald). */
  deposits: number;
  /**
   * Gross money-out that day: |manual withdrawal| + card withdrawal —
   * clean positive, identical to the bar's `withdrawals` hover value
   * (House-POV rose).
   */
  withdrawals: number;
  /**
   * Net change in user available + locked balance that day (signed) —
   * identical to the bar's `balanceChange`. A liability that GREW is positive.
   */
  balanceChange: number;
  /** Cards obtained − cards sold/exchanged that day (signed). */
  inventoryChange: number;
  /** Vouchers issued − vouchers claimed that day (signed). */
  voucherChange: number;
  /**
   * House P&L for the day — the five terms above combined with the
   * canonical formula. Equals the bar height by construction.
   */
  pnl: number;
};

/** A single underlying ledger/inventory/voucher record in the drill. */
export type DailyPnlBreakdownRecord = {
  id: string;
  userId: string;
  username: string | null;
  /**
   * The record's SIGNED dollar contribution to its component (e.g. a
   * deposit is +amount; a balance-change row is balance_after −
   * balance_before; a disposed inventory card is −value). The call site
   * colours it House-POV.
   */
  amount: number;
  /** A short type/kind label for the row (e.g. ledger type, "obtained"). */
  kind: string;
  /** Event instant (ISO) — bucketed into this day by its own event column. */
  at: string;
};

/** A capped list of records for one component, with truncation metadata. */
export type DailyPnlBreakdownSection = {
  rows: DailyPnlBreakdownRecord[];
  /** True total row count for the component (un-capped). */
  totalCount: number;
  /** Whether `rows` was truncated to the cap. */
  capped: boolean;
};

export type DailyPnlBreakdown = {
  summary: DailyPnlBreakdownSummary;
  /** Completed `deposit` ledger rows (positive). */
  deposits: DailyPnlBreakdownSection;
  /**
   * Money-out rows: manual-withdrawal admin adjustments (ledger) + card
   * withdrawals (card_withdrawal_requests). Shown as negative contributions.
   */
  withdrawals: DailyPnlBreakdownSection;
  /**
   * Every completed ledger row for the day (any type), each carrying its
   * balance-Δ as the signed contribution — the rows that compose the
   * "User Balance change" term. The loudest |Δ| first.
   */
  balanceChanges: DailyPnlBreakdownSection;
  /** Inventory obtained (+value) and disposed (−value) rows. */
  inventoryChanges: DailyPnlBreakdownSection;
  /** Voucher issued (+value) and claimed (−value) rows. */
  voucherChanges: DailyPnlBreakdownSection;
  /** The cap applied to each section's row list (for the modal note). */
  rowCap: number;
};

/** Strict YYYY-MM-DD guard — the value comes from the client (bar payload). */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve the full breakdown for one UTC calendar day. `dayUtc` must be a
 * `YYYY-MM-DD` string (one of the bar day keys). Throws on a malformed value
 * rather than silently widening the scan.
 */
export async function getDailyPnlBreakdown(
  dayUtc: string,
  rowCap = DAILY_PNL_BREAKDOWN_ROW_CAP,
): Promise<DailyPnlBreakdown> {
  if (!DAY_RE.test(dayUtc)) {
    throw new Error("Invalid day — expected YYYY-MM-DD.");
  }
  const cap = Math.max(1, Math.min(Math.trunc(rowCap), MAX_ROW_CAP));

  return withTiming("dashboard.dailyPnlBreakdown", async () => {
    const db = await getDb();
    const excluded = await getExcludedUserIds();
    const blacklist = blacklistNotInClause("u.id", excluded);
    // EXACT same scope getDailyPnl uses — staff dropped, blacklist dropped,
    // creators KEPT (this is the global P&L scope, NOT the creator-dropping
    // getMetricsScope). The `u` alias is bound inside the subquery only.
    const usersScope = `(SELECT id FROM "user" u WHERE u.role NOT IN ('admin', 'support') ${blacklist})`;

    // The day literal — `$DATE = '<dayUtc>'::date`. Inlined as a quoted date
    // literal (the value is regex-validated to YYYY-MM-DD above, so it cannot
    // carry injection) so the per-component `DATE(col) = <day>` predicate
    // matches getDailyPnl's bucketing exactly.
    const dayLit = `'${dayUtc}'::date`;

    // ─── SUMMARY aggregates (un-capped — these reconcile to the bar) ────────
    type LedgerAggRow = {
      deposits: number;
      manual_wd: number;
      balance_change: number;
    };
    type CardAggRow = { card_wd: number };
    type InvAggRow = { obtained: number; disposed: number };
    type VchAggRow = { issued: number; claimed: number };

    // ─── RECORD lists (capped, ordered by magnitude DESC) ───────────────────
    type LedgerRecRow = {
      id: string;
      user_id: string;
      username: string | null;
      delta: number;
      type: string;
      at: Date;
    };
    type WdLedgerRecRow = {
      id: string;
      user_id: string;
      username: string | null;
      amount: number;
      at: Date;
    };
    type CardRecRow = {
      id: string;
      user_id: string;
      username: string | null;
      amount: number;
      at: Date;
    };
    type CountRow = { n: number };
    type InvRecRow = {
      id: string;
      user_id: string;
      username: string | null;
      value: number;
      kind: string;
      at: Date;
    };
    type VchRecRow = {
      id: string;
      user_id: string;
      username: string | null;
      value: number;
      kind: string;
      at: Date;
    };

    const [
      ledgerAgg,
      cardAgg,
      invAgg,
      vchAgg,
      depositRows,
      depositCount,
      wdLedgerRows,
      wdLedgerCount,
      cardRows,
      cardCount,
      balanceRows,
      balanceCount,
      invRows,
      invCount,
      vchRows,
      vchCount,
    ] = await Promise.all([
      // Ledger aggregate — deposits, manual-withdrawal, signed balance-Δ.
      db.$queryRawUnsafe<LedgerAggRow[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN lt.type::text = 'deposit' THEN lt.amount::numeric ELSE 0 END), 0)::float8 AS deposits,
           COALESCE(SUM(CASE WHEN lt.type::text = 'admin_balance_adjustment'
                              AND lt.balance_after < lt.balance_before
                              AND lt.description ILIKE 'Manual withdrawal:%'
                             THEN lt.amount::numeric ELSE 0 END), 0)::float8 AS manual_wd,
           COALESCE(SUM((lt.balance_after - lt.balance_before)::numeric), 0)::float8 AS balance_change
         FROM ledger_transactions lt
         WHERE lt.status = 'completed' AND DATE(lt.created_at) = ${dayLit}
           AND lt.user_id IN ${usersScope}`,
      ),
      // Card-withdrawal aggregate — bucketed by COALESCE(shipped_at,
      // completed_at), the same finality key getDailyPnl uses.
      db.$queryRawUnsafe<CardAggRow[]>(
        `SELECT COALESCE(SUM(cwr.total_value_usd::numeric), 0)::float8 AS card_wd
         FROM card_withdrawal_requests cwr
         WHERE cwr.status IN ('completed', 'shipped')
           AND DATE(COALESCE(cwr.shipped_at, cwr.completed_at)) = ${dayLit}
           AND cwr.user_id IN ${usersScope}`,
      ),
      // Inventory aggregate — obtained (by obtained_at) vs disposed (by
      // COALESCE(sold_at, exchanged_at)). Same union split as getDailyPnl.
      db.$queryRawUnsafe<InvAggRow[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN DATE(ui.obtained_at) = ${dayLit} THEN ui.value_at_obtained::numeric ELSE 0 END), 0)::float8 AS obtained,
           COALESCE(SUM(CASE WHEN DATE(COALESCE(ui.sold_at, ui.exchanged_at)) = ${dayLit} THEN ui.value_at_obtained::numeric ELSE 0 END), 0)::float8 AS disposed
         FROM user_inventory ui
         WHERE (DATE(ui.obtained_at) = ${dayLit}
                OR DATE(COALESCE(ui.sold_at, ui.exchanged_at)) = ${dayLit})
           AND ui.user_id IN ${usersScope}`,
      ),
      // Voucher aggregate — issued (by created_at) vs claimed (by claimed_at).
      db.$queryRawUnsafe<VchAggRow[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN DATE(v.created_at) = ${dayLit} THEN v.value::numeric ELSE 0 END), 0)::float8 AS issued,
           COALESCE(SUM(CASE WHEN DATE(v.claimed_at) = ${dayLit} THEN v.value::numeric ELSE 0 END), 0)::float8 AS claimed
         FROM vouchers v
         WHERE (DATE(v.created_at) = ${dayLit} OR DATE(v.claimed_at) = ${dayLit})
           AND v.user_id IN ${usersScope}`,
      ),

      // ── Deposit records (positive). ──
      db.$queryRawUnsafe<LedgerRecRow[]>(
        `SELECT lt.id::text AS id, lt.user_id AS user_id, u.username AS username,
                lt.amount::float8 AS delta, lt.type::text AS type, lt.created_at AS at
         FROM ledger_transactions lt
         JOIN "user" u ON u.id = lt.user_id
         WHERE lt.status = 'completed' AND lt.type::text = 'deposit'
           AND DATE(lt.created_at) = ${dayLit}
           AND lt.user_id IN ${usersScope}
         ORDER BY lt.amount::numeric DESC
         LIMIT ${cap}`,
      ),
      db.$queryRawUnsafe<CountRow[]>(
        `SELECT COUNT(*)::int AS n
         FROM ledger_transactions lt
         WHERE lt.status = 'completed' AND lt.type::text = 'deposit'
           AND DATE(lt.created_at) = ${dayLit}
           AND lt.user_id IN ${usersScope}`,
      ),

      // ── Manual-withdrawal ledger records (negative money-out). ──
      db.$queryRawUnsafe<WdLedgerRecRow[]>(
        `SELECT lt.id::text AS id, lt.user_id AS user_id, u.username AS username,
                lt.amount::float8 AS amount, lt.created_at AS at
         FROM ledger_transactions lt
         JOIN "user" u ON u.id = lt.user_id
         WHERE lt.status = 'completed'
           AND lt.type::text = 'admin_balance_adjustment'
           AND lt.balance_after < lt.balance_before
           AND lt.description ILIKE 'Manual withdrawal:%'
           AND DATE(lt.created_at) = ${dayLit}
           AND lt.user_id IN ${usersScope}
         ORDER BY ABS(lt.amount::numeric) DESC
         LIMIT ${cap}`,
      ),
      db.$queryRawUnsafe<CountRow[]>(
        `SELECT COUNT(*)::int AS n
         FROM ledger_transactions lt
         WHERE lt.status = 'completed'
           AND lt.type::text = 'admin_balance_adjustment'
           AND lt.balance_after < lt.balance_before
           AND lt.description ILIKE 'Manual withdrawal:%'
           AND DATE(lt.created_at) = ${dayLit}
           AND lt.user_id IN ${usersScope}`,
      ),

      // ── Card-withdrawal records (negative money-out). ──
      db.$queryRawUnsafe<CardRecRow[]>(
        `SELECT cwr.id::text AS id, cwr.user_id AS user_id, u.username AS username,
                cwr.total_value_usd::float8 AS amount,
                COALESCE(cwr.shipped_at, cwr.completed_at) AS at
         FROM card_withdrawal_requests cwr
         JOIN "user" u ON u.id = cwr.user_id
         WHERE cwr.status IN ('completed', 'shipped')
           AND DATE(COALESCE(cwr.shipped_at, cwr.completed_at)) = ${dayLit}
           AND cwr.user_id IN ${usersScope}
         ORDER BY cwr.total_value_usd::numeric DESC
         LIMIT ${cap}`,
      ),
      db.$queryRawUnsafe<CountRow[]>(
        `SELECT COUNT(*)::int AS n
         FROM card_withdrawal_requests cwr
         WHERE cwr.status IN ('completed', 'shipped')
           AND DATE(COALESCE(cwr.shipped_at, cwr.completed_at)) = ${dayLit}
           AND cwr.user_id IN ${usersScope}`,
      ),

      // ── Balance-change ledger records — every completed row for the day,
      //    carrying its signed balance-Δ. Loudest |Δ| first. ──
      db.$queryRawUnsafe<LedgerRecRow[]>(
        `SELECT lt.id::text AS id, lt.user_id AS user_id, u.username AS username,
                (lt.balance_after - lt.balance_before)::float8 AS delta,
                lt.type::text AS type, lt.created_at AS at
         FROM ledger_transactions lt
         JOIN "user" u ON u.id = lt.user_id
         WHERE lt.status = 'completed' AND DATE(lt.created_at) = ${dayLit}
           AND lt.user_id IN ${usersScope}
         ORDER BY ABS(lt.balance_after - lt.balance_before) DESC
         LIMIT ${cap}`,
      ),
      db.$queryRawUnsafe<CountRow[]>(
        `SELECT COUNT(*)::int AS n
         FROM ledger_transactions lt
         WHERE lt.status = 'completed' AND DATE(lt.created_at) = ${dayLit}
           AND lt.user_id IN ${usersScope}`,
      ),

      // ── Inventory records — obtained (+) UNION disposed (−). ──
      db.$queryRawUnsafe<InvRecRow[]>(
        `SELECT id, user_id, username, value, kind, at FROM (
           SELECT ui.id::text AS id, ui.user_id AS user_id, u.username AS username,
                  ui.value_at_obtained::float8 AS value, 'obtained'::text AS kind,
                  ui.obtained_at AS at
           FROM user_inventory ui
           JOIN "user" u ON u.id = ui.user_id
           WHERE DATE(ui.obtained_at) = ${dayLit} AND ui.user_id IN ${usersScope}
           UNION ALL
           SELECT ui.id::text AS id, ui.user_id AS user_id, u.username AS username,
                  (-ui.value_at_obtained)::float8 AS value,
                  CASE WHEN ui.sold_at IS NOT NULL THEN 'sold' ELSE 'exchanged' END AS kind,
                  COALESCE(ui.sold_at, ui.exchanged_at) AS at
           FROM user_inventory ui
           JOIN "user" u ON u.id = ui.user_id
           WHERE DATE(COALESCE(ui.sold_at, ui.exchanged_at)) = ${dayLit}
             AND ui.user_id IN ${usersScope}
         ) x
         ORDER BY ABS(x.value) DESC
         LIMIT ${cap}`,
      ),
      db.$queryRawUnsafe<CountRow[]>(
        `SELECT (
           (SELECT COUNT(*) FROM user_inventory ui
             WHERE DATE(ui.obtained_at) = ${dayLit} AND ui.user_id IN ${usersScope})
           +
           (SELECT COUNT(*) FROM user_inventory ui
             WHERE DATE(COALESCE(ui.sold_at, ui.exchanged_at)) = ${dayLit}
               AND ui.user_id IN ${usersScope})
         )::int AS n`,
      ),

      // ── Voucher records — issued (+) UNION claimed (−). ──
      db.$queryRawUnsafe<VchRecRow[]>(
        `SELECT id, user_id, username, value, kind, at FROM (
           SELECT v.id::text AS id, v.user_id AS user_id, u.username AS username,
                  v.value::float8 AS value, 'issued'::text AS kind, v.created_at AS at
           FROM vouchers v
           JOIN "user" u ON u.id = v.user_id
           WHERE DATE(v.created_at) = ${dayLit} AND v.user_id IN ${usersScope}
           UNION ALL
           SELECT v.id::text AS id, v.user_id AS user_id, u.username AS username,
                  (-v.value)::float8 AS value, 'claimed'::text AS kind, v.claimed_at AS at
           FROM vouchers v
           JOIN "user" u ON u.id = v.user_id
           WHERE DATE(v.claimed_at) = ${dayLit} AND v.user_id IN ${usersScope}
         ) x
         ORDER BY ABS(x.value) DESC
         LIMIT ${cap}`,
      ),
      db.$queryRawUnsafe<CountRow[]>(
        `SELECT (
           (SELECT COUNT(*) FROM vouchers v
             WHERE DATE(v.created_at) = ${dayLit} AND v.user_id IN ${usersScope})
           +
           (SELECT COUNT(*) FROM vouchers v
             WHERE DATE(v.claimed_at) = ${dayLit} AND v.user_id IN ${usersScope})
         )::int AS n`,
      ),
    ]);

    // ─── Assemble the summary using the IDENTICAL getDailyPnl math ──────────
    const depositsTotal = ledgerAgg[0]?.deposits ?? 0;
    const manualWd = ledgerAgg[0]?.manual_wd ?? 0;
    const balanceChange = ledgerAgg[0]?.balance_change ?? 0;
    const cardWd = cardAgg[0]?.card_wd ?? 0;
    const obtained = invAgg[0]?.obtained ?? 0;
    const disposed = invAgg[0]?.disposed ?? 0;
    const issued = vchAgg[0]?.issued ?? 0;
    const claimed = vchAgg[0]?.claimed ?? 0;

    const inventoryChange = obtained - disposed;
    const voucherChange = issued - claimed;
    // Gross money-out — abs the manual-withdrawal leg so it reads positive
    // regardless of stored sign, exactly like getDailyPnl's `withdrawals`.
    const withdrawals = Math.abs(manualWd) + cardWd;
    const pnl =
      depositsTotal -
      (Math.abs(manualWd) + cardWd) -
      balanceChange -
      inventoryChange -
      voucherChange;

    const summary: DailyPnlBreakdownSummary = {
      date: dayUtc,
      deposits: depositsTotal,
      withdrawals,
      balanceChange,
      inventoryChange,
      voucherChange,
      pnl,
    };

    // ─── Map the record rows into the serializable shape ────────────────────
    const mapLedger = (rows: LedgerRecRow[]): DailyPnlBreakdownRecord[] =>
      rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        username: r.username,
        amount: toNumber(r.delta),
        kind: r.type,
        at: r.at.toISOString(),
      }));

    const depositSection: DailyPnlBreakdownSection = {
      rows: mapLedger(depositRows),
      totalCount: depositCount[0]?.n ?? 0,
      capped: (depositCount[0]?.n ?? 0) > depositRows.length,
    };

    // Withdrawals = manual-withdrawal ledger rows (negate the stored amount so
    // it reads as money-out) + card-withdrawal rows (negative). Combined,
    // re-sorted by magnitude, then capped — so the merged feed honours the cap
    // even though each leg was queried with its own LIMIT.
    const wdCombined: DailyPnlBreakdownRecord[] = [
      ...wdLedgerRows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        username: r.username,
        amount: -Math.abs(toNumber(r.amount)),
        kind: "manual_withdrawal",
        at: r.at.toISOString(),
      })),
      ...cardRows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        username: r.username,
        amount: -Math.abs(toNumber(r.amount)),
        kind: "card_withdrawal",
        at: r.at.toISOString(),
      })),
    ].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    const wdTotalCount =
      (wdLedgerCount[0]?.n ?? 0) + (cardCount[0]?.n ?? 0);
    const withdrawalSection: DailyPnlBreakdownSection = {
      rows: wdCombined.slice(0, cap),
      totalCount: wdTotalCount,
      capped: wdTotalCount > wdCombined.slice(0, cap).length,
    };

    const balanceSection: DailyPnlBreakdownSection = {
      rows: mapLedger(balanceRows),
      totalCount: balanceCount[0]?.n ?? 0,
      capped: (balanceCount[0]?.n ?? 0) > balanceRows.length,
    };

    const invSection: DailyPnlBreakdownSection = {
      rows: invRows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        username: r.username,
        amount: toNumber(r.value),
        kind: r.kind,
        at: r.at.toISOString(),
      })),
      totalCount: invCount[0]?.n ?? 0,
      capped: (invCount[0]?.n ?? 0) > invRows.length,
    };

    const vchSection: DailyPnlBreakdownSection = {
      rows: vchRows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        username: r.username,
        amount: toNumber(r.value),
        kind: r.kind,
        at: r.at.toISOString(),
      })),
      totalCount: vchCount[0]?.n ?? 0,
      capped: (vchCount[0]?.n ?? 0) > vchRows.length,
    };

    return {
      summary,
      deposits: depositSection,
      withdrawals: withdrawalSection,
      balanceChanges: balanceSection,
      inventoryChanges: invSection,
      voucherChanges: vchSection,
      rowCap: cap,
    };
  });
}
