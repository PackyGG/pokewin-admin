"use client";

import { MultiplierWagerWeightsCard } from "@/app/(admin)/security/multiplier-wager-weights-card";
import { DEFAULT_MULTIPLIER_TIERS } from "@/lib/backend-api/multiplier-wager-weights-shared";
import type { MultiplierWagerWeights } from "@/lib/backend-api/multiplier-wager-weights";

/**
 * Static, representative multiplier-weight config for the dev-only
 * fixture: the backend defaults (below 1.25× → 20%, 1.25–1.50× → 50%,
 * disabled) on two destinations, one enabled destination with a longer
 * custom ladder and one enabled destination with an EMPTY tier list, so
 * both Switch states, fractional weights and the empty-tiers copy all
 * render.
 */
const FIXTURE_WEIGHTS: MultiplierWagerWeights = {
  withdrawal: { enabled: false, tiers: [...DEFAULT_MULTIPLIER_TIERS] },
  rakeback: {
    enabled: true,
    tiers: [
      { max_x: 1.1, weight_bps: 1000 },
      { max_x: 1.25, weight_bps: 2275 },
      { max_x: 1.5, weight_bps: 5000 },
      { max_x: 2, weight_bps: 7550 },
    ],
  },
  leaderboard: { enabled: true, tiers: [...DEFAULT_MULTIPLIER_TIERS] },
  shards: { enabled: true, tiers: [] },
};

export function MultiplierWagerWeightsFixtureClient() {
  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Populated (backend reachable)
        </h2>
        <MultiplierWagerWeightsCard initial={FIXTURE_WEIGHTS} />
      </section>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Degraded (awaiting backend deploy)
        </h2>
        <MultiplierWagerWeightsCard initial={null} />
      </section>
    </div>
  );
}
