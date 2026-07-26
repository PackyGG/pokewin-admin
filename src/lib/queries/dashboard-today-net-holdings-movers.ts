import "server-only";

import { unstable_cache } from "next/cache";
import { getDrizzleDb } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "./_blacklist";
import { nonCreatorOwnerSql } from "./_creator-pnl-exclusion";
import { statsExcludedAdjustmentSqlPredicate } from "@/lib/balance-adjustment-categories";

/**
 * Top net-holdings movers for the P&L Today tile's "Net holdings Δ"
 * drilldown — the five users with the largest |balanceΔ + inventoryΔ +
 * voucherΔ| since UTC midnight today.
 *
 * Per-user `netHoldingsChange` matches `calculateWindowedPnl`'s component
 * sum (balanceChange + inventoryChange + voucherChange). Scope matches
 * `getTodayPnl`: real users only (admin/support dropped, excluded-users
 * blacklist, statsExcluded ledger carve-outs on balance change).
 */

type TodayNetHoldingsHolderRow = {
  userId: string;
  username: string | null;
  balanceChange: number;
  inventoryChange: number;
  voucherChange: number;
  /** balanceChange + inventoryChange + voucherChange (signed). */
  netHoldingsChange: number;
};

export type TodayNetHoldingsTopHolders = {
  holders: TodayNetHoldingsHolderRow[];
  /** ISO window start (today 00:00 UTC). */
  dayStartIso: string;
};

function utcStartOfDay(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

const cachedTodayNetHoldingsTopHolders = unstable_cache(
  async (
    dayKey: string,
    sinceIso: string,
    excludeUserIds: string[],
  ): Promise<Omit<TodayNetHoldingsTopHolders, "dayStartIso">> => {
    void dayKey;
    const db = await getDrizzleDb();
    const since = new Date(sinceIso);
    const blacklist = blacklistNotInClause("u.id", excludeUserIds);
    const statsExcluded = statsExcludedAdjustmentSqlPredicate({
      typeColumn: "lt.type",
      metadataColumn: "lt.metadata",
    });

    type Row = {
      user_id: string;
      username: string | null;
      balance_change: string;
      inventory_change: string;
      voucher_change: string;
      net_holdings_change: string;
    };

    const rows = await queryRows<Row[]>(db,
      `WITH eligible AS (
         SELECT id FROM "user" u
         WHERE u.role NOT IN ('admin', 'support') ${blacklist}
       ),
       bal AS (
         SELECT lt.user_id,
           COALESCE(SUM(CASE WHEN ${statsExcluded} THEN 0
                             ELSE (lt.balance_after - lt.balance_before)::numeric END), 0) AS balance_change
         FROM ledger_transactions lt
         WHERE lt.status = 'completed'
           AND lt.created_at >= $1
           AND lt.user_id IN (SELECT id FROM eligible)
         GROUP BY lt.user_id
       ),
       admin_inv AS (
         SELECT lt.user_id,
           COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS disposed
         FROM ledger_transactions lt
         WHERE lt.status = 'completed'
           AND lt.created_at >= $1
           AND lt.type::text = 'admin_balance_adjustment'
           AND lt.metadata->>'kind' = 'inventory_removal'
           AND lt.user_id IN (SELECT id FROM eligible)
           AND ${nonCreatorOwnerSql("lt.user_id")}
           AND NOT EXISTS (
             SELECT 1 FROM user_inventory ui2
             WHERE ui2.id::text = lt.metadata->>'inventory_item_id'
           )
         GROUP BY lt.user_id
       ),
       inv AS (
         -- CREATOR-INVENTORY carve-out: drop creator-owned inventory from the
         -- holdings delta (matches calculateWindowedPnl). See
         -- _creator-pnl-exclusion.ts.
         SELECT ui.user_id,
           COALESCE(SUM(CASE WHEN ui.obtained_at >= $1
                             THEN ui.value_at_obtained::numeric ELSE 0 END), 0) AS obtained,
           COALESCE(SUM(CASE WHEN (ui.sold_at >= $1 OR ui.exchanged_at >= $1)
                             THEN ui.value_at_obtained::numeric ELSE 0 END), 0) AS ui_disposed
         FROM user_inventory ui
         WHERE (ui.obtained_at >= $1 OR ui.sold_at >= $1 OR ui.exchanged_at >= $1)
           AND ui.user_id IN (SELECT id FROM eligible)
           AND ${nonCreatorOwnerSql("ui.user_id")}
         GROUP BY ui.user_id
       ),
       admin_vch AS (
         SELECT lt.user_id,
           COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS claimed
         FROM ledger_transactions lt
         WHERE lt.status = 'completed'
           AND lt.created_at >= $1
           AND lt.type::text = 'admin_balance_adjustment'
           AND lt.metadata->>'kind' = 'voucher_removal'
           AND lt.user_id IN (SELECT id FROM eligible)
           AND NOT EXISTS (
             SELECT 1 FROM vouchers v2
             WHERE v2.id::text = lt.metadata->>'voucher_id'
           )
         GROUP BY lt.user_id
       ),
       vch AS (
         SELECT v.user_id,
           COALESCE(SUM(CASE WHEN v.created_at >= $1 THEN v.value::numeric ELSE 0 END), 0) AS issued,
           COALESCE(SUM(CASE WHEN v.claimed_at >= $1 THEN v.value::numeric ELSE 0 END), 0) AS vch_claimed
         FROM vouchers v
         WHERE (v.created_at >= $1 OR v.claimed_at >= $1)
           AND v.user_id IN (SELECT id FROM eligible)
         GROUP BY v.user_id
       ),
       active_users AS (
         SELECT user_id FROM bal
         UNION SELECT user_id FROM inv
         UNION SELECT user_id FROM vch
         UNION SELECT user_id FROM admin_inv
         UNION SELECT user_id FROM admin_vch
       ),
       combined AS (
         SELECT au.user_id,
           COALESCE(bal.balance_change, 0) AS balance_change,
           COALESCE(inv.obtained, 0)
             - COALESCE(inv.ui_disposed, 0)
             - COALESCE(admin_inv.disposed, 0) AS inventory_change,
           COALESCE(vch.issued, 0)
             - COALESCE(vch.vch_claimed, 0)
             - COALESCE(admin_vch.claimed, 0) AS voucher_change
         FROM active_users au
         LEFT JOIN bal ON bal.user_id = au.user_id
         LEFT JOIN inv ON inv.user_id = au.user_id
         LEFT JOIN admin_inv ON admin_inv.user_id = au.user_id
         LEFT JOIN vch ON vch.user_id = au.user_id
         LEFT JOIN admin_vch ON admin_vch.user_id = au.user_id
       ),
       ranked AS (
         SELECT c.*,
           (c.balance_change + c.inventory_change + c.voucher_change) AS net_holdings_change
         FROM combined c
         WHERE (c.balance_change + c.inventory_change + c.voucher_change) <> 0
       )
       SELECT
         r.user_id,
         u.username,
         r.balance_change::text,
         r.inventory_change::text,
         r.voucher_change::text,
         r.net_holdings_change::text
       FROM ranked r
       JOIN "user" u ON u.id = r.user_id
       ORDER BY ABS(r.net_holdings_change) DESC
       LIMIT 5`,
      since,
    );

    const holders: TodayNetHoldingsHolderRow[] = rows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      balanceChange: toNumber(r.balance_change),
      inventoryChange: toNumber(r.inventory_change),
      voucherChange: toNumber(r.voucher_change),
      netHoldingsChange: toNumber(r.net_holdings_change),
    }));

    return { holders };
  },
  ["dashboard-today-net-holdings-movers-v1"],
  { revalidate: 60, tags: ["dashboard-activity"] },
);

export async function getTodayNetHoldingsTopHolders(): Promise<TodayNetHoldingsTopHolders> {
  return withTiming("pnl.todayNetHoldingsMovers", async () => {
    const now = new Date();
    const since = utcStartOfDay(now);
    const sinceIso = since.toISOString();
    const dayKey = sinceIso.slice(0, 10);
    const excluded = await getExcludedUserIds();

    // through on failure); off/comparison serve Postgres unchanged. The
    // `dayStartIso` scalar is assembled here from the same window; comparison-
    // mode drift is logged by the dashboard action's existing
    // compareDashboardNetHoldingsMovers() call, so no compare thunk here.
    const { holders } = await cachedTodayNetHoldingsTopHolders(
      dayKey,
      sinceIso,
      excluded,
    );
    return { holders, dayStartIso: sinceIso };
  });
}
