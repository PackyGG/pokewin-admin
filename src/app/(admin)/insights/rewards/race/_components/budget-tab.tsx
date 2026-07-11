import { Target, Flag, Sigma } from "lucide-react";
import {
  KpiTile,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import {
  getRaceInsightsPerType,
  type RacePerTypeRow,
} from "@/lib/queries/insights-rewards/race/per-type";
import { compareRacePerType } from "@/lib/clickhouse/compare/insights-race-per-type";

const TYPE_LABEL: Record<RacePerTypeRow["raceType"], string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

/**
 * Budget tab — focused view on how much of the configured race prize
 * budget actually gets paid out. Reuses `getRaceInsightsPerType` (so
 * the cache key is shared with the per-type tab) and computes the
 * blended utilisation across all types as a single headline.
 *
 * House-POV: configured budget = ceiling; actually paid = cost → rose.
 * Overage flagged amber so admins can spot tier-edit edge cases.
 */
export async function RaceBudgetTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const res = await safeQuery(
    () => getRaceInsightsPerType(period),
    [],
    "insights-rewards.race.budget",
  );
  if (res.error) {
    return (
      <TileErrorFallback
        label="Race — Budget"
        hint="The budget query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const rows = res.data;
  const label = insightsRewardsPeriodLabel(period);

  void compareRacePerType(period, rows);

  const anyActivity = rows.some((r) => r.distinctRaces > 0);
  if (!anyActivity) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Target}
          title={`No race spend in ${label.toLowerCase()}`}
          description="No race prizes paid out in this window. Try a longer period."
          compact
        />
      </div>
    );
  }

  const totalPaid = rows.reduce((acc, r) => acc + r.prizePoolTotal, 0);
  const totalCeiling = rows.reduce(
    (acc, r) => acc + r.tierBudgetForWindow,
    0,
  );
  const blendedUtilisation = totalCeiling > 0 ? totalPaid / totalCeiling : null;
  const overBudgetTypes = rows.filter(
    (r) => r.tierUtilisation !== null && r.tierUtilisation > 1,
  );

  return (
    <FadeIn>
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <KpiTile
            label="Blended utilisation"
            value={
              blendedUtilisation === null
                ? "—"
                : `${(blendedUtilisation * 100).toFixed(1)}%`
            }
            sub="Paid / window ceiling"
            icon={Target}
            accent={
              blendedUtilisation !== null && blendedUtilisation > 1
                ? "amber"
                : "rose"
            }
          />
          <KpiTile
            label="Paid"
            value={formatCurrency(totalPaid)}
            sub={`${label}`}
            icon={Sigma}
            accent="rose"
          />
          <KpiTile
            label="Window ceiling"
            value={formatCurrency(totalCeiling)}
            sub="Sum of per-race budgets"
            icon={Target}
            accent="blue"
          />
          <KpiTile
            label="Over-budget types"
            value={formatNumber(overBudgetTypes.length)}
            sub={
              overBudgetTypes.length === 0
                ? "All within configured tiers"
                : "Audit tier configuration"
            }
            icon={Flag}
            accent={overBudgetTypes.length > 0 ? "amber" : "emerald"}
          />
        </div>

        <div className="space-y-3">
          <SectionHeading icon={Target} title="Per-type utilisation" />
          <div className="grid gap-4 lg:grid-cols-3">
            {rows.map((r) => (
              <BudgetTypeCard key={r.raceType} row={r} />
            ))}
          </div>
        </div>
      </div>
    </FadeIn>
  );
}

function BudgetTypeCard({ row }: { row: RacePerTypeRow }) {
  const pct = row.tierUtilisation === null ? 0 : row.tierUtilisation * 100;
  const over = pct > 100;
  return (
    <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {TYPE_LABEL[row.raceType]}
          </p>
          <p
            className={cn(
              "mt-1 text-2xl font-bold tabular-nums",
              over
                ? "text-amber-600 dark:text-amber-400"
                : "text-rose-600 dark:text-rose-400",
            )}
          >
            {row.tierUtilisation === null ? "—" : `${pct.toFixed(1)}%`}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs tabular-nums text-rose-600 dark:text-rose-400">
            {formatCurrency(row.prizePoolTotal)}
          </p>
          <p className="text-[10px] tabular-nums text-muted-foreground">
            of {formatCurrency(row.tierBudgetForWindow)}
          </p>
        </div>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-sm bg-muted">
        <div
          className={cn(
            "h-full rounded-sm transition-all",
            over ? "bg-amber-500/60" : "bg-rose-500/60",
          )}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 border-t pt-3 text-[11px] text-muted-foreground">
        <div>
          <span className="block text-foreground tabular-nums">
            {formatNumber(row.distinctRaces)}
          </span>
          races
        </div>
        <div>
          <span className="block text-foreground tabular-nums">
            {formatCurrency(row.configuredBudget)}
          </span>
          per race
        </div>
        <div>
          <span className="block text-foreground tabular-nums">
            {formatCurrency(row.avgPrizePerRace)}
          </span>
          actual avg
        </div>
      </div>
    </div>
  );
}
