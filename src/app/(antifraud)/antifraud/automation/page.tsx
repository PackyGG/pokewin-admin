import { Suspense } from "react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { TabChips } from "@/components/ux";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { AutomationControls } from "./_sections/controls";
import { AutomationDelivery } from "./_sections/delivery";
import { AutomationDetections } from "./_sections/detections";
import { AutomationOverview } from "./_sections/overview";

export const metadata = { title: "Automation · Antifraud" };

/**
 * AUTOMATION CONTROL CENTER
 *
 * The System group's front door. Previously one long scroll that mixed a
 * health summary, a link map, the live point flows, the code-owned catalog and
 * Discord coverage into a single page — every operator question needed a
 * scroll hunt, and every visit paid for all four data reads.
 *
 * Now four URL-addressable tabs with distinct jobs:
 *   overview   — what is broken right now, ranked, with a fix link each
 *   detections — everything that can fire, split by who owns it
 *   delivery   — where each enabled alert lands
 *   controls   — the switches owned here + the index of every other setting
 *
 * Active-tab-only (house rule): each tab is its own async component and ONLY
 * the selected branch is mounted, so a hidden tab never fires its monitor
 * reads. The `key={tab}` Suspense boundary re-suspends on every switch so the
 * skeleton matches the incoming tab rather than the outgoing one.
 */

type AutomationTab = "overview" | "detections" | "delivery" | "controls";

const AUTOMATION_TABS = [
  { value: "overview", label: "Overview" },
  { value: "detections", label: "Detections" },
  { value: "delivery", label: "Alert delivery" },
  { value: "controls", label: "Controls" },
] as const;

function resolveTab(value: string | undefined): AutomationTab {
  return value === "detections" ||
    value === "delivery" ||
    value === "controls"
    ? value
    : "overview";
}

export default async function AntifraudAutomationPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  await requireAntifraudManagerPage();
  const tab = resolveTab((await searchParams).tab);

  // Shell-first: the header, the tab bar and the tab's own skeleton paint
  // immediately; no monitor read is awaited in this body.
  return (
    <div className="space-y-4">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-600 dark:text-cyan-400">
          Control center
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Automation</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          Detection, scoring, automatic account actions, and alert delivery — what
          is live, what is broken, and where each setting is edited.
        </p>
      </div>

      <TabChips
        items={AUTOMATION_TABS}
        current={tab}
        paramKey="tab"
        defaultValue="overview"
      />

      <Suspense key={tab} fallback={<TabSkeleton tab={tab} />}>
        {tab === "detections" ? (
          <AutomationDetections />
        ) : tab === "delivery" ? (
          <AutomationDelivery />
        ) : tab === "controls" ? (
          <AutomationControls />
        ) : (
          <AutomationOverview />
        )}
      </Suspense>
    </div>
  );
}

function TabSkeleton({ tab }: { tab: AutomationTab }) {
  if (tab === "controls") {
    return (
      <div className="space-y-6">
        <Skeleton className="h-52 rounded-xl" />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-36 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (tab === "detections") {
    return (
      <div className="space-y-6">
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-40 rounded-xl" />
    </div>
  );
}
