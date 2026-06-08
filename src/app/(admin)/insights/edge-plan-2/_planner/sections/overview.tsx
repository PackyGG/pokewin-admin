"use client";

import { Layers, ShieldAlert, Wallet, TrendingDown } from "lucide-react";

import { StatPanel, PanelRow } from "@/components/modern-panels";
import { formatCurrency } from "@/lib/utils/format";
import { formatPct, formatSignedUsd } from "../../../edge-calc/math";
import { cn } from "@/lib/utils";
import type { EdgePlanV2Projection } from "../../_model-v2";
import type { NetEdgeScenario } from "../../../system-edge-plan/_model";

export function OverviewSection({
  projection,
  netEdgeScenarios,
}: {
  projection: EdgePlanV2Projection;
  netEdgeScenarios: NetEdgeScenario[];
}) {
  return (
    <div className="space-y-4">
      <StatPanel title="GGR by game type" icon={Layers} accent="emerald">
        <div className="grid gap-3 sm:grid-cols-3">
          {projection.gameTypes.map((g) => {
            const up = g.ggrDelta >= 0;
            const tone =
              Math.abs(g.ggrDelta) < 0.005
                ? "text-muted-foreground"
                : up
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400";
            return (
              <div
                key={g.type}
                className="rounded-lg border bg-background/40 px-3 py-2.5 space-y-1"
              >
                <div className="text-sm font-medium">{g.label}</div>
                <div className="text-[11px] text-muted-foreground">
                  {formatPct(g.currentEdge)} → {formatPct(g.plannedEdge)} edge
                </div>
                <div className={cn("text-sm font-semibold tabular-nums", tone)}>
                  {Math.abs(g.ggrDelta) < 0.005 ? "—" : formatSignedUsd(g.ggrDelta)}
                </div>
              </div>
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

      <StatPanel title="Net edge by scenario" icon={ShieldAlert} accent="amber">
        {netEdgeScenarios.length === 0 ? (
          <p className="text-sm text-muted-foreground">No scenarios — set planned edge above.</p>
        ) : (
          <div className="space-y-1">
            {netEdgeScenarios.map((s) => (
              <PanelRow
                key={s.key}
                label={s.label}
                value={
                  <span
                    className={cn(
                      "font-semibold tabular-nums",
                      s.netEdge < 0
                        ? "text-rose-600 dark:text-rose-400"
                        : s.netEdge < 0.02
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-emerald-600 dark:text-emerald-400",
                    )}
                  >
                    {formatPct(s.netEdge)}
                  </span>
                }
              />
            ))}
          </div>
        )}
      </StatPanel>

      <StatPanel title="Reward cost delta by lever" icon={TrendingDown} accent="purple">
        <div className="space-y-0.5">
          {projection.levers.map((l) => {
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
                  <span className={cn("tabular-nums font-medium", tone)}>
                    {l.deltaCost === 0 ? "—" : formatSignedUsd(-l.deltaCost)}
                  </span>
                }
              />
            );
          })}
        </div>
      </StatPanel>

      <StatPanel title="Reward cost summary" icon={Wallet} accent="rose">
        <PanelRow label="Current reward cost" value={formatCurrency(projection.currentRewardCost)} />
        <PanelRow label="Planned reward cost" value={formatCurrency(projection.plannedRewardCost)} />
        <PanelRow
          label="Shard shop (planned)"
          value={formatCurrency(projection.shardsRedemptionPlanned)}
        />
      </StatPanel>
    </div>
  );
}
