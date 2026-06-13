"use client";

import * as React from "react";
import { Scale } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatPanel, PanelRow } from "@/components/modern-panels";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  isLeverIncludedInEdgeV2,
  resolveLeverSeedsV2,
  type EdgePlanV2Baseline,
  type EdgePlanV2Projection,
  type PlannedLeversV2,
} from "../../_model-v2";
import { TEXT_TONE } from "../colors";
import {
  EdgeInclusionToggle,
  InclusionAwareRewardTitle,
} from "./edge-inclusion-toggle";
import { EmptyLever } from "./empty-lever";
import { NotItemizedDrilldownRow } from "./not-itemized-drilldown";
import { PlannerBudgetInput } from "./usd-budget-input";
import { leverEdgeDragPct } from "./reward-edge-drag";

/**
 * AdjustmentsPanel — the balance-adjustments box (owner spec #10, expanded
 * by specs #12 + #14, 2026-06-12).
 *
 * Read-only REAL 30d per-category breakdown (canonical null-safe category
 * predicates, including the NULL "Not itemized" bucket) + ONE planning
 * lever: `adjustmentsMonthlyRecurringUsd` — the monthly $ the owner expects
 * to keep granting, seeded from the counted-credits run-rate.
 *
 * Spec #12: the NULL "Not itemized" row is EXPANDABLE — a lazy drill-down
 * (server action fires on first expand only) over the same window/scope/
 * predicate, with by-month / top-users / largest-20 / by-reason groupings
 * whose totals reconcile exactly with the bucket row
 * (`components/not-itemized-drilldown.tsx`).
 *
 * Spec #14: the title row carries the "counts toward edge" switch — OFF
 * excludes the adjustments program from drag/cost/edge/NGR attribution
 * while every $ here keeps displaying.
 *
 * House-POV: credits go OUT to users → rose; debits claw back → emerald.
 * Only COUNTED categories feed GGR/NGR (the "counted" badge column) —
 * uncounted rows (fake-balance `official_stream`, the NULL bucket) are shown
 * for completeness but cost $0 in the projection.
 */
export function AdjustmentsPanel({
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
  const seeds = React.useMemo(
    () => resolveLeverSeedsV2(baseline, levers),
    [baseline, levers],
  );
  const rows = baseline.adjustmentBreakdown;
  const plannedAdjustments =
    projection.levers.find((l) => l.key === "adjustments")?.plannedCost ?? 0;

  return (
    <StatPanel
      title={
        <InclusionAwareRewardTitle
          label="Balance adjustments"
          dragPct={leverEdgeDragPct(projection, "adjustments")}
          included={isLeverIncludedInEdgeV2(levers, "adjustments")}
        />
      }
      icon={Scale}
      accent="blue"
      action={
        <EdgeInclusionToggle
          leverKey="adjustments"
          levers={levers}
          setLevers={setLevers}
        />
      }
    >
      <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
        In plain words: money admins manually added to (or removed from)
        player balances.
      </p>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        Real 30d admin balance adjustments by category (canonical customer
        scope). Only <strong>counted</strong> categories feed GGR/NGR — the
        fake-balance and not-itemized rows are listed for completeness but
        cost $0 here. Click the <strong>Not itemized</strong> row to drill
        into its individual rows (loaded lazily, only on expand). The one
        lever below plans the recurring monthly $ of counted credits.
      </p>

      {rows.length === 0 ? (
        <EmptyLever note="No balance adjustments found in this window (or the scan timed out)." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Count</TableHead>
              <TableHead className="text-right">Credits</TableHead>
              <TableHead className="text-right">Debits</TableHead>
              <TableHead className="text-right">Counted</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) =>
              r.category == null ? (
                // Spec #12: the NULL bucket row expands into the lazy
                // drill-down (server action on first expand only).
                <NotItemizedDrilldownRow key="__null__" row={r} />
              ) : (
                <TableRow key={r.category}>
                  <TableCell className="font-medium">{r.label}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(r.count)}
                  </TableCell>
                  <TableCell
                    className={`text-right tabular-nums ${
                      r.creditsUsd > 0 ? TEXT_TONE.rose : "text-muted-foreground"
                    }`}
                  >
                    {formatCurrency(r.creditsUsd)}
                  </TableCell>
                  <TableCell
                    className={`text-right tabular-nums ${
                      r.debitsUsd > 0
                        ? TEXT_TONE.emerald
                        : "text-muted-foreground"
                    }`}
                  >
                    {formatCurrency(r.debitsUsd)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge
                      variant="outline"
                      className={`text-[10px] ${
                        r.counted ? TEXT_TONE.rose : "text-muted-foreground"
                      }`}
                    >
                      {r.counted ? "counted" : "not counted"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ),
            )}
          </TableBody>
        </Table>
      )}

      <div className="mt-3 space-y-0.5 border-t pt-3">
        <PanelRow
          label="Counted credits (window, the reward-cost slice)"
          value={formatCurrency(baseline.adjustmentCountedCost)}
          valueClassName={TEXT_TONE.rose}
        />
        <PanelRow
          label="Planned recurring adjustments (window)"
          value={formatCurrency(plannedAdjustments)}
          valueClassName={TEXT_TONE.rose}
        />
      </div>
      <div className="mt-3 border-t pt-3">
        <PlannerBudgetInput
          label="Recurring adjustments monthly"
          value={seeds.adjustmentsMonthlyRecurringUsd}
          seeded={levers.adjustmentsMonthlyRecurringUsd == null}
          onCommit={(next) =>
            setLevers((s) => ({ ...s, adjustmentsMonthlyRecurringUsd: next }))
          }
        />
      </div>
    </StatPanel>
  );
}
