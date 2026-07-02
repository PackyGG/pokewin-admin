"use client";

import type { ReactNode } from "react";
import { Info, Gift, CloudRain } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { RaceWinClaimants } from "./reward-cost-race-claimants";
import { PromoBalanceCreditClaimants } from "./reward-cost-promo-claimants";

/**
 * Reward-cost breakdown popover — what the house SPENT on rewards for the
 * CURRENT CALENDAR DAY since 00:00 UTC (NOT a rolling past-24h window — the
 * same boundary as the P&L Today tile).
 *
 * Every line is money the house paid OUT to users → a house COST → rose
 * per CLAUDE.md's House-POV rule (a reward we pay a user is a dollar we
 * spent): deposit bonuses, daily/free packs, signup/balance rewards,
 * rakeback, promo/gift cards, race wins, raffle prizes, motha
 * (founder-account) giveaways, manual vouchers, promo balance credits, and
 * the flat rain line ($2/hr). Affiliate commissions MOVED WHOLESALE to the
 * sibling Creators Costs breakdown (owner decision, 2026-07-02) — there is
 * no affiliate line here.
 *
 * Rain is the OWNER-CONFIRMED flat model: $2 × hours elapsed since UTC
 * midnight ("we don't pay anything else for it") — NOT the summed rain
 * payouts. Leaderboard prizes are excluded entirely (owner decision,
 * 2026-06-04): every `affiliate_leaderboard_prize` is a creator-run-event
 * cost counted in FULL by the sibling Creators Costs breakdown, so $0 of it
 * lands here.
 *
 * Consumed by `RewardCreatorCostsTodayCard` (the merged Reward + Creators
 * Costs tile, owner request 2026-07-02: "move reward cost and creators
 * costs into one box like deposits / withdrawals") — the card face now only
 * shows the rose total per line-group; every itemized line lives behind
 * this popover.
 *
 * All props are serializable primitives — no function props cross the RSC
 * boundary per CLAUDE.md / Next 15.
 */
export function RewardCostsInfoPopover({
  total,
  lines,
  dayLabel,
  hoursElapsed,
}: {
  total: number;
  lines: Array<{ key: string; label: string; amount: number }>;
  dayLabel: string;
  hoursElapsed: number;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Show today's reward-cost breakdown"
            title="Show today's reward-cost breakdown"
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
            Reward costs today · breakdown
          </p>
          <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
            House-funded reward spend since 00:00 today (UTC) —{" "}
            <strong>{dayLabel}</strong> — not a rolling 24h window. Every line
            is money paid out to users (a house cost), broken out per
            program. Rain is the flat <span className="font-mono">$2/hr</span>{" "}
            model ({hoursElapsed.toFixed(1)}h elapsed); raffle + motha lines
            are reconstructed (raffle = today&apos;s completed-raffle prize
            value; motha = the founder account&apos;s outflows). Real
            customers only (staff + excluded users dropped).
          </p>
        </div>

        {/* Line rows — each shows its magnitude, all rose (house cost). */}
        <ul className="space-y-0.5">
          {lines.map((l) => (
            <RewardCostRow
              key={l.key}
              label={l.label}
              amount={l.amount}
              isRain={l.key === "rain"}
            >
              {l.key === "race" && l.amount > 0 && (
                <RaceWinClaimants raceTotal={l.amount} />
              )}
              {l.key === "counted_adjustments" && l.amount > 0 && (
                <PromoBalanceCreditClaimants creditTotal={l.amount} />
              )}
            </RewardCostRow>
          ))}
        </ul>

        {/* Bottom math: the lines sum to the total. Rose — a house cost. */}
        <div className="border-t border-border/60 pt-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold uppercase tracking-wider">
              Total reward cost
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
 * One line row inside the reward-cost popover. The icon chip is a neutral
 * muted tint (informational); the amount carries the rose House-POV cost
 * color. The rain line gets a distinct icon + the $2/hr annotation so it's
 * clear it's the flat model, not summed rain payouts.
 */
function RewardCostRow({
  label,
  amount,
  isRain,
  children,
}: {
  label: string;
  amount: number;
  isRain: boolean;
  children?: ReactNode;
}) {
  const Icon = isRain ? CloudRain : Gift;
  return (
    <li className="rounded px-1 py-0.5 text-[11px] hover:bg-muted/40">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
            <Icon className="size-3" />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-medium text-foreground/90">
              {label}
            </span>
            {isRain && (
              <span className="block truncate text-[10px] text-muted-foreground">
                Flat $2 per hour
              </span>
            )}
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
