import "server-only";

import { unstable_cache } from "next/cache";

import { getDevDb, getProdDb } from "@/lib/db";
import { readDbEnv } from "@/lib/db-env";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause, escapeBlacklistIds } from "@/lib/queries/_blacklist";
import {
  WAGER_TYPES_SQL,
  GAMING_PAYOUT_TYPES_SQL,
} from "@/lib/metrics/ledger-sets";
import {
  WAGER_LEG_FILTER,
  PAYOUT_LEG_FILTER,
} from "@/lib/metrics/gaming-sql";
import { getMetricsScope } from "@/lib/metrics/scope";
import { ggr as ggrFormula, gamingPayoutTotal } from "@/lib/metrics/formulas";

/**
 * Creator Hub — per-creator Overview activity chart time-series.
 *
 * Bucketed wager / coverage-attributed deposits / canonical code-user GGR
 * for ONE creator over a compact window (7d / 30d / 90d). Every leg reuses
 * the SAME attribution + scope model as `getAllCreatorsNetGgr` — narrowed
 * to a single `affiliate_user_id` and grouped by UTC calendar day.
 *
 * House-POV: wager + deposits are cash INTO the house; GGR is net gaming
 * margin (wager − gaming payout) for the creator's attributed cohort.
 */

export const CREATOR_ACTIVITY_PERIODS = ["7d", "30d", "90d"] as const;
export type CreatorActivityPeriod = (typeof CREATOR_ACTIVITY_PERIODS)[number];
export const DEFAULT_CREATOR_ACTIVITY_PERIOD: CreatorActivityPeriod = "30d";

export const CREATOR_ACTIVITY_PERIOD_LABELS: Record<
  CreatorActivityPeriod,
  string
> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

export function parseCreatorActivityPeriod(
  value: string | undefined | null,
): CreatorActivityPeriod {
  if (!value) return DEFAULT_CREATOR_ACTIVITY_PERIOD;
  return (CREATOR_ACTIVITY_PERIODS as readonly string[]).includes(value)
    ? (value as CreatorActivityPeriod)
    : DEFAULT_CREATOR_ACTIVITY_PERIOD;
}

export type CreatorActivityPoint = {
  /** Short x-axis label (e.g. "Jun 4"). */
  label: string;
  /** ISO date key (YYYY-MM-DD) for sorting / fill. */
  date: string;
  wagerUsd: number;
  depositsUsd: number;
  ggrUsd: number;
};

export type CreatorActivitySeries = {
  period: CreatorActivityPeriod;
  series: CreatorActivityPoint[];
  totals: {
    wagerUsd: number;
    depositsUsd: number;
    ggrUsd: number;
  };
};

function periodToDays(period: CreatorActivityPeriod): number {
  switch (period) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
  }
}

function formatBucketLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function fillDailyBuckets(
  period: CreatorActivityPeriod,
  byDate: Map<
    string,
    { wagerUsd: number; depositsUsd: number; ggrUsd: number }
  >,
): CreatorActivityPoint[] {
  const days = periodToDays(period);
  const out: CreatorActivityPoint[] = [];
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));

  const cursor = new Date(start);
  while (cursor <= end) {
    const date = cursor.toISOString().split("T")[0]!;
    const row = byDate.get(date) ?? { wagerUsd: 0, depositsUsd: 0, ggrUsd: 0 };
    out.push({
      date,
      label: formatBucketLabel(date),
      ...row,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

type BucketRow = { bucket: string; amount: string };

const COVERING_CREATOR_FOR_DEPOSIT = `(
  SELECT acu_c.affiliate_user_id
    FROM affiliate_code_usages acu_c
   WHERE acu_c.referred_user_id = lt.user_id
     AND acu_c.created_at <= lt.created_at
     AND acu_c.created_at >= lt.created_at - INTERVAL '7 days'
   ORDER BY acu_c.created_at DESC
   LIMIT 1
)`;

function coveringLateralForCreator(userCol: string, tsCol: string): string {
  return `LEFT JOIN LATERAL (
    SELECT acu.affiliate_user_id AS creator_id
      FROM affiliate_code_usages acu
     WHERE acu.referred_user_id = ${userCol}
       AND acu.referred_user_id <> acu.affiliate_user_id
       AND acu.created_at <= ${tsCol}
       AND acu.created_at >= ${tsCol} - INTERVAL '7 days'
       AND acu.affiliate_user_id = $1
     ORDER BY acu.created_at DESC
     LIMIT 1
   ) cov ON TRUE`;
}

const cachedCreatorActivityInner = (
  creatorUserId: string,
  period: CreatorActivityPeriod,
  env: Awaited<ReturnType<typeof readDbEnv>>,
  exclLedger: string,
  exclInventory: string,
  upgBlacklist: string,
  depositBlacklistAnd: string,
  hasUpgrader: boolean,
) =>
  unstable_cache(
    async (): Promise<CreatorActivitySeries> => {
      const db = env === "dev" ? getDevDb() : getProdDb();
      const days = periodToDays(period);
      const sinceClause = (col: string) =>
        `AND ${col} >= NOW() - INTERVAL '${days} days'`;

      const lateral = coveringLateralForCreator;

      const [ledgerRows, invRows, upgRows, depositRows] = await Promise.all([
        db.$queryRawUnsafe<
          { bucket: string; wager: string; ledger_payout: string }[]
        >(
          `SELECT to_char(DATE(ledger_transactions.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS bucket,
                  COALESCE(SUM(CASE WHEN ledger_transactions.type IN ${WAGER_TYPES_SQL} THEN ABS(ledger_transactions.amount::numeric) ELSE 0 END), 0)::text AS wager,
                  COALESCE(SUM(CASE WHEN ledger_transactions.type IN ${GAMING_PAYOUT_TYPES_SQL} THEN ABS(ledger_transactions.amount::numeric) ELSE 0 END), 0)::text AS ledger_payout
             FROM ledger_transactions
             ${lateral("user_id", "created_at")}
            WHERE status = 'completed'
              ${sinceClause("created_at")}
              AND ${WAGER_LEG_FILTER}
              ${exclLedger}
              AND cov.creator_id = $1
            GROUP BY bucket
            ORDER BY bucket`,
          creatorUserId,
        ),
        db.$queryRawUnsafe<{ bucket: string; inv_payout: string }[]>(
          `SELECT to_char(DATE(user_inventory.obtained_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS bucket,
                  COALESCE(SUM(user_inventory.value_at_obtained::numeric), 0)::text AS inv_payout
             FROM user_inventory
             ${lateral("user_id", "obtained_at")}
            WHERE source_type IN ('pack','battle')
              ${sinceClause("obtained_at")}
              AND ${PAYOUT_LEG_FILTER}
              ${exclInventory}
              AND cov.creator_id = $1
            GROUP BY bucket
            ORDER BY bucket`,
          creatorUserId,
        ),
        hasUpgrader
          ? db.$queryRawUnsafe<
              { bucket: string; upg_wager: string; upg_payout: string }[]
            >(
              `SELECT to_char(DATE(upgrader_games.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS bucket,
                      COALESCE(SUM(upgrader_games.bet_amount::numeric), 0)::text AS upg_wager,
                      COALESCE(SUM(upgrader_games.won_amount::numeric), 0)::text AS upg_payout
                 FROM upgrader_games
                 ${lateral("user_id", "created_at")}
                WHERE user_id IN (
                    SELECT u_ug.id FROM "user" u_ug
                     WHERE u_ug.role NOT IN ('admin', 'support', 'creator') ${upgBlacklist}
                  )
                  ${sinceClause("created_at")}
                  AND cov.creator_id = $1
                GROUP BY bucket
                ORDER BY bucket`,
              creatorUserId,
            )
          : Promise.resolve(
              [] as { bucket: string; upg_wager: string; upg_payout: string }[],
            ),
        db.$queryRawUnsafe<BucketRow[]>(
          `SELECT to_char(DATE(lt.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS bucket,
                  COALESCE(SUM(lt.amount::numeric), 0)::text AS amount
             FROM ledger_transactions lt
             JOIN "user" u ON u.id = lt.user_id
            WHERE lt.type::text = 'deposit'
              AND lt.status = 'completed'
              AND lt.created_at >= NOW() - INTERVAL '${days} days'
              AND u.role NOT IN ('admin', 'support', 'creator')
              AND u.id != $1
              ${depositBlacklistAnd}
              AND $1 = ${COVERING_CREATOR_FOR_DEPOSIT}
            GROUP BY bucket
            ORDER BY bucket`,
          creatorUserId,
        ),
      ]);

      type Acc = {
        wagerUsd: number;
        ledgerPayout: number;
        inventoryPayout: number;
        upgraderWager: number;
        upgraderPayout: number;
        depositsUsd: number;
      };

      const byDate = new Map<string, Acc>();
      const blank = (): Acc => ({
        wagerUsd: 0,
        ledgerPayout: 0,
        inventoryPayout: 0,
        upgraderWager: 0,
        upgraderPayout: 0,
        depositsUsd: 0,
      });

      for (const r of ledgerRows) {
        const e = byDate.get(r.bucket) ?? blank();
        e.wagerUsd += toNumber(r.wager);
        e.ledgerPayout += toNumber(r.ledger_payout);
        byDate.set(r.bucket, e);
      }
      for (const r of invRows) {
        const e = byDate.get(r.bucket) ?? blank();
        e.inventoryPayout += toNumber(r.inv_payout);
        byDate.set(r.bucket, e);
      }
      for (const r of upgRows) {
        const e = byDate.get(r.bucket) ?? blank();
        e.upgraderWager += toNumber(r.upg_wager);
        e.upgraderPayout += toNumber(r.upg_payout);
        byDate.set(r.bucket, e);
      }
      for (const r of depositRows) {
        const e = byDate.get(r.bucket) ?? blank();
        e.depositsUsd += toNumber(r.amount);
        byDate.set(r.bucket, e);
      }

      const merged = new Map<
        string,
        { wagerUsd: number; depositsUsd: number; ggrUsd: number }
      >();

      for (const [date, e] of byDate) {
        const wager = e.wagerUsd + e.upgraderWager;
        const gamingPayout = gamingPayoutTotal({
          inventoryPayout: e.inventoryPayout,
          battleRefund: e.ledgerPayout + e.upgraderPayout,
        });
        merged.set(date, {
          wagerUsd: wager,
          depositsUsd: e.depositsUsd,
          ggrUsd: ggrFormula({ wager, gamingPayout }),
        });
      }

      const series = fillDailyBuckets(period, merged);
      const totals = series.reduce(
        (acc, p) => ({
          wagerUsd: acc.wagerUsd + p.wagerUsd,
          depositsUsd: acc.depositsUsd + p.depositsUsd,
          ggrUsd: acc.ggrUsd + p.ggrUsd,
        }),
        { wagerUsd: 0, depositsUsd: 0, ggrUsd: 0 },
      );

      return { period, series, totals };
    },
    [
      "creator-hub-activity-series-v1",
      creatorUserId,
      period,
      env,
      exclLedger,
      exclInventory,
      upgBlacklist,
      depositBlacklistAnd,
      String(hasUpgrader),
    ],
    { revalidate: 300, tags: ["creator-activity-series"] },
  );

export async function getCreatorActivitySeries(
  creatorUserId: string,
  period: CreatorActivityPeriod,
): Promise<CreatorActivitySeries> {
  return withTiming("creator-hub.activitySeries", async () => {
    const env = await readDbEnv();
    const probeDb = env === "dev" ? getDevDb() : getProdDb();
    const scope = await getMetricsScope();
    const excluded = await getExcludedUserIds();

    const exclLedger = scope.exclStaffSessionFrag({ tsCol: "created_at" });
    const exclInventory = scope.exclStaffSessionFrag({ tsCol: "obtained_at" });
    const upgBlacklist = blacklistNotInClause("u_ug.id", excluded);
    const depositBlacklistAnd =
      excluded.length > 0
        ? ` AND u.id NOT IN (${escapeBlacklistIds(excluded)})`
        : "";

    const upgProbe = await probeDb.$queryRaw<{ exists: string | null }[]>`
      SELECT to_regclass('public.upgrader_games')::text AS exists`;
    const hasUpgrader = upgProbe[0]?.exists != null;

    return cachedCreatorActivityInner(
      creatorUserId,
      period,
      env,
      exclLedger,
      exclInventory,
      upgBlacklist,
      depositBlacklistAnd,
      hasUpgrader,
    )();
  });
}
