"use client";

import { Gift, CloudRain } from "lucide-react";
import { AnimatedNumber } from "@/components/animated-number";
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
 * "Reward Costs (today)" dashboard tile — what the house SPENT on rewards
 * for the CURRENT CALENDAR DAY since 00:00 UTC (NOT a rolling past-24h
 * window — the same boundary as the P&L Today tile).
 *
 * Every line is money the house paid OUT to users → a house COST → rose
 * per CLAUDE.md's House-POV rule (a reward we pay a user is a dollar we
 * spent). The card face shows the rose total + the two largest lines as
 * chips; the Info popover spells out every line so the owner sees where it
 * went — deposit bonuses, daily/free packs, signup/balance rewards,
 * rakeback, promo/gift cards, race prizes, leaderboard prizes, manual
 * vouchers, promo balance credits, and the flat rain line ($2/hr).
 *
 * Rain is the OWNER-CONFIRMED flat model: $2 × hours elapsed since UTC
 * midnight ("we don't pay anything else for it") — NOT the summed rain
 * payouts. Affiliate commissions are EXCLUDED entirely.
 *
 * Composes the shared dashboard box primitives (./_boxes) so it reads as
 * the same family as the P&L Today tile. All props are serializable
 * primitives — no function props cross the RSC boundary per CLAUDE.md.
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
    <DashboardHeroBox
      accent="rose"
      title="Reward Costs"
      caption={dayLabel}
      info={
        <RewardCostsInfoPopover
          total={total}
          lines={lines}
          dayLabel={dayLabel}
          hoursElapsed={hoursElapsed}
        />
      }
      chip={<DashboardStatusChip icon={Gift} accent="rose" />}
      // Total — a house COST, so always rose with a leading minus to read
      // as money out (House-POV).
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
            {topLines.map((l) => (
              <DashboardFaceChip
                key={l.key}
                label={l.label}
                value={l.amount}
                tone="rose"
              />
            ))}
          </>
        ) : undefined
      }
      footer={
        <p className="text-tiny text-muted-foreground">
          No reward spend yet today.
        </p>
      }
    />
  );
}

/**
 * Info popover for the reward-cost tile. Lists every reward-cost line with
 * its magnitude (rose — all are house costs), with the rain line annotated
 * as the flat $2/hr model and the total at the bottom (the lines sum to
 * the total).
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
    <DashboardInfoPopover
      accent="rose"
      label="Show today's reward-cost breakdown"
    >
      <DashboardPopoverHeader title="Reward costs today · breakdown">
        House-funded reward spend since 00:00 today (UTC) —{" "}
        <strong>{dayLabel}</strong> — not a rolling 24h window. Every line is
        money paid out to users (a house cost). Rain is the flat{" "}
        <span className="font-mono">$2/hr</span> model (
        {hoursElapsed.toFixed(1)}h elapsed); affiliate commissions are
        excluded. Real customers only (staff + excluded users dropped).
      </DashboardPopoverHeader>

      {/* Line rows — each shows its magnitude, all rose (house cost). */}
      <ul className="space-y-0.5">
        {lines.map((l) => {
          const isRain = l.key === "rain";
          return (
            <DashboardBreakdownRow
              key={l.key}
              icon={isRain ? CloudRain : Gift}
              label={l.label}
              sub={isRain ? "Flat $2 per hour" : undefined}
              amount={l.amount}
              sign="−"
              tone={l.amount > 0 ? "rose" : "neutral"}
            />
          );
        })}
      </ul>

      {/* Bottom math: the lines sum to the total. Rose — a house cost. */}
      <DashboardBreakdownTotal
        label="Total reward cost"
        amount={total}
        sign="−"
        tone="rose"
      />
    </DashboardInfoPopover>
  );
}
