import { Suspense } from "react";
import {
  CalendarClock,
  CheckCircle2,
  Gauge,
  Info,
  TrendingDown,
  TrendingUp,
  XCircle,
} from "lucide-react";

import {
  SectionHeading,
  StatPanel,
  PanelRow,
  type AccentColor,
} from "@/components/modern-panels";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FadeIn } from "@/components/fade-in";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

import { getForecastData, type ForecastSpan } from "../_queries/forecast-data";
import { ForecastChart } from "./forecast-chart";

/**
 * Forecast tab for `creators/[id]`.
 *
 * Projects whether THIS creator's deal stays profitable for the HOUSE over
 * 1 week / 2 weeks / 1 month, driven by his CURRENT realized wager rate +
 * realized PnL AND the deal stats (withdraw cap + leaderboard funding ×
 * house% + tip/sponsor allowance), using the owner's Profitable Algo math:
 *
 *   Generated Value = projected wager × 0.075
 *   Deal Spend      = (weekly withdraw cap + weekly LB funding + weekly
 *                      tip/sponsor) × (span days / 7)
 *   Rate of Return  = Generated Value / Deal Spend   → profitable when > 1
 *
 * House-POV colors:
 *   • Generated value (value the deal makes the HOUSE) → emerald.
 *   • Deal spend (what the deal COSTS the house) → rose.
 *   • Net / RoR ≥ 1 → profitable for the house → emerald; < 1 → rose.
 *
 * LAZY: the whole tab streams inside one Suspense boundary; its data
 * (`getForecastData`) only runs because the page renders this component for
 * ?tab=forecast — so the heavy reuse-reads fire ONLY when the tab is opened
 * (active-tab-only / never-preload). Server component; the only client leaf is
 * the recharts comparison, which takes serializable props (no function props).
 */
export function ForecastTab({ userId }: { userId: string }) {
  return (
    <FadeIn className="space-y-5 sm:space-y-6">
      <Suspense fallback={<ForecastSkeleton />}>
        <ForecastBody userId={userId} />
      </Suspense>
    </FadeIn>
  );
}

async function ForecastBody({ userId }: { userId: string }) {
  const data = await getForecastData(userId);

  const chartData = data.spans.map((s) => ({
    label: s.label,
    generatedValueUsd: Math.round(s.generatedValueUsd),
    dealSpendUsd: Math.round(s.dealSpendUsd),
  }));

  const hasSpend = data.weeklyDealSpendUsd > 0;
  const hasWager = data.dailyWagerUsd > 0;

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* Caveat banner whenever an input is missing/estimated. */}
      {data.notes.length > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3.5 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <div className="space-y-1">
            <div className="font-medium text-amber-500">
              Forecast is an estimate
            </div>
            <ul className="list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
              {data.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* ── 1. Per-span projection cards ─────────────────────────────── */}
      <section className="space-y-3">
        <SectionHeading
          icon={CalendarClock}
          title="Deal profitability forecast"
        />
        <div className="grid gap-3 sm:grid-cols-3">
          {data.spans.map((span) => (
            <ForecastSpanCard
              key={span.key}
              span={span}
              hasSpend={hasSpend}
              hasWager={hasWager}
            />
          ))}
        </div>
      </section>

      {/* ── 2. Value vs spend comparison chart ───────────────────────── */}
      <section className="space-y-3">
        <SectionHeading icon={Gauge} title="Generated value vs deal spend" />
        <Card size="sm" className="p-4 sm:p-5">
          <ForecastChart data={chartData} hasData={hasSpend || hasWager} />
        </Card>
      </section>

      {/* ── 3. Assumptions (the two halves the forecast is built from) ── */}
      <section className="space-y-3">
        <SectionHeading icon={Info} title="What this is built from" />
        <div className="grid gap-3 lg:grid-cols-2">
          <RealizedRatePanel data={data} />
          <DealSpendPanel data={data} />
        </div>
      </section>
    </div>
  );
}

// ── Per-span card ────────────────────────────────────────────────────

function ForecastSpanCard({
  span,
  hasSpend,
  hasWager,
}: {
  span: ForecastSpan;
  hasSpend: boolean;
  hasWager: boolean;
}) {
  // House-POV: profitable (RoR > 1) → emerald; loss-making → rose; not
  // evaluable (no spend basis) → neutral blue.
  const evaluable = hasSpend && hasWager && span.rateOfReturn !== null;
  const accent: AccentColor = !evaluable
    ? "blue"
    : span.profitable
      ? "emerald"
      : "rose";
  const valueTextClass = !evaluable
    ? "text-muted-foreground"
    : span.profitable
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-rose-600 dark:text-rose-400";

  const rorLabel =
    span.rateOfReturn === null ? "—" : `${span.rateOfReturn.toFixed(2)}×`;

  return (
    <StatPanel
      title={span.label}
      icon={
        !evaluable ? Gauge : span.profitable ? TrendingUp : TrendingDown
      }
      accent={accent}
    >
      {/* Verdict + rate of return */}
      <div className="space-y-1">
        <div
          className={cn(
            "flex items-center gap-1.5 text-sm font-semibold",
            valueTextClass,
          )}
        >
          {!evaluable ? (
            <Info className="size-4 shrink-0" />
          ) : span.profitable ? (
            <CheckCircle2 className="size-4 shrink-0" />
          ) : (
            <XCircle className="size-4 shrink-0" />
          )}
          <span>
            {!evaluable
              ? "Not evaluable"
              : span.profitable
                ? "Profitable"
                : "Not profitable"}
          </span>
        </div>
        <div
          className={cn(
            "text-3xl font-bold tabular-nums leading-none",
            valueTextClass,
          )}
          title="Rate of return — generated value ÷ deal spend. > 1.00× = profitable for the house."
        >
          {rorLabel}
        </div>
        <p className="text-[10px] text-muted-foreground">
          rate of return (value ÷ spend)
        </p>
      </div>

      {/* Breakdown */}
      <div className="mt-3 space-y-0.5 border-t pt-2">
        <PanelRow
          label="Projected wager"
          value={
            span.projectedWagerUsd === 0
              ? "—"
              : formatCurrency(span.projectedWagerUsd)
          }
          valueClassName="text-muted-foreground"
        />
        <PanelRow
          label="Generated value (× 7.5%)"
          value={
            span.generatedValueUsd === 0
              ? "—"
              : formatCurrency(span.generatedValueUsd)
          }
          valueClassName={
            span.generatedValueUsd > 0
              ? "text-emerald-600 dark:text-emerald-400"
              : undefined
          }
        />
        <PanelRow
          label="Deal spend"
          value={
            span.dealSpendUsd === 0 ? "—" : `−${formatCurrency(span.dealSpendUsd)}`
          }
          valueClassName={
            span.dealSpendUsd > 0
              ? "text-rose-600 dark:text-rose-400"
              : undefined
          }
        />
        <PanelRow
          label="Net (house)"
          value={
            !evaluable
              ? "—"
              : `${span.netUsd >= 0 ? "+" : ""}${formatCurrency(span.netUsd)}`
          }
          valueClassName={valueTextClass}
        />
        {span.projectedRealizedPnlUsd !== null && (
          <PanelRow
            label="Projected realized PnL"
            value={`${span.projectedRealizedPnlUsd >= 0 ? "+" : ""}${formatCurrency(span.projectedRealizedPnlUsd)}`}
            valueClassName={
              span.projectedRealizedPnlUsd > 0
                ? "text-emerald-600 dark:text-emerald-400"
                : span.projectedRealizedPnlUsd < 0
                  ? "text-rose-600 dark:text-rose-400"
                  : "text-muted-foreground"
            }
          />
        )}
      </div>
    </StatPanel>
  );
}

// ── Assumption panels ────────────────────────────────────────────────

function RealizedRatePanel({
  data,
}: {
  data: Awaited<ReturnType<typeof getForecastData>>;
}) {
  const windowLabel = data.rateWindow ?? "—";
  return (
    <StatPanel title="Current rate (realized)" icon={TrendingUp} accent="emerald">
      <p className="text-xs text-muted-foreground">
        Driven by this creator&apos;s most recent window with wager activity
        {data.rateWindow ? ` (${windowLabel})` : ""} — the longest available, for
        a steadier rate.
      </p>
      <div className="mt-3 space-y-0.5">
        <PanelRow
          label="Daily wager rate"
          value={
            data.dailyWagerUsd === 0 ? "—" : `${formatCurrency(data.dailyWagerUsd)}/day`
          }
          valueClassName={
            data.dailyWagerUsd > 0
              ? "text-emerald-600 dark:text-emerald-400"
              : undefined
          }
        />
        <PanelRow
          label={`Window wager (${windowLabel})`}
          value={
            data.rateWindowWagerUsd === 0
              ? "—"
              : formatCurrency(data.rateWindowWagerUsd)
          }
          valueClassName="text-muted-foreground"
        />
        <PanelRow
          label="Daily realized PnL"
          value={
            data.dailyRealizedPnlUsd === null
              ? "—"
              : `${data.dailyRealizedPnlUsd >= 0 ? "+" : ""}${formatCurrency(data.dailyRealizedPnlUsd)}/day`
          }
          valueClassName={
            data.dailyRealizedPnlUsd === null
              ? "text-muted-foreground"
              : data.dailyRealizedPnlUsd > 0
                ? "text-emerald-600 dark:text-emerald-400"
                : data.dailyRealizedPnlUsd < 0
                  ? "text-rose-600 dark:text-rose-400"
                  : "text-muted-foreground"
          }
        />
        <PanelRow
          label={`Window PnL (${windowLabel})`}
          value={
            data.rateWindowPnlUsd === null
              ? "—"
              : `${data.rateWindowPnlUsd >= 0 ? "+" : ""}${formatCurrency(data.rateWindowPnlUsd)}`
          }
          valueClassName={
            data.rateWindowPnlUsd === null
              ? "text-muted-foreground"
              : data.rateWindowPnlUsd > 0
                ? "text-emerald-600 dark:text-emerald-400"
                : data.rateWindowPnlUsd < 0
                  ? "text-rose-600 dark:text-rose-400"
                  : "text-muted-foreground"
          }
        />
      </div>
      <div className="mt-3 flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        <Info className="size-3.5 shrink-0 mt-0.5" />
        <span>
          Wager rate = the window&apos;s affiliate wager ÷ its days. Generated
          value extends it forward at 7.5% per $ wagered. Realized PnL (cohort
          deposits − card withdrawals) is shown as a reality check — it is NOT
          part of the rate-of-return math.
        </span>
      </div>
    </StatPanel>
  );
}

function DealSpendPanel({
  data,
}: {
  data: Awaited<ReturnType<typeof getForecastData>>;
}) {
  return (
    <StatPanel title="Deal spend (weekly)" icon={TrendingDown} accent="rose">
      <p className="text-xs text-muted-foreground">
        {data.hasDeal
          ? `From the ${data.dealStatus ?? "current"} deal — withdraw cap + leaderboard funding (× house %) + tip/sponsor allowance.`
          : "No deal found — there is no committed spend envelope to forecast against."}
      </p>
      <div className="mt-3 space-y-0.5">
        <PanelRow
          label="Weekly withdraw cap"
          value={
            data.weeklyWithdrawCapUsd === 0
              ? "—"
              : formatCurrency(data.weeklyWithdrawCapUsd)
          }
          valueClassName={
            data.weeklyWithdrawCapUsd > 0
              ? "text-rose-600 dark:text-rose-400"
              : undefined
          }
        />
        <PanelRow
          label="Weekly LB funding (× house %)"
          value={
            data.weeklyLbFundingUsd === 0
              ? "—"
              : formatCurrency(data.weeklyLbFundingUsd)
          }
          valueClassName={
            data.weeklyLbFundingUsd > 0
              ? "text-rose-600 dark:text-rose-400"
              : undefined
          }
        />
        <PanelRow
          label={
            data.tipSponsorSource === "deal_terms"
              ? "Weekly tip / sponsor (deal allowance)"
              : data.tipSponsorSource === "realized_cadence"
                ? "Weekly tip / sponsor (realized avg)"
                : "Weekly tip / sponsor"
          }
          value={
            data.weeklyTipSponsorUsd === 0
              ? "—"
              : formatCurrency(data.weeklyTipSponsorUsd)
          }
          valueClassName={
            data.weeklyTipSponsorUsd > 0
              ? "text-rose-600 dark:text-rose-400"
              : undefined
          }
        />
        {data.tipSponsorSource === "deal_terms" && data.dealFillsAllowed > 0 && (
          <PanelRow
            label="Deal allowance basis"
            value={`${formatCurrency(data.dealTipPerStreamUsd)} tip + ${formatCurrency(data.dealSponsorPerStreamUsd)} sponsor / stream × ${data.dealFillsAllowed} fills`}
            valueClassName="text-muted-foreground text-[11px]"
          />
        )}
        {data.tipSponsorSource === "realized_cadence" &&
          data.lifetimeTipSponsorUsd > 0 && (
            <PanelRow
              label="Lifetime realized (context)"
              value={formatCurrency(data.lifetimeTipSponsorUsd)}
              valueClassName="text-muted-foreground"
            />
          )}
        <PanelRow
          label="Total weekly spend"
          value={
            data.weeklyDealSpendUsd === 0
              ? "—"
              : formatCurrency(data.weeklyDealSpendUsd)
          }
          valueClassName={
            data.weeklyDealSpendUsd > 0
              ? "text-rose-600 dark:text-rose-400 font-semibold"
              : undefined
          }
        />
      </div>
      <div className="mt-3 flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        <Info className="size-3.5 shrink-0 mt-0.5" />
        <span>
          Withdraw cap is the deal&apos;s weekly cap. Tip/sponsor uses the
          deal&apos;s per-stream allowance × fills in the weekly window when a
          deal is loaded; if there is no deal, it falls back to realized
          lifetime tip/sponsor spend ÷ active weeks. LB funding is still this
          creator&apos;s realized lifetime leaderboard cost spread over{" "}
          {data.activeWeeks < 1.05
            ? "≈ 1 week"
            : `≈ ${data.activeWeeks.toFixed(1)} active weeks`}{" "}
          (historical cadence). Each span scales weekly spend by span ÷ 7.
        </span>
      </div>
    </StatPanel>
  );
}

// ── Skeleton ─────────────────────────────────────────────────────────

function ForecastSkeleton() {
  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-6 w-56" />
        <div className="grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} size="sm" className="space-y-2 p-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-20" />
              <Skeleton className="h-3 w-28" />
              <div className="space-y-1.5 pt-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-full" />
              </div>
            </Card>
          ))}
        </div>
      </div>
      <div className="space-y-3">
        <Skeleton className="h-6 w-64" />
        <Card size="sm" className="p-4 sm:p-5">
          <Skeleton className="h-[240px] w-full rounded-md" />
        </Card>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <Card key={i} size="sm" className="space-y-2 p-4 sm:p-5">
            <Skeleton className="h-4 w-40" />
            <div className="space-y-1.5 pt-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-full" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
