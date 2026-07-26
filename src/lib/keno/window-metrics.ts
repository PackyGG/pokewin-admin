export type KenoWindowMetrics = {
  games: number;
  players: number;
  wager: number;
  payout: number;
  profit: number;
  edgePct: number;
};

/**
 * Derive the house-facing Keno result for one settled-game window.
 *
 * Profit is wager minus player payouts. Realized edge is profit divided by
 * wager, expressed in percentage points for direct display (7.5 = 7.5%).
 */
export function deriveKenoWindowMetrics({
  games,
  players,
  wager,
  payout,
}: {
  games: number;
  players: number;
  wager: number;
  payout: number;
}): KenoWindowMetrics {
  const profit = wager - payout;

  return {
    games,
    players,
    wager,
    payout,
    profit,
    edgePct: wager > 0 ? (profit / wager) * 100 : 0,
  };
}
