/**
 * Retune V2 workspace — the ONE copy map. Every §5 string (status badges,
 * banner headlines, limit-kind plain-words copy, relaxation explainers,
 * push-row labels, confirm copy, failure-matrix copy) lives HERE and nowhere
 * else, so the panel, the confirm dialog and the bulk summary can never
 * drift apart on wording. Pure module — no React, no side effects.
 */

import type { ShapeWeightsLimit, ShapeWeightsRelaxation } from "@/app/(admin)/insights/edge-calc/risk";
import { formatCurrency } from "@/lib/utils/format";

// ─── Small formatters (shared by the copy functions) ────────────────────────

/** Fraction (0..1) → trimmed percent body, e.g. 0.05 → "5", 0.125 → "12.5". */
function pctBody(fraction: number): string {
  const v = fraction * 100;
  const s = v.toFixed(2);
  return s.replace(/\.?0+$/, "");
}

/** Tag fraction → the DB-notation badge label, e.g. 0.01 → "%1". */
export function tagBadgeLabel(tag: number): string {
  return `%${pctBody(tag)}`;
}

// ─── Status badge (§5a) ─────────────────────────────────────────────────────

export const STATUS_BADGE = {
  plannedClean: "Planned · clean",
  plannedDirty: "Planned · dirty odds",
  relaxed: "Relaxed",
  infeasible: "Infeasible",
  planning: "Planning…",
  stale: "Stale — re-planning",
  previewOnly: "Preview only",
  pushing: "Pushing…",
  pushed: "Pushed",
  drifted: "Live changed",
  refused: "Refused",
  error: "Plan failed",
} as const;

// ─── Banner copy (§5c — exactly one slot, priority top-down) ────────────────

/** Limit-kind → plain-words headline (risk.ts:396-410). */
export function limitHeadline(
  limit: ShapeWeightsLimit,
  ctx: { price: number; tag: number | null },
): string {
  const price = ctx.price;
  switch (limit.kind) {
    case "empty-pool":
      return "This pack has no cards. Add cards in the Builder first.";
    case "no-win-cards":
      return `Nothing in this pool is worth the ticket price — there is no card a player can win. Add at least one card worth ${formatCurrency(price)} or more.`;
    case "no-win-band-card":
      return limit.suggestedRange
        ? `The pool jumps from cheap cards straight to jackpots. Add a mid-size winner (${formatCurrency(limit.suggestedRange.min)}–${formatCurrency(limit.suggestedRange.max)}) so the math has something to balance with.`
        : "The pool jumps from cheap cards straight to jackpots. Add a mid-size winner so the math has something to balance with.";
    case "degenerate-pool":
      return "Every card is worth the same, so there is nothing to shape. Add some cheaper filler or a bigger winner.";
    case "ev-out-of-range":
      return "At this price the pool pays out either too much or too little overall, no matter the odds. Change the price or swap cards.";
    case "no-dust-cards":
      return limit.priceIndependent
        ? "No price works here — every card sits too close to the ticket. The pool needs a genuinely cheap card (under half the price) before it can be retuned; price moves can't fix it."
        : `There are no cheap cards to soak up the losing opens. Add a couple of cards under ${formatCurrency(0.5 * price)}.`;
    case "no-dust-mass":
      return "Winners and near-misses use all the room — no space left for losing opens. Add cheaper cards or drop a winner.";
    case "ev-unreachable-for-split":
      return `The ${ctx.tag !== null ? pctBody(ctx.tag) : "?"}% tag is locked and no jackpot may get more likely, so this pool can only pay one exact amount — and it's not the right one. Add one cheap card, or accept a price move.`;
    case "edge-unreachable":
      return "Can't reach the target edge with these cards at this price. Raise the price or add cheaper cards.";
    case "pins-infeasible":
      // The engine already writes the pins-infeasible detail in plain words
      // WITH the computed numbers (how much the pins over/undershoot the EV
      // budget or the tag, the cap the pinned card breaks, the Drafts pointer
      // for deliberate below-target pools) — render it verbatim.
      return limit.detail;
    case "invalid-price":
    case "invalid-target-edge":
    case "invalid-target-win-rate":
      return "Something's off with the inputs. Reset to live and try again.";
    default:
      // Unknown kind — the server's detail verbatim.
      return limit.detail;
  }
}

/** The suggestedRange CTA label ("one-click fix loop", D2 steal). */
export function addCardCtaLabel(range: { min: number; max: number }): string {
  return `Add a card between ${formatCurrency(range.min)}–${formatCurrency(range.max)}`;
}

// ─── Guidance engine (ruleset §2 — ranked, proven suggestions) ──────────────

export const GUIDANCE_HEADING = "Computed fixes (ranked, engine-proven)";

/** Short chip label per suggestion kind (`TuneSuggestionKind`). */
export function suggestionKindLabel(kind: string): string {
  switch (kind) {
    case "price-move":
      return "Price move";
    case "price-edge-exact":
      return "Price + edge";
    case "add-card":
      return "Add a card";
    case "edge-bump":
      return "Edge target";
    case "raise-cap":
      return "Raise cap";
    case "repair-monotone":
      return "Fix ladder rung";
    case "loosen-cheapest-winner":
      return "Loosen floor winner";
    case "retag":
      return "Retag";
    case "remove-dead-card":
      return "Dead card";
    case "accept-as-is":
      return "Accept as-is";
    case "no-fix-under-constraints":
      return "No fix available";
    default:
      return kind;
  }
}

/** Badge shown when the top suggestion round-tripped the real solver. */
export const SOLVER_VERIFIED_BADGE = "solver-verified";

// ─── Untagged degenerate loss ladder (the owner's "Captive" case) ────────────

/**
 * Banner headline for a FEASIBLE untagged plan whose loss ladder collapsed
 * onto one carrier card (cards pinned at the 0.0001% odds floor, win-rate
 * floated up). The plan is valid — the accept-as-is suggestion carries the
 * full numeric WHY; this line just names the situation.
 */
export const DEGENERATE_LADDER_BANNER =
  "Some loss cards are pinned at the minimum odds — at this price the edge math parks the whole loss mass on one card and floats the win rate up. The plan is still sound; the fixes below spread the ladder (or accept as-is).";

/** The per-row pinned-at-floor chip (pool table, planned-% cell). */
export const FLOOR_PIN_CHIP = "min";
export const FLOOR_PIN_TOOLTIP =
  "Pinned at minimum odds — the edge target needs the loss mass on richer cards; see fixes.";

/** One-shot emerald flip after the fix loop lands feasible. */
export const FIX_LOOP_SUCCESS = "That did it — this pack is tunable now.";

// ─── Owner pins (Retune V2 — click-to-edit Planned %) ────────────────────────

/** The amber per-row chip on a pinned card. */
export const PIN_CHIP = "pinned";
/** Tooltip on the pin chip — the typed value BINDS the plan. */
export const PIN_TOOLTIP =
  "Pinned — the typed chance binds the plan: the server holds this card at exactly this value (through the clean-odds snap too) or refuses honestly.";
/** aria/tooltip for the hover pencil on the Planned % cell. */
export const PIN_EDIT_HINT = "Click to pin this card's chance";
/** Placeholder inside the pin editor input. */
export const PIN_INPUT_PLACEHOLDER = "e.g. 0.0005";
/** Clear-all control near the plan header (shown only when pins exist). */
export function clearAllPinsLabel(count: number): string {
  return `Clear ${count} pin${count === 1 ? "" : "s"}`;
}

export function tagSaturatedBanner(tag: number): string {
  return `No price in the search band hits the ${pctBody(tag)}% tag exactly — closest achievable shown. Pushing is blocked.`;
}

export function dirtyOddsBanner(offLadderCount: number, cardCount: number): string {
  return `Odds are exact but not round numbers — ${offLadderCount} of ${cardCount} cards are off the clean ladder (amber dots below). Nudge the price or swap a card; clean odds are required to push.`;
}

/** Feasible + exact on the per-100k grid, but the pool is too pinned to land
 *  round numbers at any price in the band (§niceness). Plan stays pushable. */
export function nicePinnedBanner(offCount: number, cardCount: number): string {
  return `Exact but not pretty — ${offCount} of ${cardCount} odds can't land on round numbers at any price in the band: the tag and the never-inflate caps pin this pool too tightly. Fine to push — tag and edge are exact. To prettify: add a mid-value card to free up room, pin the odds you want by hand, or accept these numbers.`;
}

/**
 * Per-lever relaxation explainer lines (§5c "Relaxed").
 *
 * Tag-aware (owner-lens §5 / Pattern 9e): a TAGGED pack can carry a `winRate`
 * relaxation — the engine reuses that lever for the unavoidable-jackpot-
 * inflation NOTE (`requested === applied`) and for the achievable-win-rate
 * float. The old copy unconditionally printed "Allowed — this pack has no tag",
 * which rendered on the %10-tagged Chaos (both halves false). The `ctx.tag`
 * split fixes the emission:
 *   • no actual float (requested ≈ applied) → the engine's own sentence is the
 *     truth (it explains the note); never the "floated / no tag" line;
 *   • a real float on a TAGGED pack → name the tag it drifted off, point at the
 *     tag banner (Pattern 9a direction-aware, no false "no tag" claim);
 *   • a real float on an UNTAGGED pack → the original "has no tag" copy, but
 *     direction-aware: "floated up to" when the plan RAISED the win rate,
 *     "eased down to" when it lowered it (Pattern 9a: never "relaxed" upward).
 */
export function relaxationLine(
  r: ShapeWeightsRelaxation,
  ctx: { tag: number | null },
): string {
  switch (r.lever) {
    case "nearMiss":
      return `Wanted ${pctBody(r.requested)}% near-miss ('almost!') opens; this pool only supports ${pctBody(r.applied)}%. Fine to push — just fewer teases.`;
    case "winRate": {
      // No actual float (requested ≈ applied): the engine reused the lever as a
      // NOTE (e.g. unavoidable jackpot inflation) — its own sentence is the
      // truth, and it can render on tagged AND untagged packs.
      if (Math.abs(r.applied - r.requested) <= 1e-9) return r.reason;
      // Pattern 9a — direction-aware verb (never "relaxed"/"floated up" on a
      // downward move).
      const verb = r.applied > r.requested ? "floated up to" : "eased down to";
      if (ctx.tag !== null) {
        return `Win chance ${verb} ${pctBody(r.applied)}% (from ${pctBody(r.requested)}%) so the numbers close — off the ${pctBody(ctx.tag)}% tag. See the tag banner for the fix.`;
      }
      return `Win chance ${verb} ${pctBody(r.applied)}% (from ${pctBody(r.requested)}%) so the numbers close. Allowed — this pack has no tag.`;
    }
    case "floor":
      return "The most common card lands cheaper than usual.";
    default:
      return r.reason;
  }
}

export const RELAXED_FOOTER = "Still safe: edge and win-rate targets are met.";

export const JACKPOT_NOTE =
  "One jackpot's odds had to rise a touch — its current odds are rarer than the math can keep. Check its row before pushing.";

export const CLEAN_BANNER =
  "Ready. Clean odds — every chance is a round number. Pushing writes exactly these numbers.";

export const STALE_BANNER = "Numbers changed — re-planning…";

export const PLAN_FAILED_BANNER =
  "Planning took too long or failed. Nothing was written.";

/** Independent amber strip ABOVE the banner slot whenever the live pool is off-tag. */
export function offTagStrip(liveWinRate: number, tag: number): string {
  return `Live pool pays ${(liveWinRate * 100).toFixed(2)}% winners but the tag says ${pctBody(tag)}%. Pushing this plan fixes it.`;
}

// ─── Failure-matrix copy (§7) ───────────────────────────────────────────────

export const F1_NO_SNAPSHOT_TITLE = "No risk snapshot yet";
export const F1_NO_SNAPSHOT_BODY =
  "No risk snapshot yet — the workspace seeds from Pack Doctor's snapshot.";
export const F2_RAIL_FAILED_TITLE = "Couldn't load packs";
export const F3_PACK_GONE = "This pack no longer exists.";
export const F4_OUT_OF_SCOPE =
  "Inactive or unpriced — retune targets don't apply.";
export const F7_DRIFTED = "This pack changed on live since you loaded it.";
export const F8_REBASED =
  "Live pool changed — your edits were re-based, review before pushing";
export const F10_PLAN_CHANGED = "Plan changed underneath — nothing was written";
export const F17_REHYDRATED_DRIFT =
  "This pack changed since you staged these edits.";
export const F17_KEEP = "Keep my edits (re-anchor)";
export const F17_DISCARD = "Discard";

// ─── KPI copy (§5b) ─────────────────────────────────────────────────────────

export function edgeTargetSub(targetEdge: number): string {
  return `target ${(targetEdge * 100).toFixed(2)}% (this pack's own curve)`;
}

export const WIN_RATE_ON_TAG = "on tag";
export const WIN_RATE_OVER_TAG = "users win more than designed";

export function priceMoveSub(delta: number): string {
  return `Price moves ${delta >= 0 ? "+" : "−"}$${Math.abs(delta).toFixed(2)} so the odds land clean.`;
}

export const PRICE_PINNED_SUB = "price pinned — odds only";

// ─── Pool-table footer copy (§5d) ───────────────────────────────────────────

export const PRICE_INPUT_HINT =
  "the planner may move it within the allowed band to land clean odds";

// ─── Cap removals (owner rule, 2026-07-03) ──────────────────────────────────

/** Badge on a pool/confirm row the cap pre-filter drops (a true removal). */
export function capRemovedBadgeLabel(capUsd: number): string {
  return `removed — over max-win cap $${capUsd.toFixed(2)}`;
}

/** Tooltip on the cap-removed badge: why + both ways out. */
export function capRemovedTooltip(valueUsd: number, capUsd: number): string {
  return `This card's value $${valueUsd.toFixed(2)} exceeds the pack's max-win cap $${capUsd.toFixed(2)}, so the plan drops it — pushing removes it from the pack (no dead 0%-odds row is written). Revert from History to bring it back, or raise the pack's max-win cap so it can stay.`;
}

// ─── Push row + confirm (§5e / §6) ──────────────────────────────────────────

export function pushSubLine(args: {
  priceAfter: number;
  oddsChanges: number;
  added: number;
  removed: number;
}): string {
  return `Will write: $${args.priceAfter.toFixed(2)} ticket · ${args.oddsChanges} odds changes · ${args.added} added · ${args.removed} removed. Nothing changes until you confirm twice.`;
}

export const PUSH_LABEL = "Push to production";
export const PUSH_DISABLED_REPLANNING = "Re-planning…";
export const PUSH_DISABLED_FIX_POOL = "Fix the pool first";
export const PUSH_DISABLED_OFF_TAG = "Off tag — can't push";
export const PUSH_DISABLED_DIRTY = "Dirty odds — can't push";
export const PUSH_DISABLED_PUSHING = "Pushing…";

export function confirmStep1Title(name: string): string {
  return `Push ${name} — the exact write`;
}
export const CONFIRM_STEP1_CONTINUE = "Looks right — continue";
export const CONFIRM_STEP2_TITLE =
  "100% sure? This rewrites the live pack on production.";
export const CONFIRM_STEP2_ACTION = "Yes — push live";

/** F9 — the skew-refusal panel's copy-to-clipboard affordance. */
export const COPY_DETAILS = "Copy details";

// ─── Bulk (§6) ──────────────────────────────────────────────────────────────

export const BULK_STAGED_NOTE =
  "bulk tunes the live pool; your staged edits stay";

export function bulkPlanTitle(n: number): string {
  return `Planning ${n} packs`;
}
export const BULK_PLAN_RUNNING =
  "Read-only dry-runs — nothing is written while planning.";
export function bulkPushLabel(m: number): string {
  return `Push ${m} pack${m === 1 ? "" : "s"}`;
}
export function bulkConfirmTitle(m: number): string {
  return `100% sure? This rewrites ${m} live pack${m === 1 ? "" : "s"} on production.`;
}
export function bulkPushTitle(m: number): string {
  return `Pushing ${m} pack${m === 1 ? "" : "s"}`;
}
export const BULK_PUSH_RUNNING =
  "Writing each pack's own approved plan to production — stoppable after the current pack.";
