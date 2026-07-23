// =============================================================================
// chat-raffle-draw.test.ts — seeded raffle draw proof (NO DB).
//
// The draw decides who gets real money, so its properties are asserted here
// against the REAL functions the action calls (src/lib/chat-raffle/draw.ts) —
// no replica, so these can't silently drift from runtime behaviour.
//
// The properties that matter:
//   1. DETERMINISM      — same seed + same pool ⇒ same winners, always.
//      Without this the "reproducible draw" claim on the UI is a lie.
//   2. SEED SENSITIVITY  — a different seed generally moves the winners.
//   3. WEIGHTING         — a user with more tickets wins proportionally more
//      often. Empirically checked over many seeds; a draw that ignored
//      `tickets` would fail here.
//   4. NO REPEAT WINNERS — with the flag off, one user can hold at most one
//      place, and the pool draining is what allows a short pool to yield
//      fewer winners than prizes rather than duplicating someone.
//   5. REPEAT WINNERS ON — a single-entrant pool can legitimately sweep.
//   6. POOL EXHAUSTION   — 5 prizes, 3 entrants, no repeats ⇒ 3 winners, not
//      a crash and not an invented winner.
//   7. ZERO-TICKET SAFETY — entries with 0 tickets never win and an all-zero
//      pool yields nothing (guards a mod-by-zero).
//
// Run via tsx:
//   npx tsx --test scripts/__fixtures__/chat-raffle-draw.test.ts
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  drawValue,
  drawWinners,
  type DrawPoolEntry,
} from "../../src/lib/chat-raffle/draw";

const ROUND = "11111111-2222-3333-4444-555555555555";

function pool(...spec: [string, number][]): DrawPoolEntry[] {
  return spec.map(([userId, tickets]) => ({
    userId,
    username: userId,
    tickets,
  }));
}

const BASE = pool(["alice", 500], ["bob", 300], ["carol", 200]);

test("same seed + same pool always yields the same winners", () => {
  const args = {
    roundId: ROUND,
    seed: "a".repeat(48),
    entries: BASE,
    prizeCount: 3,
    allowRepeatWinners: false,
  };
  const first = drawWinners(args);
  const second = drawWinners(args);
  assert.deepEqual(
    first.map((w) => w.userId),
    second.map((w) => w.userId),
    "a re-run of the same draw must reproduce it exactly",
  );
  assert.deepEqual(
    first.map((w) => w.winningTicket),
    second.map((w) => w.winningTicket),
    "the landed ticket numbers must reproduce too",
  );
});

test("drawValue is stable and seed-dependent", () => {
  const a = drawValue("seed-one", ROUND, 1);
  assert.equal(a, drawValue("seed-one", ROUND, 1), "must be deterministic");
  assert.notEqual(
    a,
    drawValue("seed-two", ROUND, 1),
    "a different seed must give a different value",
  );
  assert.notEqual(
    a,
    drawValue("seed-one", ROUND, 2),
    "a different pick index must give a different value",
  );
});

test("more tickets wins measurably more often", () => {
  // 90/10 split. Over 400 seeds the heavy favourite should land far more
  // often than the long shot; the assertion is deliberately loose (>2x) so
  // it proves weighting without being a flaky exact-frequency test.
  const weighted = pool(["whale", 900], ["minnow", 100]);
  let whale = 0;
  let minnow = 0;
  for (let i = 0; i < 400; i++) {
    const [winner] = drawWinners({
      roundId: ROUND,
      seed: `seed-${i}`,
      entries: weighted,
      prizeCount: 1,
      allowRepeatWinners: false,
    });
    if (winner.userId === "whale") whale++;
    else minnow++;
  }
  assert.ok(
    whale > minnow * 2,
    `expected the 900-ticket entry to dominate, got whale=${whale} minnow=${minnow}`,
  );
  assert.ok(
    minnow > 0,
    `expected the 100-ticket entry to still win sometimes, got ${minnow}`,
  );
});

test("no repeat winners: each user takes at most one place", () => {
  for (let i = 0; i < 100; i++) {
    const winners = drawWinners({
      roundId: ROUND,
      seed: `seed-${i}`,
      entries: BASE,
      prizeCount: 3,
      allowRepeatWinners: false,
    });
    const ids = winners.map((w) => w.userId);
    assert.equal(
      new Set(ids).size,
      ids.length,
      `duplicate winner in seed-${i}: ${ids.join(", ")}`,
    );
  }
});

test("repeat winners allowed: a lone entrant can sweep every place", () => {
  const winners = drawWinners({
    roundId: ROUND,
    seed: "solo",
    entries: pool(["only", 10]),
    prizeCount: 3,
    allowRepeatWinners: true,
  });
  assert.equal(winners.length, 3);
  assert.ok(winners.every((w) => w.userId === "only"));
});

test("pool exhaustion yields fewer winners, never an invented one", () => {
  const winners = drawWinners({
    roundId: ROUND,
    seed: "short-pool",
    entries: BASE, // 3 entrants
    prizeCount: 5, // 5 places
    allowRepeatWinners: false,
  });
  assert.equal(winners.length, 3, "only 3 eligible entrants exist");
  assert.deepEqual(
    winners.map((w) => w.position),
    [1, 2, 3],
    "unfilled places are simply absent, positions stay 1..n",
  );
  assert.equal(new Set(winners.map((w) => w.userId)).size, 3);
});

test("zero-ticket entries never win and an empty pool draws nobody", () => {
  const withZeros = pool(["ghost", 0], ["real", 5], ["ghost2", 0]);
  for (let i = 0; i < 50; i++) {
    const winners = drawWinners({
      roundId: ROUND,
      seed: `z-${i}`,
      entries: withZeros,
      prizeCount: 3,
      allowRepeatWinners: false,
    });
    assert.ok(
      winners.every((w) => w.tickets > 0),
      "a 0-ticket entry must never be drawn",
    );
    assert.equal(winners.length, 1, "only one entry actually holds tickets");
  }

  assert.deepEqual(
    drawWinners({
      roundId: ROUND,
      seed: "all-zero",
      entries: pool(["a", 0], ["b", 0]),
      prizeCount: 2,
      allowRepeatWinners: false,
    }),
    [],
    "an all-zero pool must draw nobody (and not divide by zero)",
  );

  assert.deepEqual(
    drawWinners({
      roundId: ROUND,
      seed: "empty",
      entries: [],
      prizeCount: 2,
      allowRepeatWinners: false,
    }),
    [],
  );
});

test("the landed ticket always falls inside the pool it was drawn from", () => {
  for (let i = 0; i < 100; i++) {
    const winners = drawWinners({
      roundId: ROUND,
      seed: `range-${i}`,
      entries: BASE,
      prizeCount: 3,
      allowRepeatWinners: false,
    });
    // Pool shrinks by the previous winner's tickets on each pick.
    let remaining = BASE.reduce((sum, e) => sum + e.tickets, 0);
    for (const w of winners) {
      assert.ok(
        w.winningTicket >= BigInt(0) && w.winningTicket < BigInt(remaining),
        `ticket ${w.winningTicket} outside 0..${remaining} at place ${w.position}`,
      );
      remaining -= w.tickets;
    }
  }
});
