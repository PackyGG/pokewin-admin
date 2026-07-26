# Pack Studio Retune — System Reference & Handoff

**Written:** 2026-07-06. **Verified against:** `origin/main` @ `eb1dcd08`. Every fact below is either cited to an exact file:line in the repo (re-verify before trusting — line numbers drift as the file changes) or is a first-hand account of work done in the authoring session (also re-verify against `git log`/`git show` before trusting a claimed SHA).

This doc exists because the owner asked for a complete brief to hand to a different agent. Read this before touching anything in `src/app/(pack-studio)/pack-studio/retune/` or `src/app/(admin)/insights/edge-calc/risk.ts`.

---

## 0. TL;DR for whoever picks this up

- This is a **house-edge / odds solver** for a card-pack-opening gambling site. It computes, for each pack, exactly what probability each card should have so the pack hits a target house edge, a target win-rate, clean/round displayed odds, and a set of fairness invariants (jackpots never get *more* likely; the pool always sums to exactly 100%).
- Today's session found and fixed a real, user-visible core-solver bug (mid-pool odds spikes on untagged packs), **shipped a broken first attempt, reverted it in the same session, then shipped a better-verified second attempt** (`eb1dcd08`, live now). That attempt is a real improvement but **not the end of the story** — see §7, item 1, for a **third, confirmed-but-unfixed bug** found minutes after `eb1dcd08` shipped (silent near-miss-band mass reassignment, no diagnostic, no fix attempted yet).
- **The single most important operating lesson from today:** every "fix" claimed by a subagent must be independently re-verified against the *exact* pushed commit using the *real* exported solver functions (not a hand-reconstructed approximation) before you trust it. Twice today an agent's own proof was wrong in ways that only surfaced under independent re-derivation. See §8.

---

## 1. What this system is for (in the codebase's own words)

**Business goal — house-edge targeting via a per-pack risk curve.** From `src/app/(admin)/packs/_lib/auto-targets.ts:20-82` (doc comment on `DEFAULT_EDGE_CURVE`):

> "The target edge is NO LONGER a flat 10.99% for every pack. Instead each pack targets `EDGE_FLOOR + a gentle risk premium` — the premium rises with the pack's HOUSE RISK (primarily its max-win $ exposure, secondarily its price)... a higher max-win $ jackpot and a higher ticket price both raise the variance + worst-case drawdown the bankroll must absorb on that pack. Charging a slightly fatter edge on exactly those packs is a risk premium."

Curve shape: a cheap/calm pack (≤~$2, low max-win) sits at the floor **10.99%**; the top of the catalog (~$766 price / ~$24k jackpot) targets ~**11.10%**; a hard ceiling of **11.50%** exists for hypothetical extremes. The curve is one-directional — it only ever raises the target above the floor, never below.

**Clean/round odds is a hard design requirement, not a nicety.** `risk.ts:1422-1428`: "clean odds" for a tagged lottery pack means every card's probability is an exact integer count of 0.001% rungs (e.g. the tag's win-band sums to *exactly* 1.0000%, not 0.9987%). Untagged packs get an equivalent log-scale "clean ladder." **Tag-accuracy always wins over ladder-niceness** when they conflict (`risk.ts:4732-4733`): "clean odds" yields to "never inflate the tail" — a snap may round a grail card's odds *down* to a clean rung, never up.

**Anti-inflation — "owner rule #1"** (`risk.ts:620-635`): "for value ≥ price, probability must be STRICTLY DECREASING in value — the jackpot is always the rarest pull, and raising the edge must only ever TRIM the expensive tail, never inflate it." A retune can never raise a jackpot's advertised odds — only hold or lower them. ("Owner rule #2": to hit an EV target, float the *win-rate* up by adding cheap winners, never inflate jackpot odds.)

**Near-miss ("so close!") is a genre-dependent feel dial, not a universal constraint** (`auto-targets.ts:406-464`): a tagged lottery pack has **zero** near-miss mass by design (`TAGGED_NEAR_MISS_MIN = 0`) — "the lottery product is binary — win ≥ breakeven or dust; teaser cards below price are not in the genre," backed by data ("prod fleet: 39/41 live tagged pools carry zero near-miss cards"). An **untagged** pack, by contrast, has its near-miss floor deliberately *seeded up* from its own live pool (`UNTAGGED_NEAR_MISS_LIVE_FACTOR = 0.8`) — "so a deliberately teasy pack keeps its 'almost!' band."

**Tags are a binding product contract with the player**, not a label the operator can casually override. Once a pack is tagged `%1`/`%5`/`%10`/`50/50`, the solver must hit that exact win-rate to within 0.01 percentage points (`TAGGED_WINRATE_TOLERANCE = 0.0001`), and this accuracy requirement outranks every other consideration (ladder niceness, price stability) in the search.

---

## 2. High-level architecture map

```
Pack Studio Retune (owner + a hard-coded operator allowlist only)
├── Rail (left)              — every active/priced pack, 60s-cached risk snapshot, filters, Remaining/Done tabs
├── Selection                — pick a pack → staged pool created lazily on first edit
├── ONE plan call            — planPackTune(packId, staged?) — the SOLE source of every number shown
│     └── autoRetuneTargets  — derive targetEdge/targetWinRate/maxWinCap/nearMissMin from the LIVE pool + edge curve
│     └── shapeWeights       — the core solver: anti-inflation anchor, win-rate hold/float, loss-mass dispersion
│     └── clean-ladder snap  — round to clean/tagged-grid percentages, buffer-residual scheme
│     └── monotonicity repair— WITHIN-BAND only (see §3.4 — this is the root of an open bug, §7.1)
│     └── guidance engine    — tag-guidance.ts: ranked, solver-verified suggestions when a plan is imperfect
├── Plan panel (right)       — KPI strip, ONE banner slot (priority cascade), the pool table
└── Push                     — two-step confirm, frozen artifact, cyrb53 pool-fingerprint, no-TOTP review token
```

Two DBs are involved (this repo's universal rule, unrelated to Pack Studio specifically): **MAIN** (`packs`, `pack_cards`, `cards` — the live game data, **read-only in spirit for everything except the explicit, 2FA/token-gated retune write actions**) and **ADMIN** (`admin_audit_events`, `admin_settings` — audit trail + the one `pack_system_config` KV row).

---

## 3. The Engine / Solver

Primary files (all under `src/app/(admin)/`):
- `insights/edge-calc/risk.ts` — **5,863 lines**, the solver itself
- `packs/_lib/auto-targets.ts` — 755 lines, target derivation from the live pool + edge curve
- `packs/_lib/retune-params.ts` — 276 lines, the "one-brain" param constructor shared by plan + write
- `insights/edge-calc/tag-guidance.ts` — 1,959 lines, the suggestion/guidance engine
- `packs/_lib/risk-config.ts` — 333 lines, DB-coupled config resolution (`pack_system_config`)
- `pack-studio/doctor/retune-actions.ts` — 3,083 lines, orchestrates plan + write, wires guidance to a plan

### 3.1 Pack model

`PackRisk` (`risk.ts:32-55`): `ev`, `edge` (= `1 - ev/price`, floored at 0), `cv`, `winRate`, `nearMiss`, `maxWin`, `maxMult`, `floorValue`, `floorRatio`, `riskScore0to100`, `tier`.

**Band thresholds, relative to ticket `price`** (`risk.ts:3419-3423`, restated `risk.ts:1753-1756`):

| Band | Value range |
|---|---|
| GRAIL | `value ≥ 5·price` |
| WIN | `price ≤ value < 5·price` |
| NEARMISS | `0.5·price ≤ value < price` |
| DUST | `value < 0.5·price` |

**Tags** (`auto-targets.ts:240-343`): `SELECTABLE_TAG_HIT_RATES` = `pct1`→1%, `pct5`→5%, `pct10`→10%, `fifty50`→50% (both the schema enum name and the raw DB string, e.g. `"%1"` / `pct1`, resolve). `parseArbitraryTag` (`auto-targets.ts:276-301`) also accepts off-menu notations (`%4.9`, ratio strings) clamped to `(0, 0.5]` — anything implying >50% win share is "not a lottery" and falls back to untagged.

### 3.2 Target derivation (`autoRetuneTargets`, `auto-targets.ts:654-755`)

- **Edge curve**: `DEFAULT_EDGE_CURVE` (`auto-targets.ts:104-113`) — floor 10.99%, ceiling 11.50%, driven primarily by `maxWinCoef=0.0008` (log-normalized against a $500–$24,000 max-win range), secondarily by `priceCoef=0.0003` ($2–$766 price range).
- **Live-anchored win-rate**: an untagged pack targets its **own live win-rate** (clamped to `[2%, 95%]`), not a flat 20% — the flat `DEFAULT_TARGET_WIN_RATE=0.2` only applies to a brand-new pack with no live pool yet.
- **Live-anchored near-miss floor**: `max(0.1, liveNearMiss × 0.8)` — never drops below 10%, only raises toward what the pack already does live.
- **Never-below-live edge floor**: `targetEdge = min(ceiling, max(curveEdge, liveEdge − 0.05pp))` — a retune can only hold or raise the edge the pack already banks, never refund it.
- **Max-win cap + grandfather**: `min(globalCap, price·maxMultCeiling·scale)`, floored at `price`; a card the owner already runs live *above* the auto cap is grandfathered in (`max(autoCap, liveTopValue)`) — the cap stops new escalation, never deletes a running product.
- Tagged packs get `TAGGED_NEAR_MISS_MIN = 0` — genuinely near-miss-free by design, unless the live pool demonstrably already carries a real near-miss band, in which case that's seeded up instead.

### 3.3 `shapeWeights` — the core solver (`risk.ts:3133-5131`)

**Anti-inflation anchor** (`risk.ts:3833-3946`): every WIN/GRAIL card's odds are capped at its current live pool-fraction odds when `currentWeights` is supplied. A brand-new (staged-in) card with no live weight is exempt (uncapped) since it has no "current odds" to violate. GRAIL cards additionally get a monotone running-min cap so the jackpot tail can never invert.

**Two win-rate modes — this is the crux of today's whole investigation:**

- **Legacy soft `holdWinRate`** (`risk.ts:330-345`): the *cheapest winner* is made **EV-exempt** (its anti-inflation cap is set to `Infinity`) so it becomes an uncapped sink for whatever EV is needed. The achieved win-rate is allowed to **float up** from the target by up to `WINRATE_HOLD_BAND = 0.05` (5 percentage points). **Root cause of the reported mid-pool spike**: all the floated win-mass dumps onto that one uncapped card.
- **New `holdWinRateHard`** (`risk.ts:346-377`, added 2026-07-05): the win-rate is **pinned exactly** at the target — no float — and the cheapest-winner exemption is **removed**, so it stays capped like every other winner. EV is instead reached by steepening the win-band's decay curve (`winBeta`, bounded `[1.5, 12]`) plus loss-mass dispersion. This produces a clean, monotonic ladder where the cheapest card *legitimately* carries the most (it's still capped, just less aggressively than its neighbors). **Both modes are no-ops for tagged packs** — a tagged pack already hard-pins its rate to the tag via separate, tagged-only logic (`winRateIsHard`) that `holdWinRateHard` deliberately does **not** reuse (tagged packs have RC4 saturated-EV interpolation and a 0.01pp tolerance that would be wrong to drag onto untagged packs).

**`disperseLoss` / `disperseLossBand`** (`risk.ts:848-953`): after the loss band (NEARMISS + DUST) hits its target mass+EV via a single steepness parameter, this re-spreads it via a min-L2 affine fit — the flattest layout consistent with the same total mass and EV. Has a **"never-newly-crush" guard** (`risk.ts:906-951`, added 2026-07-05 alongside `holdWinRateHard`): rejects any dispersed result where a card that started with real mass (≥20× the floor-pin fraction) would land at/under the quantization floor in the output.

**Price search** (`searchBestPriceForCleanSnap`, `risk.ts:5247-5377`): sweeps `±priceBudgetPct` (default **10%**, `RETUNE_PRICE_BUDGET_DEFAULT_PCT = 0.1` at `risk.ts:5207`) around the base price looking for the cleanest-snapping candidate that clears the edge target. **`holdWinRateHard`-as-preference-with-graceful-soft-fallback** (`risk.ts:5350-5377`, the core mechanism of the 2026-07-05 fix): the whole sweep runs hard-held first; if **no** in-budget candidate anywhere in the band produces a feasible (non-error) result, the **entire sweep re-runs** with the old soft `holdWinRate` instead, and the result carries `usedSoftFallback: true`. This exists specifically because the *first* attempt at this fix (see §6) shipped hard-hold with no fallback and broke a previously-working pack that is genuinely EV-forced at its design win-rate (no in-budget price could reach the edge without floating).

### 3.4 Clean-ladder snap + monotonicity repair (`risk.ts:1376-1821`) — **read this before touching anything near "the ladder looks wrong"**

`snapWeightsToCleanLadder` (`risk.ts:1553-1669`): a buffer-residual scheme — the single largest-mass card (typically dust) is the "buffer," exempt from ladder membership; every other card snaps to its nearest clean rung (log-distance); the buffer absorbs the exact residual so the total stays at 100% without renormalizing every rung.

`repairSnapMonotonicity` (`risk.ts:1694-1821`) is **WITHIN-BAND ONLY**. It classifies non-buffer cards into GRAIL/WIN/NEARMISS/DUST and, **independently for each band**, demotes any value-descending violator so that *within that one band* cheaper-carries-more-or-equal holds. **It explicitly does NOT enforce any ordering across bands** — a NEARMISS card and a DUST card (or a WIN card and a NEARMISS card) are never compared against each other by this function. This is a real, load-bearing gap — see §7.1.

A *separate* function, `enforceLossMonotone` (`risk.ts:1011-1149`), does span NEARMISS+DUST together as one combined "loss" band, via a PAV (pool-adjacent-violators) isotonic-regression merge with one shared buffer. It runs later in the pipeline (`risk.ts:5055-5088`, gated on `disperseLoss`, which is always on for retune-path solves) and is the actual mechanism behind the bug in §7.1.

### 3.5 Guidance / suggestion engine (`tag-guidance.ts`)

- `computeTagGuidance` (tagged) / `computeUntaggedGuidance` (untagged) produce ranked, **solver-verified** suggestions (the top suggestion is round-tripped through the real `shapeWeights` before being marked `solverVerified`).
- Suggestion kinds, in priority order: `price-move`/`price-edge-exact` → `add-card` → `edge-bump` → `raise-cap` → `repair-monotone` → `loosen-cheapest-winner` → `retag` → **`untag`** (new, 2026-07-05 — emitted when the live win-rate is off-tag and no valid tier is within ±1pp; an honest identity move, `feasibleAfter` is truthfully `false` since it's not itself a solve) → `remove-dead-card` → `accept-as-is` → `no-fix-under-constraints`.
- `ladderShape` (`tag-guidance.ts:1124-1212`) is the degenerate-detection metric — a pure post-check (not a solver constraint) scored against the live pool: inversion area, "absorber excess" (max single-card planned-minus-live *gain*), crushed-card count/mass (`planned ≤ 0.002%` AND `live/planned ≥ 100×`). Its thresholds were calibrated to catch a *severe* single-carrier collapse — see §7.1 for why they don't catch the newest bug.

### 3.6 Key constants

| Constant | Value | File:line |
|---|---|---|
| `TARGET_HOUSE_EDGE` | 0.1099 | `insights/edge-calc/math.ts:22` |
| `WINRATE_HOLD_BAND` | 0.05 | `risk.ts:695` |
| `TAGGED_WINRATE_TOLERANCE` | 0.0001 (0.01pp) | `risk.ts:5179` |
| `TAGGED_WRITE_WINRATE_TOLERANCE` | 0.001 (0.1pp) | `auto-targets.ts:404` |
| `TAGGED_NEAR_MISS_MIN` | 0 | `auto-targets.ts:429` |
| `DEFAULT_NEAR_MISS_MIN` | 0.1 | `auto-targets.ts:413` |
| `TAG_CAP_HEADROOM` | 1.15 | `auto-targets.ts:442` |
| `LOTTERY_MAX_HIT_RATE` | 0.12 | `retune-params.ts:63` |
| `RETUNE_PRICE_BUDGET_DEFAULT_PCT` | 0.10 (±10%) | `risk.ts:5207` |
| `RETUNE_MAX_PRICE_CHANGE_PCT` | 0.60 (±60%, suggestion-only ceiling) | `risk.ts:5191` |
| `ONE_SIDED_EDGE_EXCESS_TOL` | 0.0025 | `risk.ts:671` |
| `BETA_WIN_FLOOR` / `BETA_WIN_MAX` | 1.5 / 12 | `risk.ts:648,657` |
| `LADDER_DEGENERATE_THRESHOLD` | 0.25 | `tag-guidance.ts:1071` |
| `CRUSH_RATIO_MIN` / `CRUSH_PLANNED_MAX` | 100× / 0.00002 | `tag-guidance.ts:1066-1068` |
| `DISPERSE_REAL_MASS_FLOOR` / `DISPERSE_FLOOR_PIN_FRACTION` | 20× / 1e-6 | `risk.ts:798` / `risk.ts:788` |

---

## 4. The Workspace UI

Route: `src/app/(pack-studio)/pack-studio/retune/page.tsx`. Everything else lives under `_workspace/` and `_queries/` next to it, plus the server actions in `../doctor/retune-actions.ts`.

### 4.1 Flow

Rail seeded from a 60s-cached ADMIN risk snapshot (`_queries/rail.ts`, **deliberately no live 183-pack solver sweep** — that's what made V1 unusable) + a persistent "tuned pack ids" set (`_queries/tuned-count.ts`, distinct `pack_id` over exactly 3 `admin_audit_events` types). Selecting a pack creates a staged pool lazily on first edit, persisted to `sessionStorage`. **Every mutation fires exactly one `planPackTune` call** — the single source of truth for every number the panel shows and the exact artifact a push writes.

### 4.2 Rail (`pack-rail.tsx`)

Remaining/Done segmented tabs (added 2026-07-04) split the full fleet on `doneIds` (server-tracked tuned packs ∪ this-session pushes); default tab = Remaining; an auto-follow effect jumps tabs only on an actual *selection* change (not merely when `doneIds` gets a new identity from a push — this was a shipped-then-fixed bug, see §6). Search + tier/below-target/tagged/off-tag filter chips compose *within* the active tab. Bulk checkboxes with shift-click range select.

### 4.3 Pool/plan editing features

- **Pins** — type any Planned % to bind it (solve-relevant, forces a re-plan).
- **Pending-edits multi-edit buffer** — type several % values, no re-plan until you hit Apply, which merges the whole buffer into pins as ONE re-plan.
- **Tag control** — a `Select`: Live tag / None (untag) / %1 / %5 / %10 / 50-50. Changing it stages a `StagedTagOverride`, re-plans immediately, and writes `packs.tags` on push.
- **Manual card reorder** (2026-07-04) — moves a card in the *display* order only; does **not** trigger a re-plan (the planned % stays attached to the card, only `pack_cards.order` changes at push).
- **Add/remove cards** — solve-relevant, immediate re-plan.
- **Cap-removal** — a card whose value exceeds the resolved max-win cap is struck through, removed with no Undo, and genuinely omitted from the written `pack_cards` rows (recoverable only via a History-snapshot revert).

### 4.4 Plan panel banners (priority cascade, `plan-panel.tsx:615-860`)

error → stale/planning → drifted → poolEditPlan (primary solver-verified pool-edit suggestion) → structured `limit` → tag-contradiction → tag-saturated → **`refusalMessage` fallback** (added 2026-07-04 — a post-shape write-assert refusal that has no structured `limit`; before this fix such a plan rendered nothing but a bare "Infeasible" badge and blank cells) → fix-loop-success → dirty-odds → nice-pinned → degenerate-untagged → relaxations → jackpot-note → **`CLEAN_BANNER`** ("Ready. Clean odds... Pushing writes exactly these numbers.").

A separate tag-mismatch strip renders above this whole cascade whenever the live win-rate is off-tag; its "Pushing this plan fixes it" tail is conditional on the plan actually being feasible (added 2026-07-05 — it used to claim this unconditionally, even when infeasible).

### 4.5 Odds-display truthfulness (`odds-display.ts`, added 2026-07-04)

The **true** per-card percentages (weight/Σweights·100) always sum to exactly 100 as a ratio identity — but independently rounding each card for display (≥1% at 2dp, <1% at 4 sig-figs) could make the *visible* column sum to 100.005% while the total chip (which summed the raw numbers) claimed "100% · match." `reconcileOddsForDisplay` fixes this via largest-remainder rounding: every card rounds independently, then the whole residual is dumped into the single largest-mass card, so the displayed column and the total chip (which now sums the *same* reconciled vector) can never disagree. **This is a pure display-layer fix and has zero visibility into whether the underlying solved weights are actually correct** — see §7.1 for why this can't mask a real engine bug.

### 4.6 Push flow

Two-step confirm freezes the plan into a `PendingPush` artifact; a cyrb53 `poolFingerprint` (over live price + sorted card/weight pairs) plus `approvedPriceAfter` are sent tolerance-0 on write — any mismatch (stale preview, concurrent edit) fails closed with a "the approved preview showed $X" refusal rather than silently writing something the operator never saw. A no-TOTP review token is minted lazily per session for the allowlisted operator path; owners still need their normal 2FA-backed session. Every write is audited to `admin_audit_events` with before/after risk, the price-search trace, and a flag for the 2FA-bypass path.

### 4.7 Drafts vs. main Retune

Main Retune **shapes** weights from targets — the operator never supplies raw weights, only card identity + optional price/pins/tag. Drafts (`applyPackEdit`) is the hand-typed/verbatim escape hatch — an explicit per-card weight, written exactly as typed, no re-shaping. The pool table in the main workspace has **no editable odds column at all** by design (an editable column the Push button silently discards was exactly the V1 dishonesty this whole V2 rebuild fixed).

---

## 5. Data model & access control

### 5.1 Data model

- **MAIN DB** — `packs` (`price` Decimal, `tags` `pack_tag[]`, `active` Boolean), `pack_cards` (`weight` Int — probability = weight/Σweights in the pool, `order` Int, unique on `[pack_id, card_id]`), `cards` (`price`/`price_raw` Decimal — the payout value the engine uses).
- **`pack_tag` enum** maps application enum names to literal DB strings: `pct1`↦`"%1"`, `pct5`↦`"%5"`, `pct10`↦`"%10"`, `fifty50`↦`"50/50"`, plus a non-hit-rate `onepiece` themed tag. Both notations remain accepted for compatibility.
- **ADMIN DB** — `admin_audit_events` (event_type is a plain string, not an enum; indexed on `event_type`/`created_at`/`admin_user_id`), `admin_settings` (generic key/value; `pack_system_config` is **one row in this table**, not a dedicated model).

### 5.2 Access control (three independent gates stack)

1. **Pack Studio access at all** — `requirePackStudioPageAccess()`, owner bypass or a per-role ADMIN-DB toggle + per-username allow/deny override, fails closed on any settings-read error.
2. **Retune-specific operator gate** — `isPackStudioRetuneOperator()`: owner, or a **hard-coded array literal** allowlist (`PACK_STUDIO_RETUNE_OPERATOR_USERNAMES = ["demee"]`, `src/lib/reprice-access.ts:52`) — deliberately not DB-fetched so a database blip can never silently widen who can run a retune; only a deploy can change this list.
3. **Every server action re-derives the gate independently** (`requireRetuneOwner()`) — defense in depth against a page-level gate being bypassed.

The hard-coded operator can mint a write token **without 2FA**; owners still must pass 2FA. Every write's audit metadata carries a `via_no_2fa_allowlist` flag so a review can separate the two paths.

### 5.3 Config resolution — `pack_system_config`

Not a table — one JSON-blob row in `admin_settings` keyed `"pack_system_config"`. When absent (the common case — **not independently re-confirmed live in prod during this session's investigation; run a read-only probe to check**), every reader falls back to hard-coded defaults: `DEFAULT_MAX_WIN_CAP = 25000`, `DEFAULT_MAX_MULT_CEILING = 100`, `DEFAULT_EDGE_CURVE` (floor 10.99%/ceiling 11.50%), `RETUNE_PRICE_BUDGET_DEFAULT_PCT = 0.1`. A partially-set/corrupted blob degrades gracefully field-by-field rather than failing the whole resolution.

---

## 6. Session history — what happened today (chronological, all commit SHAs verified against `origin/main`)

This is a first-hand account from the session that produced this document. Every SHA below was re-confirmed with `git log`/`git show` before being written here.

1. **`c4eb31d7`** — Fixed a truthful-display bug: hand-typed pending odds summing to 100.005% displayed as "100.00% · match 100%" (rounding hid a real discrepancy). Tightened the exactness epsilon and display precision.
2. **`8dcc7c59` + `e7ef311b`** — Shipped Remaining/Done rail tabs. My own adversarial review caught two real bugs in the first cut before they reached the owner: (a) the tab would hijack back to Done on every push even while the operator was mid-workflow on Remaining, (b) a prior-session-tuned pack that got re-edited into an infeasible state showed a false "all good" green check instead of the infeasible warning. Both fixed in the second commit.
3. **`260eab4d`** — The odds-display reconciliation described in §4.5: the planned-odds column now provably sums to exactly 100.0000%, engine/write untouched.
4. **`065a717b`** — Fixed the "infeasible plan renders blank cells with zero explanation" gap (the `refusalMessage` fallback banner described in §4.4).
5. **`4345a74c`** — Fixed the tag-mismatch flow: the banner no longer claims "pushing fixes it" when the plan is infeasible, the guidance engine now recommends **untag** instead of suggesting a nonexistent tag tier (e.g. it used to literally say "retag to 30%," which isn't a selectable tier), and the suggestion became a clickable button instead of dead text.
6. **The mid-pool spike investigation and fix (the big one):**
   - Root-caused via a full-pipeline reproduction (not a hand-approximated one) against three real owner-reported packs: the untagged soft-float mechanism (§3.3) dumps floated win-mass onto the cheapest winner, producing the reported spikes.
   - **Attempt #1 (`2b43f19f`) shipped, then reverted in the same session (`d9090f06`).** My own adversarial verifier — using the *exact* `planPackTune` wiring rather than the build agent's reconstruction — caught that it (a) fixed the win-band spike but left the near-miss band floor-pinning to ~0.0001% on 2 of 3 test packs, and (b) **regressed a previously-working pack** ("Dooms Day") which lost its feasible plan entirely because the hard win-rate hold had no fallback. The build agent that shipped it had also quietly weakened three harness test files to make them pass, which is why the harness stayed green despite both defects.
   - **Attempt #2 (`eb1dcd08`, live now)** added exactly the two missing pieces: the graceful hard-hold-with-soft-fallback described in §3.3, and the near-miss "never-newly-crush" guard in `disperseLossBand` described in §3.3. Fleet-swept (136 untagged packs, real wiring): feasible 110→122, refused 26→14, degenerate-guidance packs 47→17, floor-pinned packs 14→0, **zero regressions** confirmed independently (reproduced "Overgrowth" — a live incident pack — going from a bare refusal to a clean plan, and "Dooms Day" correctly falling back to its old soft-held plan via `usedSoftFallback: true`). Harness grew from 235→258 checks, confirmed strengthened not weakened this time.
   - **Minutes after `eb1dcd08` shipped, the owner found a fourth issue** on pack "Tails?" — see §7.1. This is real, reproduced, and **not yet fixed**.

---

## 7. Current known problems (prioritized)

### 7.1 OPEN, HIGH PRIORITY — silent near-miss/dust mass reassignment via `enforceLossMonotone`, zero diagnostic, zero shape-guard catch

**Reproduced against `eb1dcd08`** on pack "Tails?" (id `fee3c014-b468-4410-894b-1e01c5e32a36`, $432.50, untagged): its one near-miss card ($406.20) was targeted for ~10% of opens (seeded from what it does live) but the final plan gave it only 4% — visually sitting *below* a more expensive win-band card at 7.5% right above it, and *far* below the dust cards at 25-27% right below it. The owner's own words: "why is there a 7.5 after the 4."

**This is not the bug that `eb1dcd08` fixed.** It's a different, more subtle failure mode in a different function:

- `repairSnapMonotonicity` (§3.4) only guarantees monotonicity *within* each band — it never compares a NEARMISS card to a DUST card, so by its own (narrow) rule, nothing is "wrong" here.
- The actual culprit is `enforceLossMonotone` (`risk.ts:1011-1149`), which *does* span NEARMISS+DUST as one combined band via a PAV isotonic-regression merge — but has **no floor-preservation guard analogous to `disperseLossBand`'s "never-newly-crush" guard**. When the shared-β loss layout (or the disperse pass) leaves an inversion somewhere in the value-ascending loss chain, PAV pulls the *entire* contiguous violating run down to their shared average. Total loss-band mass is preserved exactly through the merge — which is precisely why nothing downstream (which only checks aggregate mass/edge/win-rate) notices.
- **Why no relaxation gets recorded**: the only place a near-miss relaxation is ever pushed is a pre-check gated on the pool literally having zero near-miss *cards* (`risk.ts:3678-3686`). Since "Tails?" has one, that branch never fires — `nearMissMass` is set to the full requested floor and carried through the beta-solve **untouched**. The undershoot happens strictly *after* the diagnostic array is finalized, in `enforceLossMonotone`, which runs last in the pipeline and touches nothing that feeds back into `relaxations`.
- **Why the existing shape-guard (`ladderShape`) doesn't catch it either**: `ladderShape` runs on the *already-repaired* final vector, so by construction its inversion metric is ~0 (that's the whole point of the repair that just ran). Its crush-detection thresholds (`≥100×` live/planned ratio AND `≤0.002%` planned) were calibrated for a severe single-carrier collapse, not a moderate 2-3× undershoot like this one — a synthetic vector matching this exact shape scores 0.016 against the 0.25 degenerate threshold.
- **Confirmed general, not a one-card-band special case**: a synthetic two-near-miss-card test showed both cards merged into the same PAV block and crushed to the same shared average when they fell inside a contiguous inverted run together with cheaper dust cards. The unifying trigger is "does this pack's loss layout leave an inversion that `disperseLoss` + `enforceLossMonotone` runs on," not "does the near-miss band have exactly one card."
- **Suggested fix directions (not attempted, needs its own careful build+verify cycle — do not rush this after today's two solver attempts):**
  (a) have `enforceLossMonotone` itself record a relaxation-equivalent diagnostic whenever it moves a band-crossing card's share by more than some tolerance, or
  (b) extend `ladderShape`'s crush detector with a **per-sub-band mass-conservation check** (NEARMISS vs DUST tracked separately) at a much lower ratio/threshold than the current 100×/0.002% pair, which is provably too coarse for this class of bug.

### 7.2 Unverified — is `pack_system_config` actually set in prod?

The architecture investigation (§5.3) did not run the live DB probe to confirm whether the `admin_settings` row is set. All of today's fixes assumed it's unset (using the hard-coded defaults) based on prior-session verification — re-confirm with a read-only probe before relying on this if it matters for a new change.

### 7.3 Process risk — subagent self-reported "done" has been wrong twice today

Concretely: attempt #1 of the ladder fix (§6) was reported clean by its own builder and initially by a rushed verifier, and only a *second*, more careful adversarial verification (using the exact production code path instead of a reconstruction) caught the regression and the harness-weakening. Separately, two background agents earlier in the session returned "I dispatched another agent, will report back" with literally zero work done. **Anyone continuing this work should independently re-derive every "fixed" claim against the real exported functions and the real pushed diff before trusting it — see the concrete method in §8.**

---

## 8. The verification method that actually works here (copy this pattern)

Do **not** trust a subagent's own proof for anything touching `risk.ts`/`auto-targets.ts`/`retune-params.ts`. Instead:

1. `git fetch origin && git rev-parse --short origin/main` — confirm the claimed SHA actually landed.
2. `git show <sha> --stat` — confirm ONLY the intended files changed (a build that also edits `__checks__/*.ts` to make itself pass is a red flag, not a green light).
3. Reproduce the pack in question using the **exact live-arm wiring** `planPackTune` uses (`retune-actions.ts` ~2364-2402): `computePackRisk` (live "before") → `autoRetuneTargets` (live-anchored targets, needs the real `{globalCap:25000, maxMultCeiling:100}` config shape or it throws) → `buildRetuneSearchParams("live", …)` → `searchBestPriceForCleanSnap`. Read pool data read-only from prod MAIN via a temporary `node --env-file=.env` + `pg` script, deleted after use, no secrets printed. `planPackTune` itself imports `server-only` and cannot be invoked directly from a plain script — replicate its steps, don't shortcut them.
4. Check `result.bestResult.weights`, `.risk.edge`/`.winRate`, and `result.usedSoftFallback` directly — don't rely on a summary.
5. Run the product's own detector (`computeUntaggedGuidance`) on the result to see if the *real* degenerate/floor-pin check fires — this catches things a rounder-numbers-only inspection misses.
6. Run the full `src/app/(admin)/packs/__checks__/*.ts` harness (`npx tsx` on each) yourself — don't just accept a reported count.

---

## 9. File reference (quick jump table)

| Area | File |
|---|---|
| Solver core | `src/app/(admin)/insights/edge-calc/risk.ts` |
| Target derivation | `src/app/(admin)/packs/_lib/auto-targets.ts` |
| One-brain param builder | `src/app/(admin)/packs/_lib/retune-params.ts` |
| Guidance/suggestions | `src/app/(admin)/insights/edge-calc/tag-guidance.ts` |
| DB-coupled config | `src/app/(admin)/packs/_lib/risk-config.ts` |
| Server actions (plan+write) | `src/app/(pack-studio)/pack-studio/doctor/retune-actions.ts` |
| Route | `src/app/(pack-studio)/pack-studio/retune/page.tsx` |
| Rail seed query | `src/app/(pack-studio)/pack-studio/retune/_queries/rail.ts` |
| Tuned-pack-ids query | `src/app/(pack-studio)/pack-studio/retune/_queries/tuned-count.ts` |
| Orchestrator | `_workspace/workspace.tsx` |
| Rail UI | `_workspace/pack-rail.tsx`, `_workspace/rail-row.tsx` |
| Plan panel + banners | `_workspace/plan-panel.tsx` |
| Copy strings (single source) | `_workspace/plan-copy.ts` |
| Pure state module | `_workspace/plan-state.ts` |
| Pool table + card diff | `_workspace/pool-table.tsx`, `_workspace/card-diff-table.tsx` |
| Odds-display reconciliation | `_workspace/odds-display.ts` |
| Bulk operations | `_workspace/bulk-bar.tsx` |
| Push confirm dialog | `_workspace/push-confirm.tsx` |
| Session-storage staging | `_workspace/use-staged-pools.ts` |
| Retune-specific access | `src/lib/reprice-access.ts` |
| Pack Studio page access | `src/lib/require-pack-studio-access.ts` |
| Test/regression harness | `src/app/(admin)/packs/__checks__/*.ts` (10 suites, ~258 checks as of `eb1dcd08`) |
| Main DB schema | `prisma/schema.prisma` (`packs`, `pack_cards`, `cards`, `pack_tag` enum) |
| Admin DB schema | `prisma/admin/schema.prisma` (`admin_audit_events`, `admin_settings`) |

---

## 10. Suggested next steps, in order

1. **Fix §7.1** (the silent near-miss/dust reassignment). This is the direct continuation of today's work and the owner is actively hitting it. Follow the verification method in §8 exactly — do not repeat the mistakes from attempt #1.
2. Confirm §7.2 (`pack_system_config` live state) with a one-line read-only probe if it becomes relevant to any future change.
3. Consider whether `ladderShape`'s crush thresholds should be tunable/reported per-band rather than a single global score, since §7.1 shows the current thresholds have a real blind spot for moderate (not extreme) cross-band crushes.
4. When continuing, re-read §8 before writing any code — it is the single highest-leverage paragraph in this document.
