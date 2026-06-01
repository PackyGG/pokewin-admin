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
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
  TILE_COLORS,
  type AccentColor,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { ExportButton } from "@/components/export-button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  parseInsightsPeriod,
  INSIGHTS_PERIOD_LABELS,
} from "../analytics/types";
import {
  getCostBreakdown,
  type CostLine,
  type CostBreakdown,
} from "@/lib/queries/insights-analytics/cost-breakdown";
import { CostBreakdownPeriodFilter } from "./period-filter";
import { CostTrendChart } from "./trend-chart";
import { WaterfallRow } from "./waterfall-row";

export const metadata = { title: "Cost Breakdown" };

/**
 * /insights/cost-breakdown — THE money-leakage page.
 *
 * Answers the operator's recurring question: "$2.5M wagered but only
 * $17k P&L — where does all the money go?" One waterfall ties total
 * wager → realized P&L, itemizing every cost / leakage category in
 * between, each with its dollar amount, %-of-GGR, and %-of-wager so the
 * biggest leak is obvious.
 *
 * Every number is an AGGREGATION of the existing query infrastructure
 * (getCostBreakdown → getMoneyFlowDecomposition + the canonical GGR
 * type sets + the gaming-margin contributor sweep), so the figures
 * reconcile by construction with /ggr, /dashboard, and the
 * /insights/analytics Money Flow tab. Cross-consistency is the point —
 * if this page says bonuses = $X, /insights/rewards agrees.
 *
 * House-POV throughout (CLAUDE.md): money flowing BACK to users (every
 * cost line) is rose; the house's gross margin (GGR) and realized P&L
 * are emerald when positive, rose when negative. Inventory + voucher
 * liability are surfaced as prominent first-class lines because they're
 * the big "hidden" leaks the operator keeps not seeing — GGR can be
 * positive while P&L is thin precisely because users are holding cards
 * (unrealized winnings the house still owes).
 */
export default async function CostBreakdownPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/insights/cost-breakdown");
  const params = await searchParams;
  const period = parseInsightsPeriod(params.period);
  const periodLabel = INSIGHTS_PERIOD_LABELS[period];

  const { data, error } = await safeQuery(
    () => getCostBreakdown(period, periodLabel, 10),
    null,
    "insights.costBreakdown",
  );

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={TrendingDown}
            accent="rose"
            title="Cost Breakdown"
            subtitle="Where the wager goes — full P&L leakage analysis"
          />
          <div className="flex flex-wrap items-center gap-2">
            <CostBreakdownPeriodFilter />
            <ExportButton page="cost-breakdown" params={{ period }} />
          </div>
        </div>
      </PageHero>

      {error || !data ? (
        <TileErrorFallback
          label="Cost Breakdown"
          hint="The cost-breakdown aggregation failed. Server logs hold the digest."
          size="panel"
        />
      ) : (
        <FadeIn>
          <div className="space-y-6">
            <Narrative data={data} periodLabel={periodLabel} />
            <HeroKpis data={data} periodLabel={periodLabel} />

            <section className="space-y-3">
              <SectionHeading
                icon={Scale}
                title={`The waterfall — wager → P&L · ${periodLabel}`}
              />
              <WaterfallPanel data={data} />
            </section>

            <section className="space-y-3">
              <SectionHeading
                icon={ListOrdered}
                title={`Cost categories ranked · ${periodLabel}`}
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
                  title={`Who drove the gaming margin · ${periodLabel}`}
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
      )}
    </div>
  );
}

// ─── Narrative ──────────────────────────────────────────────────────

/**
 * The headline answer in plain English. Names the gross margin, the
 * total handed back, the share tied up in inventory/vouchers, the
 * realized P&L, and the single biggest leak.
 */
function Narrative({
  data,
  periodLabel,
}: {
  data: CostBreakdown;
  periodLabel: string;
}) {
  const heldUp = data.inventoryDelta + data.voucherDelta;
  const backToUsers =
    data.gamingPayouts + data.rewardPayouts + data.cardWithdrawals;
  const leak = data.biggestLeak;
  return (
    <div className="rounded-2xl border border-rose-500/20 bg-rose-500/[0.04] p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="shrink-0 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2">
          <TrendingDown className="size-4 text-rose-500" />
        </div>
        <div className="space-y-1.5 text-sm leading-relaxed">
          <p>
            Of{" "}
            <span className="font-semibold">
              {formatCurrency(data.totalWager)}
            </span>{" "}
            wagered in {periodLabel.toLowerCase()}, the house edge captured{" "}
            <span className="font-semibold text-emerald-600 dark:text-emerald-400">
              {formatCurrency(data.ggr)}
            </span>{" "}
            in gaming margin (GGR).{" "}
            <span className="font-semibold text-rose-600 dark:text-rose-400">
              {formatCurrency(backToUsers)}
            </span>{" "}
            went back to users as winnings, bonuses, prizes and shipped cards;{" "}
            <span className="font-semibold text-rose-600 dark:text-rose-400">
              {formatCurrency(heldUp)}
            </span>{" "}
            is tied up in cards and vouchers users still hold — leaving{" "}
            <span
              className={cn(
                "font-semibold",
                data.pnl >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400",
              )}
            >
              {formatCurrency(data.pnl)}
            </span>{" "}
            realized.
          </p>
          {leak && (
            <p className="text-xs text-muted-foreground">
              The biggest leak is{" "}
              <span className="font-medium text-foreground">{leak.label}</span>{" "}
              at{" "}
              <span className="font-semibold text-rose-600 dark:text-rose-400">
                {formatCurrency(leak.amount)}
              </span>
              {data.ggr > 0 && (
                <>
                  {" "}
                  ({((leak.amount / data.ggr) * 100).toFixed(1)}% of GGR)
                </>
              )}
              . Inventory + voucher liability —{" "}
              <span className="font-medium text-foreground">
                {formatCurrency(heldUp)}
              </span>{" "}
              — is the hidden cost most easily missed: it&apos;s why GGR can be
              healthy while realized P&L stays thin.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Hero KPIs ──────────────────────────────────────────────────────

function HeroKpis({
  data,
  periodLabel,
}: {
  data: CostBreakdown;
  periodLabel: string;
}) {
  const ggrPos = data.ggr >= 0;
  const pnlPos = data.pnl >= 0;
  return (
    <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
      <KpiTile
        label="Total wager"
        value={formatCurrency(data.totalWager)}
        sub={`${periodLabel} · customer wager`}
        icon={Coins}
        accent="blue"
      />
      <KpiTile
        label="GGR (gaming margin)"
        value={`${ggrPos ? "+" : "−"}${formatCurrency(Math.abs(data.ggr))}`}
        sub={
          data.margin.ggrPctOfWager !== null
            ? `${data.margin.ggrPctOfWager.toFixed(1)}% of wager`
            : "wager − payouts"
        }
        icon={ggrPos ? TrendingUp : TrendingDown}
        accent={ggrPos ? "emerald" : "rose"}
      />
      <KpiTile
        label="Total cost (back to users)"
        value={`−${formatCurrency(data.totalCost)}`}
        sub={
          data.margin.costPctOfGgr !== null
            ? `${data.margin.costPctOfGgr.toFixed(0)}% of GGR consumed`
            : "wager − P&L"
        }
        icon={ArrowUpFromLine}
        accent="rose"
      />
      <KpiTile
        label="Net P&L (realized)"
        value={`${pnlPos ? "+" : "−"}${formatCurrency(Math.abs(data.pnl))}`}
        sub={
          data.margin.pnlPctOfWager !== null
            ? `${data.margin.pnlPctOfWager.toFixed(1)}% of wager`
            : periodLabel
        }
        icon={pnlPos ? TrendingUp : TrendingDown}
        accent={pnlPos ? "emerald" : "rose"}
      />
    </div>
  );
}

// ─── Waterfall ──────────────────────────────────────────────────────

/**
 * Maps a cost line to an accent + a server-rendered lucide icon node.
 * Cost lines (gaming / reward / liability / residual) are rose; the
 * base wager is blue; GGR + P&L flip emerald/rose on sign. Keeping the
 * icon resolution server-side keeps lucide off the client WaterfallRow
 * bundle and the accent token deterministic.
 */
function lineVisual(line: CostLine): {
  accent: AccentColor;
  sign: "+" | "−" | "=";
  icon: React.ElementType;
} {
  switch (line.kind) {
    case "base":
      return { accent: "blue", sign: "+", icon: Coins };
    case "gaming-payout":
      return { accent: "rose", sign: "−", icon: ArrowDownToLine };
    case "reward":
      return { accent: "rose", sign: "−", icon: Gift };
    case "liability":
      return {
        accent: "rose",
        sign: "−",
        icon:
          line.key === "inventory"
            ? Package
            : line.key === "voucher-liability"
              ? Ticket
              : ArrowUpFromLine,
      };
    case "residual":
      return {
        accent: line.label.startsWith("Unexplained") ? "amber" : "blue",
        sign: line.signedAmount <= 0 ? "−" : "+",
        icon: AlertCircle,
      };
    case "subtotal":
      return {
        accent: line.signedAmount >= 0 ? "emerald" : "rose",
        sign: "=",
        icon: line.signedAmount >= 0 ? TrendingUp : TrendingDown,
      };
    case "result":
      return {
        accent: line.signedAmount >= 0 ? "emerald" : "rose",
        sign: "=",
        icon: line.signedAmount >= 0 ? TrendingUp : TrendingDown,
      };
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

  return (
    <Card>
      <CardContent className="space-y-1 p-4 sm:p-5">
        {data.lines.map((line, i) => {
          const v = lineVisual(line);
          const colors = TILE_COLORS[v.accent];
          const Icon = v.icon;
          const isSubtotalOrResult =
            line.kind === "subtotal" || line.kind === "result";
          return (
            <div key={line.key}>
              {/* Divider before the GGR subtotal and before the P&L
                  result so the three bands (givebacks → GGR →
                  liabilities → P&L) read distinctly. */}
              {(line.kind === "subtotal" || line.kind === "result") &&
                i > 0 && <div className="my-2 border-t" />}
              <WaterfallRow
                label={line.label}
                why={line.why}
                signedAmount={line.signedAmount}
                sign={v.sign}
                maxMag={maxMag}
                accent={v.accent}
                pctOfGgr={line.pctOfGgr}
                pctOfWager={line.pctOfWager}
                emphasis={isSubtotalOrResult ? "strong" : "normal"}
                rank={topLeakRank.get(line.key)}
                iconNode={
                  <Icon className={cn("size-3.5", colors.icon)} />
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
                </div>
                <span className="shrink-0 font-mono text-sm font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                  −{formatCurrency(line.amount)}
                </span>
              </div>
              <div className="ml-7 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted/60">
                  <div
                    className="h-full rounded-full bg-rose-500/60"
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
                <div className="flex shrink-0 items-center gap-2 text-[10px] tabular-nums text-muted-foreground">
                  {line.pctOfGgr !== null && (
                    <span>{Math.abs(line.pctOfGgr).toFixed(1)}% GGR</span>
                  )}
                  {line.pctOfWager !== null && (
                    <span>{Math.abs(line.pctOfWager).toFixed(1)}% wager</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ─── Margin health ──────────────────────────────────────────────────

function MarginHealth({ data }: { data: CostBreakdown }) {
  const m = data.margin;
  const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);
  const ratio = (v: number | null) =>
    v === null ? "—" : `${(v * 100).toFixed(1)}%`;
  // House-POV: a HIGHER house edge / GGR%-of-wager is good for the house
  // (emerald); a higher RTP / cost-of-GGR means more flowed back to
  // users (rose). P&L survival is emerald when positive.
  return (
    <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <KpiTile
        label="RTP"
        value={ratio(m.rtp)}
        sub="Payouts ÷ wager"
        icon={ArrowDownToLine}
        accent="rose"
      />
      <KpiTile
        label="House edge"
        value={ratio(m.houseEdge)}
        sub="GGR ÷ wager"
        icon={Scale}
        accent={
          m.houseEdge !== null && m.houseEdge >= 0 ? "emerald" : "rose"
        }
      />
      <KpiTile
        label="GGR % of wager"
        value={pct(m.ggrPctOfWager)}
        sub="Gross margin rate"
        icon={Coins}
        accent={
          m.ggrPctOfWager !== null && m.ggrPctOfWager >= 0
            ? "emerald"
            : "rose"
        }
      />
      <KpiTile
        label="P&L % of wager"
        value={pct(m.pnlPctOfWager)}
        sub="Realized margin rate"
        icon={Trophy}
        accent={
          m.pnlPctOfWager !== null && m.pnlPctOfWager >= 0
            ? "emerald"
            : "rose"
        }
      />
      <KpiTile
        label="Cost % of GGR"
        value={pct(m.costPctOfGgr)}
        sub="Gross margin consumed"
        icon={ArrowUpFromLine}
        accent="rose"
      />
      <KpiTile
        label="P&L % of GGR"
        value={pct(m.pnlPctOfGgr)}
        sub="Gross margin survived"
        icon={TrendingUp}
        accent={
          m.pnlPctOfGgr !== null && m.pnlPctOfGgr >= 0 ? "emerald" : "rose"
        }
      />
    </div>
  );
}

// ─── Contributors ───────────────────────────────────────────────────

/**
 * Top users by absolute net contribution to the gross gaming margin
 * (the "who"). Reuses the same canonical wager/payout sets + filters as
 * /ggr, so this list reconciles with the GGR page's top-contributors.
 * House-POV: net > 0 (user lost) = emerald; net < 0 (user won) = rose.
 */
function Contributors({ data }: { data: CostBreakdown }) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="grid grid-cols-[2rem_1fr_repeat(3,_minmax(0,_7rem))] items-center gap-3 border-b bg-muted/30 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <span className="text-right">#</span>
          <span>User</span>
          <span className="text-right">Wager</span>
          <span className="text-right">Payouts</span>
          <span className="text-right">Net (house)</span>
        </div>
        <ul>
          {data.contributors.map((c, i) => (
            <li key={c.userId}>
              <Link
                href={`/users/${c.userId}`}
                className="grid grid-cols-[2rem_1fr_repeat(3,_minmax(0,_7rem))] items-center gap-3 border-b border-border/60 px-4 py-2.5 text-xs transition-colors last:border-b-0 hover:bg-muted/30"
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
                <span className="text-right font-mono tabular-nums text-muted-foreground">
                  {formatCurrency(c.wagerTotal)}
                </span>
                <span className="text-right font-mono tabular-nums text-muted-foreground">
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
        <p className="px-4 py-2 text-[10px] text-muted-foreground">
          Net is house-POV: positive (emerald) = the user lost (house
          profited); negative (rose) = the user won. Top{" "}
          {formatNumber(data.contributors.length)} by absolute net.
        </p>
      </CardContent>
    </Card>
  );
}
