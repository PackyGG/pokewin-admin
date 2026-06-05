import { Suspense } from "react";
import {
  History,
  UserPlus,
  UserMinus,
  Handshake,
  RotateCcw,
  Ban,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { SkeletonTable } from "@/components/ux";
import { type DashboardPeriod } from "@/lib/queries/dashboard-period";
import {
  getCreatorsChangelogEvents,
  type CreatorChangelogEvent,
} from "@/lib/queries/creators-changelog";
import { clampCreatorsPeriod } from "../_lib/search-params";
import {
  CreatorsKpiPanel,
  CreatorsPlainHero,
  CreatorsPanelSub,
} from "../_components/creators-kpi-panel";
import { ChangelogPeriodFilter } from "./period-filter";
import { ChangelogFeed } from "./changelog-feed";

export const metadata = { title: "Creator Changelog" };

/**
 * /creators/changelog — a time-ordered, read-only feed of creator-marketing
 * admin actions (promote / deal / reset / exclusion) sourced from the
 * existing admin audit log. Modern page pattern (PageHero + KPI strip +
 * SectionHeading + feed), /audit table style, dark-mode + motion-safe.
 *
 * Visual language matches the reskinned main /creators page: the KPI strip
 * uses the same `CreatorsKpiPanel` boxes (tinted Card + header icon + hero
 * value + sub) the /creators strip uses, and the period chips are floored to
 * the same 48h minimum (`CREATORS_MIN_PERIOD`) via the shared
 * `clampCreatorsPeriod` helper.
 *
 * Active-timeframe-only: only the selected `?period=` window is queried,
 * inside a `<Suspense key={period}>` boundary so switching the chip
 * re-fetches just that one window (default/floor 48h). The param is clamped
 * to 48h+ here so the server only ever loads a 48h-or-wider window — no
 * eager pre-load of any other window.
 */
export default async function CreatorChangelogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/creators/changelog");
  const params = await searchParams;
  // Floor to the /creators 48h minimum (sub-48h windows are clamped up, an
  // absent param → 48h). Shared with `<ChangelogPeriodFilter>` so the loaded
  // window and the highlighted chip always agree.
  const period = clampCreatorsPeriod(params.period);

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
      {/* KPI strip — the same dashboard-style panel boxes the reskinned
          main /creators page uses (`CreatorsKpiPanel` + `CreatorsPlainHero`
          + `CreatorsPanelSub`) so the two surfaces read as one family.
          The count metrics + their icons are preserved; the heroes
          are plain counts (these are throughput tallies, not signed money,
          so no house-POV +/− sign). Accents stay within the panel tint set
          and consistent with /creators: blue for the neutral counts, emerald
          for deals (matches the feed's "Deal created" badge), purple for the
          corrective reset (the same family as /creators' purple Past-Creators
          tile), and rose for both the corrective creator-removal (matches the
          feed's "Creator removed" badge) and the guarded exclusion action
          (matches the feed's exclusion badge + the per-fill house-cost
          amounts already rendered in rose). Same responsive grid as the main
          strip, widened to 6 columns for the added removal tile. */}
      <div className="grid grid-cols-1 items-stretch gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 2xl:grid-cols-6">
        <CreatorsKpiPanel title="Events" icon={History} tint="blue">
          <CreatorsPlainHero value={events.length} format="number" />
          <CreatorsPanelSub>Creator-marketing actions</CreatorsPanelSub>
        </CreatorsKpiPanel>
        <CreatorsKpiPanel title="Creators signed" icon={UserPlus} tint="blue">
          <CreatorsPlainHero value={counts.user_made_creator} format="number" />
          <CreatorsPanelSub>Users promoted to creator</CreatorsPanelSub>
        </CreatorsKpiPanel>
        <CreatorsKpiPanel title="Deals created" icon={Handshake} tint="emerald">
          <CreatorsPlainHero
            value={counts.creator_deal_created}
            format="number"
          />
          <CreatorsPanelSub>New creator deals</CreatorsPanelSub>
        </CreatorsKpiPanel>
        <CreatorsKpiPanel title="Creators removed" icon={UserMinus} tint="rose">
          <CreatorsPlainHero value={counts.creator_removed} format="number" />
          <CreatorsPanelSub>Creators fired back to user</CreatorsPanelSub>
        </CreatorsKpiPanel>
        <CreatorsKpiPanel title="Resets to user" icon={RotateCcw} tint="purple">
          <CreatorsPlainHero
            value={counts.creator_force_reset_to_user}
            format="number"
          />
          <CreatorsPanelSub>Creators reset to plain user</CreatorsPanelSub>
        </CreatorsKpiPanel>
        <CreatorsKpiPanel title="Exclusions" icon={Ban} tint="rose">
          <CreatorsPlainHero
            value={counts.excluded_user_added + counts.excluded_user_removed}
            format="number"
          />
          <CreatorsPanelSub>Analytics-exclusion changes</CreatorsPanelSub>
        </CreatorsKpiPanel>
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
