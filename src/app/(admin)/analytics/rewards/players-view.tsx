import Link from "next/link";
import {
  Trophy,
  TrendingDown,
  Users,
  Scale,
  Layers,
  ArrowUpRight,
} from "lucide-react";
import { SectionHeading, KpiTile, TILE_COLORS } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import {
  getRewardProgramRecipients,
  RECIPIENT_PROGRAM_KEYS,
  type RewardRecipientRow,
  type RecipientProgramKey,
} from "@/lib/queries/insights-rewards/program-recipients";
import { REWARD_PROGRAM_LABELS } from "@/lib/queries/insights-rewards/program-spend";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { PROGRAM_META, MONEY_OUT } from "./program-meta";

/**
 * Rewards → Players. Who the budget actually reaches, and whether it came
 * back.
 *
 * Per player: reward received (split by program), their gameplay GGR over the
 * same window, and the net. House-POV — reward paid is rose; net is emerald
 * when the house is still ahead on that player after what we gave them, rose
 * when it isn't. That net is the whole point of the view: a big reward number
 * next to a bigger GGR number is a good outcome, not a problem.
 *
 * The ranking is ledger-backed programs only; daily-pack giveaway value and
 * the creator tips/sponsor pool are stated as excluded rather than quietly
 * folded in (see `program-recipients.ts`).
 */
export async function RewardsPlayersView({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data: rows, error } = await safeQuery(
    () => getRewardProgramRecipients(period),
    [] as RewardRecipientRow[],
    "analytics.rewards.recipients",
    REWARD_QUERY_TIMEOUT_MS,
  );

  if (error) {
    return (
      <TileErrorFallback
        label="Reward recipients"
        hint="The recipients query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }

  const label = insightsRewardsPeriodLabel(period);

  if (!rows || rows.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Trophy}
          title={`No reward recipients in ${label.toLowerCase()}`}
          description="No player received a reward payout in this window. Try a longer period."
          compact
        />
      </div>
    );
  }

  const totalPaid = rows.reduce((a, r) => a + r.total, 0);
  const totalGgr = rows.reduce((a, r) => a + r.ggrInWindow, 0);
  const net = totalGgr - totalPaid;
  const netIsHouseAhead = net >= 0;
  const houseAheadCount = rows.filter((r) => r.netToHouse >= 0).length;
  const maxTotal = rows[0]?.total ?? 0;

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            label="Paid to top 25"
            value={formatCurrency(totalPaid)}
            sub={label}
            icon={TrendingDown}
            accent="rose"
          />
          <KpiTile
            label="Their GGR"
            value={formatCurrency(totalGgr)}
            sub="Same window, same players"
            icon={Scale}
            accent="emerald"
          />
          <KpiTile
            label="Net to house"
            value={`${netIsHouseAhead ? "+" : "−"}${formatCurrency(Math.abs(net))}`}
            sub={netIsHouseAhead ? "Ahead after rewards" : "Behind after rewards"}
            icon={netIsHouseAhead ? Scale : TrendingDown}
            accent={netIsHouseAhead ? "emerald" : "rose"}
          />
          <KpiTile
            label="Profitable players"
            value={`${houseAheadCount} / ${rows.length}`}
            sub="GGR above what we paid them"
            icon={Users}
            accent="blue"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <section className="space-y-3">
          <SectionHeading
            icon={Trophy}
            title="Top reward recipients"
            action={
              <span className="text-xs text-muted-foreground">
                Ledger programs only — daily packs &amp; creator pool excluded
              </span>
            }
          />
          <ProgramSplitLegend />
          <div className="overflow-hidden rounded-2xl border bg-card">
            {/* Desktop header. The mobile layout drops it — each card
                labels its own fields instead. */}
            <div className="hidden items-center gap-3 border-b bg-muted/30 px-4 py-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground lg:flex">
              <span className="w-8 shrink-0">#</span>
              <span className="min-w-0 flex-1">Player</span>
              <span className="w-28 shrink-0 text-right">Reward paid</span>
              <span className="w-40 shrink-0">Program split</span>
              <span className="w-28 shrink-0 text-right">Their GGR</span>
              <span className="w-28 shrink-0 text-right">Net to house</span>
            </div>
            <ul className="divide-y">
              {rows.map((row, i) => (
                <RecipientRow
                  key={row.userId}
                  row={row}
                  rank={i + 1}
                  maxTotal={maxTotal}
                />
              ))}
            </ul>
          </div>
        </section>
      </FadeIn>
    </div>
  );
}

function RecipientRow({
  row,
  rank,
  maxTotal,
}: {
  row: RewardRecipientRow;
  rank: number;
  maxTotal: number;
}) {
  const houseAhead = row.netToHouse >= 0;
  const money = (v: number) => formatCurrency(Math.abs(v));

  return (
    <li>
      <Link
        href={`/users/${row.userId}`}
        className="flex flex-col gap-2.5 px-4 py-3 transition-colors hover:bg-muted/40 lg:flex-row lg:items-center lg:gap-3"
      >
        <span className="hidden w-8 shrink-0 text-sm tabular-nums text-muted-foreground lg:block">
          {rank}
        </span>

        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="text-sm tabular-nums text-muted-foreground lg:hidden">
            {rank}.
          </span>
          <span className="truncate text-sm font-medium">
            {row.username ?? "—"}
          </span>
          <span className="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
            {row.programCount} program{row.programCount === 1 ? "" : "s"}
          </span>
          <ArrowUpRight className="size-3 shrink-0 text-muted-foreground/50" />
        </div>

        {/* Amounts. On phones these stack into a labelled 3-up row so the
            numbers keep their meaning without the desktop header. */}
        <div className="grid grid-cols-3 gap-2 lg:hidden">
          <MobileFigure
            label="Paid"
            value={formatCurrency(row.total)}
            className={MONEY_OUT}
          />
          <MobileFigure label="Their GGR" value={formatCurrency(row.ggrInWindow)} />
          <MobileFigure
            label="Net"
            value={`${houseAhead ? "+" : "−"}${money(row.netToHouse)}`}
            className={
              houseAhead
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400"
            }
          />
        </div>

        <span
          className={cn(
            "hidden w-28 shrink-0 text-right text-sm font-semibold tabular-nums lg:block",
            MONEY_OUT,
          )}
        >
          {formatCurrency(row.total)}
        </span>

        <div className="w-full lg:w-40 lg:shrink-0">
          <ProgramSplitBar
            perProgram={row.perProgram}
            total={row.total}
            widthScale={maxTotal > 0 ? row.total / maxTotal : 0}
          />
        </div>

        <span className="hidden w-28 shrink-0 text-right text-sm tabular-nums lg:block">
          {formatCurrency(row.ggrInWindow)}
        </span>

        <span
          className={cn(
            "hidden w-28 shrink-0 text-right text-sm font-semibold tabular-nums lg:block",
            houseAhead
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400",
          )}
        >
          {houseAhead ? "+" : "−"}
          {money(row.netToHouse)}
        </span>
      </Link>
    </li>
  );
}

function MobileFigure({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="rounded-lg border bg-muted/20 px-2 py-1.5">
      <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </p>
      <p className={cn("mt-0.5 text-xs font-semibold tabular-nums", className)}>
        {value}
      </p>
    </div>
  );
}

/**
 * Stacked segment bar showing WHICH programs a player's reward total came
 * from. The bar's overall width is scaled to the top recipient, so rank and
 * composition read at once; the segments inside are proportional to that
 * player's own split.
 */
function ProgramSplitBar({
  perProgram,
  total,
  widthScale,
}: {
  perProgram: Record<RecipientProgramKey, number>;
  total: number;
  widthScale: number;
}) {
  const segments = RECIPIENT_PROGRAM_KEYS.filter(
    (k) => perProgram[k] > 0,
  ).sort((a, b) => perProgram[b] - perProgram[a]);

  return (
    <div className="flex items-center gap-2">
      <div
        className="flex h-2 overflow-hidden rounded-full bg-muted"
        style={{ width: `${Math.max(6, widthScale * 100)}%` }}
      >
        {segments.map((key) => (
          <span
            key={key}
            title={`${REWARD_PROGRAM_LABELS[key]}: ${formatCurrency(perProgram[key])}`}
            style={{
              width: `${total > 0 ? (perProgram[key] / total) * 100 : 0}%`,
              backgroundColor: PROGRAM_META[key].chartColor,
            }}
          />
        ))}
      </div>
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground lg:hidden">
        {formatNumber(segments.length)}
      </span>
    </div>
  );
}

/** Legend so the split-bar colours mean something. Rendered once, above the list. */
function ProgramSplitLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Layers className="size-3" />
        Programs
      </span>
      {RECIPIENT_PROGRAM_KEYS.map((key) => (
        <span
          key={key}
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
        >
          <span
            className="size-2 rounded-full"
            style={{ backgroundColor: PROGRAM_META[key].chartColor }}
          />
          <span className={cn(TILE_COLORS[PROGRAM_META[key].accent].text)}>
            {REWARD_PROGRAM_LABELS[key]}
          </span>
        </span>
      ))}
    </div>
  );
}
