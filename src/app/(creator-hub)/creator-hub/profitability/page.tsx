import { Suspense } from "react";
import {
  AlertTriangle,
  Coins,
  History,
  LineChart,
  TrendingUp,
  Users,
} from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { TabChips } from "@/components/ux";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

import { getCreatorProfitability } from "./_queries/deal-profitability";
import {
  PAST_DEALS_PAGE_SIZE,
  getPastDeals,
  parsePastDealsPage,
} from "./_queries/past-deals";
import { HubKpiInfoPopover } from "../_components/hub-kpi-info-popover";
import { HubNotice } from "../_components/hub-notice";
import { conversionClass } from "./_components/deal-formatters";
import { ProfitabilityList } from "./_components/profitability-list";
import { PastDealsList } from "./_components/past-deals-list";
import { ProfitabilitySkeleton } from "./_components/profitability-skeleton";

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
 * Shell-first: the SectionHeading identity + tab strip paint instantly
 * (page identity is a SectionHeading — no hero titles, owner decision);
 * the active tab's data section streams behind Suspense. Only the active
 * tab loads on each render (Active-Timeframe-Only). The Active tab keeps
 * the existing roster-walk view; the Past Deals tab lists every ENDED
 * leaderboard frame (= past deal under the "leaderboard frame IS the deal"
 * model — the same entity as Active, just finished) with server-side
 * pagination (25/page, `?page=`).
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
      {/* Page identity — SectionHeading (no hero titles by owner decision). */}
      <div className="space-y-1.5">
        <SectionHeading icon={TrendingUp} title="Profitability" />
        <p className="text-xs text-muted-foreground">{TAB_SUBTITLES[tab]}</p>
      </div>

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
          fallback={<ProfitabilitySkeleton coldLoadNote={tab === "past"} />}
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

/** Amber degraded card for a failed roster/backend walk (HubNotice tone). */
function ProfitabilityUnavailable() {
  return (
    <HubNotice
      tone="amber"
      icon={AlertTriangle}
      title="Profitability unavailable"
    >
      Couldn&apos;t load the creator roster from the backend. Try refreshing in
      a moment.
    </HubNotice>
  );
}

/**
 * Compact secondary stat line — the demoted wager/conversion trio (plus the
 * deal count) that used to be four full KPI boxes. One flat rounded-lg bar
 * under the headline tiles.
 */
function SecondaryStatLine({
  items,
}: {
  items: { label: string; value: string; className?: string }[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 rounded-lg border bg-card px-3 py-2">
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {item.label}
          </span>
          <span
            className={cn(
              "text-xs font-semibold tabular-nums",
              item.className,
            )}
          >
            {item.value}
          </span>
        </div>
      ))}
    </div>
  );
}

async function ActiveProfitabilitySection() {
  // Same hard error isolation as `PastDealsSection` below (digest 3304963582):
  // `getCreatorProfitability` degrades its own legs, but an unexpected throw
  // here — a database connection drop, a transient rejection — would escape to
  // (creator-hub)/error.tsx and take the identity + tab strip with it. This is
  // the DEFAULT tab, so it is the likeliest path to hit; degrade to the amber
  // notice and keep the shell painted.
  let data: Awaited<ReturnType<typeof getCreatorProfitability>>;
  try {
    data = await getCreatorProfitability();
  } catch (err) {
    console.error("[creator-hub.profitability] section threw — notice:", err);
    return <ProfitabilityUnavailable />;
  }

  const { rows, totals, rosterUnavailable } = data;

  if (rosterUnavailable) {
    return <ProfitabilityUnavailable />;
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
      <div className="space-y-2">
        {/* Explicit totals scope — the Active strip sums the FULL roster. */}
        <p className="text-[11px] text-muted-foreground">
          Totals: all {formatNumber(rows.length)} current deals (full set) ·{" "}
          {formatNumber(totals.totalActiveDeals)} active,{" "}
          {formatNumber(rows.length - totals.totalActiveDeals)} scheduled
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <KpiTile
            label="Deal Cost"
            icon={Coins}
            accent="rose"
            value={formatCurrency(totals.totalCost)}
            sub="Cap + leaderboard + tips"
            action={
              <HubKpiInfoPopover
                title="Deal Cost"
                description="Σ per-creator cost of the current deal frame: full withdraw cap + (tip + sponsor) × fills across the frame's weekly deals, plus the leaderboard net prize × 50% (the house always pays half). No daily-fill leg — the withdraw cap already bounds fill exposure. House cost → rose."
                lines={[
                  {
                    label: "Expected wager to cover (cost ÷ 7.5% edge)",
                    value: formatCurrency(totals.totalExpectedWager),
                    tone: "muted",
                  },
                ]}
                footer={{
                  label: "Total cost",
                  value: formatCurrency(totals.totalCost),
                  tone: "rose",
                }}
              />
            }
          />
          <KpiTile
            label="Affiliates Made Us"
            icon={Users}
            accent={affiliatesAccent}
            value={formatCurrency(totals.totalAffiliatesMadeUs)}
            sub="Deposits − withdrawals − claims"
            action={
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
          <KpiTile
            label="Actual PnL"
            icon={LineChart}
            accent={pnlAccent}
            value={formatCurrency(totals.totalActualPnl)}
            sub="Affiliates made us − deal cost"
            action={
              <HubKpiInfoPopover
                title="Actual PnL"
                description="Affiliates made us − deal cost, summed across the roster (house-profit convention). Positive = the cohorts earned back more than the deals cost (emerald); negative = the deals cost more than the cohorts earned us (rose)."
                lines={[
                  {
                    label: "Affiliates made us",
                    value: formatCurrency(totals.totalAffiliatesMadeUs),
                    tone: totals.totalAffiliatesMadeUs < 0 ? "rose" : "emerald",
                  },
                  {
                    label: "Deal cost",
                    value: `− ${formatCurrency(totals.totalCost)}`,
                    tone: "rose",
                  },
                ]}
                footer={{
                  label: "Actual PnL",
                  value: formatCurrency(totals.totalActualPnl),
                  tone: totals.totalActualPnl < 0 ? "rose" : "emerald",
                }}
              />
            }
          />
        </div>
        <SecondaryStatLine
          items={[
            {
              label: "Active Deals",
              value: formatNumber(totals.totalActiveDeals),
            },
            {
              label: "Expected Wager",
              value: formatCurrency(totals.totalExpectedWager),
            },
            {
              label: "Actual Wager",
              value: formatCurrency(totals.totalCreatorWager),
              className: "text-emerald-600 dark:text-emerald-400",
            },
            {
              label: "Avg Conversion",
              value: `${totals.avgConversionRate.toFixed(2)}x`,
              className: conversionClass(totals.avgConversionRate),
            },
          ]}
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
  // here (a database connection drop, an Edge-Config read inside `resolveAdminRead`
  // erroring, a Suspense child rejecting on a transient state) must NOT escape
  // the section — otherwise the page identity + tab strip vanish behind the
  // route error boundary. The bug class behind digest `3304963582` is exactly
  // this kind of escape: the section throws, the (creator-hub)/error.tsx
  // catches it, and the user loses the whole page. Catching here keeps the
  // shell painted and degrades only the inner card to a friendly empty state.
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

  const first = (data.page - 1) * PAST_DEALS_PAGE_SIZE + 1;
  const last = Math.min(data.page * PAST_DEALS_PAGE_SIZE, data.totalCount);
  const scopeLabel =
    data.totalCount > 0
      ? `Totals: this page (${formatNumber(first)}–${formatNumber(last)} of ${formatNumber(
          data.totalCount,
        )} ended deals)`
      : "Totals: this page (no ended deals)";

  return (
    <FadeIn className="space-y-6">
      <div className="space-y-2">
        {/* Explicit totals scope — Past money totals are PAGE-scoped. */}
        <p className="text-[11px] text-muted-foreground">{scopeLabel}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <KpiTile
            label="Deal Cost"
            icon={Coins}
            accent="rose"
            value={formatCurrency(data.totals.totalCost)}
            sub="Cap + leaderboard + tips"
            action={
              <HubKpiInfoPopover
                title="Deal Cost (page)"
                description="Σ cost of the 25 ended frames on this page: full withdraw cap + (tip + sponsor) × fills across each frame's weekly deals, plus the leaderboard net prize × 50% (the house always pays half). No daily-fill leg. Page-scoped so the strip matches the rows below."
                lines={[
                  {
                    label: "Expected wager to cover (cost ÷ 7.5% edge)",
                    value: formatCurrency(data.totals.totalExpectedWager),
                    tone: "muted",
                  },
                ]}
                footer={{
                  label: "Page cost",
                  value: formatCurrency(data.totals.totalCost),
                  tone: "rose",
                }}
              />
            }
          />
          <KpiTile
            label="Affiliates Made Us"
            icon={Users}
            accent={affiliatesAccent}
            value={formatCurrency(data.totals.totalAffiliatesMadeUs)}
            sub="Deposits − withdrawals − claims"
            action={
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
          <KpiTile
            label="Actual PnL"
            icon={LineChart}
            accent={pnlAccent}
            value={formatCurrency(data.totals.totalActualPnl)}
            sub="Affiliates made us − deal cost"
            action={
              <HubKpiInfoPopover
                title="Actual PnL (page)"
                description="Affiliates made us − deal cost, summed over this page's ended frames (house-profit convention). Positive = the cohorts earned back more than the deals cost (emerald); negative = house loss (rose)."
                lines={[
                  {
                    label: "Affiliates made us",
                    value: formatCurrency(data.totals.totalAffiliatesMadeUs),
                    tone:
                      data.totals.totalAffiliatesMadeUs < 0 ? "rose" : "emerald",
                  },
                  {
                    label: "Deal cost",
                    value: `− ${formatCurrency(data.totals.totalCost)}`,
                    tone: "rose",
                  },
                ]}
                footer={{
                  label: "Actual PnL",
                  value: formatCurrency(data.totals.totalActualPnl),
                  tone: data.totals.totalActualPnl < 0 ? "rose" : "emerald",
                }}
              />
            }
          />
        </div>
        <SecondaryStatLine
          items={[
            {
              label: "Ended Deals",
              value: formatNumber(data.totals.totalEndedDeals),
            },
            {
              label: "Expected Wager",
              value: formatCurrency(data.totals.totalExpectedWager),
            },
            {
              label: "Actual Wager",
              value: formatCurrency(data.totals.totalCreatorWager),
              className: "text-emerald-600 dark:text-emerald-400",
            },
            {
              label: "Avg Conversion",
              value: `${data.totals.avgConversionRate.toFixed(2)}x`,
              className: conversionClass(data.totals.avgConversionRate),
            },
          ]}
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
