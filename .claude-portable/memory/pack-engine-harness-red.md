---
name: pack-engine-harness-red
description: packs/__checks__ is GREEN 13/13 again after the 2026-07-24 re-pin; the live node-cap hazard 31368e2a left behind
metadata: 
  node_type: memory
  type: project
  originSessionId: 1f5e9843-3e48-40dc-9ba0-9627571fea93
  modified: 2026-07-24T00:10:49.837Z
---

**RESOLVED 2026-07-24 (commit `8fe49a85`).** The 6 red `packs/__checks__` suites
are green again — 13/13. Cause was proven by A/B, not assumed: reverting only
the two arrays in `31368e2a` ("densify clean ladder grid", 42→65 nice rungs)
made all 13 pass; restoring them reproduced exactly those 6 failures. The
densification is deliberate and stays; the pins were stale (the suites were
last touched at `84ec9009`, then 13 engine commits landed with nobody re-running
them).

Re-pin rule used, worth repeating for the next grid change: sort every check
into **laws** (tag exactness, edge ≥ target, never-inflate caps, LAW M
monotonicity, positive-int weights, determinism, honest refusal) vs
**incidental pinned values** (a best price, a weights vector, a grid-derived
count). Re-derive only the latter, by running the real engine. That pass went
+64 assertions net, zero tolerances widened.

## LIVE HAZARD — not fixed, owner's call

`TAGGED_SNAP_NODE_CAP = 120_000` (`insights/edge-calc/risk.ts:3207`) was tuned
down from 400k with a comment claiming "ZERO fixture regressions" — true against
the **42-rung** grid, false now. The tier-N/P DFS enumerates the nice grid per
free win card, so 65 rungs grows the tree ~7.4× (112k → 829k nodes) against the
unchanged cap: the walk truncates at ~14% of the tree, and because it orders by
ascending rung, far branches are never reached.

On the Lucky Pond fixture this collapses the jackpot ~350× (350 units → 1). It
**breaches no law** — never-inflate is a ceiling so moving down is legal, and
the absorber keeps the tag cent-exact — which is exactly why law-based checks
cannot see it. Measured against the real fleet: of 44 feasible tagged packs
exactly ONE jackpot shrinks >1.5× (2×), and the two packs on the 1-unit floor
were already there live (1.00×). **So it does not reproduce in production** —
but it worsens with every rung added. Suggested fix if it ever bites: raise the
cap, or order the DFS by shape distance instead of ascending rung.

Related: [[pack-edge-model]], [[pack-studio-current-state]], [[pack-fleet-sweep-2026-07]].
