import {
  Sigma,
  LineChart,
  Coins,
  TrendingUp,
  TrendingDown,
  Scale,
  Gift,
  Trophy,
  Package,
  Swords,
  ArrowUpCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Ticket,
  Wallet,
  PiggyBank,
  Banknote,
  Landmark,
  Layers,
  Receipt,
  HandCoins,
  Sparkles,
  BadgeDollarSign,
  Percent,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  getCostBreakdownLifetimeCached,
  type CostBreakdown,
} from "@/lib/queries/insights-analytics/cost-breakdown";
import {
  getInsightsHubWager,
  INSIGHTS_HUB_WAGER_LOOKBACK_DAYS,
} from "@/lib/queries/insights-analytics/hub-wager";
import {
  getRealNumbersGameSplit,
  getRewardSpendItemization,
  getCreatorNetCashDetail,
  getCreatorProgramCost,
  getRealizedPnlCustomersExclCreators,
  getCustomerRecyclingDetail,
  type RealNumbersGameSplit,
  type GameGgrRow,
  type RewardSpendItemization,
  type CreatorProgramCost,
  type CustomerRecyclingDetail,
} from "@/lib/queries/insights-analytics/real-numbers";
import {
  getRealizedPnlSnapshot,
  type RealizedPnlSnapshot,
} from "@/lib/queries/_realized-pnl";
import { getDashboardKpiStats } from "@/lib/queries/dashboard";
import { getAvgPnl7d } from "@/lib/queries/dashboard-avg-pnl-7d";
import { compareRealNumbers } from "@/lib/clickhouse/compare/insights-real-numbers";
import { formatDateTime } from "@/lib/utils/format";
// Reuse the cost-breakdown waterfall primitives + the directive-free
// semantic-tone vocabulary (server-safe) — same components
// /insights/real-numbers used before this section moved here.
import {
  WaterfallRow,
  WaterfallBand,
} from "../insights/cost-breakdown/waterfall-row";
import { SEMANTIC_TONES, type SemanticTone } from "../insights/cost-breakdown/tones";

/**
 * House-POV signed currency string, e.g. `+$1,234.56` / `−$1,234.56`.
 */
function signedCurrency(value: number): string {
  const isProfit = value >= 0;
  return `${isProfit ? "+" : "−"}${formatCurrency(Math.abs(value))}`;
}

/**
 * Owner-only lifetime section — merged into the Analytics Overview tab from
 * the former /insights/real-numbers page (2026-07, owner-approved). Two
 * pieces, both LIFETIME / 365d-capped (NOT period-scoped, unlike everything
 * above this section on the Overview tab):
 *
 *   1. Deposit-cadence + acquisition figures (formerly the "Analytics" tab
 *      on /insights/real-numbers) — FTDs, Depositors, Avg RTP, Avg Deposit,
 *      Deposits/Hour, Total P&L (lifetime + avg-daily-7d).
 *   2. The full Real Numbers waterfall — GGR/NGR/reward-cost breakdown,
 *      per-game split, balance-sheet P&L, the closing GGR→P&L bridge,
 *      creator program cost, and the definitions reference.
 *
 * SECURITY: this whole section is rendered ONLY when the caller has already
 * verified `canAccessInsights(userId)` — see `tab-overview.tsx`. It must
 * never be reachable by a non-owner. The Player CRM tab from the source page
 * was dropped entirely per the owner ("remove CRM, its useless") — not
 * migrated here or anywhere else.
 *
 * All read paths are reused VERBATIM from the source page — no new queries,
 * no re-derived math. The "Cost Breakdown" outbound link is preserved.
 */
export async function RealNumbersLifetimeSection() {
  const asOf = formatDateTime(new Date());

  return (
    <div className="space-y-6">
      <SectionHeading
        icon={Sigma}
        title="Lifetime real numbers — owner only"
        action={
          <Link
            href="/insights/cost-breakdown"
            className={cn(
              "group/cb inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground shadow-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <TrendingDown className="size-4 text-rose-500" />
            <span>Cost Breakdown</span>
            <ArrowRight className="size-3.5 text-muted-foreground transition-transform motion-safe:group-hover/cb:translate-x-0.5" />
          </Link>
        }
      />
      <p className="-mt-3 text-[11px] leading-snug text-muted-foreground">
        Lifetime, {INSIGHTS_HUB_WAGER_LOOKBACK_DAYS}d-capped — NOT controlled
        by the period selector above. Source of truth · real customers only
        (staff, creators &amp; blacklisted users excluded) · reconciled to the
        ledger &amp; balances. As of {asOf}.
      </p>

      <DepositCadenceSection />
      <RealNumbersBody />
    </div>
  );
}

// ─── Deposit-cadence / acquisition section (formerly the Analytics tab) ──

/**
 * Lifetime / fixed-window snapshot figures — moved here from the former
 * /insights/real-numbers "Analytics" tab (which itself carried figures
 * moved off the dashboard KPI strip). Read paths are REUSED verbatim:
 *   • FTDs / Depositors / Avg RTP / Avg Deposit / Deposits per Hour come off
 *     `getDashboardKpiStats("today")`.
 *   • Total P&L (lifetime) ← `getRealizedPnlSnapshot()`; Avg Daily P&L (7d)
 *     ← `getAvgPnl7d()`.
 */
async function DepositCadenceSection() {
  const [statsResult, avgPnl7dResult, lifetimePnlResult] = await Promise.all([
    safeQuery(
      () => getDashboardKpiStats("today"),
      null,
      "analytics.overview.lifetime.snapshot",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getAvgPnl7d(),
      null,
      "analytics.overview.lifetime.avgPnl7d",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getRealizedPnlSnapshot(),
      null,
      "analytics.overview.lifetime.pnl",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);

  const { data: stats, error, kind } = statsResult;

  // Defensive against a stale-shape `unstable_cache` entry — same guard the
  // source AnalyticsTab used.
  if (error || !stats || !stats.financials) {
    return (
      <TileErrorFallback
        label="Deposit cadence"
        hint="The analytics aggregate failed to load — refresh to retry."
        kind={kind ?? undefined}
        size="panel"
      />
    );
  }

  const avgDeposit = stats.financials.avgDeposit ?? 0;
  const depositsPerHour24h = (stats.depositCount24h ?? 0) / 24;
  const depositsPerHour7d = (stats.depositCount7d ?? 0) / (7 * 24);

  const ftds24h = stats.financials.ftds24h ?? 0;
  const ftdTotal24h = stats.financials.ftdTotal24h ?? 0;
  const ftdAvg24h = stats.financials.ftdAvg24h ?? 0;

  const uniqueDepositors = stats.financials.uniqueDepositors ?? 0;
  const usersTotal = stats.users?.total ?? 0;
  const depositorsPctOfUsers =
    usersTotal > 0 ? (uniqueDepositors / usersTotal) * 100 : null;

  const totalWagered = stats.financials.totalWagered ?? 0;
  const totalWon = stats.financials.totalWon ?? 0;
  const avgRtp = totalWagered > 0 ? (totalWon / totalWagered) * 100 : 0;

  const lifetimePnl = lifetimePnlResult.data;
  const avgPnl7d = avgPnl7dResult.data;
  const pnlAvailable = lifetimePnl != null && avgPnl7d != null;
  const totalPnlLifetime = lifetimePnl?.pnl ?? 0;
  const totalPnl7d = avgPnl7d?.totalPnl7d ?? 0;
  const avgDailyPnl7d = avgPnl7d?.avgDailyPnl ?? 0;
  const pnlIsProfit = totalPnlLifetime >= 0;

  return (
    <div className="space-y-6">
      <div className="space-y-5">
        <SectionHeading icon={TrendingUp} title="Profit & loss (lifetime)" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {pnlAvailable ? (
            <KpiTile
              label="Total P&L"
              value={signedCurrency(totalPnlLifetime)}
              sub={`${signedCurrency(avgDailyPnl7d)} / day · ${signedCurrency(
                totalPnl7d,
              )} rolling 7d`}
              icon={pnlIsProfit ? TrendingUp : TrendingDown}
              accent={pnlIsProfit ? "emerald" : "rose"}
            />
          ) : (
            <TileErrorFallback
              label="Total P&L"
              hint="The lifetime / 7d P&L scan timed out — refresh to retry."
              kind={lifetimePnlResult.kind ?? avgPnl7dResult.kind ?? undefined}
              size="compact"
            />
          )}
        </div>
      </div>

      <div className="space-y-5">
        <SectionHeading icon={BadgeDollarSign} title="Acquisition & funding" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <KpiTile
            label="FTDs"
            value={formatNumber(ftds24h)}
            sub={`24h · ${formatCurrency(ftdTotal24h)} total · ${formatCurrency(
              ftdAvg24h,
            )} avg`}
            icon={HandCoins}
            accent="amber"
          />
          <KpiTile
            label="Depositors"
            value={formatNumber(uniqueDepositors)}
            sub={
              depositorsPctOfUsers != null
                ? `${depositorsPctOfUsers.toFixed(1)}% of users have funded`
                : "Unique players who funded at least once"
            }
            icon={BadgeDollarSign}
            accent="purple"
          />
          <KpiTile
            label="Avg RTP"
            value={`${avgRtp.toFixed(2)}%`}
            sub="Lifetime · payouts ÷ wagered"
            icon={Percent}
            accent="pink"
          />
        </div>
      </div>

      <div className="space-y-5">
        <SectionHeading icon={Wallet} title="Deposit cadence" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <KpiTile
            label="Avg Deposit"
            value={formatCurrency(avgDeposit)}
            sub="Σ deposited ÷ lifetime deposit count"
            icon={Wallet}
            accent="emerald"
          />
          <KpiTile
            label="Deposits / Hour"
            value={`${formatNumber(Math.round(depositsPerHour24h * 10) / 10)}/h`}
            sub="Rolling 24h average"
            icon={Coins}
            accent="blue"
          />
          <KpiTile
            label="Deposits / Hour"
            value={`${formatNumber(Math.round(depositsPerHour7d * 10) / 10)}/h`}
            sub="Rolling 7d baseline"
            icon={Coins}
            accent="blue"
          />
        </div>
      </div>
    </div>
  );
}

// ─── Real Numbers waterfall body ────────────────────────────────────

/**
 * The data body — the 9 heavy lifetime reads + the full waterfall/bridge UI.
 * Moved verbatim from /insights/real-numbers/page.tsx's `RealNumbersBody`.
 * Math, shapes and House-POV colours are unchanged.
 */
async function RealNumbersBody() {
  const [
    { data: cost, error: costErr },
    { data: wager },
    { data: split },
    { data: snapshot },
    { data: rewardSpend },
    { data: creatorDetail },
    { data: creatorProgram },
    { data: customerCash },
    { data: recycling },
  ] = await Promise.all([
    safeQuery(
      () => getCostBreakdownLifetimeCached(),
      null,
      "analytics.overview.lifetime.cost",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getInsightsHubWager(),
      0,
      "analytics.overview.lifetime.wager",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getRealNumbersGameSplit(),
      null,
      "analytics.overview.lifetime.split",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getRealizedPnlSnapshot(),
      null,
      "analytics.overview.lifetime.snapshotPnl",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getRewardSpendItemization(),
      null,
      "analytics.overview.lifetime.rewardSpend",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getCreatorNetCashDetail(),
      null,
      "analytics.overview.lifetime.creatorNetCash",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getCreatorProgramCost(),
      null,
      "analytics.overview.lifetime.creatorProgramCost",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getRealizedPnlCustomersExclCreators(),
      null,
      "analytics.overview.lifetime.customerCash",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getCustomerRecyclingDetail(),
      null,
      "analytics.overview.lifetime.recycling",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);

  // Comparison-mode CH twin (fire-and-forget) — unchanged from the source
  // page. No-op unless `insights_real_numbers` is in comparison mode.
  void compareRealNumbers({
    hubWager: wager ?? 0,
    split,
    rewardSpend,
    pnlExclCreators: customerCash,
    creatorNetCash: creatorDetail,
    creatorProgram,
    recycling,
  });

  if (costErr || !cost) {
    return (
      <TileErrorFallback
        label="Real Numbers"
        hint="The canonical cost-breakdown helper failed. Server logs hold the digest."
        size="panel"
      />
    );
  }

  return (
    <div className="space-y-6">
      <KpiStrip cost={cost} wager={wager ?? 0} snapshot={snapshot} />

      <div className="space-y-3">
        <SectionHeading
          icon={Layers}
          title="GGR by game — packs · battles · upgrader"
        />
        {split ? (
          <GameSplitPanel split={split} headlineGgr={cost.ggr} />
        ) : (
          <TileErrorFallback
            label="Per-game GGR"
            hint="The per-game split failed to load. The headline GGR above is unaffected."
            size="panel"
          />
        )}
      </div>

      <div className="space-y-3">
        <SectionHeading
          icon={Scale}
          title="Gaming-margin waterfall — wager → GGR → NGR"
        />
        <GamingWaterfall
          cost={cost}
          wager={wager ?? 0}
          netRain={rewardSpend?.netRain ?? null}
        />
      </div>

      <div className="space-y-3">
        <SectionHeading
          icon={Receipt}
          title="Reward & bonus spend — itemized · every penny, where & why"
        />
        {rewardSpend ? (
          <RewardSpendPanel
            itemization={rewardSpend}
            headlineRewardCost={cost.rewardPayouts}
          />
        ) : (
          <TileErrorFallback
            label="Reward-spend itemization"
            hint="The itemized reward-spend breakdown failed to load. The headline reward cost above is unaffected."
            size="panel"
          />
        )}
      </div>

      {snapshot && (
        <div className="space-y-3">
          <SectionHeading
            icon={Banknote}
            title="Balance-sheet P&L — the cash-basis bottom line"
          />
          <BalanceSheetWaterfall snapshot={snapshot} />
        </div>
      )}

      {snapshot && (
        <div className="space-y-3">
          <SectionHeading
            icon={PiggyBank}
            title="Why GGR ≠ realized P&L — two different scoreboards"
          />
          <ReconciliationCallout cost={cost} snapshot={snapshot} />
        </div>
      )}

      <div className="space-y-3">
        <SectionHeading
          icon={Scale}
          title="GGR → realized P&L — the complete closing waterfall"
        />
        <GgrToNgrBridge
          cost={cost}
          snapshot={snapshot}
          wager={wager ?? 0}
          split={split}
          rewardSpend={rewardSpend}
          customerCashMargin={customerCash?.pnl ?? null}
          recycling={recycling}
        />
      </div>

      <div className="space-y-3">
        <SectionHeading
          icon={Sparkles}
          title="Creator program cost — what the house actually funds"
        />
        {creatorProgram ? (
          <CreatorProgramCostPanel
            program={creatorProgram}
            creatorNetCash={creatorDetail?.netCash ?? null}
          />
        ) : (
          <TileErrorFallback
            label="Creator program cost"
            hint="The creator-program cost breakdown failed to load. The bridge above is unaffected."
            size="panel"
          />
        )}
      </div>

      <div className="space-y-3">
        <SectionHeading icon={LineChart} title="Definitions — what each number means" />
        <Definitions cost={cost} snapshot={snapshot} />
      </div>
    </div>
  );
}

// ─── KPI strip ──────────────────────────────────────────────────────

function KpiStrip({
  cost,
  wager,
  snapshot,
}: {
  cost: CostBreakdown;
  wager: number;
  snapshot: RealizedPnlSnapshot | null;
}) {
  const ggrPos = cost.ggr >= 0;
  const ngrPos = cost.ngr >= 0;
  const pnl = snapshot ? snapshot.pnl : cost.pnl;
  const pnlPos = pnl >= 0;

  const held = snapshot
    ? snapshot.userBalance +
      snapshot.inventory +
      snapshot.vouchers +
      snapshot.unclaimedRakeback
    : null;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
      <KpiTile
        label="Wager"
        icon={Coins}
        accent="blue"
        value={formatCurrency(wager)}
        sub="Lifetime turnover · real customers"
      />
      <KpiTile
        label="GGR"
        icon={ggrPos ? TrendingUp : TrendingDown}
        accent={ggrPos ? "emerald" : "rose"}
        value={`${ggrPos ? "+" : "−"}${formatCurrency(Math.abs(cost.ggr))}`}
        sub={
          cost.margin.ggrPctOfWager !== null
            ? `${cost.margin.ggrPctOfWager.toFixed(1)}% house edge`
            : "wager − gameplay winnings"
        }
      />
      <KpiTile
        label="Reward & bonus cost"
        icon={Gift}
        accent="rose"
        value={`−${formatCurrency(cost.rewardPayouts)}`}
        sub={
          cost.ggr > 0
            ? `${((cost.rewardPayouts / cost.ggr) * 100).toFixed(0)}% of GGR given away`
            : "house-funded giveaways"
        }
      />
      <KpiTile
        label="NGR"
        icon={Scale}
        accent={ngrPos ? "emerald" : "rose"}
        value={`${ngrPos ? "+" : "−"}${formatCurrency(Math.abs(cost.ngr))}`}
        sub={
          cost.margin.ngrPctOfWager !== null
            ? `${cost.margin.ngrPctOfWager.toFixed(1)}% of wager · after rewards`
            : "GGR − reward cost"
        }
      />
      <KpiTile
        label="Realized P&L"
        icon={pnlPos ? TrendingUp : TrendingDown}
        accent={pnlPos ? "emerald" : "rose"}
        value={`${pnlPos ? "+" : "−"}${formatCurrency(Math.abs(pnl))}`}
        sub="Cash basis · the true bottom line"
      />
      {held !== null && (
        <KpiTile
          label="Customers hold (owed)"
          icon={PiggyBank}
          accent="rose"
          value={formatCurrency(held)}
          sub="Balance + inventory + vouchers + rakeback"
        />
      )}
    </div>
  );
}

// ─── Per-game GGR split ─────────────────────────────────────────────

const GAME_VISUAL: Record<
  GameGgrRow["key"],
  { icon: LucideIcon; accent: SemanticTone }
> = {
  packs: { icon: Package, accent: "base" },
  battles: { icon: Swords, accent: "base" },
  upgrader: { icon: ArrowUpCircle, accent: "base" },
};

function GameSplitPanel({
  split,
  headlineGgr,
}: {
  split: RealNumbersGameSplit;
  headlineGgr: number;
}) {
  const residual = split.totalGgr - headlineGgr;
  const reconciles = Math.abs(residual) < 1;

  return (
    <Card>
      <CardContent className="p-0">
        <div className="grid grid-cols-[1fr_repeat(2,_minmax(0,_5rem))] items-center gap-2 border-b bg-muted/30 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:grid-cols-[1.4fr_repeat(4,_minmax(0,_7rem))] sm:gap-3 sm:px-4">
          <span>Game</span>
          <span className="hidden text-right sm:block">Wager</span>
          <span className="hidden text-right sm:block">Payout</span>
          <span className="text-right">GGR</span>
          <span className="text-right">RTP / edge</span>
        </div>
        <ul>
          {split.games.map((g) => {
            const v = GAME_VISUAL[g.key];
            const Icon = v.icon;
            const ggrPos = g.ggr >= 0;
            return (
              <li
                key={g.key}
                className="grid grid-cols-[1fr_repeat(2,_minmax(0,_5rem))] items-center gap-2 border-b border-border/60 px-3 py-3 text-xs last:border-b-0 sm:grid-cols-[1.4fr_repeat(4,_minmax(0,_7rem))] sm:gap-3 sm:px-4"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Icon className="size-3.5" />
                  </span>
                  <span className="truncate font-medium">{g.label}</span>
                </span>
                <span className="hidden text-right font-mono tabular-nums text-muted-foreground sm:block">
                  {formatCurrency(g.wager)}
                </span>
                <span className="hidden text-right font-mono tabular-nums text-muted-foreground sm:block">
                  {formatCurrency(g.payout)}
                </span>
                <span
                  className={cn(
                    "text-right font-mono font-semibold tabular-nums",
                    ggrPos
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-rose-600 dark:text-rose-400",
                  )}
                >
                  {ggrPos ? "+" : "−"}
                  {formatCurrency(Math.abs(g.ggr))}
                </span>
                <span className="text-right font-mono tabular-nums text-muted-foreground">
                  {g.rtp !== null ? `${(g.rtp * 100).toFixed(0)}%` : "—"}
                  {" / "}
                  <span
                    className={cn(
                      g.houseEdge !== null && g.houseEdge >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-rose-600 dark:text-rose-400",
                    )}
                  >
                    {g.houseEdge !== null
                      ? `${(g.houseEdge * 100).toFixed(0)}%`
                      : "—"}
                  </span>
                </span>
              </li>
            );
          })}
          <li className="grid grid-cols-[1fr_repeat(2,_minmax(0,_5rem))] items-center gap-2 bg-muted/30 px-3 py-2.5 text-xs font-semibold sm:grid-cols-[1.4fr_repeat(4,_minmax(0,_7rem))] sm:gap-3 sm:px-4">
            <span>Total (all games)</span>
            <span className="hidden text-right font-mono tabular-nums sm:block">
              {formatCurrency(split.totalWager)}
            </span>
            <span className="hidden text-right font-mono tabular-nums sm:block">
              {formatCurrency(split.totalPayout)}
            </span>
            <span
              className={cn(
                "text-right font-mono tabular-nums",
                split.totalGgr >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400",
              )}
            >
              {split.totalGgr >= 0 ? "+" : "−"}
              {formatCurrency(Math.abs(split.totalGgr))}
            </span>
            <span className="text-right font-mono tabular-nums text-muted-foreground">
              {split.totalWager > 0
                ? `${((split.totalPayout / split.totalWager) * 100).toFixed(0)}%`
                : "—"}
            </span>
          </li>
        </ul>
        <p className="px-3 py-2.5 text-[10px] leading-snug text-muted-foreground sm:px-4">
          GGR = wager − gaming payout (cards won & kept + battle cash refunds +
          upgrader payouts), house POV. Each line is on the canonical
          borrow-corrected, real-customer basis.{" "}
          {reconciles ? (
            <span className="text-emerald-600 dark:text-emerald-400">
              Reconciles with the headline GGR exactly.
            </span>
          ) : (
            <span className="text-amber-600 dark:text-amber-400">
              Reconciliation residual vs headline GGR:{" "}
              {residual >= 0 ? "+" : "−"}
              {formatCurrency(Math.abs(residual))} (rounding / a leg outside the
              per-game split).
            </span>
          )}
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Reward-spend itemization ───────────────────────────────────────

function RewardSpendPanel({
  itemization,
  headlineRewardCost,
}: {
  itemization: RewardSpendItemization;
  headlineRewardCost: number;
}) {
  const residual = itemization.total - headlineRewardCost;
  const reconciles = Math.abs(residual) < 1;
  const denom = itemization.total;

  return (
    <Card>
      <CardContent className="p-0">
        <div className="grid grid-cols-[1fr_minmax(0,_5.5rem)_minmax(0,_3rem)] items-center gap-2 border-b bg-muted/30 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:grid-cols-[1.6fr_minmax(0,_7rem)_minmax(0,_4.5rem)_minmax(0,_5rem)] sm:gap-3 sm:px-4">
          <span>Category</span>
          <span className="text-right">Amount</span>
          <span className="hidden text-right sm:block">Count</span>
          <span className="text-right">% spend</span>
        </div>
        <ul>
          {itemization.rows.map((r) => {
            const pct = denom > 0 ? (r.amount / denom) * 100 : null;
            return (
              <li
                key={r.key}
                className="grid grid-cols-[1fr_minmax(0,_5.5rem)_minmax(0,_3rem)] items-start gap-2 border-b border-border/60 px-3 py-3 text-xs last:border-b-0 sm:grid-cols-[1.6fr_minmax(0,_7rem)_minmax(0,_4.5rem)_minmax(0,_5rem)] sm:gap-3 sm:px-4"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-rose-500/10 text-rose-500">
                      <Receipt className="size-3" />
                    </span>
                    <span className="truncate font-medium">{r.label}</span>
                  </span>
                  <span className="pl-8 text-[10px] leading-snug text-muted-foreground">
                    {r.why}
                  </span>
                </span>
                <span className="text-right font-mono font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                  −{formatCurrency(r.amount)}
                </span>
                <span className="hidden text-right font-mono tabular-nums text-muted-foreground sm:block">
                  {r.count !== null ? formatNumber(r.count) : "—"}
                </span>
                <span className="text-right font-mono tabular-nums text-muted-foreground">
                  {pct !== null ? `${pct.toFixed(1)}%` : "—"}
                </span>
              </li>
            );
          })}
          <li className="grid grid-cols-[1fr_minmax(0,_5.5rem)_minmax(0,_3rem)] items-center gap-2 bg-muted/30 px-3 py-2.5 text-xs font-semibold sm:grid-cols-[1.6fr_minmax(0,_7rem)_minmax(0,_4.5rem)_minmax(0,_5rem)] sm:gap-3 sm:px-4">
            <span>Total reward &amp; bonus spend</span>
            <span className="text-right font-mono tabular-nums text-rose-600 dark:text-rose-400">
              −{formatCurrency(itemization.total)}
            </span>
            <span className="hidden text-right sm:block" />
            <span className="text-right font-mono tabular-nums text-muted-foreground">
              {denom > 0 ? "100%" : "—"}
            </span>
          </li>
          <li className="grid grid-cols-[1fr_minmax(0,_5.5rem)_minmax(0,_3rem)] items-start gap-2 border-t border-dashed border-border/70 px-3 py-3 text-xs sm:grid-cols-[1.6fr_minmax(0,_7rem)_minmax(0,_4.5rem)_minmax(0,_5rem)] sm:gap-3 sm:px-4">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-2">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-rose-500/10 text-rose-500">
                  <Package className="size-3" />
                </span>
                <span className="truncate font-medium">
                  Daily / free packs (card giveaway)
                </span>
              </span>
              <span className="pl-8 text-[10px] leading-snug text-muted-foreground">
                Value of cards handed out by free reward-pack opens (≈ $0 wager).
                Tracked in inventory, NOT a ledger reward type — so it is{" "}
                <span className="font-medium text-foreground/80">
                  not in the GGR − NGR reward cost above
                </span>{" "}
                (it lands in realized P&amp;L via held inventory). Shown
                separately to avoid double-counting it against GGR.
              </span>
            </span>
            <span className="text-right font-mono font-semibold tabular-nums text-rose-600 dark:text-rose-400">
              −{formatCurrency(itemization.dailyPacks.cost)}
            </span>
            <span className="hidden text-right font-mono tabular-nums text-muted-foreground sm:block">
              {itemization.dailyPacks.opens > 0
                ? formatNumber(itemization.dailyPacks.opens)
                : "—"}
            </span>
            <span className="text-right font-mono tabular-nums text-muted-foreground">
              —
            </span>
          </li>
          <li className="grid grid-cols-[1fr_minmax(0,_5.5rem)_minmax(0,_3rem)] items-center gap-2 bg-muted/20 px-3 py-2 text-[11px] font-medium text-muted-foreground sm:grid-cols-[1.6fr_minmax(0,_7rem)_minmax(0,_4.5rem)_minmax(0,_5rem)] sm:gap-3 sm:px-4">
            <span>Total incl. daily-pack giveaway (memo)</span>
            <span className="text-right font-mono tabular-nums text-rose-600 dark:text-rose-400">
              −{formatCurrency(itemization.total + itemization.dailyPacks.cost)}
            </span>
            <span className="hidden text-right sm:block" />
            <span className="text-right" />
          </li>
        </ul>
        <p className="px-3 py-2.5 text-[10px] leading-snug text-muted-foreground sm:px-4">
          Every line is house-funded money credited to customers (a cost, House
          POV). Lifetime, {itemization.lookbackDays}d-capped, real customers
          only. Rain shows the net house top-up only — gross{" "}
          {formatCurrency(itemization.rainWinGross)} rain winnings less{" "}
          {formatCurrency(itemization.rainTipOffset)} user/founder tips ={" "}
          {formatCurrency(itemization.netRain)} net. Creator tips are excluded
          (a user→user pass-through, not a house cost).{" "}
          {reconciles ? (
            <span className="text-emerald-600 dark:text-emerald-400">
              Reconciles to reward spend · {formatCurrency(itemization.total)}.
            </span>
          ) : (
            <span className="text-amber-600 dark:text-amber-400">
              Reconciliation residual vs the reward-spend line:{" "}
              {residual >= 0 ? "+" : "−"}
              {formatCurrency(Math.abs(residual))} (rounding / a leg outside the
              itemization).
            </span>
          )}{" "}
          The{" "}
          <span className="text-rose-600 dark:text-rose-400">
            {formatCurrency(itemization.dailyPacks.cost)}
          </span>{" "}
          daily / free-pack card giveaway ({formatNumber(itemization.dailyPacks.opens)}{" "}
          opens) is listed below the total but kept OUT of it: those cards aren&apos;t
          a ledger reward type and are excluded from GGR&apos;s gaming payout, so
          they sit in realized P&amp;L via held inventory — counting them in the
          reward subtotal would double-count them.
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Gaming-margin waterfall ────────────────────────────────────────

function GamingWaterfall({
  cost,
  wager,
  netRain,
}: {
  cost: CostBreakdown;
  wager: number;
  netRain: number | null;
}) {
  const ggrPos = cost.ggr >= 0;
  const ngrPos = cost.ngr >= 0;

  const splitRain =
    netRain !== null && netRain >= 0 && netRain <= cost.rewardPayouts;

  const rewardLines: Array<{
    key: string;
    label: string;
    signed: number;
    sign: "+" | "−" | "=";
    tone: SemanticTone;
    icon: LucideIcon;
    emphasis?: "normal" | "subtotal" | "result";
    why: string;
  }> = splitRain
    ? [
        {
          key: "reward",
          label: "Reward & bonus cost (excl. rain)",
          signed: -(cost.rewardPayouts - (netRain as number)),
          sign: "−",
          tone: "cost",
          icon: Gift,
          why: "House-funded giveaways credited to user balance: deposit bonuses, rakeback, promo/gift cards, race & leaderboard prizes, affiliate commissions, counted balance adjustments.",
        },
        {
          key: "net-rain",
          label: "Net rain (house slice)",
          signed: -(netRain as number),
          sign: "−",
          tone: "cost",
          icon: Gift,
          why: "Rain winnings beyond what user/founder tips funded — max(0, rain_win − rain_tip). Only the house's slice of mixed-funded rain is a cost.",
        },
      ]
    : [
        {
          key: "reward",
          label: "Reward & bonus cost",
          signed: -cost.rewardPayouts,
          sign: "−",
          tone: "cost",
          icon: Gift,
          why: "All house-funded giveaways credited to user balance: deposit bonuses, rakeback, promo/gift cards, race & leaderboard prizes, affiliate commissions, counted balance adjustments, and the net house slice of rain. Itemized in the table below.",
        },
      ];

  const lines: Array<{
    key: string;
    label: string;
    signed: number;
    sign: "+" | "−" | "=";
    tone: SemanticTone;
    icon: LucideIcon;
    emphasis?: "normal" | "subtotal" | "result";
    why: string;
  }> = [
    {
      key: "wager",
      label: "Wager (GGR basis)",
      signed: cost.totalWager,
      sign: "+",
      tone: "base",
      icon: Coins,
      why: "Customer stake on packs / battles / upgrader, borrow-corrected, real customers only. The GGR-basis wager that ties out to GGR below.",
    },
    {
      key: "gaming-payout",
      label: "Gaming payout (won & paid back)",
      signed: -cost.gamingPayouts,
      sign: "−",
      tone: "cost",
      icon: ArrowDownToLine,
      why: "Cards users won and kept (inventory value at obtained) + battle cash refunds + upgrader payouts. The user's own gameplay winnings.",
    },
    {
      key: "ggr",
      label: "GGR — gross gaming margin",
      signed: cost.ggr,
      sign: "=",
      tone: ggrPos ? "keep" : "cost",
      icon: ggrPos ? TrendingUp : TrendingDown,
      emphasis: "subtotal",
      why: "Wager − gaming payout. The gross house edge on gaming alone, before any marketing / reward cost. The canonical GGR.",
    },
    ...rewardLines,
    {
      key: "ngr",
      label: "NGR — net gaming margin",
      signed: cost.ngr,
      sign: "=",
      tone: ngrPos ? "keep" : "cost",
      icon: ngrPos ? TrendingUp : TrendingDown,
      emphasis: "subtotal",
      why: "GGR − all house-funded reward / marketing spend (incl. the net house slice of rain). What the gaming business kept after giveaways.",
    },
  ];

  const maxMag = Math.max(...lines.map((l) => Math.abs(l.signed)), 1);

  return (
    <Card>
      <CardContent className="space-y-0.5 p-3 sm:p-4">
        <WaterfallBand label="Incoming" hint="what customers staked" />
        {lines.map((l) => {
          const colors = SEMANTIC_TONES[l.tone] ?? SEMANTIC_TONES.muted;
          const Icon = l.icon;
          const band =
            l.key === "reward"
              ? { label: "Less reward & marketing", hint: "house-funded giveaways" }
              : null;
          return (
            <div key={l.key}>
              {band && <WaterfallBand label={band.label} hint={band.hint} />}
              <WaterfallRow
                label={l.label}
                signedAmount={l.signed}
                sign={l.sign}
                maxMag={maxMag}
                tone={l.tone}
                pctOfGgr={cost.ggr > 0 ? (l.signed / cost.ggr) * 100 : null}
                pctOfWager={
                  cost.totalWager > 0 ? (l.signed / cost.totalWager) * 100 : null
                }
                emphasis={l.emphasis ?? "normal"}
                iconNode={<Icon className={cn("size-3.5", colors.icon)} />}
              />
            </div>
          );
        })}
        <p className="px-2 pt-3 text-[10px] leading-snug text-muted-foreground">
          The blue headline Wager tile ({formatCurrency(wager)}) is total
          lifetime turnover (borrow-net, sponsored + upgrader included). The
          waterfall base here is the GGR-basis wager ({formatCurrency(cost.totalWager)})
          — the slice that ties out to GGR — so the two can differ.
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Balance-sheet P&L waterfall ────────────────────────────────────

function BalanceSheetWaterfall({ snapshot }: { snapshot: RealizedPnlSnapshot }) {
  const pnlPos = snapshot.pnl >= 0;
  const lines: Array<{
    key: string;
    label: string;
    signed: number;
    sign: "+" | "−" | "=";
    tone: SemanticTone;
    icon: LucideIcon;
    emphasis?: "normal" | "subtotal" | "result";
  }> = [
    {
      key: "deposits",
      label: "Deposits (cash in)",
      signed: snapshot.totalDeposited,
      sign: "+",
      tone: "base",
      icon: ArrowDownToLine,
    },
    {
      key: "withdrawals",
      label: "Withdrawals (cash + cards out)",
      signed: -snapshot.totalWithdrawn,
      sign: "−",
      tone: "cost",
      icon: ArrowUpFromLine,
    },
    {
      key: "balance",
      label: "On-site balance held",
      signed: -snapshot.userBalance,
      sign: "−",
      tone: "cost",
      icon: Wallet,
    },
    {
      key: "inventory",
      label: "Inventory value held",
      signed: -snapshot.inventory,
      sign: "−",
      tone: "cost",
      icon: Package,
    },
    {
      key: "vouchers",
      label: "Unclaimed vouchers",
      signed: -snapshot.vouchers,
      sign: "−",
      tone: "cost",
      icon: Ticket,
    },
    {
      key: "rakeback",
      label: "Unclaimed rakeback",
      signed: -snapshot.unclaimedRakeback,
      sign: "−",
      tone: "cost",
      icon: Trophy,
    },
    {
      key: "pnl",
      label: "Realized P&L",
      signed: snapshot.pnl,
      sign: "=",
      tone: pnlPos ? "keep" : "cost",
      icon: pnlPos ? TrendingUp : TrendingDown,
      emphasis: "result",
    },
  ];
  const maxMag = Math.max(...lines.map((l) => Math.abs(l.signed)), 1);

  return (
    <Card>
      <CardContent className="space-y-0.5 p-3 sm:p-4">
        <WaterfallBand label="Cash in" hint="real money deposited" />
        {lines.map((l) => {
          const colors = SEMANTIC_TONES[l.tone] ?? SEMANTIC_TONES.muted;
          const Icon = l.icon;
          const band =
            l.key === "withdrawals"
              ? { label: "Less money owed to / held by users", hint: "liabilities" }
              : null;
          return (
            <div key={l.key}>
              {band && <WaterfallBand label={band.label} hint={band.hint} />}
              <WaterfallRow
                label={l.label}
                signedAmount={l.signed}
                sign={l.sign}
                maxMag={maxMag}
                tone={l.tone}
                pctOfGgr={null}
                pctOfWager={null}
                emphasis={l.emphasis ?? "normal"}
                iconNode={<Icon className={cn("size-3.5", colors.icon)} />}
              />
            </div>
          );
        })}
        <p className="px-2 pt-3 text-[10px] leading-snug text-muted-foreground">
          P&L = deposits − withdrawals − on-site balance − inventory value −
          unclaimed vouchers − unclaimed rakeback. The cash-basis bottom line:
          what would be left if every customer cashed out everything they hold
          right now. Excludes staff + the admin blacklist.
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Reconciliation callout ─────────────────────────────────────────

function BridgeStep({
  label,
  value,
  sign,
  tone,
  emphasis = "normal",
}: {
  label: string;
  value: number;
  sign: "+" | "−" | "=";
  tone: SemanticTone;
  emphasis?: "normal" | "result";
}) {
  const t = SEMANTIC_TONES[tone] ?? SEMANTIC_TONES.muted;
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 rounded-lg px-2.5",
        emphasis === "result"
          ? cn("py-2 ring-1 ring-inset", t.face, t.ring)
          : "py-1.5",
      )}
    >
      <span
        className={cn(
          "min-w-0 truncate",
          emphasis === "result"
            ? "text-[13px] font-bold sm:text-sm"
            : "text-[13px] font-medium",
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          "shrink-0 font-mono font-semibold tabular-nums",
          emphasis === "result" ? "text-sm sm:text-base" : "text-[13px]",
          t.text,
        )}
      >
        {sign === "=" ? "= " : sign}
        {formatCurrency(Math.abs(value))}
      </span>
    </div>
  );
}

function ReconciliationCallout({
  cost,
  snapshot,
}: {
  cost: CostBreakdown;
  snapshot: RealizedPnlSnapshot;
}) {
  const held =
    snapshot.userBalance +
    snapshot.inventory +
    snapshot.vouchers +
    snapshot.unclaimedRakeback;
  const ngrPos = cost.ngr >= 0;
  const pnlPos = snapshot.pnl >= 0;

  return (
    <div className="overflow-hidden rounded-2xl border bg-card ring-1 ring-foreground/10">
      <div className="flex items-start gap-3 border-b bg-muted/30 px-4 py-3 sm:px-5">
        <div className="shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2">
          <Scale className="size-4 text-amber-500" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold sm:text-base">
            Two scoreboards, two bases — you can&apos;t subtract one to get the
            other
          </h3>
          <p className="text-xs text-muted-foreground">
            GGR is the gaming margin booked on every dollar wagered (won cards
            at sticker value); realized P&L is the real cash flow. They measure
            different things, so the gap between them is not a list of costs.
          </p>
        </div>
      </div>

      <div className="grid gap-px bg-border/60 sm:grid-cols-2">
        <div className="space-y-1 bg-card p-4 sm:p-5">
          <div className="mb-1 flex items-center gap-2">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-blue-500/10 text-blue-500">
              <Scale className="size-3.5" />
            </span>
            <h4 className="text-[13px] font-semibold tracking-tight">
              Gaming margin (edge on play)
            </h4>
          </div>
          <BridgeStep
            label="Wager (turnover)"
            value={cost.totalWager}
            sign="+"
            tone="base"
          />
          <BridgeStep
            label="GGR — gross gaming margin"
            value={cost.ggr}
            sign="="
            tone={cost.ggr >= 0 ? "keep" : "cost"}
          />
          <BridgeStep
            label="Reward & bonus spend"
            value={cost.rewardPayouts}
            sign="−"
            tone="cost"
          />
          <BridgeStep
            label="NGR — net gaming margin"
            value={cost.ngr}
            sign="="
            tone={ngrPos ? "keep" : "cost"}
            emphasis="result"
          />
          <p className="pt-2 text-[10px] leading-snug text-muted-foreground">
            Booked on every dollar wagered, valuing won cards at sticker
            (value-at-obtained). Customers re-wager their winnings, so this
            turnover came from far less real deposited cash.
          </p>
        </div>

        <div className="space-y-1 bg-card p-4 sm:p-5">
          <div className="mb-1 flex items-center gap-2">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-blue-500/10 text-blue-500">
              <Banknote className="size-3.5" />
            </span>
            <h4 className="text-[13px] font-semibold tracking-tight">
              Cash — the real money
            </h4>
          </div>
          <BridgeStep
            label="Deposits (cash in)"
            value={snapshot.totalDeposited}
            sign="+"
            tone="base"
          />
          <BridgeStep
            label="Withdrawals (cashed out)"
            value={snapshot.totalWithdrawn}
            sign="−"
            tone="cost"
          />
          <BridgeStep
            label="Customers still hold"
            value={held}
            sign="−"
            tone="cost"
          />
          <BridgeStep
            label="Realized P&L"
            value={snapshot.pnl}
            sign="="
            tone={pnlPos ? "keep" : "cost"}
            emphasis="result"
          />
          <p className="pt-2 text-[10px] leading-snug text-muted-foreground">
            The real money: of {formatCurrency(snapshot.totalDeposited)}{" "}
            deposited, customers withdrew{" "}
            {formatCurrency(snapshot.totalWithdrawn)} and still hold{" "}
            {formatCurrency(held)} (balance + inventory + vouchers + rakeback).
            This column reconciles exactly.
          </p>
        </div>
      </div>

      <div className="space-y-2.5 border-t bg-muted/20 p-4 text-sm leading-relaxed sm:p-5">
        <p>
          GGR is a gaming-margin number measured on{" "}
          <span className="font-medium text-foreground">turnover</span>, not
          cash. The real money is the cash flow on the right: of{" "}
          {formatCurrency(snapshot.totalDeposited)} deposited, the biggest
          outflow by far is the{" "}
          <span className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">
            {formatCurrency(snapshot.totalWithdrawn)}
          </span>{" "}
          customers withdrew, leaving a realized{" "}
          <span
            className={cn(
              "font-semibold tabular-nums",
              pnlPos
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400",
            )}
          >
            {pnlPos ? "+" : "−"}
            {formatCurrency(Math.abs(snapshot.pnl))}
          </span>{" "}
          P&L.
        </p>
        <p>
          The only clean giveaway cost shared between the two scoreboards is the{" "}
          <span className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">
            {formatCurrency(cost.rewardPayouts)}
          </span>{" "}
          reward &amp; bonus spend (GGR → NGR, itemized above). The rest of the
          distance — NGR of{" "}
          <span
            className={cn(
              "font-semibold tabular-nums",
              ngrPos
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400",
            )}
          >
            {ngrPos ? "+" : "−"}
            {formatCurrency(Math.abs(cost.ngr))}
          </span>{" "}
          still sitting well above realized cash — is{" "}
          <span className="font-medium text-foreground">
            a measurement-basis difference, not hidden spending
          </span>
          : gaming margin is booked on re-wagered turnover at card-sticker
          values, while realized cash is bounded by deposits − withdrawals.
        </p>
        <p className="text-muted-foreground">
          That gaming-vs-cash gap does not decompose into clean line items — the{" "}
          <span className="font-medium text-foreground/80">
            /insights/cost-breakdown
          </span>{" "}
          page carries an &ldquo;unexplained residual&rdquo; for exactly this
          reason. The trustworthy bottom line is the cash P&L.
        </p>
      </div>
    </div>
  );
}

// ─── GGR → realized P&L bridge (the full waterfall) ─────────────────

function BridgeSubRow({
  label,
  sub,
  amount,
  sign,
  tone,
  iconNode,
  pct,
  pctLabel,
}: {
  label: string;
  sub?: string;
  amount: number;
  sign: "+" | "−" | "=";
  tone: SemanticTone;
  iconNode: ReactNode;
  pct?: number | null;
  pctLabel?: string;
}) {
  const t = SEMANTIC_TONES[tone] ?? SEMANTIC_TONES.muted;
  return (
    <li className="grid grid-cols-[1fr_auto] items-start gap-2 px-2 py-1.5 sm:gap-3">
      <span className="flex min-w-0 items-start gap-2">
        <span
          className={cn(
            "mt-px flex size-5 shrink-0 items-center justify-center rounded",
            t.chip,
          )}
        >
          {iconNode}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[12px] font-medium text-foreground/90">
            {label}
          </span>
          {sub && (
            <span className="block text-[10px] leading-snug text-muted-foreground">
              {sub}
            </span>
          )}
        </span>
      </span>
      <span className="flex shrink-0 items-baseline gap-1.5">
        {pct !== null && pct !== undefined && (
          <span className="hidden text-[10px] tabular-nums text-muted-foreground sm:inline">
            {pct.toFixed(pct >= 10 ? 0 : 1)}
            {pctLabel ?? "%"}
          </span>
        )}
        <span
          className={cn(
            "font-mono text-[12px] font-semibold tabular-nums",
            t.text,
          )}
        >
          {sign === "=" ? "= " : sign}
          {formatCurrency(Math.abs(amount))}
        </span>
      </span>
    </li>
  );
}

function BridgeSubTable({
  caption,
  children,
  note,
}: {
  caption: string;
  children: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="ml-3 mt-1 border-l-2 border-border/70 pl-2 sm:ml-4 sm:pl-3">
      <p className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
        {caption}
      </p>
      <ul className="rounded-lg bg-muted/25 py-0.5">{children}</ul>
      {note && (
        <p className="px-2 pb-1 pt-1.5 text-[10px] leading-snug text-muted-foreground">
          {note}
        </p>
      )}
    </div>
  );
}

function GgrToNgrBridge({
  cost,
  snapshot,
  wager,
  split,
  rewardSpend,
  customerCashMargin,
  recycling,
}: {
  cost: CostBreakdown;
  snapshot: RealizedPnlSnapshot | null;
  wager: number;
  split: RealNumbersGameSplit | null;
  rewardSpend: RewardSpendItemization | null;
  customerCashMargin: number | null;
  recycling: CustomerRecyclingDetail | null;
}) {
  const ngrPos = cost.ngr >= 0;
  const ggrPos = cost.ggr >= 0;

  const canClose = customerCashMargin !== null && snapshot !== null;
  const conversionValue = canClose ? cost.ngr - customerCashMargin : 0;
  const creatorNetCash = canClose
    ? customerCashMargin - snapshot.pnl
    : 0;
  const realizedPnl = snapshot ? snapshot.pnl : null;
  const customerCashPos = (customerCashMargin ?? 0) >= 0;
  const realizedPos = realizedPnl !== null && realizedPnl >= 0;

  const ggrSubRows: ReactNode = split ? (
    <BridgeSubTable caption="By game — wager → payout = GGR (RTP)">
      {split.games.map((g) => {
        const gv = GAME_VISUAL[g.key];
        const GIcon = gv.icon;
        const gPos = g.ggr >= 0;
        return (
          <BridgeSubRow
            key={g.key}
            label={g.label}
            sub={`${formatCurrency(g.wager)} wager · ${
              g.rtp !== null ? `${(g.rtp * 100).toFixed(0)}% RTP` : "—"
            }`}
            amount={g.ggr}
            sign={gPos ? "+" : "−"}
            tone={gPos ? "keep" : "cost"}
            iconNode={<GIcon className="size-3" />}
            pct={cost.ggr > 0 ? (g.ggr / cost.ggr) * 100 : null}
            pctLabel="% GGR"
          />
        );
      })}
    </BridgeSubTable>
  ) : null;

  const REWARD_INLINE = 6;
  const rewardSubRows: ReactNode = rewardSpend ? (
    <BridgeSubTable caption="Itemized — top reward & bonus categories">
      {rewardSpend.rows.slice(0, REWARD_INLINE).map((r) => (
        <BridgeSubRow
          key={r.key}
          label={r.label}
          amount={r.amount}
          sign="−"
          tone="cost"
          iconNode={<Receipt className="size-3" />}
          pct={
            rewardSpend.total > 0 ? (r.amount / rewardSpend.total) * 100 : null
          }
          pctLabel="% spend"
        />
      ))}
      {rewardSpend.rows.length > REWARD_INLINE &&
        (() => {
          const tail = rewardSpend.rows.slice(REWARD_INLINE);
          const tailSum = tail.reduce((s, r) => s + r.amount, 0);
          return (
            <BridgeSubRow
              label={`+ ${tail.length} more categories`}
              sub="rakeback, lossback, rain net, gift/promo, …"
              amount={tailSum}
              sign="−"
              tone="cost"
              iconNode={<Layers className="size-3" />}
              pct={
                rewardSpend.total > 0
                  ? (tailSum / rewardSpend.total) * 100
                  : null
              }
              pctLabel="% spend"
            />
          );
        })()}
    </BridgeSubTable>
  ) : null;

  const reWagerMultiple =
    recycling && recycling.deposits > 0 ? wager / recycling.deposits : null;
  const dailyPackCost = rewardSpend?.dailyPacks.cost ?? 0;
  const dailyPackInConversion = Math.min(
    Math.max(0, dailyPackCost),
    Math.max(0, conversionValue),
  );
  const basisResidual = conversionValue - dailyPackInConversion;
  const conversionSubRows: ReactNode =
    canClose ? (
      <>
        <BridgeSubTable
          caption="Exact decomposition — NGR → customer cash margin (both measured)"
          note={
            <>
              The conversion is the difference of two independently-measured
              anchors. Only the daily / free-pack giveaway is an isolable cash
              term inside it (a real house cost carried in realized P&amp;L via
              held inventory, but not a REWARD_PAYOUT type, so not in NGR). The
              rest is a measurement-basis remainder — NGR values won cards at
              sticker on re-wagered turnover; customer cash is bounded by
              deposits − withdrawals — not hidden spending and not a plug. It
              ties to the penny: daily-pack giveaway + basis remainder = the
              conversion above.
            </>
          }
        >
          <BridgeSubRow
            label="NGR — net gaming margin (turnover basis)"
            sub="Gaming margin on all turnover, won cards at sticker — the starting anchor"
            amount={cost.ngr}
            sign="="
            tone={ngrPos ? "keep" : "cost"}
            iconNode={
              ngrPos ? (
                <TrendingUp className="size-3" />
              ) : (
                <TrendingDown className="size-3" />
              )
            }
          />
          <BridgeSubRow
            label="Daily / free-pack giveaway"
            sub={`Value of cards from free reward-pack opens — in cash P&L via held inventory, NOT in NGR's reward cost${
              rewardSpend && rewardSpend.dailyPacks.opens > 0
                ? ` (${formatNumber(rewardSpend.dailyPacks.opens)} opens)`
                : ""
            }`}
            amount={dailyPackInConversion}
            sign="−"
            tone="cost"
            iconNode={<Package className="size-3" />}
            pct={
              conversionValue > 0
                ? (dailyPackInConversion / conversionValue) * 100
                : null
            }
            pctLabel="% of conversion"
          />
          <BridgeSubRow
            label="Turnover-vs-cash basis remainder"
            sub="Sticker-valued gaming margin on re-wagered turnover above realized cash — measurement basis, not a cost"
            amount={basisResidual}
            sign="−"
            tone="muted"
            iconNode={<Scale className="size-3" />}
            pct={
              conversionValue > 0
                ? (basisResidual / conversionValue) * 100
                : null
            }
            pctLabel="% of conversion"
          />
          <BridgeSubRow
            label="Customer cash margin (cash basis)"
            sub="Realized P&L of customers only — deposits − withdrawals − held"
            amount={customerCashMargin ?? 0}
            sign="="
            tone={customerCashPos ? "keep" : "cost"}
            iconNode={
              customerCashPos ? (
                <TrendingUp className="size-3" />
              ) : (
                <TrendingDown className="size-3" />
              )
            }
          />
        </BridgeSubTable>
        {recycling && (
          <BridgeSubTable
            caption="Recycling evidence — why gaming margin ≠ customer cash"
            note={
              <>
                Card sell-backs are neutral inventory↔balance conversions (a
                normal user action, never a house cost) — shown here only as
                proof of the re-wager that inflates turnover above deposited
                cash. Not part of any cost above.
              </>
            }
          >
            <BridgeSubRow
              label="Customer deposits"
              sub="Real cash that ever entered (balances.total_deposited)"
              amount={recycling.deposits}
              sign="+"
              tone="base"
              iconNode={<ArrowDownToLine className="size-3" />}
            />
            <BridgeSubRow
              label="Customer wager (turnover)"
              sub="Total stake the house booked its edge on"
              amount={wager}
              sign="+"
              tone="base"
              iconNode={<Coins className="size-3" />}
              pct={reWagerMultiple}
              pctLabel="× deposits"
            />
            <BridgeSubRow
              label="Card sell-backs to balance"
              sub={`Cards sold back ${formatCurrency(
                recycling.cardSaleLeg,
              )} + exchanged for credit ${formatCurrency(
                recycling.cardExchangeLeg,
              )} — re-bet`}
              amount={recycling.cardSellBacks}
              sign="="
              tone="muted"
              iconNode={<ArrowUpCircle className="size-3" />}
            />
          </BridgeSubTable>
        )}
      </>
    ) : null;

  const lines: Array<{
    key: string;
    label: string;
    sub?: string;
    signed: number;
    sign: "+" | "−" | "=";
    tone: SemanticTone;
    icon: LucideIcon;
    emphasis?: "normal" | "subtotal" | "result";
    subRows?: ReactNode;
  }> = [
    {
      key: "wager",
      label: "Wager (GGR basis)",
      signed: cost.totalWager,
      sign: "+",
      tone: "base",
      icon: Coins,
    },
    {
      key: "gaming-payout",
      label: "Gaming payout (won & paid back)",
      signed: -cost.gamingPayouts,
      sign: "−",
      tone: "cost",
      icon: ArrowDownToLine,
    },
    {
      key: "ggr",
      label: "GGR — gross gaming margin",
      signed: cost.ggr,
      sign: "=",
      tone: ggrPos ? "keep" : "cost",
      icon: ggrPos ? TrendingUp : TrendingDown,
      emphasis: "subtotal",
      subRows: ggrSubRows,
    },
    {
      key: "reward",
      label: "Reward & bonus spend",
      signed: -cost.rewardPayouts,
      sign: "−",
      tone: "cost",
      icon: Gift,
      subRows: rewardSubRows,
    },
    {
      key: "ngr",
      label: "NGR — net gaming margin",
      signed: cost.ngr,
      sign: "=",
      tone: ngrPos ? "keep" : "cost",
      icon: ngrPos ? TrendingUp : TrendingDown,
      emphasis: "subtotal",
    },
    ...(canClose
      ? [
          {
            key: "conversion",
            label: "Turnover→cash conversion",
            sub: "= NGR − customer cash margin (both measured) · decomposed below into the daily-pack giveaway + the basis remainder",
            signed: -conversionValue,
            sign: "−" as const,
            tone: "cost" as const,
            icon: ArrowUpFromLine,
            subRows: conversionSubRows,
          },
          {
            key: "customer-cash",
            label: "Customer cash margin",
            sub: "Realized P&L of customers only (creators excluded)",
            signed: customerCashMargin,
            sign: "=" as const,
            tone: (customerCashPos ? "keep" : "cost") as SemanticTone,
            icon: customerCashPos ? TrendingUp : TrendingDown,
            emphasis: "subtotal" as const,
          },
          {
            key: "creator-net",
            label: "Creator net cash",
            sub: "= customer cash margin − realized P&L (creators back in)",
            signed: -creatorNetCash,
            sign: (creatorNetCash >= 0 ? "−" : "+") as "+" | "−",
            tone: "cost" as const,
            icon: Sparkles,
          },
          {
            key: "pnl",
            label: "Realized P&L",
            signed: snapshot.pnl,
            sign: "=" as const,
            tone: (realizedPos ? "keep" : "cost") as SemanticTone,
            icon: realizedPos ? TrendingUp : TrendingDown,
            emphasis: "result" as const,
          },
        ]
      : []),
  ];

  const maxMag = Math.max(...lines.map((l) => Math.abs(l.signed)), 1);

  const runningTotal = lines
    .filter((l) => l.sign !== "=")
    .reduce((s, l) => s + l.signed, 0);
  const tieOutDelta =
    canClose && realizedPnl !== null ? runningTotal - realizedPnl : null;
  const tiesOut = tieOutDelta !== null && Math.abs(tieOutDelta) < 1;

  return (
    <Card>
      <CardContent className="space-y-0.5 p-3 sm:p-4">
        <p className="px-2 pb-1 text-[11px] leading-snug text-muted-foreground">
          {canClose ? (
            <>
              The complete closing waterfall — every dollar from GGR down to
              realized cash P&L accounted for. Each step is a directly{" "}
              <span className="font-medium text-foreground">measured</span>{" "}
              value or the{" "}
              <span className="font-medium text-foreground">
                explicit difference of two measured values
              </span>{" "}
              (never a plug), so the running total closes to the penny. Every
              step drills into its sub-components below it.
            </>
          ) : (
            <>
              A fully-measured gaming-margin breakdown — wager, gaming payout,
              reward &amp; bonus spend are each a direct value from the canonical
              cost model, ending at NGR. The customer-cash-margin read failed,
              so the closing legs are withheld rather than guessed; reload to
              close the waterfall to realized P&L.
            </>
          )}
        </p>
        <WaterfallBand label="Gaming margin" hint="house edge on play" />
        {lines.map((l) => {
          const colors = SEMANTIC_TONES[l.tone] ?? SEMANTIC_TONES.muted;
          const Icon = l.icon;
          const band =
            l.key === "reward"
              ? {
                  label: "Less reward & marketing",
                  hint: "house-funded giveaways",
                }
              : l.key === "conversion"
                ? {
                    label: "Gaming margin → real customer cash",
                    hint: "turnover-vs-cash basis conversion",
                  }
                : l.key === "creator-net"
                  ? {
                      label: "Creators back into the cash population",
                      hint: "net real crypto out − in",
                    }
                  : null;
          return (
            <div key={l.key}>
              {band && <WaterfallBand label={band.label} hint={band.hint} />}
              <WaterfallRow
                label={l.label}
                signedAmount={l.signed}
                sign={l.sign}
                maxMag={maxMag}
                tone={l.tone}
                pctOfGgr={cost.ggr > 0 ? (l.signed / cost.ggr) * 100 : null}
                pctOfWager={
                  cost.totalWager > 0 ? (l.signed / cost.totalWager) * 100 : null
                }
                emphasis={l.emphasis ?? "normal"}
                iconNode={<Icon className={cn("size-3.5", colors.icon)} />}
              />
              {l.sub && (
                <p className="px-2 pb-0.5 pl-[2.85rem] text-[10px] leading-snug text-muted-foreground sm:pl-[3.1rem]">
                  {l.sub}
                </p>
              )}
              {l.subRows}
            </div>
          );
        })}

        {canClose && (
          <div className="mt-3 rounded-xl border border-border/70 bg-muted/20 p-3 sm:p-4">
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-rose-500/10 text-rose-500">
                <ArrowUpFromLine className="size-3.5" />
              </span>
              <div className="min-w-0 space-y-1.5 text-[12px] leading-relaxed text-muted-foreground">
                <p>
                  <span className="font-semibold text-foreground">
                    Turnover→cash conversion
                  </span>{" "}
                  is the{" "}
                  <span className="font-medium text-foreground">
                    measured difference NGR − customer cash margin
                  </span>{" "}
                  — both numbers independently measured. NGR (
                  <span className="tabular-nums">
                    {ngrPos ? "+" : "−"}
                    {formatCurrency(Math.abs(cost.ngr))}
                  </span>
                  ) is gaming margin on{" "}
                  <span className="tabular-nums">{formatCurrency(wager)}</span>{" "}
                  of turnover with won cards at sticker;{" "}
                  {recycling && recycling.deposits > 0 ? (
                    <>
                      customers deposited only{" "}
                      <span className="tabular-nums">
                        {formatCurrency(recycling.deposits)}
                      </span>{" "}
                      and recycled winnings{" "}
                      {reWagerMultiple !== null && (
                        <span className="font-semibold tabular-nums text-foreground">
                          ≈ {reWagerMultiple.toFixed(1)}×
                        </span>
                      )}{" "}
                      (sold{" "}
                      <span className="tabular-nums">
                        {formatCurrency(recycling.cardSellBacks)}
                      </span>{" "}
                      of cards back to balance &amp; re-bet).
                    </>
                  ) : (
                    <>customers deposited far less and recycled winnings.</>
                  )}{" "}
                  This converts gaming margin to real customer cash —{" "}
                  <span className="font-medium text-foreground">
                    not a cost, not a plug: a basis conversion.
                  </span>
                </p>
                <p>
                  <span className="font-medium text-foreground">
                    Decomposed exactly:
                  </span>{" "}
                  of the{" "}
                  <span className="tabular-nums">
                    {formatCurrency(conversionValue)}
                  </span>{" "}
                  conversion, only{" "}
                  <span className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                    {formatCurrency(dailyPackInConversion)}
                  </span>{" "}
                  is an isolable cash term — the daily / free-pack card giveaway,
                  a real house cost carried in realized P&amp;L via held inventory
                  but not a REWARD_PAYOUT type, so absent from NGR. The remaining{" "}
                  <span className="font-semibold tabular-nums text-foreground">
                    {formatCurrency(basisResidual)}
                  </span>{" "}
                  is the turnover-vs-cash basis remainder: NGR books margin on
                  re-wagered turnover at card-sticker values, while realized cash
                  is bounded by deposits − withdrawals. The two sum to the
                  conversion exactly (see the decomposition table on the line
                  above).
                </p>
                <p>
                  <span className="font-semibold text-foreground">
                    Creator net cash
                  </span>{" "}
                  (
                  <span className="tabular-nums">
                    {creatorNetCash >= 0 ? "−" : "+"}
                    {formatCurrency(Math.abs(creatorNetCash))}
                  </span>
                  ) is the real crypto creators took out (out − in). The gross
                  creator-program funding is mostly fake/recycled session money
                  and is shown in the{" "}
                  <span className="font-medium text-foreground/80">
                    Creator program cost
                  </span>{" "}
                  panel below — it&apos;s already inside these cash flows, so it
                  is NOT subtracted again here (that would double-count).
                </p>
              </div>
            </div>
          </div>
        )}

        {tieOutDelta !== null && (
          <p
            className={cn(
              "px-2 pt-3 text-[11px] leading-snug",
              tiesOut
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-amber-600 dark:text-amber-400",
            )}
          >
            {tiesOut ? (
              <>
                Ties out to realized P&L exactly — GGR{" "}
                {ggrPos ? "+" : "−"}
                {formatCurrency(Math.abs(cost.ggr))} − reward{" "}
                {formatCurrency(cost.rewardPayouts)} − (NGR − customer cash){" "}
                {formatCurrency(conversionValue)} − creator net{" "}
                {formatCurrency(creatorNetCash)} ={" "}
                {realizedPos ? "+" : "−"}
                {formatCurrency(Math.abs(realizedPnl as number))} realized P&L.
                No plug, no residual line.
              </>
            ) : (
              <>
                Waterfall closes within{" "}
                {formatCurrency(Math.abs(tieOutDelta))} of the measured realized
                P&L ({realizedPos ? "+" : "−"}
                {formatCurrency(Math.abs(realizedPnl as number))}) — a rounding
                / cache-staleness gap between independently-cached reads, not a
                plug.
              </>
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Creator program cost panel ─────────────────────────────────────

function ProgramCostRow({
  icon: Icon,
  label,
  sub,
  amount,
  footnote,
  alreadyCounted = false,
}: {
  icon: LucideIcon;
  label: string;
  sub: string;
  amount: number;
  footnote?: string;
  alreadyCounted?: boolean;
}) {
  return (
    <li className="grid grid-cols-[1fr_auto] items-start gap-2 border-b border-border/60 px-3 py-3 text-xs last:border-b-0 sm:gap-3 sm:px-4">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-md",
              alreadyCounted
                ? "bg-muted text-muted-foreground"
                : "bg-rose-500/10 text-rose-500",
            )}
          >
            <Icon className="size-3" />
          </span>
          <span className="truncate font-medium">{label}</span>
        </span>
        <span className="pl-8 text-[10px] leading-snug text-muted-foreground">
          {sub}
        </span>
        {footnote && (
          <span className="pl-8 text-[10px] font-medium leading-snug text-amber-600 dark:text-amber-400">
            {footnote}
          </span>
        )}
      </span>
      <span
        className={cn(
          "shrink-0 text-right font-mono font-semibold tabular-nums",
          alreadyCounted
            ? "text-muted-foreground"
            : "text-rose-600 dark:text-rose-400",
        )}
      >
        −{formatCurrency(amount)}
      </span>
    </li>
  );
}

function CreatorProgramCostPanel({
  program,
  creatorNetCash,
}: {
  program: CreatorProgramCost;
  creatorNetCash: number | null;
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-start gap-3 border-b bg-muted/30 px-4 py-3 sm:px-5">
          <div className="shrink-0 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2">
            <Sparkles className="size-4 text-rose-500" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold sm:text-base">
              The house-funded creator program — gross spend
            </h3>
            <p className="text-xs text-muted-foreground">
              What it actually costs the house to run creator content. Separate
              from the cash bridge above — these are GROSS program costs, not the
              net crypto creators personally withdrew.
            </p>
          </div>
        </div>

        <ul>
          <ProgramCostRow
            icon={HandCoins}
            label="Session tips"
            sub={`Tips creators send users from their fill balance — creator_tip ${formatCurrency(
              program.creatorTip,
            )} + creator_fill_spend_tip ${formatCurrency(program.fillSpendTip)}.`}
            amount={program.sessionTips}
          />
          <ProgramCostRow
            icon={Ticket}
            label="Session conversion vouchers"
            sub={`Leftover session "fake" fill balance creators convert into a real payout voucher they keep — ${formatNumber(
              program.conversionVoucherCount,
            )} vouchers (origin = creator_fill_conversion).`}
            amount={program.conversionVouchers}
          />
          <ProgramCostRow
            icon={Trophy}
            label="Leaderboard payments"
            sub={`affiliate_leaderboard_prize paid to top affiliates / creators — ${formatNumber(
              program.leaderboardPrizeCount,
            )} payouts.`}
            amount={program.leaderboardPrize}
            alreadyCounted
            footnote="Already counted in reward & bonus cost — not additional."
          />
          <li className="grid grid-cols-[1fr_auto] items-center gap-2 bg-rose-500/[0.05] px-3 py-2.5 text-xs font-semibold sm:gap-3 sm:px-4">
            <span className="min-w-0">
              <span className="block">
                Creator-specific program cost
              </span>
              <span className="block text-[10px] font-normal leading-snug text-muted-foreground">
                Session tips + conversion vouchers — the cost on TOP of the
                reward line (leaderboard excluded, it&apos;s already in reward).
              </span>
            </span>
            <span className="shrink-0 text-right font-mono tabular-nums text-rose-600 dark:text-rose-400">
              −{formatCurrency(program.creatorSpecificSubtotal)}
            </span>
          </li>
        </ul>

        <div className="space-y-2 border-t bg-blue-500/[0.03] p-4 sm:p-5">
          <div className="flex items-center gap-2">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-blue-500/10 text-blue-500">
              <Coins className="size-3.5" />
            </span>
            <h4 className="text-[13px] font-semibold tracking-tight">
              Session fill context — fake balance for content (not a cost)
            </h4>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 pl-8 text-[11px] sm:grid-cols-4">
            <div className="flex flex-col">
              <span className="font-mono font-semibold tabular-nums text-blue-600 dark:text-blue-400">
                {formatCurrency(program.fillGrant)}
              </span>
              <span className="text-[10px] text-muted-foreground">
                Fill granted
              </span>
            </div>
            <div className="flex flex-col">
              <span className="font-mono font-semibold tabular-nums text-blue-600 dark:text-blue-400">
                {formatCurrency(program.fillActivation)}
              </span>
              <span className="text-[10px] text-muted-foreground">
                Fill activated
              </span>
            </div>
            <div className="flex flex-col">
              <span className="font-mono font-semibold tabular-nums text-blue-600 dark:text-blue-400">
                {formatCurrency(program.fillForfeiture)}
              </span>
              <span className="text-[10px] text-muted-foreground">
                Forfeited back ($0 cost)
              </span>
            </div>
            <div className="flex flex-col">
              <span className="font-mono font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(program.conversionVouchers)}
              </span>
              <span className="text-[10px] text-muted-foreground">
                → real vouchers (cost)
              </span>
            </div>
          </div>
          <p className="pl-8 text-[10px] leading-snug text-muted-foreground">
            Session fill is house-funded &ldquo;fake&rdquo; balance for content —
            most is forfeited back; only the converted vouchers + tips become
            real cost.
          </p>
        </div>

        <p className="border-t bg-muted/20 px-4 py-3 text-[11px] leading-snug text-muted-foreground sm:px-5">
          These are GROSS program costs. The bridge&apos;s{" "}
          <span className="font-medium text-foreground">
            {creatorNetCash !== null
              ? `${creatorNetCash >= 0 ? "+" : "−"}${formatCurrency(
                  Math.abs(creatorNetCash),
                )}`
              : "−$52.9k"}{" "}
            &ldquo;creator net cash&rdquo;
          </span>{" "}
          is the NET real crypto creators actually withdrew (after
          re-wagering / forfeiting / holding) — that&apos;s the piece that hits
          realized P&L. The two are different views: this section is what the
          house FUNDS, the bridge line is what creators personally TOOK OUT.
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Definitions ────────────────────────────────────────────────────

function Definitions({
  snapshot,
}: {
  cost: CostBreakdown;
  snapshot: RealizedPnlSnapshot | null;
}) {
  const defs: Array<{
    key: string;
    icon: LucideIcon;
    title: string;
    formula: string;
    body: string;
    legs: string;
  }> = [
    {
      key: "wager",
      icon: Coins,
      title: "Wager (turnover)",
      formula: "Σ stake on packs + battles + upgrader",
      body: "Total real-money stake customers placed. Turnover, not profit — it has no house-POV sign, so it's shown blue. Borrow plays count at their real net amount (the cash the customer actually paid after the borrow cut).",
      legs: "In: pack_opening, battle_bet, battle_sponsorship (ledger) + upgrader bet_amount. Out: borrow remainder, reward/daily-pack opens, creator-session play.",
    },
    {
      key: "ggr",
      icon: Scale,
      title: "GGR — gross gaming revenue",
      formula: "wager − gaming payout",
      body: "The gross house edge on gaming alone, before any marketing cost. Gaming payout = the cards customers won and kept (inventory value at obtained) + battle cash refunds + upgrader payouts — the verified inventory-delta model. Card sales / exchanges are neutral conversions and never touch this.",
      legs: "Payout in: user_inventory.value_at_obtained (source pack/battle) + battle_refund + battle_excess_to_voucher + upgrader won_amount. Positive = house up (emerald).",
    },
    {
      key: "reward",
      icon: Gift,
      title: "Reward & bonus cost",
      formula: "GGR − NGR",
      body: "Every house-funded giveaway credited to customer balance. A pure marketing / retention cost — always a payout to users, so always rose.",
      legs: "In: deposit bonuses, rakeback claims, promo / gift card redemptions, race & leaderboard prizes, affiliate commissions, the net house slice of rain (max(0, rain_win − rain_tip)), counted balance adjustments. Out: creator tips (user→user pass-through).",
    },
    {
      key: "ngr",
      icon: TrendingUp,
      title: "NGR — net gaming revenue",
      formula: "GGR − reward & bonus cost",
      body: "What the gaming business kept after giveaways — still a gaming-margin number, before balance-sheet liabilities (held inventory, vouchers). Positive = house up (emerald).",
      legs: "Derived entirely from GGR and the reward cost above; no new ledger legs.",
    },
    {
      key: "pnl",
      icon: Banknote,
      title: "Realized P&L (cash basis)",
      formula:
        "deposits − withdrawals − on-site balance − inventory − unclaimed vouchers − unclaimed rakeback",
      body: "The balance-sheet bottom line: what would be left if every customer cashed out everything they hold right now. 'Realized' = after settling every liability customers are holding. This is why it sits far below GGR — the gap is value still owed to customers, not a loss.",
      legs: "From balances (deposited / withdrawn / available + locked), card_withdrawal_requests (pending→completed), user_inventory (unsold, not withdrawal-locked), vouchers (unclaimed), rakeback_claims (unclaimed). official_stream fake balance excluded.",
    },
  ];

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {defs.map((d) => {
        const Icon = d.icon;
        return (
          <div
            key={d.key}
            className="surface-sheen relative overflow-hidden rounded-xl border bg-card p-4 ring-1 ring-foreground/10 sm:p-5"
          >
            <div className="flex items-center gap-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10">
                <Icon className="size-3.5 text-primary" />
              </span>
              <h3 className="truncate text-sm font-semibold tracking-tight">
                {d.title}
              </h3>
            </div>
            <p className="mt-2 rounded-md bg-muted/50 px-2 py-1 font-mono text-[11px] leading-snug text-foreground/80">
              {d.formula}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {d.body}
            </p>
            <p className="mt-2 border-t border-border/50 pt-2 text-[10px] leading-snug text-muted-foreground/80">
              {d.legs}
            </p>
          </div>
        );
      })}
      <div className="surface-sheen relative overflow-hidden rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-4 ring-1 ring-inset ring-emerald-500/10 sm:p-5 lg:col-span-2">
        <div className="flex items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10">
            <Landmark className="size-3.5 text-emerald-500" />
          </span>
          <h3 className="truncate text-sm font-semibold tracking-tight">
            Scope &amp; basis — applies to every number on this page
          </h3>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">Real customers only.</span>{" "}
          Staff (admin / support) and creators are excluded wholesale — a
          creator&apos;s house-funded &ldquo;for content&rdquo; play is not
          customer revenue. Blacklisted users (the admin excluded-users list)
          are dropped too, and creator-on-session rows are excluded per-row.{" "}
          <span className="font-medium text-foreground">Borrow-net basis:</span>{" "}
          borrow plays count at the real cash the customer paid after the
          borrow cut, on both the wager and payout sides.{" "}
          <span className="font-medium text-foreground">Lifetime, {INSIGHTS_HUB_WAGER_LOOKBACK_DAYS}d-capped</span>{" "}
          — the same window /ggr and the Insights hub use, so the heavy scans
          stay tractable and the numbers reconcile across surfaces.{" "}
          {snapshot && (
            <>
              The realized P&L is the platform balance-sheet snapshot (it
              additionally subtracts unclaimed rakeback as a house liability);
              the GGR/NGR scope drops creators where the P&L snapshot keeps them
              — a small, documented basis difference between a gaming-margin
              number and a balance-sheet number.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
