---
name: pack-edge-model
description: "Pack economics engine — edge/EV formulas, per-pack edge curve 10.99→11.50%, shapeWeights solver, exact constants (verified 2026-07-02)"
metadata:
  node_type: memory
  type: project
  originSessionId: 93a61a9c-5964-4a78-a705-eebd165d1e98
---

Scope: cash packs = `pack_type` **`["official"]` only** (`REPRICE_INCLUDED_PACK_TYPES`, `src/lib/queries/packs.ts:475`). Prod reality: only official/reward/shard exist, **zero `custom` rows** — but `buildPack` still creates `"custom"` (bug, see [[pack-studio-current-state]]).

**Core math** (`src/app/(admin)/insights/edge-calc/math.ts`, pure/client-safe): `EV/open = Σ(weight×card.price)/Σweight × cards_per_open`; `RTP = EV/price`; `edge = 1−RTP`; inverse `price = EV/(1−edge)` = EV/0.8901 at default. `TARGET_HOUSE_EDGE = 0.1099`. **Bands are RELATIVE to the chosen target** (my old "10.95–11.05" note was off): ACCEPT ±0.0005 → **[10.94%, 11.04%]** at default; HARD backstop ±0.002 → [10.79%, 11.19%]; target clamp [1%, 50%]. `planPackReprice` lives in **math.ts** (not queries/packs.ts), price-only, `roundingMode:"up"` in BOTH dry-run and write → written edge never below target, skips rather than overcharge.

**Per-pack edge curve** (`packs/_lib/auto-targets.ts`): `autoTargetEdge = clamp(0.1099 + 0.0008·logNorm(maxWin,500,24000) + 0.0003·logNorm(price,2,766), 0.1099, 0.115)` — floor 10.99% (calm packs sit exactly there), Divine Order ($767/$24k) ≈ 11.10%, hard ceiling 11.50%. "Below target" is judged per-pack against this curve, not a flat floor. Win-rate: `parsePackHitRate` parses a leading "X%" from the pack **NAME only** (tags column NOT consulted) → tagged hit-rate, else `DEFAULT_TARGET_WIN_RATE = 0.20`. `autoMaxWinCap = max(min(25000, price·100·scale), price)` with `scale = max(1, 0.20/hitRate)` → 1%-pack gets 20× cap loosening. `EDIT_EDGE_FLOOR = 0.05` absolute server backstop; config overrides in ADMIN `admin_settings.pack_system_config`.

**Risk engine** (`insights/edge-calc/risk.ts`, 2747 lines, pure): bands GRAIL ≥5·price / WIN [price,5p) / NEARMISS [0.5p,p) / DUST. `riskScore = 100·(0.7·clamp01(cv/12) + 0.2·clamp01(log10(maxMult)/3) + 0.1·(1−floorRatio))`; CV tiers T1<1.4, T2<3, T3<6, T4<12, T5≥12. `shapeWeights`: power-law per band (loss-β bisected [−20,50]×80; **win-β floored 1.5** so jackpot always rarest), one-sided-up edge enforcement (bump cheapest dust until edge ∈ [target, target+0.001]), win-rate SOFT ±2pp floats UP for untagged (never inflates jackpots); `winRateIsHard` pins tagged packs (0.01pp tolerance in price search). Anti-inflation anchor (19ca8e9b): no win/grail card's odds may exceed CURRENT odds. Lottery skew (≤5% win-rate, legacy path): grail band ∝ value^−2. Clean-ladder snap to human rungs [1,1.5,2,2.5,3,4,5,7.5,10,…]×10^k. `searchBestPriceForCleanSnap`: ±25% cent sweep default (retune dry-run uses ±60% — mismatch), 320 candidates tagged / 800 with upward extension.

**Designed vs realized:** designed edge always recomputed live from pool (`getPacksPoolComposition` aggregates → `computePackRiskFromAggregates`); `packs.actual_rtp/actual_house_edge` = backend-maintained lifetime realized (actual_rtp stored as PERCENT, normalized via `>2 ? /100` heuristic), display-only. Fleet edge KPI = (Σrev−Σpay)/Σrev, never the equal-weighted column average. Harnesses: `packs/__checks__/reprice.ts` (13 checks) + `risk.ts` (~40 checks), `npx tsx`, zero DB.

Odds storage: `pack_cards.weight Int` relative; forms convert odds% → `max(1, round(odds/100 × 1e6))` ppm integers. No pack_openings table — an open = `game_sessions` + `provably_fair_results` rows (`result_metadata->>'pack_id'`, index-served on prod) + `ledger_transactions` type `pack_opening`.
