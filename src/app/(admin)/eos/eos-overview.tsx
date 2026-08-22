import { BarChart3, ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  EosTestOverview,
  EosTestOverviewPeriod,
} from "@/lib/antifraud/eos-test-config-api";
import { cn } from "@/lib/utils";

const PERIOD_LABELS: Record<EosTestOverviewPeriod["period"], string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

function formatAmount(value: number) {
  const normalized = Object.is(value, -0) ? 0 : value;
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    signDisplay: "exceptZero",
  }).format(normalized)} real`;
}

function formatRate(part: number, total: number) {
  if (total === 0) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(part / total);
}

function ImpactValue({ value }: { value: number }) {
  return (
    <span className={cn(
      "font-semibold tabular-nums",
      value > 0 && "text-emerald-600 dark:text-emerald-400",
      value < 0 && "text-destructive",
    )}>
      {formatAmount(value)}
    </span>
  );
}

export function EosOverview({ overview }: { overview: EosTestOverview | null }) {
  if (!overview) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border bg-card p-6 text-center">
        <ShieldAlert className="size-6 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <p className="font-medium">Results are temporarily unavailable</p>
        <p className="max-w-md text-sm text-muted-foreground">
          Controls remain connected. Reload the page to retry the report.
        </p>
      </div>
    );
  }

  const rows = (["24h", "7d", "30d"] as const).map((period) =>
    overview.periods.find((entry) => entry.currency === "real" && entry.period === period)
  ).filter((row): row is EosTestOverviewPeriod => row !== undefined);
  const trackingDate = overview.trackingStartedAt
    ? new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Europe/Berlin",
    }).format(new Date(overview.trackingStartedAt))
    : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-1 rounded-lg bg-muted/30 px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between">
        <span className="text-muted-foreground">
          Estimated creator-side impact compared with the original random EOS block.
        </span>
        <span className="shrink-0 text-muted-foreground">
          {trackingDate ? `Since ${trackingDate}` : "Waiting for tracked battles"} · 30-day retention
        </span>
      </div>

      {rows.length === 0 || rows.every((row) => row.steeredBattles === 0) ? (
        <div className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-xl border bg-card p-6 text-center">
          <BarChart3 className="size-6 text-muted-foreground" aria-hidden="true" />
          <p className="font-medium">No controlled real-balance battles yet</p>
          <p className="text-sm text-muted-foreground">
            Results appear after an enabled global or personal control selects an outcome.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Period</TableHead>
                <TableHead className="text-right">Controlled</TableHead>
                <TableHead className="text-right">Control impact</TableHead>
                <TableHead className="text-right">Selected P&amp;L</TableHead>
                <TableHead className="text-right">Random baseline</TableHead>
                <TableHead className="text-right">Loss rate</TableHead>
                <TableHead className="text-right">Wins avoided</TableHead>
                <TableHead className="text-right">Fallbacks</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.period}>
                  <TableCell className="font-medium">{PERIOD_LABELS[row.period]}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {row.steeredBattles}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      / {row.battleCount}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <ImpactValue value={row.estimatedCreatorProfitReduction} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatAmount(row.selectedCreatorProfitLoss)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatAmount(row.randomBaselineCreatorProfitLoss)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatRate(row.selectedLosses, row.steeredBattles)}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {row.creatorWinsAvoided}
                  </TableCell>
                  <TableCell className="text-right">
                    {row.fallbackBattles > 0 ? (
                      <Badge className="border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                        {row.fallbackBattles}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="px-1 text-xs text-muted-foreground">
        Control impact is an estimate, not booked house revenue. It excludes opponent transfers and refunds.
      </p>
    </div>
  );
}
