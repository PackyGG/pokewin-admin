---
name: creator-hub-deal-cost-model
description: The correct deal-cost formula for /creator-hub/profitability (Active + Past) — do not re-add a fill leg
metadata: 
  node_type: memory
  type: project
  originSessionId: 00a34da5-2120-4207-8c8f-e270a26209bb
---

`/creator-hub/profitability` deal cost, BOTH tabs (owner-confirmed 2026-07-05, after a painful wrong detour):

**`dealCost = capUsd + leaderboardUsd + tipSponsorUsd`** — NO daily-fill leg.
- `capUsd = weeklyCap(total_withdraw_cap_usd) × frameWeeks`
- `tipSponsorUsd = (max_tip_per_stream + max_sponsorship_per_stream) × fills_allowed × frameWeeks`
- `leaderboardUsd = the leaderboard's SPONSORED-WEIGHTED house cost` = `(total_prize_usd − refund) × sponsored%/100` (default 100%). This is `board.houseCostUsd` — the house's cut, NOT the full prize.

**Do NOT add a daily-fill leg** (`per_fill_amount_usd × days`). The owner's "cost too low, only one daily fill" complaint did NOT mean "sum the daily fill" — the withdraw CAP already bounds the house's fill exposure, so adding fill on top double-counts (it inflated deals ~7x, e.g. hellorykick $2,800 → $16,400). Also do NOT switch the LB leg to the full prize — it's the sponsored cut.

The Active tab (`deal-profitability.ts`, `leaderboardUsd = fr.board?.houseCostUsd`) was ALREADY correct — don't touch it. Past (`past-deals.ts`) must mirror it. Past is anchored to the ended **leaderboard FRAME** (bi-weekly = 14 days), not the backend weekly deal, so live frames stay out of Past and the length is the full frame. Restored to this in commit `1fb753ea`. See [[owner-lens-verification]].
