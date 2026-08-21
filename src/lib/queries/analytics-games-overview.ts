import "server-only";

import { GGR_LIFETIME_LOOKBACK_DAYS } from "@/lib/metrics/ggr-window";
import { getGamingLegs } from "@/lib/metrics/queries";
import { MS_PER_DAY } from "@/lib/utils/time";
import type { AnalyticsPeriod } from "@/app/(admin)/analytics/types";

export type GameModeOverviewRow = {
  key: "packs" | "battles" | "upgrader" | "double-down" | "keno";
  label: string;
  description: string;
  wager: number;
  events: number;
};

export type GamesOverviewData = {
  totalWager: number;
  gamingPayout: number;
  ggr: number;
  bets: number;
  organicWager: number;
  attributionAdjustment: number;
  modes: GameModeOverviewRow[];
};

function periodToSince(period: AnalyticsPeriod, now = new Date()): Date {
  if (period === "today") {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    return start;
  }

  const days =
    period === "all"
      ? GGR_LIFETIME_LOOKBACK_DAYS
      : Number.parseInt(period, 10);
  return new Date(now.getTime() - days * MS_PER_DAY);
}

/**
 * One canonical gaming read, reshaped for the Games overview. The five rows
 * are directly attributable game modes; the headline stays canonical and can
 * therefore contain the metrics layer's weighted creator-settlement adjustment.
 */
export async function getGamesOverview(
  period: AnalyticsPeriod,
): Promise<GamesOverviewData> {
  const legs = await getGamingLegs({ since: periodToSince(period) });
  const modes: GameModeOverviewRow[] = [
    {
      key: "packs",
      label: "Packs",
      description: "Solo pack openings",
      wager: legs.packWager,
      events: legs.packBets,
    },
    {
      key: "battles",
      label: "Battles",
      description: "Battle entries and sponsorships",
      wager: legs.battleWager,
      events: legs.battleBets,
    },
    {
      key: "upgrader",
      label: "Upgrader",
      description: "Item upgrade attempts",
      wager: legs.upgraderWager,
      events: legs.upgraderBets,
    },
    {
      key: "double-down",
      label: "Double Down",
      description: "Resolved re-staked battle wins",
      wager: legs.ddWager,
      events: legs.ddBets,
    },
    {
      key: "keno",
      label: "Keno",
      description: "Completed Keno bets",
      wager: legs.kenoWager,
      events: legs.kenoBets,
    },
  ];
  modes.sort((a, b) => b.wager - a.wager);

  const attributedWager = modes.reduce((sum, mode) => sum + mode.wager, 0);
  const gamingPayout = legs.inventoryPayout + legs.battleRefund + legs.ddPayout;

  return {
    totalWager: legs.wager,
    gamingPayout,
    ggr: legs.wager - gamingPayout,
    bets: legs.bets,
    organicWager: legs.organicWager,
    attributionAdjustment: legs.wager - attributedWager,
    modes,
  };
}
