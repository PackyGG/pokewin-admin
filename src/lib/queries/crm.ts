import "server-only";

import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { WAGER_TYPES_SQL, GAMING_PAYOUT_TYPES_SQL } from "@/lib/metrics";
import { getCreatorSessionWindowsCte } from "./creator-session-windows";
import {
  realCustomersScopeSql,
  BORROW_FILTER_CTES,
  WAGER_NON_BORROW_FILTER,
  PAYOUT_NON_BORROW_FILTER,
} from "./insights-games/_shared";

/**
 * Player CRM / segmentation snapshot for the Overview → Player CRM page.
 *
 * One per-customer aggregate over a capped lifetime window (365d — the
 * unbounded-lifetime pattern CLAUDE.md forbids), bucketed in memory into:
 *
 *   • Lifecycle segments  — by recency (days since last money activity):
 *     Active ≤14d · At-Risk 15-30d · Dormant 31-90d · Churned >90d.
 *   • VIP value tiers      — by gross deposits in window
 *     (Diamond / Platinum / Gold / Silver / Bronze).
 *   • Dormant whales       — high-deposit players who've gone quiet
 *     (deposits ≥ $1k AND no activity in >30d) — the win-back alert list.
 *   • Top value players    — leaderboard by deposits with lifecycle + GGR.
 *
 * Per segment we also report house GGR (borrow-corrected gaming margin,
 * customer scope) so each cohort's contribution is visible.
 *
 * Scope + model match the canonical /analytics surfaces exactly (via
 * `realCustomersScopeSql` + the borrow CTEs + `@/lib/metrics`): staff +
 * creators + blacklist dropped, borrow plays excluded on both wager and
 * payout sides. Read-only against MAIN (SELECT only).
 *
 *   wager  = Σ|ledger WAGER_TYPES| (non-borrow) + upgrader_games.bet_amount
 *   payout = Σ inventory.value_at_obtained[pack|battle] (non-borrow)
 *          + Σ|GAMING_PAYOUT_TYPES| + upgrader_games.won_amount
 *   ggr    = wager − payout   (house POV: positive = house win)
 */

const LIFETIME_LOOKBACK_DAYS = 365;
const NEW_CUSTOMER_DAYS = 30;
const DORMANT_WHALE_MIN_DEPOSITS = 1000;
const DORMANT_WHALE_MIN_RECENCY_DAYS = 30;
const DORMANT_WHALE_LIMIT = 15;
const TOP_VALUE_LIMIT = 20;

export type LifecycleKey = "active" | "at_risk" | "dormant" | "churned";
export type VipTierKey =
  | "diamond"
  | "platinum"
  | "gold"
  | "silver"
  | "bronze";

export type CrmSegmentRow = {
  key: string;
  label: string;
  users: number;
  deposits: number;
  ggr: number;
};

export type CrmPlayerRow = {
  userId: string;
  username: string | null;
  image: string | null;
  deposits: number;
  netDeposits: number;
  ggr: number;
  plays: number;
  recencyDays: number;
  lifecycle: LifecycleKey;
};

export type CrmSnapshot = {
  totalCustomers: number;
  depositingCustomers: number;
  newCustomers: number;
  totalDeposits: number;
  totalNetDeposits: number;
  totalGgr: number;
  avgDepositPerCustomer: number;
  lifecycle: CrmSegmentRow[];
  vipTiers: CrmSegmentRow[];
  dormantWhales: CrmPlayerRow[];
  topValue: CrmPlayerRow[];
};

type RawRow = {
  user_id: string;
  username: string | null;
  image: string | null;
  deposits: string;
  withdrawals: string;
  wager: string;
  payout: string;
  plays: number;
  recency_days: number;
  signup_days: number;
};

const LIFECYCLE_LABELS: Record<LifecycleKey, string> = {
  active: "Active (≤14d)",
  at_risk: "At-Risk (15-30d)",
  dormant: "Dormant (31-90d)",
  churned: "Churned (>90d)",
};

const VIP_LABELS: Record<VipTierKey, string> = {
  diamond: "Diamond ($5k+)",
  platinum: "Platinum ($2k-5k)",
  gold: "Gold ($500-2k)",
  silver: "Silver ($100-500)",
  bronze: "Bronze (<$100)",
};

function lifecycleFor(recencyDays: number): LifecycleKey {
  if (recencyDays <= 14) return "active";
  if (recencyDays <= 30) return "at_risk";
  if (recencyDays <= 90) return "dormant";
  return "churned";
}

function vipTierFor(deposits: number): VipTierKey | null {
  if (deposits >= 5000) return "diamond";
  if (deposits >= 2000) return "platinum";
  if (deposits >= 500) return "gold";
  if (deposits >= 100) return "silver";
  if (deposits > 0) return "bronze";
  return null;
}

/**
 * `true` when the connected DB has `upgrader_games`. Upgrader lives ONLY
 * there (prod does not write `upgrader_*` to the ledger). `to_regclass`
 * probe avoids a 42P01 throw on a migration-lagged snapshot.
 */
async function hasUpgraderGames(): Promise<boolean> {
  const db = await getDb();
  const probe = await db.$queryRaw<{ exists: string | null }[]>`
    SELECT to_regclass('public.upgrader_games')::text AS exists`;
  return probe[0]?.exists != null;
}

async function computeCrmSnapshot(
  _blacklistKey: string[],
): Promise<CrmSnapshot> {
  void _blacklistKey; // cache-key dimension only; scope fetched internally
  const db = await getDb();
  const scope = await realCustomersScopeSql();
  const sessionWindowsCte = await getCreatorSessionWindowsCte();
  const upgrader = await hasUpgraderGames();
  const cutoff = `NOW() - INTERVAL '${LIFETIME_LOOKBACK_DAYS} days'`;

  const notInSession = (userCol: string, tsCol: string) => `
    AND NOT EXISTS (
      SELECT 1 FROM session_windows sw
      WHERE sw.uid = ${userCol}
        AND ${tsCol} >= sw.win_start
        AND ${tsCol} <  sw.win_end
    )`;

  const rows = await db.$queryRawUnsafe<RawRow[]>(`
    WITH ${sessionWindowsCte},
         ${BORROW_FILTER_CTES},
         deposit_src AS (
           SELECT lt.user_id,
                  ABS(lt.amount::numeric) AS deposits, 0::numeric AS withdrawals,
                  0::numeric AS wager, 0::numeric AS payout, 0 AS plays,
                  lt.created_at AS act_ts
           FROM ledger_transactions lt
           WHERE lt.status = 'completed' AND lt.type::text = 'deposit'
             AND lt.user_id IN ${scope}
             AND lt.created_at >= ${cutoff}
         ),
         withdrawal_src AS (
           SELECT lt.user_id,
                  0::numeric, ABS(lt.amount::numeric),
                  0::numeric, 0::numeric, 0, lt.created_at
           FROM ledger_transactions lt
           WHERE lt.status = 'completed' AND lt.type::text = 'card_withdrawal'
             AND lt.user_id IN ${scope}
             AND lt.created_at >= ${cutoff}
         ),
         wager_src AS (
           SELECT lt.user_id,
                  0::numeric, 0::numeric, ABS(lt.amount::numeric), 0::numeric, 1,
                  lt.created_at
           FROM ledger_transactions lt
           WHERE lt.status = 'completed' AND lt.type::text IN ${WAGER_TYPES_SQL}
             AND lt.user_id IN ${scope}
             ${WAGER_NON_BORROW_FILTER}
             ${notInSession("lt.user_id", "lt.created_at")}
             AND lt.created_at >= ${cutoff}
         ),
         refund_src AS (
           SELECT lt.user_id,
                  0::numeric, 0::numeric, 0::numeric, ABS(lt.amount::numeric), 0,
                  lt.created_at
           FROM ledger_transactions lt
           WHERE lt.status = 'completed' AND lt.type::text IN ${GAMING_PAYOUT_TYPES_SQL}
             AND lt.user_id IN ${scope}
             ${notInSession("lt.user_id", "lt.created_at")}
             AND lt.created_at >= ${cutoff}
         ),
         inv_payout_src AS (
           SELECT ui.user_id,
                  0::numeric, 0::numeric, 0::numeric, ui.value_at_obtained::numeric, 0,
                  ui.obtained_at
           FROM user_inventory ui
           WHERE ui.source_type IN ('pack','battle')
             AND ui.user_id IN ${scope}
             ${PAYOUT_NON_BORROW_FILTER}
             ${notInSession("ui.user_id", "ui.obtained_at")}
             AND ui.obtained_at >= ${cutoff}
         )${
           upgrader
             ? `,
         upgrader_src AS (
           SELECT ug.user_id,
                  0::numeric, 0::numeric, ug.bet_amount::numeric, ug.won_amount::numeric, 0,
                  ug.created_at
           FROM upgrader_games ug
           WHERE ug.user_id IN ${scope}
             ${notInSession("ug.user_id", "ug.created_at")}
             AND ug.created_at >= ${cutoff}
         )`
             : ""
         }
    SELECT g.user_id::text AS user_id, u.username, u.image,
           SUM(g.deposits)::text AS deposits,
           SUM(g.withdrawals)::text AS withdrawals,
           SUM(g.wager)::text AS wager,
           SUM(g.payout)::text AS payout,
           SUM(g.plays)::int AS plays,
           (EXTRACT(EPOCH FROM (NOW() - MAX(g.act_ts))) / 86400)::int AS recency_days,
           (EXTRACT(EPOCH FROM (NOW() - u.created_at)) / 86400)::int AS signup_days
    FROM (
      SELECT user_id, deposits, withdrawals, wager, payout, plays, act_ts FROM deposit_src
      UNION ALL SELECT * FROM withdrawal_src
      UNION ALL SELECT * FROM wager_src
      UNION ALL SELECT * FROM refund_src
      UNION ALL SELECT * FROM inv_payout_src
      ${upgrader ? "UNION ALL SELECT * FROM upgrader_src" : ""}
    ) g
    JOIN "user" u ON u.id = g.user_id
    GROUP BY g.user_id, u.username, u.image, u.created_at
    HAVING SUM(g.deposits) > 0 OR SUM(g.wager) > 0
  `);

  // ── In-memory bucketing ──────────────────────────────────────────────
  const lifecycleAgg: Record<LifecycleKey, { users: number; deposits: number; ggr: number }> = {
    active: { users: 0, deposits: 0, ggr: 0 },
    at_risk: { users: 0, deposits: 0, ggr: 0 },
    dormant: { users: 0, deposits: 0, ggr: 0 },
    churned: { users: 0, deposits: 0, ggr: 0 },
  };
  const vipAgg: Record<VipTierKey, { users: number; deposits: number; ggr: number }> = {
    diamond: { users: 0, deposits: 0, ggr: 0 },
    platinum: { users: 0, deposits: 0, ggr: 0 },
    gold: { users: 0, deposits: 0, ggr: 0 },
    silver: { users: 0, deposits: 0, ggr: 0 },
    bronze: { users: 0, deposits: 0, ggr: 0 },
  };

  let totalDeposits = 0;
  let totalWithdrawals = 0;
  let totalGgr = 0;
  let depositingCustomers = 0;
  let newCustomers = 0;

  const players: CrmPlayerRow[] = rows.map((r) => {
    const deposits = toNumber(r.deposits);
    const withdrawals = toNumber(r.withdrawals);
    const ggr = toNumber(r.wager) - toNumber(r.payout);
    const recencyDays = Math.max(0, r.recency_days);
    const lc = lifecycleFor(recencyDays);

    totalDeposits += deposits;
    totalWithdrawals += withdrawals;
    totalGgr += ggr;
    if (deposits > 0) depositingCustomers += 1;
    if (r.signup_days <= NEW_CUSTOMER_DAYS) newCustomers += 1;

    lifecycleAgg[lc].users += 1;
    lifecycleAgg[lc].deposits += deposits;
    lifecycleAgg[lc].ggr += ggr;

    const tier = vipTierFor(deposits);
    if (tier) {
      vipAgg[tier].users += 1;
      vipAgg[tier].deposits += deposits;
      vipAgg[tier].ggr += ggr;
    }

    return {
      userId: r.user_id,
      username: r.username,
      image: r.image,
      deposits,
      netDeposits: deposits - withdrawals,
      ggr,
      plays: r.plays,
      recencyDays,
      lifecycle: lc,
    };
  });

  const lifecycle: CrmSegmentRow[] = (Object.keys(lifecycleAgg) as LifecycleKey[]).map(
    (key) => ({ key, label: LIFECYCLE_LABELS[key], ...lifecycleAgg[key] }),
  );
  const vipTiers: CrmSegmentRow[] = (Object.keys(vipAgg) as VipTierKey[]).map(
    (key) => ({ key, label: VIP_LABELS[key], ...vipAgg[key] }),
  );

  const dormantWhales = players
    .filter(
      (p) =>
        p.deposits >= DORMANT_WHALE_MIN_DEPOSITS &&
        p.recencyDays > DORMANT_WHALE_MIN_RECENCY_DAYS,
    )
    .sort((a, b) => b.deposits - a.deposits)
    .slice(0, DORMANT_WHALE_LIMIT);

  const topValue = [...players]
    .sort((a, b) => b.deposits - a.deposits)
    .slice(0, TOP_VALUE_LIMIT);

  return {
    totalCustomers: players.length,
    depositingCustomers,
    newCustomers,
    totalDeposits,
    totalNetDeposits: totalDeposits - totalWithdrawals,
    totalGgr,
    avgDepositPerCustomer:
      depositingCustomers > 0 ? totalDeposits / depositingCustomers : 0,
    lifecycle,
    vipTiers,
    dormantWhales,
    topValue,
  };
}

/**
 * Cross-request cached CRM snapshot. Heavy (multi-table per-user aggregate
 * over 365d), so a 300s `unstable_cache` keyed on the sorted blacklist
 * (an excluded-users edit → new key → fresh aggregate). The page also
 * wraps this in `safeQuery` with a timeout so a cold fill degrades to a
 * fallback instead of hanging the segment.
 */
const cachedCrmSnapshot = unstable_cache(
  computeCrmSnapshot,
  ["crm-snapshot-v1"],
  { revalidate: 300, tags: ["analytics", "crm"] },
);

export async function getCrmSnapshot(): Promise<CrmSnapshot> {
  const blacklist = await getExcludedUserIds();
  return cachedCrmSnapshot([...blacklist].sort());
}
