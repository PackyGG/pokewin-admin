/**
 * Retune V2 workspace — PURE state module (zero React, unit-testable).
 *
 * Principle (design D3): STORE FACTS, DERIVE STATUS. The workspace keeps
 * plain fact maps (staged pools, landed plans, pushed markers); everything
 * the UI calls a "status" is derived by `deriveStatus` from those facts, so
 * no stored enum can ever contradict the data (the V1 audit's stale-approve
 * and toggle-reset bugs were exactly that class of drift).
 *
 * Everything here is serializable-safe and side-effect-free:
 *   • shared types (StagedPool / PlanEntry / …),
 *   • `stagedKey` / `basisKey` — the ONLY identity the plan cache keys on
 *     (solve-relevant inputs only: cosmetics never stale a plan),
 *   • `deriveStatus` — the workspace status machine,
 *   • `isPushEnabled` — the push-enablement predicate (clean odds are a
 *     MUST per the owner directive; tagged packs are tag-exact or blocked),
 *   • staged-pool builders (seed / re-anchor / plan-input / write-input) so
 *     the plan call and the write call are built from the SAME staged facts.
 */

import type {
  EditPool,
  PackTunePlan,
  PackTuneStagedInput,
  StagedPoolInput,
} from "../../doctor/retune-actions";
import { computePoolFingerprint } from "@/app/(admin)/packs/_lib/pool-fingerprint";
import { TAGGED_WRITE_WINRATE_TOLERANCE } from "@/app/(admin)/packs/_lib/auto-targets";

// ─── Staged pool facts ──────────────────────────────────────────────────────

export type StagedCard = {
  cardId: string;
  name: string;
  /** `cards.price` — the item's value (a voucher is the same as a card). */
  value: number;
  imageUrl: string;
  color: string | null;
  animation: boolean;
  /** Live pool weight, or null for a staged-in (added) card. */
  liveWeight: number | null;
  /** True for a card pulled in via the picker (not in the live pool). */
  added: boolean;
};

export type StagedPool = {
  /** The staged pool in SOLVE order (push `order` = row index at push time). */
  cards: StagedCard[];
  /** Live-pool cards the operator removed (rendered strikethrough + Undo). */
  removed: StagedCard[];
  /** Staged ticket price (USD) — starts equal to `livePrice`. */
  price: number;
  /** The live ticket price the pool was seeded from. */
  livePrice: number;
  /** Escape hatch: solve odds-only AT the staged price (no price search). */
  pinPrice: boolean;
  /** `computePoolFingerprint` of the LIVE pool this staged pool was seeded from. */
  baseFingerprint: string;
};

// ─── Plan entry facts ───────────────────────────────────────────────────────

export type PlanEntryStatus = "loading" | "ready" | "error";

export type PlanEntry = {
  /** The basis the plan was requested FOR (packId | arm | stagedKey). */
  basisKey: string;
  /** Monotonic request sequence — stale responses are dropped, never surfaced. */
  seq: number;
  status: PlanEntryStatus;
  /** The landed plan; null = out of scope (F4) or not landed yet. */
  plan: PackTunePlan | null;
  error?: string;
};

export type PushedInfo = {
  at: number;
  priceAfter: number;
  edgeAfter: number;
  winRateAfter: number;
};

/** Rail verdict marks once a pack was visited / written this session. */
export type PackVerdict = "ok" | "infeasible" | "error" | "refused";

// ─── Keys (the D2 precision steal) ──────────────────────────────────────────

/**
 * ONLY solve-relevant inputs: card identity set, price (2dp), pin flag.
 * Cosmetic edits (color/animation) and display order change `dirty` but NOT
 * the staged key — they never stale a plan and never trigger a re-plan (they
 * ride the push payload only).
 */
export function stagedKey(pool: StagedPool): string {
  return JSON.stringify({
    ids: pool.cards.map((c) => c.cardId).sort(),
    price: pool.price.toFixed(2),
    pin: pool.pinPrice,
  });
}

/**
 * The identity a landed plan is valid FOR. Arm dispatch is derived, never an
 * operator decision: ANY staged entry (identity, price, cosmetic, or pin)
 * → staged arm; else live arm. The first cosmetic-only edit flips the arm
 * live→staged (one re-plan — identical inputs produce identical numbers by
 * the shared `buildRetuneSearchParams`); later cosmetic edits are free.
 */
export function basisKey(packId: string, staged: StagedPool | null): string {
  return staged === null
    ? `${packId}|live|live`
    : `${packId}|staged|${stagedKey(staged)}`;
}

// ─── Derived status (pure) ──────────────────────────────────────────────────

export type WorkspaceStatus =
  | "pristine"
  | "planning"
  | "planned"
  | "infeasible"
  | "stale"
  | "drifted"
  | "pushing"
  | "pushed"
  | "refused"
  | "error";

/**
 * Derive the selected pack's workspace status from facts. Priority:
 * `pushing` > `refused` > `pushed` (marker, no re-staged edits — F14: a
 * pushed pack requires re-staging before Push re-enables) > entry-derived
 * (`pristine → planning → planned | infeasible | stale | drifted | error`).
 */
export function deriveStatus(args: {
  packId: string;
  staged: StagedPool | null;
  entry: PlanEntry | undefined;
  pushInFlight: boolean;
  pushed: boolean;
  refused: boolean;
}): WorkspaceStatus {
  const { packId, staged, entry, pushInFlight, pushed, refused } = args;
  if (pushInFlight) return "pushing";
  if (refused) return "refused";
  // F14 double-push kill: after a successful push the staged entry is
  // cleared; the pushed marker holds the pack in `pushed` until the operator
  // stages NEW edits — so a fresh live-arm plan can't silently re-arm Push.
  if (pushed && staged === null) return "pushed";
  if (!entry) return "pristine";
  if (entry.status === "loading") return "planning";
  if (entry.status === "error") return "error";
  if (entry.basisKey !== basisKey(packId, staged)) return "stale";
  if (
    staged !== null &&
    entry.plan !== null &&
    entry.plan.poolFingerprint !== staged.baseFingerprint
  ) {
    return "drifted"; // F7 — live pool moved under the staged edits
  }
  if (entry.plan !== null && entry.plan.feasible) return "planned";
  return "infeasible";
}

// ─── Push enablement (never approve what wasn't planned) ────────────────────

/**
 * Push is enabled iff ALL of (§4):
 *   status === `planned` (implies: plan landed for the CURRENT basis, no
 *   push in flight, not recently pushed without re-staging)
 *   ∧ no tag contradiction
 *   ∧ tagged packs are tag-exact (`taggedAccuracyHit !== false` AND the
 *     after win-rate is within `TAGGED_WRITE_WINRATE_TOLERANCE` of the tag)
 *   ∧ clean odds (`snapped !== false`) — the owner's MUST — with the ONE
 *     escape hatch: a staged-arm plan under an explicit price pin.
 */
export function isPushEnabled(args: {
  status: WorkspaceStatus;
  plan: PackTunePlan | null;
  arm: "live" | "staged";
  pinPrice: boolean;
}): boolean {
  const { status, plan, arm, pinPrice } = args;
  if (status !== "planned" || plan === null || plan.after === null) return false;
  if (plan.tagContradiction !== null) return false;
  if (plan.intendedHitRate !== null) {
    if (plan.taggedAccuracyHit === false) return false;
    if (
      Math.abs(plan.after.winRate - plan.intendedHitRate) >
      TAGGED_WRITE_WINRATE_TOLERANCE
    ) {
      return false;
    }
  }
  if (plan.snapped === false && !(arm === "staged" && pinPrice)) return false;
  return true;
}

// ─── Staged pool builders ───────────────────────────────────────────────────

/** Seed a staged pool from the fresh `getPackEditPool` read (first edit). */
export function seedStagedPool(pool: EditPool): StagedPool {
  return {
    cards: pool.cards.map((c) => ({
      cardId: c.cardId,
      name: c.name,
      value: c.value,
      imageUrl: c.imageUrl,
      color: c.color,
      animation: c.animation,
      liveWeight: c.weight,
      added: false,
    })),
    removed: [],
    price: pool.price,
    livePrice: pool.price,
    pinPrice: false,
    baseFingerprint: computePoolFingerprint(
      pool.price,
      pool.cards.map((c) => ({ cardId: c.cardId, weight: c.weight })),
    ),
  };
}

/**
 * Re-anchor a staged pool onto a FRESH live pool (D1's re-base steal — F8's
 * recovery and F17's "Keep my edits"): the operator's identity choices
 * (adds/removes/cosmetics) survive, the live-weight anchors + baseline
 * fingerprint re-seed from fresh production truth.
 */
export function reanchorStagedPool(
  staged: StagedPool,
  freshPool: EditPool,
): StagedPool {
  const freshById = new Map(freshPool.cards.map((c) => [c.cardId, c]));
  const stagedIds = new Set(staged.cards.map((c) => c.cardId));
  const removedIds = new Set(staged.removed.map((c) => c.cardId));
  const cards: StagedCard[] = staged.cards.map((c) => {
    const fresh = freshById.get(c.cardId);
    return fresh
      ? { ...c, value: fresh.value, liveWeight: fresh.weight, added: false }
      : { ...c, liveWeight: null, added: true };
  });
  // Fresh live cards the operator neither kept nor explicitly removed (a
  // card someone ELSE added since the seed) join the staged pool — the
  // operator reviews them in the diff rather than silently deleting them.
  for (const fresh of freshPool.cards) {
    if (!stagedIds.has(fresh.cardId) && !removedIds.has(fresh.cardId)) {
      cards.push({
        cardId: fresh.cardId,
        name: fresh.name,
        value: fresh.value,
        imageUrl: fresh.imageUrl,
        color: fresh.color,
        animation: fresh.animation,
        liveWeight: fresh.weight,
        added: false,
      });
    }
  }
  // Explicit removals stay removed — but only the ones still live (an
  // externally-deleted card has nothing left to remove).
  const removed: StagedCard[] = staged.removed
    .filter((c) => freshById.has(c.cardId))
    .map((c) => {
      const fresh = freshById.get(c.cardId)!;
      return { ...c, value: fresh.value, liveWeight: fresh.weight, added: false };
    });
  const priceUntouched = staged.price === staged.livePrice;
  return {
    cards,
    removed,
    price: priceUntouched ? freshPool.price : staged.price,
    livePrice: freshPool.price,
    pinPrice: staged.pinPrice,
    baseFingerprint: computePoolFingerprint(
      freshPool.price,
      freshPool.cards.map((c) => ({ cardId: c.cardId, weight: c.weight })),
    ),
  };
}

/**
 * The staged input `planPackTune` receives — pool IDENTITY only (weights are
 * server-shaped; cosmetics never affect the solve). The write payload
 * (`stagedWriteInput`) is derived from the SAME staged facts so plan ≡ write
 * by construction.
 */
export function stagedPlanInput(staged: StagedPool): PackTuneStagedInput {
  return {
    cards: staged.cards.map((c, i) => ({ cardId: c.cardId, order: i })),
    ...(staged.price !== staged.livePrice ? { price: staged.price } : {}),
    ...(staged.pinPrice ? { pinPrice: true } : {}),
  };
}

/**
 * The `applyStagedPackEditAndRetune` pool input — the SAME identity + order
 * as {@link stagedPlanInput}, plus the operator's cosmetics (color/animation
 * ride the push payload only).
 */
export function stagedWriteInput(staged: StagedPool): StagedPoolInput {
  return {
    cards: staged.cards.map((c, i) => ({
      cardId: c.cardId,
      ...(c.color !== null ? { color: c.color } : {}),
      animation: c.animation,
      order: i,
    })),
    ...(staged.price !== staged.livePrice ? { price: staged.price } : {}),
  };
}

// ─── Write-refusal classifiers (server messages, verified verbatim) ─────────

/**
 * F8 — pool-freshness (fingerprint) refusal. Matches BOTH write arms'
 * messages ("this pack's pool or price changed since the approved proposal…"
 * / "this pack's live pool or price changed since the reviewed proposal…").
 */
export function isPoolDriftRefusal(message: string): boolean {
  return message.includes("changed since the");
}

/**
 * F9 — `approvedPriceAfter` tolerance-0 refusal ("…the approved preview
 * showed $X.XX … parameter-skew or nondeterminism bug; please report it").
 */
export function isPriceSkewRefusal(message: string): boolean {
  return message.includes("the approved preview showed");
}

/** F6 — retune-token expiry (silent re-mint + ONE retry, same frozen artifact). */
export function isTokenExpired(message: string): boolean {
  return message.includes("authorization expired");
}
