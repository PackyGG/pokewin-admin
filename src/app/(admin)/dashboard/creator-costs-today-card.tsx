"use client";

import { Info, Trophy, HandCoins, Gift, ArrowUpFromLine } from "lucide-react";
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
 * "Creators Costs (today)" dashboard tile — what CREATORS cost the house for
 * the CURRENT CALENDAR DAY since 00:00 UTC (NOT a rolling past-24h window —
 * the same boundary as the Reward Costs Today + P&L Today tiles).
 *
 * Every line is money the house paid OUT on creator activity → a house COST
 * → rose per CLAUDE.md's House-POV rule. Lines:
 *   • Creator withdrawals — deal-payout vouchers the creator cashed out today.
 *   • Tips                — house-funded creator tips handed to users today.
 *   • Leaderboard spend   — shown BOTH ways: the full 100% prize pool paid
 *                           today, AND our cut (the house-funded share after
 *                           the creator's off-site sponsor %). The TOTAL uses
 *                           the our-cut figure (the real house outflow); the
 *                           100% pool is context.
 *
 * The card face shows the rose total (using our-cut for leaderboard) + the
 * two largest lines as chips; the Info popover (styled exactly like the
 * Reward Costs / GGR breakdown popover) spells out every line, with the
 * leaderboard row annotated with BOTH the 100% pool and the our-cut share.
 *
 * All props are serializable primitives — no function props cross the RSC
 * boundary (`AnimatedNumber` takes the `format` string-enum, not a formatter
 * fn) per CLAUDE.md / Next 15.
 */
export function CreatorCostsTodayCard({
  total,
  lines,
  leaderboardFull,
  leaderboardOurCut,
  dayLabel,
}: {
  total: number;
  /** Itemized lines, largest magnitude first (leaderboard = our-cut). */
  lines: Array<{ key: string; label: string; amount: number }>;
  /** Full leaderboard prize pool paid today (100%, context only). */
  leaderboardFull: number;
  /** House-funded share of today's leaderboard prizes (after sponsor %). */
  leaderboardOurCut: number;
  /** YYYY-MM-DD (UTC) — the calendar day this cost covers. */
  dayLabel: string;
}) {
  // The two loudest non-zero lines headline the card face as chips.
  const topLines = lines.filter((l) => l.amount > 0).slice(0, 2);

  return (
    <Card className="bg-rose-500/10">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <CardTitle className="text-card-title text-muted-foreground inline-flex items-center gap-1">
            Creators Costs
            <CreatorCostsInfoPopover
              total={total}
              lines={lines}
              leaderboardFull={leaderboardFull}
              leaderboardOurCut={leaderboardOurCut}
              dayLabel={dayLabel}
            />
          </CardTitle>
          {/* Calendar date the figure covers — anchors the "since 00:00
              today" semantic, matching the Reward Costs tile. */}
          <span className="text-tiny text-muted-foreground tabular-nums">
            {dayLabel}
          </span>
        </div>
        <Trophy className="size-4 shrink-0 text-rose-400" />
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Total — a house COST, so always rose with a leading minus to read
            as money out (House-POV). Uses the leaderboard our-cut share. */}
        <div className="text-stat-value truncate">
          <span className="text-rose-400">
            −<AnimatedNumber value={total} format="currency" />
          </span>
        </div>
        {/* Top-two line chips. Empty state (a quiet day) shows a single
            neutral note so the card never collapses. */}
        {topLines.length > 0 ? (
          <div className="grid grid-cols-2 gap-1.5 -mx-0.5">
            {topLines.map((l) => (
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
 * Small chip showing one creator-cost line on the card face. Always rose —
 * every line is a house cost (money paid out on creator activity) per
 * House-POV. Mirrors the RewardCostChip on the Reward Costs tile.
 */
function CreatorCostChip({ label, value }: { label: string; value: number }) {
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

/** Icon per line key — keeps the popover rows readable at a glance. */
function lineIcon(key: string) {
  switch (key) {
    case "creator_withdrawals":
      return ArrowUpFromLine;
    case "tips":
      return Gift;
    case "leaderboard":
      return Trophy;
    default:
      return HandCoins;
  }
}

/**
 * Info popover styled exactly like the Reward Costs / GGR breakdown button
 * (Popover + render-prop trigger + Info icon + small PopoverContent). Lists
 * every creator-cost line with its magnitude (rose — all are house costs).
 * The leaderboard row is annotated with BOTH the full 100% pool and the
 * our-cut house share, so it's clear the total uses the our-cut figure. The
 * total at the bottom equals creator withdrawals + tips + leaderboard our-cut.
 */
function CreatorCostsInfoPopover({
  total,
  lines,
  leaderboardFull,
  leaderboardOurCut,
  dayLabel,
}: {
  total: number;
  lines: Array<{ key: string; label: string; amount: number }>;
  leaderboardFull: number;
  leaderboardOurCut: number;
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
            is money paid out (a house cost): deal-payout withdrawals the
            creator cashed out, house-funded tips, and house-funded leaderboard
            prizes. Leaderboard is shown at <strong>100%</strong> (full pool)
            and at <strong>our cut</strong> (after the creator&apos;s off-site
            sponsor %); the total uses the our-cut share.
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
              leaderboardFull={l.key === "leaderboard" ? leaderboardFull : null}
            />
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
          {/* Leaderboard 100% vs our-cut callout so the gap is explicit. */}
          {leaderboardFull > 0 && (
            <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
              Leaderboard at 100%:{" "}
              <span className="font-semibold tabular-nums text-foreground/80">
                {formatCurrency(leaderboardFull)}
              </span>{" "}
              · our cut:{" "}
              <span className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(leaderboardOurCut)}
              </span>
            </p>
          )}
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
  leaderboardFull,
}: {
  lineKey: string;
  label: string;
  amount: number;
  leaderboardFull: number | null;
}) {
  const Icon = lineIcon(lineKey);
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
          {leaderboardFull != null && leaderboardFull > 0 && (
            <span className="block truncate text-[10px] text-muted-foreground">
              {formatCurrency(leaderboardFull)} pool at 100%
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
