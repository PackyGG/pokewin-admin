import { Suspense } from "react";
import {
  Bell,
  AlertTriangle,
  BellRing,
  ShieldAlert,
} from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/utils/format";

import { HubKpiBox } from "../_components/hub-kpi-box";
import { getCreatorAlerts } from "./_queries/creator-alerts";
import { AlertsList } from "./_components/alerts-list";

export const metadata = { title: "Alerts · Creator Hub" };

/**
 * Creator Hub — Alerts center ("needs attention").
 *
 * Alert CONTENT is derived live from existing data (deal expiring, withdraw
 * cap near, leaderboard ending, risk flags, P&L red, big FTD, went live).
 * Read/dismiss state persists in the ADMIN DB `creator_alerts` table so
 * managers aren't re-shown alerts they've handled.
 *
 * ACCESS: `canAccessCreatorHub` (founder `motha` or a role with the Hub
 * toggle on) — enforced explicitly here in addition to the layout gate.
 */
export default async function CreatorHubAlertsPage() {
  await requireCreatorHubPageAccess();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Bell}
          accent="pink"
          title="Alerts"
          subtitle="Needs-attention center — deals, caps, leaderboards, risk & live signals"
        />
      </PageHero>

      <Suspense fallback={<AlertsSkeleton />}>
        <AlertsSection />
      </Suspense>
    </div>
  );
}

async function AlertsSection() {
  const data = await getCreatorAlerts();

  return (
    <FadeIn className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <HubKpiBox
          label="Active alerts"
          icon={BellRing}
          accent="blue"
          value={formatNumber(data.counts.total)}
          sub="derived + not dismissed"
        />
        <HubKpiBox
          label="Unread"
          icon={Bell}
          accent="blue"
          value={formatNumber(data.counts.unread)}
          sub="awaiting acknowledgment"
          live={data.counts.unread > 0}
        />
        <HubKpiBox
          label="Critical"
          icon={ShieldAlert}
          accent="rose"
          value={formatNumber(data.counts.critical)}
          sub="needs immediate review"
          live={data.counts.critical > 0}
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={AlertTriangle} title="Attention queue" />
        <AlertsList alerts={data.alerts} syncError={data.syncError} />
      </div>
    </FadeIn>
  );
}

function AlertsSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-2xl" />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[120px] rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
