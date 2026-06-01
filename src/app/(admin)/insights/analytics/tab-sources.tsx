import Link from "next/link";
import { Network } from "lucide-react";
import { FadeIn } from "@/components/fade-in";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  getSourcesBuckets,
  getSourcesCodes,
  parseSourcesSubTab,
  type SourcesSubTab,
} from "@/lib/queries/insights-analytics/sources";
import { EmptyState } from "@/components/empty-state";
import {
  INSIGHTS_PERIOD_LABELS,
  type InsightsPeriod,
} from "./types";

/**
 * Sources tab — signup source breakdown. Two views:
 *   • Buckets — 3 buckets (organic / creator-affiliate / regular)
 *   • Codes   — per affiliate-code performance
 */
export async function SourcesInsightsTab({
  period,
  subTab,
}: {
  period: InsightsPeriod;
  subTab: string | undefined;
}) {
  const view = parseSourcesSubTab(subTab);

  return (
    <FadeIn>
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
          <div className="rounded-md bg-primary/10 p-1.5">
            <Network className="size-4 text-primary" />
          </div>
          <div className="text-sm">
            <h3 className="font-semibold">Signup sources</h3>
            <p className="text-muted-foreground">
              Where users come from and how they perform. Period:{" "}
              {INSIGHTS_PERIOD_LABELS[period].toLowerCase()}. Signup
              source is fixed at signup; the ledger metrics scope to the
              period.
            </p>
          </div>
        </div>

        <SubTabToggle current={view} />

        {view === "buckets" ? (
          <BucketsView period={period} />
        ) : (
          <CodesView period={period} />
        )}
      </div>
    </FadeIn>
  );
}

async function BucketsView({ period }: { period: InsightsPeriod }) {
  const rows = await getSourcesBuckets(period);
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Network}
        title="No signups"
        description="No users signed up in the selected period."
      />
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">By source bucket</CardTitle>
        <p className="text-xs text-muted-foreground">
          Cohort metrics per signup source. Conversion % = first-deposit /
          signups. House POV: positive GGR driven = emerald.
        </p>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead className="text-right">Signups</TableHead>
              <TableHead className="text-right">FTD %</TableHead>
              <TableHead className="text-right">Wager %</TableHead>
              <TableHead className="text-right">MAW %</TableHead>
              <TableHead className="text-right">Deposits</TableHead>
              <TableHead className="text-right">Wager</TableHead>
              <TableHead className="text-right">GGR driven</TableHead>
              <TableHead className="text-right">Avg GGR/user</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell className="font-medium">{r.label}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(r.signups)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.signups > 0 ? `${((r.firstDeposit / r.signups) * 100).toFixed(1)}%` : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.signups > 0 ? `${((r.firstWager / r.signups) * 100).toFixed(1)}%` : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.signups > 0 ? `${((r.maw / r.signups) * 100).toFixed(1)}%` : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatCurrency(r.depositsDriven)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatCurrency(r.wagerDriven)}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right tabular-nums",
                    r.ggrDriven >= 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-rose-600 dark:text-rose-400",
                  )}
                >
                  {formatCurrency(r.ggrDriven)}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right tabular-nums",
                    r.avgGgr >= 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-rose-600 dark:text-rose-400",
                  )}
                >
                  {formatCurrency(r.avgGgr)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

async function CodesView({ period }: { period: InsightsPeriod }) {
  const rows = await getSourcesCodes(period);
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Network}
        title="No code attribution"
        description="No users signed up under an affiliate code in the selected period."
      />
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Top 25 affiliate codes</CardTitle>
        <p className="text-xs text-muted-foreground">
          Codes ranked by signups in the period. FTD% = fraction of
          new signups that made at least one deposit.
        </p>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead className="text-right">Signups</TableHead>
              <TableHead className="text-right">FTD %</TableHead>
              <TableHead className="text-right">Wager</TableHead>
              <TableHead className="text-right">GGR driven</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.code}>
                <TableCell className="font-medium">
                  {r.affiliateUserId ? (
                    <Link
                      href={`/creators/${r.affiliateUserId}`}
                      className="hover:underline"
                    >
                      {r.code}
                    </Link>
                  ) : (
                    r.code
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(r.signups)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.signups > 0 ? `${((r.firstDeposit / r.signups) * 100).toFixed(1)}%` : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatCurrency(r.wagerDriven)}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right tabular-nums",
                    r.ggrDriven >= 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-rose-600 dark:text-rose-400",
                  )}
                >
                  {formatCurrency(r.ggrDriven)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function SubTabToggle({ current }: { current: SourcesSubTab }) {
  const options: { value: SourcesSubTab; label: string }[] = [
    { value: "buckets", label: "Buckets" },
    { value: "codes", label: "Codes" },
  ];
  return (
    <div className="flex gap-1 rounded-md border bg-muted/40 p-1 self-start w-fit">
      {options.map(({ value, label }) => (
        <Link
          key={value}
          href={`?tab=sources&sourcesBy=${value}`}
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
