"use client";

import { Info, Gift, CloudRain } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AnimatedNumber } from "@/components/animated-number";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

/**
 * "Reward Costs (today)" dashboard tile — what the house SPENT on rewards
 * for the CURRENT CALENDAR DAY since 00:00 UTC (NOT a rolling past-24h
 * window — the same boundary as the P&L Today tile).
 *
 * Every line is money the house paid OUT to users → a house COST → rose
 * per CLAUDE.md's House-POV rule (a reward we pay a user is a dollar we
 * spent). The card face shows the rose total + the two largest lines as
 * chips; the Info popover (styled exactly like the P&L Today / GGR
 * breakdown popover) spells out every line so the owner sees where it went
 * — deposit bonuses, daily/free packs, signup/balance rewards, rakeback,
 * promo/gift cards, race prizes, manual vouchers, promo balance credits,
 * and the flat rain line ($2/hr).
 *
 * Rain is the OWNER-CONFIRMED flat model: $2 × hours elapsed since UTC
 * midnight ("we don't pay anything else for it") — NOT the summed rain
 * payouts. Affiliate commissions are EXCLUDED entirely. Leaderboard prizes
 * are ALSO excluded entirely (owner decision, 2026-06-04): every
 * `affiliate_leaderboard_prize` is a creator-run-event cost counted in FULL
 * by the sibling Creators Costs box, so $0 of it lands here — there is no
 * leaderboard line on this card, and its per-claimant drilldown now lives
 * on the Creators Costs card.
 *
 * All props are serializable primitives — no function props cross the RSC
 * boundary (`AnimatedNumber` takes the `format` string-enum, not a
 * formatter fn) per CLAUDE.md / Next 15.
 */
export function RewardCostsTodayCard({
  total,
  lines,
  dayLabel,
  hoursElapsed,
}: {
  total: number;
  /** Itemized lines, largest magnitude first. */
  lines: Array<{ key: string; label: string; amount: number }>;
  /** YYYY-MM-DD (UTC) — the calendar day this cost covers. */
  dayLabel: string;
  /** Hours elapsed since UTC midnight — surfaced in the rain line note. */
  hoursElapsed: number;
}) {
  // The two loudest non-zero lines headline the card face as chips.
  const topLines = lines.filter((l) => l.amount > 0).slice(0, 2);

  return (
    <Card className="bg-rose-500/10">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <CardTitle className="text-card-title text-muted-foreground inline-flex items-center gap-1">
            Reward Costs
            <RewardCostsInfoPopover
              total={total}
              lines={lines}
              dayLabel={dayLabel}
              hoursElapsed={hoursElapsed}
            />
          </CardTitle>
          {/* Calendar date the figure covers — anchors the "since 00:00
              today" semantic, matching the P&L Today tile. */}
          <span className="text-tiny text-muted-foreground tabular-nums">
            {dayLabel}
          </span>
        </div>
        <Gift className="size-4 shrink-0 text-rose-400" />
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Total — a house COST, so always rose with a leading minus to
            read as money out (House-POV). */}
        <div className="text-stat-value truncate">
          <span className="text-rose-400">
            −<AnimatedNumber value={total} format="currency" />
          </span>
        </div>
        {/* Top-two line chips. Empty state (a quiet day) shows a single
            neutral chip so the card never collapses. */}
        {topLines.length > 0 ? (
          <div className="grid grid-cols-2 gap-1.5 -mx-0.5">
            {topLines.map((l) => (
              <RewardCostChip key={l.key} label={l.label} value={l.amount} />
            ))}
          </div>
        ) : (
          <p className="text-tiny text-muted-foreground">
            No reward spend yet today.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Small chip showing one reward-cost line on the card face. Always rose —
 * every line is a house cost (money paid out to users) per House-POV.
 * Mirrors the TodayComponentChip on the P&L Today tile.
 */
function RewardCostChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-rose-500/15 bg-background/40 px-2 py-1.5 min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground truncate">
        {label}
      </p>
      <p className="text-xs font-semibold tabular-nums truncate text-rose-600 dark:text-rose-400">
        <AnimatedNumber value={value} format="currency" />
      </p>
    </div>
  );
}

/**
 * Info popover styled exactly like the P&L Today / GGR breakdown button
 * (Popover + render-prop trigger + Info icon + small PopoverContent). Lists
 * every reward-cost line with its magnitude (rose — all are house costs),
 * with the rain line annotated as the flat $2/hr model and the total at the
 * bottom (the lines sum to the total).
 *
 * Leaderboard prizes are NOT a line here (owner decision, 2026-06-04) — the
 * full gross of every `affiliate_leaderboard_prize` is a creator-run-event
 * cost counted in the sibling Creators Costs box, which now hosts the
 * per-claimant leaderboard drilldown.
 */
function RewardCostsInfoPopover({
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
            is money paid out to users (a house cost). Rain is the flat{" "}
            <span className="font-mono">$2/hr</span> model (
            {hoursElapsed.toFixed(1)}h elapsed); affiliate commissions are
            excluded. Real customers only (staff + excluded users dropped).
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
            />
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
}: {
  label: string;
  amount: number;
  isRain: boolean;
}) {
  const Icon = isRain ? CloudRain : Gift;
  return (
    <li className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-muted/40">
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
    </li>
  );
}
