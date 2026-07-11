"use client";

/**
 * Rewards SUMMARY for the user-detail Rewards tab — the readable, scannable
 * top-of-tab stat boxes the owner asked for ("the Rewards tab is hard to
 * read"). Replaces the old plain `RewardsCard` (a bare <Card> with three
 * numbers) with the house modern primitives.
 *
 * WHAT IT SHOWS (all data already fetched — no new heavy read):
 *   1. Rakeback (lead) — claimed (lifetime) + claimable (now), with a
 *      daily / weekly / monthly cadence sub-breakdown. The three cadences are
 *      the FULL `rakeback_type` enum (verified read-only against live prod:
 *      daily|weekly|monthly, no "instant" cadence) and sum EXACTLY to the
 *      claimed total. "Instant" is a cross-cutting subset (claims made via the
 *      early-claim flow) shown as an "of which" caption, never as a 4th bucket.
 *   2. Reward payouts — rain wins, race prizes, leaderboard wins and creator
 *      tips (received + sent). Each a stat box: amount + count.
 *
 * HOUSE-POV (CLAUDE.md): every dollar the user GAINS is a dollar we owe →
 *   • rakeback claimed/claimable, rain, races, leaderboards, tips received →
 *     house COST → ROSE.
 *   • tips SENT (the user spending) → house GAIN → EMERALD.
 *   • unopened one-time rewards (a neutral count, not money) → BLUE.
 *
 * NOT SHOWN (data gap, flagged — NOT fabricated): "sponsored / free battles"
 * as a reward TO the user has no metric — `battle_sponsorship` is the user
 * PAYING to sponsor a battle (a wager / house gain), the opposite of a reward,
 * and there is no per-user "free battles joined" credit. So no box is drawn
 * for it rather than showing a misleading number.
 */

import { Percent, Trophy, Flag, Award, ArrowDownToLine, ArrowUpRight, Gift } from "lucide-react";
import { SectionHeading, StatPanel, KpiTile } from "@/components/modern-panels";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import type { UserRewards } from "@/lib/queries/users";
import type { UserDetail } from "./user-tabs-types";

const ROSE = "text-rose-600 dark:text-rose-400";

/** Flat "mini-box" stat — mirrors the PanelStat pilot pattern (one hairline
 *  border + subtle muted inset, no glow), used for the rakeback cadence grid
 *  and reused by the reward-pack-opens per-type boxes. */
export function MiniStat({
  label,
  value,
  valueClassName,
  sub,
}: {
  label: string;
  value: string;
  valueClassName?: string;
  sub?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-lg border border-border bg-muted/40 px-2.5 py-2">
      <p className="min-w-0 truncate text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p className={cn("mt-1 truncate text-sm font-semibold tabular-nums", valueClassName)}>
        {value}
      </p>
      {sub ? (
        <p className="mt-0.5 truncate text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {sub}
        </p>
      ) : null}
    </div>
  );
}

export function RewardsSummarySection({
  rewards,
  tips,
}: {
  rewards: UserRewards;
  tips: UserDetail["tips"];
}) {
  const { byFrequency } = rewards;
  const hasInstant =
    rewards.instantClaimedUsd != null && rewards.instantClaimedCount != null;

  // Reward-payout boxes. House-POV: user gains → rose; tips sent → emerald.
  const payouts: {
    key: string;
    label: string;
    icon: React.ElementType;
    total: number;
    count: number;
    unit: string;
    accent: "rose" | "emerald" | "blue";
  }[] = [
    {
      key: "rain",
      label: "Rain Prizes",
      icon: Trophy,
      total: tips.rainPrizes.totalUsd,
      count: tips.rainPrizes.count,
      unit: "prize",
      accent: "rose",
    },
    {
      key: "race",
      label: "Race Prizes",
      icon: Flag,
      total: tips.raceClaims.totalUsd,
      count: tips.raceClaims.count,
      unit: "claim",
      accent: "rose",
    },
    {
      key: "leaderboard",
      label: "Leaderboard Wins",
      icon: Award,
      total: tips.leaderboardWins.totalUsd,
      count: tips.leaderboardWins.count,
      unit: "win",
      accent: "rose",
    },
    {
      key: "tips-received",
      label: "Tips Received",
      icon: ArrowDownToLine,
      total: tips.received.totalUsd,
      count: tips.received.count,
      unit: "tip",
      accent: "rose",
    },
    {
      key: "tips-sent",
      label: "Tips Sent",
      icon: ArrowUpRight,
      total: tips.sent.totalUsd,
      count: tips.sent.count,
      unit: "tip",
      accent: "emerald",
    },
  ];

  return (
    <div className="space-y-4">
      {/* ── Rakeback (lead) ───────────────────────────────────────────── */}
      <StatPanel title="Rakeback" icon={Percent} accent="rose">
        {/* Claimed lifetime + claimable now — the two headline numbers. */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <MiniStat
            label="Claimed (lifetime)"
            value={formatCurrency(rewards.rakebackClaimedUsd)}
            valueClassName={ROSE}
            sub={`${formatNumber(rewards.rakebackClaimedCount)} ${
              rewards.rakebackClaimedCount === 1 ? "claim" : "claims"
            }`}
          />
          <MiniStat
            label="Claimable now"
            value={formatCurrency(rewards.rakebackClaimableUsd)}
            valueClassName={ROSE}
            sub="unclaimed liability"
          />
        </div>

        {/* Cadence sub-breakdown of CLAIMED — the three slices sum to the
            claimed total above (daily|weekly|monthly is the full enum). */}
        <p className="mb-1.5 mt-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Claimed by cadence
        </p>
        <div className="grid grid-cols-3 gap-2">
          <MiniStat
            label="Daily"
            value={formatCurrency(byFrequency.daily.claimedUsd)}
            valueClassName={ROSE}
            sub={`${formatNumber(byFrequency.daily.claimedCount)} claims`}
          />
          <MiniStat
            label="Weekly"
            value={formatCurrency(byFrequency.weekly.claimedUsd)}
            valueClassName={ROSE}
            sub={`${formatNumber(byFrequency.weekly.claimedCount)} claims`}
          />
          <MiniStat
            label="Monthly"
            value={formatCurrency(byFrequency.monthly.claimedUsd)}
            valueClassName={ROSE}
            sub={`${formatNumber(byFrequency.monthly.claimedCount)} claims`}
          />
        </div>

        {/* "Of which instant" — a CROSS-CUTTING subset, not a 4th cadence.
            Hidden when the early-claim column is absent (drift → null). */}
        {hasInstant && rewards.instantClaimedCount! > 0 ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            of which instant-claimed:{" "}
            <span className={cn("font-semibold tabular-nums", ROSE)}>
              {formatCurrency(rewards.instantClaimedUsd!)}
            </span>{" "}
            · {formatNumber(rewards.instantClaimedCount!)}{" "}
            {rewards.instantClaimedCount === 1 ? "claim" : "claims"}
          </p>
        ) : null}
      </StatPanel>

      {/* ── Reward payouts ────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {payouts.map((p) => (
          <KpiTile
            key={p.key}
            label={p.label}
            value={formatCurrency(p.total)}
            sub={`${formatNumber(p.count)} ${p.count === 1 ? p.unit : `${p.unit}s`}`}
            icon={p.icon}
            accent={p.accent}
          />
        ))}
        {/* Unopened one-time rewards — a neutral COUNT (rewards available to
            open), not money → blue. Preserves the datum the old card showed. */}
        <KpiTile
          label="Unopened Rewards"
          value={formatNumber(rewards.openOneTimeCount)}
          sub="one-time, unclaimed"
          icon={Gift}
          accent="blue"
        />
      </div>
    </div>
  );
}

/** Section wrapper with the heading, so the tab can drop it in directly. */
export function RewardsSummary({
  rewards,
  tips,
}: {
  rewards: UserRewards;
  tips: UserDetail["tips"];
}) {
  return (
    <div className="space-y-3">
      <SectionHeading icon={Gift} title="Rewards summary" />
      <RewardsSummarySection rewards={rewards} tips={tips} />
    </div>
  );
}
