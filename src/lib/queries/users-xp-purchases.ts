import "server-only";
import { getDb } from "@/lib/db";
import { isLiveLedgerTxType } from "@/lib/queries/_ledger-tx-types";

/**
 * Per-user XP PURCHASES — the XP a single user bought by spending their own
 * (withdrawable) USD balance. Surfaced on the /users/[id] Finances tab beside
 * the Deposits & Withdrawals ledger.
 *
 * WHAT THIS READS (verified read-only against dev, 2026-06-14)
 * ───────────────────────────────────────────────────────────
 * `ledger_transactions` rows with `type = 'xp_purchase'` for ONE user. Each
 * is a DEBIT: `balance_after = balance_before − amount`, so `amount` is the
 * USD balance the user GAVE UP to buy XP. The XP granted is in
 * `metadata.xp_awarded` (an integer; e.g. 200 XP for $1).
 *
 * House-POV (CLAUDE.md): spending withdrawable balance to buy XP gives up a
 * dollar we owed → a house GAIN → the spend reads EMERALD (matched by
 * `ledgerDirection('xp_purchase')`). XP granted is a non-USD unit → neutral.
 *
 * This is a PER-USER profile read, so it is NOT customer-scoped: the section
 * must render for whichever user is being viewed (including a creator's own
 * XP purchases), exactly like the per-user shard-winnings section.
 *
 * DRIFT GUARD: the read goes through `isLiveLedgerTxType` so a DB whose enum
 * lacks `xp_purchase` degrades to a clean empty result instead of throwing
 * `22P02`. The `upgrader_*` runtime drift guards are untouched.
 *
 * READ-ONLY. SELECT only — no writes, no game-data mutation. Safe against the
 * live production DB.
 */

/** One XP purchase row for the recent list. */
export type UserXpPurchaseRow = {
  id: string;
  /** USD balance spent to buy XP (a house gain). */
  amount: number;
  /** XP granted (from metadata.xp_awarded); null when not present. */
  xpAwarded: number | null;
  createdAt: string;
};

export type UserXpPurchasesResult = {
  /** Number of xp_purchase rows for this user. */
  count: number;
  /** Total USD balance the user spent on XP (a house gain). */
  totalSpent: number;
  /** Total XP granted (Σ metadata.xp_awarded), 0 when absent. */
  totalXp: number;
  /** Recent purchases, newest first (capped). */
  recent: UserXpPurchaseRow[];
};

const EMPTY: UserXpPurchasesResult = {
  count: 0,
  totalSpent: 0,
  totalXp: 0,
  recent: [],
};

/** Cap on the recent list — enough to scan, bounded for payload size. */
const RECENT_LIMIT = 10;

type RawAggRow = {
  count: bigint | number;
  total_spent: string | number | null;
  total_xp: string | number | null;
};

type RawRecentRow = {
  id: string;
  amount: string | number | null;
  xp_awarded: string | number | null;
  created_at: Date;
};

/**
 * Resolve a single user's XP-purchase summary + recent list. Returns an empty
 * result (count 0) when the user has none or the connected enum lacks the
 * member — the section self-hides on count 0. NOT cached (a per-user read
 * already kicked behind a streamed Suspense boundary, like shard-winnings).
 */
export async function getUserXpPurchases(
  userId: string,
): Promise<UserXpPurchasesResult> {
  // Drift guard: skip the read if the connected enum lacks the member
  // (degrade to empty instead of throwing 22P02).
  if (!(await isLiveLedgerTxType("xp_purchase"))) return EMPTY;

  const db = await getDb();

  const aggRows = await db.$queryRaw<RawAggRow[]>`
    SELECT
      COUNT(*)::bigint AS count,
      COALESCE(SUM(amount), 0)::text AS total_spent,
      COALESCE(SUM(
        CASE WHEN jsonb_typeof(metadata -> 'xp_awarded') = 'number'
             THEN (metadata ->> 'xp_awarded')::numeric
             ELSE 0 END
      ), 0)::text AS total_xp
    FROM ledger_transactions
    WHERE type = 'xp_purchase'
      AND user_id = ${userId}`;
  const agg = aggRows[0];
  const count = Number(agg?.count ?? 0);
  if (count === 0) return EMPTY;

  const recentRows = await db.$queryRaw<RawRecentRow[]>`
    SELECT
      id::text AS id,
      amount::text AS amount,
      CASE WHEN jsonb_typeof(metadata -> 'xp_awarded') = 'number'
           THEN (metadata ->> 'xp_awarded')
           ELSE NULL END AS xp_awarded,
      created_at
    FROM ledger_transactions
    WHERE type = 'xp_purchase'
      AND user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT ${RECENT_LIMIT}`;

  const recent: UserXpPurchaseRow[] = recentRows.map((r) => ({
    id: r.id,
    amount: Number(r.amount ?? 0),
    xpAwarded: r.xp_awarded != null ? Number(r.xp_awarded) : null,
    createdAt:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : new Date(r.created_at).toISOString(),
  }));

  return {
    count,
    totalSpent: Number(agg?.total_spent ?? 0),
    totalXp: Number(agg?.total_xp ?? 0),
    recent,
  };
}
