"use server";

import { requirePageAccess } from "@/lib/dal";
import {
  getRaceWinClaimants,
  type RaceWinClaimantsBreakdown,
} from "@/lib/queries/dashboard-reward-costs-today";

/**
 * Server action for the Reward Costs Today card's "Race wins" drilldown.
 * Loads lazily on first expand — not on dashboard initial render.
 */
export async function fetchRaceWinClaimants(): Promise<RaceWinClaimantsBreakdown> {
  await requirePageAccess("/dashboard");
  return getRaceWinClaimants();
}
