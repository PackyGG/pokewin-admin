import { Suspense } from "react";
import {
  requirePageAccess,
  sessionIsAdmin,
  sessionIsOwner,
} from "@/lib/dal";
import { AutoRefresh } from "../dashboard/auto-refresh";
import { PeriodFilter } from "./period-filter";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { AnalyticsTabNav, type AnalyticsTab } from "./tab-nav";
import {
  parsePeriod,
  toDoubleDownPeriod,
  toInsightsPeriod,
} from "./types";
import { AcquisitionSection } from "./acquisition-section";
import { CoreSections } from "./overview-page";
import { SkeletonChart, SkeletonKpiStrip } from "@/components/ux";
import { GamesTab, parseGameView } from "./tab-games";
import { CrmTab } from "../insights/real-numbers/crm-tab";
import { CostBreakdownTab } from "./tab-cost-breakdown";
import { RewardsTab } from "./tab-rewards";
import { MapTab } from "./tab-map";
import { parseMetric } from "./map/utils";
import { parsePage } from "@/lib/utils/pagination";
import { TabSkeleton } from "./tab-skeleton";
import { parseKenoTab } from "../keno/tabs";

export const metadata = { title: "Analytics" };

// A deleted tab's URL (?tab=cohorts, funnel, ltv, retention, top, packs,
// revenue) falls through to Overview rather than 404-ing — a stale bookmark
// lands somewhere useful, and for Revenue specifically Overview is where its
// surviving panel (withdrawn cash per rail) now lives.
function parseTab(value: string | undefined): AnalyticsTab {
  switch (value) {
    case "overview":
    case "crm":
    case "cost-breakdown":
    case "rewards":
    case "games":
    case "map":
      return value;
    default:
      return "overview";
  }
}

/**
 * Tabs the page-level `?period=` drives.
 *
 * Owner, 2026-07-23: the timespan control applies to EVERY tab that has a
 * timespan. The tabs absorbed from the old /insights tree used to ship their
 * own period filters (`?cbPeriod=`, `?rwPeriod=`) and Double Down was pinned
 * to 30d — three controls doing one job, so switching tabs silently changed
 * the window you were looking at. They all read the page filter now,
 * translated by `toInsightsPeriod` / `toDoubleDownPeriod`.
 *
 * The one absentee is genuine, not an oversight: CRM takes no period argument
 * at all, so a filter there would be a dead knob — exactly what this change
 * removes everywhere else.
 */
const PERIOD_DRIVEN_TABS = new Set<AnalyticsTab>([
  "overview",
  "map",
  "cost-breakdown",
  "rewards",
  // Games drives every mode's window from the page filter — the Double Down
  // log + charts.
  "games",
]);

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePageAccess("/analytics");
  const params = await searchParams;
  const period = parsePeriod(params.period);
  const tab = parseTab(params.tab);
  // Double Down tab params (absorbed from /insights/double-down): `q` is the
  // audit-log search, `page` its pagination. Parsed defensively — a fuzzed
  // ?page= must never reach the query's OFFSET.
  // Games tab sub-view (?g=): packs | battles | upgrader | double-down | keno.
  const gameView = parseGameView(params.g);
  const kenoTab = parseKenoTab(params.kenoTab);
  const ddSearch = (params.q ?? "").trim();
  // Shared parser: rejects NaN / ≤ 0 / fractional like the hand-rolled guard
  // this replaces, and additionally caps the reachable OFFSET so a fuzzed
  // `?page=1e12` can't become a scan the planner has to walk.
  const ddPage = parsePage(params.page);
  // Games → packs/battles sort column (?packsSort=), validated inside the
  // sub-tab so a fuzzed value falls back to "revenue" rather than reaching SQL.
  const packsSort = params.packsSort;
  // Absorbed-tab sub-view param. The per-tab period params (`cbPeriod`,
  // `rwPeriod`) are gone — those tabs read the page-level `?period=` now, so
  // a stale bookmark carrying one simply falls back to the global window.
  const rwSub = params.rw;
  // Rewards → Programs view: which program's deep panel is open (`?p=`).
  // Only that program's extra reads fire, so the other six stay untouched.
  const rwProgram = params.p;
  const insightsPeriod = toInsightsPeriod(period);
  // Map tab uses its own URL param for the heat metric (users /
  // deposits / wagers / multiplier). Parsed here so the param flows
  // into the Suspense key and the tab segment re-renders when the
  // user toggles metrics.
  const mapMetric = parseMetric(params.metric);

  return (
    <div className="space-y-6">
      {/* Analytics polls at 300s — these aggregates move on hour/day
          boundaries, not seconds. Use the period/tab navigation to
          force a fresh fetch when needed. */}
      <AutoRefresh intervalMs={300_000} />
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      {/* Period filter rides the tab row instead of the hero (owner,
          2026-07-23: the page was wasting height). On phones the hero used to
          stack identity + a 5-chip filter vertically, costing a whole row
          before any data; here it sits at the end of a row that already
          exists. The tab strip keeps its own horizontal scroll, so the filter
          stays pinned and visible however many tabs there are.

          It renders ONLY on tabs the page-level `?period=` actually drives.
          Player CRM is the lone absentee: it takes no period argument at all,
          so a filter there would be a dead knob. */}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <AnalyticsTabNav />
        </div>
        {PERIOD_DRIVEN_TABS.has(tab) &&
          !(tab === "games" && gameView === "keno") && (
          <div className="shrink-0">
            <PeriodFilter />
          </div>
        )}
      </div>

      {/* The default view is the one-page overview (2026-08 redesign):
          Acquisition streams first behind its own boundary so the top of the
          page paints even when the heavy overview aggregate is slow, then the
          core sections stream as one segment with their own nested legs.
          The specialist deep dives keep the single-tab render below — only
          the active tab ever hits the DB. */}
      {tab === "overview" ? (
        <div className="space-y-6">
          <Suspense
            key={`acq-${period}`}
            fallback={
              <div className="space-y-3">
                <SkeletonKpiStrip count={3} className="sm:grid-cols-3" />
                <SkeletonChart height={300} variant="area" />
              </div>
            }
          >
            <AcquisitionSection period={period} />
          </Suspense>
          <Suspense key={`core-${period}`} fallback={<TabSkeleton />}>
            <CoreSections period={period} />
          </Suspense>
        </div>
      ) : (
      <Suspense
        key={`${tab}-${period}-${mapMetric}-${gameView}-${kenoTab}-${packsSort ?? ""}-${ddSearch}-${ddPage}-${rwSub ?? ""}-${rwProgram ?? ""}`}
        fallback={<TabSkeleton />}
      >
        {tab === "games" && (
          <GamesTab
            view={gameView}
            period={period}
            ddPeriod={toDoubleDownPeriod(period)}
            search={ddSearch}
            page={ddPage}
            packsSort={packsSort}
            kenoTab={kenoTab}
            canEditKeno={sessionIsAdmin(session) || sessionIsOwner(session)}
          />
        )}
        {tab === "crm" && <CrmTab />}
        {tab === "cost-breakdown" && (
          <CostBreakdownTab period={insightsPeriod} />
        )}
        {tab === "rewards" && (
          <RewardsTab
            period={insightsPeriod}
            sub={rwSub}
            program={rwProgram}
          />
        )}
        {tab === "map" && <MapTab period={period} metric={mapMetric} />}
      </Suspense>
      )}
    </div>
  );
}
