import Link from "next/link";
import { ListOrdered, Trophy } from "lucide-react";
import { SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getRaceInsightsBreakdown } from "@/lib/queries/insights-rewards/race/breakdown";
import { compareRaceBreakdown } from "@/lib/clickhouse/compare/insights-race-breakdown";

/**
 * Race-by-race breakdown tab. Renders one row per race instance in the
 * window with prize pool, winner count, position spread, top winner +
 * tier utilisation. Sorted by prize pool DESC server-side.
 *
 * House-POV: pool $ is house cost → rose. Tier utilisation > 100%
 * means actual paid exceeded configured budget (only possible on edge
 * cases like tier additions) — flagged amber to draw attention.
 */
export async function RaceBreakdownTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const res = await safeQuery(
    () => getRaceInsightsBreakdown(period),
    [],
    "insights-rewards.race.breakdown",
  );
  if (res.error) {
    return (
      <TileErrorFallback
        label="Race — Breakdown"
        hint="The race breakdown query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const rows = res.data;
  const label = insightsRewardsPeriodLabel(period);

  void compareRaceBreakdown(period, rows);

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Trophy}
          title={`No races in ${label.toLowerCase()}`}
          description="No race instances completed with winners in this window. Try a longer period."
          compact
        />
      </div>
    );
  }

  return (
    <FadeIn>
      <div className="space-y-3">
        <SectionHeading
          icon={ListOrdered}
          title={`Race instances · ${rows.length} race${rows.length === 1 ? "" : "s"}`}
        />
        <div className="relative overflow-hidden rounded-2xl border bg-card">
          {/* Mobile cards */}
          <div className="md:hidden divide-y">
            {rows.map((row) => (
              <div key={`${row.raceType}:${row.periodStart}`} className="space-y-2 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <RaceTypeBadge raceType={row.raceType} />
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {formatDate(row.periodStart)}
                    </span>
                  </div>
                  <span className="text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
                    {formatCurrency(row.prizePool)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                  <span>{formatNumber(row.winnerCount)} winners</span>
                  <span>Top #{row.topPosition}</span>
                  <span>Spread {row.positionSpread}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <Link
                    href={`/users/${row.topUserId}`}
                    className="truncate text-xs font-medium hover:underline"
                  >
                    {row.topUsername ?? row.topUserId.slice(0, 8)}
                  </Link>
                  <span className="text-xs tabular-nums text-rose-600 dark:text-rose-400">
                    {formatCurrency(row.topPrize)}
                  </span>
                </div>
                <UtilisationRow
                  budget={row.configuredBudget}
                  utilisation={row.tierUtilisation}
                />
              </div>
            ))}
          </div>
          {/* Desktop table */}
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Pool</TableHead>
                  <TableHead className="text-right">Winners</TableHead>
                  <TableHead className="text-right">Top pos</TableHead>
                  <TableHead className="text-right">Spread</TableHead>
                  <TableHead>Top winner</TableHead>
                  <TableHead className="text-right">Top prize</TableHead>
                  <TableHead className="text-right">Tier utilisation</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={`${row.raceType}:${row.periodStart}`}>
                    <TableCell><RaceTypeBadge raceType={row.raceType} /></TableCell>
                    <TableCell className="text-xs tabular-nums text-muted-foreground">
                      {formatDate(row.periodStart)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                      {formatCurrency(row.prizePool)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(row.winnerCount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      #{row.topPosition}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {row.positionSpread}
                    </TableCell>
                    <TableCell className="text-sm">
                      <Link
                        href={`/users/${row.topUserId}`}
                        className="font-medium hover:underline"
                      >
                        {row.topUsername ?? row.topUserId.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                      {formatCurrency(row.topPrize)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <InlineUtilisation
                        pool={row.prizePool}
                        budget={row.configuredBudget}
                        utilisation={row.tierUtilisation}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
    </FadeIn>
  );
}

function RaceTypeBadge({ raceType }: { raceType: string }) {
  const label =
    raceType === "daily"
      ? "Daily"
      : raceType === "weekly"
        ? "Weekly"
        : raceType === "monthly"
          ? "Monthly"
          : raceType;
  // Neutral primary tint — race type is a categorisation, not a finance
  // event, so the tint stays neutral per the House-POV rule.
  return (
    <Badge variant="secondary" className="text-[11px] uppercase tracking-wider">
      {label}
    </Badge>
  );
}

function InlineUtilisation({
  pool,
  budget,
  utilisation,
}: {
  pool: number;
  budget: number | null;
  utilisation: number | null;
}) {
  if (utilisation === null || budget === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  const pct = utilisation * 100;
  // > 100% means actual exceeded configured budget — possible on tier
  // additions or admin overrides; flagged amber. Healthy <= 100%.
  const className =
    pct > 100
      ? "text-amber-600 dark:text-amber-400"
      : "text-foreground";
  return (
    <span className={cn("tabular-nums", className)}>
      {pct.toFixed(1)}%{" "}
      <span className="text-[10px] text-muted-foreground">
        ({formatCurrency(pool)} / {formatCurrency(budget)})
      </span>
    </span>
  );
}

function UtilisationRow({
  budget,
  utilisation,
}: {
  budget: number | null;
  utilisation: number | null;
}) {
  if (utilisation === null || budget === null) return null;
  const pct = utilisation * 100;
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <span className="shrink-0">Tier</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-sm bg-muted">
        <div
          className={cn(
            "h-full rounded-sm transition-all",
            pct > 100 ? "bg-amber-500/60" : "bg-rose-500/60",
          )}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span
        className={cn(
          "shrink-0 tabular-nums",
          pct > 100 ? "text-amber-600 dark:text-amber-400" : "",
        )}
      >
        {pct.toFixed(1)}%
      </span>
    </div>
  );
}
