"use client";

import { Gift, Trophy } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AnimatedNumber } from "@/components/animated-number";
import { RewardCostsInfoPopover } from "./reward-costs-today-card";
import {
  CreatorCostsInfoPopover,
  AffiliateReferredPnlBadge,
} from "./creator-costs-today-card";

/**
 * "Reward + Creators Costs (today)" — MERGED dashboard tile (owner request,
 * 2026-07-02: "move reward cost and creators costs into one box like
 * deposits / withdrawals"). Replaces the two separate "Reward Costs" /
 * "Creators Costs" cards that used to sit side by side in the Today boxes
 * row with ONE card, mirroring the Deposits/Withdrawals merged-tile pattern
 * on the KPI strip below: two compact stacked halves (label + hero rose
 * total) separated by a hairline divider, held to a single tile footprint.
 *
 * Both legs are house COSTS → always rose per CLAUDE.md's House-POV rule.
 * The per-line itemization that used to render as card-face chips now lives
 * entirely behind each half's Info popover (`RewardCostsInfoPopover` /
 * `CreatorCostsInfoPopover`, unchanged breakdown logic, just no longer
 * wrapped in their own standalone cards) — nothing was dropped, it's one
 * click away instead of always-on chips, which is what makes the merged
 * tile fit a single compact footprint.
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
        </div>
      </CardContent>
    </Card>
  );
}
