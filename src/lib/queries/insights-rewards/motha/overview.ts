import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "../_period";

/**
 * Baseline rollup for the "Motha giveaways" forecast
 * (/insights/forecast?reward=motha).
 *
 * "Motha giveaways" = everything the `motha` account GIVES AWAY across its
 * three funding channels, measured over the active window. Unlike most reward
 * surfaces this is NOT a house-wide reward type — it is the OUTFLOW of one
 * specific account (the founder's giveaway budget), so it is scoped to
 * `user_id = motha` and deliberately does NOT apply the staff/blacklist
 * exclusion (motha IS the subject, not a customer being measured).
 *
 * The three channels (the forecast's segmentation):
 *   • tips        — `creator_tip` ledger rows funded by motha (user→user tip
 *                   the founder hands a creator/user). ABS(amount).
 *   • rain        — `rain_tips` rows where `user_id = motha` (the founder's
 *                   contribution to a rain pool). Sourced from the `rain_tips`
 *                   table (no status column there), summed via ABS(amount_usd).
 *   • sponsorship — `battle_sponsorship` ledger rows funded by motha (the
 *                   founder sponsoring a user's battle stake). ABS(amount).
 *
 * Total cost = tips + rain + sponsorship → the forecast baseline `totalCost`.
 *
 * Claimants: motha's giveaways do not have a single derivable "recipient" key
 * on the funding leg (the `creator_tip` / `battle_sponsorship` debit sits on
 * motha; the credit leg is a separate row we do not reliably join, and rain
 * tips fund a pool rather than a named recipient). The coherent, derivable
 * volume anchor is therefore the count of DISTINCT ACTIVE DAYS motha gave away
 * on (across all three channels) — a stable proxy the engine scales to the
 * forecast horizon. (Per the forecast contract: "distinct recipients if
 * derivable else distinct active days".)
 *
 * Source of truth:
 *   - ledger_transactions rows: status = 'completed', user = motha,
 *     type IN ('creator_tip','battle_sponsorship')
 *   - rain_tips rows: user_id = motha
 *
 * House-POV: a giveaway is money the house (via the founder account) GIVES out
 * → rose accent everywhere. Read-only against the main DB.
 */

/** Lowercased username of the giveaway account. */
const MOTHA_USERNAME = "motha";

export type MothaGiveawayOverview = {
  /** Total giveaway $ in the window = tips + rain + sponsorship. */
  totalCost: number;
  /** Total number of giveaway events in the window (ledger rows + rain tips). */
  count: number;
  /**
   * Distinct active days motha gave away on (across all three channels) — the
   * volume anchor the forecast scales to the horizon. Always ≥0.
   */
  uniqueClaimants: number;
  /** Average giveaway = totalCost / count (0 when no events). */
  avg: number;
  /** Largest single giveaway across all three channels (empirical cap). */
  max: number;
  /** Per-channel split of the window total (House-POV outflow). */
  byChannel: {
    /** `creator_tip` funded by motha. */
    tips: number;
    /** `rain_tips` funded by motha. */
    rain: number;
    /** `battle_sponsorship` funded by motha. */
    sponsorship: number;
  };
  /** Per-channel event counts (parallel to `byChannel`). */
  countByChannel: {
    tips: number;
    rain: number;
    sponsorship: number;
  };
};

const EMPTY: MothaGiveawayOverview = {
  totalCost: 0,
  count: 0,
  uniqueClaimants: 0,
  avg: 0,
  max: 0,
  byChannel: { tips: 0, rain: 0, sponsorship: 0 },
  countByChannel: { tips: 0, rain: 0, sponsorship: 0 },
};

async function computeOverview(
  period: InsightsRewardsPeriod,
): Promise<MothaGiveawayOverview> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);

  // Window filters. `lt` for ledger_transactions, `rt` for rain_tips. Lifetime
  // (days === null) drops the lower bound — motha's giveaway history is a tiny
  // single-account slice (no full-table scan risk), so no lookback cap needed.
  const ledgerDateFilter =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const rainDateFilter =
    days !== null ? `AND rt.created_at >= NOW() - INTERVAL '${days} days'` : "";

  // Resolve motha's user id once (case-insensitive). If the account does not
  // exist there is nothing to model → empty baseline (the tab renders a clean
  // empty state). Parameterized to keep the username off the raw SQL string.
  const idRows = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "user" WHERE LOWER(username) = $1 LIMIT 1`,
    MOTHA_USERNAME,
  );
  const mothaId = idRows[0]?.id;
  if (!mothaId) return EMPTY;

  // Ledger channels (tips + sponsorship) and rain channel in parallel — both
  // scoped to motha, both summed via ABS(amount). The ledger query pivots the
  // two ledger channels in one pass; the rain query sums the rain_tips table.
  const [ledgerRows, rainRows] = await Promise.all([
    db.$queryRawUnsafe<
      {
        tips_total: string;
        tips_cnt: string;
        sponsorship_total: string;
        sponsorship_cnt: string;
        max_amount: string | null;
      }[]
    >(
      `
      SELECT
        COALESCE(SUM(CASE WHEN lt.type::text = 'creator_tip' THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS tips_total,
        COUNT(*) FILTER (WHERE lt.type::text = 'creator_tip')::text AS tips_cnt,
        COALESCE(SUM(CASE WHEN lt.type::text = 'battle_sponsorship' THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS sponsorship_total,
        COUNT(*) FILTER (WHERE lt.type::text = 'battle_sponsorship')::text AS sponsorship_cnt,
        MAX(ABS(lt.amount::numeric))::text AS max_amount
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.user_id = $1
        AND lt.type::text IN ('creator_tip', 'battle_sponsorship')
        ${ledgerDateFilter}
    `,
      mothaId,
    ),
    db.$queryRawUnsafe<
      { rain_total: string; rain_cnt: string; max_amount: string | null }[]
    >(
      `
      SELECT
        COALESCE(SUM(ABS(rt.amount_usd::numeric)), 0)::text AS rain_total,
        COUNT(*)::text AS rain_cnt,
        MAX(ABS(rt.amount_usd::numeric))::text AS max_amount
      FROM rain_tips rt
      WHERE rt.user_id = $1
        ${rainDateFilter}
    `,
      mothaId,
    ),
  ]);

  // Distinct active days across BOTH sources (the volume anchor). A UNION of
  // the per-source DATE() sets, counted distinct — so a day motha tipped AND
  // rained still counts once.
  const dayRows = await db.$queryRawUnsafe<{ active_days: string }[]>(
    `
    SELECT COUNT(DISTINCT d)::text AS active_days
    FROM (
      SELECT DATE(lt.created_at) AS d
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.user_id = $1
        AND lt.type::text IN ('creator_tip', 'battle_sponsorship')
        ${ledgerDateFilter}
      UNION
      SELECT DATE(rt.created_at) AS d
      FROM rain_tips rt
      WHERE rt.user_id = $1
        ${rainDateFilter}
    ) days
  `,
    mothaId,
  );

  const lr = ledgerRows[0];
  const rr = rainRows[0];

  const tips = toNumber(lr?.tips_total);
  const sponsorship = toNumber(lr?.sponsorship_total);
  const rain = toNumber(rr?.rain_total);
  const tipsCnt = Number(lr?.tips_cnt ?? 0);
  const sponsorshipCnt = Number(lr?.sponsorship_cnt ?? 0);
  const rainCnt = Number(rr?.rain_cnt ?? 0);

  const totalCost = tips + rain + sponsorship;
  const count = tipsCnt + rainCnt + sponsorshipCnt;
  const avg = count > 0 ? totalCost / count : 0;
  const max = Math.max(
    lr?.max_amount != null ? toNumber(lr.max_amount) : 0,
    rr?.max_amount != null ? toNumber(rr.max_amount) : 0,
  );
  const uniqueClaimants = Number(dayRows[0]?.active_days ?? 0);

  return {
    totalCost,
    count,
    uniqueClaimants,
    avg,
    max,
    byChannel: { tips, rain, sponsorship },
    countByChannel: { tips: tipsCnt, rain: rainCnt, sponsorship: sponsorshipCnt },
  };
}

const cachedOverview = unstable_cache(
  async (period: InsightsRewardsPeriod) => computeOverview(period),
  ["insights-rewards-motha-overview-v1"],
  { revalidate: 60, tags: ["rewards-analytics", "insights-rewards", "insights-rewards-motha"] },
);

const cachedOverviewLifetime = unstable_cache(
  async (period: InsightsRewardsPeriod) => computeOverview(period),
  ["insights-rewards-motha-overview-lifetime-v1"],
  { revalidate: 300, tags: ["rewards-analytics", "insights-rewards", "insights-rewards-motha"] },
);

export async function getMothaGiveawayOverview(
  period: InsightsRewardsPeriod,
): Promise<MothaGiveawayOverview> {
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300 ? cachedOverviewLifetime(period) : cachedOverview(period);
}
