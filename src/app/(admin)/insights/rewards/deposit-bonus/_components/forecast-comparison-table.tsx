"use client";

import * as React from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import { formatSignedUsd } from "../../../edge-calc/math";

import type {
  Recommendation,
  ScenarioConfig,
  SimulationResult,
} from "../_forecast";
import { capLogicLabel, operationalComplexity } from "./forecast-format";

/**
 * Side-by-side scenario comparison.
 *
 * One row per scenario in the active set. Columns surface every dimension the
 * brief asks for: cap logic, projected cost, savings (gross + net), abuse
 * reduction %, conversion/retention impact, NGR impact, operational
 * complexity, and a recommended badge.
 *
 * House-POV colors throughout: cost / abuse leakage = rose (house outflow);
 * net savings / NGR positive = emerald (house gain); retained revenue =
 * emerald (downstream value the house keeps). The baseline row is muted (it
 * saves nothing vs itself).
 *
 * Desktop = a dense `ui/table`; mobile (<md) = a stacked card list (mirrors
 * the DailyBreakdownTable pattern on the Overview tab) so nothing scrolls
 * sideways on a phone.
 */

export type ComparisonRow = {
  scenario: ScenarioConfig;
  result: SimulationResult;
};

export function ForecastComparisonTable({
  rows,
  baselineId,
  recommendations,
  activeScenarioId,
  onSelectScenario,
}: {
  rows: ComparisonRow[];
  baselineId: string;
  recommendations: Recommendation[];
  activeScenarioId: string;
  onSelectScenario: (id: string) => void;
}) {
  // Map scenarioId → badge label for the "recommended" column.
  const badgeByScenario = React.useMemo(() => {
    const m = new Map<string, Recommendation["badge"]>();
    for (const r of recommendations) {
      // Keep the first (highest-priority) badge per scenario.
      if (!m.has(r.scenarioId)) m.set(r.scenarioId, r.badge);
    }
    return m;
  }, [recommendations]);

  return (
    <>
      {/* ── Mobile cards (<md) ───────────────────────────────────── */}
      <div className="space-y-2 md:hidden">
        {rows.map(({ scenario, result }) => {
          const isBaseline = scenario.id === baselineId;
          const badge = badgeByScenario.get(scenario.id);
          return (
            <button
              key={scenario.id}
              type="button"
              onClick={() => onSelectScenario(scenario.id)}
              className={cn(
                "w-full rounded-xl border bg-card px-3 py-2.5 text-left transition-colors",
                scenario.id === activeScenarioId
                  ? "border-primary/40 ring-1 ring-primary/30"
                  : "hover:border-border",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{scenario.label}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {capLogicLabel(scenario.cap)}
                  </p>
                </div>
                {badge && <RecoBadge badge={badge} />}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                <CardStat label="Cost" value={formatCurrency(result.bonusCost)} tone="rose" />
                <CardStat
                  label="Net savings"
                  value={isBaseline ? "—" : formatSignedUsd(result.netSavingsVsBaseline)}
                  tone={isBaseline ? "muted" : result.netSavingsVsBaseline >= 0 ? "emerald" : "rose"}
                />
                <CardStat label="Abuse leak" value={formatCurrency(result.abuseLeakage)} tone="amber" />
                <CardStat
                  label="NGR"
                  value={formatSignedUsd(result.ngrImpact)}
                  tone={result.ngrImpact >= 0 ? "emerald" : "rose"}
                />
              </div>
            </button>
          );
        })}
      </div>

      {/* ── Desktop table (>=md) ─────────────────────────────────── */}
      <div className="hidden overflow-x-auto md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Scenario</TableHead>
              <TableHead>Cap logic</TableHead>
              <TableHead className="text-right">Proj. cost</TableHead>
              <TableHead className="text-right">Gross savings</TableHead>
              <TableHead className="text-right">Net savings</TableHead>
              <TableHead className="text-right">Abuse ↓</TableHead>
              <TableHead className="text-right">Retention impact</TableHead>
              <TableHead className="text-right">NGR impact</TableHead>
              <TableHead className="text-center">Complexity</TableHead>
              <TableHead className="text-center">Verdict</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ scenario, result }) => {
              const isBaseline = scenario.id === baselineId;
              const badge = badgeByScenario.get(scenario.id);
              const baselineRow = rows.find((r) => r.scenario.id === baselineId)?.result;
              const abuseReductionPct =
                baselineRow && baselineRow.abuseLeakage > 0
                  ? (baselineRow.abuseLeakage - result.abuseLeakage) / baselineRow.abuseLeakage
                  : 0;
              const retentionDelta = baselineRow
                ? result.retainedRevenue - baselineRow.retainedRevenue
                : 0;
              const complexity = operationalComplexity(scenario.cap);
              return (
                <TableRow
                  key={scenario.id}
                  data-active={scenario.id === activeScenarioId}
                  onClick={() => onSelectScenario(scenario.id)}
                  className={cn(
                    "cursor-pointer",
                    scenario.id === activeScenarioId && "bg-primary/5",
                  )}
                >
                  <TableCell className="font-medium">{scenario.label}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {capLogicLabel(scenario.cap)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                    {formatCurrency(result.bonusCost)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {isBaseline ? (
                      <span className="text-muted-foreground">baseline</span>
                    ) : (
                      <span
                        className={
                          result.savingsVsBaseline >= 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-rose-600 dark:text-rose-400"
                        }
                      >
                        {formatSignedUsd(result.savingsVsBaseline)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {isBaseline ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span
                        className={
                          result.netSavingsVsBaseline >= 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-rose-600 dark:text-rose-400"
                        }
                      >
                        {formatSignedUsd(result.netSavingsVsBaseline)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {isBaseline ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span
                        className={
                          abuseReductionPct > 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-muted-foreground"
                        }
                      >
                        {(abuseReductionPct * 100).toFixed(0)}%
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {isBaseline ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      // Retention delta: a DROP in retained revenue is bad for the
                      // house (we gave up downstream value) → rose. A gain → emerald.
                      <span
                        className={
                          retentionDelta >= 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-rose-600 dark:text-rose-400"
                        }
                      >
                        {formatSignedUsd(retentionDelta)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <span
                      className={
                        result.ngrImpact >= 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-rose-600 dark:text-rose-400"
                      }
                    >
                      {formatSignedUsd(result.ngrImpact)}
                    </span>
                  </TableCell>
                  <TableCell className="text-center">
                    <ComplexityPip level={complexity} />
                  </TableCell>
                  <TableCell className="text-center">
                    {badge ? (
                      <RecoBadge badge={badge} />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

// ─── Inline helpers ──────────────────────────────────────────────────

const BADGE_META: Record<
  Recommendation["badge"],
  { label: string; className: string }
> = {
  "highest-savings": {
    label: "Top savings",
    className:
      "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  "lowest-friction": {
    label: "Lowest friction",
    className: "border-blue-500/30 bg-blue-500/15 text-blue-600 dark:text-blue-400",
  },
  "best-balance": {
    label: "Best balance",
    className:
      "border-purple-500/30 bg-purple-500/15 text-purple-600 dark:text-purple-400",
  },
};

function RecoBadge({ badge }: { badge: Recommendation["badge"] }) {
  const meta = BADGE_META[badge];
  return (
    <Badge variant="outline" className={cn("font-medium", meta.className)}>
      {meta.label}
    </Badge>
  );
}

function ComplexityPip({ level }: { level: 1 | 2 | 3 }) {
  return (
    <span className="inline-flex items-center gap-0.5" title={`Operational complexity: ${level}/3`}>
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          className={cn(
            "size-1.5 rounded-full",
            i <= level ? "bg-amber-500" : "bg-muted-foreground/25",
          )}
        />
      ))}
    </span>
  );
}

function CardStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "rose" | "emerald" | "amber" | "muted";
}) {
  const toneClass =
    tone === "rose"
      ? "text-rose-600 dark:text-rose-400"
      : tone === "emerald"
        ? "text-emerald-600 dark:text-emerald-400"
        : tone === "amber"
          ? "text-amber-600 dark:text-amber-400"
          : "text-muted-foreground";
  return (
    <div className="flex items-center justify-between gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("tabular-nums font-medium", toneClass)}>{value}</span>
    </div>
  );
}
