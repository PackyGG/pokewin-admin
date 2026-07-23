import { Sparkles } from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
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
      return "/analytics?tab=rewards&rw=categories";
    case "rakeback":
      return "/analytics?tab=rewards&rw=categories";
    case "race":
      return "/analytics?tab=rewards&rw=categories";
    case "affiliate":
      return "/analytics?tab=rewards&rw=categories";
    case "signup":
      return "/analytics?tab=rewards&rw=categories";
    case "daily-packs":
      return "/analytics?tab=rewards&rw=daily-packs";
    default:
      return "/analytics?tab=rewards";
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
        <PageHeroIdentity
          icon={Sparkles}
          accent="cyan"
          title="Reward analytics"
          subtitle={
            <span className="flex items-center gap-2">
              <Spinner size={14} label="Redirecting…" />
              Redirecting to the latest insights…
            </span>
          }
        />
      </PageHero>
    </div>
  );
}
