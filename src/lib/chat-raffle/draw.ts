import { createHmac, randomBytes } from "node:crypto";

/**
 * draw.ts — the seeded, reproducible ticket draw.
 *
 * A raffle nobody can check is just an announcement. So the draw is a pure
 * function of two persisted things:
 *
 *   • `draw_seed` — 48 hex chars from the CSPRNG, generated once and stored
 *     on the round, and
 *   • `chat_raffle_entries` — the standings FROZEN at draw time, each with a
 *     ticket count and its first ticket number in the cumulative range.
 *
 * Winner N is then:
 *
 *     HMAC-SHA256(seed, "<round id>:<n>") → first 64 bits → mod totalTickets
 *
 * Anyone holding the seed and the snapshot can replay it and land on the same
 * user. Nothing here reads the clock or the RNG at replay time.
 *
 * ─── Every place is an independent draw ──────────────────────────────────
 *
 * The pool does NOT shrink between places, so one user can take more than one
 * prize. That is deliberate (see CHAT_RAFFLE_FIXED_RULES in ./config.ts):
 * tickets ARE the weighting model, so removing a winner mid-draw would
 * silently re-weight everyone else's odds for the remaining places. Keeping
 * the pool intact means each place pays out at exactly the odds the standings
 * published — and it keeps the snapshot's `ticket_start` ranges valid for
 * every pick, not just the first.
 *
 * Modulo bias: a 64-bit draw against a ticket pool that will realistically be
 * in the thousands biases the result by under 2^-40. Not worth a rejection
 * loop.
 */

export type DrawPoolEntry = {
  userId: string;
  username: string | null;
  tickets: number;
};

export type DrawWinner = {
  /** 1-based prize place this winner takes. */
  position: number;
  userId: string;
  username: string | null;
  /** The winner's ticket count in the frozen snapshot. */
  tickets: number;
  /** The 0-based ticket the draw landed on, within the full pool. */
  winningTicket: bigint;
};

/** 48 hex chars of CSPRNG. Generated once per round, at draw time. */
export function generateDrawSeed(): string {
  return randomBytes(24).toString("hex");
}

/**
 * Deterministic 64-bit draw value for pick `n` of `roundId` under `seed`.
 * Exported so a verification script can replay a past round without pulling
 * in the whole draw.
 */
export function drawValue(seed: string, roundId: string, n: number): bigint {
  const digest = createHmac("sha256", seed).update(`${roundId}:${n}`).digest("hex");
  return BigInt(`0x${digest.slice(0, 16)}`);
}

/**
 * Pick one winner per prize place, in position order.
 *
 * Returns no winners at all when the pool holds no tickets — the caller
 * leaves those places unfilled rather than inventing a winner.
 */
export function drawWinners(params: {
  roundId: string;
  seed: string;
  /** Frozen entries, already ordered by position. */
  entries: DrawPoolEntry[];
  prizeCount: number;
}): DrawWinner[] {
  const { roundId, seed, prizeCount } = params;
  const pool = params.entries.filter((e) => e.tickets > 0);
  const total = pool.reduce((sum, e) => sum + e.tickets, 0);
  if (total <= 0) return [];

  const winners: DrawWinner[] = [];

  for (let n = 1; n <= prizeCount; n++) {
    const winningTicket = drawValue(seed, roundId, n) % BigInt(total);

    // Walk the cumulative ranges to find whose ticket that is.
    let cursor = BigInt(0);
    let hitIndex = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      cursor += BigInt(pool[i].tickets);
      if (winningTicket < cursor) {
        hitIndex = i;
        break;
      }
    }

    const hit = pool[hitIndex];
    winners.push({
      position: n,
      userId: hit.userId,
      username: hit.username,
      tickets: hit.tickets,
      winningTicket,
    });
  }

  return winners;
}
