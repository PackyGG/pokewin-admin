---
name: pack-fleet-sweep-2026-07
description: "183-pack retune replay 2026-07-24 — 0 stuck, 0 throws, 0 money-law breaches; how to rebuild the harness and the two checks that gave false positives"
metadata: 
  node_type: memory
  type: project
  originSessionId: 1f5e9843-3e48-40dc-9ba0-9627571fea93
  modified: 2026-07-24T01:07:21.120Z
---

Full fleet replay of the retune solver over all **183 active official priced
packs**, 2026-07-24. Result: **0 stuck, 0 throws, 0 money-law violations**, and
the engine is deterministic with NO cross-pack state leakage (verified: same
pack solved cold, twice, and after guidance ran for all 183 → identical).

**Corrected fleet health at the real default budget (±10%):**
172 feasible / 11 refuse · 134 clean-snap / 38 unsnapped · 34 off-nice ·
**100 fully healthy** (snapped + zero off-nice).

⚠️ **THE PROBE TRAP THAT PRODUCED WRONG NUMBERS TWICE.**
`packs/_lib/risk-config.ts` *imports* `RETUNE_PRICE_BUDGET_DEFAULT_PCT` (from
`insights/edge-calc/risk`) but **does not re-export it**. Importing it from
risk-config yields `undefined` → `priceBudgetPct: undefined` → a far narrower
search → wildly inflated refusal/dirty counts (reported 34 refuse / 82 dirty /
67 healthy, all wrong). Import it from `insights/edge-calc/risk`, or pass a
literal. Cross-check any fleet number against a second probe before reporting.

## Rebuilding the harness (it is gitignored scratch and keeps getting deleted)

Two temp files at repo root, deleted after use:
1. `_probe-fleet-dump.mjs` — read-only prod dump (`SET default_transaction_read_only = on`,
   SELECT only) of active official priced packs + their pools with card values.
2. `_probe-fleet-run.ts` — replays the **live-arm** solve per pack:
   `resolveIntendedHitRate` → `autoRetuneTargets` (live-anchored) → `nearMissMin`
   → `buildRetuneSearchParams("live", …)` → `searchBestPriceForCleanSnap`.
   Import the REAL engine + the REAL shared param constructor so it cannot drift
   from the write path (mirror `planPackTuneLiveUncached`, retune-actions.ts ~2584).

Two harness traps that cost a full re-run each:
- **Resolve `readEdgeCurveConfig()` ONCE in the parent.** Reading it per worker
  opens an ADMIN-DB connection in every child; the teardown races the exit and
  silently kills ~36% of them ("child produced no result", empty stderr).
- **Never `process.exit()` right after `stdout.write`** — it truncates the piped
  write on Windows. Use the write callback and let the process end naturally.

## Two law checks that produce FALSE POSITIVES if written naively

- **Tag exactness:** the governing bound is `TAGGED_WRITE_WINRATE_TOLERANCE =
  0.001` (0.1pp, what `applyPackRetune` asserts), NOT `TAGGED_WINRATE_TOLERANCE
  = 0.0001` (0.01pp, what the solver merely aims for). A plan landing between
  the two is accepted AND honestly reported via `taggedAccuracyHit=false`.
  Checking the solver bound flags 5 healthy packs.
- **Anti-inflation:** the **cheapest winner is deliberately exempt** —
  `monoCap[cheapestWinIdx] = Infinity` (`risk.ts:5722`), the LAW M sink. 39 of
  65 inflated cards were that card. Also honour the engine's own
  `topInflationUnavoidable` declaration.

## The two system levers, measured (2026-07-24)

- **Price budget** (`retunePriceBudgetPct` in `pack_system_config`, ADMIN DB —
  owner-settable) is BY FAR the biggest lever on pack health:
  ±10% → 100 healthy · ±25% → 112 · ±60% → **125** (and refusals 11 → 5).
  Cost: it lets the solver propose real price cuts (10% Squirt $67.39 → $37.51,
  10% Pixie $8.60 → $5.18). It only widens what the solver may SEARCH — the
  operator still approves each price — but bulk/auto paths make it a revenue
  decision, so it is an owner call, not a silent flip.
- **`TAGGED_SNAP_NODE_CAP` 120k → 900k: REJECTED, measured no-op.** At the real
  default budget the fleet is byte-identical (134 clean-snap / 34 off-nice both
  ways); it only adds ~18% wall-clock at ±60%. Do not "fix" the node-cap hazard
  by raising the cap — it buys nothing on real packs.
- **Retagging is NOT the fix.** All 41 tagged packs with a lawful `fitRange`
  already carry a tag INSIDE that range — zero need a retag.

## Real finding (unfixed, product call)

26 non-sink win cards end up with better odds than live because the anti-inflation
anchor constrains the *precise* solve but the *snap* rounds up onto a rung.
13 land on pre-existing rungs (so this predates `31368e2a`), 10 on rungs it added
(Nap Time 5.5→6%, Power Guards 12→12.5%, Primal Power 6.8→7%). Edge and tag laws
hold on all of them, so house economics are protected — what drifts is pack
*shape*. Forbidding snap-up would shrink the legal vector set and make packs
unsnappable, so it is an owner tradeoff, not a bug to patch.

Related: [[pack-engine-harness-red]], [[pack-edge-model]], [[pack-studio-current-state]].
