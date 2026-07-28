import { Suspense } from "react";
import { notFound } from "next/navigation";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import { getCreatorHeader } from "@/lib/queries/creators";
import { safeQueryOrNull } from "@/lib/errors/safe-query";

import { CreatorBanner } from "./_components/creator-banner";
import { CreatorTabBar } from "./_components/creator-tab-bar";
import {
  OverviewTab,
  parseCreatorActivityPeriod,
} from "./_components/overview-tab";
import { CreatorMetadataTab } from "./_components/creator-metadata-tab";
import { SessionsTab } from "./_components/sessions-tab";
import { RiskTab } from "./_components/risk-tab";
import { CreatorTabSkeleton } from "./_components/creator-tab-skeleton";
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
  "risk",
  "alts",
] as const;
type NavTab = (typeof NAV_TABS)[number];

function parseTab(value: string | undefined): NavTab {
  return (NAV_TABS as readonly string[]).includes(value ?? "")
    ? (value as NavTab)
    : "overview";
}

// Hard cap on `?sessionsPage=` so a hand-typed URL can never drive an
// unbounded backend offset (200 pages × 50/page = 10k sessions — far above
// any real creator). Out-of-range INTEGER pages clamp here; a page beyond
// the creator's real last page renders the tab's clean "out of range"
// state with a back-to-page-1 link.
const SESSIONS_PAGE_CAP = 200;

/** Parse `?sessionsPage=` — integer ≥ 1, default 1, capped. */
function parseSessionsPage(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  const i = Math.floor(n);
  if (i < 1) return 1;
  return Math.min(i, SESSIONS_PAGE_CAP);
}

/**
 * Creator Hub — creator detail page (`creators/[id]`).
 *
 * Layout (owner spec):
 *   1. Top banner (identity bar): pfp, username, creator code chip(s), email
 *      with hide/show toggle, a button per linked social, a Discord-channel
 *      button.
 *   2. Tab bar: Overview (default) + Creator / Sessions / Risk / Alt Accounts
 *      (all navigable via `?tab=`).
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
  // Coerce to a navigable tab (unknown / missing → Overview), so a stale
  // URL never mounts a tab that doesn't exist.
  const tab = parseTab(sp.tab);
  // Sessions pagination is URL-driven (`?sessionsPage=`) — server-side and
  // bounded, only meaningful on the sessions tab (other tabs ignore it).
  const sessionsPage = tab === "sessions" ? parseSessionsPage(sp.sessionsPage) : 1;

  // Cheap header on the critical path (username / image / email / primary
  // code) — the ONLY blocking await (2 indexed lookups, 5s-bounded).
  //
  // De-fanged (was a raw await): a transient MAIN blip is NOT the same as a
  // missing user, but it used to escape this await and throw the whole page
  // into the error boundary. Now only a CONFIRMED unknown id 404s
  // (`!header && !headerError`); a failed/timed-out lookup renders the
  // degraded banner (user id + amber band) and still mounts the tab bar +
  // active tab — every tab only needs `userId`. One failing leg never
  // blanks the page.
  const {
    data: header,
    error: headerError,
    kind: headerFailureKind,
  } = await safeQueryOrNull(
    () => getCreatorHeader(id),
    "creator-hub.creators.header",
    5_000,
  );
  if (!header && !headerError) notFound();

  return (
    <div className="space-y-5 sm:space-y-6">
      <CreatorBanner
        header={header}
        userId={id}
        headerFailureKind={headerFailureKind ?? null}
      />
      <CreatorTabBar />

      {/* Only the active tab mounts — keyed on `tab` (and, for sessions, the
          page) so switching tabs OR paging forces a fresh boundary (the
          fallback shows) instead of reusing the prior tree. No other tab's
          data is fetched. */}
      <Suspense
        key={`${tab}:${tab === "sessions" ? sessionsPage : ""}`}
        fallback={<CreatorTabSkeleton />}
      >
        {tab === "overview" && (
          <OverviewTab
            userId={id}
            username={header?.username ?? null}
            activityPeriod={parseCreatorActivityPeriod(sp.activityPeriod)}
          />
        )}
        {tab === "creator" && <CreatorMetadataTab userId={id} />}
        {tab === "sessions" && <SessionsTab userId={id} page={sessionsPage} />}
        {tab === "risk" && <RiskTab userId={id} />}
        {tab === "alts" && <AltAccountsTab userId={id} />}
      </Suspense>
    </div>
  );
}
