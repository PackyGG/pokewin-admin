import { queryMainRows } from "@/lib/drizzle-query";
import "server-only";

import { unstable_cache } from "next/cache";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { WAGER_TYPES_SQL, GAMING_PAYOUT_TYPES_SQL } from "@/lib/metrics";
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
  LevelBandKey,
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
 *   • Player level bands   — by the REAL `user_statistics.level` (XP-driven,
 *     0–84 on prod). Replaced the invented "VIP value tiers" (Diamond /
 *     Platinum / …), which were deposit brackets wearing product-sounding
 *     names for a tier system that does not exist.
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
  const probe = await queryMainRows<{ exists: string | null }[]>(
    `SELECT to_regclass('public.upgrader_games')::text AS exists`,
  );
  return probe[0]?.exists != null;
}

async function computeCrmRowsPg(anchor: Date): Promise<RawRow[]> {
  const scope = await realCustomersScopeSql();
  const sessionWindowsCte = await getCreatorSessionWindowsCte();
  const upgrader = await hasUpgraderGames();
  // Anchor every NOW()-relative term (cutoff + recency + signup) to a single
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

  const rows = await queryMainRows<RawRow[]>(`
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
 * Real player level per user id, for the customers the aggregate actually
 * returned.
 *
 * Read HERE and shared by BOTH read legs rather than derived inside each: the
 * leg computing its own would produce a snapshot the Postgres leg could never
 * match. It is also current state, not a windowed metric — nothing about it
 * belongs in the 365-day aggregate.
 *
 * Index-served: `user_statistics_user_id_unique` on `user_id`, probed with the
 * ids already in hand (never a full-table read). A user with no stats row is
 * simply absent and banks as level 0 upstream.
 */
async function fetchLevels(userIds: string[]): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();
  const rows = await queryMainRows<{ user_id: string; level: number }[]>(
    `SELECT user_id, level
     FROM user_statistics
     WHERE user_id = ANY($1::text[])`,
    userIds,
  );
  return new Map(rows.map((r) => [r.user_id, r.level]));
}

/**
 * CQRS serve-path for the `crm_snapshot` surface. Both legs return the same
 * per-customer aggregate rows, bucketed by the SAME pure `bucketCrmSnapshot`,
 * so the served snapshot is identical regardless of engine:
 *
 *     cache so the page's `safeQuery` degrades — never re-runs the heavy PG
 *     aggregate).
 *   • "comparison" → serve Postgres, fire-and-forget drift log.
 *   • "off"        → serve Postgres (today's behavior; CH dormant in prod).
 *
 * A single `anchor` instant is captured per compute and passed to BOTH engines
 * so cutoff/recency/signup are wall-clock-identical across the two paths.
 */
async function computeCrmSnapshot(blacklist: string[]): Promise<CrmSnapshot> {
  void blacklist;
  const anchor = new Date();
  const rows = await computeCrmRowsPg(anchor);
  return bucketCrmSnapshot(rows, await fetchLevels(rows.map((r) => r.user_id)));
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
