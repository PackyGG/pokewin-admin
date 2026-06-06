import { notFound } from "next/navigation";

import { requireRole } from "@/lib/dal";
import { getCreatorHeader } from "@/lib/queries/creators";

import { CreatorBanner } from "./_components/creator-banner";
import { CreatorTabBar } from "./_components/creator-tab-bar";
import { OverviewTab } from "./_components/overview-tab";

export const metadata = { title: "Creator · Creator Hub" };

/**
 * Creator Hub — creator detail page (`creators/[id]`).
 *
 * Layout (owner spec):
 *   1. Top banner (identity bar): pfp, username, creator code chip(s), email
 *      with hide/show toggle, a button per linked social, a Discord-channel
 *      button.
 *   2. Tab bar: Overview (active) + the future tabs (Creator / Sessions /
 *      Kick / Twitter / Risk / Forecast / Cohorts & LTV / Alt Accounts) as
 *      "Soon" placeholders — built in later waves.
 *   3. Overview tab content (KPI strip → Deal | Leaderboards → Performance).
 *
 * ACCESS: admin + creator_manager only (the (creator-hub) layout enforces it;
 * this page adds the explicit DAL gate too — every protected page gates
 * server-side first per the house convention).
 *
 * PERFORMANCE (active-tab-only / never-preload): only the cheap header (2
 * indexed lookups) is awaited on the critical path so the banner + tab bar
 * paint immediately; every heavy Overview region streams in its own keyed
 * Suspense boundary. The non-Overview tabs are inert placeholders this wave,
 * so NO other tab's data is ever fetched.
 *
 * MAIN/prod game DB is READ-ONLY — every read here reuses an existing,
 * cached query; nothing writes MAIN and no schema changed.
 */
export default async function CreatorHubCreatorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole(["admin", "creator_manager"]);

  const { id } = await params;

  // Cheap header on the critical path (username / image / email / primary
  // code). A truly unknown user 404s; everything heavy streams below.
  const header = await getCreatorHeader(id);
  if (!header) notFound();

  return (
    <div className="space-y-5 sm:space-y-6">
      <CreatorBanner header={header} />
      <CreatorTabBar />
      <OverviewTab userId={id} />
    </div>
  );
}
