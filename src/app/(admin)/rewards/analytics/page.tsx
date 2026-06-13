import { Sparkles } from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { PageHero } from "@/components/modern-panels";
import { Spinner } from "@/components/ux";

import { RewardsAnalyticsClientRedirect } from "./_components/client-redirect";

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
      return "/insights/rewards?tab=categories";
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
 *
 * The destination is DYNAMIC (`?category=` → 7 targets, `?period=` remapped),
 * so this can't be a static `next.config.ts` 308. It also must NOT call
 * `redirect()` in render — an in-render redirect on first document load
 * crashes Next's App Router ("Rendered more hooks…", React #310/#418). Instead
 * we compute the exact destination server-side (auth gate intact) and hand the
 * plain string to a tiny client component that performs `router.replace` in an
 * effect after hydration, rendering a minimal hero skeleton in the meantime.
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
  const dest = `${base}${sep}period=${period}`;

  return (
    <div className="space-y-6">
      <RewardsAnalyticsClientRedirect dest={dest} />
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-cyan-500/10">
            <Sparkles className="size-5 text-cyan-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Reward analytics</h1>
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner size={14} label="Redirecting…" />
              Redirecting to the latest insights…
            </p>
          </div>
        </div>
      </PageHero>
    </div>
  );
}
