"use client";

import * as React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import {
  Banknote,
  Boxes,
  Coins,
  Gauge,
  Gift,
  Percent,
  RotateCcw,
  Share2,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Swords,
  Ticket,
  TrendingDown,
  TrendingUp,
  Trophy,
  UserPlus,
  Wallet,
  Zap,
  CloudRain,
  Layers,
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
import { Badge } from "@/components/ui/badge";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";

import {
  clamp,
  computeNetEdgeScenarios,
  defaultLevers,
  defaultPlannedEdge,
  effectiveTypeEdge,
  gameTypeLabel,
  projectEdgePlan,
  sanitizeLevers,
  PLANNED_PACKS_BATTLES_EDGE_DEFAULT,
  REMOVE_WAGER_REQ_COST_UPLIFT,
  type GameTypeId,
  type NetEdgeScenario,
  type PlannedLevers,
  type RakebackCadenceId,
  type SystemEdgeBaseline,
} from "./_model";
import { LeverSlider } from "./_planner-ui";
import { PlannerPresets, usePlannerPresets } from "./_presets";
import {
  PackDesignCard,
  RewardPackCatalogGrid,
  WelcomePackGrid,
} from "./_pack-visual";
import {
  PlannerSectionNav,
  PlannerSectionPanel,
  type PlannerSectionId,
} from "./_planner-nav";
import { PlannerIdeasPanel } from "./_planner-ideas";

const ROSE = "#f43f5e";
const EMERALD = "#10b981";
// Amber for a thin / near-zero net edge (house-POV "danger zone" — still
// positive but with little cushion against further reward erosion).
const AMBER = "#f59e0b";
// Neutral slate for "no change" planned bars — matches the muted
// "current" baseline tone (#64748b) used in the chart config so an
// equal planned-vs-current bar reads as neutral, not as a win/loss.
const NEUTRAL = "#64748b";

/**
 * Threshold (0..1 fraction) below which a net edge is "thin" — comfortably
 * positive above it (emerald), thin/at-risk between 0 and it (amber), negative
 * below 0 (rose). 2 percentage points of net edge is a reasonable cushion line.
 */
const THIN_NET_EDGE = 0.02;

/** House-POV tone for a net-edge value (emerald / amber / rose), as a hex. */
function netEdgeColor(netEdge: number): string {
  if (netEdge < 0) return ROSE;
  if (netEdge < THIN_NET_EDGE) return AMBER;
  return EMERALD;
}

/** House-POV tone for a net-edge value, as a Tailwind text-class. */
function netEdgeTextClass(netEdge: number): string {
  if (netEdge < 0) return "text-rose-600 dark:text-rose-400";
  if (netEdge < THIN_NET_EDGE) return "text-amber-600 dark:text-amber-400";
  return "text-emerald-600 dark:text-emerald-400";
}

/**
 * Per-game-type icon + accent. `iconClass` is a STATIC Tailwind class (not an
 * interpolated `text-${accent}-500`, which Tailwind's static analysis would not
 * emit) so the colour is always present in the build.
 */
const GAME_TYPE_META: Record<
  GameTypeId,
  { icon: React.ElementType; iconClass: string }
> = {
  packs: { icon: Boxes, iconClass: "text-blue-500" },
  battles: { icon: Swords, iconClass: "text-purple-500" },
  upgrader: { icon: Zap, iconClass: "text-cyan-500" },
};

/**
 * System Edge Plan — the client PLANNER island.
 *
 * A full, customizable edge + reward-system planner. The levers are seeded from
 * the REAL current config (threaded down as a serializable `baseline`) and held
 * in client state. Every change re-runs the PURE projection in a `useMemo` (no
 * server round-trip, NO data writes). The headline is the PROFIT DELTA vs the
 * current real config, with monthly / annual extrapolation.
 *
 * Levers (every one the owner asked for), grouped into sections:
 *   • House edge — SEPARATE per game type (packs · battles · upgrader).
 *   • Rakeback — per-cadence rates + pack/battle vs upgrader wager weighting +
 *     an instant-claim payout-%/adoption control.
 *   • Deposit bonus — match % · cap · min deposit · wager requirement.
 *   • Raffle — prize pool · draw frequency · ticket cost.
 *   • Packs — daily/free pack value + frequency, and signup grant.
 *   • Rain — net giveaway cost.
 *   • Affiliate — per-tier commission % + the 1× wager-requirement toggle.
 *
 * House-POV throughout (CLAUDE.md, strict):
 *   • A reward COST going DOWN is a house GAIN → emerald; going UP → rose.
 *   • Projected PROFIT (NGR) positive → emerald; negative → rose.
 *   • The profit DELTA: + (house makes more) → emerald; − (costs the house) → rose.
 */
export function SystemEdgePlanner({ baseline }: { baseline: SystemEdgeBaseline }) {
  const [activeSection, setActiveSection] = React.useState<PlannerSectionId>("overview");
  const [levers, setLevers] = React.useState<PlannedLevers>(() =>
    defaultLevers(baseline),
  );

  const projection = React.useMemo(
    () => projectEdgePlan(baseline, levers),
    [baseline, levers],
  );

  // Net-edge-by-scenario rows — recomputed live from the current levers (planned
  // edge, affiliate rates, rakeback rates, deposit-bonus levers). Pure model.
  const netEdgeScenarios = React.useMemo(
    () => computeNetEdgeScenarios(baseline, levers),
    [baseline, levers],
  );

  const defaults = React.useMemo(() => defaultLevers(baseline), [baseline]);
  const dirty = React.useMemo(
    () => !leversEqual(levers, defaults),
    [levers, defaults],
  );

  const reset = React.useCallback(() => setLevers(defaults), [defaults]);

  // ── Saved configs (client-side / localStorage; no DB writes) ──
  const presets = usePlannerPresets();
  const loadConfig = React.useCallback(
    (next: PlannedLevers) => setLevers(sanitizeLevers(next)),
    [],
  );
  // "Unsaved changes" is measured against the ACTIVE saved config when one is
  // loaded, else against the live baseline (the reset target).
  const dirtyVsActive = React.useMemo(() => {
    const ref = presets.activeConfig
      ? sanitizeLevers(presets.activeConfig.levers)
      : defaults;
    return !leversEqual(levers, ref);
  }, [levers, presets.activeConfig, defaults]);

  // ── Lever setters (sliders carry their own units; convert here) ──
  const setEdge = (type: GameTypeId, pct: number) =>
    setLevers((s) => ({
      ...s,
      edges: { ...s.edges, [type]: clamp(pct / 100, 0, 1) },
    }));
  // Packs & battles share ONE house edge — one slider drives BOTH so the
  // combined lever stays internally consistent (the model sums per-type
  // edge × wager, so setting both to the same value gives the combined GGR).
  const setPacksBattlesEdge = (pct: number) =>
    setLevers((s) => {
      const v = clamp(pct / 100, 0, 1);
      return { ...s, edges: { ...s.edges, packs: v, battles: v } };
    });
  const setRakebackRate = (cadence: RakebackCadenceId, pct: number) =>
    setLevers((s) => ({
      ...s,
      rakebackRates: { ...s.rakebackRates, [cadence]: clamp(pct / 100, 0, 1) },
    }));
  const setRakebackPbWeight = (pct: number) =>
    setLevers((s) => ({ ...s, rakebackPackBattleWeight: clamp(pct / 100, 0, 1) }));
  const setRakebackUpgWeight = (pct: number) =>
    setLevers((s) => ({ ...s, rakebackUpgraderWeight: clamp(pct / 100, 0, 1) }));
  const setInstantPayout = (pct: number) =>
    setLevers((s) => ({ ...s, rakebackInstantPayoutPct: clamp(pct / 100, 0, 1) }));
  const setInstantAdoption = (pct: number) =>
    setLevers((s) => ({ ...s, rakebackInstantAdoption: clamp(pct / 100, 0, 1) }));
  const setAffiliateRate = (level: number, pct: number) =>
    setLevers((s) => ({
      ...s,
      affiliateRates: { ...s.affiliateRates, [level]: clamp(pct / 100, 0, 1) },
    }));
  const setRemoveReq = (v: boolean) =>
    setLevers((s) => ({ ...s, removeAffiliateWagerReq: v }));
  const setDepMatch = (pct: number) =>
    setLevers((s) => ({ ...s, depositBonusMatchMult: clamp(pct / 100, 0, 5) }));
  const setDepCap = (pct: number) =>
    setLevers((s) => ({ ...s, depositBonusCapMult: clamp(pct / 100, 0, 5) }));
  const setDepMinDeposit = (pct: number) =>
    setLevers((s) => ({ ...s, depositBonusMinDepositMult: clamp(pct / 100, 0, 5) }));
  const setDepWagerReq = (pct: number) =>
    setLevers((s) => ({ ...s, depositBonusWagerReqMult: clamp(pct / 100, 0, 5) }));
  const setRacePool = (pct: number) =>
    setLevers((s) => ({ ...s, racePrizePoolMult: clamp(pct / 100, 0, 5) }));
  const setRaceFreq = (pct: number) =>
    setLevers((s) => ({ ...s, raceFrequencyMult: clamp(pct / 100, 0, 5) }));
  const setRaceEntry = (pct: number) =>
    setLevers((s) => ({ ...s, raceEntryCostMult: clamp(pct / 100, 0, 5) }));
  const setRafflePool = (pct: number) =>
    setLevers((s) => ({ ...s, rafflePrizePoolMult: clamp(pct / 100, 0, 5) }));
  const setRaffleFreq = (pct: number) =>
    setLevers((s) => ({ ...s, raffleFrequencyMult: clamp(pct / 100, 0, 5) }));
  const setRaffleTicket = (pct: number) =>
    setLevers((s) => ({ ...s, raffleTicketCostMult: clamp(pct / 100, 0, 5) }));
  const setDailyPackEv = (packId: string, usd: number) =>
    setLevers((s) => ({
      ...s,
      dailyPackEvUsd: { ...s.dailyPackEvUsd, [packId]: Math.max(0, usd) },
    }));
  const setDailyFreq = (pct: number) =>
    setLevers((s) => ({ ...s, dailyPacksFrequencyMult: clamp(pct / 100, 0, 5) }));
  const setSignupGrant = (usd: number) =>
    setLevers((s) => ({ ...s, signupGrantUsd: Math.max(0, usd) }));
  const setRainMult = (pct: number) =>
    setLevers((s) => ({ ...s, rainCostMult: clamp(pct / 100, 0, 5) }));
  const setOtherRewardMult = (pct: number) =>
    setLevers((s) => ({ ...s, otherRewardCostMult: clamp(pct / 100, 0, 5) }));
  const setMothaMult = (pct: number) =>
    setLevers((s) => ({ ...s, mothaCostMult: clamp(pct / 100, 0, 5) }));

  const profitTone = projection.profitDelta >= 0 ? EMERALD : ROSE;
  const profitUp = projection.profitDelta >= 0;

  return (
    <div className="space-y-6">
      {/* ── Planner header: saved-config manager (localStorage only) ──── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <SlidersHorizontal className="size-4 text-cyan-500" />
          Planner configs
        </div>
        <PlannerPresets
          presets={presets}
          currentLevers={levers}
          dirtyVsActive={dirtyVsActive}
          onLoad={(cfg) => loadConfig(cfg.levers)}
        />
      </div>

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
                {Math.abs(projection.profitDelta) < 0.005 ? (
                  <>
                    Move a lever below to model a future update — the headline
                    updates live with the projected profit vs the current live
                    config.
                  </>
                ) : profitUp ? (
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
                    Reset to defaults
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
          sub={`${formatPct(projection.plannedEdge)} blended edge`}
          icon={Gauge}
          accent="emerald"
        />
        <KpiTile
          label="Reward cost"
          value={formatCompactUsd(projection.plannedRewardCost)}
          sub={deltaSub(projection.rewardCostDelta)}
          icon={Wallet}
          accent="rose"
        />
        <KpiTile
          label="Planned NGR"
          value={formatCompactUsd(projection.plannedNgr)}
          sub={deltaSub(projection.profitDelta)}
          icon={projection.plannedNgr >= 0 ? TrendingUp : TrendingDown}
          accent={projection.plannedNgr >= 0 ? "emerald" : "rose"}
        />
        <KpiTile
          label="GGR delta"
          value={formatSignedUsd(projection.ggrDelta)}
          sub="From edge changes"
          icon={Gauge}
          accent={projection.ggrDelta >= 0 ? "emerald" : "rose"}
        />
      </div>

      {/* ── Section nav + levers / breakdown ───────────────────────────── */}
      <PlannerSectionNav
        active={activeSection}
        onChange={setActiveSection}
        className="sticky top-0 z-10 backdrop-blur-md supports-[backdrop-filter]:bg-background/80"
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
        {/* Main column — tabbed lever panels */}
        <div className="min-w-0 space-y-5">
          <PlannerSectionPanel id="overview" active={activeSection}>
            <div className="rounded-xl border border-dashed bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground lg:hidden">
              Charts and breakdowns are in the sidebar on desktop — scroll down on
              mobile or switch to a lever tab to tune settings.
            </div>
            <div className="space-y-5 lg:hidden">
              <GgrByTypePanel projection={projection} />
              <NetEdgeByScenarioPanel scenarios={netEdgeScenarios} />
              <RewardCostComparisonChart projection={projection} />
              <LeverBreakdownPanel projection={projection} />
            </div>
            <StatPanel title="Quick start" icon={SlidersHorizontal} accent="cyan">
              <p className="text-sm leading-relaxed text-muted-foreground">
                Use the tabs above to tune house edge, rewards, and pack EVs. The
                headline profit delta updates live — anchored on{" "}
                <span className="font-medium text-foreground">
                  {baseline.periodLabel}
                </span>{" "}
                wager and cost. Pack art previews link straight to{" "}
                <span className="font-medium text-foreground">/packs</span> for
                catalog edits.
              </p>
            </StatPanel>
          </PlannerSectionPanel>

          <PlannerSectionPanel id="gaming" active={activeSection}>
          {/* ── HOUSE EDGE — combined Packs & Battles + separate Upgrader ── */}
          <StatPanel title="House edge" icon={Gauge} accent="emerald">
            <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
              Packs &amp; battles share one house edge (combined lever); upgrader is
              its own. The sliders open on the owner-chosen planning defaults —{" "}
              <span className="font-medium text-foreground">
                {formatPct(PLANNED_PACKS_BATTLES_EDGE_DEFAULT)}
              </span>{" "}
              packs &amp; battles ·{" "}
              <span className="font-medium text-foreground">
                {formatPct(defaultPlannedEdge("upgrader"))}
              </span>{" "}
              upgrader — with the live <span className="font-medium">measured</span>{" "}
              edge shown for reference. Edge is set by RNG odds / pool composition in
              the backend, not a runtime knob — this models the catalog-level GGR
              effect of a target edge at the observed wager.
            </p>
            <div className="space-y-4">
              {/* Combined Packs & Battles edge — one slider drives both types. */}
              <PacksBattlesEdgeControl
                baseline={baseline}
                projection={projection}
                plannedEdge={levers.edges.packs ?? PLANNED_PACKS_BATTLES_EDGE_DEFAULT}
                onChange={setPacksBattlesEdge}
              />

              {/* Upgrader — its own separate edge lever. */}
              <UpgraderEdgeControl
                baseline={baseline}
                projection={projection}
                plannedEdge={levers.edges.upgrader ?? defaultPlannedEdge("upgrader")}
                onChange={(pct) => setEdge("upgrader", pct)}
              />
            </div>
          </StatPanel>
          </PlannerSectionPanel>

          <PlannerSectionPanel id="rewards" active={activeSection}>
          {/* ── RAKEBACK ── */}
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
                    step={0.001}
                    baselineMarker={c.currentRate * 100}
                    baselineLabel={`current ${formatPct(c.currentRate)}`}
                    preciseInput={{ unit: "percent", decimals: 3 }}
                  />
                ))}
              </div>
            )}

            {/* Wager weighting (pack/battle vs upgrader) */}
            <div className="mt-4 space-y-3 border-t pt-3">
              <SectionHeading icon={Percent} title="Wager weighting" />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                How much each wager type counts toward rakeback accrual. Real ={" "}
                <span className="font-medium text-foreground">100%</span> (full,
                unweighted). Down-weighting shrinks the rakeback bill from that
                slice.
              </p>
              <LeverSlider
                label="Packs + battles wager → rakeback"
                valueLabel={formatPct(levers.rakebackPackBattleWeight)}
                value={levers.rakebackPackBattleWeight * 100}
                onValueChange={setRakebackPbWeight}
                min={0}
                max={100}
                step={0.1}
                baselineMarker={100}
                baselineLabel="current 100%"
                disabled={baseline.rakebackCost <= 0}
                preciseInput={{ unit: "percent" }}
              />
              <LeverSlider
                label="Upgrader wager → rakeback"
                valueLabel={formatPct(levers.rakebackUpgraderWeight)}
                value={levers.rakebackUpgraderWeight * 100}
                onValueChange={setRakebackUpgWeight}
                min={0}
                max={100}
                step={0.1}
                baselineMarker={100}
                baselineLabel="current 100%"
                preciseInput={{ unit: "percent" }}
                disabled={
                  baseline.rakebackCost <= 0 ||
                  !baseline.gameTypes.some(
                    (g) => g.type === "upgrader" && g.dataAvailable,
                  )
                }
              />
            </div>

            {/* Instant claim */}
            <div className="mt-4 space-y-3 border-t pt-3">
              <SectionHeading icon={Zap} title="Instant claim" />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Let users claim rakeback instantly at a discount instead of
                waiting for the cadence. You set the instant payout % and how many
                claimants take it — the discount trims the realized cost across
                the adopting share. Planning what-if (not a live feature).
              </p>
              <LeverSlider
                label="Instant payout %"
                valueLabel={formatPct(levers.rakebackInstantPayoutPct)}
                value={levers.rakebackInstantPayoutPct * 100}
                onValueChange={setInstantPayout}
                min={0}
                max={100}
                step={0.1}
                baselineMarker={100}
                baselineLabel="100% = full accrual (no discount)"
                disabled={baseline.rakebackCost <= 0}
                preciseInput={{ unit: "percent" }}
              />
              <LeverSlider
                label="Instant adoption (share of claimants)"
                valueLabel={formatPct(levers.rakebackInstantAdoption)}
                value={levers.rakebackInstantAdoption * 100}
                onValueChange={setInstantAdoption}
                min={0}
                max={100}
                step={0.1}
                baselineMarker={0}
                baselineLabel="0% = nobody takes it (current)"
                disabled={baseline.rakebackCost <= 0}
                preciseInput={{ unit: "percent" }}
              />
            </div>
          </StatPanel>

          {/* ── DEPOSIT BONUS — concrete, explained controls ── */}
          <DepositBonusPanel
            baseline={baseline}
            levers={levers}
            onMatch={setDepMatch}
            onCap={setDepCap}
            onMinDeposit={setDepMinDeposit}
            onWagerReq={setDepWagerReq}
          />

          {/* ── RACES — concrete, explained controls ── */}
          <RacesPanel
            baseline={baseline}
            levers={levers}
            onPool={setRacePool}
            onFreq={setRaceFreq}
            onEntry={setRaceEntry}
          />

          {/* ── RAFFLES (on-site ticket raffles · real reconstructed cost) ── */}
          <StatPanel title="Raffles" icon={Ticket} accent="orange">
            <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
              On-site ticket raffles (users earn tickets per $X wagered). Raffles
              pay out pack/card items via a prize list — there is no raffle
              ledger type, so the real cost is{" "}
              <span className="font-medium text-foreground">reconstructed</span>{" "}
              from completed raffles&apos; prizes valued at the live item price.
              Real reconstructed prize cost this window:{" "}
              <span className="font-medium text-rose-600 dark:text-rose-400">
                {formatCurrency(baseline.raffleCost)}
              </span>
              . The configured ticket-earn rate / draw schedule live in the game
              backend (not readable here) — these controls model the cost effect.
            </p>
            {baseline.raffleCost <= 0 ? (
              <EmptyLever note="No completed-raffle prize cost in this window." />
            ) : (
              <div className="space-y-3">
                <LeverSlider
                  label={`Prize pool (real ${formatCompactUsd(baseline.raffleCost)})`}
                  valueLabel={formatCompactUsd(
                    baseline.raffleCost * levers.rafflePrizePoolMult,
                  )}
                  value={levers.rafflePrizePoolMult * 100}
                  onValueChange={setRafflePool}
                  min={0}
                  max={300}
                  step={0.1}
                  baselineMarker={100}
                  baselineLabel="Total prize value across the period. Cost scales ~linearly with the pool."
                  preciseInput={{ unit: "multiplier" }}
                />
                <LeverSlider
                  label="Draw frequency"
                  valueLabel={multLabel(levers.raffleFrequencyMult)}
                  value={levers.raffleFrequencyMult * 100}
                  onValueChange={setRaffleFreq}
                  min={0}
                  max={300}
                  step={0.1}
                  baselineMarker={100}
                  baselineLabel="How often a raffle is drawn. More draws ⇒ more prize cost."
                  preciseInput={{ unit: "multiplier" }}
                />
                <LeverSlider
                  label="Ticket / entry cost"
                  valueLabel={multLabel(levers.raffleTicketCostMult)}
                  value={levers.raffleTicketCostMult * 100}
                  onValueChange={setRaffleTicket}
                  min={0}
                  max={300}
                  step={0.1}
                  baselineMarker={100}
                  baselineLabel="Points (wager) needed per ticket. A higher cost trims farming leakage → slightly less cost; it moves the genuine-vs-farmed split more than the headline."
                  preciseInput={{ unit: "multiplier" }}
                />
              </div>
            )}
          </StatPanel>

          {/* ── RAIN — concrete net-slice breakdown ── */}
          <RainPanel
            baseline={baseline}
            costMult={levers.rainCostMult}
            onChange={setRainMult}
          />

          {/* ── AFFILIATE ── */}
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
                  is implicit — not a stored toggle). Removing it widens the base —
                  modeled as a{" "}
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
                    step={0.001}
                    baselineMarker={t.currentRate * 100}
                    baselineLabel={`current ${formatPct(t.currentRate)}`}
                    preciseInput={{ unit: "percent", decimals: 3 }}
                  />
                ))}
              </div>
            )}
          </StatPanel>

          <OtherRewardsPanel
            baseline={baseline}
            otherMult={levers.otherRewardCostMult}
            mothaMult={levers.mothaCostMult}
            onOther={setOtherRewardMult}
            onMotha={setMothaMult}
          />
          </PlannerSectionPanel>

          <PlannerSectionPanel id="packs" active={activeSection}>
          <StatPanel title="Reward pack catalog" icon={Boxes} accent="pink">
            <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
              Every <span className="font-medium text-foreground">pack_type = reward</span>{" "}
              pack in production — the same art users see when they claim daily or
              welcome packs. Click a tile to open the pack admin.
            </p>
            <RewardPackCatalogGrid packs={baseline.rewardPackCatalog} />
          </StatPanel>

          <DailyPacksPanel
            baseline={baseline}
            levers={levers}
            onChangeEv={setDailyPackEv}
            onChangeFreq={setDailyFreq}
          />

          <SignupPanel
            baseline={baseline}
            grantUsd={levers.signupGrantUsd}
            onChangeGrant={setSignupGrant}
          />
          </PlannerSectionPanel>

          <PlannerSectionPanel id="ideas" active={activeSection}>
            <PlannerIdeasPanel />
          </PlannerSectionPanel>
        </div>

        {/* Breakdown sidebar — sticky on desktop */}
        <aside className="hidden space-y-5 xl:block xl:sticky xl:top-[4.5rem] xl:self-start">
          <GgrByTypePanel projection={projection} />
          <NetEdgeByScenarioPanel scenarios={netEdgeScenarios} />
          <RewardCostComparisonChart projection={projection} />
          <LeverBreakdownPanel projection={projection} />
        </aside>
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ExtrapolationChip({ label, value }: { label: string; value: number }) {
  const up = value >= 0;
  const flat = Math.abs(value) < 0.005;
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <p
        className={cn(
          "text-sm font-bold tabular-nums",
          flat
            ? "text-muted-foreground"
            : up
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

/**
 * Combined Packs & Battles edge control — ONE slider that drives both types'
 * planned edge. Surfaces the combined wager + planned GGR, the live MEASURED
 * blended edge (packs+battles) as a muted reference, and a baseline tick at that
 * measured edge. Default opens at the planning target (10.99%).
 */
function PacksBattlesEdgeControl({
  baseline,
  projection,
  plannedEdge,
  onChange,
}: {
  baseline: SystemEdgeBaseline;
  projection: ReturnType<typeof projectEdgePlan>;
  plannedEdge: number;
  onChange: (pct: number) => void;
}) {
  const packs = baseline.gameTypes.find((g) => g.type === "packs");
  const battles = baseline.gameTypes.find((g) => g.type === "battles");
  const combinedWager = (packs?.wager ?? 0) + (battles?.wager ?? 0);
  const combinedGgr = (packs?.ggr ?? 0) + (battles?.ggr ?? 0);
  // Measured blended edge across packs + battles (GGR / wager), for reference.
  const measuredEdge = combinedWager > 0 ? combinedGgr / combinedWager : null;
  const dataAvailable = combinedWager > 0;

  // Planned combined GGR = the per-type planned GGR of packs + battles.
  const plannedCombinedGgr = projection.gameTypes
    .filter((g) => g.type === "packs" || g.type === "battles")
    .reduce((s, g) => s + g.plannedGgr, 0);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Boxes className="size-3.5 text-blue-500" />
        <Swords className="size-3.5 text-purple-500" />
        <span className="text-xs font-semibold">Packs &amp; Battles</span>
        {dataAvailable ? (
          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
            wager {formatCompactUsd(combinedWager)} · GGR{" "}
            {formatCompactUsd(plannedCombinedGgr)}
          </span>
        ) : (
          <Badge
            variant="outline"
            className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-600 dark:text-amber-400"
          >
            no data this window
          </Badge>
        )}
      </div>
      <LeverSlider
        label="Packs & battles edge"
        valueLabel={formatPct(plannedEdge)}
        value={plannedEdge * 100}
        onValueChange={onChange}
        min={0}
        max={30}
        step={0.001}
        baselineMarker={measuredEdge != null ? measuredEdge * 100 : undefined}
        baselineLabel={
          measuredEdge != null
            ? `measured: ${formatPct(measuredEdge)} · default ${formatPct(PLANNED_PACKS_BATTLES_EDGE_DEFAULT)}`
            : `no measured edge this window · default ${formatPct(PLANNED_PACKS_BATTLES_EDGE_DEFAULT)}`
        }
        preciseInput={{ unit: "percent", decimals: 3 }}
      />
    </div>
  );
}

/**
 * Separate Upgrader edge control. On DBs without `upgrader_games` the lever is
 * SURFACED but disabled + labeled "not yet wired"; it still defaults to the 10%
 * planning target. When data exists it behaves like the combined control.
 */
function UpgraderEdgeControl({
  baseline,
  projection,
  plannedEdge,
  onChange,
}: {
  baseline: SystemEdgeBaseline;
  projection: ReturnType<typeof projectEdgePlan>;
  plannedEdge: number;
  onChange: (pct: number) => void;
}) {
  const upg = baseline.gameTypes.find((g) => g.type === "upgrader");
  const meta = GAME_TYPE_META.upgrader;
  const measuredEdge = upg ? effectiveTypeEdge(upg) : null;
  const dataAvailable = upg?.dataAvailable ?? false;
  const typeGgr = projection.gameTypes.find((g) => g.type === "upgrader");
  const planDefault = defaultPlannedEdge("upgrader");

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <meta.icon className={cn("size-3.5", meta.iconClass)} />
        <span className="text-xs font-semibold">{gameTypeLabel("upgrader")}</span>
        {!dataAvailable ? (
          <Badge
            variant="outline"
            className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-600 dark:text-amber-400"
          >
            not yet wired
          </Badge>
        ) : (
          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
            wager {formatCompactUsd(upg?.wager ?? 0)} · GGR{" "}
            {formatCompactUsd(typeGgr?.plannedGgr ?? upg?.ggr ?? 0)}
          </span>
        )}
      </div>
      <LeverSlider
        label="Upgrader edge"
        valueLabel={formatPct(plannedEdge)}
        value={plannedEdge * 100}
        onValueChange={onChange}
        min={0}
        max={30}
        step={0.001}
        baselineMarker={
          dataAvailable && measuredEdge != null ? measuredEdge * 100 : undefined
        }
        baselineLabel={
          dataAvailable && measuredEdge != null
            ? `measured: ${formatPct(measuredEdge)} · default ${formatPct(planDefault)}`
            : `not yet wired on this DB · default ${formatPct(planDefault)}`
        }
        disabled={!dataAvailable}
        preciseInput={{ unit: "percent", decimals: 3 }}
      />
    </div>
  );
}

/**
 * DAILY / FREE PACKS — one editable-EV row PER real reward pack
 * (`packs.pack_type = 'reward'`). Each row defaults to the pack's MEASURED avg
 * house cost per open (`giveawayPayout / opens`) and lets the owner scale THAT
 * pack's EV; the projection aggregates `Σ (plannedEv × opens) × frequency`. Cost
 * basis = GROSS giveaway (cards out) — House-POV: a card giveaway is a house
 * cost → rose. The 30-day XP-unlock is DISPLAY-ONLY (backend-enforced).
 */
function DailyPacksPanel({
  baseline,
  levers,
  onChangeEv,
  onChangeFreq,
}: {
  baseline: SystemEdgeBaseline;
  levers: PlannedLevers;
  onChangeEv: (packId: string, usd: number) => void;
  onChangeFreq: (pct: number) => void;
}) {
  const rows = baseline.dailyPackRows;
  // Planned per-pack giveaway (EV × opens), then frequency-scaled, for the
  // live total readout.
  const freq = Math.max(0, levers.dailyPacksFrequencyMult);
  const plannedTotal =
    rows.reduce((s, p) => {
      const ev = Math.max(0, levers.dailyPackEvUsd[p.packId] ?? p.measuredEvUsd);
      return s + ev * p.opens;
    }, 0) * freq;

  return (
    <StatPanel title="Daily / free packs" icon={Boxes} accent="pink">
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        Daily / free packs are the reward packs (
        <span className="font-medium text-foreground">pack_type = reward</span>)
        the site hands out for free. They are effectively a{" "}
        <span className="font-medium text-foreground">wager-loss</span> — the open
        collects ≈ $0 but the user keeps the card, so the full card value is a pure
        house cost (
        <span className="font-medium text-rose-600 dark:text-rose-400">
          {formatCurrency(baseline.dailyPacksCost)}
        </span>{" "}
        this window, gross cards out). Each row below is a real pack defaulting to
        its <span className="font-medium text-foreground">measured EV per open</span>{" "}
        — scale a pack&apos;s EV (richer/cheaper cards) and the cost follows{" "}
        <span className="font-medium text-foreground">EV × opens</span>.
      </p>

      {rows.length === 0 ? (
        <EmptyLever note="No reward-pack opens in this window." />
      ) : (
        <div className="space-y-4">
          {rows.map((p) => {
            const plannedEv = Math.max(
              0,
              levers.dailyPackEvUsd[p.packId] ?? p.measuredEvUsd,
            );
            const plannedPackCost = plannedEv * p.opens * freq;
            return (
              <PackDesignCard
                key={p.packId}
                packId={p.packId}
                name={p.name}
                slug={p.slug}
                imageUrl={p.imageUrl}
                cardPreviews={p.cardPreviews}
                badge="Daily"
                meta={
                  <>
                    {p.opens.toLocaleString()} opens · {p.claimers.toLocaleString()}{" "}
                    claimers
                  </>
                }
                evLabel={evLabel(plannedEv)}
                costLabel={`${formatCompactUsd(plannedPackCost)} planned`}
              >
                <LeverSlider
                  label="EV per open"
                  valueLabel={evLabel(plannedEv)}
                  value={plannedEv}
                  onValueChange={(usd) => onChangeEv(p.packId, usd)}
                  min={0}
                  max={Math.max(0.5, p.measuredEvUsd * 4)}
                  step={0.0001}
                  baselineMarker={p.measuredEvUsd}
                  baselineLabel={`measured EV ${evLabel(p.measuredEvUsd)} / open · ${p.claimers.toLocaleString()} claimers`}
                  preciseInput={{ unit: "usd", decimals: 4 }}
                />
              </PackDesignCard>
            );
          })}

          <div className="border-t pt-3">
            <LeverSlider
              label="Grant frequency"
              valueLabel={multLabel(levers.dailyPacksFrequencyMult)}
              value={levers.dailyPacksFrequencyMult * 100}
              onValueChange={onChangeFreq}
              min={0}
              max={300}
              step={0.1}
              baselineMarker={100}
              baselineLabel="How often packs are granted. Scales every pack's cost together. More frequent ⇒ more cost."
              preciseInput={{ unit: "multiplier" }}
            />
          </div>

          <PanelRow
            label="Planned daily-pack cost"
            value={
              <span className="text-rose-600 dark:text-rose-400">
                {formatCompactUsd(plannedTotal)}
              </span>
            }
          />
        </div>
      )}

      {/* 30-day XP-unlock — DISPLAY-ONLY (backend-enforced, not tunable here). */}
      <div className="mt-3 flex items-start gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-cyan-500" />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          A <span className="font-medium text-foreground">30-day XP unlock</span>{" "}
          gates these daily rewards (the schema carries{" "}
          <span className="font-medium text-foreground">daily_period_start</span> +{" "}
          <span className="font-medium text-foreground">
            daily_unlock_xp_baseline
          </span>{" "}
          on <span className="font-medium text-foreground">user_rewards</span>). The
          exact XP-% threshold and its enforcement live in the game backend — they
          are not readable or tunable here, so this is shown for reference only.
        </p>
      </div>
    </StatPanel>
  );
}

/**
 * SIGNUP — the cash balance reward (the honest relabel of the misleading
 * "$5.71") + the real welcome PACK references for context.
 *
 * The signup lever is a CASH `balance_reward_claim` credit (NOT a welcome pack).
 * The headline grant is the TRUE per-CLAIMANT average (`signupAvgGrant`); the
 * amortized-per-signup figure is demoted to a secondary stat with the bridge
 * `avgPerSignup = avgPerClaim × conversionPct`. The welcome card-pack EVs are
 * surfaced separately, display-only. House-POV: a house grant → rose.
 */
function SignupPanel({
  baseline,
  grantUsd,
  onChangeGrant,
}: {
  baseline: SystemEdgeBaseline;
  grantUsd: number;
  onChangeGrant: (usd: number) => void;
}) {
  const avgClaim = baseline.signupAvgGrant;
  const avgSignup = baseline.signupAvgPerSignup;
  const conv = baseline.signupConversionPct;

  return (
    <StatPanel title="Signup balance reward" icon={UserPlus} accent="pink">
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        The signup bonus is a <span className="font-medium text-foreground">cash
        balance credit</span> (ledger{" "}
        <span className="font-medium text-foreground">balance_reward_claim</span>),
        NOT a welcome pack. Real cost this window:{" "}
        <span className="font-medium text-rose-600 dark:text-rose-400">
          {formatCurrency(baseline.signupPacksCost)}
        </span>
        {baseline.signupClaimants > 0 && (
          <>
            {" "}across {baseline.signupClaimants.toLocaleString()} claimant
            {baseline.signupClaimants === 1 ? "" : "s"}
          </>
        )}
        .
      </p>

      {baseline.signupClaimants <= 0 ? (
        <EmptyLever note="No signup-bonus claims in this window." />
      ) : (
        <>
          <LeverSlider
            label="Avg grant per claimant (cash)"
            valueLabel={formatCurrency(grantUsd)}
            value={grantUsd}
            onValueChange={onChangeGrant}
            min={0}
            max={Math.max(25, (avgClaim ?? 5) * 4)}
            step={0.01}
            baselineMarker={avgClaim ?? undefined}
            baselineLabel={
              avgClaim != null
                ? `Real avg per CLAIMANT ${formatCurrency(avgClaim)}. Cost = claimants × grant.`
                : undefined
            }
            preciseInput={{ unit: "usd" }}
          />

          {/* The $5.71 bridge — demote avgPerSignup to a labeled efficiency stat. */}
          {avgSignup != null && avgClaim != null && (
            <div className="mt-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
              <div className="flex items-center justify-between gap-2">
                <span>Avg per CLAIMANT (the real grant)</span>
                <span className="font-semibold tabular-nums text-foreground">
                  {formatCurrency(avgClaim)}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span>Amortized per SIGNUP (incl. non-claimers)</span>
                <span className="font-semibold tabular-nums text-foreground">
                  {formatCurrency(avgSignup)}
                </span>
              </div>
              <p className="mt-1.5">
                The amortized figure is{" "}
                <span className="font-medium text-foreground">not</span> the grant
                size — it is the bonus cost spread across every signup. Bridge:{" "}
                <span className="font-medium text-foreground">
                  {formatCurrency(avgClaim)} × {formatPct(conv)} claim-conversion ={" "}
                  {formatCurrency(avgSignup)}
                </span>
                .
              </p>
            </div>
          )}
        </>
      )}

      {/* Real welcome / one-time reward PACKS — display-only context. */}
      <div className="mt-3 border-t pt-3">
        <SectionHeading icon={Gift} title="Welcome packs (context)" />
        <WelcomePacksReadout baseline={baseline} />
      </div>
    </StatPanel>
  );
}

/**
 * The real welcome / one-time reward PACK references + their theoretical EVs.
 * DISPLAY-ONLY (the signup cost is the cash credit above). Honest about what the
 * data shows — if it isn't a clean set of three packs, it says so rather than
 * fabricating one.
 */
function WelcomePacksReadout({ baseline }: { baseline: SystemEdgeBaseline }) {
  const packs = baseline.welcomePacks;

  if (packs.length === 0) {
    return (
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
        No <span className="font-medium text-foreground">one_time</span> reward
        currently references a reward pack, so there is no welcome card-pack EV to
        show. The signup grant above (a cash credit) is the real signup cost.
      </p>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Welcome / one-time rewards that hand out a card pack, with each pack&apos;s{" "}
        <span className="font-medium text-foreground">theoretical EV per open</span>.
        Separate from the cash signup credit above.
      </p>
      <WelcomePackGrid
        packs={packs.map((w) => ({
          packId: w.packId,
          packName: w.packName,
          packSlug: w.packSlug,
          rewardName: w.rewardName,
          rewardSlug: w.rewardSlug,
          imageUrl: w.imageUrl,
          cardPreviews: w.cardPreviews,
          theoreticalEvUsd: w.theoreticalEvUsd,
          cardsPerOpen: w.cardsPerOpen,
        }))}
      />
    </div>
  );
}

function OtherRewardsPanel({
  baseline,
  otherMult,
  mothaMult,
  onOther,
  onMotha,
}: {
  baseline: SystemEdgeBaseline;
  otherMult: number;
  mothaMult: number;
  onOther: (pct: number) => void;
  onMotha: (pct: number) => void;
}) {
  const hasOther = baseline.otherRewardCost > 0;
  const hasMotha = baseline.mothaCost > 0;

  if (!hasOther && !hasMotha) {
    return (
      <StatPanel title="Other & founder rewards" icon={Gift} accent="amber">
        <EmptyLever note="No other reward cost or motha giveaways in this window." />
      </StatPanel>
    );
  }

  return (
    <StatPanel title="Other & founder rewards" icon={Gift} accent="amber">
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        Gift cards, promo codes, waitlist prizes, manual vouchers, and founder
        giveaways (motha) — channels not fully itemized elsewhere. Scale each
        bucket to model budget changes.
      </p>
      <div className="space-y-3">
        {hasOther ? (
          <LeverSlider
            label={`Other reward spend (real ${formatCompactUsd(baseline.otherRewardCost)})`}
            valueLabel={formatCompactUsd(baseline.otherRewardCost * otherMult)}
            value={otherMult * 100}
            onValueChange={onOther}
            min={0}
            max={300}
            step={0.1}
            baselineMarker={100}
            baselineLabel="gift_card · promo_code · waitlist · vouchers · adjustments"
            preciseInput={{ unit: "multiplier" }}
          />
        ) : null}
        {hasMotha ? (
          <LeverSlider
            label={`Motha giveaways (real ${formatCompactUsd(baseline.mothaCost)})`}
            valueLabel={formatCompactUsd(baseline.mothaCost * mothaMult)}
            value={mothaMult * 100}
            onValueChange={onMotha}
            min={0}
            max={300}
            step={0.1}
            baselineMarker={100}
            baselineLabel="creator tips · battle sponsorship · rain tips (founder account)"
            preciseInput={{ unit: "multiplier" }}
          />
        ) : null}
      </div>
    </StatPanel>
  );
}

/**
 * DEPOSIT BONUS — concrete, explained controls. The cap / window / wager
 * requirement / min-deposit / match-% live in the game backend (not readable
 * here), so each control models the COST EFFECT of changing that setting against
 * the real realized spend. Each slider shows the absolute value it implies (e.g.
 * "100%", "$100") and a plain-English note on which way cost moves. House-POV:
 * deposit bonus is a house grant → rose.
 */
function DepositBonusPanel({
  baseline,
  levers,
  onMatch,
  onCap,
  onMinDeposit,
  onWagerReq,
}: {
  baseline: SystemEdgeBaseline;
  levers: PlannedLevers;
  onMatch: (pct: number) => void;
  onCap: (pct: number) => void;
  onMinDeposit: (pct: number) => void;
  onWagerReq: (pct: number) => void;
}) {
  // Absolute readouts derived from the mult × the real backend anchor.
  const matchPct = 100 * levers.depositBonusMatchMult; // baseline match 100%
  const capUsd = baseline.depositBonusCapUsd * levers.depositBonusCapMult;

  return (
    <StatPanel title="Deposit bonus" icon={Coins} accent="amber">
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        The house matches a deposit up to a cap per window. The real config (
        <span className="font-medium text-foreground">
          {formatPercentInt(100)}
        </span>{" "}
        match, cap{" "}
        <span className="font-medium text-foreground">
          {formatCurrency(baseline.depositBonusCapUsd)}
        </span>{" "}
        per {baseline.depositBonusWindowHours}h) lives in the game backend, so each
        control models the cost effect against the real realized spend (
        <span className="font-medium text-rose-600 dark:text-rose-400">
          {formatCurrency(baseline.depositBonusCost)}
        </span>
        ).
      </p>
      {baseline.depositBonusCost <= 0 ? (
        <EmptyLever note="No deposit-bonus spend in this window." />
      ) : (
        <div className="space-y-3">
          <LeverSlider
            label="Match %"
            valueLabel={formatPercentInt(matchPct)}
            value={levers.depositBonusMatchMult * 100}
            onValueChange={onMatch}
            min={0}
            max={300}
            step={0.1}
            baselineMarker={100}
            baselineLabel={`House matches ${formatPercentInt(matchPct)} of the deposit (real 100%). Higher match → directly higher cost.`}
            preciseInput={{ unit: "multiplier" }}
          />
          <LeverSlider
            label="Cap $"
            valueLabel={formatCurrency(capUsd)}
            value={levers.depositBonusCapMult * 100}
            onValueChange={onCap}
            min={0}
            max={300}
            step={0.1}
            baselineMarker={100}
            baselineLabel={`Max bonus per ${baseline.depositBonusWindowHours}h = ${formatCurrency(capUsd)} (real ${formatCurrency(baseline.depositBonusCapUsd)}). A higher cap only lets the clipped upper tail through → cost rises sub-linearly.`}
            preciseInput={{ unit: "multiplier" }}
          />
          <LeverSlider
            label="Min deposit gate"
            valueLabel={multLabel(levers.depositBonusMinDepositMult)}
            value={levers.depositBonusMinDepositMult * 100}
            onValueChange={onMinDeposit}
            min={0}
            max={300}
            step={0.1}
            baselineMarker={100}
            baselineLabel="Minimum deposit to qualify (real value backend-only). A higher gate filters out small claimers → fewer claims → less cost."
            preciseInput={{ unit: "multiplier" }}
          />
          <LeverSlider
            label="Wager requirement"
            valueLabel={multLabel(levers.depositBonusWagerReqMult)}
            value={levers.depositBonusWagerReqMult * 100}
            onValueChange={onWagerReq}
            min={0}
            max={300}
            step={0.1}
            baselineMarker={100}
            baselineLabel="How many times the bonus must be wagered before withdrawal (real value backend-only). A higher requirement raises breakage (more bonus expires unwagered) → less realized cost."
            preciseInput={{ unit: "multiplier" }}
          />
        </div>
      )}
    </StatPanel>
  );
}

/**
 * RACES (on-site competitive races · real `race_prize` ledger cost). Concrete,
 * explained controls: prize pool (absolute $ derived from the real cost), race
 * frequency, and entry threshold — each with a plain-English cost note.
 * House-POV: a race prize is a house payout → rose.
 */
function RacesPanel({
  baseline,
  levers,
  onPool,
  onFreq,
  onEntry,
}: {
  baseline: SystemEdgeBaseline;
  levers: PlannedLevers;
  onPool: (pct: number) => void;
  onFreq: (pct: number) => void;
  onEntry: (pct: number) => void;
}) {
  const poolUsd = baseline.raceCost * levers.racePrizePoolMult;
  return (
    <StatPanel title="Races" icon={Trophy} accent="orange">
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        On-site competitive races — the{" "}
        <span className="font-medium text-foreground">race_prize</span> ledger
        payout (real{" "}
        <span className="font-medium text-rose-600 dark:text-rose-400">
          {formatCurrency(baseline.raceCost)}
        </span>{" "}
        this window). The prize tiers / schedule live in the game backend; these
        controls model the cost effect.
      </p>
      {baseline.raceCost <= 0 ? (
        <EmptyLever note="No race prize cost in this window." />
      ) : (
        <div className="space-y-3">
          <LeverSlider
            label={`Prize pool (real ${formatCompactUsd(baseline.raceCost)})`}
            valueLabel={formatCompactUsd(poolUsd)}
            value={levers.racePrizePoolMult * 100}
            onValueChange={onPool}
            min={0}
            max={300}
            step={0.1}
            baselineMarker={100}
            baselineLabel="Total prize value paid across the period. Cost scales ~linearly with the pool."
            preciseInput={{ unit: "multiplier" }}
          />
          <LeverSlider
            label="Race frequency"
            valueLabel={multLabel(levers.raceFrequencyMult)}
            value={levers.raceFrequencyMult * 100}
            onValueChange={onFreq}
            min={0}
            max={300}
            step={0.1}
            baselineMarker={100}
            baselineLabel="How often a race runs. More races ⇒ more prize cost."
            preciseInput={{ unit: "multiplier" }}
          />
          <LeverSlider
            label="Entry threshold"
            valueLabel={multLabel(levers.raceEntryCostMult)}
            value={levers.raceEntryCostMult * 100}
            onValueChange={onEntry}
            min={0}
            max={300}
            step={0.1}
            baselineMarker={100}
            baselineLabel="Qualifying spend to place (real value backend-only). A higher bar trims farming leakage → slightly less cost."
            preciseInput={{ unit: "multiplier" }}
          />
        </div>
      )}
    </StatPanel>
  );
}

/**
 * RAIN — concrete net-slice breakdown. Rain is system-automatic + mixed-funded:
 * the house only funds the slice of the winnings beyond user/founder tips, so the
 * cost is `max(0, rain wins − tips)`. Surfaces the real gross win, the tips that
 * cover part of it, and the net house slice, then a single proportional lever on
 * that net slice. House-POV: the net rain slice is a house payout → rose.
 *
 * Whether rain winnings carry a wager requirement before withdrawal is NOT
 * readable from this admin (backend-only) — flagged in openQuestions, so we do
 * not model breakage here (would be a fabricated coefficient).
 */
function RainPanel({
  baseline,
  costMult,
  onChange,
}: {
  baseline: SystemEdgeBaseline;
  costMult: number;
  onChange: (pct: number) => void;
}) {
  const hasGross = baseline.rainWinTotal > 0;
  return (
    <StatPanel title="Rain" icon={CloudRain} accent="cyan">
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        Rain is system-automatic and mixed-funded. Only the{" "}
        <span className="font-medium text-foreground">net house slice</span> counts
        — the winnings beyond what users and the founder tipped in:{" "}
        <span className="font-medium text-foreground">
          max(0, rain wins − tips)
        </span>
        .
      </p>

      {hasGross && (
        <div className="mb-3 space-y-0.5">
          <PanelRow
            label="Rain wins paid (gross)"
            value={
              <span className="text-rose-600 dark:text-rose-400">
                {formatCompactUsd(baseline.rainWinTotal)}
              </span>
            }
          />
          <PanelRow
            label="− User / founder tips (funded the pool)"
            value={
              <span className="text-emerald-600 dark:text-emerald-400">
                {formatCompactUsd(baseline.rainTipTotal)}
              </span>
            }
          />
          <PanelRow
            label="= Net house slice"
            value={
              <span className="font-semibold text-rose-600 dark:text-rose-400">
                {formatCompactUsd(baseline.rainCost)}
              </span>
            }
          />
        </div>
      )}

      {baseline.rainCost <= 0 ? (
        <EmptyLever
          note={
            hasGross
              ? "Tips fully covered rain wins this window — no net house cost."
              : "No net rain cost in this window."
          }
        />
      ) : (
        <LeverSlider
          label={`Net rain cost (real ${formatCompactUsd(baseline.rainCost)})`}
          valueLabel={formatCompactUsd(baseline.rainCost * Math.max(0, costMult))}
          value={costMult * 100}
          onValueChange={onChange}
          min={0}
          max={300}
          step={0.1}
          baselineMarker={100}
          baselineLabel="Scales the net house slice (dollars per rain × frequency). Higher ⇒ more cost."
          preciseInput={{ unit: "multiplier" }}
        />
      )}

      <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
        Note: whether rain winnings carry a wager requirement before withdrawal is
        enforced in the game backend and is not readable here, so no breakage is
        modeled (it would be a guessed number).
      </p>
    </StatPanel>
  );
}

/** GGR contribution per game type — current vs planned, house-POV emerald/rose. */
function GgrByTypePanel({
  projection,
}: {
  projection: ReturnType<typeof projectEdgePlan>;
}) {
  return (
    <StatPanel title="GGR by game type" icon={Layers} accent="emerald">
      <div className="space-y-0.5">
        {projection.gameTypes.map((g) => {
          const up = g.ggrDelta >= 0;
          const tone =
            Math.abs(g.ggrDelta) < 0.005
              ? "text-muted-foreground"
              : up
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400";
          return (
            <PanelRow
              key={g.type}
              label={`${g.label}${g.dataAvailable ? "" : " (no data)"}`}
              value={
                <span className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {formatPct(g.currentEdge)} → {formatPct(g.plannedEdge)} edge
                  </span>
                  <span className={cn("w-20 text-right", tone)}>
                    {Math.abs(g.ggrDelta) < 0.005 ? "—" : formatSignedUsd(g.ggrDelta)}
                  </span>
                </span>
              }
            />
          );
        })}
      </div>
      <div className="mt-3 border-t pt-3">
        <PanelRow
          label="Total GGR change"
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
      </div>
    </StatPanel>
  );
}

/**
 * Net edge by scenario — where the house edge ENDS UP after reward erosion,
 * under scenarios derived from the REAL config (base, each affiliate tier, and a
 * couple of combined worst-cases). Reacts live to the levers (planned edge,
 * affiliate rates, rakeback rates, deposit-bonus levers) because the rows are
 * computed in the pure model from the current planned levers.
 *
 * BASIS (verified, not fabricated — see `_model.computeNetEdgeScenarios`):
 * affiliate commission + rakeback are both a % of WAGER, the SAME base the edge
 * is measured on, so each erodes its rate of edge 1:1 (a 10% tier-8 commission
 * takes a full 10 points off the edge → net 0.99% on the 10.99% plan). The
 * deposit-bonus row uses realized cost ÷ wager — labeled as such.
 *
 * House-POV color on the net value: comfortably positive = emerald, thin / near
 * zero = amber, negative (we lose money on that profile) = rose.
 */
function NetEdgeByScenarioPanel({
  scenarios,
}: {
  scenarios: NetEdgeScenario[];
}) {
  // Chart data: the NET edge per scenario as percentage points so the bars are
  // directly comparable (a base row + each affiliate tier + the combined cases).
  const data = scenarios.map((s) => ({
    key: s.key,
    label: s.label,
    netPct: s.netEdge * 100,
  }));

  const anyNegative = scenarios.some((s) => s.netEdge < 0);
  const anyThin = scenarios.some((s) => s.netEdge >= 0 && s.netEdge < THIN_NET_EDGE);

  return (
    <StatPanel title="Net edge by scenario" icon={ShieldAlert} accent="amber">
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        Where the house edge ends up after reward erosion. Affiliate commission and
        rakeback are a{" "}
        <span className="font-medium text-foreground">% of wager</span> — the same
        base the edge is measured on — so each erodes its rate of edge{" "}
        <span className="font-medium text-foreground">1:1</span> (a tier paying 10%
        takes a full 10 points off the edge). The deposit-bonus row uses realized
        cost ÷ wager.{" "}
        <span className="text-emerald-600 dark:text-emerald-400">Emerald</span> =
        comfortable,{" "}
        <span className="text-amber-600 dark:text-amber-400">amber</span> = thin
        (&lt;{formatPct(THIN_NET_EDGE)}),{" "}
        <span className="text-rose-600 dark:text-rose-400">rose</span> = we lose
        money on that profile.
      </p>

      {scenarios.length === 0 ? (
        <EmptyLever note="No scenarios to show — set a planned edge above." />
      ) : (
        <>
          {/* Bar chart — net edge (percentage points) per scenario. */}
          <ChartContainer
            config={netEdgeChartConfig}
            className="aspect-auto h-[260px] w-full"
          >
            <BarChart
              data={data}
              layout="vertical"
              margin={{ left: 4, right: 52, top: 4, bottom: 4 }}
              accessibilityLayer
            >
              <CartesianGrid horizontal={false} />
              <XAxis
                type="number"
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `${Number(v).toFixed(1)}%`}
                tick={{ fontSize: 11 }}
              />
              <YAxis
                type="category"
                dataKey="label"
                tickLine={false}
                axisLine={false}
                width={150}
                tick={{ fontSize: 11 }}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(v) => `${Number(v).toFixed(2)}% net edge`}
                  />
                }
              />
              {/* Zero line — anything left of it means the house loses money. */}
              <ReferenceLine x={0} stroke="var(--border)" strokeWidth={1} />
              <Bar
                dataKey="netPct"
                radius={[0, 3, 3, 0]}
                animationDuration={700}
                animationEasing="ease-out"
              >
                {data.map((d) => (
                  <Cell key={d.key} fill={netEdgeColor(d.netPct / 100)} />
                ))}
                <LabelList
                  dataKey="netPct"
                  position="right"
                  formatter={(v: number) => `${v.toFixed(2)}%`}
                  className="fill-foreground"
                  style={{ fontSize: 10 }}
                />
              </Bar>
            </BarChart>
          </ChartContainer>

          {/* Table — exact gross → net per scenario, house-POV toned. Custom
              row markup (not PanelRow) so the label can carry a basis tag +
              tooltip; the shared PanelRow is a string-only hotspot we leave
              untouched. */}
          <div className="mt-3 space-y-0.5 border-t pt-3">
            {scenarios.map((s) => (
              <div
                key={s.key}
                className="flex items-center justify-between gap-3 py-1 text-sm"
                title={s.note}
              >
                <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <span className={cn("truncate", s.isBase && "font-semibold")}>
                    {s.label}
                  </span>
                  {!s.isBase && basisLabel(s) && (
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                      {basisLabel(s)}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2 tabular-nums">
                  {!s.isBase && (
                    <span className="text-xs text-muted-foreground">
                      {formatPct(s.grossEdge)} − {formatPct(s.erosion)} →
                    </span>
                  )}
                  <span
                    className={cn(
                      "w-16 text-right font-semibold",
                      netEdgeTextClass(s.netEdge),
                    )}
                  >
                    {formatPct(s.netEdge)}
                  </span>
                </span>
              </div>
            ))}
          </div>

          {(anyNegative || anyThin) && (
            <p
              className={cn(
                "mt-3 rounded-lg border px-3 py-2 text-[11px] leading-relaxed",
                anyNegative
                  ? "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
              )}
            >
              {anyNegative ? (
                <>
                  At least one profile drives the net edge{" "}
                  <span className="font-semibold">below zero</span> — the house loses
                  money on that player profile at the planned edge. Raise the edge or
                  trim the commission / rakeback rates above.
                </>
              ) : (
                <>
                  At least one profile leaves a{" "}
                  <span className="font-semibold">thin</span> net edge (&lt;
                  {formatPct(THIN_NET_EDGE)}) — little cushion against further reward
                  erosion on that profile.
                </>
              )}
            </p>
          )}
        </>
      )}
    </StatPanel>
  );
}

/** Short basis tag for a scenario row (e.g. "wager-based"). */
function basisLabel(s: NetEdgeScenario): string {
  if (s.bases.includes("deposit-bonus")) return "wager + cost";
  if (s.bases.includes("rakeback")) return "wager-based";
  if (s.bases.includes("affiliate")) return "% of wager";
  return "";
}

const netEdgeChartConfig = {
  netPct: { label: "Net edge", color: EMERALD },
} satisfies ChartConfig;

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
        <ChartContainer config={chartConfig} className="aspect-auto h-[300px] w-full">
          <BarChart
            data={data}
            layout="vertical"
            margin={{ left: 4, right: 48, top: 4, bottom: 4 }}
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
              width={120}
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
                  // Per-bar tint reflects the direction of the planned change
                  // from the house POV: cost DROP = house WIN (emerald), cost
                  // RISE = house LOSS (rose), exactly equal = neutral. Using
                  // strict `<`/`>` so a no-op lever does not falsely paint as
                  // a win.
                  fill={
                    d.planned < d.current
                      ? EMERALD
                      : d.planned > d.current
                        ? ROSE
                        : NEUTRAL
                  }
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

/** "1.5×" style multiplier label (rounded to a sensible precision). */
function multLabel(mult: number): string {
  const rounded = Math.round(mult * 100) / 100;
  return `${rounded}×`;
}

/**
 * Format a small per-open EV ($0.0064-style). `formatCurrency` rounds to cents,
 * which would collapse these tiny card EVs to $0.00/$0.01, so we show up to 4
 * decimals (trailing zeros trimmed, min 2) — the real measured EV stays legible.
 */
function evLabel(usd: number): string {
  if (!Number.isFinite(usd)) return "$0.00";
  if (usd === 0) return "$0.00";
  // ≥ $1 reads fine in plain currency; below that show fine precision.
  if (Math.abs(usd) >= 1) return formatCurrency(usd);
  const fixed = usd.toFixed(4);
  const trimmed = fixed.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  // Keep at least 2 decimals so "$0.01" doesn't render as "$0.0".
  const parts = trimmed.split(".");
  if (parts.length === 2 && parts[1].length < 2) {
    return `$${parts[0]}.${parts[1].padEnd(2, "0")}`;
  }
  return `$${trimmed}`;
}

/** Format a whole-ish percent for a readout (e.g. 100 → "100%", 137.5 → "137.5%"). */
function formatPercentInt(pct: number): string {
  if (!Number.isFinite(pct)) return "—";
  const rounded = Math.round(pct * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded}%`;
}

/** Sub-label for a KPI tile: a signed delta vs current. */
function deltaSub(delta: number): string {
  if (Math.abs(delta) < 0.005) return "no change";
  return `${formatSignedUsd(delta)} vs current`;
}

function leversEqual(a: PlannedLevers, b: PlannedLevers): boolean {
  if (
    a.rakebackPackBattleWeight !== b.rakebackPackBattleWeight ||
    a.rakebackUpgraderWeight !== b.rakebackUpgraderWeight ||
    a.rakebackInstantPayoutPct !== b.rakebackInstantPayoutPct ||
    a.rakebackInstantAdoption !== b.rakebackInstantAdoption ||
    a.removeAffiliateWagerReq !== b.removeAffiliateWagerReq ||
    a.depositBonusMatchMult !== b.depositBonusMatchMult ||
    a.depositBonusCapMult !== b.depositBonusCapMult ||
    a.depositBonusMinDepositMult !== b.depositBonusMinDepositMult ||
    a.depositBonusWagerReqMult !== b.depositBonusWagerReqMult ||
    a.racePrizePoolMult !== b.racePrizePoolMult ||
    a.raceFrequencyMult !== b.raceFrequencyMult ||
    a.raceEntryCostMult !== b.raceEntryCostMult ||
    a.rafflePrizePoolMult !== b.rafflePrizePoolMult ||
    a.raffleFrequencyMult !== b.raffleFrequencyMult ||
    a.raffleTicketCostMult !== b.raffleTicketCostMult ||
    a.dailyPacksFrequencyMult !== b.dailyPacksFrequencyMult ||
    a.signupGrantUsd !== b.signupGrantUsd ||
    a.rainCostMult !== b.rainCostMult ||
    a.otherRewardCostMult !== b.otherRewardCostMult ||
    a.mothaCostMult !== b.mothaCostMult
  ) {
    return false;
  }
  const edgeKeys = new Set([
    ...Object.keys(a.edges),
    ...Object.keys(b.edges),
  ]) as Set<GameTypeId>;
  for (const k of edgeKeys) {
    if ((a.edges[k] ?? 0) !== (b.edges[k] ?? 0)) return false;
  }
  // Per-pack daily EV map.
  const dailyKeys = new Set([
    ...Object.keys(a.dailyPackEvUsd),
    ...Object.keys(b.dailyPackEvUsd),
  ]);
  for (const k of dailyKeys) {
    if ((a.dailyPackEvUsd[k] ?? 0) !== (b.dailyPackEvUsd[k] ?? 0)) return false;
  }
  const cadKeys = Object.keys({
    ...a.rakebackRates,
    ...b.rakebackRates,
  }) as RakebackCadenceId[];
  for (const k of cadKeys) {
    if ((a.rakebackRates[k] ?? 0) !== (b.rakebackRates[k] ?? 0)) return false;
  }
  const affKeys = new Set([
    ...Object.keys(a.affiliateRates),
    ...Object.keys(b.affiliateRates),
  ]);
  for (const k of affKeys) {
    const lvl = Number(k);
    if ((a.affiliateRates[lvl] ?? 0) !== (b.affiliateRates[lvl] ?? 0)) return false;
  }
  return true;
}
