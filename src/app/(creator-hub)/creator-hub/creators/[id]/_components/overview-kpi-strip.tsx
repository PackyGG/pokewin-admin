import {
  BadgeDollarSign,
  Flame,
  HandCoins,
  Info,
  MousePointerClick,
  UserPlus,
  Wallet,
} from "lucide-react";

import { KpiTile } from "@/components/modern-panels";
import { HubNotice } from "../../../_components/hub-notice";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

import type { getCreatorDetailCached } from "../_queries/overview-data";

type CreatorDetail = Awaited<ReturnType<typeof getCreatorDetailCached>>;

/**
 * Overview KPI strip — the creator's display boxes (clicks / signups / FTDs /
 * active affiliates / wager volume / earned). House-POV colors:
 *   • Clicks / Signups / FTDs → blue family (neutral funnel events)
 *   • Active affi             → amber (currently-warm referrals)
 *   • Wager Volume           → emerald (money INTO the house)
 *   • Total Earned           → rose (money paid OUT to the creator = house cost)
 *
 * Driven by the existing `getCreatorDetail` aggregate (cached) — every
 * figure maps to a real field on that result; nothing fabricated. Renders a
 * compact degraded banner if the aggregate failed/timed out (the banner +
 * tab bar already painted, so we never 404 the whole page). `failureKind`
 * keeps the band copy TRUTHFUL: a hard failure says "failed", only a real
 * timeout says "taking too long" (a 22P02 used to masquerade as slow).
 */
export function OverviewKpiStrip({
  profile,
  failureKind = null,
}: {
  profile: CreatorDetail | null;
  failureKind?: "timeout" | "error" | null;
}) {
  if (!profile) {
    const timedOut = failureKind === "timeout";
    return (
      <HubNotice
        tone="amber"
        icon={Info}
        title={
          timedOut
            ? "Creator metrics are taking too long to load"
            : "Creator metrics failed to load"
        }
      >
        {timedOut
          ? "The acquisition + wager aggregate timed out. Refresh to retry — the rest of the page is unaffected."
          : "The acquisition + wager aggregate failed — its data is unavailable right now. Refresh to retry; the rest of the page is unaffected."}
      </HubNotice>
    );
  }

  return (
    <div className="space-y-3 sm:space-y-4">
      {!profile.hasAffiliateAccount && (
        <HubNotice
          tone="amber"
          icon={Info}
          title="This user has no affiliate account yet"
        >
          Not yet provisioned as a creator — code, click, and signup metrics
          will appear empty.
        </HubNotice>
      )}

      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiTile
          label="Clicks"
          value={formatNumber(profile.clicks.total)}
          icon={MousePointerClick}
          accent="blue"
        />
        <KpiTile
          label="Signups"
          value={formatNumber(profile.signups.total)}
          icon={UserPlus}
          accent="cyan"
        />
        <KpiTile
          label="FTDs"
          value={formatNumber(profile.ftdCount)}
          icon={BadgeDollarSign}
          accent="purple"
        />
        <KpiTile
          label="Active affi"
          value={formatNumber(profile.activeReferrals7d)}
          sub={`${formatNumber(profile.activeReferrals24h)} in 24h · 7d window`}
          icon={Flame}
          accent="amber"
        />
        <KpiTile
          label="Wager Volume"
          value={formatCurrency(profile.totalWagerVolumeUsd)}
          sub="All-time"
          icon={Wallet}
          accent="emerald"
        />
        <KpiTile
          label="Total Earned"
          value={formatCurrency(profile.totalEarnedUsd)}
          sub={`Paid out: ${formatCurrency(profile.totalPaidOutUsd)}`}
          icon={HandCoins}
          accent="rose"
        />
      </div>
    </div>
  );
}

export function OverviewKpiStripSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Card key={i} size="sm" className="space-y-2 p-4">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-2.5 w-14" />
        </Card>
      ))}
    </div>
  );
}
