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
 *     house COST → ROSE — but ONLY when the figure is actually > 0. An exact
 *     $0.00 means nothing happened in that category yet; that's neutral, not
 *     a house cost, so it renders muted/blue instead of rose (bug fix —
 *     these boxes previously hardcoded rose regardless of the value, so a
 *     user with no rain/race/leaderboard/rakeback activity saw every box in
 *     red for $0.00).
 *   • tips SENT (the user spending) → house GAIN → EMERALD (same zero-aware
 *     rule — no tips sent = neutral, not emerald).
 *   • unopened one-time rewards (a neutral count, not money) → BLUE.
 *
 * LAYOUT: the Rakeback box (the "big box") sits on the LEFT with the
 * reward-payout display boxes to its RIGHT on lg+ viewports, stacked below
 * it on narrower ones (owner request — was full-width-stacked before).
 * The two columns share the SAME row height via `lg:items-stretch` (grid's
 * own default, made explicit — mirrors the Overview 3-up panel row in
 * user-view-modern-tabs.tsx) instead of the `lg:items-start` this shipped
 * with, which forced each column to size to only its OWN content — since
 * the payout-tile grid is naturally much shorter than the Rakeback panel,
 * that produced a visibly mismatched-height "weird af" layout (owner
 * report, 2026-07-12). The shorter tile column is then vertically centered
 * within the shared height via its own `h-full flex flex-col justify-center`
 * wrapper, so it stays correct however many payout tiles render.
 *
 * VISUAL REDESIGN (owner, 2026-07-12: "the UI right now is horrible" — full
 * pass, not a patch):
 *   • Rakeback panel had NO hero — "Claimed" and "Claimable" were rendered
 *     as the same tiny `MiniStat` scale as the cadence sub-breakdown below
 *     them, so nothing drew the eye first and the panel read flat. Promoted
 *     both to a hero-number pair (same `text-xl sm:text-2xl font-bold`
 *     treatment `ModernBalancePanel`/`ModernPnlPanel` use for their headline
 *     number in `./user-view-modern-panels.tsx`), with the cadence
 *     breakdown demoted below a `border-t` divider — mirrors the established
 *     "hero number(s) → breakdown grid" shape used everywhere else on this
 *     page instead of inventing a new one.
 *   • Added matching subsection labels ("Claimed by cadence" already
 *     existed; "Reward payouts" added above the tile grid) so both halves
 *     of the row read as clearly labeled groups instead of one box with a
 *     title and one without.
 *   • Fixed a real 2-col/3-tile orphan-row wrap in the sibling pack-opens
 *     section's daily-highlight strip (see reward-pack-opens-section.tsx).
 *
 * VISUAL REDESIGN ROUND 2 (owner: "looks the same still ass", screenshot):
 * the round-1 pass fixed hierarchy/labels but left `PayoutTile` as a
 * top-left stacked block (icon+label row, value below) inside a grid cell
 * that stretches to fill whatever width the `1fr` payout column gets — on a
 * wide viewport that leaves most of each tile empty below/right of the
 * content, which reads as unfinished. Rebuilt `PayoutTile` as a horizontal
 * icon-chip row (chip left, label/value column, optional meta caption right)
 * so it fills its full height at any tile width instead of leaving dead
 * space, using the same icon-chip treatment `StatPanel`'s header already
 * uses. No prop shape change — every call site (this file +
 * reward-pack-opens-section.tsx) is unaffected.
 *
 * PRIMITIVES: imports `SectionHeading` / `StatPanel` from the page-local
 * FLAT fork (`./user-view-modern-panels`), not the shared, colorful
 * gradient/corner-glow versions in `@/components/modern-panels`. This page
 * flattened its own primitives in the "cleaner & flatter" pilot; a later
 * commit that added this file imported the global colorful ones by mistake,
 * silently reintroducing the gradient fill + corner glow this page had just
 * dropped everywhere else. The reward-payout tiles use a small page-local
 * `PayoutTile` (flat, same vocabulary as `MiniStat`) instead of the
 * shared/oversized `KpiTile` for the same reason.
 *
 * NOT SHOWN (data gap, flagged — NOT fabricated): "sponsored / free battles"
 * as a reward TO the user has no metric — `battle_sponsorship` is the user
 * PAYING to sponsor a battle (a wager / house gain), the opposite of a reward,
 * and there is no per-user "free battles joined" credit. So no box is drawn
 * for it rather than showing a misleading number.
 */

import { Percent, Trophy, Flag, Award, ArrowDownToLine, ArrowUpRight, Gift } from "lucide-react";
import { SectionHeading, StatPanel } from "./user-view-modern-panels";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import type { UserRewards } from "@/lib/queries/users";
import type { UserDetail } from "./user-tabs-types";

const ROSE = "text-rose-600 dark:text-rose-400";
const EMERALD = "text-emerald-600 dark:text-emerald-400";
const BLUE = "text-blue-600 dark:text-blue-400";
const NEUTRAL = "text-muted-foreground";

/** Flat-tile accent keys — House-POV colors (rose/emerald/blue) plus the
 *  handful of informational hues `reward-pack-opens-section` reuses
 *  `PayoutTile` for (cyan/amber/purple — cadence/type groupings, not
 *  money-sign-driven). */
type PayoutTileAccent = "rose" | "emerald" | "blue" | "cyan" | "amber" | "purple";

const ACCENT_TEXT: Record<PayoutTileAccent, string> = {
  rose: ROSE,
  emerald: EMERALD,
  blue: BLUE,
  cyan: "text-cyan-600 dark:text-cyan-400",
  amber: "text-amber-600 dark:text-amber-400",
  purple: "text-purple-600 dark:text-purple-400",
};
const ACCENT_ICON: Record<PayoutTileAccent, string> = {
  rose: "text-rose-500",
  emerald: "text-emerald-500",
  blue: "text-blue-500",
  cyan: "text-cyan-500",
  amber: "text-amber-500",
  purple: "text-purple-500",
};

/** Icon-chip background per accent — same token values as `TILE_COLORS` in
 *  `./user-view-modern-panels` (kept as a local copy since `PayoutTile` uses
 *  its own accent union, which includes cyan/amber/purple on top of the
 *  House-POV rose/emerald/blue). */
const ACCENT_CHIP: Record<PayoutTileAccent, string> = {
  rose: "bg-rose-500/10",
  emerald: "bg-emerald-500/10",
  blue: "bg-blue-500/10",
  cyan: "bg-cyan-500/10",
  amber: "bg-amber-500/10",
  purple: "bg-purple-500/10",
};

/**
 * House-POV money color for a rakeback figure — zero-aware. A genuine house
 * cost (amount > 0) still gets the rose tint; an exact $0.00 means nothing
 * has happened yet (no claim, no cadence used) — that's neutral, not a
 * loss, so it must NOT render rose. Mirrors the zero-is-flat convention
 * already used by `RollingPnlChip` on this same page.
 */
function rakebackValueClass(amountUsd: number): string {
  return amountUsd > 0 ? ROSE : NEUTRAL;
}

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

/**
 * Flat "display box" for a reward-payout category — icon CHIP + label/value
 * column + an optional right-aligned meta caption, laid out as a horizontal
 * row (not a top-left stack). A stacked layout left most of a wide grid cell
 * empty below the content (owner, 2026-07-12 round 2: "looks the same still
 * ass" — the wide near-empty tiles in the screenshot were the actual defect,
 * not the numbers/labels). The icon-chip + row layout fills the tile's full
 * height regardless of width and reads as an intentional list-row instead of
 * a mostly-empty box — same chip treatment `StatPanel`'s header icon uses in
 * `./user-view-modern-panels`, just sized for a compact tile. Exported so
 * `reward-pack-opens-section` (the sibling Rewards-tab section) reuses the
 * same tile instead of pulling in the colorful global `KpiTile`.
 */
export function PayoutTile({
  label,
  value,
  sub,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  accent: PayoutTileAccent;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border bg-card px-3 py-3">
      <div
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg",
          ACCENT_CHIP[accent],
        )}
      >
        <Icon className={cn("size-4", ACCENT_ICON[accent])} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </p>
        <p
          className={cn(
            "mt-0.5 truncate text-lg font-bold tracking-tight tabular-nums",
            ACCENT_TEXT[accent],
          )}
        >
          {value}
        </p>
      </div>
      {sub && (
        <span className="shrink-0 whitespace-nowrap text-right text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {sub}
        </span>
      )}
    </div>
  );
}

function RewardsSummarySection({
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
  // (The actual rendered accent is zero-aware — see `PayoutTile` call
  // below — an exact-zero total renders neutral/blue instead of this base
  // accent.)
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
    // Rakeback (the "big box") on the LEFT, reward-payout display boxes on
    // the RIGHT, side by side on lg+ — stacked (box, then tile grid) below
    // that so neither column gets cramped on phones/tablets.
    // `lg:items-stretch` (see doc comment above) keeps both columns at the
    // same height instead of each sizing to its own content.
    <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_1fr] lg:items-stretch">
      {/* ── Rakeback (lead) ───────────────────────────────────────────── */}
      <StatPanel title="Rakeback" icon={Percent} accent="rose">
        {/* Claimed lifetime + claimable now — the two headline numbers,
            promoted to hero scale (was the same tiny MiniStat size as the
            cadence breakdown below, so nothing drew the eye first). Mirrors
            the hero-number treatment ModernBalancePanel/ModernPnlPanel use
            for their own headline figure. Stacks on the narrowest widths
            (this panel goes full-bleed below `lg`) so two currency values
            never fight for space in a 360px column. */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Claimed (lifetime)
            </p>
            <p
              className={cn(
                "mt-1 truncate text-xl font-bold tracking-tight tabular-nums sm:text-2xl",
                rakebackValueClass(rewards.rakebackClaimedUsd),
              )}
            >
              {formatCurrency(rewards.rakebackClaimedUsd)}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {formatNumber(rewards.rakebackClaimedCount)}{" "}
              {rewards.rakebackClaimedCount === 1 ? "claim" : "claims"}
            </p>
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Claimable now
            </p>
            <p
              className={cn(
                "mt-1 truncate text-xl font-bold tracking-tight tabular-nums sm:text-2xl",
                rakebackValueClass(rewards.rakebackClaimableUsd),
              )}
            >
              {formatCurrency(rewards.rakebackClaimableUsd)}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              unclaimed liability
            </p>
          </div>
        </div>

        {/* Cadence sub-breakdown of CLAIMED — the three slices sum to the
            claimed total above (daily|weekly|monthly is the full enum).
            Demoted below a divider so it reads as detail under the hero
            pair above, not equal-weight with it. */}
        <div className="mt-4 border-t pt-3">
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Claimed by cadence
          </p>
          <div className="grid grid-cols-3 gap-2">
            <MiniStat
              label="Daily"
              value={formatCurrency(byFrequency.daily.claimedUsd)}
              valueClassName={rakebackValueClass(byFrequency.daily.claimedUsd)}
              sub={`${formatNumber(byFrequency.daily.claimedCount)} claims`}
            />
            <MiniStat
              label="Weekly"
              value={formatCurrency(byFrequency.weekly.claimedUsd)}
              valueClassName={rakebackValueClass(byFrequency.weekly.claimedUsd)}
              sub={`${formatNumber(byFrequency.weekly.claimedCount)} claims`}
            />
            <MiniStat
              label="Monthly"
              value={formatCurrency(byFrequency.monthly.claimedUsd)}
              valueClassName={rakebackValueClass(byFrequency.monthly.claimedUsd)}
              sub={`${formatNumber(byFrequency.monthly.claimedCount)} claims`}
            />
          </div>

          {/* "Of which instant" — a CROSS-CUTTING subset, not a 4th cadence.
              Hidden when the early-claim column is absent (drift → null). */}
          {hasInstant && rewards.instantClaimedCount! > 0 ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              of which instant-claimed:{" "}
              <span
                className={cn(
                  "font-semibold tabular-nums",
                  rakebackValueClass(rewards.instantClaimedUsd!),
                )}
              >
                {formatCurrency(rewards.instantClaimedUsd!)}
              </span>{" "}
              · {formatNumber(rewards.instantClaimedCount!)}{" "}
              {rewards.instantClaimedCount === 1 ? "claim" : "claims"}
            </p>
          ) : null}
        </div>
      </StatPanel>

      {/* ── Reward payouts ("display boxes") ─────────────────────────────
          A matching StatPanel that mirrors the Rakeback panel on the left
          (same flat bordered box + header treatment) so the two columns read
          as an aligned equal-height PAIR instead of a big box sitting next to
          small floating tiles (owner: "reward payout boxes so much smaller
          than the rakeback one — make it all align"). `lg:items-stretch` on
          the outer grid keeps both panels the same height; the tile grid
          fills that height (`flex-1` + `auto-rows-fr`) so the tiles grow to
          the panel edges and line up with the Rakeback panel. */}
      <StatPanel title="Reward payouts" icon={Gift} accent="blue">
        <div className="grid flex-1 auto-rows-fr grid-cols-2 gap-3 sm:grid-cols-3">
          {payouts.map((p) => (
            <PayoutTile
              key={p.key}
              label={p.label}
              value={formatCurrency(p.total)}
              sub={`${formatNumber(p.count)} ${p.count === 1 ? p.unit : `${p.unit}s`}`}
              icon={p.icon}
              // Zero-aware House-POV: nothing paid out yet = neutral, not a
              // house cost/gain in either direction — only a genuine nonzero
              // total keeps the category's accent.
              accent={p.total > 0 ? p.accent : "blue"}
            />
          ))}
          {/* Unopened one-time rewards — a neutral COUNT (rewards available
              to open), not money → blue. Preserves the datum the old card
              showed. */}
          <PayoutTile
            label="Unopened Rewards"
            value={formatNumber(rewards.openOneTimeCount)}
            sub="one-time, unclaimed"
            icon={Gift}
            accent="blue"
          />
        </div>
      </StatPanel>
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
