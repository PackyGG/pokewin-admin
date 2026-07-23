import { Suspense } from "react";
import Link from "next/link";
import {
  TrendingDown,
  TrendingUp,
  Coins,
  Scale,
  Package,
  Gift,
  ArrowUpFromLine,
  Ticket,
  AlertCircle,
  ArrowDownToLine,
  Trophy,
  ListOrdered,
  Activity,
  Users,
  Wallet,
  PiggyBank,
  Layers,
  HandCoins,
  type LucideIcon,
} from "lucide-react";
import {
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { ExportButton } from "@/components/export-button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SkeletonText } from "@/components/ux";
import { SectionHeadingSkeleton } from "@/components/loading-skeletons";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  parseInsightsPeriod,
  INSIGHTS_PERIOD_LABELS,
  type InsightsPeriod,
} from "@/lib/queries/insights-analytics/period";
import {
  getCostBreakdownCached,
  type CostLine,
  type CostBreakdown,
} from "@/lib/queries/insights-analytics/cost-breakdown";
import {
  getRealizedPnlSnapshot,
  type RealizedPnlSnapshot,
} from "@/lib/queries/_realized-pnl";
import { compareCostBreakdown } from "@/lib/clickhouse/compare/insights-cost-breakdown";
import { CostTrendChart } from "../insights/cost-breakdown/trend-chart";
import { WaterfallRow, WaterfallBand } from "../insights/cost-breakdown/waterfall-row";
import {
  MetricInfoPopover,
  InfoRow,
  InfoTotal,
  ValueChip,
} from "../insights/cost-breakdown/_components";
// SEMANTIC_TONES is imported from the DIRECTIVE-FREE `./tones` module (not
// `./_components`, which is "use client"). This page is a Server Component
// and reads `SEMANTIC_TONES[tone].face/.icon/…` while rendering its tiles
// and waterfall; importing that value from a "use client" module on the
// server yields a client-reference proxy whose keys are undefined, so
// `SEMANTIC_TONES[tone] ?? SEMANTIC_TONES.muted` collapses to `undefined`
// and `.face` crashes during Flight serialize. The directive-free module
// hands back the genuine object on both server and client.
import { SEMANTIC_TONES, type SemanticTone } from "../insights/cost-breakdown/tones";

/**
 * /insights/cost-breakdown — THE money-leakage page, rebuilt
 * comprehension-first.
 *
 * It answers, at a glance, the operator's recurring question — "$2.5M
 * wagered but only $17k P&L, where does the money go?" — in a strict
 * reading order:
 *
 *   0. The LIFETIME REALIZED P&L reference — the canonical balance-sheet
 *      snapshot (`getRealizedPnlSnapshot`), the SAME figure the /insights
 *      hub, /insights/real-numbers and /dashboard show. This is the real
 *      "what's our actual bottom line" answer and stays constant across
 *      the period chip. Everything below it is the PER-PERIOD breakdown.
 *   1. A plain-language STORY LEAD (the period's headline flow + biggest
 *      leak + the realized-vs-held distinction, chunked into scannable
 *      lines).
 *   2. A SUMMARY grouped into semantic sections — Incoming value → Paid
 *      back & costs → Held / unrealized → Period outcome — where the
 *      period's net result and the biggest driver stand out most.
 *   3. The WATERFALL (wager → GGR → −costs → NGR → −held → net result)
 *      as grouped bands with emphasised checkpoints, not a flat list.
 *   4. Detail rows (ranked leaks, margin health, contributors, trend)
 *      only AFTER the high-level story.
 *
 * The gaming/cost financial logic is UNCHANGED: every windowed figure
 * still comes from `getCostBreakdown` (an assembly of the canonical
 * `@/lib/metrics` layer: getWindowMetrics + sumLedgerTypes +
 * calculateWindowedPnl), so the page reconciles by construction with
 * /ggr, /dashboard and every migrated surface. GGR is the verified
 * inventory-delta model; NGR nets house-funded rewards; the contributors
 * net comes from the authoritative `balances` counters.
 *
 * IMPORTANT distinction (honest labeling): `getCostBreakdown(...).pnl`
 * (`calculateWindowedPnl`) is a per-period gaming→cash FLOW. It is the
 * right "net result" for a bounded window (7d / 30d), but on the
 * unbounded LIFETIME scan it diverges from the balance-sheet snapshot
 * above (it omits the unclaimed-rakeback liability and treats in-flight
 * withdrawals differently), so it is labeled "Net result (this period)" —
 * NOT "the bottom line". The lifetime balance-sheet snapshot is the
 * authoritative bottom line. This remake is presentation/IA + labeling
 * only; no money math changed.
 *
 * House-POV throughout (CLAUDE.md), but with a colour HIERARCHY:
 *   • base wager → blue;
 *   • money the house keeps (GGR/NGR/P&L positive) → emerald;
 *   • realized money-back (gaming payouts, rewards, shipped cards) → rose;
 *   • HELD / unrealized liability (inventory still held, unclaimed
 *     vouchers) → amber — deliberately NOT the same red as a realized
 *     loss, because it can still come back; and
 *   • the honest leftover → muted.
 */
/**
 * Cost Breakdown as an /analytics tab.
 *
 * Was `/insights/cost-breakdown` (owner, 2026-07-23). Body untouched; the
 * PageHero is gone because /analytics renders one, and the period filter +
 * export moved inline above the waterfall.
 *
 * Shell-first is preserved: the controls paint instantly from the URL — no DB
 * — and the heavy assembly (the canonical metric layer + bridge terms +
 * contributor sweep + lifetime realized-P&L snapshot, the heaviest read in
 * the app) streams behind a Suspense keyed on `period`.
 *
 * PERIOD: reads the page-level `?period=`, translated by `toInsightsPeriod`
 * (owner, 2026-07-23 — one timespan control for the whole page). It used to
 * own `?cbPeriod=` and render its own filter, because the two layers name
 * their shortest window differently (`today` vs `24h`). That difference is
 * now handled by one mapper in `analytics/types.ts` instead of a second
 * control the user had to notice.
 */
export async function CostBreakdownTab({
  period,
}: {
  period: ReturnType<typeof parseInsightsPeriod>;
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Where the wager goes — wager → net result, every leak named
        </p>
        <ExportButton page="cost-breakdown" params={{ period }} />
      </div>

      <Suspense key={period} fallback={<CostBreakdownBodySkeleton />}>
        <CostBreakdownBody period={period} />
      </Suspense>
    </div>
  );
}

/**
 * The streamed body: the two heavy reads (period cost-breakdown assembly +
 * the lifetime realized-P&L snapshot) + the fire-and-forget CQRS comparison,
 * then the full per-period story tree. Isolated behind the page's Suspense
 * boundary so the hero + controls never wait on it. Served numbers are
 * unchanged from the previous page-body implementation.
 */
async function CostBreakdownBody({
  period,
}: {
  period: InsightsPeriod;
}) {
  const periodLabel = INSIGHTS_PERIOD_LABELS[period];

  const [{ data, error }, { data: lifetimeSnapshot }] = await Promise.all([
    safeQuery(
      () => getCostBreakdownCached(period, periodLabel, 10),
      null,
      "insights.costBreakdown",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    // Lifetime realized P&L — the canonical balance-sheet snapshot
    // (deposits − withdrawals − on-site balance − inventory − unclaimed
    // vouchers/rakeback), the SAME source /insights/real-numbers, the
    // /insights hub P&L tile and the dashboard read, so the four can never
    // drift. React-cached + 5-min cached → cheap. It is NOT the windowed
    // `getCostBreakdown(...).pnl`, which is a per-period gaming→cash FLOW
    // that, on the unbounded lifetime scan, diverges from this snapshot
    // (it omits the unclaimed-rakeback liability and treats in-flight
    // withdrawals differently). Shown as the constant authoritative
    // bottom-line reference on every period. Its own leg so a snapshot
    // read failure degrades just that reference, not the whole page.
    safeQuery(
      () => getRealizedPnlSnapshot(),
      null,
      "insights.costBreakdown.lifetimePnl",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);

  // Fire-and-forget CQRS comparison (Phase 2B): no-op unless the
  // `insights_cost_breakdown` surface is in `comparison` mode. Runs the
  // ClickHouse twin on the SAME period + canonical cutoff and logs drift —
  // the served Postgres payload (`data`) is never affected.
  if (data) void compareCostBreakdown(period, data);

  if (error || !data) {
    return (
      <TileErrorFallback
        label="Cost Breakdown"
        hint="The cost-breakdown aggregation failed. Server logs hold the digest."
        size="panel"
      />
    );
  }

  return (
    <FadeIn>
      <div className="space-y-6">
        <LifetimePnlReference snapshot={lifetimeSnapshot} />

        <StoryLead data={data} periodLabel={periodLabel} />

        <section className="space-y-3">
          <SectionHeading
            icon={Layers}
            title={`The story in four moves · ${periodLabel}`}
          />
          <SummaryFlow data={data} periodLabel={periodLabel} />
        </section>

        <section className="space-y-3">
          <SectionHeading
            icon={Scale}
            title={`The waterfall — wager → net result · ${periodLabel}`}
          />
          <WaterfallPanel data={data} />
        </section>

        <section className="space-y-3">
          <SectionHeading
            icon={ListOrdered}
            title={`Cost categories ranked — biggest leak first · ${periodLabel}`}
          />
          <RankedCosts data={data} />
        </section>

        <section className="space-y-3">
          <SectionHeading
            icon={Activity}
            title={`Margin health · ${periodLabel}`}
          />
          <MarginHealth data={data} />
        </section>

        {data.contributors.length > 0 && (
          <section className="space-y-3">
            <SectionHeading
              icon={Users}
              title="Who drove the margin · lifetime wager loss"
            />
            <Contributors data={data} />
          </section>
        )}

        {data.trend.length > 0 && (
          <section className="space-y-3">
            <SectionHeading
              icon={TrendingUp}
              title={`Trend — is leakage growing? · ${periodLabel}`}
            />
            <CostTrendChart data={data.trend} />
          </section>
        )}
      </div>
    </FadeIn>
  );
}

/**
 * The waterfall-skeleton silhouette rendered inside the page's Suspense
 * fallback while the body streams (and by `loading.tsx` for the route-level
 * pending state). Layout-matching so nothing jumps when the data lands:
 * the story-lead block, the four-move summary grid, and the waterfall panel.
 */
function CostBreakdownBodySkeleton() {
  return (
    <>
      {/* Story lead */}
      <div className="overflow-hidden rounded-2xl border bg-card">
        <div className="flex items-center gap-3 border-b bg-muted/30 px-4 py-3 sm:px-5">
          <Skeleton className="size-8 shrink-0 rounded-lg" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-3 w-40" />
          </div>
        </div>
        <div className="p-4 sm:p-5">
          <SkeletonText lines={4} />
        </div>
      </div>

      {/* Four-move summary grid */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={220} />
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, g) => (
            <div key={g} className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <div className="grid gap-3">
                <Skeleton className="h-[5.5rem] rounded-xl" />
                <Skeleton className="h-[5.5rem] rounded-xl" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Waterfall */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={260} />
        <div className="rounded-xl border bg-card p-3 sm:p-4">
          <SkeletonText lines={12} />
        </div>
      </div>
    </>
  );
}

// ─── Lifetime realized P&L reference ────────────────────────────────

/**
 * The authoritative bottom-line answer, shown ABOVE the per-period story:
 * the canonical lifetime balance-sheet snapshot from
 * `getRealizedPnlSnapshot` — deposits − withdrawals − on-site balance −
 * inventory − unclaimed vouchers − unclaimed rakeback. This is the SAME
 * figure the /insights hub P&L tile, /insights/real-numbers and the
 * dashboard render, so the four can never drift. It is intentionally
 * separate from (and a constant reference for) the windowed cost-breakdown
 * P&L below, which on the unbounded lifetime scan diverges from this
 * snapshot — see the "Net result (this period)" tile.
 *
 * House-POV: P&L ≥ 0 → emerald (keep), < 0 → rose (cost). Renders nothing
 * if the snapshot leg failed (the page's per-period story still stands).
 */
function LifetimePnlReference({
  snapshot,
}: {
  snapshot: RealizedPnlSnapshot | null;
}) {
  if (!snapshot) return null;
  const pos = snapshot.pnl >= 0;
  const tone = SEMANTIC_TONES[pos ? "keep" : "cost"];
  const PnlIcon = pos ? TrendingUp : TrendingDown;
  return (
    <div className="rounded-2xl border bg-card p-4 shadow-sm sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-lg",
              tone.chip,
            )}
          >
            <PnlIcon className="size-5" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:text-[11px]">
                Lifetime realized P&amp;L (balance sheet)
              </span>
              <MetricInfoPopover
                tone={pos ? "keep" : "cost"}
                label="What lifetime realized P&L means"
                title="Lifetime realized P&L · balance sheet"
                blurb="The canonical house bottom line: deposits − withdrawals − on-site balance − inventory − unclaimed vouchers − unclaimed rakeback. The SAME snapshot the Insights hub, Real Numbers and the Dashboard show, so they can never drift. Constant across the period chip — it is lifetime, not windowed."
              >
                <ul className="space-y-0.5">
                  <InfoRow
                    iconNode={<ArrowDownToLine className="size-3" />}
                    label="Deposits"
                    amount={snapshot.totalDeposited}
                    sign="+"
                    tone="base"
                  />
                  <InfoRow
                    iconNode={<ArrowUpFromLine className="size-3" />}
                    label="Withdrawals"
                    sub="balance + shipped-card cash-out"
                    amount={snapshot.totalWithdrawn}
                    sign="−"
                    tone="cost"
                  />
                  <InfoRow
                    iconNode={<Wallet className="size-3" />}
                    label="On-site balance held"
                    amount={snapshot.userBalance}
                    sign="−"
                    tone="held"
                  />
                  <InfoRow
                    iconNode={<Package className="size-3" />}
                    label="Inventory held"
                    amount={snapshot.inventory}
                    sign="−"
                    tone="held"
                  />
                  <InfoRow
                    iconNode={<Ticket className="size-3" />}
                    label="Unclaimed vouchers"
                    amount={snapshot.vouchers}
                    sign="−"
                    tone="held"
                  />
                  <InfoRow
                    iconNode={<HandCoins className="size-3" />}
                    label="Unclaimed rakeback"
                    amount={snapshot.unclaimedRakeback}
                    sign="−"
                    tone="held"
                  />
                </ul>
                <InfoTotal
                  label="Realized P&L"
                  amount={snapshot.pnl}
                  sign={pos ? "+" : "−"}
                  tone={pos ? "keep" : "cost"}
                  note="The real bottom line — deposits minus withdrawals minus everything users still hold. See Real Numbers for the full balance sheet."
                />
              </MetricInfoPopover>
            </div>
            <p
              className={cn(
                "mt-0.5 text-2xl font-bold leading-tight tracking-tight tabular-nums sm:text-3xl",
                tone.text,
              )}
            >
              {pos ? "+" : "−"}
              {formatCurrency(Math.abs(snapshot.pnl))}
            </p>
            <p className="mt-1 max-w-prose text-[11px] leading-snug text-muted-foreground">
              deposits − withdrawals − holdings − unclaimed rakeback; the real
              bottom line — see{" "}
              <Link
                href="/insights/real-numbers"
                className="font-medium text-foreground underline decoration-dotted underline-offset-2 hover:decoration-solid"
              >
                Real Numbers
              </Link>
              .
            </p>
          </div>
        </div>
        <p className="shrink-0 rounded-lg border border-border/70 bg-background/40 px-2.5 py-1.5 text-[10px] leading-snug text-muted-foreground sm:max-w-[14rem] sm:text-right">
          Constant lifetime figure — independent of the period chip. The
          breakdown below is the per-period flow.
        </p>
      </div>
    </div>
  );
}

// ─── Story lead ─────────────────────────────────────────────────────

/**
 * The headline answer in plain English, chunked into short scannable
 * lines instead of one dense wall: the gross margin captured, what went
 * back to users, what's held/unrealized, the period's net result, then
 * the single biggest leak + the held-liability caveat (why GGR can look
 * healthy while the period result stays thin).
 */
function StoryLead({
  data,
  periodLabel,
}: {
  data: CostBreakdown;
  periodLabel: string;
}) {
  const held = data.inventoryDelta + data.voucherDelta;
  const backToUsers =
    data.gamingPayouts + data.rewardPayouts + data.cardWithdrawals;
  const leak = data.biggestLeak;
  const pnlPos = data.pnl >= 0;
  const ggrPos = data.ggr >= 0;
  return (
    <div className="overflow-hidden rounded-2xl border bg-card">
      <div className="flex items-start gap-3 border-b bg-muted/30 px-4 py-3 sm:px-5">
        <div className="shrink-0 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2">
          <TrendingDown className="size-4 text-rose-500" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold sm:text-base">
            Where the {formatCurrency(data.totalWager)} wagered ended up
          </h2>
          <p className="text-xs text-muted-foreground">
            {periodLabel} · house perspective — every dollar a user keeps is
            a dollar we owe.
          </p>
        </div>
      </div>

      <div className="grid gap-x-6 gap-y-2.5 p-4 text-sm leading-relaxed sm:p-5 lg:grid-cols-2">
        <p className="lg:col-span-2">
          Customers staked{" "}
          <ValueChip tone="base">{formatCurrency(data.totalWager)}</ValueChip>{" "}
          across packs and battles. The house edge turned that into{" "}
          <ValueChip tone={ggrPos ? "keep" : "cost"}>
            {ggrPos ? "+" : "−"}
            {formatCurrency(Math.abs(data.ggr))}
          </ValueChip>{" "}
          of gross gaming margin (GGR).
        </p>
        <p>
          <span className="font-medium text-foreground">Paid straight back:</span>{" "}
          <ValueChip tone="cost">{formatCurrency(backToUsers)}</ValueChip> left
          as gameplay winnings, bonuses, prizes and shipped cards — money the
          house no longer holds.
        </p>
        <p>
          <span className="font-medium text-foreground">Still held:</span>{" "}
          <ValueChip tone="held">{formatCurrency(held)}</ValueChip> sits in
          cards and vouchers users own but haven&apos;t cashed — an unrealized
          liability, not yet a loss.
        </p>
        <p className="lg:col-span-2">
          Netting this window&apos;s gaming margin against what flowed out, the{" "}
          <span className="font-medium text-foreground">
            net result for {periodLabel.toLowerCase()}
          </span>{" "}
          is{" "}
          <ValueChip tone={pnlPos ? "keep" : "cost"} className="text-[15px]">
            {pnlPos ? "+" : "−"}
            {formatCurrency(Math.abs(data.pnl))}
          </ValueChip>
          {data.margin.pnlPctOfWager !== null && (
            <span className="text-muted-foreground">
              {" "}
              — {data.margin.pnlPctOfWager.toFixed(1)}% of every dollar wagered.
            </span>
          )}{" "}
          <span className="text-muted-foreground">
            This is the per-period gaming→cash flow — for the house&apos;s
            actual bottom line see the lifetime balance-sheet figure above.
          </span>
        </p>

        {leak && (
          <div className="mt-1 rounded-xl border border-border/70 bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground lg:col-span-2">
            <span className="font-medium text-foreground">Biggest leak:</span>{" "}
            <span className="font-medium text-foreground">{leak.label}</span> at{" "}
            <span className="font-semibold text-rose-600 dark:text-rose-400">
              {formatCurrency(leak.amount)}
            </span>
            {data.ggr > 0 && (
              <> ({((leak.amount / data.ggr) * 100).toFixed(1)}% of GGR)</>
            )}
            . And watch the{" "}
            <span className="font-semibold text-amber-600 dark:text-amber-400">
              {formatCurrency(held)}
            </span>{" "}
            held in inventory + vouchers: it&apos;s the cost most easily
            missed, and it&apos;s why GGR can look healthy while the period
            result stays thin.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Summary flow (the four moves) ──────────────────────────────────

/**
 * One summary value tile — a tinted face with a hairline ring in its
 * tone, an icon chip, a label with an optional "i" breakdown popover, a
 * hero value, and an optional sub-line. `size="hero"` makes the realized
 * outcome read loudest; `size="lead"` is a slightly heavier driver tile.
 */
function SummaryTile({
  label,
  value,
  sub,
  icon: Icon,
  tone,
  size = "base",
  info,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  icon: LucideIcon;
  tone: SemanticTone;
  size?: "base" | "lead" | "hero";
  info?: React.ReactNode;
}) {
  const t = SEMANTIC_TONES[tone] ?? SEMANTIC_TONES.muted;
  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border bg-card",
        size === "hero" ? "p-4 sm:p-5" : "p-3 sm:p-4",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "flex shrink-0 items-center justify-center rounded-md",
            size === "hero" ? "size-7" : "size-6",
            t.chip,
          )}
        >
          <Icon className={size === "hero" ? "size-4" : "size-3.5"} />
        </span>
        <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:text-[11px]">
          {label}
        </span>
        {info}
      </div>
      <p
        className={cn(
          "mt-1.5 truncate font-bold leading-tight tracking-tight tabular-nums",
          t.text,
          size === "hero"
            ? "text-2xl sm:text-3xl"
            : size === "lead"
              ? "text-xl sm:text-2xl"
              : "text-lg sm:text-xl",
        )}
      >
        {value}
      </p>
      {sub && (
        <p className="mt-0.5 truncate text-[10px] text-muted-foreground sm:text-[11px]">
          {sub}
        </p>
      )}
    </div>
  );
}

/** A labelled group header above a cluster of summary tiles. */
function SummaryGroup({
  step,
  title,
  children,
}: {
  step: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-bold tabular-nums text-muted-foreground">
          {step}
        </span>
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        <span aria-hidden className="h-px flex-1 bg-border/60" />
      </div>
      {children}
    </div>
  );
}

/**
 * The summary grouped into the four-move reading order:
 *   1 Incoming value (wager) → 2 Paid back & costs (gaming + rewards) →
 *   3 Held / unrealized (inventory + vouchers + shipped) → 4 Period
 *   outcome (NGR checkpoint + the loud per-period net result).
 * Each headline metric carries the "i" breakdown popover the owner likes.
 * The lifetime balance-sheet bottom line is rendered separately, ABOVE
 * this windowed story (see `LifetimePnlReference`).
 */
function SummaryFlow({
  data,
  periodLabel,
}: {
  data: CostBreakdown;
  periodLabel: string;
}) {
  const m = data.margin;
  const ggrPos = data.ggr >= 0;
  const ngrPos = data.ngr >= 0;
  const pnlPos = data.pnl >= 0;
  const held = data.inventoryDelta + data.voucherDelta;

  return (
    <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
      {/* 1 — Incoming */}
      <SummaryGroup step={1} title="Incoming value">
        <div className="grid gap-3">
          <SummaryTile
            label="Organic wager"
            value={formatCurrency(data.organicCustomerStake)}
            sub={`${periodLabel} · no creator code`}
            icon={Coins}
            tone="base"
            info={
              <MetricInfoPopover
                tone="base"
                label="What organic wager means"
                title="Organic wager"
                blurb="Customer stake from users who did not join under a creator code (on-stream sponsored play excluded). Matches the dashboard organic wager + organic upgrader. Borrow-funded play is included — distinct from the GGR waterfall base below, which excludes borrow."
              />
            }
          />
          <SummaryTile
            label="GGR — gross gaming margin"
            value={`${ggrPos ? "+" : "−"}${formatCurrency(Math.abs(data.ggr))}`}
            sub={
              m.ggrPctOfWager !== null
                ? `${m.ggrPctOfWager.toFixed(1)}% of wager (house edge)`
                : "wager − gameplay winnings"
            }
            icon={ggrPos ? TrendingUp : TrendingDown}
            tone={ggrPos ? "keep" : "cost"}
            info={
              <MetricInfoPopover
                tone={ggrPos ? "keep" : "cost"}
                label="What GGR means"
                title="GGR · gross gaming margin"
                blurb="Wager minus the gameplay winnings paid back (inventory-delta + battle refunds). The gross house edge on gaming alone, before any marketing/reward cost. Same canonical GGR as /ggr and /dashboard. Card sales/exchanges are NEUTRAL conversions — they never touch this."
              >
                <ul className="space-y-0.5">
                  <InfoRow
                    iconNode={<Coins className="size-3" />}
                    label="Total wager"
                    amount={data.totalWager}
                    sign="+"
                    tone="base"
                  />
                  <InfoRow
                    iconNode={<ArrowDownToLine className="size-3" />}
                    label="Gameplay winnings paid back"
                    sub="inventory value + battle refunds"
                    amount={data.gamingPayouts}
                    sign="−"
                    tone="cost"
                  />
                </ul>
                <InfoTotal
                  label="GGR"
                  amount={data.ggr}
                  sign={ggrPos ? "+" : "−"}
                  tone={ggrPos ? "keep" : "cost"}
                />
              </MetricInfoPopover>
            }
          />
        </div>
      </SummaryGroup>

      {/* 2 — Paid back & costs */}
      <SummaryGroup step={2} title="Paid back & costs">
        <div className="grid gap-3">
          <SummaryTile
            label="Gameplay winnings"
            value={`−${formatCurrency(data.gamingPayouts)}`}
            sub={
              m.rtp !== null
                ? `${(m.rtp * 100).toFixed(1)}% RTP · won & kept`
                : "cards kept + battle refunds"
            }
            icon={ArrowDownToLine}
            tone="cost"
            info={
              <MetricInfoPopover
                tone="cost"
                label="What gameplay winnings means"
                title="Gameplay winnings paid back"
                blurb="The cards users won and kept (inventory value at obtained) plus battle cash refunds — the user's own gameplay winnings. The verified inventory-delta payout; card sales/exchanges are neutral conversions and are not counted here."
              />
            }
          />
          <SummaryTile
            label="Reward & marketing"
            value={`−${formatCurrency(data.rewardPayouts)}`}
            sub={
              data.ggr > 0
                ? `${((data.rewardPayouts / data.ggr) * 100).toFixed(0)}% of GGR given away`
                : "GGR − NGR"
            }
            icon={Gift}
            tone="cost"
            info={
              <MetricInfoPopover
                tone="cost"
                label="What reward & marketing cost means"
                title="Reward & marketing giveaways"
                blurb="All house-funded giveaways that turn GGR into NGR: deposit bonuses, rakeback, promo/gift cards, race & leaderboard prizes, affiliate commissions, the net house slice of rain, and counted balance adjustments. Equals GGR − NGR. Itemised per category in the waterfall and ranked-leaks list below."
              />
            }
          />
        </div>
      </SummaryGroup>

      {/* 3 — Held / unrealized */}
      <SummaryGroup step={3} title="Held / unrealized">
        <div className="grid gap-3">
          <SummaryTile
            label="Held by users (unrealized)"
            value={formatCurrency(held)}
            sub="inventory + unclaimed vouchers"
            icon={PiggyBank}
            tone="held"
            info={
              <MetricInfoPopover
                tone="held"
                label="What held / unrealized means"
                title="Held by users · unrealized liability"
                blurb="Value users own but haven't cashed out — a future liability, NOT a realized loss. It can still flip back to the house if they let cards or vouchers expire, so it's shown in amber, not red. This is the gap that keeps realized P&L below GGR."
              >
                <ul className="space-y-0.5">
                  <InfoRow
                    iconNode={<Package className="size-3" />}
                    label="Inventory still held"
                    sub="cards won & kept (obtained − sold)"
                    amount={data.inventoryDelta}
                    tone="held"
                  />
                  <InfoRow
                    iconNode={<Ticket className="size-3" />}
                    label="Unclaimed voucher liability"
                    sub="issued − claimed"
                    amount={data.voucherDelta}
                    tone="held"
                  />
                </ul>
                <InfoTotal
                  label="Held (unrealized)"
                  amount={held}
                  tone="held"
                  note="Separate from shipped cards, which have already left the house and count as a realized cost."
                />
              </MetricInfoPopover>
            }
          />
          <SummaryTile
            label="Cards shipped (realized)"
            value={`−${formatCurrency(data.cardWithdrawals)}`}
            sub="left the house entirely"
            icon={ArrowUpFromLine}
            tone="cost"
            info={
              <MetricInfoPopover
                tone="cost"
                label="What shipped cards means"
                title="Card withdrawals (shipped)"
                blurb="Physical cards shipped out in the window (completed/shipped withdrawal requests). Unlike held inventory, this value has left the house entirely — so it's a realized cost (rose), not an unrealized hold (amber)."
              />
            }
          />
        </div>
      </SummaryGroup>

      {/* 4 — Period outcome */}
      <SummaryGroup step={4} title="Period outcome">
        <div className="grid gap-3">
          <SummaryTile
            label="NGR — net gaming margin"
            value={`${ngrPos ? "+" : "−"}${formatCurrency(Math.abs(data.ngr))}`}
            sub={
              m.ngrPctOfWager !== null
                ? `${m.ngrPctOfWager.toFixed(1)}% of wager · after rewards`
                : "GGR − reward cost"
            }
            icon={Scale}
            tone={ngrPos ? "keep" : "cost"}
            size="lead"
            info={
              <MetricInfoPopover
                tone={ngrPos ? "keep" : "cost"}
                label="What NGR means"
                title="NGR · net gaming margin"
                blurb="GGR minus all house-funded reward / marketing spend (bonuses, rakeback, prizes, the net house slice of rain, affiliate-leaderboard prizes, …). What the gaming business kept after giveaways — still before balance-sheet held liabilities."
              />
            }
          />
          <SummaryTile
            label="Net result (this period)"
            value={`${pnlPos ? "+" : "−"}${formatCurrency(Math.abs(data.pnl))}`}
            sub={
              m.pnlPctOfWager !== null
                ? `${m.pnlPctOfWager.toFixed(1)}% of wager · gaming margin → cash flow`
                : "gaming margin → cash flow this period"
            }
            icon={pnlPos ? TrendingUp : TrendingDown}
            tone={pnlPos ? "keep" : "cost"}
            size="hero"
            info={
              <MetricInfoPopover
                tone={pnlPos ? "keep" : "cost"}
                label="What net result (this period) means"
                title="Net result · this period"
                blurb="The window's gaming margin netted to cash flow: NGR − inventory change − cards shipped − voucher change + net residual ledger flows (the canonical windowed P&L). A legit per-period flow for a bounded window (7d / 30d). NOT the lifetime bottom line — on the unbounded lifetime scan it diverges from the balance-sheet snapshot at the top (which also nets unclaimed rakeback + in-flight withdrawals). For the house's actual P&L use the Lifetime realized P&L above."
              >
                <ul className="space-y-0.5">
                  <InfoRow
                    iconNode={<Scale className="size-3" />}
                    label="NGR (net gaming margin)"
                    amount={data.ngr}
                    sign={ngrPos ? "+" : "−"}
                    tone={ngrPos ? "keep" : "cost"}
                  />
                  <InfoRow
                    iconNode={<Package className="size-3" />}
                    label="Inventory still held"
                    amount={data.inventoryDelta}
                    sign="−"
                    tone="held"
                  />
                  <InfoRow
                    iconNode={<ArrowUpFromLine className="size-3" />}
                    label="Cards shipped"
                    amount={data.cardWithdrawals}
                    sign="−"
                    tone="cost"
                  />
                  <InfoRow
                    iconNode={<Ticket className="size-3" />}
                    label="Unclaimed vouchers"
                    amount={data.voucherDelta}
                    sign="−"
                    tone="held"
                  />
                  <InfoRow
                    iconNode={<Wallet className="size-3" />}
                    label="Residual ledger flows (net)"
                    sub="deposits in, transfers, adjustments"
                    amount={Math.abs(data.residualNamedTotal + data.residual)}
                    sign={
                      data.residualNamedTotal + data.residual >= 0 ? "+" : "−"
                    }
                    tone={
                      data.residualNamedTotal + data.residual >= 0
                        ? "base"
                        : "cost"
                    }
                  />
                </ul>
                <InfoTotal
                  label="Net result (this period)"
                  amount={data.pnl}
                  sign={pnlPos ? "+" : "−"}
                  tone={pnlPos ? "keep" : "cost"}
                  note="NGR minus held & shipped liabilities, plus net residual ledger flows, equals this period's net result. The lifetime bottom line is the balance-sheet snapshot at the top of the page."
                />
              </MetricInfoPopover>
            }
          />
        </div>
      </SummaryGroup>
    </div>
  );
}

// ─── Waterfall ──────────────────────────────────────────────────────

/**
 * Maps a cost line to its SEMANTIC tone + a server-rendered lucide icon.
 * The tone language (not one flat rose): the base wager is blue; money
 * the house keeps (GGR/NGR/P&L subtotals when positive) is emerald;
 * realized money-back (gaming payout, rewards, shipped cards) is rose;
 * HELD / unrealized liabilities (inventory, unclaimed vouchers) are amber
 * so they never read as a realized loss; named RESIDUAL_TYPES rows colour
 * by their effect on P&L (inflow blue, outflow rose, net-zero transfer
 * muted); the honest leftover is muted. Resolving the icon server-side
 * keeps lucide off the client WaterfallRow bundle.
 */
function lineVisual(line: CostLine): {
  tone: SemanticTone;
  sign: "+" | "−" | "=";
  icon: LucideIcon;
} {
  switch (line.kind) {
    case "base":
      return { tone: "base", sign: "+", icon: Coins };
    case "gaming-payout":
      return { tone: "cost", sign: "−", icon: ArrowDownToLine };
    case "reward":
      return { tone: "cost", sign: "−", icon: Gift };
    case "liability":
      // Inventory + unclaimed vouchers are HELD / unrealized → amber.
      // Shipped cards have left the house → realized cost → rose.
      if (line.key === "inventory")
        return { tone: "held", sign: "−", icon: Package };
      if (line.key === "voucher-liability")
        return { tone: "held", sign: "−", icon: Ticket };
      return { tone: "cost", sign: "−", icon: ArrowUpFromLine };
    case "residual":
      // signedAmount > 0 = cash inflow to the house (deposits) → blue;
      // < 0 = an outflow (card-withdrawal leg, rain funding, admin debit)
      // → rose; == 0 = a net-zero transfer (vault, creator-tip, escrow,
      // creator-fill) → muted (informational).
      return {
        tone:
          line.signedAmount > 0
            ? "base"
            : line.signedAmount < 0
              ? "cost"
              : "muted",
        sign:
          line.signedAmount > 0
            ? "+"
            : line.signedAmount < 0
              ? "−"
              : "=",
        icon:
          line.signedAmount > 0
            ? ArrowDownToLine
            : line.signedAmount < 0
              ? ArrowUpFromLine
              : Scale,
      };
    case "unexplained":
      return {
        tone: line.label.startsWith("Unexplained") ? "held" : "muted",
        sign: line.signedAmount < 0 ? "−" : "+",
        icon: AlertCircle,
      };
    case "subtotal":
      return {
        tone: line.signedAmount >= 0 ? "keep" : "cost",
        sign: "=",
        icon: line.signedAmount >= 0 ? TrendingUp : TrendingDown,
      };
    case "result":
      return {
        tone: line.signedAmount >= 0 ? "keep" : "cost",
        sign: "=",
        icon: line.signedAmount >= 0 ? TrendingUp : TrendingDown,
      };
    default:
      // The switch above is exhaustive over CostLineKind, so this is
      // unreachable by the type system. It exists as a RUNTIME safety net:
      // should a CostLine ever carry an unexpected `kind` (e.g. a future
      // ledger type or a serialization edge), `lineVisual` must still return
      // a valid, mapped tone rather than `undefined` — otherwise the
      // downstream `SEMANTIC_TONES[v.tone]` lookup would be `undefined` and
      // dereferencing `.face`/`.icon` would crash render. Fall back to the
      // muted (always-present) tone, the same key the guarded lookups use.
      return { tone: "muted", sign: "−", icon: AlertCircle };
  }
}

/**
 * Bands the ordered waterfall lines into labelled chapters so the running
 * total reads as distinct moves. Returns, for each line, the band header
 * (if this line opens a new band) to render above it.
 */
function bandFor(line: CostLine): { label: string; hint?: string } | null {
  switch (line.kind) {
    case "base":
      return { label: "Incoming", hint: "what customers staked" };
    case "gaming-payout":
      return { label: "Less gameplay winnings", hint: "the user's own wins" };
    case "reward":
      return null; // rewards open their own band via the NGR-side header
    case "liability":
      return null;
    case "residual":
      return null;
    case "unexplained":
      return null;
    case "subtotal":
      return null;
    case "result":
      return null;
  }
}

function WaterfallPanel({ data }: { data: CostBreakdown }) {
  const maxMag = Math.max(
    ...data.lines.map((l) => Math.abs(l.signedAmount)),
    1,
  );
  // Identify the top-3 cost lines by magnitude so we can badge them
  // inline in the waterfall. Keyed by line.key for O(1) lookup.
  const topLeakRank = new Map<string, number>();
  data.rankedCosts.slice(0, 3).forEach((l, i) => {
    if (l.amount > 0) topLeakRank.set(l.key, i + 1);
  });

  // Insert band headers ahead of the first reward line and ahead of the
  // first liability/held line so the three middle chapters
  // (givebacks → rewards → held) read distinctly without hard-coding
  // indices.
  const firstRewardKey = data.lines.find((l) => l.kind === "reward")?.key;
  const firstHeldKey = data.lines.find(
    (l) => l.kind === "liability" || l.kind === "residual",
  )?.key;

  return (
    <Card>
      <CardContent className="space-y-0.5 p-3 sm:p-4">
        {data.lines.map((line) => {
          const v = lineVisual(line);
          const colors = SEMANTIC_TONES[v.tone] ?? SEMANTIC_TONES.muted;
          const Icon = v.icon;
          const emphasis: "normal" | "subtotal" | "result" =
            line.kind === "result"
              ? "result"
              : line.kind === "subtotal"
                ? "subtotal"
                : "normal";

          // Band header above this row, if it opens a chapter.
          let band = bandFor(line);
          if (line.key === firstRewardKey)
            band = {
              label: "Less reward & marketing",
              hint: "house-funded giveaways",
            };
          else if (line.key === firstHeldKey)
            band = {
              label: "Less held & balance-sheet flows",
              hint: "held liabilities, transfers, residual",
            };

          return (
            <div key={line.key}>
              {band && <WaterfallBand label={band.label} hint={band.hint} />}
              <WaterfallRow
                label={line.label}
                signedAmount={line.signedAmount}
                sign={v.sign}
                maxMag={maxMag}
                tone={v.tone}
                pctOfGgr={line.pctOfGgr}
                pctOfWager={line.pctOfWager}
                emphasis={emphasis}
                rank={topLeakRank.get(line.key)}
                iconNode={<Icon className={cn("size-3.5", colors.icon)} />}
                info={
                  <MetricInfoPopover
                    tone={v.tone}
                    label={`What ${line.label} means`}
                    title={line.label}
                    blurb={line.why}
                  />
                }
              />
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ─── Ranked costs ───────────────────────────────────────────────────

/**
 * Every leakage category sorted biggest-first, each with amount +
 * %-of-GGR + %-of-wager and a proportional bar. The "which leak is
 * biggest" view, decoupled from the waterfall's running-total order.
 * Held / unrealized liabilities are tinted amber here too, so an
 * unrealized hold is never mistaken for realized money-back.
 */
function RankedCosts({ data }: { data: CostBreakdown }) {
  const visible = data.rankedCosts.filter((l) => l.amount > 0);
  const maxMag = Math.max(...visible.map((l) => l.amount), 1);
  if (visible.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          No costs recorded in this window.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="space-y-2.5 p-4 sm:p-5">
        {visible.map((line, i) => {
          const v = lineVisual(line);
          const t = SEMANTIC_TONES[v.tone] ?? SEMANTIC_TONES.muted;
          const widthPct = Math.min(
            100,
            Math.max(2, (line.amount / maxMag) * 100),
          );
          return (
            <div key={line.key} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="w-5 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums">
                    {i + 1}
                  </span>
                  <span className="truncate text-sm font-medium">
                    {line.label}
                  </span>
                  {v.tone === "held" && (
                    <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                      held
                    </span>
                  )}
                </div>
                <span
                  className={cn(
                    "shrink-0 font-mono text-sm font-semibold tabular-nums",
                    t.text,
                  )}
                >
                  −{formatCurrency(line.amount)}
                </span>
              </div>
              <div className="ml-7 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted/60">
                  <div
                    className={cn("h-full rounded-full", t.bar)}
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
                <div className="flex shrink-0 items-center gap-2 text-[10px] tabular-nums text-muted-foreground">
                  {line.pctOfGgr !== null && (
                    <span>{Math.abs(line.pctOfGgr).toFixed(1)}% GGR</span>
                  )}
                  {line.pctOfWager !== null && (
                    <span className="hidden sm:inline">
                      {Math.abs(line.pctOfWager).toFixed(1)}% wager
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <p className="border-t border-border/60 pt-2.5 text-[10px] leading-snug text-muted-foreground">
          <span className="font-medium text-amber-600 dark:text-amber-400">
            Amber &ldquo;held&rdquo;
          </span>{" "}
          lines are unrealized liabilities (inventory + vouchers users still
          own) — they erode realized P&L but can still flip back to the house.
          Everything else has already left the house.
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Margin health ──────────────────────────────────────────────────

/**
 * Compact ratio tiles. House-POV: a higher house edge / GGR%-of-wager is
 * good (emerald); a higher RTP / cost-of-GGR means more flowed back to
 * users (rose); P&L survival is emerald when positive. These read lighter
 * than the summary tiles on purpose — they're supporting detail.
 */
function MarginHealth({ data }: { data: CostBreakdown }) {
  const m = data.margin;
  const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);
  const ratio = (v: number | null) =>
    v === null ? "—" : `${(v * 100).toFixed(1)}%`;
  const tiles: Array<{
    label: string;
    value: string;
    sub: string;
    icon: LucideIcon;
    tone: SemanticTone;
  }> = [
    {
      label: "RTP",
      value: ratio(m.rtp),
      sub: "Gaming payouts ÷ wager",
      icon: ArrowDownToLine,
      tone: "cost",
    },
    {
      label: "House edge",
      value: ratio(m.houseEdge),
      sub: "GGR ÷ wager",
      icon: Scale,
      tone: m.houseEdge !== null && m.houseEdge >= 0 ? "keep" : "cost",
    },
    {
      label: "GGR % of wager",
      value: pct(m.ggrPctOfWager),
      sub: "Gross margin rate",
      icon: Coins,
      tone: m.ggrPctOfWager !== null && m.ggrPctOfWager >= 0 ? "keep" : "cost",
    },
    {
      label: "P&L % of wager",
      value: pct(m.pnlPctOfWager),
      sub: "Realized margin rate",
      icon: Trophy,
      tone: m.pnlPctOfWager !== null && m.pnlPctOfWager >= 0 ? "keep" : "cost",
    },
    {
      label: "Cost % of GGR",
      value: pct(m.costPctOfGgr),
      sub: "Gross margin consumed",
      icon: HandCoins,
      tone: "cost",
    },
    {
      label: "P&L % of GGR",
      value: pct(m.pnlPctOfGgr),
      sub: "Gross margin survived",
      icon: TrendingUp,
      tone: m.pnlPctOfGgr !== null && m.pnlPctOfGgr >= 0 ? "keep" : "cost",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
      {tiles.map((tile) => {
        const t = SEMANTIC_TONES[tile.tone] ?? SEMANTIC_TONES.muted;
        return (
          <div
            key={tile.label}
            className="rounded-xl border bg-card p-3"
          >
            <div className="flex items-center gap-1.5">
              <tile.icon className={cn("size-3.5 shrink-0", t.icon)} />
              <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {tile.label}
              </span>
            </div>
            <p
              className={cn(
                "mt-1 truncate text-lg font-bold tabular-nums sm:text-xl",
                t.text,
              )}
            >
              {tile.value}
            </p>
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
              {tile.sub}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// ─── Contributors ───────────────────────────────────────────────────

/**
 * Top users by absolute lifetime Wager Loss (the "who"). Sourced from the
 * authoritative `balances.total_wagered` / `total_won` counters — the
 * SAME figures shown on `/users/[id]` — so each row reconciles with that
 * user's detail-page Wager Loss tile. Always lifetime (the counters are
 * cumulative; the main DB has no windowed `won`), so this list does not
 * track the page's period chip. House-POV: net > 0 (user net-lost) =
 * emerald; net < 0 (user up) = rose.
 *
 * On phones the wager/payout columns are dropped (they overflow a 360px
 * row); the net stays since it's the headline. They return at sm+.
 */
function Contributors({ data }: { data: CostBreakdown }) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="grid grid-cols-[1.75rem_1fr_minmax(0,_6rem)] items-center gap-2 border-b bg-muted/30 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:grid-cols-[2rem_1fr_repeat(3,_minmax(0,_7rem))] sm:gap-3 sm:px-4">
          <span className="text-right">#</span>
          <span>User</span>
          <span className="hidden text-right sm:block">Wager</span>
          <span className="hidden text-right sm:block">Payouts</span>
          <span className="text-right">Net (house)</span>
        </div>
        <ul>
          {data.contributors.map((c, i) => (
            <li key={c.userId}>
              <Link
                href={`/users/${c.userId}`}
                className="grid grid-cols-[1.75rem_1fr_minmax(0,_6rem)] items-center gap-2 border-b border-border/60 px-3 py-2.5 text-xs transition-colors last:border-b-0 hover:bg-muted/30 sm:grid-cols-[2rem_1fr_repeat(3,_minmax(0,_7rem))] sm:gap-3 sm:px-4"
              >
                <span className="text-right text-muted-foreground tabular-nums">
                  {i + 1}
                </span>
                <span className="truncate font-medium">
                  {c.username ?? (
                    <span className="font-mono text-muted-foreground">
                      {c.userId.slice(0, 8)}…
                    </span>
                  )}
                </span>
                <span className="hidden text-right font-mono tabular-nums text-muted-foreground sm:block">
                  {formatCurrency(c.wagerTotal)}
                </span>
                <span className="hidden text-right font-mono tabular-nums text-muted-foreground sm:block">
                  {formatCurrency(c.payoutTotal)}
                </span>
                <span
                  className={cn(
                    "text-right font-mono font-semibold tabular-nums",
                    c.net >= 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-rose-600 dark:text-rose-400",
                  )}
                >
                  {c.net >= 0 ? "+" : "−"}
                  {formatCurrency(Math.abs(c.net))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="px-3 py-2 text-[10px] leading-snug text-muted-foreground sm:px-4">
          Lifetime Wager = Total Wagered, Payouts = Total Won (the
          authoritative per-user counters shown on each user&apos;s detail
          page). Net is house-POV: positive (emerald) = the user net-lost
          (house up); negative (rose) = the user is up. Top{" "}
          {formatNumber(data.contributors.length)} by absolute lifetime wager
          loss — always lifetime, independent of the period above.
        </p>
      </CardContent>
    </Card>
  );
}
