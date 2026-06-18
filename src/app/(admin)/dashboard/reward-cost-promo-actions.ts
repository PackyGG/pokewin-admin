"use server";

import { requirePageAccess } from "@/lib/dal";
import {
  getPromoBalanceCreditClaimants,
  type PromoBalanceCreditClaimantsBreakdown,
} from "@/lib/queries/dashboard-reward-costs-today";

/**
 * Server action for the Reward Costs Today card's "Promo balance credits"
 * drilldown. Loads lazily on first expand — not on dashboard initial render.
 */
export async function fetchPromoBalanceCreditClaimants(): Promise<PromoBalanceCreditClaimantsBreakdown> {
  await requirePageAccess("/dashboard");
  return getPromoBalanceCreditClaimants();
}
