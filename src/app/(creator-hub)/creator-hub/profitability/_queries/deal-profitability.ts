import "server-only";

import type { DashboardPeriod } from "@/lib/queries/dashboard-period";
import { listRosterCreators } from "../../creators/_queries/list-roster-creators";

/**
 * Creator Hub — Profitability data.
 *
 * Sources the SAME fill-creator roster the `/creator-hub/creators` page
 * renders (`listRosterCreators` → backend creator API + the verified
 * `getDealValueByUser` deal-cost composition + windowed cohort wager). No
 * new DB read is introduced here — this only re-projects the already-loaded,
 * cached roster rows into a cost-vs-wager profitability view:
 *
 *   dealCost      = the roster's composed deal value (withdraw cap +
 *                   leaderboard funding × house share + tip/sponsor
 *                   allowance) — house cost, rose POV.
 *   expectedWager = dealCost / house edge (7.5%) — the wager volume whose
 *                   GGR would exactly cover that cost.
 *   actualWager   = the creator's windowed cohort affiliate wager (the
 *                   roster's "Wager" column, scoped to `period`).
 *   conversion    = actualWager / expectedWager (≥1× = deal pays for itself).
 */

const HOUSE_EDGE = 0.075;

export type CreatorProfitabilityRow = {
  userId: string;
  username: string | null;
  image: string | null;
  code: string | null;
  capUsd: number;
  leaderboardUsd: number;
  tipSponsorUsd: number;
  dealCost: number;
  expectedWager: number;
  actualWager: number;
  /** `expectedWager > 0 ? actualWager / expectedWager : 0`. */
  conversionRate: number;
};

export type ProfitabilityTotals = {
  totalCost: number;
  totalActualPnl: number;
  totalExpectedWager: number;
  totalCreatorWager: number;
  avgConversionRate: number;
};

export type ProfitabilityData = {
  rows: CreatorProfitabilityRow[];
  totals: ProfitabilityTotals;
  /** True when the backend roster walk failed (page shows the error state). */
  rosterUnavailable: boolean;
};

export async function getCreatorProfitability(
  period: DashboardPeriod,
): Promise<ProfitabilityData> {
  // deal_desc => biggest deal cost first; "fill" => creators on a fill deal,
  // exactly the roster the /creators page's default tab walks.
  const { creators, rosterUnavailable } = await listRosterCreators(
    period,
    "deal_desc",
    "fill",
  );

  const rows: CreatorProfitabilityRow[] = creators
    .filter((c) => c.dealValue != null && c.dealValue.dealValueUsd > 0)
    .map((c) => {
      const dv = c.dealValue!;
      const dealCost = dv.dealValueUsd;
      const expectedWager = dealCost / HOUSE_EDGE;
      const actualWager = c.windowedWagerUsd;
      const conversionRate = expectedWager > 0 ? actualWager / expectedWager : 0;
      return {
        userId: c.id,
        username: c.username,
        image: c.image,
        code: c.code,
        capUsd: dv.capUsd,
        leaderboardUsd: dv.leaderboardUsd,
        tipSponsorUsd: dv.tipSponsorUsd,
        dealCost,
        expectedWager,
        actualWager,
        conversionRate,
      };
    });

  const totalCost = rows.reduce((acc, r) => acc + r.dealCost, 0);
  const totalExpectedWager = rows.reduce((acc, r) => acc + r.expectedWager, 0);
  const totalCreatorWager = rows.reduce((acc, r) => acc + r.actualWager, 0);

  // Actual P&L of the deal program (house-POV): the GGR the creators' real
  // windowed wager throws off at the house edge, minus what the deals cost.
  const totalActualPnl = totalCreatorWager * HOUSE_EDGE - totalCost;

  const converting = rows.filter((r) => r.expectedWager > 0);
  const avgConversionRate =
    converting.length > 0
      ? converting.reduce((acc, r) => acc + r.conversionRate, 0) /
        converting.length
      : 0;

  return {
    rows,
    totals: {
      totalCost,
      totalActualPnl,
      totalExpectedWager,
      totalCreatorWager,
      avgConversionRate,
    },
    rosterUnavailable,
  };
}
