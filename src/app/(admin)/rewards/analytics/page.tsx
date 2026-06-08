import { redirect, RedirectType } from "next/navigation";

import { requirePageAccess } from "@/lib/dal";

function mapPeriod(period: string | undefined): string {
  switch (period) {
    case "today":
      return "24h";
    case "7d":
      return "7d";
    case "30d":
      return "30d";
    case "all":
      return "all";
    default:
      return "7d";
  }
}

function insightsTarget(category: string | undefined): string {
  switch (category) {
    case "deposit-bonus":
      return "/insights/rewards/deposit-bonus";
    case "rakeback":
      return "/insights/rewards/rakeback";
    case "race":
      return "/insights/rewards/race";
    case "affiliate":
      return "/insights/rewards/affiliate";
    case "signup":
      return "/insights/rewards/signup";
    case "daily-packs":
      return "/insights/rewards?tab=daily-packs";
    default:
      return "/insights/rewards";
  }
}

/**
 * Legacy rewards analytics hub — superseded by /insights/rewards and
 * per-category insight pages. Preserves bookmarks and `/rewards/analytics`
 * permission grants.
 */
export default async function RewardsAnalyticsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/rewards/analytics");
  const params = await searchParams;
  const period = mapPeriod(params.period);
  const base = insightsTarget(params.category);
  const sep = base.includes("?") ? "&" : "?";
  redirect(`${base}${sep}period=${period}`, RedirectType.replace);
}
