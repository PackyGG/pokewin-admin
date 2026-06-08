"use client";

import * as React from "react";
import { Boxes, UserPlus } from "lucide-react";

import { StatPanel, PanelRow } from "@/components/modern-panels";
import { formatCurrency } from "@/lib/utils/format";
import { LeverSlider } from "../../../system-edge-plan/_planner-ui";
import { PackFirstTunerCard } from "../../_pack-visual-v2";
import type { DailyPackLeverRow } from "../../_model-v2";
import {
  type EdgePlanV2Baseline,
  type PlannedLeversV2,
} from "../../_model-v2";
import { formatEvUsd, multLabel } from "../utils";

export function PacksSignupSection({
  baseline,
  levers,
  setLevers,
}: {
  baseline: EdgePlanV2Baseline;
  levers: PlannedLeversV2;
  setLevers: React.Dispatch<React.SetStateAction<PlannedLeversV2>>;
}) {
  const rows = React.useMemo(() => {
    const measured = new Map(baseline.dailyPackRows.map((r) => [r.packId, r]));
    return baseline.rewardPackCatalog
      .map((cat) => {
        const hit = measured.get(cat.packId);
        if (hit) return hit;
        return {
          packId: cat.packId,
          name: cat.name,
          slug: cat.slug,
          opens: 0,
          claimers: 0,
          giveawayPayout: 0,
          measuredEvUsd: cat.theoreticalEvUsd,
          imageUrl: cat.imageUrl,
          cardPreviews: cat.cardPreviews,
        } satisfies DailyPackLeverRow;
      })
      .sort((a, b) => b.opens - a.opens || a.name.localeCompare(b.name));
  }, [baseline.dailyPackRows, baseline.rewardPackCatalog]);

  const freq = Math.max(0, levers.dailyPacksFrequencyMult);
  const plannedTotal = rows.reduce((s, p) => {
    const ev = Math.max(0, levers.dailyPackEvUsd[p.packId] ?? p.measuredEvUsd);
    return s + ev * p.opens;
  }, 0) * freq;

  return (
    <div className="space-y-4">
      <StatPanel title="Daily / free packs" icon={Boxes} accent="pink">
        <div className="mb-4 flex flex-col gap-3 rounded-xl border bg-muted/25 p-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0 flex-1 lg:max-w-md">
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
          </div>
          <div className="shrink-0 rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-right">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Planned total
            </p>
            <p className="text-lg font-bold tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(plannedTotal)}
            </p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {rows.map((p) => {
            const plannedEv =
              levers.dailyPackEvUsd[p.packId] ?? p.measuredEvUsd;
            const packCost = formatCurrency(plannedEv * p.opens * freq);
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
                    step={0.01}
                    preciseInput={{ unit: "usd", decimals: 2 }}
                  />
                }
                footerStats={
                  <div className="flex justify-between text-[11px] tabular-nums">
                    <span>
                      {p.opens.toLocaleString()} opens · {p.claimers} claimers
                    </span>
                    <span className="font-semibold text-rose-600 dark:text-rose-400">
                      {packCost}
                    </span>
                  </div>
                }
              />
            );
          })}
        </div>
      </StatPanel>

      <StatPanel title="Signup balance reward" icon={UserPlus} accent="rose">
        <PanelRow
          label="Realized cost (window)"
          value={formatCurrency(baseline.signupPacksCost)}
        />
        <PanelRow label="Claimants" value={baseline.signupClaimants.toLocaleString()} />
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
          preciseInput={{ unit: "usd", decimals: 2 }}
        />
        {baseline.welcomePacks.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            {baseline.welcomePacks.length} welcome pack reference(s) in baseline — card
            EV is display context only; cost lever is cash grant above.
          </p>
        )}
      </StatPanel>
    </div>
  );
}
