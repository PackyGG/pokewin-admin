import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime, toNumber, nonCreatorOwnerCh } from "../_shared";

/**
 * Phase 2B — Dashboard "Net holdings Δ" top movers (P&L Today drilldown), read
 * from the ClickHouse prod game mirror (`packy_prod`, PeerDB CDC).
 *
 * Twin of the canonical Postgres `getTodayNetHoldingsTopHolders`
 * (src/lib/queries/dashboard-today-net-holdings-movers.ts). Per user, over the
 * window `[since, now)` (today 00:00 UTC, passed in):
 *
 *   balanceChange   = Σ CASE WHEN stats-excluded adjustment THEN 0
 *                          ELSE (balance_after − balance_before) END  (ledger)
 *   inventoryChange = obtained − ui_disposed − admin_inventory_removal
 *   voucherChange   = issued − vch_claimed − admin_voucher_removal
 *   netHoldingsChange = balanceChange + inventoryChange + voucherChange
 *
 * Returns the 5 users with the largest |netHoldingsChange|, matching
 * `calculateWindowedPnl`'s component sum.
 *
 * ─── Scope (mirrors the PG twin EXACTLY — 2-role, creators KEPT) ──────
 *
 * `role NOT IN ('admin','support')` + the excluded-users blacklist (same as
 * `getTodayPnl`). statsExcluded ledger carve-outs (official_stream /
 * remove_locked_balance) are netted OUT of balanceChange, exactly like PG.
 *
 * ─── Deterministic ordering (§5c) ────────────────────────────────────
 *
 * PG ranks `ORDER BY ABS(net_holdings_change) DESC` with NO explicit
 * tie-break, so its order on ties is undefined. This twin pins a stable
 * `ABS(net) DESC, userId ASC` tie-break; the parity harness pins the SAME key
 * on BOTH engines so a tie can't masquerade as drift.
 *
 * ClickHouse correctness: FINAL + `_peerdb_is_deleted = 0`; money stays Decimal
 * per component (sumIf/sum over the Decimal column → toString → toNumber, never
 * Float); the per-user combination + rank + cut is composed in TS from the
 * Decimal-string sums (same as the PG twin, which also combines in JS).
 */

type NetHoldingsHolderCh = {
  userId: string;
  username: string | null;
  balanceChange: number;
  inventoryChange: number;
  voucherChange: number;
  netHoldingsChange: number;
};

const STATS_EXCLUDED_CATEGORIES = ["official_stream", "remove_locked_balance"] as const;
const STATS_EXCLUDED_SQL = `(${STATS_EXCLUDED_CATEGORIES.map((k) => `'${k}'`).join(",")})`;

function eligibleCte(hasBlacklist: boolean): string {
  return `eligible AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support')
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    )`;
}

type BalRow = { uid: string; balance_change: string };
type AmountRow = { uid: string; amount: string };
type InvRow = { uid: string; obtained: string; ui_disposed: string };
type VchRow = { uid: string; issued: string; vch_claimed: string };
type UserRow = { id: string; username: string | null };

export async function getTodayNetHoldingsTopHoldersFromClickHouse(
  since: Date,
  blacklist: string[],
): Promise<{ holders: NetHoldingsHolderCh[] }> {
  const cutoff = chDateTime(since);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { cutoff, blacklist };

  const cte = eligibleCte(hasBlacklist);
  const statsExcluded = `lt.type = 'admin_balance_adjustment' AND JSONExtractString(lt.metadata, 'adjustment_category') IN ${STATS_EXCLUDED_SQL}`;
  const liveInventoryIds = `(SELECT toString(ui2.id) FROM ${CH_DB}.public_user_inventory AS ui2 FINAL WHERE ui2._peerdb_is_deleted = 0)`;
  const liveVoucherIds = `(SELECT toString(v2.id) FROM ${CH_DB}.public_vouchers AS v2 FINAL WHERE v2._peerdb_is_deleted = 0)`;

  const balSql = `
    WITH ${cte}
    SELECT
      lt.user_id AS uid,
      toString(sum(if(${statsExcluded}, toDecimal128(0, 2), lt.balance_after - lt.balance_before))) AS balance_change
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.created_at >= {cutoff:DateTime64(6)}
      AND lt.user_id IN (SELECT id FROM eligible)
    GROUP BY lt.user_id`;

  const adminInvSql = `
    WITH ${cte}
    SELECT lt.user_id AS uid, toString(sum(abs(lt.amount))) AS amount
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.created_at >= {cutoff:DateTime64(6)}
      AND lt.type = 'admin_balance_adjustment'
      AND JSONExtractString(lt.metadata, 'kind') = 'inventory_removal'
      AND lt.user_id IN (SELECT id FROM eligible)
      AND ${nonCreatorOwnerCh("lt.user_id")}
      AND JSONExtractString(lt.metadata, 'inventory_item_id') NOT IN ${liveInventoryIds}
    GROUP BY lt.user_id`;

  const adminVchSql = `
    WITH ${cte}
    SELECT lt.user_id AS uid, toString(sum(abs(lt.amount))) AS amount
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.created_at >= {cutoff:DateTime64(6)}
      AND lt.type = 'admin_balance_adjustment'
      AND JSONExtractString(lt.metadata, 'kind') = 'voucher_removal'
      AND lt.user_id IN (SELECT id FROM eligible)
      AND JSONExtractString(lt.metadata, 'voucher_id') NOT IN ${liveVoucherIds}
    GROUP BY lt.user_id`;

  const invSql = `
    WITH ${cte}
    SELECT
      ui.user_id AS uid,
      toString(sumIf(ui.value_at_obtained, ui.obtained_at >= {cutoff:DateTime64(6)})) AS obtained,
      toString(sumIf(ui.value_at_obtained,
        ifNull(ui.sold_at >= {cutoff:DateTime64(6)}, 0) = 1
        OR ifNull(ui.exchanged_at >= {cutoff:DateTime64(6)}, 0) = 1)) AS ui_disposed
    FROM ${CH_DB}.public_user_inventory AS ui FINAL
    WHERE ui._peerdb_is_deleted = 0
      AND ui.user_id IN (SELECT id FROM eligible)
      AND ${nonCreatorOwnerCh("ui.user_id")}
      AND (ui.obtained_at >= {cutoff:DateTime64(6)}
        OR ifNull(ui.sold_at >= {cutoff:DateTime64(6)}, 0) = 1
        OR ifNull(ui.exchanged_at >= {cutoff:DateTime64(6)}, 0) = 1)
    GROUP BY ui.user_id`;

  const vchSql = `
    WITH ${cte}
    SELECT
      v.user_id AS uid,
      toString(sumIf(v.value, v.created_at >= {cutoff:DateTime64(6)})) AS issued,
      toString(sumIf(v.value, ifNull(v.claimed_at >= {cutoff:DateTime64(6)}, 0) = 1)) AS vch_claimed
    FROM ${CH_DB}.public_vouchers AS v FINAL
    WHERE v._peerdb_is_deleted = 0
      AND v.user_id IN (SELECT id FROM eligible)
      AND (v.created_at >= {cutoff:DateTime64(6)}
        OR ifNull(v.claimed_at >= {cutoff:DateTime64(6)}, 0) = 1)
    GROUP BY v.user_id`;

  const [bal, adminInv, adminVch, inv, vch] = await Promise.all([
    clickhouseRead.query<BalRow>({ queryName: "dashboard.netHoldings.balance", sql: balSql, params }),
    clickhouseRead.query<AmountRow>({ queryName: "dashboard.netHoldings.adminInv", sql: adminInvSql, params }),
    clickhouseRead.query<AmountRow>({ queryName: "dashboard.netHoldings.adminVch", sql: adminVchSql, params }),
    clickhouseRead.query<InvRow>({ queryName: "dashboard.netHoldings.inventory", sql: invSql, params }),
    clickhouseRead.query<VchRow>({ queryName: "dashboard.netHoldings.vouchers", sql: vchSql, params }),
  ]);

  const balByUser = new Map(bal.map((r) => [r.uid, toNumber(r.balance_change)]));
  const adminInvByUser = new Map(adminInv.map((r) => [r.uid, toNumber(r.amount)]));
  const adminVchByUser = new Map(adminVch.map((r) => [r.uid, toNumber(r.amount)]));
  const invByUser = new Map(inv.map((r) => [r.uid, r]));
  const vchByUser = new Map(vch.map((r) => [r.uid, r]));

  const userIds = new Set<string>([
    ...balByUser.keys(),
    ...adminInvByUser.keys(),
    ...adminVchByUser.keys(),
    ...invByUser.keys(),
    ...vchByUser.keys(),
  ]);

  type Computed = Omit<NetHoldingsHolderCh, "username">;
  const computed: Computed[] = [];
  for (const uid of userIds) {
    const balanceChange = balByUser.get(uid) ?? 0;
    const invRow = invByUser.get(uid);
    const inventoryChange =
      toNumber(invRow?.obtained) -
      toNumber(invRow?.ui_disposed) -
      (adminInvByUser.get(uid) ?? 0);
    const vchRow = vchByUser.get(uid);
    const voucherChange =
      toNumber(vchRow?.issued) -
      toNumber(vchRow?.vch_claimed) -
      (adminVchByUser.get(uid) ?? 0);
    const netHoldingsChange = balanceChange + inventoryChange + voucherChange;
    // PG filters `net_holdings_change <> 0` in numeric; mirror with a
    // cent-rounded zero test so a float residual can't keep a zero-net user.
    if (Math.round(netHoldingsChange * 100) === 0) continue;
    computed.push({ userId: uid, balanceChange, inventoryChange, voucherChange, netHoldingsChange });
  }

  // Deterministic top-5: ABS(net) DESC, then userId ASC (stable tie-break).
  computed.sort((a, b) => {
    const d = Math.abs(b.netHoldingsChange) - Math.abs(a.netHoldingsChange);
    if (d !== 0) return d;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
  const top = computed.slice(0, 5);

  // Resolve usernames for the cut (cosmetic; not part of drift comparison).
  const usernameById = new Map<string, string | null>();
  if (top.length > 0) {
    const users = await clickhouseRead.query<UserRow>({
      queryName: "dashboard.netHoldings.usernames",
      sql: `SELECT toString(id) AS id, username
            FROM ${CH_DB}.public_user FINAL
            WHERE _peerdb_is_deleted = 0 AND toString(id) IN {ids:Array(String)}`,
      params: { ids: top.map((h) => h.userId) },
    });
    for (const u of users) usernameById.set(u.id, u.username ?? null);
  }

  const holders: NetHoldingsHolderCh[] = top.map((h) => ({
    ...h,
    username: usernameById.get(h.userId) ?? null,
  }));

  return { holders };
}
