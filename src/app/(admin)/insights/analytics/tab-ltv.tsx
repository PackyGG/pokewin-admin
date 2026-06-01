import Link from "next/link";
import { TrendingUp, Crown } from "lucide-react";
import { FadeIn } from "@/components/fade-in";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  getInsightsLtv,
  parseLtvSegment,
  type LtvSegmentKey,
} from "@/lib/queries/insights-analytics/ltv";
import { EmptyState } from "@/components/empty-state";
import type { InsightsPeriod } from "./types";

/**
 * LTV tab — lifetime value per user, segmented by percentile (top 1%,
 * top 10%, …) or by signup source. Also shows the top 50 users by GGR
 * contribution so admins can drill in.
 *
 * The hero period filter is informational only — LTV is lifetime by
 * definition.
 */
export async function LtvInsightsTab({
  period: _period,
  segmentBy,
}: {
  period: InsightsPeriod;
  segmentBy: string | undefined;
}) {
  void _period;
  const seg = parseLtvSegment(segmentBy);
  const data = await getInsightsLtv(seg);

  return (
    <FadeIn>
      <div className="space-y-4">
        <Intro segmentBy={seg} />
        <SegmentToggle current={seg} />

        {data.segments.length === 0 ? (
          <EmptyState
            icon={TrendingUp}
            title="No LTV data"
            description="No users have produced ledger activity yet."
          />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">
                LTV segments
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Segments contain user-level totals. Top 1% / Top 10% / Top 50%
                are <b>cumulative</b> (the top-1% users are also in top-10%
                and top-50%). The &quot;Excl&quot; rows isolate the tail. House
                POV: positive net P&amp;L = emerald, negative = rose.
              </p>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Segment</TableHead>
                    <TableHead className="text-right">Users</TableHead>
                    <TableHead className="text-right">Deposits</TableHead>
                    <TableHead className="text-right">Wager</TableHead>
                    <TableHead className="text-right">GGR contribution</TableHead>
                    <TableHead className="text-right">Bonus drag</TableHead>
                    <TableHead className="text-right">Avg LTV</TableHead>
                    <TableHead className="text-right">Median LTV</TableHead>
                    <TableHead className="text-right">Net P&L</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.segments.map((s) => (
                    <TableRow key={s.key}>
                      <TableCell className="font-medium">{s.label}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(s.users)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(s.deposits)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(s.wager)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular-nums",
                          s.ggrContribution >= 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-rose-600 dark:text-rose-400",
                        )}
                      >
                        {formatCurrency(s.ggrContribution)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCurrency(s.bonusDrag)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(s.avgLtv)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(s.medianLtv)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular-nums",
                          s.netPnl >= 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-rose-600 dark:text-rose-400",
                        )}
                      >
                        {formatCurrency(s.netPnl)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Crown className="size-4 text-primary" />
              Top users by GGR contribution
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              The 50 users that have made us the most money over their
              lifetime. Click through to the user detail for the full breakdown.
            </p>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[60px]">Rank</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead className="text-right">GGR contribution</TableHead>
                  <TableHead className="text-right">Deposits</TableHead>
                  <TableHead className="text-right">Net P&L</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.topUsers.map((u, i) => (
                  <TableRow key={u.userId}>
                    <TableCell className="tabular-nums text-muted-foreground">
                      #{i + 1}
                    </TableCell>
                    <TableCell className="font-medium">
                      <Link href={`/users/${u.userId}`} className="hover:underline">
                        {u.username ?? u.userId.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right tabular-nums",
                        u.ggr >= 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-rose-600 dark:text-rose-400",
                      )}
                    >
                      {formatCurrency(u.ggr)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                      {formatCurrency(u.deposits)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right tabular-nums",
                        u.netPnl >= 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-rose-600 dark:text-rose-400",
                      )}
                    >
                      {formatCurrency(u.netPnl)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </FadeIn>
  );
}

function Intro({ segmentBy }: { segmentBy: LtvSegmentKey }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
      <div className="rounded-md bg-primary/10 p-1.5">
        <TrendingUp className="size-4 text-primary" />
      </div>
      <div className="text-sm">
        <h3 className="font-semibold">Lifetime Value</h3>
        <p className="text-muted-foreground">
          Each user&apos;s ledger-lifetime GGR contribution, deposits, wager,
          bonus drag, and net house P&amp;L —{" "}
          {segmentBy === "percentile"
            ? "rolled up into percentile segments"
            : "split by signup source"}
          . Bonus drag is rewards / payouts the user redeemed (rose, costs to
          house).
        </p>
      </div>
    </div>
  );
}

function SegmentToggle({ current }: { current: LtvSegmentKey }) {
  const options: { value: LtvSegmentKey; label: string }[] = [
    { value: "percentile", label: "By percentile" },
    { value: "source", label: "By source" },
  ];
  return (
    <div className="flex gap-1 rounded-md border bg-muted/40 p-1 self-start w-fit">
      {options.map(({ value, label }) => (
        <Link
          key={value}
          href={`?tab=ltv&ltvBy=${value}`}
          replace
          prefetch={false}
          className={cn(
            "rounded-sm px-3 py-1 text-xs font-medium transition-colors",
            current === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </Link>
      ))}
    </div>
  );
}
