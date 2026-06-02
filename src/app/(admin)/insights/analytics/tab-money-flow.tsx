import {
  TrendingUp,
  TrendingDown,
  ArrowUpFromLine,
  Coins,
  Package,
  Ticket,
  Gift,
  AlertCircle,
  Info,
} from "lucide-react";
import { FadeIn } from "@/components/fade-in";
import {
  SectionHeading,
  KpiTile,
  TILE_COLORS,
} from "@/components/modern-panels";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { describeLedgerType } from "@/lib/queries/_wager-payout-descriptions";
import { getMoneyFlowDecomposition } from "@/lib/queries/insights-analytics/money-flow";
import {
  INSIGHTS_PERIOD_LABELS,
  type InsightsPeriod,
} from "./types";
import { MoneyFlowChart, GapChart } from "./money-flow-chart";
import { MoneyFlowRow } from "./money-flow-row";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";

/**
 * Money Flow tab — decompose the GGR → P&L gap line-by-line.
 *
 * Surfaces the identity from `money-flow.ts`:
 *
 *   PnL = GGR − card_withdrawals − inventoryΔ − voucherΔ − residual
 *
 * Each line item gets a hero number, a "why this matters" explanation,
 * and (where applicable) an expander into the underlying ledger types
 * or sub-breakdown. A daily time-series at the bottom shows whether
 * the gap is uniform across the window or driven by a single day's
 * inventory/voucher event.
 *
 * Bonuses are surfaced as informational context — they're already
 * inside the GGR formula's payout subtraction (not a separate term in
 * the gap), but the user asked to see "how much each marketing surface
 * cost". The per-type breakdown sits below the waterfall to keep
 * the headline math focused.
 *
 * Residual is shown honestly. If it's a non-trivial fraction of GGR,
 * we label it as such — combinations of approximations (admin
 * adjustments not tagged, fee types outside `withdrawal_shipping_fee`,
 * asymmetry between creator on-stream filtering on the wager+payout
 * side vs. the actual balance ledger).
 */
export async function MoneyFlowInsightsTab({
  period,
}: {
  period: InsightsPeriod;
}) {
  const periodLabel = INSIGHTS_PERIOD_LABELS[period];
  const { data, error } = await safeQuery(
    () => getMoneyFlowDecomposition(period, periodLabel),
    null,
    "insights-analytics.moneyFlow",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Analytics — Money Flow"
        hint="The money-flow decomposition query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }

  // Residual exceeds 5% of GGR (or > $5k absolute) → flag as worth a
  // closer look. The threshold is deliberately loose — admins should
  // know if the math doesn't tie, but tiny rounding drift on a small
  // window shouldn't trigger the warning.
  const ggrRef = Math.max(Math.abs(data.ggr), 5000);
  const residualNoteworthy = Math.abs(data.residual) > 0.05 * ggrRef;

  return (
    <FadeIn>
      <div className="space-y-6">
        {/* Explainer up top — the user asked "why do we lose so much?".
            Lead with the answer in plain English. */}
        <Intro
          ggr={data.ggr}
          pnl={data.pnl}
          gap={data.ggr - data.pnl}
          periodLabel={periodLabel}
        />

        {/* Headline numbers — GGR + P&L side-by-side, plus the gap. */}
        <HeadlineKpis
          ggr={data.ggr}
          pnl={data.pnl}
          periodLabel={periodLabel}
        />

        {/* Waterfall — every term in the identity rendered as its own
            row with a hero number, sub-label, and (where applicable)
            an expander. */}
        <section className="space-y-3">
          <SectionHeading
            icon={Coins}
            title={`Decomposing the gap · ${periodLabel}`}
          />
          <WaterfallPanel
            data={data}
            residualNoteworthy={residualNoteworthy}
          />
        </section>

        {/* Bonuses by type — informational. Not a separate term in
            the gap; surfaced so admins can see what each reward
            surface cost. */}
        {data.bonusesByType.length > 0 && (
          <section className="space-y-3">
            <SectionHeading
              icon={Gift}
              title={`Reward cost — the GGR → NGR step · ${periodLabel}`}
            />
            <BonusesByTypePanel
              rows={data.bonusesByType}
              total={data.bonusesTotal}
            />
          </section>
        )}

        {/* Daily series — GGR vs P&L vs bonuses, and the per-day gap. */}
        {data.timeSeries.length > 0 && (
          <section className="space-y-3">
            <SectionHeading
              icon={TrendingUp}
              title={`Time series · ${periodLabel}`}
            />
            <div className="grid gap-3 md:grid-cols-2">
              <MoneyFlowChart data={data.timeSeries} />
              <GapChart data={data.timeSeries} />
            </div>
          </section>
        )}
      </div>
    </FadeIn>
  );
}

// ─── Intro ────────────────────────────────────────────────────────

function Intro({
  ggr,
  pnl,
  gap,
  periodLabel,
}: {
  ggr: number;
  pnl: number;
  gap: number;
  periodLabel: string;
}) {
  return (
    <div className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.04] p-4">
      <div className="flex items-start gap-3">
        <div className="shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2">
          <Info className="size-4 text-amber-500" />
        </div>
        <div className="space-y-1.5 text-sm">
          <p className="font-medium">
            For {periodLabel.toLowerCase()}, GGR was {formatCurrency(ggr)} but
            P&L was {formatCurrency(pnl)}. The gap of{" "}
            <span className="font-semibold">{formatCurrency(gap)}</span> is
            decomposed below.
          </p>
          <p className="text-xs text-muted-foreground">
            GGR is{" "}
            <span className="font-mono">wager − gaming payout</span>{" "}
            (gaming-only; the payout is the inventory-delta of cards kept +
            battle refunds, card conversions neutral). P&L is the
            balance-sheet identity{" "}
            <span className="font-mono">
              deposits − withdrawals − Δbalance − Δinventory − Δvouchers
            </span>
            . The gap is{" "}
            <span className="font-mono">
              reward cost + card_wd + inventoryΔ + voucherΔ + residual
            </span>{" "}
            — house-funded rewards plus value that left GGR but is still our
            liability (cards shipped, cards held in inventory, vouchers held
            unclaimed).
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Headline KPIs ────────────────────────────────────────────────

function HeadlineKpis({
  ggr,
  pnl,
  periodLabel,
}: {
  ggr: number;
  pnl: number;
  periodLabel: string;
}) {
  const ggrPositive = ggr >= 0;
  const pnlPositive = pnl >= 0;
  const gap = ggr - pnl;
  return (
    <div className="grid gap-3 grid-cols-2 lg:grid-cols-3">
      <KpiTile
        label="GGR"
        value={`${ggrPositive ? "+" : "−"}${formatCurrency(Math.abs(ggr))}`}
        sub={`${periodLabel} · wager − gaming payout`}
        icon={ggrPositive ? TrendingUp : TrendingDown}
        accent={ggrPositive ? "emerald" : "rose"}
      />
      <KpiTile
        label="P&L (house)"
        value={`${pnlPositive ? "+" : "−"}${formatCurrency(Math.abs(pnl))}`}
        sub={`${periodLabel} · windowed`}
        icon={pnlPositive ? TrendingUp : TrendingDown}
        accent={pnlPositive ? "emerald" : "rose"}
      />
      <KpiTile
        label="GGR − P&L gap"
        value={formatCurrency(Math.abs(gap))}
        sub="Decomposed below"
        icon={Coins}
        accent="amber"
      />
    </div>
  );
}

// ─── Waterfall ────────────────────────────────────────────────────

/**
 * Each gap component as a row in a vertical waterfall. The visual is
 * GGR up top, the four subtractions in between, and P&L below.
 *
 * Bar widths are proportional to absolute magnitude so admins can eye
 * the dominant term without reading every number. Rows with a
 * sub-breakdown (GGR, P&L) or explanatory note (card wd, inventory,
 * voucher, residual) expand on click via the client child component.
 */
function WaterfallPanel({
  data,
  residualNoteworthy,
}: {
  data: Awaited<ReturnType<typeof getMoneyFlowDecomposition>>;
  residualNoteworthy: boolean;
}) {
  // Max absolute magnitude across the waterfall rows — used to scale
  // the proportional bar width. Floor at $1 so tiny windows still
  // render some visible bar.
  const maxMag = Math.max(
    Math.abs(data.ggr),
    Math.abs(data.bonusesTotal),
    Math.abs(data.cardWithdrawals),
    Math.abs(data.inventoryDelta),
    Math.abs(data.voucherDelta),
    Math.abs(data.residual),
    Math.abs(data.pnl),
    1,
  );

  return (
    <Card>
      <CardContent className="space-y-1 p-4 sm:p-5">
        <MoneyFlowRow
          label="GGR (wager − gaming payout)"
          value={data.ggr}
          sign="+"
          maxMag={maxMag}
          accent={data.ggr >= 0 ? "emerald" : "rose"}
          iconNode={<MFIcon accent={data.ggr >= 0 ? "emerald" : "rose"} variant="trend-up" />}
          why="Gross gaming revenue, gaming-only: customer wager minus the gaming payout. The gaming payout is the verified inventory-delta model — the value of cards users won and kept (user_inventory) plus battle cash refunds. Card sales/exchanges are NEUTRAL conversions and are NOT subtracted here. Reward/marketing spend is NOT inside GGR — it's the next line (GGR → NGR)."
          subRows={[
            { label: "Wager", value: data.wagers, sign: "+" },
            {
              label: "Gaming payout (inventory wins + battle refund)",
              value: data.payouts,
              sign: "−",
            },
          ]}
        />

        <MoneyFlowRow
          label="Reward cost (GGR → NGR)"
          value={data.bonusesTotal}
          sign="−"
          maxMag={maxMag}
          accent="rose"
          iconNode={<MFIcon accent="rose" variant="trend-down" />}
          why="House-funded reward / marketing / retention spend — deposit bonuses, rakeback, promo & gift redemptions, affiliate claims, race & waitlist prizes, and the NET house slice of rain (max(0, rain_win − rain_tip)). This is the GGR → NGR step; the per-type breakdown is the 'Bonuses paid' panel below. creator_tip is a pass-through (not counted)."
          deltaTooltip="reward cost = GGR − NGR (canonical). Rain counted at its net house slice, not gross."
        />

        <MoneyFlowRow
          label="Card withdrawals (shipped)"
          value={data.cardWithdrawals}
          sign="−"
          maxMag={maxMag}
          accent="rose"
          iconNode={<MFIcon accent="rose" variant="arrow-up" />}
          why="Physical cards we shipped out in the window. These have already left our inventory by the time GGR was computed, but card_withdrawal_requests records the dollar liability — every shipped/completed request is money the house no longer holds."
          deltaTooltip="Source: card_withdrawal_requests where status IN ('completed','shipped') and shipped_at / completed_at is in the window."
        />

        <MoneyFlowRow
          label="Inventory growth"
          value={data.inventoryDelta}
          sign="−"
          maxMag={maxMag}
          accent="rose"
          iconNode={<MFIcon accent="rose" variant="package" />}
          why="Cards users got and KEPT. Every pack open fills inventory with cards we still owe the user (they can sell them back or withdraw them physically any time). If users open more than they sell/exchange, inventory grows — that's house liability sitting on the floor."
          deltaTooltip="user_inventory: obtained − (sold + exchanged), summed across the window."
        />

        <MoneyFlowRow
          label="Voucher growth"
          value={data.voucherDelta}
          sign="−"
          maxMag={maxMag}
          accent="rose"
          iconNode={<MFIcon accent="rose" variant="ticket" />}
          why="Outstanding voucher value we owe users — issued − claimed in the window. Vouchers come from battle excess, exchange leftovers, and admin grants. Until they're claimed they're a future balance credit waiting to land."
          deltaTooltip="vouchers: created_at within window minus claimed_at within window, summed by value."
        />

        <MoneyFlowRow
          label={residualNoteworthy ? "Unexplained residual" : "Residual"}
          value={data.residual}
          // residual = P&L − explainedFromNGR: a POSITIVE residual is an
          // unexplained inflow that lifts P&L (+), a negative one is a leak
          // (−). Sign reflects the effect on the running total down to P&L.
          sign={data.residual >= 0 ? "+" : "−"}
          maxMag={maxMag}
          accent={residualNoteworthy ? "amber" : "blue"}
          iconNode={
            <MFIcon
              accent={residualNoteworthy ? "amber" : "blue"}
              variant="alert"
            />
          }
          why={
            residualNoteworthy
              ? "The NGR → P&L identity doesn't close to $0 — this is what's missing after every named term (reward cost, the three balance-sheet liabilities, and the RESIDUAL_TYPES ledger flows) is itemized. Usual causes: neutral card-conversion ↔ inventory-delta edge cases, off-window timing (a card sold the moment after a pack open spans the cutoff), and rounding. Investigate if it's a large share of GGR."
              : "What the named terms don't account for after reward cost, the three balance-sheet liabilities, and the RESIDUAL_TYPES ledger flows are itemized — neutral-conversion timing edges and rounding. Small relative to GGR — within expected noise. Shown honestly, not fudged to zero."
          }
          deltaTooltip="residual = P&L − (NGR − inventoryΔ − cardWd − voucherΔ + Σ residual-type flows). Same identity as /insights/cost-breakdown."
        />

        <div className="my-3 border-t" />

        <MoneyFlowRow
          label="P&L (windowed)"
          value={data.pnl}
          sign="="
          maxMag={maxMag}
          accent={data.pnl >= 0 ? "emerald" : "rose"}
          iconNode={
            <MFIcon
              accent={data.pnl >= 0 ? "emerald" : "rose"}
              variant={data.pnl >= 0 ? "trend-up" : "trend-down"}
            />
          }
          why="House P&L for the window using the canonical formula deposits − withdrawals − Δbalance − Δinventory − Δvouchers. Same number as the P&L card on /dashboard."
          subRows={[
            { label: "Deposits", value: data.deposits, sign: "+" },
            {
              label: "Manual + card withdrawals",
              value: data.manualWithdrawals + data.cardWithdrawals,
              sign: "−",
            },
          ]}
        />
      </CardContent>
    </Card>
  );
}

/**
 * Server-rendered icon node passed to the client child. Keeps lucide
 * imports off the client boundary and the icon's exact colour token
 * (via TILE_COLORS) deterministic.
 */
function MFIcon({
  accent,
  variant,
}: {
  accent: "emerald" | "rose" | "blue" | "amber";
  variant:
    | "trend-up"
    | "trend-down"
    | "arrow-up"
    | "package"
    | "ticket"
    | "alert";
}) {
  const colors = TILE_COLORS[accent];
  const Icon =
    variant === "trend-up"
      ? TrendingUp
      : variant === "trend-down"
        ? TrendingDown
        : variant === "arrow-up"
          ? ArrowUpFromLine
          : variant === "package"
            ? Package
            : variant === "ticket"
              ? Ticket
              : AlertCircle;
  return <Icon className={cn("size-3.5", colors.icon)} />;
}

// ─── Bonuses by type ──────────────────────────────────────────────

function BonusesByTypePanel({
  rows,
  total,
}: {
  rows: Array<{ type: string; total: number }>;
  total: number;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium">
          Reward & marketing cost — per category
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">
          {formatCurrency(total)} total — this is the GGR → NGR step (sums to GGR − NGR). Rain is counted at its net house slice. Shows the reward-cost mix.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((row) => {
            const desc = describeLedgerType(row.type);
            const pct = total > 0 ? Math.round((row.total / total) * 100) : 0;
            return (
              <div
                key={row.type}
                className="rounded-lg border bg-card/50 p-3"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-sm font-medium">{desc.label}</p>
                  <p className="shrink-0 font-mono text-sm font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                    −{formatCurrency(row.total)}
                  </p>
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                  {desc.description}
                </p>
                <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/60 pt-1.5 text-[10px] tabular-nums text-muted-foreground">
                  <span className="font-mono">{row.type}</span>
                  <span>{pct}% of bonuses</span>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
