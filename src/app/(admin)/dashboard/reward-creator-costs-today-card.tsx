"use client";

import { Gift, Trophy } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AnimatedNumber } from "@/components/animated-number";
import { cn } from "@/lib/utils";
import { RewardCostsInfoPopover } from "./reward-costs-today-card";
import {
  CreatorCostsInfoPopover,
  AffiliateReferredPnlBadge,
} from "./creator-costs-today-card";

/**
 * Fixed set of programs promoted to always-visible chips on the Reward Costs
 * half, in display order — mirrors the standalone card's former
 * `PINNED_CHIP_KEYS` (owner-requested, 2026-07-02) so daily/free packs,
 * rain, rakeback, deposit bonuses, and promo balance credits always
 * headline the card face, not just whichever two happen to be largest that
 * day. `counted_adjustments` ("Promo balance credits" — counted
 * `admin_balance_adjustment` credits: giveaway / bonus / reload / lossback
 * / deposit-fix) added 2026-07-02, `race` ("Race wins" — on-site
 * competitive race prize payouts) added 2026-07-06 (both owner requests) —
 * each already existed as a line in `getRewardCostsToday()` and in the Info
 * popover breakdown, just wasn't pinned to a face chip yet. A chip still
 * renders at $0 (muted, not rose) so the card doesn't reshuffle day to day.
 */
const REWARD_PINNED_CHIP_KEYS = [
  "daily_packs",
  "rain",
  "rakeback",
  "deposit_bonus",
  "counted_adjustments",
  "race",
] as const;

/**
 * Fixed set of all five lines promoted to always-visible chips on the
 * Creators Costs half, in display order — mirrors the standalone card's
 * former `PINNED_CHIP_KEYS`.
 */
const CREATOR_PINNED_CHIP_KEYS = [
  "creator_withdrawals",
  "tips",
  "sponsored_battles",
  "leaderboard",
  "affiliate",
] as const;

/**
 * "Reward + Creators Costs (today)" — MERGED dashboard tile (owner request,
 * 2026-07-02: "move reward cost and creators costs into one box like
 * deposits / withdrawals"). Replaces the two separate "Reward Costs" /
 * "Creators Costs" cards that used to sit side by side in the Today boxes
 * row with ONE card, mirroring the Deposits/Withdrawals merged-tile pattern:
 * two stacked halves (label + hero rose total + pinned line chips)
 * separated by a hairline divider.
 *
 * Both legs are house COSTS → always rose per CLAUDE.md's House-POV rule.
 * Each half keeps its FULL pinned chip roster (owner request, 2026-07-02:
 * "i need all of them as before") — same chip sizing as the former
 * standalone cards, just stacked under one shared header instead of two.
 * The full per-line breakdown (every program, not just the pinned roster)
 * still lives behind each half's Info popover (`RewardCostsInfoPopover` /
 * `CreatorCostsInfoPopover`, unchanged breakdown logic).
 *
 * Both halves share the same "today" UTC-midnight boundary, so `dayLabel` is
 * identical on both — shown once in the card header instead of twice.
 *
 * All props are serializable primitives — no function props cross the RSC
 * boundary per CLAUDE.md / Next 15.
 */
export function RewardCreatorCostsTodayCard({
  reward,
  creators,
}: {
  reward: {
    total: number;
    lines: Array<{ key: string; label: string; amount: number }>;
    dayLabel: string;
    hoursElapsed: number;
    /**
     * Sum of rakeback claimed today whose underlying wager ALSO happened
     * today (daily-cadence claims only, `period_start` = today — see
     * `dashboard-rakeback-same-day.ts`). A SUBSET of the "rakeback" line's
     * amount, rendered as a small second line under that chip so an
     * operator can see how much of today's claimed rakeback is NOT from
     * carried-over accrual (yesterday's daily period, or a weekly/monthly
     * period). `null` when the scan failed/degraded — the sub-line is then
     * omitted, the chip itself is unaffected.
     */
    rakebackFromTodayWager: number | null;
  };
  creators: {
    total: number;
    lines: Array<{ key: string; label: string; amount: number }>;
    dayLabel: string;
    /**
     * Aggregate house P&L on affiliate-referred players for today's window.
     * `null` when unavailable (query failed/degraded) — the badge is then
     * omitted so the layout is unchanged.
     */
    affiliateReferredPnl?: number | null;
  };
}) {
  return (
    <Card className="bg-rose-500/10">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-card-title text-muted-foreground">
          Reward + Creators Costs
        </CardTitle>
        {/* Calendar date the figures cover — anchors the "since 00:00
            today" semantic, matching the P&L Today tile. Shared by both
            halves so it only needs to render once. */}
        <span className="text-tiny shrink-0 text-muted-foreground tabular-nums">
          {reward.dayLabel}
        </span>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {/* Reward Costs half. */}
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="flex min-w-0 items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-rose-600 dark:text-rose-400">
              <Gift className="size-3 shrink-0" />
              <span className="truncate">Reward Costs</span>
              <RewardCostsInfoPopover
                total={reward.total}
                lines={reward.lines}
                dayLabel={reward.dayLabel}
                hoursElapsed={reward.hoursElapsed}
              />
            </p>
          </div>
          <div className="truncate text-lg font-bold tabular-nums text-rose-600 dark:text-rose-400 sm:text-xl">
            −<AnimatedNumber value={reward.total} format="currency" />
          </div>
          <CostChipGrid
            lines={reward.lines}
            pinnedKeys={REWARD_PINNED_CHIP_KEYS}
            subLines={
              reward.rakebackFromTodayWager != null
                ? { rakeback: reward.rakebackFromTodayWager }
                : undefined
            }
          />
        </div>

        <div className="border-t border-border/50" />

        {/* Creators Costs half. */}
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="flex min-w-0 items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-rose-600 dark:text-rose-400">
              <Trophy className="size-3 shrink-0" />
              <span className="truncate">Creators Costs</span>
              <CreatorCostsInfoPopover
                total={creators.total}
                lines={creators.lines}
                dayLabel={creators.dayLabel}
              />
            </p>
            {creators.affiliateReferredPnl != null && (
              <AffiliateReferredPnlBadge pnl={creators.affiliateReferredPnl} />
            )}
          </div>
          <div className="truncate text-lg font-bold tabular-nums text-rose-600 dark:text-rose-400 sm:text-xl">
            −<AnimatedNumber value={creators.total} format="currency" />
          </div>
          <CostChipGrid lines={creators.lines} pinnedKeys={CREATOR_PINNED_CHIP_KEYS} />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Pinned-roster chip grid — renders one small chip per key in `pinnedKeys`,
 * in that fixed order, pulling label + amount from `lines` (falling back to
 * a $0 muted chip if a line is absent for the window). Byte-for-byte the
 * former standalone cards' `RewardCostChip`/`CreatorCostChip` markup
 * (`rounded-md border`, `px-2 py-1.5`, `text-[10px]` label, `-mx-0.5` grid
 * bleed, no leading minus on the chip value — only the hero total gets the
 * minus) so restoring the roster didn't change the chip's own footprint.
 * `sm:grid-cols-3` wraps both 5-item rosters (Reward, Creators) cleanly
 * (3+2) without a lone orphan chip.
 */
function CostChipGrid({
  lines,
  pinnedKeys,
  subLines,
}: {
  lines: Array<{ key: string; label: string; amount: number }>;
  pinnedKeys: readonly string[];
  /**
   * Optional per-key secondary figure rendered as a small extra line under
   * a chip's amount (e.g. the "rakeback" chip's same-day-wager-funded
   * subset). Absent keys render no sub-line — every other chip is
   * byte-for-byte unaffected.
   */
  subLines?: Record<string, number>;
}) {
  const byKey = new Map(lines.map((line) => [line.key, line]));
  return (
    <div className="mt-1.5 -mx-0.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
      {pinnedKeys.map((key) => {
        const line = byKey.get(key);
        const amount = line?.amount ?? 0;
        const subAmount = subLines?.[key];
        return (
          <div
            key={key}
            className={cn(
              "min-w-0 rounded-md border bg-background/40 px-2 py-1.5",
              amount > 0 ? "border-rose-500/15" : "border-border/60",
            )}
          >
            <p className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {line?.label ?? key}
            </p>
            <p
              className={cn(
                "truncate text-xs font-semibold tabular-nums",
                amount > 0
                  ? "text-rose-600 dark:text-rose-400"
                  : "text-muted-foreground",
              )}
            >
              <AnimatedNumber value={amount} format="currency" />
            </p>
            {subAmount != null && (
              <p className="truncate text-[9px] tabular-nums text-muted-foreground/70">
                <AnimatedNumber value={subAmount} format="currency" /> from
                today&apos;s wager
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
