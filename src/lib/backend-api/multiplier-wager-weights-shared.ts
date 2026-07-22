/**
 * Shared runtime constants + tier type for the multiplier wager-weight
 * admin surface (server-only API module, server action, client card on
 * /security and the dev fixture).
 *
 * Deliberately NOT "server-only": the client card needs the runtime
 * constants (destination list, tier cap, default tiers), and a VALUE import
 * from multiplier-wager-weights.ts would drag `import "server-only"` into
 * the client bundle and fail `npm run build` (type-only imports are erased,
 * value imports are not). Same rationale as crypto-fees-assets.ts.
 *
 * Source of truth (shapes + validation):
 *   packy-backend/src/routes/v1/admin/multiplier-wager-weights.ts
 */

/**
 * The 3 destinations the admin manages. GET may also return a retired
 * `shards` destination — the shard system is no longer used on-site, so it's
 * neither listed nor editable here and the extra field is ignored.
 */
export const MULTIPLIER_WEIGHT_DESTINATIONS = [
  "withdrawal",
  "rakeback",
  "leaderboard",
] as const;

export type MultiplierWeightDestination =
  (typeof MULTIPLIER_WEIGHT_DESTINATIONS)[number];

/**
 * One discount tier. A bet with payout multiplier m counts at the FIRST
 * tier (ascending max_x) where m < max_x; at or above the highest max_x it
 * counts 100%. weight_bps is an int 0..10000 (10000 = 100%); max_x is
 * finite, > 1 and <= 100000, strictly ascending within a list.
 */
export type MultiplierTier = {
  max_x: number;
  weight_bps: number;
};

/** Backend tier-list cap: 0–10 tiers per destination. */
export const MAX_MULTIPLIER_TIERS = 10;

/**
 * Backend defaults: below 1.25× → 20%, 1.25–1.50× → 50% (all destinations
 * disabled by default).
 */
export const DEFAULT_MULTIPLIER_TIERS: MultiplierTier[] = [
  { max_x: 1.25, weight_bps: 2000 },
  { max_x: 1.5, weight_bps: 5000 },
];
