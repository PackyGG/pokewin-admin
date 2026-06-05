import { Suspense } from "react";
import {
  History,
  UserPlus,
  Handshake,
  RotateCcw,
  Ban,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { SkeletonTable } from "@/components/ux";
import { formatNumber } from "@/lib/utils/format";
import {
  parseDashboardPeriod,
  type DashboardPeriod,
} from "@/lib/queries/dashboard-period";
import {
  getCreatorsChangelogEvents,
  type CreatorChangelogEvent,
} from "@/lib/queries/creators-changelog";
import { ChangelogPeriodFilter } from "./period-filter";
import { ChangelogFeed } from "./changelog-feed";

export const metadata = { title: "Creator Changelog" };

/**
 * /creators/changelog — a time-ordered, read-only feed of creator-marketing
 * admin actions (promote / deal / reset / exclusion) sourced from the
 * existing admin audit log. Modern page pattern (PageHero + KPI strip +
 * SectionHeading + feed), /audit table style, dark-mode + motion-safe.
 *
 * Active-timeframe-only: only the selected `?period=` window is queried,
 * inside a `<Suspense key={period}>` boundary so switching the chip
 * re-fetches just that one window (default 3h). No eager pre-load of any
 * other window.
 */
export default async function CreatorChangelogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/creators/changelog");
  const params = await searchParams;
  const period = parseDashboardPeriod(params.period);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={History}
            title="Creator Changelog"
            subtitle="Every creator-marketing action — promotions, deals, resets, and exclusions — newest first."
            accent="blue"
          />
          <ChangelogPeriodFilter />
        </div>
      </PageHero>

      <Suspense key={period} fallback={<SkeletonTable rows={8} />}>
        <ChangelogContent period={period} />
      </Suspense>
    </div>
  );
}

/**
 * Data segment — isolated so the Suspense boundary above only suspends this
 * subtree on a period switch (the hero + period chips stay mounted). The
 * query reads the admin audit log (admin DB) for the active window and
 * resolves target usernames from the main DB (separate query, no cross-DB
 * join — see `getCreatorsChangelogEvents`).
 */
async function ChangelogContent({ period }: { period: DashboardPeriod }) {
  const events = await getCreatorsChangelogEvents({ period });

  const counts = countByType(events);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <KpiTile
          label="Events"
          value={formatNumber(events.length)}
          icon={History}
          accent="blue"
        />
        <KpiTile
          label="Creators signed"
          value={formatNumber(counts.user_made_creator)}
          icon={UserPlus}
          accent="blue"
        />
        <KpiTile
          label="Deals created"
          value={formatNumber(counts.creator_deal_created)}
          icon={Handshake}
          accent="emerald"
        />
        <KpiTile
          label="Resets to user"
          value={formatNumber(counts.creator_force_reset_to_user)}
          icon={RotateCcw}
          accent="amber"
        />
        <KpiTile
          label="Exclusions"
          value={formatNumber(
            counts.excluded_user_added + counts.excluded_user_removed,
          )}
          icon={Ban}
          accent="rose"
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={History} title="Activity" />
        <FadeIn className="space-y-4">
          <ChangelogFeed data={events} />
        </FadeIn>
      </div>
    </>
  );
}

/** Per-type tallies for the KPI strip (single in-memory pass). */
function countByType(events: CreatorChangelogEvent[]) {
  const counts = {
    user_made_creator: 0,
    creator_deal_created: 0,
    creator_force_reset_to_user: 0,
    excluded_user_added: 0,
    excluded_user_removed: 0,
  };
  for (const e of events) counts[e.eventType] += 1;
  return counts;
}
