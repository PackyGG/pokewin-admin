import { Suspense } from "react";
import {
  History,
  UserPlus,
  UserMinus,
  Handshake,
  RotateCcw,
  Ban,
} from "lucide-react";

import { requireRole } from "@/lib/dal";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { SkeletonTable } from "@/components/ux";
import { Skeleton } from "@/components/ui/skeleton";
import {
  parseDashboardPeriod,
  DASHBOARD_PERIOD_LABELS,
  type DashboardPeriod,
} from "@/lib/queries/dashboard-period";
import { formatNumber } from "@/lib/utils/format";
import {
  getCreatorsChangelogEvents,
  type CreatorChangelogEvent,
} from "@/lib/queries/creators-changelog";

import { HubKpiBox } from "../_components/hub-kpi-box";
import { HubChangelogPeriodSelector } from "./_components/hub-changelog-period-selector";
import { HubChangelogFeed } from "./_components/hub-changelog-feed";

export const metadata = { title: "Changelog · Creator Hub" };

/**
 * Creator Hub → Changelog.
 *
 * The Hub-styled port of `/creators/changelog`: a time-ordered, read-only
 * feed of creator-marketing admin actions (promote / deal / reset /
 * removal / exclusion). It reuses the EXACT existing data + logic —
 * `getCreatorsChangelogEvents` from `@/lib/queries/creators-changelog`
 * (one shared query, two surfaces) — but rendered in the Hub's modern
 * chrome (slim `PageHero` + Hub KPI boxes + the Hub card container).
 *
 * ACCESS: admin + creator_manager only. The Hub layout enforces it; this
 * page adds the explicit DAL gate too (every protected page gates
 * server-side first per the house convention).
 *
 * ACTIVE-TIMEFRAME-ONLY: the period selector defaults to 24h; the data
 * segment is wrapped in a `<Suspense key={period}>` boundary, so only the
 * active window is queried on first render and switching the chip lazily
 * loads just that one window (never preloading all windows). The selected
 * window scopes both the KPI counts and the feed.
 */
export default async function CreatorHubChangelogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireRole(["admin", "creator_manager"]);

  // Reuse the canonical dashboard period parse so the changelog selector
  // (24h / 7d / 30d / all) and the rest of the Hub agree on the window
  // semantics. The changelog query accepts any DashboardPeriod.
  const period = parseDashboardPeriod((await searchParams).period);
  const windowLabel = DASHBOARD_PERIOD_LABELS[period].toLowerCase();

  return (
    <div className="space-y-6">
      {/* Slim hero — Changelog identity + active window. Blue/History accent
          (neutral audit surface) matching the existing /creators/changelog. */}
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={History}
            accent="blue"
            title="Changelog"
            subtitle={`Creator-marketing actions — promotions, deals, resets, removals & exclusions · ${windowLabel}`}
          />
          <HubChangelogPeriodSelector current={period} />
        </div>
      </PageHero>

      {/* Data segment — keyed on `period` so only the active window loads and
          switching repaints just this boundary (lazy, active-timeframe-only). */}
      <Suspense key={period} fallback={<ChangelogSkeleton />}>
        <ChangelogSection period={period} />
      </Suspense>
    </div>
  );
}

// ─── Data section (streamed via Suspense) ──────────────────────────────

/**
 * Data segment — isolated so the Suspense boundary above only suspends this
 * subtree on a period switch (the hero + period chips stay mounted). The
 * query reads the admin audit log (admin DB) for the active window and
 * resolves target usernames from the main DB (separate query, no cross-DB
 * join — see `getCreatorsChangelogEvents`).
 */
async function ChangelogSection({ period }: { period: DashboardPeriod }) {
  const events = await getCreatorsChangelogEvents({ period });
  const counts = countByType(events);

  return (
    <FadeIn className="space-y-4">
      {/* KPI strip — Hub-native KPI boxes (matches the dashboard's
          `HubKpiBox`). House-POV accents per CLAUDE.md: blue for the
          neutral throughput counts, emerald for deals created (a normal
          positive marketing event), rose for both creator removals and
          analytics exclusions (corrective / guarded actions), purple is
          not in the Hub box accent set so the corrective reset count uses
          blue. All counts are real (computed in-memory from the fetched
          window's events — no fabricated numbers). */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <HubKpiBox
          label="Events"
          icon={History}
          accent="blue"
          value={formatNumber(events.length)}
          sub="creator-marketing actions"
        />
        <HubKpiBox
          label="Creators Signed"
          icon={UserPlus}
          accent="blue"
          value={formatNumber(counts.user_made_creator)}
          sub="users promoted to creator"
        />
        <HubKpiBox
          label="Deals Created"
          icon={Handshake}
          accent="emerald"
          value={formatNumber(counts.creator_deal_created)}
          sub="new creator deals"
        />
        <HubKpiBox
          label="Creators Removed"
          icon={UserMinus}
          accent="rose"
          value={formatNumber(counts.creator_removed)}
          sub="creators fired back to user"
        />
        <HubKpiBox
          label="Resets To User"
          icon={RotateCcw}
          accent="blue"
          value={formatNumber(counts.creator_force_reset_to_user)}
          sub="creators reset to plain user"
        />
        <HubKpiBox
          label="Exclusions"
          icon={Ban}
          accent="rose"
          value={formatNumber(
            counts.excluded_user_added + counts.excluded_user_removed,
          )}
          sub="analytics-exclusion changes"
        />
      </div>

      {/* Feed */}
      <div className="space-y-3">
        <SectionHeading icon={History} title="Activity" />
        <HubChangelogFeed data={events} />
      </div>
    </FadeIn>
  );
}

/** Per-type tallies for the KPI strip (single in-memory pass). */
function countByType(events: CreatorChangelogEvent[]) {
  const counts = {
    user_made_creator: 0,
    creator_deal_created: 0,
    creator_deal_updated: 0,
    creator_webhook_created: 0,
    creator_webhook_updated: 0,
    creator_webhook_deleted: 0,
    creator_force_reset_to_user: 0,
    creator_removed: 0,
    excluded_user_added: 0,
    excluded_user_removed: 0,
  };
  for (const e of events) counts[e.eventType] += 1;
  return counts;
}

// ─── Skeleton ──────────────────────────────────────────────────────────

/**
 * In-boundary skeleton for a window switch — mirrors the data section's
 * shape (6 KPI boxes + the activity heading + a feed of rows) so the swap
 * doesn't reflow. The route-level `loading.tsx` covers the cold-nav first
 * paint; this only renders while a `?period=` change re-fetches.
 */
function ChangelogSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-2xl" />
        ))}
      </div>
      <div className="space-y-3">
        <Skeleton className="h-5 w-28 rounded" />
        <SkeletonTable rows={8} />
      </div>
    </div>
  );
}
