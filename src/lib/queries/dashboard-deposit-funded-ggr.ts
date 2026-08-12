import "server-only";

import { unstable_cache } from "next/cache";
import { getReadDrizzleDb } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { readDbEnv } from "@/lib/db-env";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { excludeStaffCreatorsAndBlacklistedSqlFromIds } from "./_blacklist";
import {
  kpiWindowToCacheCutoff,
  type DashboardKpiWindow,
} from "./dashboard-period";
import { WAGER_LEG_FILTER, PAYOUT_LEG_FILTER } from "@/lib/metrics/gaming-sql";
import {
  WAGER_TYPES_SQL,
  GAMING_PAYOUT_TYPES_SQL,
} from "@/lib/metrics/ledger-sets";

/**
 * Dashboard-LOCAL "deposit-funded GGR" — an alternate headline definition
 * for the dashboard's GGR tile ONLY (owner request, 2026-07-02). Every
 * OTHER consumer of GGR/wager (`/ggr`, insights-analytics, creators net-PnL,
 * UNCHANGED and keeps reading the canonical industry definition
 * (`getWindowMetrics` / `getGamingLegs`, wager − payouts). This module owns
 * ONLY the dashboard GGR box's headline number.
 *
 * WHY THIS EXISTS: the owner's objection to industry GGR is that a single
 * day's wager can be funded by balance carried over from a PRIOR day's
 * deposit, so that day's GGR can exceed that day's deposits (e.g. a user
 * deposits $100 Monday, plays it all Tuesday — Tuesday shows GGR up to
 * $100 with $0 Tuesday deposits). Verified against live prod data
 * (2026-07-01): 23% of that day's entire wager volume came from users who
 * deposited $0 that same day — proving same-window wager is NOT 1:1 tied
 * to same-window deposits under the industry definition. This module
 * computes a metric that IS tied to same-window deposits, by tracing (per
 * user, chronologically) how much of their wagering in the window was
 * actually fundable by money THEY deposited IN THAT SAME WINDOW.
 *
 * ── Algorithm (per user, then summed) ──────────────────────────────────
 *
 * For each real customer (canonical scope: role NOT IN
 * ('admin','support','creator') + `excluded_users` blacklist), walk their
 * DEPOSIT and WAGER events inside the window in chronological order,
 * simulating a single running "deposit pool":
 *
 *   • deposit of $D  → pool += D
 *   • wager of $W    → fundedPortion = min(W, pool); pool -= fundedPortion
 *                       (any W beyond fundedPortion draws on balance NOT
 *                       traceable to this window's deposits, and is
 *                       excluded from `fundedWager`)
 *
 * The pool is NEVER replenished by a payout/win — a win realized during
 * the window is deliberately NOT re-injected into the "deposit-funded"
 * pool, so a user who wagers carryover balance and happens to win cannot
 * launder that carryover into "deposit-funded" wagering by re-betting the
 * winnings. This is the strict reading of "only today's money."
 *
 * A wager funded only PARTLY by the pool (pool ran out mid-wager) still
 * only counts its `fundedPortion`. Because payouts are not attributed
 * per-wager (no session-level wager↔payout pairing is done here — the
 * ledger does not make that pairing cheap across pack/battle/upgrader/DD),
 * each user's payout is apportioned to the "deposit-funded" share of GGR
 * PROPORTIONALLY to how much of their TOTAL window wager was fundable:
 *
 *   fundedFraction   = fundedWager / totalWager   (0 if totalWager = 0)
 *   fundedPayout     = totalPayout * fundedFraction
 *   userContribution = fundedWager - fundedPayout
 *
 * Deposit-funded GGR for the window = Σ userContribution over all users
 * with at least one wager event in the window.
 *
 * Wager/payout leg definitions are borrowed VERBATIM from the canonical
 * `getGamingLegs` shape (`WAGER_LEG_FILTER` / `PAYOUT_LEG_FILTER` from
 * `metrics/gaming-sql.ts`, `WAGER_TYPES_SQL` / `GAMING_PAYOUT_TYPES_SQL`
 * from `metrics/ledger-sets.ts`, plus upgrader_games +
 * battle_double_down_offers, to_regclass-guarded) so the population of
 * "what counts as a wager/payout" matches the industry-GGR figure exactly
 * — the ONLY difference is the deposit-provenance filter on top.
 *
 * shape (`status`, `type`, `created_at`) that the canonical `getGamingLegs`
 * already runs successfully against `idx_ledger_tx_status_type_created_at`
 * — this introduces no new unindexed access pattern, it fetches raw rows
 * instead of a SUM over the identical predicate.
 */

type RawEvent = { userId: string; t: number; kind: "deposit" | "wager"; amount: number };

async function tableExists(name: string): Promise<boolean> {
  const db = await getReadDrizzleDb();
  const probe = await queryRows<{ exists: string | null }[]>(db,
    `SELECT to_regclass('public.${name}')::text AS exists`,
  );
  return probe[0]?.exists != null;
}

/** Merge two already-fetched raw-row sets into a per-user chronological event list. */
function bucketByUser(events: RawEvent[]): Map<string, RawEvent[]> {
  const byUser = new Map<string, RawEvent[]>();
  for (const e of events) {
    const list = byUser.get(e.userId);
    if (list) list.push(e);
    else byUser.set(e.userId, [e]);
  }
  // Chronological order; a deposit at the exact same timestamp as a wager
  // is treated as available to fund it (deposit sorts first on ties).
  for (const list of byUser.values()) {
    list.sort((a, b) => a.t - b.t || (a.kind === "deposit" ? -1 : 1));
  }
  return byUser;
}

async function computeDepositFundedGgr(
  cutoff: Date,
  blacklist: string[],
): Promise<number> {
  return withTiming("dashboard.depositFundedGgr", async () => {
    const db = await getReadDrizzleDb();
    const scopeSql = excludeStaffCreatorsAndBlacklistedSqlFromIds(blacklist);
    const cutoffLiteral = `'${cutoff.toISOString()}'::timestamptz`;

    const [hasUpgrader, hasDoubleDown] = await Promise.all([
      tableExists("upgrader_games"),
      tableExists("battle_double_down_offers"),
    ]);

    type EventRow = {
      user_id: string;
      created_at: Date | string;
      amount: string;
    };
    type TotalRow = { user_id: string; total: string };

    const [
      depositRows,
      ledgerWagerRows,
      upgraderWagerRows,
      ddWagerRows,
      ledgerPayoutRows,
      invPayoutRows,
      upgraderPayoutRows,
      ddPayoutRows,
    ] = await Promise.all([
      queryRows<EventRow[]>(db,
        `SELECT user_id, created_at, amount::numeric::text AS amount
         FROM ledger_transactions
         WHERE status = 'completed' AND type::text = 'deposit'
           AND created_at >= ${cutoffLiteral}
           AND ${scopeSql}`,
      ),
      queryRows<EventRow[]>(db,
        `SELECT user_id, created_at, ABS(amount::numeric)::text AS amount
         FROM ledger_transactions
         WHERE status = 'completed' AND type::text IN ${WAGER_TYPES_SQL}
           AND created_at >= ${cutoffLiteral}
           AND ${scopeSql}
           AND ${WAGER_LEG_FILTER}`,
      ),
      hasUpgrader
        ? queryRows<EventRow[]>(db,
            `SELECT user_id, created_at, bet_amount::numeric::text AS amount
             FROM upgrader_games
             WHERE created_at >= ${cutoffLiteral}
               AND ${scopeSql}`,
          )
        : Promise.resolve<EventRow[]>([]),
      hasDoubleDown
        ? queryRows<EventRow[]>(db,
            `SELECT user_id, resolved_at AS created_at, won_amount_usd::numeric::text AS amount
             FROM battle_double_down_offers
             WHERE result IS NOT NULL
               AND resolved_at >= ${cutoffLiteral}
               AND ${scopeSql}`,
          )
        : Promise.resolve<EventRow[]>([]),
      queryRows<TotalRow[]>(db,
        `SELECT user_id, SUM(ABS(amount::numeric))::text AS total
         FROM ledger_transactions
         WHERE status = 'completed' AND type::text IN ${GAMING_PAYOUT_TYPES_SQL}
           AND created_at >= ${cutoffLiteral}
           AND ${scopeSql}
         GROUP BY user_id`,
      ),
      queryRows<TotalRow[]>(db,
        `SELECT user_id, SUM(value_at_obtained::numeric)::text AS total
         FROM user_inventory
         WHERE obtained_at >= ${cutoffLiteral}
           AND ${scopeSql}
           AND ${PAYOUT_LEG_FILTER}
         GROUP BY user_id`,
      ),
      hasUpgrader
        ? queryRows<TotalRow[]>(db,
            `SELECT user_id, SUM(won_amount::numeric)::text AS total
             FROM upgrader_games
             WHERE created_at >= ${cutoffLiteral}
               AND ${scopeSql}
             GROUP BY user_id`,
          )
        : Promise.resolve<TotalRow[]>([]),
      hasDoubleDown
        ? queryRows<TotalRow[]>(db,
            `SELECT o.user_id, SUM(CASE WHEN o.result = 'win' THEN v.value::numeric ELSE 0 END)::text AS total
             FROM battle_double_down_offers o
             LEFT JOIN vouchers v
               ON v.id = o.won_voucher_id AND v.origin = 'battle_double_down_payout'
             WHERE o.result IS NOT NULL
               AND o.resolved_at >= ${cutoffLiteral}
               AND ${scopeSql.replace(/^user_id\b/, "o.user_id")}
             GROUP BY o.user_id`,
          )
        : Promise.resolve<TotalRow[]>([]),
    ]);

    const events: RawEvent[] = [];
    for (const r of depositRows) {
      events.push({ userId: r.user_id, t: new Date(r.created_at).getTime(), kind: "deposit", amount: toNumber(r.amount) });
    }
    for (const r of [...ledgerWagerRows, ...upgraderWagerRows, ...ddWagerRows]) {
      events.push({ userId: r.user_id, t: new Date(r.created_at).getTime(), kind: "wager", amount: toNumber(r.amount) });
    }

    const totalPayoutByUser = new Map<string, number>();
    for (const r of [...ledgerPayoutRows, ...invPayoutRows, ...upgraderPayoutRows, ...ddPayoutRows]) {
      totalPayoutByUser.set(r.user_id, (totalPayoutByUser.get(r.user_id) ?? 0) + toNumber(r.total));
    }

    const byUser = bucketByUser(events);

    let depositFundedGgr = 0;
    for (const [userId, userEvents] of byUser) {
      let pool = 0;
      let fundedWager = 0;
      let totalWager = 0;
      for (const e of userEvents) {
        if (e.kind === "deposit") {
          pool += e.amount;
        } else {
          totalWager += e.amount;
          const funded = Math.min(e.amount, pool);
          pool -= funded;
          fundedWager += funded;
        }
      }
      if (totalWager <= 0) continue;
      const fundedFraction = fundedWager / totalWager;
      const totalPayout = totalPayoutByUser.get(userId) ?? 0;
      const fundedPayout = totalPayout * fundedFraction;
      depositFundedGgr += fundedWager - fundedPayout;
    }

    return depositFundedGgr;
  });
}

/**
 * Cross-request cached deposit-funded GGR. Same 60s-TTL / cutoff-rollover /
 * blacklist-keyed shape as `dashboard-cashflow-pg.ts`'s `cachedCashflow`,
 * so this box refreshes on the same live cadence as the rest of the
 * dashboard's period-bound tiles.
 */
const cachedDepositFundedGgr = unstable_cache(
  async (
    _window: DashboardKpiWindow,
    cutoffIso: string,
    blacklist: string[],
  ): Promise<number> => {
    void _window; // cache-key discriminator only
    return computeDepositFundedGgr(new Date(cutoffIso), blacklist);
  },
  ["dashboard-deposit-funded-ggr-v1"],
  { revalidate: 60, tags: ["dashboard-activity"] },
);

/**
 * Dashboard-local deposit-funded GGR for a KPI window ("today" / "24h").
 * Prod requests hit the 60s cache; a dev-toggled admin bypasses it (same
 * pattern as every other cached dashboard aggregate).
 */
export async function getDepositFundedGgrForWindow(
  window: DashboardKpiWindow,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = kpiWindowToCacheCutoff(window, now);
  const cutoffIso = cutoff.toISOString();
  const blacklist = await getExcludedUserIds();
  const env = await readDbEnv();
  if (env !== "prod") return computeDepositFundedGgr(cutoff, blacklist);
  return cachedDepositFundedGgr(window, cutoffIso, blacklist);
}
