import "server-only";

import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { WAGER_TYPES_SQL, GAMING_PAYOUT_TYPES_SQL } from "@/lib/metrics";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getCrmRowsFromClickHouse } from "@/lib/clickhouse/queries/crm";
import { compareCrmSnapshot } from "@/lib/clickhouse/comparison";
import { getCreatorSessionWindowsCte } from "./creator-session-windows";
import {
  realCustomersScopeSql,
  BORROW_FILTER_CTES,
  WAGER_NON_BORROW_FILTER,
  PAYOUT_NON_BORROW_FILTER,
} from "./insights-games/_shared";
import { bucketCrmSnapshot, type CrmAggregateRow, type CrmSnapshot } from "./crm-types";

// Types live in the engine-neutral ./crm-types (so the CH comparison layer can
// share the bucketer without an import cycle); re-exported here so existing
// `@/lib/queries/crm` consumers (the /crm page) keep their import path.
export type {
  LifecycleKey,
  VipTierKey,
  CrmSegmentRow,
  CrmPlayerRow,
  CrmSnapshot,
  CrmAggregateRow,
} from "./crm-types";
export { bucketCrmSnapshot } from "./crm-types";

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
type RawRow = CrmAggregateRow;

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

async function computeCrmRowsPg(anchor: Date): Promise<RawRow[]> {
  const db = await getDb();
  const scope = await realCustomersScopeSql();
  const sessionWindowsCte = await getCreatorSessionWindowsCte();
  const upgrader = await hasUpgraderGames();
  // Anchor every NOW()-relative term (cutoff + recency + signup) to a single
  // fixed instant so the read is deterministic — and so the ClickHouse twin,
  // fed the SAME anchor, computes identical recency/signup buckets (no
  // wall-clock skew between the two engines during comparison/parity). The
  // 365-day cutoff is computed as exact seconds (not a calendar INTERVAL) so
  // both engines bound the window byte-identically.
  const anchorEpoch = anchor.getTime() / 1000;
  const cutoffEpoch = anchorEpoch - LIFETIME_LOOKBACK_DAYS * 86400;
  const anchorSql = `to_timestamp(${anchorEpoch})`;
  const cutoff = `to_timestamp(${cutoffEpoch})`;

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
           (EXTRACT(EPOCH FROM (${anchorSql} - MAX(g.act_ts))) / 86400)::int AS recency_days,
           (EXTRACT(EPOCH FROM (${anchorSql} - u.created_at)) / 86400)::int AS signup_days
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

  return rows;
}

/**
 * CQRS serve-path for the `crm_snapshot` surface. Both legs return the same
 * per-customer aggregate rows, bucketed by the SAME pure `bucketCrmSnapshot`,
 * so the served snapshot is identical regardless of engine:
 *
 *   • "clickhouse" → CH twin is the SOLE read (on failure it throws THROUGH the
 *     cache so the page's `safeQuery` degrades — never re-runs the heavy PG
 *     aggregate).
 *   • "comparison" → serve Postgres, fire-and-forget drift log.
 *   • "off"        → serve Postgres (today's behavior; CH dormant in prod).
 *
 * A single `anchor` instant is captured per compute and passed to BOTH engines
 * so cutoff/recency/signup are wall-clock-identical across the two paths.
 */
async function computeCrmSnapshot(blacklist: string[]): Promise<CrmSnapshot> {
  const anchor = new Date();
  return resolveAdminRead<CrmSnapshot>("crm_snapshot", {
    pg: async () => bucketCrmSnapshot(await computeCrmRowsPg(anchor)),
    ch: async () =>
      bucketCrmSnapshot(await getCrmRowsFromClickHouse(anchor, blacklist)),
    compare: (snapshot) => {
      void compareCrmSnapshot(anchor, blacklist, snapshot);
    },
  });
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
  ["crm-snapshot-v2"],
  { revalidate: 300, tags: ["analytics", "crm"] },
);

export async function getCrmSnapshot(): Promise<CrmSnapshot> {
  const blacklist = await getExcludedUserIds();
  return cachedCrmSnapshot([...blacklist].sort());
}
