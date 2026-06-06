import { Suspense } from "react";
import { notFound } from "next/navigation";

import { requireRole } from "@/lib/dal";
import { getCreatorHeader } from "@/lib/queries/creators";

import { CreatorBanner } from "./_components/creator-banner";
import { CreatorTabBar } from "./_components/creator-tab-bar";
import { OverviewTab } from "./_components/overview-tab";
import { CreatorMetadataTab } from "./_components/creator-metadata-tab";
import { RiskTab, RiskTabSkeleton } from "./_components/risk-tab";
import { ForecastTab } from "./_components/forecast-tab";
import { CohortsLtvTab } from "./_components/cohorts-ltv-tab";
import { AltAccountsTab } from "./_components/alt-accounts-tab";

export const metadata = { title: "Creator · Creator Hub" };

/**
 * Tab keys that are wired (navigable) this wave — Overview (default) + the five
 * tabs landed in this wave. Sessions / Kick / Twitter are intentionally NOT
 * here (still "Soon"); a `?tab=` outside this set falls back to Overview.
 *
 * Kept inline in this server file (and mirrored by the client tab bar) on
 * purpose: `creator-tab-bar.tsx` is a Client Component, so a server import of a
 * value from it would throw at render ("called a client function from the
 * server"). Both lists are small and co-owned, so they can't silently drift.
 */
const NAV_TABS = [
  "overview",
  "creator",
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
 *   2. Tab bar: Overview (default) + Creator / Risk / Forecast / Cohorts & LTV
 *      / Alt Accounts (all navigable via `?tab=`). Sessions / Kick / Twitter
 *      stay "Soon" placeholders — built in later waves.
 *   3. The active tab's content.
 *
 * ACCESS: admin + creator_manager only (the (creator-hub) layout enforces it;
 * this page adds the explicit DAL gate too — every protected page gates
 * server-side first per the house convention).
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
  await requireRole(["admin", "creator_manager"]);

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
        {tab === "overview" && <OverviewTab userId={id} />}
        {tab === "creator" && <CreatorMetadataTab userId={id} />}
        {tab === "risk" && <RiskTab userId={id} code={header.code} />}
        {tab === "forecast" && <ForecastTab userId={id} />}
        {tab === "cohorts" && <CohortsLtvTab userId={id} />}
        {tab === "alts" && <AltAccountsTab userId={id} />}
      </Suspense>
    </div>
  );
}
