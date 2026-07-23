import { Suspense } from "react";
import {
  Activity,
  Coins,
  Handshake,
  History,
  LineChart,
  Percent,
  TrendingUp,
  Users,
} from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { TabChips } from "@/components/ux";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

import { getCreatorProfitability } from "./_queries/deal-profitability";
import {
  getPastDeals,
  parsePastDealsPage,
} from "./_queries/past-deals";
import { HubKpiBox } from "../_components/hub-kpi-box";
import { HubKpiInfoPopover } from "../_components/hub-kpi-info-popover";
import { ProfitabilityList } from "./_components/profitability-list";
import { PastDealsList } from "./_components/past-deals-list";
import { RosterError } from "../creators/_components/roster-error";

export const metadata = { title: "Profitability · Creator Hub" };

/**
 * The Past Deals leg can take ~30–55s on a cold-cache Vercel render — the
 * per-board affiliate-PnL transaction is the heaviest read in the Creator
 * Hub (a coverage-attributed scan across 25 board windows with a 55s
 * `SET LOCAL statement_timeout`). Vercel's default 15s function budget
 * cuts that off before the warm-fill completes, surfacing as a 500
 * (the prod incident with digest 3304963582). Raising the function
 * maxDuration to 120s matches the heavy admin pages already in the repo
 * (`/users/[id]`: 300, pack-studio doctor: 120) so the cold scan can
 * complete + warm the cache; subsequent loads serve the 5-min cached
 * value in milliseconds.
 */
export const maxDuration = 120;

type ProfitabilityTab = "active" | "past";

const TAB_CHIPS = [
  { value: "active", label: "Active" },
  { value: "past", label: "Past Deals" },
] as const;

function parseTab(raw: string | undefined): ProfitabilityTab {
  return raw === "past" ? "past" : "active";
}

const TAB_SUBTITLES: Record<ProfitabilityTab, string> = {
  active: "Per-creator deal cost vs the wager driven in the current deal frame.",
  past: "Final stats and conversion for every ended leaderboard-frame deal.",
};

/**
 * Creator Hub — Profitability.
 *
 * Shell-first: the hero + tab strip paint instantly; the active tab's
 * data section streams behind Suspense. Only the active tab loads on
 * each render (Active-Timeframe-Only). The Active tab keeps the existing
 * roster-walk view; the Past Deals tab lists every ENDED leaderboard frame
 * (= past deal under the "leaderboard frame IS the deal" model — the same
 * entity as Active, just finished) with server-side pagination
 * (25/page, `?page=`).
 */
export default async function CreatorHubProfitabilityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireCreatorHubPageAccess();

  const sp = await searchParams;
  const tab = parseTab(sp.tab);
  const page = parsePastDealsPage(sp.page);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={TrendingUp}
          accent="emerald"
          title="Profitability"
          subtitle={TAB_SUBTITLES[tab]}
        />
      </PageHero>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <SectionHeading
            icon={tab === "past" ? History : Coins}
            title={tab === "past" ? "Past deals" : "Deal economics"}
          />
          <TabChips
            items={TAB_CHIPS}
            current={tab}
            paramKey="tab"
            defaultValue="active"
          />
        </div>
        {/* Keyed Suspense so flipping tab/page shows skeleton, not stale data. */}
        <Suspense
          key={tab === "past" ? `past-${page}` : "active"}
          fallback={<ProfitabilitySkeleton />}
        >
          {tab === "past" ? (
            <PastDealsSection page={page} />
          ) : (
            <ActiveProfitabilitySection />
          )}
        </Suspense>
      </div>
    </div>
  );
}

async function ActiveProfitabilitySection() {
  // Same hard error isolation as `PastDealsSection` below (digest 3304963582):
  // `getCreatorProfitability` degrades its own legs, but an unexpected throw
  // here — a Prisma connection drop, a transient rejection — would escape to
  // (creator-hub)/error.tsx and take the hero + tab strip with it. This is the
  // DEFAULT tab, so it is the likeliest path to hit; degrade to the roster
  // error card and keep the shell painted.
  let data: Awaited<ReturnType<typeof getCreatorProfitability>>;
  try {
    data = await getCreatorProfitability();
  } catch (err) {
    console.error("[creator-hub.profitability] section threw — roster error:", err);
    return <RosterError />;
  }

  const { rows, totals, rosterUnavailable } = data;

  if (rosterUnavailable) {
    return <RosterError />;
  }

  // Actual PnL = affiliates made us − deal cost (house-profit convention).
  // Positive (cohort earned back more than the deal cost → house gain) →
  // emerald; negative (deal cost exceeded earnings → house loss) → rose.
  const pnlAccent = totals.totalActualPnl < 0 ? "rose" : "emerald";
  // Affiliates made us = cohort deposits − card withdrawals (house POV).
  // Positive = we kept value (house gain) → emerald; negative → rose.
  const affiliatesAccent =
    totals.totalAffiliatesMadeUs < 0 ? "rose" : "emerald";

  return (
    <FadeIn className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
        <HubKpiBox
          label="Active Deals"
          icon={Handshake}
          accent="blue"
          value={formatNumber(totals.totalActiveDeals)}
          sub="Creators on an active deal"
        />
        <HubKpiBox
          label="Total Cost"
          icon={Coins}
          accent="rose"
          value={formatCurrency(totals.totalCost)}
          sub="Cap + leaderboard + tips"
        />
        <HubKpiBox
          label="Total Actual PNL"
          icon={LineChart}
          accent={pnlAccent}
          value={formatCurrency(totals.totalActualPnl)}
          sub="Affiliates made us − deal cost"
        />
        <HubKpiBox
          label="Affiliates Made Us"
          icon={Users}
          accent={affiliatesAccent}
          value={formatCurrency(totals.totalAffiliatesMadeUs)}
          sub="Deposits − withdrawals − claims"
          info={
            <HubKpiInfoPopover
              title="Affiliates Made Us"
              description="What each creator's affiliate cohort net-earned the house, summed across the roster. Per creator = coverage-attributed cohort deposits − card withdrawals − the creator's own affiliate_claim code earnings, all measured strictly inside that creator's deal frame. Staff, creator-role users, blacklisted users and the creator's own deposits are excluded. House POV: positive = we kept value (emerald), negative = net loss (rose)."
              footer={{
                label: "Total",
                value: formatCurrency(totals.totalAffiliatesMadeUs),
                tone: totals.totalAffiliatesMadeUs < 0 ? "rose" : "emerald",
              }}
            />
          }
        />
        <HubKpiBox
          label="Expected Wager"
          icon={TrendingUp}
          accent="blue"
          value={formatCurrency(totals.totalExpectedWager)}
          sub="To cover deal cost"
        />
        <HubKpiBox
          label="Creator Wager"
          icon={Activity}
          accent="emerald"
          value={formatCurrency(totals.totalCreatorWager)}
          sub="Actual · in deal frame"
        />
        <HubKpiBox
          label="Avg Conversion"
          icon={Percent}
          accent="blue"
          value={`${totals.avgConversionRate.toFixed(2)}x`}
          sub="Actual ÷ expected wager"
        />
      </div>

      <div className="space-y-2">
        <p className="text-[11px] text-muted-foreground">
          Each creator&apos;s deal cost is checked against the wager driven
          inside their current leaderboard cycle (the active deal frame).
        </p>
        <ProfitabilityList rows={rows} />
      </div>
    </FadeIn>
  );
}

async function PastDealsSection({ page }: { page: number }) {
  // Hard error isolation: even though `getPastDeals` internally degrades on
  // slow / failing legs (safeQuery + per-leg try/catch), an unexpected throw
  // here (a Prisma connection drop, an Edge-Config read inside `resolveAdminRead`
  // erroring, a Suspense child rejecting on a transient state) must NOT escape
  // the section — otherwise the page hero + tab strip vanish behind the route
  // error boundary. The bug class behind digest `3304963582` is exactly this
  // kind of escape: the section throws, the (creator-hub)/error.tsx catches it,
  // and the user loses the whole page. Catching here keeps the shell painted
  // and degrades only the inner card to a friendly empty state.
  let data: Awaited<ReturnType<typeof getPastDeals>>;
  try {
    data = await getPastDeals(page);
  } catch (err) {
    console.error("[creator-hub.past-deals] section threw — empty state:", err);
    data = {
      rows: [],
      totals: {
        totalEndedDeals: 0,
        totalCost: 0,
        totalAffiliatesMadeUs: 0,
        totalActualPnl: 0,
        totalExpectedWager: 0,
        totalCreatorWager: 0,
        avgConversionRate: 0,
      },
      totalCount: 0,
      page: 1,
      totalPages: 1,
      backendUnavailable: true,
    };
  }

  // Every money KPI is page-scoped (see `getPastDeals`): cost, expected
  // wager, wager, affiliates-made-us, PnL and conversion all describe the
  // same 25 frames in the rows below, so the strip is internally coherent
  // and the accent can't mislead vs. what the user sees. Full-set wager/PnL
  // would force an unbounded scan — Active-Timeframe-Only forbids it.
  const pnlAccent = data.totals.totalActualPnl < 0 ? "rose" : "emerald";
  const affiliatesAccent =
    data.totals.totalAffiliatesMadeUs < 0 ? "rose" : "emerald";

  return (
    <FadeIn className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
        <HubKpiBox
          label="Ended Deals"
          icon={History}
          accent="blue"
          value={formatNumber(data.totals.totalEndedDeals)}
          sub="Ended leaderboard frames"
        />
        <HubKpiBox
          label="Page Cost"
          icon={Coins}
          accent="rose"
          value={formatCurrency(data.totals.totalCost)}
          sub="Fill + cap + LB + tips · page"
        />
        <HubKpiBox
          label="Page Actual PNL"
          icon={LineChart}
          accent={pnlAccent}
          value={formatCurrency(data.totals.totalActualPnl)}
          sub="Affiliates made us − cost · page"
        />
        <HubKpiBox
          label="Affiliates Made Us"
          icon={Users}
          accent={affiliatesAccent}
          value={formatCurrency(data.totals.totalAffiliatesMadeUs)}
          sub="Deposits − withdrawals · page"
          info={
            <HubKpiInfoPopover
              title="Affiliates Made Us (page)"
              description="Sum of the visible page's affiliate-PnL legs. Per row = coverage-attributed cohort deposits − card withdrawals − the creator's own affiliate_claim earnings, measured strictly inside that frame's window. Page-scoped so the heavy MAIN scan stays bounded to 25 frames per request (Active-Timeframe-Only)."
              footer={{
                label: "Page total",
                value: formatCurrency(data.totals.totalAffiliatesMadeUs),
                tone: data.totals.totalAffiliatesMadeUs < 0 ? "rose" : "emerald",
              }}
            />
          }
        />
        <HubKpiBox
          label="Expected Wager"
          icon={TrendingUp}
          accent="blue"
          value={formatCurrency(data.totals.totalExpectedWager)}
          sub="To cover page cost"
        />
        <HubKpiBox
          label="Page Wager"
          icon={Activity}
          accent="emerald"
          value={formatCurrency(data.totals.totalCreatorWager)}
          sub="Actual · this page"
        />
        <HubKpiBox
          label="Avg Conversion"
          icon={Percent}
          accent="blue"
          value={`${data.totals.avgConversionRate.toFixed(2)}x`}
          sub="Page average"
        />
      </div>

      <div className="space-y-2">
        <p className="text-[11px] text-muted-foreground">
          Each row is one ended leaderboard frame (a past deal). Cost, wager
          and PnL are computed over the full frame window (weekly or bi-weekly)
          — the same per-leg model as the Active tab. Sorted by most recently
          ended first.
        </p>
        <PastDealsList
          rows={data.rows}
          page={data.page}
          totalPages={data.totalPages}
          totalCount={data.totalCount}
          backendUnavailable={data.backendUnavailable}
        />
      </div>
    </FadeIn>
  );
}

function ProfitabilitySkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-2xl" />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-[76px] rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
