/**
 * Retune V2 workspace — the ONE copy map. Every §5 string (status badges,
 * banner headlines, limit-kind plain-words copy, relaxation explainers,
 * push-row labels, confirm copy, failure-matrix copy) lives HERE and nowhere
 * else, so the panel, the confirm dialog and the bulk summary can never
 * drift apart on wording. Pure module — no React, no side effects.
 */

import type { ShapeWeightsLimit, ShapeWeightsRelaxation } from "@/app/(admin)/insights/edge-calc/risk";
import type { CleanRescue } from "@/app/(admin)/insights/edge-calc/tag-guidance";
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
  plannedDegenerate: "Planned · degenerate ladder",
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

// ─── Price-suggestion one-click (wave 4) ─────────────────────────────────────

/** `price-move` CTA: stages the suggested price PINNED + re-plans. */
export function applyPriceCtaLabel(price: number): string {
  return `Set price to ${formatCurrency(price)}`;
}

/** `price-edge-exact` CTA: stages price (pinned) + the edge-target override. */
export function applyPriceEdgeCtaLabel(price: number, edge: number): string {
  return `Set ${formatCurrency(price)} + ${(edge * 100).toFixed(3)}% edge target`;
}

/** Header chip while an owner edge-target override binds the plan. */
export function edgeOverrideChipLabel(edge: number): string {
  return `Edge target ${(edge * 100).toFixed(3)}% (override)`;
}

export const EDGE_OVERRIDE_CHIP_TITLE =
  "The plan solves against this owner-set edge target instead of the price-curve auto target. Clear it to return to the auto target.";

export const EDGE_OVERRIDE_CLEAR_ARIA = "Clear the edge-target override";

// ─── Pins-infeasible engine-detail disclosure ────────────────────────────────
//
// The owner-plain pins frame lives SERVER-SIDE since wave 2b: the verdict's
// detail is `pinShortfallHumanCopy` (shortfall + smallest verified fix), so
// the client-side `pinsRefusalFrame` parser is retired. Only the collapsed
// raw-engine-detail disclosure label remains client copy.

/** Collapsed-disclosure label over the raw engine detail (never hidden). */
export const PINS_ENGINE_DETAIL_SUMMARY = "Engine detail";

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
    case "untag":
      return "Untag";
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

/** CTA on an UNTAG guidance suggestion — clears the pack's lottery tag. */
export const UNTAG_CTA_LABEL = "Untag this pack";

/** CTA on a RETAG guidance suggestion — sets the nearest valid lottery tier. */
export function retagCtaLabel(dbLabel: string): string {
  return `Retag to ${dbLabel}`;
}

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

// ─── Pool-edits-first (owner-lens §3 / Patterns 1, 10) ───────────────────────
//
// When the fixed-pool plan is DEGENERATE, INFEASIBLE, exits its risk band with a
// tier flip, or is a dirty dead-end after the full sweep, the PRIMARY
// recommendation is a solver-verified POOL EDIT (add a mid card / remove dead
// cards / pin the price). The workspace leads with this card and demotes the
// fixed-pool plan to the explicit secondary.

export const POOL_EDIT_PRIMARY_HEADING = "Recommended: edit the pool";
export const AS_IS_SECONDARY_HEADING = "As-is plan (fixed pool)";
export const DEGENERATE_BADGE = "degenerate ladder";
export const CRUSH_CHIP = "crushed";
export const CRUSH_TOOLTIP =
  "Planned odds are 100x or more below this card's live odds — the fixed-pool math parks the mass elsewhere. See the recommended pool edit.";

/**
 * The one-line WHY the pool edit fires — degenerate / infeasible / risk-flip /
 * dirty dead-end. Rendered above the summary so the operator reads the cause.
 */
export function poolEditReasonLine(
  reason: "degenerate-shape" | "infeasible" | "risk-band-exit" | "dirty-dead-end",
): string {
  switch (reason) {
    case "degenerate-shape":
      return "At this price the fixed pool collapses onto one carrier card. A pool edit is the real fix — a price move alone can't spread the ladder.";
    case "infeasible":
      return "No clean plan exists for the pool as-is. This pool edit makes one exist.";
    case "risk-band-exit":
      return "The fixed-pool plan would flip this pack's risk tier out of its band. Edit the pool to hold the leverage.";
    case "dirty-dead-end":
      return "The search swept the whole price band and found no clean value for this pool. Editing the pool — not nudging the price — is the way out.";
    default:
      return "";
  }
}

/**
 * The primary pool-edit summary (§3.4): add-card band + removals + price +
 * predicted landing. `predicted` may be null when the derived plan carried no
 * accompanying solve landing (add-card only supplies a band, not a full solve
 * — the round-trip landing rides `predicted` when the guidance computed it).
 */
export function poolEditSummary(pe: {
  addCard: {
    valueMin: number;
    valueMax: number;
    suggestedValue: number;
    expectedShare: number;
  } | null;
  removeCount: number;
  price: number | null;
  beyondBudget: boolean;
}): string {
  const parts: string[] = [];
  if (pe.addCard) {
    const share = Math.round(pe.addCard.expectedShare * 100);
    parts.push(
      `Add a card between ${formatCurrency(pe.addCard.valueMin)} and ${formatCurrency(pe.addCard.valueMax)} (suggest ${formatCurrency(pe.addCard.suggestedValue)}${share > 0 ? ` — it carries ≈${share}% of opens` : ""})`,
    );
  }
  if (pe.removeCount > 0) {
    parts.push(
      `remove ${pe.removeCount} dead card${pe.removeCount === 1 ? "" : "s"}`,
    );
  }
  if (pe.price !== null) {
    parts.push(
      `price ${formatCurrency(pe.price)}${pe.beyondBudget ? " (outside the ±10% budget — shown, never auto-applied)" : ""}`,
    );
  }
  const lead = parts.length > 0 ? parts.join(", ") : "Adjust the pool";
  return `${lead} → the ladder spreads. Solver-verified.`;
}

/** CTA label on the pool-edit primary card. */
export function stagePoolEditCta(hasAdd: boolean): string {
  return hasAdd ? "Stage this fix — pick the card" : "Stage this fix";
}

/** Collapsed disclosure that reveals the plain guidance list under the primary. */
export const POOL_EDIT_MORE_FIXES = "More fixes";

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

// ─── Pending edits (batch multiple Planned % edits before applying) ──────────
//
// A pending edit is a typed-but-not-yet-committed pin: it sits in a client-side
// buffer, re-plans NOTHING, and renders in a distinct amber PENDING style until
// the operator applies the batch. Apply commits ALL pending edits at once as
// pins into the staged pool → exactly ONE re-plan; Discard drops them with no
// re-plan. This lets the owner edit several chances, then save once.

/** aria/tooltip for the hover pencil while pending edits are supported. */
export const PENDING_EDIT_HINT = "Type a chance, then Apply — batch several first";
/** aria-label prefix on a cell that holds a pending (uncommitted) edit. */
export const PENDING_EDIT_ARIA = "Pending edit";
/** Action-bar count label ("3 pending edits"). */
export function pendingEditsLabel(count: number): string {
  return `${count} pending edit${count === 1 ? "" : "s"}`;
}
/**
 * Action-bar Apply button — commits every pending edit as a pin (one re-plan).
 * Named for the owner's headline ask: the typed odds bind, the solver
 * auto-balances every un-typed row so the pack lands on exactly 100%.
 */
export const PENDING_APPLY = "Apply typed odds — auto-balance the rest";
/** Action-bar Discard button — drops every pending edit, no re-plan. */
export const PENDING_DISCARD = "Discard";
/** One-line explainer under the action bar. */
export const PENDING_EDITS_NOTE =
  "Typed but not saved yet — nothing re-plans until you apply. Apply pins them all at once (one re-plan); Discard reverts.";
/**
 * Shown under the action bar ONLY when the typed odds don't sum to exactly
 * 100% — makes the off-by amount honest (never rounded away) and explains that
 * Apply reconciles it: the typed rows are held as pins, the remaining rows
 * absorb the difference so the pushed plan lands on exactly 100%.
 */
export const PENDING_EDITS_OFF_HUNDRED_NOTE =
  "These typed odds don't total 100% yet. Apply re-plans the pack — your edits are held and the un-edited rows absorb the difference to land on exactly 100%.";

// ─── Pending-edits push gate (LAW P — preview ≡ write, no typed odds ride) ──
//
// Typed-but-not-applied odds are INVISIBLE to the plan (they never touch
// `stagedKey`), so a push while they exist would write a plan that does NOT
// contain them. The gate makes that impossible; every surface says why.

/** Push-row disabled label while the pending buffer is non-empty. */
export function pushDisabledPendingLabel(count: number): string {
  return `${count} typed odd${count === 1 ? " isn't" : "s aren't"} in this plan yet — Apply or Discard ${count === 1 ? "it" : "them"} first`;
}
/** Toast when the confirm is opened (keyboard/programmatic) with pending edits. */
export function pushBlockedPendingToast(count: number): string {
  return `${count} typed odd${count === 1 ? "" : "s"} aren't in this plan — Apply or Discard ${count === 1 ? "it" : "them"} before pushing.`;
}
/** Toast when a push lands while a pending buffer exists — it is KEPT, never silently deleted. */
export const PUSH_KEPT_PENDING_TOAST =
  "Your typed odds were not part of this push — they're still pending.";
/** Step-1 confirm: the explicit statement of WHICH basis the write uses. */
export const CONFIRM_BASIS_NOTE =
  "It writes the frozen plan below exactly — applied pins included. Typed odds that were not applied are never part of a push.";
/** Defensive step-1 banner if pending edits somehow exist at confirm time. */
export function confirmPendingDefensiveBanner(count: number): string {
  return `${count} typed odd${count === 1 ? " is" : "s are"} NOT in this write — pushing would ignore ${count === 1 ? "it" : "them"}. Close, then Apply or Discard ${count === 1 ? "it" : "them"} first.`;
}

// ─── Pending-buffer integrity (fingerprint drift + Apply drops) ─────────────

/** Toast when a rehydrated pending buffer no longer matches the live pool (F17-mirror: drop, honestly). */
export function pendingDroppedDriftToast(count: number): string {
  return `Dropped ${count} typed odd${count === 1 ? "" : "s"} — this pack's pool changed since ${count === 1 ? "it was" : "they were"} typed. Re-type against the fresh numbers.`;
}
/** Toast when Apply drops edits whose cards left the pool (never silent). */
export function applyDroppedEditsToast(count: number): string {
  return `Skipped ${count} typed odd${count === 1 ? "" : "s"} — ${count === 1 ? "its card is" : "their cards are"} no longer in the pool.`;
}

// ─── Pending pre-flight (dry-run verdict inside the pending-edits bar) ──────
//
// While the buffer is non-empty, a debounced READ-ONLY `planPackTune` dry-run
// (committed staged facts + the pending pins merged) answers "would these odds
// solve?" BEFORE Apply. Its result is display-only — it never becomes the
// pushable plan.

/** Spinner line while the dry-run is debouncing / in flight. */
export const PREFLIGHT_CHECKING = "Checking these odds…";
/** Success verdict — the dry-run solved. */
export function preflightSuccessLine(priceAfter: number, edgePct: number): string {
  return `These odds solve at ${formatCurrency(priceAfter)} · edge ${edgePct.toFixed(2)}% — Apply to lock them in.`;
}
/** The dry-run itself failed (timeout / error) — Apply still re-plans for real. */
export const PREFLIGHT_ERROR_LINE =
  "Couldn't check these odds — Apply still runs the real plan.";

export function tagSaturatedBanner(tag: number): string {
  return `No price in the search band hits the ${pctBody(tag)}% tag exactly — closest achievable shown. Pushing is blocked.`;
}

/**
 * Dirty-odds banner (§5c). Pattern 9g / 10: when the search EXHAUSTED the whole
 * price band and fell back (`deadEnd`), "nudge the price" is wrong advice — the
 * engine already proved no clean value exists in the band, so the copy points at
 * the pool edit instead. A non-dead-end dirty plan keeps the price/swap hint.
 */
export function dirtyOddsBanner(
  offLadderCount: number,
  cardCount: number,
  deadEnd = false,
): string {
  const head = `Odds are exact but not round numbers — ${offLadderCount} of ${cardCount} cards are off the clean ladder (amber dots below).`;
  return deadEnd
    ? `${head} No price in the band lands clean odds for this pool — edit the pool (add or remove a card) to make a clean plan exist. Clean odds are required to push.`
    : `${head} Nudge the price or swap a card; clean odds are required to push.`;
}

/**
 * Wave 13 auto-clean adoption toast (owner grant 2026-07-11): the engine
 * proved a clean landing by flexing the granted levers; the workspace staged
 * it and is re-verifying. LOUD about exactly what was flexed — an
 * auto-adopted change the owner can't see is a bug, not a feature.
 */
export function autoCleanAppliedToast(rescue: CleanRescue): string {
  const price = `price ${formatCurrency(rescue.price)} (pinned)`;
  const edge =
    rescue.edgeTargetOverride !== null
      ? ` · edge target flexed to ${(rescue.edgeTargetOverride * 100).toFixed(2)}%`
      : "";
  const band = rescue.tier === "wide-price" || rescue.tier === "edge-flex-wide"
    ? " (beyond the normal price band)"
    : "";
  return `Auto-clean applied: ${price}${band}${edge} — solver-proven clean odds (edge ${(rescue.landedEdge * 100).toFixed(2)}%, win rate ${(rescue.landedWinRate * 100).toFixed(2)}%). Re-verifying now; review, then push.`;
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

/** Progress-bar hint once a solve has run ≥12s. */
export const PLAN_PROGRESS_SLOW_HINT =
  "Still solving — big pools and wide searches take longer.";
/** Added at ≥30s — names the fail-loud contract (error state → Retry). */
export const PLAN_PROGRESS_VERY_SLOW_HINT =
  "Still working. If it fails it will say so loudly with a Retry — nothing hangs silently.";

export const PLAN_FAILED_BANNER =
  "Planning took too long or failed. Nothing was written.";

/** Toast after "Reset to live" drops the staged pool + any pending edits. */
export const RESET_TO_LIVE_TOAST =
  "Pool reset to live — staged edits dropped.";

/**
 * Independent amber strip ABOVE the banner slot whenever the live pool is off-tag.
 *
 * `feasible` gates the tail (Pattern 9a — never promise a fix that can't happen):
 * a FEASIBLE plan really does re-tune the pool to the tag on push, so keep the
 * "Pushing this plan fixes it." tail. An INFEASIBLE plan (or none yet) can't be
 * tuned to the tag at all — do NOT claim pushing fixes it; point at retag/untag
 * (the clickable action below re-plans via `onChangeTag`).
 */
export function offTagStrip(
  liveWinRate: number,
  tag: number,
  feasible: boolean,
): string {
  const head = `Live pool pays ${(liveWinRate * 100).toFixed(2)}% winners but the tag says ${pctBody(tag)}%.`;
  return feasible
    ? `${head} Pushing this plan fixes it.`
    : `${head} This pool can't be tuned to ${pctBody(tag)}% — retag or untag it to its real rate below.`;
}

/**
 * Staged-override variants of the off-tag strip (never the stale "the tag says
 * X — pushing this plan fixes it" once the operator ALREADY staged the fix):
 * the copy names the staged override and what the push writes. The no-override
 * path stays {@link offTagStrip}, byte-identical.
 */
export function offTagStripUntagStaged(
  liveWinRate: number,
  liveTag: number,
): string {
  return `Live pool pays ${(liveWinRate * 100).toFixed(2)}% winners but the live tag says ${pctBody(liveTag)}%. Untag staged — this plan treats the pack as untagged at its real rate; pushing clears the ${pctBody(liveTag)}% tag.`;
}

export function offTagStripRetagStaged(
  liveWinRate: number,
  liveTag: number,
  newTag: number,
): string {
  return `Live pool pays ${(liveWinRate * 100).toFixed(2)}% winners but the live tag says ${pctBody(liveTag)}%. Retag staged — this plan re-tunes the pack to ${pctBody(newTag)}%; pushing writes the ${pctBody(newTag)}% tag.`;
}

// ─── Verdict lead + tag triage (Retune V3 wave 2c — v9 `plan.verdict`) ───────
//
// The server's `plan.verdict` is THE lead the panel renders first (wave 2b:
// worst-first kind + headline + engine-verbatim detail + the ONE action +
// LAW T `fitRange` + pin remedies). The copy here is only what the SERVER
// doesn't carry: chip labels, the triage frame, and the rail triage title.

/** Short chip label per verified pin remedy kind (`PinRemedyKind`). */
export function pinRemedyKindLabel(kind: string): string {
  switch (kind) {
    case "raise-pin":
      return "Raise pin";
    case "lower-pin":
      return "Lower pin";
    case "unpin-card":
      return "Unpin";
    case "price-move":
      return "Price move";
    default:
      return kind;
  }
}

/** Heading over the tag-triage block (tag-law refusals with a LAW T probe). */
export const TAG_TRIAGE_HEADING = "Tag triage — what this pool can host";

/** The window-proven lawful tag interval at the plan price. */
export function tagTriageWindowLine(
  price: number,
  fitRange: { minFit: number; maxFit: number },
): string {
  return `Lawful tag window at ${formatCurrency(price)}: ${pctBody(fitRange.minFit)}%–${pctBody(fitRange.maxFit)}% (window-proven).`;
}

/** The probe ran and NO tag fits — untag or edit the pool. */
export const TAG_TRIAGE_NO_FIT =
  "No tag fits this pool at this price — window-proven. Untag it, or edit the pool and re-plan.";

/** Title on an ENABLED triage tier button (inside the lawful window). */
export function tagTriageRetagTitle(dbLabel: string): string {
  return `Retag to ${dbLabel} — inside the lawful window; re-plans immediately, pushing writes the tag`;
}

/** Title on a DISABLED triage tier button (outside the lawful window). */
export function tagTriageOutsideTitle(dbLabel: string): string {
  return `${dbLabel} is outside the lawful window at this price`;
}

/** Chip suffix on the tier the pack currently solves against. */
export const TAG_TRIAGE_CURRENT = "current";

/** Title on the triage Untag button (always lawful). */
export const TAG_TRIAGE_UNTAG_TITLE =
  "Untag — plan this pack at its real rate; pushing clears the tag";

/** Rail mark title: the visited plan refused on the tag law (triage waits). */
export const RAIL_TAG_TRIAGE_TITLE =
  "No lawful ladder hosts this tag at its price — open for retag triage";

// ─── Rail tag-override chips (staged-aware rail surfaces) ───────────────────

/** Title on the struck-through live-tag chip while an UNTAG is staged. */
export const RAIL_UNTAG_STAGED_TITLE =
  "Untag staged — pushing clears this tag";
/** Title on the amber new-tier chip while a RETAG is staged. */
export function railRetagStagedTitle(liveLabel: string | null): string {
  return liveLabel === null
    ? "Retag staged — pushing writes this tag"
    : `Retag staged — pushing writes this tag (live: ${liveLabel})`;
}
/** aria/title on the rail's amber off-tag triangle (live truth, no override). */
export const RAIL_OFFTAG_LIVE_TITLE = "Live pool is off its tag";
/** aria/title on the triangle once a tag override is staged (annotated, not stale). */
export const RAIL_OFFTAG_OVERRIDE_TITLE =
  "Live pool is off its live tag — a tag change is staged; pushing applies it";

// ─── Instant table (plan-first rows while the pool read is still in flight) ──

/** Shimmer label on the image/name/value cells of a plan-only row. */
export const ART_LOADING_LABEL = "loading card art…";

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
// owner hard law 2026-07-11: no push below 10.5% edge — server enforces
// fail-closed; this constant only drives the client disable copy
export const MIN_PUSH_EDGE = 0.105;
export const PUSH_BLOCKED_EDGE_FLOOR =
  "Blocked — edge 10.5% floor (owner law). This plan lands below it.";
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
