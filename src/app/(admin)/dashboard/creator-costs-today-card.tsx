"use client";

import { Trophy, HandCoins, Gift, ArrowUpFromLine } from "lucide-react";
import { AnimatedNumber } from "@/components/animated-number";
import { formatCurrency } from "@/lib/utils/format";
import {
  DashboardHeroBox,
  DashboardStatusChip,
  DashboardFaceChip,
  DashboardInfoPopover,
  DashboardPopoverHeader,
  DashboardBreakdownRow,
  DashboardBreakdownTotal,
} from "./_boxes";

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
 * two largest lines as chips; the Info popover spells out every line, with
 * the leaderboard row annotated with BOTH the 100% pool and the our-cut
 * share.
 *
 * Composes the shared dashboard box primitives (./_boxes) so it reads as the
 * same family as the Reward Costs / P&L Today tiles. All props are
 * serializable primitives — no function props cross the RSC boundary per
 * CLAUDE.md.
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
    <DashboardHeroBox
      accent="rose"
      title="Creators Costs"
      caption={dayLabel}
      info={
        <CreatorCostsInfoPopover
          total={total}
          lines={lines}
          leaderboardFull={leaderboardFull}
          leaderboardOurCut={leaderboardOurCut}
          dayLabel={dayLabel}
        />
      }
      chip={<DashboardStatusChip icon={Trophy} accent="rose" />}
      // Total — a house COST, so always rose with a leading minus to read
      // as money out (House-POV). Uses the leaderboard our-cut share.
      value={
        <span className="text-rose-400">
          −<AnimatedNumber value={total} format="currency" />
        </span>
      }
      // Top-two line chips. Empty state (a quiet day) shows a single
      // neutral note so the card never collapses.
      chips={
        topLines.length > 0 ? (
          <>
            {topLines.map((l) => {
              // Leaderboard chip carries BOTH figures on its face: the full
              // 100% pool (context, muted) and our-cut (the house cost that
              // sums into the total, rose/primary). Only surface the full
              // pool when it's actually larger than our-cut (a sponsor % is
              // in play) — at 100% sponsorship the two are equal and the
              // "full /" prefix would just be noise.
              const showFull =
                l.key === "leaderboard" && leaderboardFull > l.amount;
              return (
                <DashboardFaceChip
                  key={l.key}
                  label={l.label}
                  value={l.amount}
                  tone="rose"
                  labelSuffix={
                    showFull ? (
                      <span className="ml-1 normal-case tracking-normal text-muted-foreground/70">
                        · 100% / ours
                      </span>
                    ) : undefined
                  }
                  title={
                    showFull
                      ? `${formatCurrency(leaderboardFull)} full pool at 100% / ${formatCurrency(l.amount)} our cut`
                      : undefined
                  }
                  valueNode={
                    showFull ? (
                      <>
                        <span className="text-muted-foreground">
                          {formatCurrency(leaderboardFull)}
                        </span>
                        <span className="mx-0.5 text-muted-foreground/60">
                          /
                        </span>
                        <span className="text-rose-600 dark:text-rose-400">
                          <AnimatedNumber value={l.amount} format="currency" />
                        </span>
                      </>
                    ) : undefined
                  }
                />
              );
            })}
          </>
        ) : undefined
      }
      footer={
        <p className="text-tiny text-muted-foreground">
          No creator spend yet today.
        </p>
      }
    />
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
 * Info popover for the creator-cost tile. Lists every creator-cost line with
 * its magnitude (rose — all are house costs). The leaderboard row is
 * annotated with BOTH the full 100% pool and the our-cut house share, so
 * it's clear the total uses the our-cut figure. The total at the bottom
 * equals creator withdrawals + tips + leaderboard our-cut.
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
    <DashboardInfoPopover
      accent="rose"
      label="Show today's creator-cost breakdown"
    >
      <DashboardPopoverHeader title="Creators costs today · breakdown">
        House spend on creator activity since 00:00 today (UTC) —{" "}
        <strong>{dayLabel}</strong> — not a rolling 24h window. Every line is
        money paid out (a house cost): deal-payout withdrawals the creator
        cashed out, house-funded tips, and house-funded leaderboard prizes.
        Leaderboard is shown at <strong>100%</strong> (full pool) and at{" "}
        <strong>our cut</strong> (after the creator&apos;s off-site sponsor %);
        the total uses the our-cut share.
      </DashboardPopoverHeader>

      {/* Line rows — each shows its magnitude, all rose (house cost). The
          leaderboard row carries the 100% pool as a sub-line. */}
      <ul className="space-y-0.5">
        {lines.map((l) => {
          const lbFull = l.key === "leaderboard" ? leaderboardFull : null;
          return (
            <DashboardBreakdownRow
              key={l.key}
              icon={lineIcon(l.key)}
              label={l.label}
              sub={
                lbFull != null && lbFull > 0
                  ? `${formatCurrency(lbFull)} pool at 100%`
                  : undefined
              }
              amount={l.amount}
              sign="−"
              tone={l.amount > 0 ? "rose" : "neutral"}
            />
          );
        })}
      </ul>

      {/* Bottom math: the lines sum to the total. Rose — a house cost. The
          leaderboard 100% vs our-cut callout makes the gap explicit. */}
      <DashboardBreakdownTotal
        label="Total creator cost"
        amount={total}
        sign="−"
        tone="rose"
        note={
          leaderboardFull > 0 ? (
            <>
              Leaderboard at 100%:{" "}
              <span className="font-semibold tabular-nums text-foreground/80">
                {formatCurrency(leaderboardFull)}
              </span>{" "}
              · our cut:{" "}
              <span className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(leaderboardOurCut)}
              </span>
            </>
          ) : undefined
        }
      />
    </DashboardInfoPopover>
  );
}
