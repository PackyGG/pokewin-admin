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
  resolveLeverSeedsV2,
  type EdgePlanV2Baseline,
  type EdgePlanV2Projection,
  type PlannedLeversV2,
} from "../../_model-v2";
import { TEXT_TONE } from "../colors";
import { EmptyLever } from "./empty-lever";
import { PlannerBudgetInput } from "./usd-budget-input";
import { leverEdgeDragPct, RewardPanelTitle } from "./reward-edge-drag";

/**
 * AdjustmentsPanel — the balance-adjustments box (owner spec #10).
 *
 * Read-only REAL 30d per-category breakdown (canonical null-safe category
 * predicates, including the NULL "Not itemized" bucket) + ONE planning
 * lever: `adjustmentsMonthlyRecurringUsd` — the monthly $ the owner expects
 * to keep granting, seeded from the counted-credits run-rate.
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
        <RewardPanelTitle
          label="Balance adjustments"
          dragPct={leverEdgeDragPct(projection, "adjustments")}
        />
      }
      icon={Scale}
      accent="blue"
    >
      <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
        In plain words: money admins manually added to (or removed from)
        player balances.
      </p>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        Real 30d admin balance adjustments by category (canonical customer
        scope). Only <strong>counted</strong> categories feed GGR/NGR — the
        fake-balance and not-itemized rows are listed for completeness but
        cost $0 here. The one lever below plans the recurring monthly $ of
        counted credits.
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
            {rows.map((r) => (
              <TableRow key={r.category ?? "__null__"}>
                <TableCell className="font-medium">
                  {r.label}
                  {r.category == null && (
                    <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                      (NULL category)
                    </span>
                  )}
                </TableCell>
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
            ))}
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
