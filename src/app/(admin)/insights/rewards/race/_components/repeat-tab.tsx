import Link from "next/link";
import { Repeat, Users, Flag, Trophy } from "lucide-react";
import {
  KpiTile,
  SectionHeading,
} from "@/components/modern-panels";
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
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getRaceInsightsRepeatWinners } from "@/lib/queries/insights-rewards/race/repeat-winners";
import { DistributionBarChart } from "@/app/(admin)/rewards/analytics/_components/distribution-bar-chart";

/**
 * Repeat-winners tab. Users who placed in ≥2 races within the window.
 * Top 10 by cumulative prize + frequency distribution chart.
 *
 * House-POV: cumulative prize is cost → rose.
 */
export async function RaceRepeatWinnersTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const res = await safeQuery(
    () => getRaceInsightsRepeatWinners(period),
    null,
    "insights-rewards.race.repeat",
  );
  if (res.error || !res.data) {
    return (
      <TileErrorFallback
        label="Race — Repeat winners"
        hint="The repeat-winner query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const data = res.data;
  const label = insightsRewardsPeriodLabel(period);

  if (data.totalRepeatWinners === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Repeat}
          title={`No repeat winners in ${label.toLowerCase()}`}
          description="No user placed in more than one race in this window. Try a longer period."
          compact
        />
      </div>
    );
  }

  const totalPrize = data.topRepeatWinners.reduce(
    (acc, w) => acc + w.totalPrize,
    0,
  );

  return (
    <FadeIn>
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <KpiTile
            label="Repeat winners"
            value={formatNumber(data.totalRepeatWinners)}
            sub="≥2 races in window"
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="Top-10 prize sum"
            value={formatCurrency(totalPrize)}
            sub="Across heavy repeaters"
            icon={Trophy}
            accent="rose"
          />
          <KpiTile
            label="Most races (top 1)"
            value={
              data.topRepeatWinners[0]
                ? `${formatNumber(data.topRepeatWinners[0].raceCount)}`
                : "—"
            }
            sub={
              data.topRepeatWinners[0]
                ? data.topRepeatWinners[0].username ??
                  data.topRepeatWinners[0].userId.slice(0, 8)
                : "—"
            }
            icon={Flag}
            accent="cyan"
          />
          <KpiTile
            label="Highest cumulative"
            value={
              data.topRepeatWinners[0]
                ? formatCurrency(data.topRepeatWinners[0].totalPrize)
                : "—"
            }
            sub="Top repeater's total"
            icon={Trophy}
            accent="rose"
          />
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <div className="space-y-3">
            <SectionHeading
              icon={Repeat}
              title="Frequency distribution"
            />
            <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
              <p className="text-[11px] text-muted-foreground">
                How many users land in each race-count bucket. Spotting a long
                tail at 11+ means a small group of repeat winners absorb most
                of the spend.
              </p>
              <div className="mt-3">
                <DistributionBarChart
                  data={data.frequencyBuckets.map((b) => ({
                    label: b.label,
                    count: b.userCount,
                    volume: b.totalPrize,
                  }))}
                  metric="count"
                />
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
                {data.frequencyBuckets.map((b) => (
                  <div
                    key={b.label}
                    className="rounded-lg border bg-muted/30 p-2"
                  >
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {b.label}
                    </p>
                    <p className="mt-0.5 text-sm font-bold tabular-nums">
                      {formatNumber(b.userCount)}
                    </p>
                    <p className="text-[10px] tabular-nums text-rose-600 dark:text-rose-400">
                      {formatCurrency(b.totalPrize)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <SectionHeading
              icon={Trophy}
              title="Top 10 cumulative repeat winners"
            />
            <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card">
              <div className="md:hidden divide-y">
                {data.topRepeatWinners.map((w, i) => (
                  <div
                    key={w.userId}
                    className="flex items-center gap-3 p-3"
                  >
                    <span className="w-7 shrink-0 text-xs tabular-nums text-muted-foreground">
                      #{i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/users/${w.userId}`}
                        className="block truncate text-sm font-medium hover:underline"
                      >
                        {w.username ?? w.userId.slice(0, 8)}
                      </Link>
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        {formatNumber(w.raceCount)} races · avg {formatCurrency(w.avgPrize)}
                      </span>
                    </div>
                    <span className="shrink-0 text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
                      {formatCurrency(w.totalPrize)}
                    </span>
                  </div>
                ))}
              </div>
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[50px]">Rank</TableHead>
                      <TableHead>User</TableHead>
                      <TableHead className="text-right">Races</TableHead>
                      <TableHead className="text-right">Avg prize</TableHead>
                      <TableHead className="text-right">Total prize</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.topRepeatWinners.map((w, i) => (
                      <TableRow key={w.userId}>
                        <TableCell className="tabular-nums text-muted-foreground">
                          #{i + 1}
                        </TableCell>
                        <TableCell className="font-medium">
                          <Link
                            href={`/users/${w.userId}`}
                            className="hover:underline"
                          >
                            {w.username ?? w.userId.slice(0, 8)}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatNumber(w.raceCount)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {formatCurrency(w.avgPrize)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                          {formatCurrency(w.totalPrize)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </FadeIn>
  );
}
