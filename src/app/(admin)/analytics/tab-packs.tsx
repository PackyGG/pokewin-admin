import Link from "next/link";
import { ArrowRight, Flame, Package, Swords } from "lucide-react";
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
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { FadeIn } from "@/components/fade-in";
import { CardImage } from "@/components/card-image";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import {
  getPackProfitability,
  getTopOpenedPacks24h,
  type PacksPeriod,
  type TopPack24hRow,
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
  view = "both",
}: {
  period: AnalyticsPeriod;
  sortKey: string | undefined;
  /**
   * Which half to render. The Games tab shows packs and battles as separate
   * sub-views (owner, 2026-07-23) — the reads are shared, so this filters the
   * RENDER, not the queries. "both" keeps the original combined layout for
   * any caller that still wants it.
   */
  view?: "packs" | "battles" | "both";
}) {
  const showPacks = view !== "battles";
  const showBattles = view !== "packs";
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
  // Each leg degrades independently via safeQuery — a single failed
  // scan turns its own section into a panel fallback instead of taking
  // the whole tab down through the route error boundary.
  const [profitabilityResult, overviewResult, topPacks24hResult] =
    await Promise.all([
      safeQuery(
        () => getPackProfitability(period),
        null,
        "analytics.packs.profitability",
        REWARD_QUERY_TIMEOUT_MS,
      ),
      safeQuery(
        () => getPackAndBattleStats(heroPeriod),
        null,
        "analytics.packs.overview",
        REWARD_QUERY_TIMEOUT_MS,
      ),
      safeQuery(
        () => getTopOpenedPacks24h(10),
        null,
        "analytics.packs.top24h",
        REWARD_QUERY_TIMEOUT_MS,
      ),
    ]);
  const data = profitabilityResult.data;
  const overview = overviewResult.data;
  const topPacks24h = topPacks24hResult.data;

  // own surface flag is in `comparison` mode; never awaited, swallows its own
  // errors, and never affects the rendered Postgres payload.
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
  const sortedPacks = data ? [...data.packs].sort(sortFn) : null;
  const sortedBattles = data ? [...data.battles].sort(sortFn) : null;

  return (
    <FadeIn>
      <div className="space-y-4">
        {!showPacks ? null : topPacks24hResult.error || !topPacks24h ? (
          <TileErrorFallback
            label="Top packs — last 24h"
            hint="The 24h pack-opens query failed — other sections still rendered. Refresh to retry."
            size="panel"
          />
        ) : (
          <TopPacks24hPanel rows={topPacks24h} />
        )}

        {overviewResult.error || !overview ? (
          <TileErrorFallback
            label="Battle modes & pack popularity"
            hint="The pack/battle stats query failed — other sections still rendered. Refresh to retry."
            size="panel"
          />
        ) : (
          <div className="space-y-4">
            {showBattles && <BattleModesSection stats={overview.battleStats} />}
            {showPacks && <PackPopularitySection stats={overview.packStats} />}
          </div>
        )}

        <div className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
          <div className="rounded-md bg-primary/10 p-1.5">
            <Package className="size-4 text-primary" />
          </div>
          <div className="text-sm">
            <h3 className="font-semibold">Pack &amp; battle profitability</h3>
            <p className="text-muted-foreground">
              Per-pack revenue (wager paid), payouts (value of cards won from
              the pack), gross margin (revenue − payouts, house POV), and
              margin %. Battles view splits each battle&apos;s stake and won
              value evenly across its packs. Real customers only; borrow plays
              excluded. Click a column to re-sort.
            </p>
          </div>
        </div>

        <div className="flex justify-end">
          <SortControl active={sort} />
        </div>

        {showPacks && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Package className="size-4 text-primary" />
              Top 20 packs (solo openings) — {periodLabel(period)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {profitabilityResult.error || !sortedPacks ? (
              <TileErrorFallback
                label="Pack profitability"
                hint="The profitability query failed — refresh to retry."
                size="panel"
              />
            ) : (
              <PacksTable rows={sortedPacks} />
            )}
          </CardContent>
        </Card>
        )}

        {showBattles && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Swords className="size-4 text-primary" />
              Top 20 battle-packs — {periodLabel(period)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {profitabilityResult.error || !sortedBattles ? (
              <TileErrorFallback
                label="Battle-pack profitability"
                hint="The profitability query failed — refresh to retry."
                size="panel"
              />
            ) : (
              <BattlePacksTable rows={sortedBattles} />
            )}
          </CardContent>
        </Card>
        )}
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
      <EmptyState
        icon={Package}
        title="No pack data"
        description="No solo pack openings in the selected window. Try a longer period."
        compact
      />
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
      <EmptyState
        icon={Swords}
        title="No battle-pack data"
        description="No packs were played inside battles in the selected window. Try a longer period."
        compact
      />
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

// ── Top Packs (last 24h) ────────────────────────────────────────────
//
// Rolling-24h leaderboard of most-opened packs with exact open count
// + pack name (and avatar where the pack has an image_url). Period
// filter at the top of the page is intentionally ignored — this panel
// answers "what's hot RIGHT NOW" and pairing it with a 90d window
// would dilute the signal. Lives on this tab (was on Overview) so
// pack-related signals are grouped together.
function TopPacks24hPanel({ rows }: { rows: TopPack24hRow[] }) {
  const totalOpens = rows.reduce((sum, r) => sum + r.opens, 0);
  const topOpens = rows[0]?.opens ?? 0;

  return (
    <div className="rounded-2xl border bg-card p-4 sm:p-5">
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-orange-500/10">
            <Flame className="size-4 text-orange-500" />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-semibold leading-tight">
              Top packs — last 24h
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Most-opened packs in the rolling last 24 hours. Real users
              only.
            </p>
          </div>
        </div>
        <div className="shrink-0 rounded-lg border bg-muted/30 px-3 py-1.5 sm:text-right">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Total opens
          </p>
          <p className="text-base font-bold tabular-nums text-foreground">
            {formatNumber(totalOpens)}
          </p>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Flame}
          title="No pack opens in the last 24 hours"
          description="Real-user pack openings from the rolling 24h window will appear here as they happen."
          compact
        />
      ) : (
        <div className="divide-y rounded-xl border">
          {rows.map((r, idx) => (
            <TopPackRow key={r.id} row={r} rank={idx + 1} topOpens={topOpens} />
          ))}
        </div>
      )}
    </div>
  );
}

function TopPackRow({
  row,
  rank,
  topOpens,
}: {
  row: TopPack24hRow;
  rank: number;
  topOpens: number;
}) {
  // Inline progress bar — width relative to the #1 pack so the
  // distribution is readable at a glance without forcing every row to
  // be 100%.
  const widthPct = topOpens > 0 ? (row.opens / topOpens) * 100 : 0;
  return (
    <Link
      href={`/packs/${row.id}`}
      className="group flex items-center justify-between gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40 sm:px-4"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="w-6 shrink-0 text-center text-xs font-semibold tabular-nums text-muted-foreground">
          {rank}
        </span>
        <CardImage
          src={row.imageUrl}
          alt=""
          className="size-9 shrink-0 rounded-lg"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium leading-tight">
            {row.name}
          </p>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-sm bg-muted/60">
            <div
              className="h-full rounded-sm bg-orange-500/70 transition-[width] motion-safe:duration-500"
              style={{ width: `${widthPct}%` }}
            />
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <p className="text-sm font-semibold tabular-nums sm:text-base">
          {formatNumber(row.opens)}
        </p>
        <ArrowRight className="size-4 text-muted-foreground opacity-50 transition-opacity group-hover:opacity-100" />
      </div>
    </Link>
  );
}
