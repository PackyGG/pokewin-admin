"use client";

import * as React from "react";
import { Boxes, ChevronDown, UserPlus } from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatPanel, PanelRow } from "@/components/modern-panels";
import { formatCurrency } from "@/lib/utils/format";
import { LeverSlider } from "../../../system-edge-plan/_planner-ui";
import {
  RewardPackCatalogGrid,
  WelcomePackGrid,
} from "../../../system-edge-plan/_pack-visual";
import { PackFirstTunerCard } from "../../_pack-visual-v2";
import type {
  DailyPackLeverRow,
  DailyPackLevelInfo,
  DailyPackUsageInfo,
} from "../../_model-v2";
import {
  isLeverIncludedInEdgeV2,
  type EdgePlanV2Baseline,
  type EdgePlanV2Projection,
  type PlannedLeversV2,
} from "../../_model-v2";
import {
  computePackCoverage,
  computePackCoverageAggregate,
  type PackCoverageInput,
} from "../../_pack-coverage-v2";
import { formatPct } from "../../../edge-calc/math";
import { formatEvUsd, multLabel } from "../utils";
import { TEXT_TONE } from "../colors";
import { EmptyLever } from "../components/empty-lever";
import { LeverHint } from "../components/lever-hint";
import {
  PackCoverageBlock,
  type PackCoverageDisplayRow,
} from "../components/pack-coverage-block";
import { leverEdgeDragPct } from "../components/reward-edge-drag";
import {
  EdgeInclusionToggle,
  InclusionAwareRewardTitle,
} from "../components/edge-inclusion-toggle";

export function PacksSignupSection({
  baseline,
  levers,
  projection,
  setLevers,
}: {
  baseline: EdgePlanV2Baseline;
  levers: PlannedLeversV2;
  projection: EdgePlanV2Projection;
  setLevers: React.Dispatch<React.SetStateAction<PlannedLeversV2>>;
}) {
  const rows = React.useMemo(() => {
    const measured = new Map(baseline.dailyPackRows.map((r) => [r.packId, r]));
    const levelByPack = new Map(
      baseline.dailyPackLevels.map((l) => [l.packId, l]),
    );
    const usageByPack = new Map(
      baseline.dailyPackUsage.map((u) => [u.packId, u]),
    );
    return baseline.rewardPackCatalog
      .map((cat) => {
        const hit = measured.get(cat.packId);
        const row: DailyPackLeverRow =
          hit ??
          ({
            packId: cat.packId,
            name: cat.name,
            slug: cat.slug,
            opens: 0,
            claimers: 0,
            giveawayPayout: 0,
            measuredEvUsd: cat.theoreticalEvUsd,
            imageUrl: cat.imageUrl,
            cardPreviews: cat.cardPreviews,
          } satisfies DailyPackLeverRow);
        const level: DailyPackLevelInfo | null =
          levelByPack.get(cat.packId) ?? null;
        const usage: DailyPackUsageInfo | null =
          usageByPack.get(cat.packId) ?? null;
        return { ...row, level, usage };
      })
      .sort((a, b) => b.opens - a.opens || a.name.localeCompare(b.name));
  }, [
    baseline.dailyPackRows,
    baseline.dailyPackLevels,
    baseline.dailyPackUsage,
    baseline.rewardPackCatalog,
  ]);

  const freq = Math.max(0, levers.dailyPacksFrequencyMult);
  const plannedTotal = rows.reduce((s, p) => {
    const ev = Math.max(0, levers.dailyPackEvUsd[p.packId] ?? p.measuredEvUsd);
    return s + ev * p.opens;
  }, 0) * freq;
  /** Real window $ actually paid out across all daily packs (Σ giveawayPayout). */
  const measuredTotal = rows.reduce((s, p) => s + p.giveawayPayout, 0);

  // ── Wager-loss vs giveback coverage (shipped pure module, consumed here) ──
  // LOCAL planning assumption — deliberately NOT a lever / model field: the
  // share of the re-lock-gated loss that would not happen without the program.
  const [coverageIncrementality, setCoverageIncrementality] =
    React.useState(0.25);

  const coverage = React.useMemo(() => {
    const windowDays = Math.max(1, baseline.periodDays);
    const global = { incrementality: coverageIncrementality };
    const entries = rows
      .filter((p) => p.claimers > 0)
      .map((p) => {
        const level = p.level;
        // Gate exists but has no empirical $ value (no player at that level
        // yet) → we cannot price the required loss; exclude from totals.
        // levelRequired <= 0 is a GENUINE no-gate pack: required loss $0.
        const gateUnpriced =
          level == null ||
          (level.levelRequired > 0 && level.wagerLossRequiredUsd == null);
        const relockDefault = level?.relockPctDefault ?? 0.01;
        const input: PackCoverageInput = {
          id: p.packId,
          levelRequirementUsd: level?.wagerLossRequiredUsd ?? 0,
          relockPct: levers.dailyPackRelockPct[p.packId] ?? relockDefault,
          evPerOpenUsd: Math.max(
            0,
            levers.dailyPackEvUsd[p.packId] ?? p.measuredEvUsd,
          ),
          // Grant frequency scales opens; claimers held constant (same
          // assumption as the planned-cost line: EV × opens × frequency).
          opensPerWindow: (p.opens * freq) / p.claimers,
          claimers: p.claimers,
          eligibleUsers: p.usage?.eligibleUsers ?? 0,
          windowDays,
        };
        return { name: p.name, gateUnpriced, input };
      });
    const aggregate = computePackCoverageAggregate(
      entries.filter((e) => !e.gateUnpriced).map((e) => e.input),
      global,
    );
    const displayRows: PackCoverageDisplayRow[] = entries.map((e) => ({
      packId: e.input.id!,
      name: e.name,
      gateUnpriced: e.gateUnpriced,
      result: computePackCoverage(e.input, global),
    }));
    return {
      aggregate,
      rows: displayRows,
      byPack: new Map(displayRows.map((r) => [r.packId, r])),
      windowDays,
    };
  }, [
    rows,
    levers.dailyPackEvUsd,
    levers.dailyPackRelockPct,
    freq,
    baseline.periodDays,
    coverageIncrementality,
  ]);

  const amortizedPerSignup =
    baseline.signupSignups > 0
      ? (levers.signupGrantUsd * baseline.signupClaimants) / baseline.signupSignups
      : null;

  return (
    <div className="space-y-4">
      <StatPanel
        title={
          <InclusionAwareRewardTitle
            label="Daily / free packs"
            dragPct={leverEdgeDragPct(projection, "daily-packs")}
            included={isLeverIncludedInEdgeV2(levers, "daily-packs")}
          />
        }
        icon={Boxes}
        accent="pink"
        action={
          <EdgeInclusionToggle
            leverKey="daily-packs"
            levers={levers}
            setLevers={setLevers}
          />
        }
      >
        <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
          In plain words: free packs we hand out — the cost is what&apos;s
          inside, times how many get opened, times how often we grant them.
        </p>
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          Daily / free packs. Grant frequency = how often packs are handed out
          (scales the total daily-pack cost). Planned EV per open = the average
          house cost of one pack open — set it richer or leaner per pack. The
          level gate and the 30d re-lock are PLAYER requirements (wager-loss to
          unlock / re-earn) — they change no house cost here; only EV × opens ×
          frequency does. What the re-lock lever DOES drive is the coverage
          panel below: required loss flow vs giveback.
        </p>
        <div className="mb-4 flex flex-col gap-3 rounded-xl border bg-muted/25 p-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0 flex-1 lg:max-w-md">
            <LeverHint hint="How often free packs are handed out across all packs. Scales the total daily-pack cost.">
              <LeverSlider
                label="Grant frequency (all packs)"
                valueLabel={multLabel(levers.dailyPacksFrequencyMult)}
                value={levers.dailyPacksFrequencyMult * 100}
                onValueChange={(v) =>
                  setLevers((s) => ({
                    ...s,
                    dailyPacksFrequencyMult: Math.max(0, v / 100),
                  }))
                }
                min={0}
                max={300}
                step={0.1}
                baselineMarker={100}
                preciseInput={{ unit: "multiplier" }}
              />
            </LeverHint>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <div className="rounded-lg border bg-muted/30 px-3 py-2 text-right">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Measured (window)
              </p>
              <p className="text-lg font-bold tabular-nums">
                {formatCurrency(measuredTotal)}
              </p>
              <p className="text-[9px] text-muted-foreground">
                real $ paid out
              </p>
            </div>
            <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-right">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Planned total
              </p>
              <p className={`text-lg font-bold tabular-nums ${TEXT_TONE.rose}`}>
                {formatCurrency(plannedTotal)}
              </p>
              <p className="text-[9px] text-muted-foreground">
                EV × opens × frequency
              </p>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {rows.map((p) => {
            const plannedEv =
              levers.dailyPackEvUsd[p.packId] ?? p.measuredEvUsd;
            const plannedCostUsd = plannedEv * p.opens * freq;
            const packCost = formatCurrency(plannedCostUsd);
            const costChanged =
              Math.abs(plannedCostUsd - p.giveawayPayout) > 0.005;
            const coverageRow = coverage.byPack.get(p.packId);
            const coverageRatio = coverageRow?.result.coverageRatio ?? null;
            const level = p.level;
            const usage = p.usage;
            const relockDefault = level?.relockPctDefault ?? 0.01;
            const relockFrac =
              levers.dailyPackRelockPct[p.packId] ?? relockDefault;
            const relockUsd =
              level?.wagerLossRequiredUsd != null
                ? relockFrac * level.wagerLossRequiredUsd
                : null;
            const opensPerClaimer =
              usage?.opensPerClaimer ??
              (p.claimers > 0 ? p.opens / p.claimers : 0);
            return (
              <PackFirstTunerCard
                key={p.packId}
                packId={p.packId}
                name={p.name}
                slug={p.slug}
                imageUrl={p.imageUrl}
                cardPreviews={p.cardPreviews}
                measuredEvUsd={p.measuredEvUsd}
                plannedEvUsd={plannedEv}
                badge="Daily pack"
                inactive={p.opens === 0}
                slider={
                  <>
                    <div className="rounded-lg border bg-muted/20 px-2.5 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Unlock gate
                        </span>
                        {level ? (
                          <>
                            <Badge
                              variant="outline"
                              className={`px-1.5 py-0 text-[10px] ${TEXT_TONE.blue}`}
                            >
                              Lvl {level.levelRequired}
                            </Badge>
                            {level.levelRequired <= 0 ? (
                              <span className="text-[10px] text-muted-foreground">
                                no level gate — everyone eligible
                              </span>
                            ) : level.wagerLossRequiredUsd != null ? (
                              <>
                                <span className="text-[11px] font-semibold tabular-nums">
                                  {formatCurrency(level.wagerLossRequiredUsd)}{" "}
                                  wager-loss
                                </span>
                                <Badge
                                  variant="outline"
                                  className={`px-1.5 py-0 text-[9px] ${TEXT_TONE.blue}`}
                                >
                                  empirical
                                </Badge>
                              </>
                            ) : (
                              <span className="text-[10px] text-muted-foreground">
                                no player at this level yet — no empirical $
                                basis
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">
                            level gate unknown (no opens this window)
                          </span>
                        )}
                      </div>
                      {level &&
                      level.levelRequired > 0 &&
                      level.wagerLossRequiredUsd != null ? (
                        <p className="mt-1 text-[10px] leading-snug text-muted-foreground/80">
                          From real XP level boundaries (1 XP = $0.01
                          wager-loss). Player requirement — not a house cost.
                        </p>
                      ) : null}
                    </div>
                    <LeverHint hint="Avg house cost of one open of this pack. Tick marks today's measured EV.">
                      <LeverSlider
                        label="Planned EV / open"
                        valueLabel={formatEvUsd(plannedEv)}
                        value={plannedEv}
                        onValueChange={(usd) =>
                          setLevers((s) => ({
                            ...s,
                            dailyPackEvUsd: {
                              ...s.dailyPackEvUsd,
                              [p.packId]: Math.max(0, usd),
                            },
                          }))
                        }
                        min={0}
                        max={Math.max(50, plannedEv * 3, p.measuredEvUsd * 3, 5)}
                        step={0.0001}
                        baselineMarker={p.measuredEvUsd}
                        preciseInput={{ unit: "usd", decimals: 4 }}
                      />
                    </LeverHint>
                    <LeverHint hint="Share of the unlock wager-loss a player must re-earn every 30 days to keep this pack unlocked. Player requirement — changes no house cost in this plan.">
                      <LeverSlider
                        label="30d re-lock requirement"
                        valueLabel={
                          relockUsd != null
                            ? `${formatPct(relockFrac)} · ${formatCurrency(relockUsd)}`
                            : formatPct(relockFrac)
                        }
                        value={relockFrac * 100}
                        onValueChange={(v) =>
                          setLevers((s) => ({
                            ...s,
                            dailyPackRelockPct: {
                              ...s.dailyPackRelockPct,
                              [p.packId]: Math.min(1, Math.max(0, v / 100)),
                            },
                          }))
                        }
                        min={0}
                        max={100}
                        step={0.05}
                        baselineMarker={relockDefault * 100}
                        baselineLabel={`default ${formatPct(relockDefault, 1)}`}
                        preciseInput={{ unit: "percent", decimals: 2 }}
                      />
                    </LeverHint>
                    <p className="text-[10px] tabular-nums text-muted-foreground">
                      {relockUsd != null
                        ? `= ${formatCurrency(relockUsd)} wager-loss to re-earn per 30d window`
                        : "No empirical $ basis for this level yet — % only."}
                    </p>
                  </>
                }
                footerStats={
                  <div className="space-y-2">
                    <div className="grid grid-cols-3 gap-x-2 gap-y-2">
                      <UsageStat label="Opens" value={p.opens.toLocaleString()} />
                      <UsageStat
                        label="Claimers"
                        value={p.claimers.toLocaleString()}
                      />
                      <UsageStat
                        label="Opens / claimer"
                        value={p.claimers > 0 ? opensPerClaimer.toFixed(1) : "—"}
                      />
                      <UsageStat
                        label="Claim rate"
                        value={
                          usage?.claimRateVsEligible != null
                            ? formatPct(usage.claimRateVsEligible, 1)
                            : "—"
                        }
                        sub={
                          usage?.eligibleUsers != null
                            ? `${usage.eligibleUsers.toLocaleString()} eligible`
                            : undefined
                        }
                      />
                      <UsageStat
                        label="Every-time %"
                        value={
                          usage?.everyTimeClaimerPct != null
                            ? formatPct(usage.everyTimeClaimerPct, 1)
                            : "—"
                        }
                        sub="claim ≥90% of days"
                      />
                      <UsageStat
                        label="Coverage"
                        value={
                          coverageRow == null
                            ? "—"
                            : coverageRow.gateUnpriced
                              ? "n/a"
                              : coverageRatio == null
                                ? "n/a"
                                : `${coverageRatio.toFixed(2)}×`
                        }
                        tone={
                          coverageRow != null &&
                          !coverageRow.gateUnpriced &&
                          coverageRatio != null
                            ? coverageRatio >= 1
                              ? TEXT_TONE.emerald
                              : TEXT_TONE.rose
                            : undefined
                        }
                        sub={
                          coverageRow == null
                            ? "no claimers"
                            : coverageRow.gateUnpriced
                              ? "no $ basis"
                              : "re-lock flow ÷ giveback"
                        }
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/20 px-2.5 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Measured cost
                        </p>
                        <p className="text-[11px] font-semibold tabular-nums">
                          {formatCurrency(p.giveawayPayout)}
                        </p>
                        <p className="truncate text-[9px] text-muted-foreground">
                          real window $
                        </p>
                      </div>
                      <div className="min-w-0 text-right">
                        <p className="truncate text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Planned cost
                        </p>
                        <p
                          className={`text-[11px] font-semibold tabular-nums ${
                            costChanged ? TEXT_TONE.rose : "text-muted-foreground"
                          }`}
                        >
                          {packCost}
                        </p>
                        <p className="truncate text-[9px] text-muted-foreground">
                          EV × opens × freq
                        </p>
                      </div>
                    </div>
                  </div>
                }
              />
            );
          })}
        </div>
      </StatPanel>

      <PackCoverageBlock
        aggregate={coverage.aggregate}
        rows={coverage.rows}
        incrementality={coverageIncrementality}
        onIncrementalityChange={setCoverageIncrementality}
        windowDays={coverage.windowDays}
      />

      <StatPanel
        title={
          <InclusionAwareRewardTitle
            label="Signup balance reward"
            dragPct={leverEdgeDragPct(projection, "signup-packs")}
            included={isLeverIncludedInEdgeV2(levers, "signup-packs")}
          />
        }
        icon={UserPlus}
        accent="rose"
        action={
          <EdgeInclusionToggle
            leverKey="signup-packs"
            levers={levers}
            setLevers={setLevers}
          />
        }
      >
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          In plain words: the welcome money a brand-new player gets for
          signing up.
        </p>
        <PanelRow
          label="Realized cost (window)"
          value={formatCurrency(baseline.signupPacksCost)}
        />
        <PanelRow label="Claimants" value={baseline.signupClaimants.toLocaleString()} />
        <PanelRow label="Signups" value={baseline.signupSignups.toLocaleString()} />
        {baseline.signupClaimants <= 0 ? (
          <EmptyLever note="No signup-bonus claims in this window." />
        ) : (
          <>
            <LeverHint hint="One-time balance reward each new player gets when they claim, per claimant.">
              <LeverSlider
                label="Avg grant per claimant"
                valueLabel={formatCurrency(levers.signupGrantUsd)}
                value={levers.signupGrantUsd}
                onValueChange={(usd) =>
                  setLevers((s) => ({ ...s, signupGrantUsd: Math.max(0, usd) }))
                }
                min={0}
                max={Math.max(50, (baseline.signupAvgGrant ?? 5) * 3)}
                step={0.01}
                baselineMarker={baseline.signupAvgGrant ?? 0}
                baselineLabel={
                  baseline.signupAvgGrant != null
                    ? `real avg ${formatCurrency(baseline.signupAvgGrant)}`
                    : undefined
                }
                preciseInput={{ unit: "usd", decimals: 2 }}
              />
            </LeverHint>
            {amortizedPerSignup != null && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Bridge: {formatCurrency(levers.signupGrantUsd)} ×{" "}
                {baseline.signupClaimants} claimants ÷ {baseline.signupSignups}{" "}
                signups ≈ {formatCurrency(amortizedPerSignup)} amortized per signup
              </p>
            )}
          </>
        )}
        {baseline.welcomePacks.length > 0 ? (
          <div className="mt-3 space-y-2">
            <p className="text-[11px] text-muted-foreground">
              Welcome / one-time card packs (theoretical EV — separate from cash
              grant above).
            </p>
            <WelcomePackGrid
              packs={baseline.welcomePacks.map((w) => ({
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
        ) : (
          <p className="mt-3 text-[11px] text-muted-foreground">
            No welcome pack EV in baseline — signup cost is the cash grant lever
            above.
          </p>
        )}
      </StatPanel>

      {baseline.rewardPackCatalog.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger
            render={
              <Button variant="outline" size="sm" className="gap-1.5">
                Reward pack catalog
                <ChevronDown className="size-3.5" />
              </Button>
            }
          />
          <CollapsibleContent className="mt-3">
            <p className="mb-3 text-[11px] text-muted-foreground">
              Reference gallery — all configured reward packs, including those
              with no opens this window.
            </p>
            <RewardPackCatalogGrid packs={baseline.rewardPackCatalog} compact />
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

/** One tiny labeled stat cell in a pack card's usage-stats footer grid. */
function UsageStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={`text-[11px] font-semibold tabular-nums ${tone ?? ""}`}>
        {value}
      </p>
      {sub ? (
        <p className="truncate text-[9px] text-muted-foreground">{sub}</p>
      ) : null}
    </div>
  );
}
