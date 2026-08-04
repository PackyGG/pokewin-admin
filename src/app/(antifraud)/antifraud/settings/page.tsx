import { Suspense } from "react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { TabChips } from "@/components/ux";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { AlertsSection } from "./_sections/alerts";
import { AutomationSection } from "./_sections/automation";
import { EventsSection } from "./_sections/events";
import { FlowsSection } from "./_sections/flows";
import { EngineHealthSection } from "./_sections/health";
import { IntegrationsSection } from "./_sections/integrations";
import { OverviewSection } from "./_sections/overview";
import { ScoringSection } from "./_sections/scoring";

export const metadata = { title: "Settings · Antifraud" };

/**
 * FRAUD SETTINGS — one page, one tab switcher, every System section.
 *
 * The System group used to be a nav entry per surface (Automation, Rules &
 * scoring, Event catalog, Integrations, Config, Flows), each its own route with
 * its own tabs — the same handful of settings scattered across six places. It
 * is all one page now: the sidebar carries "Settings" and the sections are tabs
 * on it. The old routes redirect to their tab so existing links and bookmarks
 * keep working.
 *
 * Active-tab-only (house rule): each tab is its own async component and ONLY
 * the selected branch is mounted, so a hidden tab never fires its reads. The
 * `key={tab}` Suspense boundary re-suspends on every switch so the skeleton
 * matches the incoming tab rather than the outgoing one.
 */

const SETTINGS_TABS = [
  { value: "overview", label: "Overview" },
  { value: "automation", label: "Automation" },
  { value: "scoring", label: "Scoring" },
  { value: "flows", label: "Point flows" },
  { value: "events", label: "Events" },
  { value: "alerts", label: "Alerts" },
  { value: "integrations", label: "Integrations" },
  { value: "health", label: "Engine health" },
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number]["value"];

const TAB_VALUES = new Set<string>(SETTINGS_TABS.map((tab) => tab.value));

function resolveTab(value: string | undefined): SettingsTab {
  return value && TAB_VALUES.has(value) ? (value as SettingsTab) : "overview";
}

export default async function AntifraudSettingsPage({
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

      {/* No eyebrow, title or blurb: the sidebar already names the page and the
          tab bar already names the section. */}
      <TabChips
        items={SETTINGS_TABS}
        current={tab}
        paramKey="tab"
        defaultValue="overview"
      />

      <Suspense key={tab} fallback={<TabSkeleton tab={tab} />}>
        {tab === "automation" ? (
          <AutomationSection />
        ) : tab === "scoring" ? (
          <ScoringSection />
        ) : tab === "flows" ? (
          <FlowsSection />
        ) : tab === "events" ? (
          <EventsSection />
        ) : tab === "alerts" ? (
          <AlertsSection />
        ) : tab === "integrations" ? (
          <IntegrationsSection />
        ) : tab === "health" ? (
          <EngineHealthSection />
        ) : (
          <OverviewSection />
        )}
      </Suspense>
    </div>
  );
}

function TabSkeleton({ tab }: { tab: SettingsTab }) {
  if (tab === "flows") {
    return (
      <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
        <Skeleton className="h-[520px] rounded-xl" />
        <div className="space-y-4">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      </div>
    );
  }

  if (tab === "integrations") {
    return <Skeleton className="h-[520px] w-full rounded-xl" />;
  }

  if (tab === "automation") {
    return (
      <div className="space-y-6">
        <Skeleton className="h-52 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  // Overview, scoring, events, alerts and health all open on a KPI strip.
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
