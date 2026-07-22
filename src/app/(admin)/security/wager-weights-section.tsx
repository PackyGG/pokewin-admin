"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LeaderboardWagerWeightsCard } from "./leaderboard-wager-weights-card";
import { RakebackWagerWeightsCard } from "./rakeback-wager-weights-card";
import { SourceWagerWeightsCard } from "./source-wager-weights-card";
import { MultiplierWagerWeightsCard } from "./multiplier-wager-weights-card";
import type { LeaderboardWagerWeights } from "@/lib/backend-api/leaderboard-wager-weights";
import type { RakebackWagerWeights } from "@/lib/backend-api/rakeback-wager-weights";
import type { SourceWagerWeights } from "@/lib/backend-api/source-wager-weights";
import type { MultiplierWagerWeights } from "@/lib/backend-api/multiplier-wager-weights";

/**
 * Umbrella for the 4 wager-weight cards, previously 4 separate top-level
 * /security sections that all looked like near-identical grids of number
 * inputs (owner: "so confusing and messy" — Leaderboard vs Funding-Source
 * weights got mixed up in practice, see the 2026-07-22 race-prize incident).
 * Each tab is a DIFFERENT AXIS of "how much does this wager count", not a
 * duplicate of the others:
 *
 *   - Leaderboards  — BY GAME (packs/battles/upgrader), feeds official
 *     races + creator/affiliate leaderboards.
 *   - Rakeback      — BY GAME, feeds the rakeback wager base. Same axis as
 *     Leaderboards, different destination — kept as its own tab (not
 *     merged) because the two cards edit independent backend fields.
 *   - Funding Source — BY WHERE THE MONEY CAME FROM (deposit vs race prize
 *     vs rain vs rakeback vs affiliate vs tips), across withdrawal /
 *     rakeback / leaderboard destinations at once.
 *   - Multiplier Tiers — BY THE PAYOUT MULTIPLIER the player picked
 *     (upgrader only) — discounts near-guaranteed low-multiplier bets.
 *
 * Each card's own internals, actions, and backend calls are UNCHANGED —
 * this only re-parents them under one collapsible + tab bar instead of 4
 * separate top-level sections.
 */
export function WagerWeightsSection({
  leaderboardWeights,
  rakebackWeights,
  sourceWeights,
  multiplierWeights,
}: {
  leaderboardWeights: LeaderboardWagerWeights | null;
  rakebackWeights: RakebackWagerWeights | null;
  sourceWeights: SourceWagerWeights | null;
  multiplierWeights: MultiplierWagerWeights | null;
}) {
  return (
    <Tabs defaultValue="leaderboard">
      <TabsList className="h-auto flex-wrap">
        <TabsTrigger value="leaderboard">Leaderboards</TabsTrigger>
        <TabsTrigger value="rakeback">Rakeback</TabsTrigger>
        <TabsTrigger value="source">Funding Source</TabsTrigger>
        <TabsTrigger value="multiplier">Multiplier Tiers</TabsTrigger>
      </TabsList>

      <TabsContent value="leaderboard" className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Weight BY GAME (packs / battles / upgrader) — feeds official races
          and creator/affiliate leaderboards.
        </p>
        <LeaderboardWagerWeightsCard initial={leaderboardWeights} />
      </TabsContent>

      <TabsContent value="rakeback" className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Weight BY GAME (packs / battles / upgrader) — feeds the rakeback
          wager base. Same axis as Leaderboards, different destination.
        </p>
        <RakebackWagerWeightsCard initial={rakebackWeights} />
      </TabsContent>

      <TabsContent value="source" className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Weight BY WHERE THE MONEY CAME FROM (deposit vs race prize, rain,
          rakeback, affiliate, tips) — across withdrawal, rakeback, and
          leaderboard destinations at once.
        </p>
        <SourceWagerWeightsCard initial={sourceWeights} />
      </TabsContent>

      <TabsContent value="multiplier" className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Weight BY PAYOUT MULTIPLIER the player picked (upgrader only) —
          discounts near-guaranteed low-multiplier bets.
        </p>
        <MultiplierWagerWeightsCard initial={multiplierWeights} />
      </TabsContent>
    </Tabs>
  );
}
