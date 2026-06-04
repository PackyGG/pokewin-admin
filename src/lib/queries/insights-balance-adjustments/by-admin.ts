import { unstable_cache } from "next/cache";
import { adminDb } from "@/lib/admin-db";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { BALANCE_ADJ_CACHE_TAGS } from "./_shared";
import { OFFICIAL_STREAM_ADJUSTMENT_CATEGORY } from "@/lib/balance-adjustment-categories";

/**
 * By-Admin accountability lens for /insights/balance-adjustments.
 *
 * DATA SOURCE NOTE (CRITICAL — read before trusting these numbers):
 *
 * The ledger row (`ledger_transactions.admin_balance_adjustment`) does
 * NOT carry the acting admin's id — it only knows the target user, the
 * amount, and a description. WHO performed the adjustment is recorded
 * separately in the ADMIN DB, in `admin_audit_events`:
 *
 *   - event_type = 'balance_adjustment'       → metadata.amount  (signed)
 *   - event_type = 'manual_withdrawal_recorded' → metadata.amountUsd
 *                                                 (positive magnitude of a
 *                                                  debit / payout)
 *
 * written by `adjustBalance` / `recordManualWithdrawal` in
 * `src/app/(admin)/users/[id]/actions.ts` (createAdminAuditEvent calls at
 * lines ~202 and ~601). Per the CLAUDE.md dual-DB rule the two Postgres
 * clusters can't be SQL-joined, so this lens is computed ENTIRELY from
 * the admin DB audit trail — which is the correct source for "who handed
 * out balance" anyway. We do NOT fuzzy-join to the ledger.
 *
 * Caveat surfaced in the UI: the audit trail is the source of admin
 * attribution; counts here reflect audit events, which the write flow
 * emits unconditionally alongside every ledger write. Giveaway-tagged
 * adjustments also appear under their acting admin here (they emit the
 * same 'balance_adjustment' event).
 *
 * House-POV: total volume an admin moved → rose (these are mostly
 * payouts). Net credit (gave users money) → rose; net debit → emerald.
 */

export type AdminAdjustmentRow = {
  adminUserId: string;
  username: string | null;
  displayUsername: string | null;
  /** Sum of signed amounts (credit positive, manual-wd counted negative). */
  net: number;
  /** Sum of credit magnitudes (money given to users). */
  creditVolume: number;
  /** Sum of debit magnitudes (money taken / manual withdrawals). */
  debitVolume: number;
  /** Gross magnitude moved = creditVolume + debitVolume. */
  grossVolume: number;
  /** Number of adjustment events by this admin. */
  count: number;
  /** Distinct target users this admin adjusted. */
  uniqueUsers: number;
  /** Avg absolute size = grossVolume / count. */
  avgSize: number;
  /** Largest single absolute adjustment by this admin. */
  maxSize: number;
};

async function computeByAdmin(
  period: InsightsRewardsPeriod,
): Promise<AdminAdjustmentRow[]> {
  const days = daysForInsightsPeriod(period);
  const windowFilter =
    days !== null
      ? `AND ae.created_at >= NOW() - INTERVAL '${days} days'`
      : "";

  // Extract a signed amount per audit event:
  //   balance_adjustment       → metadata->>'amount'   (already signed)
  //   manual_withdrawal_recorded → -(metadata->>'amountUsd')  (a debit;
  //       amountUsd is the positive payout magnitude, so negate it so
  //       credit/debit math is consistent with the ledger sign rule).
  // Rows whose metadata can't be parsed to a number contribute 0 to the
  // volume sums but still count toward `count` (so an admin who fired a
  // malformed-metadata event isn't dropped from the accountability list).
  const rows = await adminDb.$queryRawUnsafe<
    {
      admin_user_id: string;
      net: string;
      credit_vol: string;
      debit_vol: string;
      cnt: string;
      users: string;
      max_abs: string | null;
    }[]
  >(`
    WITH ev AS (
      SELECT
        ae.admin_user_id,
        ae.target_user_id,
        CASE
          WHEN ae.event_type = 'manual_withdrawal_recorded'
            THEN -1 * COALESCE((ae.metadata->>'amountUsd')::numeric, 0)
          ELSE COALESCE((ae.metadata->>'amount')::numeric, 0)
        END AS signed_amt
      FROM admin_audit_events ae
      WHERE ae.event_type IN ('balance_adjustment', 'manual_withdrawal_recorded')
        AND ae.admin_user_id IS NOT NULL
        -- FAKE-BALANCE: drop official_stream events (the writer stamps
        -- metadata.category on the audit row, actions.ts). IS DISTINCT FROM
        -- keeps NULL-category rows (manual withdrawals carry no category).
        AND (ae.metadata->>'category') IS DISTINCT FROM '${OFFICIAL_STREAM_ADJUSTMENT_CATEGORY.replace(/'/g, "''")}'
        ${windowFilter}
    )
    SELECT
      admin_user_id::text AS admin_user_id,
      COALESCE(SUM(signed_amt), 0)::text AS net,
      COALESCE(SUM(CASE WHEN signed_amt > 0 THEN signed_amt ELSE 0 END), 0)::text AS credit_vol,
      COALESCE(SUM(CASE WHEN signed_amt < 0 THEN ABS(signed_amt) ELSE 0 END), 0)::text AS debit_vol,
      COUNT(*)::text AS cnt,
      COUNT(DISTINCT target_user_id)::text AS users,
      MAX(ABS(signed_amt))::text AS max_abs
    FROM ev
    GROUP BY admin_user_id
    ORDER BY SUM(ABS(signed_amt)) DESC
    LIMIT 100
  `);

  if (rows.length === 0) return [];

  // Resolve admin identities from the admin DB (same cluster — a normal
  // query, not a cross-DB join).
  const adminIds = rows.map((r) => r.admin_user_id);
  const admins = await adminDb.admin_users.findMany({
    where: { id: { in: adminIds } },
    select: { id: true, username: true, display_username: true },
  });
  const adminMap = new Map(admins.map((a) => [a.id, a]));

  return rows.map((r) => {
    const creditVolume = toNumber(r.credit_vol);
    const debitVolume = toNumber(r.debit_vol);
    const grossVolume = creditVolume + debitVolume;
    const count = Number(r.cnt);
    const meta = adminMap.get(r.admin_user_id);
    return {
      adminUserId: r.admin_user_id,
      username: meta?.username ?? null,
      displayUsername: meta?.display_username ?? null,
      net: toNumber(r.net),
      creditVolume,
      debitVolume,
      grossVolume,
      count,
      uniqueUsers: Number(r.users),
      avgSize: count > 0 ? grossVolume / count : 0,
      maxSize: r.max_abs != null ? toNumber(r.max_abs) : 0,
    };
  });
}

const cached = unstable_cache(
  async (period: InsightsRewardsPeriod) => computeByAdmin(period),
  ["insights-balance-adjustments-by-admin-v1"],
  { revalidate: 60, tags: [...BALANCE_ADJ_CACHE_TAGS] },
);

const cachedLifetime = unstable_cache(
  async (period: InsightsRewardsPeriod) => computeByAdmin(period),
  ["insights-balance-adjustments-by-admin-lifetime-v1"],
  { revalidate: 300, tags: [...BALANCE_ADJ_CACHE_TAGS] },
);

export async function getBalanceAdjustmentByAdmin(
  period: InsightsRewardsPeriod,
): Promise<AdminAdjustmentRow[]> {
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300 ? cachedLifetime(period) : cached(period);
}
