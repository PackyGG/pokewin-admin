import { Suspense } from "react";
import { notFound } from "next/navigation";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import { getCreatorHeader } from "@/lib/queries/creators";

import { CreatorBanner } from "./_components/creator-banner";
import { CreatorTabBar } from "./_components/creator-tab-bar";
import {
  OverviewTab,
  parseCreatorActivityPeriod,
} from "./_components/overview-tab";
import { CreatorMetadataTab } from "./_components/creator-metadata-tab";
import { SessionsTab } from "./_components/sessions-tab";
import { KickTab } from "./_components/kick-tab";
import { TwitterTab } from "./_components/twitter-tab";
import { RiskTab, RiskTabSkeleton } from "./_components/risk-tab";
import { ForecastTab } from "./_components/forecast-tab";
import { CohortsLtvTab } from "./_components/cohorts-ltv-tab";
import { AltAccountsTab } from "./_components/alt-accounts-tab";

export const metadata = { title: "Creator · Creator Hub" };

/**
 * Tab keys that are wired (navigable) — Overview (default) + every creator
 * detail tab. A `?tab=` outside this set falls back to Overview.
 *
 * Kept inline in this server file (and mirrored by the client tab bar) on
 * purpose: `creator-tab-bar.tsx` is a Client Component, so a server import of a
 * value from it would throw at render ("called a client function from the
 * server"). Both lists are small and co-owned, so they can't silently drift.
 */
const NAV_TABS = [
  "overview",
  "creator",
  "sessions",
  "kick",
  "twitter",
  "risk",
  "forecast",
  "cohorts",
  "alts",
] as const;
type NavTab = (typeof NAV_TABS)[number];

function parseTab(value: string | undefined): NavTab {
  return (NAV_TABS as readonly string[]).includes(value ?? "")
    ? (value as NavTab)
    : "overview";
}

/**
 * Creator Hub — creator detail page (`creators/[id]`).
 *
 * Layout (owner spec):
 *   1. Top banner (identity bar): pfp, username, creator code chip(s), email
 *      with hide/show toggle, a button per linked social, a Discord-channel
 *      button.
 *   2. Tab bar: Overview (default) + Creator / Sessions / Kick / Twitter / Risk
 *      / Forecast / Cohorts & LTV / Alt Accounts (all navigable via `?tab=`).
 *   3. The active tab's content.
 *
 * ACCESS: `canAccessCreatorHub` (the layout enforces it; this page adds the
 * explicit gate too — every protected page gates server-side first).
 *
 * PERFORMANCE (active-tab-only / never-preload): only the cheap header (2
 * indexed lookups) is awaited on the critical path so the banner + tab bar
 * paint immediately. ONLY the active tab (resolved from `?tab=`) is mounted,
 * inside a `<Suspense>` keyed on the tab — so exactly one tab's data is ever
 * fetched, switching tabs swaps the URL + lazily loads just that tab, and no
 * other tab is eager-loaded. Each tab component additionally streams its own
 * heavy regions in their own inner Suspense boundaries.
 *
 * MAIN/prod game DB is READ-ONLY — every read here reuses an existing,
 * cached query; nothing writes MAIN and no schema changed.
 */
export default async function CreatorHubCreatorDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireCreatorHubPageAccess();

  const { id } = await params;
  const sp = await searchParams;
  // Coerce to a navigable tab (unknown / "Soon" / missing → Overview), so a
  // stale URL never mounts a tab that isn't wired this wave.
  const tab = parseTab(sp.tab);

  // Cheap header on the critical path (username / image / email / primary
  // code). A truly unknown user 404s; everything heavy streams below.
  const header = await getCreatorHeader(id);
  if (!header) notFound();

  return (
    <div className="space-y-5 sm:space-y-6">
      <CreatorBanner header={header} />
      <CreatorTabBar />

      {/* Only the active tab mounts — keyed on `tab` so switching forces a
          fresh boundary (and the fallback shows) instead of reusing the prior
          tab's tree. No other tab's data is fetched. */}
      <Suspense key={tab} fallback={<RiskTabSkeleton />}>
        {tab === "overview" && (
          <OverviewTab
            userId={id}
            activityPeriod={parseCreatorActivityPeriod(sp.activityPeriod)}
          />
        )}
        {tab === "creator" && <CreatorMetadataTab userId={id} />}
        {tab === "sessions" && <SessionsTab userId={id} />}
        {tab === "kick" && <KickTab userId={id} />}
        {tab === "twitter" && <TwitterTab userId={id} />}
        {tab === "risk" && <RiskTab userId={id} code={header.code} />}
        {tab === "forecast" && <ForecastTab userId={id} />}
        {tab === "cohorts" && <CohortsLtvTab userId={id} />}
        {tab === "alts" && <AltAccountsTab userId={id} />}
      </Suspense>
    </div>
  );
}
