import Link from "next/link";
import { Trophy, Flag } from "lucide-react";
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
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import {
  getRaceInsightsTopWinners,
  type RaceTopWinner,
} from "@/lib/queries/insights-rewards/race/top-winners";
import { compareRaceTop } from "@/lib/clickhouse/compare/insights-race-top";

/**
 * Top winners tab — top 25 by total race prize in period + lifetime,
 * side-by-side. House-POV: prize $ is house cost → rose.
 */
export async function RaceTopWinnersTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const res = await safeQuery(
    () => getRaceInsightsTopWinners(period),
    null,
    "insights-rewards.race.top-winners",
  );
  if (res.error || !res.data) {
    return (
      <TileErrorFallback
        label="Race — Top winners"
        hint="The top-winner query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const data = res.data;
  const label = insightsRewardsPeriodLabel(period);

  void compareRaceTop(period, data);

  if (data.period.length === 0 && data.lifetime.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Trophy}
          title={`No race winners in ${label.toLowerCase()}`}
          description="No race prizes have been paid out. Try a longer period."
          compact
        />
      </div>
    );
  }

  return (
    <FadeIn>
      <div className="grid gap-6 xl:grid-cols-2">
        <WinnersPanel
          title={`Top 25 — ${label}`}
          subtitle="In-window cumulative prize"
          rows={data.period}
          showLifetime
        />
        <WinnersPanel
          title="Top 25 — Lifetime"
          subtitle="All-time cumulative prize"
          rows={data.lifetime}
          showLifetime={false}
        />
      </div>
    </FadeIn>
  );
}

function WinnersPanel({
  title,
  subtitle,
  rows,
  showLifetime,
}: {
  title: string;
  subtitle: string;
  rows: RaceTopWinner[];
  showLifetime: boolean;
}) {
  return (
    <div className="space-y-3">
      <SectionHeading icon={Trophy} title={title} />
      <div className="relative overflow-hidden rounded-2xl border bg-card">
        <div className="border-b p-3 sm:p-4">
          <p className="text-[11px] text-muted-foreground">{subtitle}</p>
        </div>
        {rows.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No winners to show in this window.
          </p>
        ) : (
          <>
            <div className="md:hidden divide-y">
              {rows.map((w, i) => (
                <div key={w.userId} className="flex items-center gap-3 p-3">
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
                      <Flag className="mr-0.5 inline size-3" />
                      {formatNumber(w.raceCount)} · avg {formatCurrency(w.avgPrize)}
                    </span>
                    {showLifetime && (
                      <span className="ml-2 text-[11px] tabular-nums text-muted-foreground">
                        lifetime {formatCurrency(w.lifetimeTotal)}
                      </span>
                    )}
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
                    <TableHead className="text-right">Avg</TableHead>
                    <TableHead className="text-right">
                      {showLifetime ? "Period" : "Total"}
                    </TableHead>
                    {showLifetime && (
                      <TableHead className="text-right">Lifetime</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((w, i) => (
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
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatNumber(w.raceCount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatCurrency(w.avgPrize)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCurrency(w.totalPrize)}
                      </TableCell>
                      {showLifetime && (
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {formatCurrency(w.lifetimeTotal)}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
