import Link from "next/link";
import { Package, Swords } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { FadeIn } from "@/components/fade-in";
import { cn } from "@/lib/utils";
import {
  getPackProfitability,
  type PacksPeriod,
} from "@/lib/queries/analytics-packs";
import { getPackAndBattleStats } from "@/lib/queries/analytics";
import { BattleModesSection, PackPopularitySection } from "./sections";
import type { AnalyticsPeriod } from "./types";

type SortKey = "revenue" | "margin" | "margin_pct" | "opens";

function parseSort(v: string | undefined): SortKey {
  switch (v) {
    case "margin":
    case "margin_pct":
    case "opens":
      return v;
    default:
      return "revenue";
  }
}

/**
 * Pack & battle tab — hosts the battle-mode and pack-popularity
 * breakdowns at the top, followed by the profitability deep-dive: two
 * sortable tables (packs / solo openings and battle-packs) with opens,
 * gross revenue, payouts (card sales), gross margin, margin %. Sort key
 * persists via `?packsSort=…`.
 */
export async function PacksBattlesTab({
  period: heroPeriod,
  sortKey,
}: {
  period: AnalyticsPeriod;
  sortKey: string | undefined;
}) {
  const period: PacksPeriod =
    heroPeriod === "today"
      ? "7d"
      : heroPeriod === "7d" ||
          heroPeriod === "30d" ||
          heroPeriod === "90d" ||
          heroPeriod === "all"
        ? heroPeriod
        : "30d";

  const sort = parseSort(sortKey);
  // `getPackProfitability` powers the profitability tables below; the
  // battle-mode / pack-popularity breakdowns at the top of this tab are
  // sourced from the slim `getPackAndBattleStats` helper. Previously
  // this called the full `getAnalyticsData(heroPeriod)` bundle (11
  // raws — incl. PERCENTILE_CONT median, multi-day GROUP BY revenue,
  // visitors count, etc.) purely to consume two of its return fields.
  // Slim variant runs the 6 raws that actually feed those two
  // sections, dropping the rest entirely.
  const [data, overview] = await Promise.all([
    getPackProfitability(period),
    getPackAndBattleStats(heroPeriod),
  ]);
  const sortFn = (a: {
    revenue: number;
    grossMargin: number;
    marginPct: number;
    opens?: number;
    battlesPlayed?: number;
  },
  b: {
    revenue: number;
    grossMargin: number;
    marginPct: number;
    opens?: number;
    battlesPlayed?: number;
  }): number => {
    if (sort === "margin") return b.grossMargin - a.grossMargin;
    if (sort === "margin_pct") return b.marginPct - a.marginPct;
    if (sort === "opens") {
      return (b.opens ?? b.battlesPlayed ?? 0) - (a.opens ?? a.battlesPlayed ?? 0);
    }
    return b.revenue - a.revenue;
  };
  const sortedPacks = [...data.packs].sort(sortFn);
  const sortedBattles = [...data.battles].sort(sortFn);

  return (
    <FadeIn>
      <div className="space-y-4">
        <div className="space-y-4">
          <BattleModesSection stats={overview.battleStats} />
          <PackPopularitySection stats={overview.packStats} />
        </div>

        <div className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
          <div className="rounded-md bg-primary/10 p-1.5">
            <Package className="size-4 text-primary" />
          </div>
          <div className="text-sm">
            <h3 className="font-semibold">Pack &amp; battle profitability</h3>
            <p className="text-muted-foreground">
              Per-pack revenue, payouts (card sales from obtained inventory),
              gross margin (revenue − payouts), and margin %. Battles view
              treats each pack as a line-item in the battles that included
              it. Click a column to re-sort.
            </p>
          </div>
        </div>

        <div className="flex justify-end">
          <SortControl active={sort} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Package className="size-4 text-primary" />
              Top 20 packs (solo openings) — {periodLabel(period)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <PacksTable rows={sortedPacks} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Swords className="size-4 text-primary" />
              Top 20 battle-packs — {periodLabel(period)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <BattlePacksTable rows={sortedBattles} />
          </CardContent>
        </Card>
      </div>
    </FadeIn>
  );
}

function periodLabel(p: PacksPeriod): string {
  switch (p) {
    case "7d":
      return "Last 7 days";
    case "30d":
      return "Last 30 days";
    case "90d":
      return "Last 90 days";
    case "all":
      return "All time";
  }
}

function SortControl({ active }: { active: SortKey }) {
  const opts: { value: SortKey; label: string }[] = [
    { value: "revenue", label: "Revenue" },
    { value: "margin", label: "Gross Margin" },
    { value: "margin_pct", label: "Margin %" },
    { value: "opens", label: "Volume" },
  ];
  return (
    <div className="flex flex-wrap gap-1 rounded-md border bg-muted/40 p-0.5">
      <span className="px-2 py-0.5 text-xs text-muted-foreground">Sort by:</span>
      {opts.map(({ value, label }) => (
        <Link
          key={value}
          href={`?tab=packs&packsSort=${value}`}
          replace
          prefetch={false}
          className={cn(
            "rounded-sm px-2 py-0.5 text-xs font-medium transition-colors",
            active === value
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

function PacksTable({
  rows,
}: {
  rows: Awaited<ReturnType<typeof getPackProfitability>>["packs"];
}) {
  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No pack data for the selected window.
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Pack</TableHead>
          <TableHead className="text-right">Opens</TableHead>
          <TableHead className="text-right">Revenue</TableHead>
          <TableHead className="text-right">Payouts</TableHead>
          <TableHead className="text-right">Gross Margin</TableHead>
          <TableHead className="text-right">Margin %</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="font-medium">{r.name}</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatNumber(r.opens)}
            </TableCell>
            <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
              {formatCurrency(r.revenue)}
            </TableCell>
            <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(r.payouts)}
            </TableCell>
            <TableCell
              className={cn(
                "text-right tabular-nums font-semibold",
                r.grossMargin > 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : r.grossMargin < 0
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-muted-foreground",
              )}
            >
              {formatCurrency(r.grossMargin)}
            </TableCell>
            <TableCell
              className={cn(
                "text-right tabular-nums",
                r.marginPct > 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : r.marginPct < 0
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-muted-foreground",
              )}
            >
              {(r.marginPct * 100).toFixed(1)}%
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function BattlePacksTable({
  rows,
}: {
  rows: Awaited<ReturnType<typeof getPackProfitability>>["battles"];
}) {
  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No battle-pack data for the selected window.
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Pack</TableHead>
          <TableHead className="text-right">Battles</TableHead>
          <TableHead className="text-right">Revenue</TableHead>
          <TableHead className="text-right">Payouts</TableHead>
          <TableHead className="text-right">Gross Margin</TableHead>
          <TableHead className="text-right">Margin %</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="font-medium">{r.name}</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatNumber(r.battlesPlayed)}
            </TableCell>
            <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
              {formatCurrency(r.revenue)}
            </TableCell>
            <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(r.payouts)}
            </TableCell>
            <TableCell
              className={cn(
                "text-right tabular-nums font-semibold",
                r.grossMargin > 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : r.grossMargin < 0
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-muted-foreground",
              )}
            >
              {formatCurrency(r.grossMargin)}
            </TableCell>
            <TableCell
              className={cn(
                "text-right tabular-nums",
                r.marginPct > 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : r.marginPct < 0
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-muted-foreground",
              )}
            >
              {(r.marginPct * 100).toFixed(1)}%
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
