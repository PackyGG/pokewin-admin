"use client";

import type { ReactNode } from "react";
import {
  Info,
  Trophy,
  HandCoins,
  Gift,
  ArrowUpFromLine,
  Percent,
  Swords,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AnimatedNumber } from "@/components/animated-number";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { LeaderboardGrossClaimants } from "./creator-cost-leaderboard-claimants";
import { CreatorWithdrawalsDrilldown } from "./creator-cost-withdrawals-drilldown";

/**
 * "Creators Costs (today)" dashboard tile — what CREATORS cost the house for
 * the CURRENT CALENDAR DAY since 00:00 UTC (NOT a rolling past-24h window —
 * the same boundary as the Reward Costs Today + P&L Today tiles).
 *
 * Every line is money the house paid OUT on creator activity → a house COST
 * → rose per CLAUDE.md's House-POV rule. Lines:
 *   • Converted payouts     — deal-payout vouchers minted today (session convert).
 *   • Tips                  — house-funded creator tips handed to users today.
 *   • Sponsored battles     — house-funded battle sponsorships handed to users
 *                             today (`creator_fill_spend_battle`), the sibling
 *                             leg of Tips from the SAME house-funded
 *                             tips/sponsor pool (owner, 2026-07-02) — see
 *                             `creators/_queries/tips-sponsor-spend.ts`.
 *   • Leaderboard prizes    — the FULL gross of today's leaderboard prizes.
 *                             Every affiliate leaderboard is a creator-run event
 *                             (owner, 2026-06-04), so its whole gross is a
 *                             creator cost counted here — no sponsored-% split.
 *                             The sibling Reward Costs box counts $0 of it.
 *   • Affiliate commissions — `affiliate_claim` ledger sum today. MOVED
 *                             WHOLESALE here from the Reward Costs box (owner,
 *                             2026-07-02): affiliate-code earners are
 *                             creator-program recipients. Scoped with this
 *                             box's own blacklist-only convention (NOT the
 *                             Reward Costs box's full customer-scope drop).
 *                             The sibling Reward Costs box counts $0 of it now.
 *
 * The card face shows the rose total + a FIXED set of chips covering all five
 * lines (see `PINNED_CHIP_KEYS`), always visible regardless of magnitude — the
 * same pattern already established on the Reward Costs card. The Info popover
 * (styled exactly like the Reward Costs / GGR breakdown popover) spells out
 * every line. The leaderboard line carries a click-to-reveal per-claimant
 * drilldown (`LeaderboardGrossClaimants`); the creator-withdrawals line
 * carries a sibling drilldown (`CreatorWithdrawalsDrilldown`). Both reconcile
 * to their line amounts and load lazily on click (server actions), never on
 * the dashboard's initial render.
 *
 * The header's top-right corner also carries a SMALL aggregate-P&L badge
 * (`affiliateReferredPnl`) — house P&L on affiliate-referred players for the
 * same "today" window — tucked beside the Trophy icon. House-POV color
 * (emerald = house up, rose = house down). It is purely additive: it sits in
 * the existing header flex row and never grows the card or shifts the title /
 * total / chips. `null` ⇒ the badge is omitted entirely (graceful degrade).
 *
 * All props are serializable primitives — no function props cross the RSC
 * boundary (`AnimatedNumber` takes the `format` string-enum, not a formatter
 * fn) per CLAUDE.md / Next 15.
 */
/**
 * Fixed set of ALL FIVE lines promoted to always-visible card-face chips, in
 * display order — mirrors the pinned-chip pattern already established on the
 * Reward Costs card (`PINNED_CHIP_KEYS` there) so the box doesn't visually
 * reshuffle day to day. A chip still renders at $0 (muted, not rose) so a
 * quiet day doesn't drop a line from view.
 */
const PINNED_CHIP_KEYS = [
  "creator_withdrawals",
  "tips",
  "sponsored_battles",
  "leaderboard",
  "affiliate",
] as const;

export function CreatorCostsTodayCard({
  total,
  lines,
  dayLabel,
  affiliateReferredPnl,
}: {
  total: number;
  /** Itemized lines, largest magnitude first (leaderboard = full gross). */
  lines: Array<{ key: string; label: string; amount: number }>;
  /** YYYY-MM-DD (UTC) — the calendar day this cost covers. */
  dayLabel: string;
  /**
   * Aggregate house P&L on affiliate-referred players for today's window
   * (House-POV: positive = house up). `null` when the figure is unavailable
   * (query failed / degraded) — the badge is then omitted so the card layout
   * is unchanged.
   */
  affiliateReferredPnl?: number | null;
}) {
  // Fixed roster of all four lines the owner wants ALWAYS visible on the
  // card face — regardless of magnitude — so the box doesn't visually
  // reshuffle. Falls back to omitting a key if the query ever stops
  // returning that line. Mirrors the Reward Costs card's PINNED_CHIP_KEYS.
  const pinned = PINNED_CHIP_KEYS.map((key) => lines.find((l) => l.key === key)).filter(
    (l): l is { key: string; label: string; amount: number } => l != null,
  );

  return (
    <Card className="bg-rose-500/10">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <CardTitle className="text-card-title text-muted-foreground inline-flex items-center gap-1">
            Creators Costs
            <CreatorCostsInfoPopover
              total={total}
              lines={lines}
              dayLabel={dayLabel}
            />
          </CardTitle>
          {/* Calendar date the figure covers — anchors the "since 00:00
              today" semantic, matching the Reward Costs tile. */}
          <span className="text-tiny text-muted-foreground tabular-nums">
            {dayLabel}
          </span>
        </div>
        {/* Top-right cluster: the small affiliate-referred P&L badge (when
            available) + the Trophy icon. `shrink-0` + the compact badge keep
            this within the existing header height — it never grows the card
            or pushes the title row. */}
        <div className="flex shrink-0 items-center gap-1.5">
          {affiliateReferredPnl != null && (
            <AffiliateReferredPnlBadge pnl={affiliateReferredPnl} />
          )}
          <Trophy className="size-4 shrink-0 text-rose-400" />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Total — a house COST, so always rose with a leading minus to read
            as money out (House-POV). Includes the full leaderboard gross. */}
        <div className="text-stat-value truncate">
          <span className="text-rose-400">
            −<AnimatedNumber value={total} format="currency" />
          </span>
        </div>
        {/* Pinned-line chips (always the same five, same order) — a quiet
            $0 day still shows the full roster, just muted instead of rose,
            so the box never visually reshuffles or collapses. sm:grid-cols-3
            wraps five chips cleanly (3 + 2) instead of leaving a lone
            orphan chip on its own row at sm:grid-cols-4. */}
        {pinned.length > 0 ? (
          <div className="grid grid-cols-2 gap-1.5 -mx-0.5 sm:grid-cols-3">
            {pinned.map((l) => (
              <CreatorCostChip key={l.key} label={l.label} value={l.amount} />
            ))}
          </div>
        ) : (
          <p className="text-tiny text-muted-foreground">
            No creator spend yet today.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Small chip showing one creator-cost line on the card face. Rose whenever
 * there's actual spend — every non-zero line is a house cost (money paid out
 * on creator activity) per House-POV. A $0 line renders muted instead of rose
 * so a quiet day doesn't read as alarming — the chip still holds its place in
 * the fixed roster. Mirrors the RewardCostChip on the Reward Costs tile.
 */
function CreatorCostChip({ label, value }: { label: string; value: number }) {
  return (
    <div
      className={cn(
        "rounded-md border bg-background/40 px-2 py-1.5 min-w-0",
        value > 0 ? "border-rose-500/15" : "border-border/60",
      )}
    >
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground truncate">
        {label}
      </p>
      <p
        className={cn(
          "text-xs font-semibold tabular-nums truncate",
          value > 0
            ? "text-rose-600 dark:text-rose-400"
            : "text-muted-foreground",
        )}
      >
        <AnimatedNumber value={value} format="currency" />
      </p>
    </div>
  );
}

/**
 * Small top-right corner badge showing the aggregate house P&L on
 * affiliate-referred players for today's window. House-POV per CLAUDE.md:
 *   • house up   (pnl > 0) → emerald, leading "+"
 *   • house down (pnl < 0) → rose,    leading "−"
 *   • flat       (pnl == 0)→ muted
 * Compact (text-[10px], tight padding, tabular-nums) so it tucks into the
 * existing header height beside the Trophy icon without growing the card.
 * The `title` spells out the meaning + window on hover.
 */
function AffiliateReferredPnlBadge({ pnl }: { pnl: number }) {
  const up = pnl > 0;
  const down = pnl < 0;
  // Render the magnitude with an explicit House-POV sign. AnimatedNumber's
  // currency format already prints its own sign for negatives, so feed it the
  // ABSOLUTE value and prefix the sign ourselves — keeps "+"/"−" consistent
  // with the rest of the dashboard's House-POV amounts.
  const sign = up ? "+" : down ? "−" : "";
  return (
    <span
      title={`Affiliate-referred players · house P&L today (since 00:00 UTC). ${
        up
          ? "House is up on referred players."
          : down
            ? "House is down on referred players."
            : "Flat on referred players."
      }`}
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold tabular-nums leading-none",
        up &&
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        down &&
          "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
        !up &&
          !down &&
          "border-border/60 bg-background/40 text-muted-foreground",
      )}
    >
      <span className="mr-px text-muted-foreground/80">PnL</span>
      <span className="ml-1">
        {sign}
        <AnimatedNumber value={Math.abs(pnl)} format="currency" />
      </span>
    </span>
  );
}

/** Icon per line key — keeps the popover rows readable at a glance. */
function lineIcon(key: string) {
  switch (key) {
    case "creator_withdrawals":
      return ArrowUpFromLine;
    case "tips":
      return Gift;
    case "sponsored_battles":
      return Swords;
    case "leaderboard":
      return Trophy;
    case "affiliate":
      return Percent;
    default:
      return HandCoins;
  }
}

/**
 * Info popover styled exactly like the Reward Costs / GGR breakdown button
 * (Popover + render-prop trigger + Info icon + small PopoverContent). Lists
 * every creator-cost line with its magnitude (rose — all are house costs).
 * The leaderboard row carries a click-to-reveal per-claimant drilldown; the
 * creator-withdrawals row carries a per-creator / per-request drilldown.
 * Both reconcile to their line amounts. The total at the bottom equals
 * creator withdrawals + tips + sponsored battles + the full leaderboard
 * gross + affiliate commissions.
 */
function CreatorCostsInfoPopover({
  total,
  lines,
  dayLabel,
}: {
  total: number;
  lines: Array<{ key: string; label: string; amount: number }>;
  dayLabel: string;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Show today's creator-cost breakdown"
            title="Show today's creator-cost breakdown"
            className="rounded text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40"
          />
        }
      >
        <Info className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[340px] max-w-[calc(100vw-2rem)] space-y-2 p-3"
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Creators costs today · breakdown
          </p>
          <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
            House spend on creator activity since 00:00 today (UTC) —{" "}
            <strong>{dayLabel}</strong> — not a rolling 24h window. Every line
            is money paid out (a house cost): deal payouts converted from
            sessions (voucher minted), house-funded tips, house-funded battle
            sponsorships, leaderboard prizes, and affiliate commissions.
            Sponsored battles are the sibling leg of Tips from the same
            house-funded tips/sponsor pool.
            Every affiliate leaderboard is a creator-run event, so its{" "}
            <strong>full prize gross</strong> is counted here as a creator cost
            (the Reward Costs box counts $0 of it). Affiliate commissions
            moved here wholesale from the Reward Costs box too — affiliate-code
            earners are creator-program recipients.
          </p>
        </div>

        {/* Line rows — each shows its magnitude, all rose (house cost). The
            leaderboard row carries the 100% pool as a sub-line. */}
        <ul className="space-y-0.5">
          {lines.map((l) => (
            <CreatorCostRow
              key={l.key}
              lineKey={l.key}
              label={l.label}
              amount={l.amount}
            >
              {l.key === "creator_withdrawals" && l.amount > 0 && (
                <CreatorWithdrawalsDrilldown withdrawalsTotal={l.amount} />
              )}
              {l.key === "leaderboard" && l.amount > 0 && (
                <LeaderboardGrossClaimants grossTotal={l.amount} />
              )}
            </CreatorCostRow>
          ))}
        </ul>

        {/* Bottom math: the lines sum to the total. Rose — a house cost. */}
        <div className="border-t border-border/60 pt-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold uppercase tracking-wider">
              Total creator cost
            </span>
            <span className="font-bold tabular-nums text-rose-400">
              −{formatCurrency(total)}
            </span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One line row inside the creator-cost popover. The icon chip is a neutral
 * muted tint (informational); the amount carries the rose House-POV cost
 * color. The leaderboard line gets the 100%-pool sub-line so it's clear the
 * shown magnitude is our-cut, not the full pool.
 */
function CreatorCostRow({
  lineKey,
  label,
  amount,
  children,
}: {
  lineKey: string;
  label: string;
  amount: number;
  children?: ReactNode;
}) {
  const Icon = lineIcon(lineKey);
  return (
    <li className="rounded px-1 py-0.5 text-[11px] hover:bg-muted/40">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
            <Icon className="size-3" />
          </span>
          <span className="block min-w-0 truncate font-medium text-foreground/90">
            {label}
          </span>
        </span>
        <span
          className={cn(
            "shrink-0 font-semibold tabular-nums",
            amount > 0
              ? "text-rose-600 dark:text-rose-400"
              : "text-muted-foreground",
          )}
        >
          −{formatCurrency(amount)}
        </span>
      </div>
      {children}
    </li>
  );
}
