import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriodCapped,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "../_period";
import {
  parseRafflePrizes,
  buildRafflePrizeValuator,
  type RafflePrizeLine,
} from "./prize-valuation";

/**
 * Baseline rollup for the RAFFLE forecast on /insights/rewards (hub) +
 * /insights/rewards/raffle.
 *
 * Unlike deposit-bonus / race, raffle prizes are NOT a `ledger_transactions`
 * type — a raffle pays out pack/card ITEMS recorded as a `prizes` JSON array on
 * the `raffles` row (`[{ type:'pack'|'card', id, quantity? }]`). So there is no
 * money column to SUM; the cost has to be RECONSTRUCTED by valuing each prize
 * line at its item price (`packs.price` for a pack, `cards.price` for a card,
 * × quantity) via the shared prize-valuation helper.
 *
 * Scope of the baseline (what the forecast anchors on):
 *   • COMPLETED raffles only (`status = 'completed'`), `completed_at` in the
 *     active window. A raffle's cost is only "realized" once it has a winner.
 *   • winner must be a non-staff + non-blacklisted user (same customer scope
 *     the rest of the rewards-insights module enforces). A raffle whose winner
 *     is excluded is dropped wholesale (its prize cost is not a real customer
 *     payout we want to model).
 *
 * What the helper returns:
 *   • totalPrizeCost   — Σ over completed raffles of Σ(prize.price × qty)
 *   • raffleCount      — number of completed raffles counted
 *   • uniqueWinners    — distinct winner user_ids (the "claimants")
 *   • participants     — distinct users who ENTERED a counted raffle (the
 *                        denominator for the empirical "claim" probability =
 *                        winners ÷ participants)
 *   • claimProbability — uniqueWinners ÷ participants, clamped [0,1], or null
 *   • avgPrizePerRaffle  — totalPrizeCost ÷ raffleCount
 *   • avgPrizePerWinner  — totalPrizeCost ÷ uniqueWinners
 *   • maxRafflePrizeUsd  — the single most-expensive completed raffle's total
 *                          prize value (the empirical "cap")
 *   • avgEntriesPerRaffle / avgPointsPerEntry — ticket-rate context for the
 *                          forecast's ticket-rate levers
 *   • dailyPrizes      — date-bucketed (by completed_at) cost + count series
 *
 * READ-ONLY against the main (production) DB. House-POV: a raffle prize is an
 * item the house GIVES a user → cost → rose. (Per CLAUDE.md.)
 *
 * Performance: COMPLETED raffles are a small, bounded set even at lifetime, but
 * the `all` window is still bounded to the standard insights lookback
 * (`daysForInsightsPeriodCapped`) so a lifetime view never scans unboundedly.
 * Prize valuation reads each referenced pack/card price ONCE via two `IN (…)`
 * lookups, not per-raffle.
 */

export type RafflePrizeDailyPoint = {
  date: string;
  /** Reconstructed prize cost (USD) of raffles completed on this day. */
  cost: number;
  /** Raffles completed on this day. */
  count: number;
};

export type RaffleForecastBaseline = {
  /** Σ reconstructed prize cost across counted completed raffles (USD). */
  totalPrizeCost: number;
  /** Number of completed raffles counted in the window. */
  raffleCount: number;
  /** Distinct winners (the claimants). */
  uniqueWinners: number;
  /** Distinct users who entered a counted raffle (claim-prob denominator). */
  participants: number;
  /** uniqueWinners ÷ participants, clamped [0,1]; null when no participants. */
  claimProbability: number | null;
  /** totalPrizeCost ÷ raffleCount (0 when none). */
  avgPrizePerRaffle: number;
  /** totalPrizeCost ÷ uniqueWinners (0 when none). */
  avgPrizePerWinner: number;
  /** Most-expensive single completed raffle's total prize value (empirical cap). */
  maxRafflePrizeUsd: number;
  /** Mean entries per counted raffle (ticket-volume context). */
  avgEntriesPerRaffle: number;
  /** Mean points spent per entry across counted raffles (ticket-rate context). */
  avgPointsPerEntry: number;
  /** Daily series keyed on completed_at (ASC). */
  dailyPrizes: RafflePrizeDailyPoint[];
};

/** Raw raffle row shape we read for valuation. */
type RaffleRow = {
  id: string;
  prizes: unknown;
  winner_user_id: string | null;
  total_entries: number | null;
  participant_count: number | null;
  completed_at: Date | null;
};

// Prize parsing + valuation now live in the shared `./prize-valuation`
// helper (also consumed by the Edge Plan 2.0 live-raffle context cards).

async function computeRaffleBaseline(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RaffleForecastBaseline> {
  const db = await getDb();
  // Completed raffles are a small set; still bound the lifetime window to the
  // standard insights lookback so `all` never scans unboundedly.
  const days = daysForInsightsPeriodCapped(period);
  const blacklistTail = blacklistNotInClause("u.id", blacklistIds);

  // Pull the completed raffles in-window whose winner is an in-scope customer.
  // Join to "user" to enforce the staff + blacklist exclusion on the winner.
  // (A NULL winner can't pass the JOIN, which is correct — an un-drawn raffle
  // is not a realized cost.)
  const raffleRows = await db.$queryRawUnsafe<RaffleRow[]>(`
    SELECT
      r.id,
      r.prizes,
      r.winner_user_id,
      r.total_entries,
      r.participant_count,
      r.completed_at
    FROM raffles r
    JOIN "user" u ON u.id = r.winner_user_id
    WHERE r.status = 'completed'
      AND r.completed_at IS NOT NULL
      AND r.completed_at >= NOW() - INTERVAL '${days} days'
      AND u.role NOT IN ('admin', 'support') ${blacklistTail}
    ORDER BY r.completed_at ASC
  `);

  if (raffleRows.length === 0) {
    return {
      totalPrizeCost: 0,
      raffleCount: 0,
      uniqueWinners: 0,
      participants: 0,
      claimProbability: null,
      avgPrizePerRaffle: 0,
      avgPrizePerWinner: 0,
      maxRafflePrizeUsd: 0,
      avgEntriesPerRaffle: 0,
      avgPointsPerEntry: 0,
      dailyPrizes: [],
    };
  }

  // Parse every raffle's prizes once and collect the referenced item ids so we
  // value each distinct pack/card with a single lookup (not per-raffle).
  const parsedByRaffle = new Map<string, RafflePrizeLine[]>();
  const allLines: RafflePrizeLine[] = [];
  for (const row of raffleRows) {
    const prizes = parseRafflePrizes(row.prizes);
    parsedByRaffle.set(row.id, prizes);
    allLines.push(...prizes);
  }

  const raffleIds = raffleRows.map((r) => r.id);

  // Item prices + the entries rollup (distinct participants + points) run in
  // parallel; none depends on the others.
  const [valuator, entryRows] = await Promise.all([
    buildRafflePrizeValuator(db, allLines),
    // Distinct participants across the counted raffles + total points spent, so
    // the forecast has the real ticket-rate context. Customer scope is enforced
    // on the entrant too (consistent with the winner scope above).
    db.$queryRawUnsafe<{ participants: string; entries: string; points: string }[]>(`
      SELECT
        COUNT(DISTINCT re.user_id)::text AS participants,
        COUNT(*)::text AS entries,
        COALESCE(SUM(re.points_spent), 0)::text AS points
      FROM raffle_entries re
      JOIN "user" u ON u.id = re.user_id
      WHERE re.raffle_id IN (${raffleIds.map((id) => `'${id}'::uuid`).join(", ")})
        AND u.role NOT IN ('admin', 'support') ${blacklistNotInClause("u.id", blacklistIds)}
    `),
  ]);

  /** Value one raffle's full prize set (Σ price × qty). Unknown items → 0. */
  const valueRaffle = (raffleId: string): number =>
    valuator.valueLines(parsedByRaffle.get(raffleId) ?? []);

  let totalPrizeCost = 0;
  let maxRafflePrizeUsd = 0;
  let totalEntries = 0;
  const winners = new Set<string>();
  const dailyMap = new Map<string, { cost: number; count: number }>();

  for (const row of raffleRows) {
    const cost = valueRaffle(row.id);
    totalPrizeCost += cost;
    if (cost > maxRafflePrizeUsd) maxRafflePrizeUsd = cost;
    if (row.winner_user_id) winners.add(row.winner_user_id);
    totalEntries += Number(row.total_entries ?? 0);

    const day = (row.completed_at ?? new Date()).toISOString().split("T")[0];
    const bucket = dailyMap.get(day) ?? { cost: 0, count: 0 };
    bucket.cost += cost;
    bucket.count += 1;
    dailyMap.set(day, bucket);
  }

  const raffleCount = raffleRows.length;
  const uniqueWinners = winners.size;

  const entryAgg = entryRows[0];
  const participants = Number(entryAgg?.participants ?? 0);
  const entriesCounted = Number(entryAgg?.entries ?? 0);
  const pointsSpent = toNumber(entryAgg?.points);

  const claimProbability =
    participants > 0 ? Math.min(1, Math.max(0, uniqueWinners / participants)) : null;
  const avgPrizePerRaffle = raffleCount > 0 ? totalPrizeCost / raffleCount : 0;
  const avgPrizePerWinner = uniqueWinners > 0 ? totalPrizeCost / uniqueWinners : 0;
  // Prefer the entries-table count for entries-per-raffle (it is scope-filtered
  // the same way), falling back to the denormalized `total_entries` sum.
  const avgEntriesPerRaffle =
    raffleCount > 0 ? (entriesCounted > 0 ? entriesCounted : totalEntries) / raffleCount : 0;
  const avgPointsPerEntry = entriesCounted > 0 ? pointsSpent / entriesCounted : 0;

  const dailyPrizes: RafflePrizeDailyPoint[] = [...dailyMap.entries()]
    .map(([date, v]) => ({ date, cost: v.cost, count: v.count }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    totalPrizeCost,
    raffleCount,
    uniqueWinners,
    participants,
    claimProbability,
    avgPrizePerRaffle,
    avgPrizePerWinner,
    maxRafflePrizeUsd,
    avgEntriesPerRaffle,
    avgPointsPerEntry,
    dailyPrizes,
  };
}

const RAFFLE_CACHE_TAGS = ["insights-rewards", "insights-rewards-raffle"] as const;

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeRaffleBaseline(period, blacklistIds),
  ["insights-rewards-raffle-baseline-v1"],
  { revalidate: 60, tags: [...RAFFLE_CACHE_TAGS] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeRaffleBaseline(period, blacklistIds),
  ["insights-rewards-raffle-baseline-lifetime-v1"],
  { revalidate: 300, tags: [...RAFFLE_CACHE_TAGS] },
);

export async function getRaffleForecastBaseline(
  period: InsightsRewardsPeriod,
): Promise<RaffleForecastBaseline> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300 ? cachedLong(period, sorted) : cachedShort(period, sorted);
}
