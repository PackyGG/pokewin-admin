import {
  Sigma,
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
  ScrollText,
  Layers,
  Info,
  Receipt,
  type LucideIcon,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  getCostBreakdown,
  type CostBreakdown,
} from "@/lib/queries/insights-analytics/cost-breakdown";
import {
  getInsightsHubWager,
  INSIGHTS_HUB_WAGER_LOOKBACK_DAYS,
} from "@/lib/queries/insights-analytics/hub-wager";
import {
  getRealNumbersGameSplit,
  getRewardSpendItemization,
  type RealNumbersGameSplit,
  type GameGgrRow,
  type RewardSpendItemization,
} from "@/lib/queries/insights-analytics/real-numbers";
import {
  getRealizedPnlSnapshot,
  type RealizedPnlSnapshot,
} from "@/lib/queries/_realized-pnl";
import { formatDateTime } from "@/lib/utils/format";
// Reuse the cost-breakdown waterfall primitives + the directive-free
// semantic-tone vocabulary (server-safe — see ../cost-breakdown/tones.ts).
import {
  WaterfallRow,
  WaterfallBand,
} from "../cost-breakdown/waterfall-row";
import { SEMANTIC_TONES, type SemanticTone } from "../cost-breakdown/tones";

export const metadata = { title: "Real Numbers" };

/**
 * /insights/real-numbers — the SOURCE OF TRUTH page.
 *
 * The owner's ask: "a page that shows our REAL data — accurate, reconciled,
 * not inflated/obsolete/guessed." So every figure here is READ from the
 * canonical corrected metric layer (creators + staff + blacklisted users
 * fully excluded; borrow plays counted at their real net basis), never
 * hardcoded and never re-derived locally:
 *
 *   • Wager (turnover)        ← getInsightsHubWager() (borrow-net, creator-
 *                                sessions excluded, sponsored + upgrader in)
 *   • GGR / NGR / reward cost  ← getCostBreakdown(all, 365d) (assembly of
 *                                getWindowMetrics — the inventory-delta GGR)
 *   • Realized P&L + bridge    ← getRealizedPnlSnapshot() (the balance-sheet
 *                                truth: deposits − withdrawals − balance −
 *                                inventory − vouchers − unclaimed rakeback)
 *   • Per-game GGR split       ← getRealNumbersGameSplit() (the SAME
 *                                WAGER_LEG_FILTER / PAYOUT_LEG_FILTER the
 *                                headline uses → sums to headline GGR)
 *
 * Lifetime only (365d-capped, the same cap /ggr + the insights hub use).
 * No period selector — one window, one truth. House-POV colours throughout
 * (CLAUDE.md): user gains → rose, user loses / house up → emerald, neutral
 * turnover / cash-in → blue.
 */
export default async function RealNumbersPage() {
  await requirePageAccess("/insights/real-numbers");

  // Lifetime, 365d-capped — the same window the insights hub + /ggr use.
  const [
    { data: cost, error: costErr },
    { data: wager },
    { data: split },
    { data: snapshot },
    { data: rewardSpend },
  ] = await Promise.all([
    safeQuery(
      () => getCostBreakdown("all", "Lifetime", 0, INSIGHTS_HUB_WAGER_LOOKBACK_DAYS),
      null,
      "insights.realNumbers.cost",
    ),
    safeQuery(() => getInsightsHubWager(), 0, "insights.realNumbers.wager"),
    safeQuery(() => getRealNumbersGameSplit(), null, "insights.realNumbers.split"),
    safeQuery(() => getRealizedPnlSnapshot(), null, "insights.realNumbers.pnl"),
    safeQuery(
      () => getRewardSpendItemization(),
      null,
      "insights.realNumbers.rewardSpend",
    ),
  ]);

  const asOf = formatDateTime(new Date());

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Sigma}
          accent="emerald"
          title="Real Numbers"
          subtitle="Source of truth · lifetime · real customers only (staff, creators & blacklisted users excluded) · reconciled to the ledger & balances"
        />
        <div className="mt-3 flex flex-col gap-1.5 border-t border-border/50 pt-3 text-[11px] leading-snug text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <p className="flex min-w-0 items-center gap-1.5">
            <ScrollText className="size-3.5 shrink-0 text-muted-foreground/70" />
            <span className="min-w-0">
              Sourced from the canonical metric layer (
              <span className="font-medium text-foreground/80">getCostBreakdown</span>
              {" · "}
              <span className="font-medium text-foreground/80">getInsightsHubWager</span>
              {" · "}
              <span className="font-medium text-foreground/80">getRealizedPnlSnapshot</span>
              ) — GGR is the verified inventory-delta model; borrow plays
              count at their real net basis.
            </span>
          </p>
          <p className="shrink-0 tabular-nums">As of {asOf} · last {INSIGHTS_HUB_WAGER_LOOKBACK_DAYS}d</p>
        </div>
      </PageHero>

      {costErr || !cost ? (
        <TileErrorFallback
          label="Real Numbers"
          hint="The canonical cost-breakdown helper failed. Server logs hold the digest."
          size="panel"
        />
      ) : (
        <FadeIn>
          <div className="space-y-6">
            <KpiStrip cost={cost} wager={wager ?? 0} snapshot={snapshot} />

            <section className="space-y-3">
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
            </section>

            <section className="space-y-3">
              <SectionHeading
                icon={Scale}
                title="Gaming-margin waterfall — wager → GGR → NGR"
              />
              <GamingWaterfall
                cost={cost}
                wager={wager ?? 0}
                netRain={rewardSpend?.netRain ?? null}
              />
            </section>

            <section className="space-y-3">
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
            </section>

            {snapshot && (
              <section className="space-y-3">
                <SectionHeading
                  icon={Banknote}
                  title="Balance-sheet P&L — the cash-basis bottom line"
                />
                <BalanceSheetWaterfall snapshot={snapshot} />
              </section>
            )}

            {snapshot && (
              <section className="space-y-3">
                <SectionHeading
                  icon={PiggyBank}
                  title="Why GGR ≠ realized P&L — two different scoreboards"
                />
                <ReconciliationCallout cost={cost} snapshot={snapshot} />
              </section>
            )}

            <section className="space-y-3">
              <SectionHeading icon={Info} title="Definitions — what each number means" />
              <Definitions cost={cost} snapshot={snapshot} />
            </section>
          </div>
        </FadeIn>
      )}
    </div>
  );
}

// ─── KPI strip ──────────────────────────────────────────────────────

/**
 * The five headline numbers, House-POV (STRICT):
 *   • Wager        — blue (turnover / neutral, not a P&L sign)
 *   • GGR          — emerald (house up) / rose (house down)
 *   • Reward cost  — rose (every reward dollar is a payout to users)
 *   • NGR          — emerald / rose
 *   • Realized P&L — emerald / rose (the balance-sheet snapshot)
 * Plus an optional "Customers hold (owed)" tile — rose, since it's value
 * users hold = money we owe them.
 */
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
  // Realized P&L: prefer the balance-sheet snapshot (the +$45k figure incl.
  // unclaimed rakeback). Fall back to the cost-breakdown windowed P&L only if
  // the snapshot read failed.
  const pnl = snapshot ? snapshot.pnl : cost.pnl;
  const pnlPos = pnl >= 0;

  // "Customers hold (owed)" = on-site balance + inventory + unclaimed
  // vouchers + unclaimed rakeback — the value customers still hold that the
  // house owes. This is the bridge between GGR and realized P&L.
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

/**
 * Per-product GGR table: wager · gaming payout · GGR · RTP · house edge.
 * GGR / house edge are emerald when the house is up on that line, rose when
 * down. The footer asserts the split reconciles with the headline GGR.
 */
function GameSplitPanel({
  split,
  headlineGgr,
}: {
  split: RealNumbersGameSplit;
  headlineGgr: number;
}) {
  // Reconciliation residual: Σ per-game GGR vs the headline GGR. They are
  // built from the same canonical legs so this should be ~0; surfaced
  // honestly rather than hidden.
  const residual = split.totalGgr - headlineGgr;
  const reconciles = Math.abs(residual) < 1; // sub-dollar = exact

  return (
    <Card>
      <CardContent className="p-0">
        {/* Header row */}
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
          {/* Total row */}
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

/**
 * The itemized reward-spend table — every house-funded reward dollar split by
 * source, directly below the reward-spend line in the waterfall above.
 *
 * Columns: Category · Amount · Count · % of reward spend · Why. House-POV is
 * ROSE throughout — every row is money the house GAVE users (a cost). Rows are
 * pre-sorted by amount desc. The footer total equals the page's headline
 * reward cost (`cost.rewardPayouts` = GGR − NGR) because the itemization
 * mirrors `getRewardCost`'s exact predicates; the reconciliation is asserted
 * live in-render (within $1), the same way the per-game GGR panel asserts it.
 */
function RewardSpendPanel({
  itemization,
  headlineRewardCost,
}: {
  itemization: RewardSpendItemization;
  headlineRewardCost: number;
}) {
  // Reconciliation: Σ itemized rows vs the headline reward cost. Built from
  // the same canonical predicates, so this should be ~0 — surfaced honestly.
  const residual = itemization.total - headlineRewardCost;
  const reconciles = Math.abs(residual) < 1; // sub-dollar = exact
  const denom = itemization.total;

  return (
    <Card>
      <CardContent className="p-0">
        {/* Header row */}
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
          {/* Total row */}
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
          )}
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Gaming-margin waterfall ────────────────────────────────────────

/**
 * Wager → −Gaming payout → GGR → −Reward cost → NGR.
 *
 * Reuses the cost-breakdown WaterfallRow / WaterfallBand + the semantic tone
 * vocabulary. House-POV tones: the base wager is blue; gaming payout + the
 * reward giveback are realized costs (rose); the GGR / NGR checkpoints are
 * emerald when positive, rose when negative. The wager here is the canonical
 * GGR-basis wager (cost.totalWager) so the arithmetic ties out to GGR — the
 * blue headline wager tile above is the broader hub turnover (borrow-net,
 * includes the organic-stake definition), noted in the footer.
 *
 * The reward giveback ALWAYS sums to the canonical reward cost
 * (`cost.rewardPayouts` = GGR − NGR), so GGR − reward = NGR holds visibly.
 * When the reward itemization is available we split it into its real non-rain
 * leg + the net house slice of rain (both sourced from the same canonical
 * itemization the table below uses — `netRain`); otherwise we show a single
 * clean "Reward & bonus cost" line (the itemized split lives in the table
 * directly below either way). It is NEVER re-derived from ggr/ngr/reward
 * (those are linearly dependent → always 0).
 */
function GamingWaterfall({
  cost,
  wager,
  netRain,
}: {
  cost: CostBreakdown;
  wager: number;
  /**
   * The net house slice of rain (max(0, rain_win − rain_tip)) from the
   * canonical reward-spend itemization, or null when that read failed. When
   * present and ≤ the total reward cost it lets us show the excl-rain / net-
   * rain split; otherwise the reward cost renders as one line.
   */
  netRain: number | null;
}) {
  const ggrPos = cost.ggr >= 0;
  const ngrPos = cost.ngr >= 0;

  // Show the rain split only when the itemized net-rain value is available
  // AND fits inside the total reward cost (so the two legs both stay ≥ 0 and
  // sum to exactly cost.rewardPayouts). Otherwise fall back to one line.
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
          // Band header ahead of the first reward line.
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

/**
 * Deposits → −Withdrawals → −On-site balance → −Inventory value →
 * −Unclaimed vouchers → −Unclaimed rakeback → Realized P&L.
 *
 * House-POV tones: deposits in = blue (neutral cash-in that funds the
 * house); every subtraction is value owed to / held by users = a liability
 * that erodes our realized P&L (rose); the realized P&L result is emerald
 * when positive. All terms read from the canonical getRealizedPnlSnapshot.
 */
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

/**
 * One labelled step in a mini-bridge column. House-POV tones:
 *   • base  — neutral cash-in / turnover entering the column (blue)
 *   • cost  — money that flowed back / is owed to users (rose)
 *   • keep  — a positive house margin / result (emerald)
 * `emphasis: "result"` renders the loud final-result row.
 */
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

/**
 * "Why GGR ≠ realized P&L" — the corrected explanation.
 *
 * GGR/NGR and realized P&L are TWO DIFFERENT SCOREBOARDS measured on different
 * bases; you CANNOT subtract a list of costs to get from one to the other.
 * (The old copy claimed the gap WAS the value customers still hold — that is
 * mathematically false: GGR − P&L is ~hundreds of thousands, while held value
 * is only a few thousand.)
 *
 * So we show them as two side-by-side mini-bridges, each internally exact:
 *   • Gaming margin (edge on play): wager → GGR → −reward → NGR. Booked on
 *     EVERY dollar wagered, valuing won cards at sticker. Customers re-wager
 *     winnings, so the multi-million turnover came from far less real cash.
 *   • Cash — the real money: deposits − withdrawals − customers-hold =
 *     realized P&L. This column reconciles exactly (the P&L formula is
 *     deposits − withdrawals − balance − inventory − vouchers − rakeback, and
 *     "customers hold" = balance + inventory + vouchers + rakeback).
 *
 * The honest caveat (stated plainly, not hidden): NGR sits far above realized
 * cash NOT because of extra spending but because gaming margin is booked on
 * re-wagered turnover at card-sticker values while realized cash is bounded by
 * deposits − withdrawals. That gaming-vs-cash gap does NOT decompose into clean
 * line items (the /insights/cost-breakdown page carries an "unexplained
 * residual" for exactly this reason). The trustworthy bottom line is the cash
 * P&L. All values are read live from `cost` + `snapshot`.
 */
function ReconciliationCallout({
  cost,
  snapshot,
}: {
  cost: CostBreakdown;
  snapshot: RealizedPnlSnapshot;
}) {
  // Cash column: deposits − withdrawals − held = realized P&L, exactly (the
  // P&L formula minus the held terms is the identity). "held" is the value
  // customers still hold = money the house owes.
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

      {/* Two side-by-side mini-bridges, each internally exact. */}
      <div className="grid gap-px bg-border/60 sm:grid-cols-2">
        {/* Gaming margin — edge on play (turnover basis). */}
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

        {/* Cash — the real money (deposits − withdrawals − held). */}
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

      {/* Plain-language explainer + honest caveat. */}
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

// ─── Definitions ────────────────────────────────────────────────────

/**
 * One StatPanel-style card per headline metric: plain language + the exact
 * formula + which ledger legs are in/out + the scope + the borrow-net note.
 * Kept as plain bordered cards (not the accent StatPanel hero — these are
 * reference text, not KPIs) so the reading stays calm.
 */
function Definitions({
  cost,
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
      {/* Scope card — applies to everything above. */}
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
