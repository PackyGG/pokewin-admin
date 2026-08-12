"use client";

import type { ReactNode } from "react";
import {
  Info,
  Trophy,
  HandCoins,
  Gift,
  ArrowUpFromLine,
  Percent,
  Sparkles,
  Swords,
} from "lucide-react";
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
 * Creators-cost breakdown popover — what CREATORS cost the house for the
 * CURRENT CALENDAR DAY since 00:00 UTC (NOT a rolling past-24h window — the
 * same boundary as the Reward Costs Today + P&L Today tiles).
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
 *                             The sibling Reward Costs breakdown counts $0 of it.
 *   • Affiliate commissions — `affiliate_claim` ledger sum today. MOVED
 *                             WHOLESALE here from the Reward Costs breakdown
 *                             (owner, 2026-07-02): affiliate-code earners are
 *                             creator-program recipients. Scoped with this
 *                             breakdown's own blacklist-only convention (NOT
 *                             the Reward Costs breakdown's full
 *                             customer-scope drop).
 *   • Creator rewards        — approved payouts from the new creator reward
 *                             programs, identified by their immutable ledger
 *                             adjustment category and claim references.
 *
 * The leaderboard line carries a click-to-reveal per-claimant drilldown
 * (`LeaderboardGrossClaimants`); the creator-withdrawals line carries a
 * sibling drilldown (`CreatorWithdrawalsDrilldown`). Both reconcile to their
 * line amounts and load lazily on click (server actions), never on the
 * dashboard's initial render.
 *
 * Consumed by `RewardCreatorCostsTodayCard` (the merged Reward + Creators
 * Costs tile, owner request 2026-07-02: "move reward cost and creators
 * costs into one box like deposits / withdrawals") alongside
 * `AffiliateReferredPnlBadge` — the card face now only shows the rose total
 * per line-group; every itemized line lives behind this popover.
 *
 * All props are serializable primitives — no function props cross the RSC
 * boundary (`AnimatedNumber` takes the `format` string-enum, not a formatter
 * fn) per CLAUDE.md / Next 15.
 */

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
export function AffiliateReferredPnlBadge({ pnl }: { pnl: number }) {
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
    case "creator_rewards":
      return Sparkles;
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
export function CreatorCostsInfoPopover({
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
            sponsorships, leaderboard prizes, affiliate commissions, and
            approved Creator Rewards payouts.
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
