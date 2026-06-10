import "server-only";

import { unstable_cache } from "next/cache";

import {
  runPeriodWindowQuery,
  parsePeriodWindowRow,
} from "@/lib/queries/period-window-kpis";
import { upgraderMetrics } from "@/lib/metrics/queries";
import { getCreatorSessionWindowsCte } from "@/lib/queries/creator-session-windows";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { MS_PER_DAY, MS_PER_MINUTE } from "@/lib/utils/time";

/**
 * Total customer WAGER for the /insights hub headline tile.
 *
 * The hub used to show `getCostBreakdown(...).organicCustomerStake`, which
 * (a) is SKIPPED on the lifetime window (`period === "all"` → falls back to
 * $0) and (b) is the ORGANIC subset (users NOT under a creator code, no
 * upgrader). The hub is now Lifetime-only, so it needs a wager that is real
 * on lifetime AND follows the house rules the owner specified:
 *
 *   1. Borrow → only the REAL amount counts. The `pack_opening` /
 *      `battle_bet` ledger `amount` is already the cash the user paid AFTER
 *      the borrow cut (a $100 pack on $90 borrow books `amount = $10`), so
 *      we SUM `amount` as-is and do NOT drop borrow plays. (This is exactly
 *      what `runPeriodWindowQuery` does — unlike the canonical GGR wager,
 *      which drops borrow plays entirely.)
 *   2. Creator deal / multiplier sessions → excluded: the `creator` role is
 *      dropped wholesale and on-session rows are removed via the
 *      `session_windows` CTE (`NOT in_session`).
 *   3. Sponsored battles → counted: `battle_sponsorship` is in WAGER_TYPES,
 *      summed once (the payer's pay-for-others stake).
 *   4. Upgrader → counted for all non-excluded users (no borrow concept),
 *      sourced from `upgrader_games` via `upgraderMetrics` (to_regclass-
 *      guarded → contributes 0 on a pre-upgrader DB).
 *
 * = `runPeriodWindowQuery.wager` (total pack/battle/sponsorship, real
 * customers, borrow-net, creator-sessions excluded) + total upgrader wager.
 *
 * Lifetime is bounded to {@link INSIGHTS_HUB_WAGER_LOOKBACK_DAYS} (365d) —
 * the same cap `/ggr`, `insights-analytics/overview.ts` and
 * `insights-games/_shared.ts` use — so the ledger / upgrader scans never run
 * unbounded (CLAUDE.md "Performance & Daten-Laden") and the tile is reliably
 * non-zero instead of degrading. This module only READS the Main DB and
 * reuses canonical readers; it changes none of them.
 */

/** Lifetime lookback cap (days) for the hub wager — matches the 365d cap used across /ggr + insights. */
export const INSIGHTS_HUB_WAGER_LOOKBACK_DAYS = 365;

/** "now" floored to the whole minute so the period-keyed cache key is stable for 60s. */
function bucketedNow(): Date {
  return new Date(Math.floor(Date.now() / MS_PER_MINUTE) * MS_PER_MINUTE);
}

/**
 * Period-keyed cache wrapper. The cutoff ISO AND the scope inputs
 * (`blacklistIdNotIn`, `sessionWindowsCte`) are all in the key, so a changed
 * blacklist / creator-session set can never serve a stale value. Tagged with
 * the canonical insights tags so a wipe/restore or exclusion change busts it.
 */
const cachedHubWager = unstable_cache(
  async (
    cutoffIso: string,
    blacklistIdNotIn: string,
    sessionWindowsCte: string,
  ): Promise<number> => {
    const cutoff = new Date(cutoffIso);
    const [windowRes, upg] = await Promise.all([
      runPeriodWindowQuery({
        currentCutoff: cutoff,
        previousStart: null,
        previousEnd: null,
        blacklistIdNotIn,
        sessionWindowsCte,
      }),
      // Total upgrader wager (all non-excluded users; no borrow). `null` on a
      // pre-upgrader DB (to_regclass guard) → contributes 0.
      upgraderMetrics({ since: cutoff }),
    ]);

    const ledgerWager = parsePeriodWindowRow(windowRes.current).wager;
    const upgraderWager = upg?.wager ?? 0;
    return ledgerWager + upgraderWager;
  },
  ["insights-hub-wager-v1"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);

/**
 * Total customer wager for the Insights hub, lifetime (365d-bounded).
 * House rules baked in — see the module doc above.
 */
export async function getInsightsHubWager(): Promise<number> {
  const now = bucketedNow();
  const cutoff = new Date(
    now.getTime() - INSIGHTS_HUB_WAGER_LOOKBACK_DAYS * MS_PER_DAY,
  );
  const [excluded, sessionWindowsCte] = await Promise.all([
    getExcludedUserIds(),
    getCreatorSessionWindowsCte(),
  ]);
  const blacklistIdNotIn = blacklistNotInClause("id", excluded);
  return cachedHubWager(
    cutoff.toISOString(),
    blacklistIdNotIn,
    sessionWindowsCte,
  );
}
