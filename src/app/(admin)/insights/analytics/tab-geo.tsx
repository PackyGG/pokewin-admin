import Link from "next/link";
import { Globe } from "lucide-react";
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
  getInsightsGeo,
  parseGeoGroupBy,
  type GeoGroupBy,
} from "@/lib/queries/insights-analytics/geo";
import { EmptyState } from "@/components/empty-state";
import {
  INSIGHTS_PERIOD_LABELS,
  type InsightsPeriod,
} from "./types";

/**
 * Geo tab — country / continent / US-state breakdown.
 *
 * Period scopes the deposits / wager / GGR / withdrawals columns. The
 * `users` column is always lifetime (so admins can see "we have N
 * users in this region" alongside "they wagered $X in the period").
 */
export async function GeoInsightsTab({
  period,
  groupBy,
}: {
  period: InsightsPeriod;
  groupBy: string | undefined;
}) {
  const gb = parseGeoGroupBy(groupBy);
  const data = await getInsightsGeo(period, gb);

  return (
    <FadeIn>
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
          <div className="rounded-md bg-primary/10 p-1.5">
            <Globe className="size-4 text-primary" />
          </div>
          <div className="text-sm">
            <h3 className="font-semibold">Geographic breakdown</h3>
            <p className="text-muted-foreground">
              Users + deposits + wager + GGR per location for{" "}
              {INSIGHTS_PERIOD_LABELS[period].toLowerCase()}. House POV:
              positive GGR = emerald, negative = rose. The Users column is
              lifetime; everything else is windowed.
            </p>
          </div>
        </div>

        <GroupByToggle current={gb} />

        {data.rows.length === 0 ? (
          <EmptyState
            icon={Globe}
            title="No geo data"
            description="No users matched the current grouping in the selected period."
          />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">By {gb}</CardTitle>
              <p className="text-xs text-muted-foreground">
                Sorted by GGR (house gain). Click a row to drill into the
                /users list filtered by location later — TODO.
              </p>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Location</TableHead>
                    <TableHead className="text-right">Users (lifetime)</TableHead>
                    <TableHead className="text-right">Signups (period)</TableHead>
                    <TableHead className="text-right">Deposits</TableHead>
                    <TableHead className="text-right">Withdrawals</TableHead>
                    <TableHead className="text-right">Wager</TableHead>
                    <TableHead className="text-right">GGR</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((r) => (
                    <TableRow key={r.key}>
                      <TableCell className="font-medium">
                        {r.countryCode && gb !== "continent" && (
                          <span className="mr-2 text-xs text-muted-foreground">
                            {r.countryCode}
                          </span>
                        )}
                        {r.label}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(r.users)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-blue-600 dark:text-blue-400">
                        {formatNumber(r.signups)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(r.deposits)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCurrency(r.withdrawals)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(r.wager)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular-nums",
                          r.ggr >= 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-rose-600 dark:text-rose-400",
                        )}
                      >
                        {formatCurrency(r.ggr)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </FadeIn>
  );
}

function GroupByToggle({ current }: { current: GeoGroupBy }) {
  const options: { value: GeoGroupBy; label: string }[] = [
    { value: "country", label: "Country" },
    { value: "continent", label: "Continent" },
    { value: "state", label: "US State" },
  ];
  return (
    <div className="flex gap-1 rounded-md border bg-muted/40 p-1 self-start w-fit">
      {options.map(({ value, label }) => (
        <Link
          key={value}
          href={`?tab=geo&geoBy=${value}`}
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
