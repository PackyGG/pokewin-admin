"use client";

import * as React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  XAxis,
  YAxis,
} from "recharts";
import {
  Banknote,
  Gauge,
  Percent,
  RotateCcw,
  Share2,
  ShieldCheck,
  Ticket,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCompactUsd, formatCurrency } from "@/lib/utils/format";
import { formatPct, formatSignedUsd } from "../edge-calc/math";
import {
  KpiTile,
  PanelRow,
  SectionHeading,
  StatPanel,
} from "@/components/modern-panels";
import { AnimatedNumber } from "@/components/animated-number";
import { FadeIn } from "@/components/fade-in";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";

import {
  clamp,
  defaultLevers,
  effectiveBaselineEdge,
  projectEdgePlan,
  REMOVE_WAGER_REQ_COST_UPLIFT,
  type PlannedLevers,
  type RakebackCadenceId,
  type SystemEdgeBaseline,
} from "./_model";
import { LeverSlider } from "./_planner-ui";

const ROSE = "#f43f5e";
const EMERALD = "#10b981";

/**
 * System Edge Plan — the client PLANNER island.
 *
 * Read-only what-if planning: the levers are seeded from the REAL current config
 * (threaded down as a serializable `baseline`) and held in client state. Every
 * change re-runs the PURE projection in a `useMemo` (no server round-trip, NO
 * data writes). The headline is the PROFIT DELTA vs the current real config, with
 * monthly / annual savings — exactly the owner's affiliate-tier example shape
 * ("old vs new + estimated monthly/annual savings").
 *
 * House-POV throughout (CLAUDE.md, strict):
 *   • A reward COST going DOWN is a house GAIN → emerald; going UP → rose.
 *   • Projected PROFIT (NGR) positive → emerald; negative → rose.
 *   • The profit DELTA: + (house makes more) → emerald; − (costs the house) → rose.
 */
export function SystemEdgePlanner({ baseline }: { baseline: SystemEdgeBaseline }) {
  const [levers, setLevers] = React.useState<PlannedLevers>(() =>
    defaultLevers(baseline),
  );

  const projection = React.useMemo(
    () => projectEdgePlan(baseline, levers),
    [baseline, levers],
  );

  const baselineEdge = effectiveBaselineEdge(baseline);
  const dirty = React.useMemo(
    () => !leversEqual(levers, defaultLevers(baseline)),
    [levers, baseline],
  );

  const reset = React.useCallback(
    () => setLevers(defaultLevers(baseline)),
    [baseline],
  );

  // ── Lever setters ──
  const setHouseEdge = (pct: number) =>
    setLevers((s) => ({ ...s, houseEdge: clamp(pct / 100, 0, 1) }));
  const setUpgWeight = (pct: number) =>
    setLevers((s) => ({ ...s, upgraderRakebackWeight: clamp(pct / 100, 0, 1) }));
  const setRakebackRate = (cadence: RakebackCadenceId, pct: number) =>
    setLevers((s) => ({
      ...s,
      rakebackRates: { ...s.rakebackRates, [cadence]: clamp(pct / 100, 0, 1) },
    }));
  const setAffiliateRate = (level: number, pct: number) =>
    setLevers((s) => ({
      ...s,
      affiliateRates: { ...s.affiliateRates, [level]: clamp(pct / 100, 0, 1) },
    }));
  const setRemoveReq = (v: boolean) =>
    setLevers((s) => ({ ...s, removeAffiliateWagerReq: v }));
  const setDepositMult = (pct: number) =>
    setLevers((s) => ({ ...s, depositBonusMult: clamp(pct / 100, 0, 5) }));
  const setRaffleMult = (pct: number) =>
    setLevers((s) => ({ ...s, raffleTicketRateMult: clamp(pct / 100, 0, 5) }));

  const profitTone = projection.profitDelta >= 0 ? EMERALD : ROSE;
  const profitUp = projection.profitDelta >= 0;

  return (
    <div className="space-y-6">
      {/* ── Profit-delta hero ────────────────────────────────────────── */}
      <FadeIn>
        <div className="surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/60 sm:rounded-3xl">
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute -right-16 -top-16 size-56 rounded-full blur-3xl",
              profitUp ? "bg-emerald-500/[0.12]" : "bg-rose-500/[0.12]",
            )}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent"
          />
          <div className="relative grid gap-5 p-5 sm:p-6 lg:grid-cols-[1.2fr_1fr]">
            {/* Headline delta */}
            <div className="flex flex-col justify-center">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {profitUp ? (
                  <TrendingUp className="size-4 text-emerald-500" />
                ) : (
                  <TrendingDown className="size-4 text-rose-500" />
                )}
                Projected profit impact · {baseline.periodLabel}
              </div>
              <p
                className="mt-1 text-4xl font-bold leading-none tracking-tight tabular-nums sm:text-5xl"
                style={{ color: profitTone }}
              >
                <AnimatedNumber value={projection.profitDelta} format="currency" />
              </p>
              <p className="mt-2 max-w-md text-sm text-muted-foreground">
                {profitUp ? (
                  <>
                    The planned config makes the house{" "}
                    <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                      {formatCurrency(Math.abs(projection.profitDelta))} more
                    </span>{" "}
                    over this window vs the current live config.
                  </>
                ) : (
                  <>
                    The planned config costs the house{" "}
                    <span className="font-semibold text-rose-600 dark:text-rose-400">
                      {formatCurrency(Math.abs(projection.profitDelta))}
                    </span>{" "}
                    over this window vs the current live config.
                  </>
                )}
              </p>

              {/* Monthly / annual extrapolation */}
              <div className="mt-4 flex flex-wrap gap-2">
                <ExtrapolationChip
                  label="Per 30 days"
                  value={projection.monthlyProfitDelta}
                />
                <ExtrapolationChip
                  label="Per year"
                  value={projection.annualProfitDelta}
                />
                {dirty && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={reset}
                    className="ml-auto gap-1.5"
                  >
                    <RotateCcw className="size-3.5" />
                    Reset to current
                  </Button>
                )}
              </div>
            </div>

            {/* Current vs planned NGR side-by-side */}
            <div className="grid grid-cols-2 gap-3 self-center">
              <CompareBlock
                label="Current profit"
                sub="Live config (NGR)"
                value={projection.currentNgr}
              />
              <CompareBlock
                label="Planned profit"
                sub="What-if config (NGR)"
                value={projection.plannedNgr}
                highlight={profitTone}
              />
            </div>
          </div>
        </div>
      </FadeIn>

      {/* ── Projection KPI strip ─────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiTile
          label="Wager (real)"
          value={formatCompactUsd(projection.plannedWager)}
          sub="Held at observed volume"
          icon={Banknote}
          accent="blue"
        />
        <KpiTile
          label="Planned GGR"
          value={formatCompactUsd(projection.plannedGgr)}
          sub={`${formatPct(projection.plannedEdge)} edge`}
          icon={Gauge}
          accent="emerald"
        />
        <KpiTile
          label="Reward cost"
          value={formatCompactUsd(projection.plannedRewardCost)}
          sub={deltaSub(projection.rewardCostDelta, true)}
          icon={Wallet}
          accent="rose"
        />
        <KpiTile
          label="Planned NGR"
          value={formatCompactUsd(projection.plannedNgr)}
          sub={deltaSub(projection.profitDelta, false)}
          icon={projection.plannedNgr >= 0 ? TrendingUp : TrendingDown}
          accent={projection.plannedNgr >= 0 ? "emerald" : "rose"}
        />
        <KpiTile
          label="GGR delta"
          value={formatSignedUsd(projection.ggrDelta)}
          sub="From edge change"
          icon={Gauge}
          accent={projection.ggrDelta >= 0 ? "emerald" : "rose"}
        />
      </div>

      {/* ── Levers + breakdown ───────────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-[1.05fr_1fr]">
        {/* Levers column */}
        <div className="space-y-5">
          {/* House edge */}
          <StatPanel title="House edge" icon={Gauge} accent="emerald">
            <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
              The blended house edge on gameplay (real empirical edge ={" "}
              <span className="font-medium text-foreground">
                {formatPct(baselineEdge)}
              </span>
              {baseline.houseEdge == null && baseline.bets > 0 && (
                <> · derived from GGR/wager (below the {30}-bet confidence gate)</>
              )}
              ). Pack edge is set by pool composition, not a runtime knob — this
              models the catalog-level effect of a target-edge shift on GGR.
            </p>
            <LeverSlider
              label="Blended house edge"
              valueLabel={formatPct(levers.houseEdge)}
              value={levers.houseEdge * 100}
              onValueChange={setHouseEdge}
              min={0}
              max={30}
              step={0.05}
              baselineMarker={baselineEdge * 100}
              baselineLabel={`current ${formatPct(baselineEdge)}`}
            />
          </StatPanel>

          {/* Rakeback */}
          <StatPanel title="Rakeback" icon={Wallet} accent="rose">
            <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
              Per-cadence rebate rates from the live{" "}
              <span className="font-medium text-foreground">rakeback_config</span>{" "}
              table. Realized cost over this window:{" "}
              <span className="font-medium text-rose-600 dark:text-rose-400">
                {formatCurrency(baseline.rakebackCost)}
              </span>
              .
            </p>
            {baseline.rakebackCadences.length === 0 ? (
              <EmptyLever note="No rakeback cadences configured." />
            ) : (
              <div className="space-y-3">
                {baseline.rakebackCadences.map((c) => (
                  <LeverSlider
                    key={c.cadence}
                    label={`${c.label}${c.enabled ? "" : " (disabled)"}`}
                    valueLabel={formatPct(levers.rakebackRates[c.cadence] ?? c.currentRate)}
                    value={(levers.rakebackRates[c.cadence] ?? c.currentRate) * 100}
                    onValueChange={(pct) => setRakebackRate(c.cadence, pct)}
                    min={0}
                    max={Math.max(2, c.currentRate * 100 * 3)}
                    step={0.01}
                    baselineMarker={c.currentRate * 100}
                    baselineLabel={`current ${formatPct(c.currentRate)}`}
                  />
                ))}
              </div>
            )}
          </StatPanel>

          {/* Upgrader → rakeback weighting */}
          <StatPanel title="Upgrader → rakeback weight" icon={Percent} accent="cyan">
            <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
              Currently upgrader wager accrues rakeback at{" "}
              <span className="font-medium text-foreground">100%</span> (unweighted).
              Down-weighting it shrinks the rakeback bill — but the real upgrader
              wager slice is not separable from the window rollup here, so this
              lever is informational until that split is wired.
            </p>
            <LeverSlider
              label="Upgrader weight"
              valueLabel={formatPct(levers.upgraderRakebackWeight)}
              value={levers.upgraderRakebackWeight * 100}
              onValueChange={setUpgWeight}
              min={0}
              max={100}
              step={1}
              baselineMarker={baseline.upgraderRakebackWeight * 100}
              baselineLabel="current 100%"
              disabled={baseline.upgraderWager <= 0}
            />
          </StatPanel>

          {/* Affiliate */}
          <StatPanel title="Affiliate commission" icon={Share2} accent="rose">
            <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
              Per-tier commission rates from the live{" "}
              <span className="font-medium text-foreground">
                affiliate_level_configs
              </span>{" "}
              ladder
              {baseline.affiliateBlendedRate != null && (
                <>
                  {" "}
                  (~{formatPct(baseline.affiliateBlendedRate)} blended over this
                  window)
                </>
              )}
              . Realized commission cost:{" "}
              <span className="font-medium text-rose-600 dark:text-rose-400">
                {formatCurrency(baseline.affiliateCost)}
              </span>
              .
            </p>

            {/* Remove 1× wager requirement toggle */}
            <div className="mb-3 flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <ShieldCheck className="size-3.5 text-amber-500" />
                  Remove 1× wager requirement
                </div>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  Commission currently vests on referred wager (the 1× requirement
                  is implicit). Removing it widens the base — modeled as a{" "}
                  <span className="font-medium text-amber-600 dark:text-amber-400">
                    +{formatPct(REMOVE_WAGER_REQ_COST_UPLIFT)}
                  </span>{" "}
                  cost uplift (what-if).
                </p>
              </div>
              <Switch
                checked={levers.removeAffiliateWagerReq}
                onCheckedChange={setRemoveReq}
                aria-label="Remove 1x wager requirement"
              />
            </div>

            {baseline.affiliateTiers.length === 0 ? (
              <EmptyLever note="No affiliate tiers configured." />
            ) : (
              <div className="space-y-3">
                {baseline.affiliateTiers.map((t) => (
                  <LeverSlider
                    key={t.level}
                    label={t.label}
                    valueLabel={formatPct(levers.affiliateRates[t.level] ?? t.currentRate)}
                    value={(levers.affiliateRates[t.level] ?? t.currentRate) * 100}
                    onValueChange={(pct) => setAffiliateRate(t.level, pct)}
                    min={0}
                    max={Math.max(15, t.currentRate * 100 * 2)}
                    step={0.1}
                    baselineMarker={t.currentRate * 100}
                    baselineLabel={`current ${formatPct(t.currentRate)}`}
                  />
                ))}
              </div>
            )}
          </StatPanel>

          {/* Deposit bonus + raffle (proportional cost multipliers) */}
          <StatPanel title="Deposit bonus & raffle" icon={Ticket} accent="amber">
            <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
              Neither exposes a single rate knob in the admin (the deposit-bonus
              cap is backend-enforced; the raffle ticket rate lives in the game
              backend). These scale the real realized cost proportionally.
            </p>
            <div className="space-y-3">
              <LeverSlider
                label={`Deposit bonus spend (real ${formatCurrency(baseline.depositBonusCost)})`}
                valueLabel={`${Math.round(levers.depositBonusMult * 100)}%`}
                value={levers.depositBonusMult * 100}
                onValueChange={setDepositMult}
                min={0}
                max={200}
                step={5}
                baselineMarker={100}
                baselineLabel="current 100%"
                disabled={baseline.depositBonusCost <= 0}
              />
              <LeverSlider
                label={`Raffle ticket rate (real ${formatCurrency(baseline.raffleCost)})`}
                valueLabel={`${Math.round(levers.raffleTicketRateMult * 100)}%`}
                value={levers.raffleTicketRateMult * 100}
                onValueChange={setRaffleMult}
                min={0}
                max={200}
                step={5}
                baselineMarker={100}
                baselineLabel="current 100%"
                disabled={baseline.raffleCost <= 0}
              />
            </div>
          </StatPanel>
        </div>

        {/* Breakdown column */}
        <div className="space-y-5">
          <RewardCostComparisonChart projection={projection} />
          <LeverBreakdownPanel projection={projection} />
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ExtrapolationChip({ label, value }: { label: string; value: number }) {
  const up = value >= 0;
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <p
        className={cn(
          "text-sm font-bold tabular-nums",
          up
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-rose-600 dark:text-rose-400",
        )}
      >
        {formatSignedUsd(value)}
      </p>
    </div>
  );
}

function CompareBlock({
  label,
  sub,
  value,
  highlight,
}: {
  label: string;
  sub: string;
  value: number;
  highlight?: string;
}) {
  const tone = value >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400";
  return (
    <div className="rounded-xl border bg-card/60 p-3.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={cn("mt-1 text-xl font-bold tabular-nums sm:text-2xl", !highlight && tone)}
        style={highlight ? { color: highlight } : undefined}
      >
        <AnimatedNumber value={value} format="currency" />
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>
    </div>
  );
}

const chartConfig = {
  current: { label: "Current", color: "#64748b" },
  planned: { label: "Planned", color: ROSE },
} satisfies ChartConfig;

function RewardCostComparisonChart({
  projection,
}: {
  projection: ReturnType<typeof projectEdgePlan>;
}) {
  // Only chart levers that carry cost (drop zero/zero rows to keep it clean).
  const data = projection.levers
    .filter((l) => l.currentCost > 0 || l.plannedCost > 0)
    .map((l) => ({
      lever: l.label,
      current: l.currentCost,
      planned: l.plannedCost,
    }));

  return (
    <StatPanel title="Reward cost — current vs planned" icon={Wallet} accent="rose">
      {data.length === 0 ? (
        <EmptyLever note="No realized reward cost in this window to compare." />
      ) : (
        <ChartContainer config={chartConfig} className="aspect-auto h-[260px] w-full">
          <BarChart
            data={data}
            layout="vertical"
            margin={{ left: 4, right: 40, top: 4, bottom: 4 }}
            accessibilityLayer
          >
            <CartesianGrid horizontal={false} />
            <XAxis
              type="number"
              tickLine={false}
              axisLine={false}
              tickFormatter={formatCompactUsd}
              tick={{ fontSize: 11 }}
            />
            <YAxis
              type="category"
              dataKey="lever"
              tickLine={false}
              axisLine={false}
              width={108}
              tick={{ fontSize: 11 }}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent formatter={(v) => formatCurrency(Number(v))} />
              }
            />
            <Bar
              dataKey="current"
              fill="var(--color-current)"
              radius={[0, 3, 3, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Bar
              dataKey="planned"
              radius={[0, 3, 3, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            >
              {data.map((d, i) => (
                <Cell
                  key={i}
                  // Planned cost BELOW current = house saving → emerald; ABOVE = rose.
                  fill={d.planned <= d.current ? EMERALD : ROSE}
                />
              ))}
              <LabelList
                dataKey="planned"
                position="right"
                formatter={(v: number) => formatCompactUsd(v)}
                className="fill-foreground"
                style={{ fontSize: 10 }}
              />
            </Bar>
          </BarChart>
        </ChartContainer>
      )}
    </StatPanel>
  );
}

function LeverBreakdownPanel({
  projection,
}: {
  projection: ReturnType<typeof projectEdgePlan>;
}) {
  return (
    <StatPanel title="Cost delta by lever" icon={TrendingDown} accent="purple">
      <div className="space-y-0.5">
        {projection.levers.map((l) => {
          // A cost going DOWN (negative delta) is a house GAIN → emerald.
          const saving = -l.deltaCost;
          const tone =
            l.deltaCost === 0
              ? "text-muted-foreground"
              : saving > 0
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400";
          return (
            <PanelRow
              key={l.key}
              label={l.label}
              value={
                <span className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {formatCompactUsd(l.currentCost)} → {formatCompactUsd(l.plannedCost)}
                  </span>
                  <span className={cn("w-20 text-right", tone)}>
                    {l.deltaCost === 0 ? "—" : formatSignedUsd(saving)}
                  </span>
                </span>
              }
            />
          );
        })}
      </div>
      <div className="mt-3 border-t pt-3">
        <SectionHeading icon={Wallet} title="Net" />
        <PanelRow
          label="Total reward cost change"
          value={
            <span
              className={cn(
                projection.rewardCostDelta <= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400",
              )}
            >
              {formatSignedUsd(-projection.rewardCostDelta)}
            </span>
          }
        />
        <PanelRow
          label="GGR change (edge)"
          value={
            <span
              className={cn(
                projection.ggrDelta >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400",
              )}
            >
              {formatSignedUsd(projection.ggrDelta)}
            </span>
          }
        />
        <PanelRow
          label="Net profit impact"
          value={
            <span
              className={cn(
                "font-bold",
                projection.profitDelta >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400",
              )}
            >
              {formatSignedUsd(projection.profitDelta)}
            </span>
          }
        />
      </div>
    </StatPanel>
  );
}

function EmptyLever({ note }: { note: string }) {
  return (
    <div className="rounded-lg border border-dashed bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
      {note}
    </div>
  );
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** Sub-label for a KPI tile: a signed delta. `costFraming` flips the tone. */
function deltaSub(delta: number, costFraming: boolean): string {
  if (Math.abs(delta) < 0.005) return "no change";
  // For a cost, a NEGATIVE delta (less cost) is good; the sub just states the
  // signed change. The tile accent already carries the tone.
  void costFraming;
  return `${formatSignedUsd(delta)} vs current`;
}

function leversEqual(a: PlannedLevers, b: PlannedLevers): boolean {
  if (
    a.houseEdge !== b.houseEdge ||
    a.upgraderRakebackWeight !== b.upgraderRakebackWeight ||
    a.removeAffiliateWagerReq !== b.removeAffiliateWagerReq ||
    a.depositBonusMult !== b.depositBonusMult ||
    a.raffleTicketRateMult !== b.raffleTicketRateMult
  ) {
    return false;
  }
  const ar = Object.keys({ ...a.rakebackRates, ...b.rakebackRates }) as RakebackCadenceId[];
  for (const k of ar) {
    if ((a.rakebackRates[k] ?? 0) !== (b.rakebackRates[k] ?? 0)) return false;
  }
  const af = new Set([
    ...Object.keys(a.affiliateRates),
    ...Object.keys(b.affiliateRates),
  ]);
  for (const k of af) {
    const lvl = Number(k);
    if ((a.affiliateRates[lvl] ?? 0) !== (b.affiliateRates[lvl] ?? 0)) return false;
  }
  return true;
}
