"use server";

import { revalidatePath, revalidateTag, unstable_cache } from "next/cache";
import { isUuid } from "@/lib/utils/ids";
import type { pack_tag } from "@/generated/prisma/enums";
import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { sessionHasRole } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { requirePackStudioAccess } from "@/lib/require-pack-studio-access";
import {
  isPackStudioRetuneOperator,
  isPackStudioRetuneOperatorNonOwner,
} from "@/lib/reprice-access";
import { verifyRetuneToken } from "@/lib/reprice-token";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { reloadPacks } from "@/app/(admin)/rewards/actions";
import { getPacksPoolComposition } from "@/lib/queries/packs";
import { getPackCardValues } from "@/lib/queries/pack-card-values";
import { getSets, getRarities } from "@/lib/queries/cards";
import { capturePackSnapshot } from "@/app/(admin)/packs/_lib/pack-history";
import { buildPackCompliance } from "@/app/(admin)/packs/_lib/risk-config";
import {
  computePackRisk,
  searchBestPriceForCleanSnap,
  isOnCleanLadderPct,
  isOnNiceGridPct,
  ONE_SIDED_EDGE_EXCESS_TOL,
  RETUNE_MAX_PRICE_CHANGE_PCT,
  type PackRisk,
  type ShapeWeightsRelaxation,
  type ShapeWeightsLimit,
} from "@/app/(admin)/insights/edge-calc/risk";
import {
  computeTagGuidance,
  computeUntaggedGuidance,
  ladderShape,
  buildWidePriceProbeSuggestion,
  derivePoolEditPlan,
  pruneNoOpSuggestions,
  buildPackTuneVerdict,
  computePinRemedies,
  type TagGuidance,
  type LadderShape,
  type TuneSuggestion,
  type PoolEditPlan,
  type PoolEditReason,
  type PackTuneVerdict,
  type PinRemedy,
} from "@/app/(admin)/insights/edge-calc/tag-guidance";
import {
  planPackReprice,
  clampRepriceTarget,
  REPRICE_ACCEPT_TOLERANCE,
  REPRICE_HARD_TOLERANCE,
  type RepriceAction,
} from "@/app/(admin)/insights/edge-calc/math";
import {
  autoRetuneTargets,
  resolveIntendedHitRate,
  SELECTABLE_TAG_HIT_RATES,
  TAGGED_WRITE_WINRATE_TOLERANCE,
  TAGGED_NEAR_MISS_MIN,
  autoTargetEdge,
  DEFAULT_EDGE_CURVE,
  EDIT_EDGE_FLOOR,
  readEdgeCurveConfig,
  readMaxWinCap,
  readMaxMultCeiling,
  readRetunePriceBudgetPct,
  type EdgeCurveConfig,
  type ResolvedAutoTargetCfg,
} from "@/app/(admin)/packs/_lib/risk-config";
import { computePoolFingerprint } from "@/app/(admin)/packs/_lib/pool-fingerprint";
import {
  packRiskBand,
  isRiskBandExit,
  type RiskBand,
} from "@/app/(admin)/packs/_lib/risk-bands";
import {
  buildRetuneSearchParams,
  computeCapDroppedCardIds,
  mapPinnedOddsToShares,
  omitZeroWeightRows,
  type RetunePinnedOdds,
} from "@/app/(admin)/packs/_lib/retune-params";
import { packRetunePlanTag } from "../_actions/retune-cache-tag";

/**
 * Read-only plan surfaces + staged-write actions backing the Pack Doctor and
 * the Retune V2 workspace. The authoritative pool/price WRITE path for the
 * live arm is the existing pack server actions (`planPackRetune` /
 * `authorizePackRetune` / `applyPackRetune` and `authorizeReprice` /
 * `repricePackToTargetEdge` in `src/app/(admin)/packs/actions.ts`) — this file
 * adds the operator-gated READ surfaces those don't export plus the staged
 * writers:
 *
 *   • planCustomRepin   — a READ-ONLY dry-run for the "Re-pin below-target packs
 *     to ≥ target" action: re-derives each below-target pack's round-up
 *     price/edge via the SAME `planPackReprice` the global re-price uses.
 *   • planPackTune      — THE Retune V2 single-pack plan (live or staged arm);
 *     the workspace's one brain (see the section near the end of this file).
 *   • getPackEditPool / applyPackEdit / applyStagedPackEditAndRetune — the
 *     inline pool read + the verbatim / server-shaped staged writers.
 *
 * Reads are owner-gated AND Pack-Studio-gated, READ-ONLY (MAIN is read-only
 * here; they only SELECT), and write nothing. The mutations stay paranoid and
 * token-guarded (same RETUNE scope `authorizePackRetune` mints).
 */

/**
 * Operator + Pack-Studio gate shared by every read in this module.
 *
 * Open to owners and to the hard-coded Pack-Studio retune operator allowlist
 * (`isPackStudioRetuneOperator`) — operators on that list reach these read-only
 * dry-runs without owner status, and the matching write actions on the same
 * surface bypass 2FA for them (see `src/lib/reprice-access.ts` for the rationale).
 */
async function requireRetuneOwner() {
  const session = await requirePackStudioAccess(
    "Not authorized to access the pack re-tune tools.",
  );
  if (!isPackStudioRetuneOperator(session)) {
    throw new Error("The pack re-tune tools are restricted to authorized operators.");
  }
  return session;
}

export type CustomRepinRow = {
  packId: string;
  name: string;
  slug: string;
  priceBefore: number;
  priceAfter: number | null;
  edgeBefore: number;
  edgeAfter: number | null;
  /** THIS pack's target edge fraction (its per-pack curve target). */
  target: number;
  action: RepriceAction;
  reason: string;
};

export type CustomRepinPlan = {
  /**
   * How the plan's targets were chosen: `"per-pack"` (each pack to ITS edge-curve
   * target — floor 10.99% + risk premium) or a flat number (every pack to the
   * SAME edge). The write loop passes this same selector to
   * `repricePackToTargetEdge` so the dry-run and the write can't drift.
   */
  target: number | "per-pack";
  /** The edge FLOOR (10.99%) — the lowest target any pack can carry. Shown in UI. */
  targetFloor: number;
  /** Tolerances are RELATIVE to each pack's own target; these are at the floor. */
  acceptMin: number;
  acceptMax: number;
  hardMin: number;
  hardMax: number;
  /** Packs that WILL change (round-up price move), largest swing first. */
  toReprice: CustomRepinRow[];
  /** Packs already on target / inside the accept band. */
  unchanged: CustomRepinRow[];
  /** Packs that can't be brought into the band (e.g. 1¢ step too coarse). */
  skipped: CustomRepinRow[];
};

/**
 * READ-ONLY dry-run for the "Re-pin packs to their target edge" action. Given the
 * candidate pack ids (the below-target packs the doctor grid already surfaced),
 * re-read each pack's FRESH composition from MAIN and re-derive its round-up
 * price/edge via the SAME `planPackReprice` the global re-price uses.
 *
 * `target` selects how each pack's target is chosen:
 *   • `"per-pack"` (default) — each pack targets ITS OWN edge-curve target
 *     ({@link autoTargetEdge}: floor 10.99% + a gentle risk premium driven by the
 *     pack's max-win $ exposure + price). Different packs get different targets.
 *   • a flat number — every pack targets the SAME edge (legacy/explicit).
 *
 * The SAME selector is returned in the plan and re-passed to
 * `repricePackToTargetEdge`, so the dry-run and the authoritative write derive
 * each pack's target identically (no drift). Writes nothing — the operator
 * confirms, then the existing `authorizeReprice` + `repricePackToTargetEdge` loop
 * performs the per-pack 2FA-guarded writes. Out-of-scope ids (a pack that's no
 * longer active, has no price, or is now on target) surface as skipped/unchanged
 * so a stale grid can't force a bad write.
 */
export async function planCustomRepin(
  packIds: string[],
  target: number | "per-pack" = "per-pack",
): Promise<CustomRepinPlan> {
  await requireRetuneOwner();

  if (target !== "per-pack" && (!Number.isFinite(target) || target <= 0 || target >= 1)) {
    throw new Error("Invalid target edge.");
  }

  // The edge-curve config (floor / ceiling / coefficients) resolved ONCE for the
  // whole run, so every pack's per-pack target derives off the same source-of-
  // truth blob — matches what `repricePackToTargetEdge` reads on the write side.
  const edgeCurve: EdgeCurveConfig =
    target === "per-pack" ? await readEdgeCurveConfig() : DEFAULT_EDGE_CURVE;

  /** This pack's target: its curve target in per-pack mode, else the flat one. */
  const targetFor = (p: { price: number; maxWin: number }): number =>
    target === "per-pack"
      ? clampRepriceTarget(autoTargetEdge({ price: p.price, maxWin: p.maxWin }, edgeCurve))
      : target;

  const ids = packIds.filter((id) => isUuid(id));
  const comps = ids.length > 0 ? await getPacksPoolComposition({ packIds: ids }) : [];

  // The floor target (10.99% in per-pack mode, or the flat target) — used for the
  // header band display. Per-pack bands are RELATIVE to each pack's own target.
  const targetFloor = target === "per-pack" ? edgeCurve.edgeFloor : target;

  const rows: CustomRepinRow[] = comps.map((p) => {
    const packTarget = targetFor({ price: p.price, maxWin: p.maxValue });
    // Defense-in-depth: the per-pack write re-checks scope anyway, but skip
    // here too so the preview never promises a write the action would reject.
    if (!p.active || !(p.price > 0)) {
      return {
        packId: p.id,
        name: p.name,
        slug: p.slug,
        priceBefore: p.price,
        priceAfter: null,
        edgeBefore: 0,
        edgeAfter: null,
        target: packTarget,
        action: "skip" as RepriceAction,
        reason: !p.active
          ? "Out of scope: pack is not active."
          : "Out of scope: pack has no price.",
      };
    }
    const plan = planPackReprice({
      currentPrice: p.price,
      cardsPerOpen: p.cardsPerOpen,
      totalWeight: p.totalWeight,
      weightedPriceSum: p.weightedPriceSum,
      targetEdge: packTarget,
      // One-sided-up rounding — IDENTICAL to the `repricePackToTargetEdge` write
      // this dry-run previews. Each re-pinned pack's edge lands ≥ its per-pack
      // target (never below the 10.99% floor); a pack whose only round-up cent
      // overshoots beyond ±ACCEPT is skipped, not overcharged. The preview and
      // the write share this mode so the dry-run can't promise a write the action
      // would round differently.
      roundingMode: "up",
    });
    return {
      packId: p.id,
      name: p.name,
      slug: p.slug,
      priceBefore: p.price,
      priceAfter: plan.newPrice,
      edgeBefore: plan.currentEdge,
      edgeAfter: plan.newEdge,
      target: packTarget,
      action: plan.action,
      reason: plan.reason,
    };
  });

  const toReprice = rows
    .filter((r) => r.action === "reprice")
    .sort(
      (a, b) =>
        Math.abs((b.priceAfter ?? b.priceBefore) - b.priceBefore) -
        Math.abs((a.priceAfter ?? a.priceBefore) - a.priceBefore),
    );
  const unchanged = rows.filter((r) => r.action === "unchanged");
  const skipped = rows.filter((r) => r.action === "skip");

  return {
    target,
    targetFloor,
    acceptMin: targetFloor - REPRICE_ACCEPT_TOLERANCE,
    acceptMax: targetFloor + REPRICE_ACCEPT_TOLERANCE,
    hardMin: targetFloor - REPRICE_HARD_TOLERANCE,
    hardMax: targetFloor + REPRICE_HARD_TOLERANCE,
    toReprice,
    unchanged,
    skipped,
  };
}

// ─── Card-picker filters for the inline pool editor (read-only) ───────────

export type RetunePickerFilters = {
  sets: { id: string; name: string }[];
  rarities: string[];
};

/**
 * READ-ONLY, Pack-Studio-gated: the set + rarity filter lists the inline
 * pool editor's card picker needs. Loaded lazily (only when the owner opens the
 * editor) so the review surface doesn't pay for them up front. Mirrors what the
 * Builder page fetches for its `BuilderCardPicker` (`getSets` + `getRarities`),
 * just behind a server action so the client can fetch on demand. Writes nothing.
 */
export async function getRetunePickerFilters(): Promise<RetunePickerFilters> {
  await requireRetuneOwner();
  const [sets, rarities] = await Promise.all([getSets(), getRarities()]);
  return {
    sets,
    rarities: rarities.filter((r): r is string => r != null),
  };
}

// ─── Inline pool editing (read the pool to edit + write an EXPLICIT edited pool) ─
//
// The retune review can also EDIT a pack's card pool by hand — add/remove cards
// and set per-card weights — and Approve the EXACT pool it shows. Unlike a retune
// (which re-shapes weights server-side via `shapeWeights` from a target), an edit
// writes the operator's EXPLICIT weights verbatim. It carries the SAME paranoia as
// `applyPackRetune` in `src/app/(admin)/packs/actions.ts`:
//   • operator-only (`isPackStudioRetuneOperator`) + `__can_update_pack` capability,
//   • the SAME 2FA RETUNE token `authorizePackRetune` mints (`verifyRetuneToken`),
//   • the pack_creator live-pack carve-out,
//   • a FRESH MAIN read of price + scope right before the write (fail-closed),
//   • a "edit" snapshot of the CURRENT state captured FIRST (revertable),
//   • the SAME delete-all-then-createMany `pack_cards` transaction `updatePack` /
//     `applyPackRetune` use, then audit + ADMIN risk-row refresh.
//
// MAIN stays read-only FOR THE AGENT — this is code the owner runs behind their
// own 2FA via the existing owner-operated pack_cards transaction (existing tables,
// no MAIN schema change). The agent never executes it against prod.

/** Only `official` packs may be edited via the retune review (matches the
 *  `REPRICE_OR_RETUNE_PACK_TYPES` scope the pack actions enforce). */
const EDITABLE_PACK_TYPES: readonly string[] = ["official"];

/** One pool card for the inline editor: identity + value + the editable knobs. */
export type EditPoolCard = {
  cardId: string;
  name: string;
  imageUrl: string;
  /** `cards.price` — the item's value (a voucher is the same as a card). */
  value: number;
  weight: number;
  color: string | null;
  animation: boolean;
  order: number;
};

export type EditPool = {
  packId: string;
  name: string;
  slug: string;
  packType: string;
  active: boolean;
  price: number;
  /** Pool cards in `pack_cards.order`, with the metadata the editor round-trips. */
  cards: EditPoolCard[];
};

/**
 * READ-ONLY (MAIN), owner-gated: the pack's FULL current pool for the inline
 * editor — price + per-card {value (cards.price), weight, color, animation,
 * order, name, imageUrl}. Reads MAIN read-only (the pack identity + its
 * pack_cards joined to cards for value/name/image). Writes nothing.
 */
export async function getPackEditPool(packId: string): Promise<EditPool> {
  await requireRetuneOwner();
  if (!isUuid(packId)) throw new Error("Invalid pack id");

  const db = await getDb();
  const pack = await db.packs.findUnique({
    where: { id: packId },
    select: {
      name: true,
      slug: true,
      price: true,
      active: true,
      pack_type: true,
      pack_cards: {
        select: {
          card_id: true,
          weight: true,
          color: true,
          animation: true,
          order: true,
        },
        orderBy: { order: "asc" },
      },
    },
  });
  if (!pack) throw new Error("Pack not found");

  const cardIds = pack.pack_cards.map((pc) => pc.card_id);
  // Identity + value for each pool card (read-only PK probe on `cards`).
  const cardMeta = new Map<string, { name: string; imageUrl: string; value: number }>();
  if (cardIds.length > 0) {
    const cardRows = await db.cards.findMany({
      where: { id: { in: cardIds } },
      select: { id: true, name: true, image_url: true, price: true },
    });
    for (const r of cardRows) {
      cardMeta.set(r.id, {
        name: r.name,
        imageUrl: r.image_url,
        value: Number(r.price.toString()),
      });
    }
  }

  const cards: EditPoolCard[] = pack.pack_cards.map((pc) => {
    const meta = cardMeta.get(pc.card_id);
    return {
      cardId: pc.card_id,
      name: meta?.name ?? `${pc.card_id.slice(0, 8)}…`,
      imageUrl: meta?.imageUrl ?? "",
      value: meta?.value ?? 0,
      weight: pc.weight,
      color: pc.color,
      animation: pc.animation,
      order: pc.order,
    };
  });

  return {
    packId,
    name: pack.name,
    slug: pack.slug,
    packType: pack.pack_type,
    active: pack.active,
    price: Number(pack.price.toString()),
    cards,
  };
}

/** One explicit card slot the operator approves — written verbatim. */
export type EditPoolInputCard = {
  cardId: string;
  weight: number;
  color?: string;
  animation?: boolean;
  order: number;
};

export type EditPoolInput = {
  cards: EditPoolInputCard[];
  /** Optional new pack price (USD). When omitted, the price is left unchanged. */
  price?: number;
  /**
   * RC1 pool-freshness token — the fingerprint of the LIVE pool (price +
   * sorted (cardId, weight) pairs) the operator's edit was seeded/reviewed
   * from ({@link computePoolFingerprint}). When set, the write recomputes the
   * fingerprint over the FRESH live pool and REFUSES on mismatch ("pool
   * changed since the preview") instead of silently rewriting a pool the
   * operator never saw — identical fail-closed pattern as
   * `applyStagedPackEditAndRetune` / `applyPackRetune`. Optional — legacy
   * callers (e.g. the drafts push) pass nothing and are unaffected.
   */
  approvedPoolFingerprint?: string | null;
};

export type ApplyPackEditResult = {
  packId: string;
  name: string;
  status: "edited";
  cardCountBefore: number;
  cardCountAfter: number;
  priceBefore: number;
  priceAfter: number;
  /** Risk summary of the pack AS IT IS NOW vs. the explicit edited pool. */
  before: { edge: number; winRate: number; maxWin: number };
  after: { edge: number; winRate: number; maxWin: number };
};

/**
 * The pack_creator live-pack carve-out, mirroring `applyPackRetune` /
 * `updatePack`: a pack_creator may iterate on inactive (demo) packs but is
 * blocked from rewriting an ACTIVE pack's pool unless granted
 * `__can_edit_live_packs`. A real admin / owner short-circuits earlier in
 * `requireCapability`, so this is only reached for non-admins. Returns true iff
 * an active pack was edited under the explicit capability (for the audit flag).
 */
async function enforcePackCreatorLiveGate(
  session: Awaited<ReturnType<typeof requirePackStudioAccess>>,
  active: boolean,
): Promise<boolean> {
  if (!sessionHasRole(session, "pack_creator")) return false;
  if (!active) return false;
  const perms = await adminDb.admin_users.findUnique({
    where: { id: session.userId },
    select: { allowed_pages: true },
  });
  const canEditLive = perms
    ? hasCapability(perms.allowed_pages, "__can_edit_live_packs")
    : false;
  if (!canEditLive) {
    throw new Error(
      "Live packs can only be edited by full admins or pack creators with the 'Edit Live Packs' capability. Ask an admin to grant the capability, or deactivate the pack first.",
    );
  }
  return true;
}

/**
 * Write an EXPLICIT edited card pool to MAIN. Owner-only AND requires a valid
 * RETUNE token from `authorizePackRetune` (the SAME 2FA scope a retune carries)
 * + `__can_update_pack` + the pack_creator live-pack carve-out.
 *
 * Unlike a retune, this writes the operator's explicit weights/color/animation/
 * order verbatim (the client supplies the pool it approved). It still FAILS
 * CLOSED before any write:
 *   • token / owner / capability / scope (`official`) gate,
 *   • non-empty pool, every weight a positive integer, no duplicate cardId,
 *     every cardId a valid uuid, optional price > 0,
 *   • every edited cardId must exist in the pack's CURRENT live pool — an edit
 *     can re-weight / remove / reorder existing cards, but cannot inject a card
 *     the pool never had (adding a brand-new card belongs in the full Builder,
 *     which validates card identity; this keeps the verbatim edit honest
 *     and read-verified against fresh MAIN truth).
 *
 * Captures an "edit" snapshot of the CURRENT state FIRST (revertable), then
 * writes via the SAME delete-all-then-createMany `pack_cards` transaction
 * `updatePack` / `applyPackRetune` use, audits "pack_edited_via_retune" with
 * before/after card counts + a risk summary, and refreshes the ADMIN risk row.
 */
export async function applyPackEdit(
  packId: string,
  token: string,
  input: EditPoolInput,
): Promise<ApplyPackEditResult> {
  const session = await requireRetuneOwner();
  await requireCapability(session, "__can_update_pack", "edit packs");
  if (!(await verifyRetuneToken(token, session.userId))) {
    throw new Error("2FA authorization expired or missing — re-confirm to continue.");
  }
  if (!isUuid(packId)) throw new Error("Invalid pack id");

  // ── Validate the explicit input (fail-closed BEFORE any read/write) ──────
  if (!Array.isArray(input.cards) || input.cards.length === 0) {
    throw new Error("Refused: the edited pool must contain at least one card.");
  }
  const seen = new Set<string>();
  for (const c of input.cards) {
    if (!isUuid(c.cardId)) throw new Error("Refused: a card id is invalid.");
    if (seen.has(c.cardId)) {
      throw new Error("Refused: the edited pool has a duplicate card.");
    }
    seen.add(c.cardId);
    if (
      !Number.isInteger(c.weight) ||
      c.weight <= 0
    ) {
      throw new Error("Refused: every card weight must be a positive integer.");
    }
    if (!Number.isInteger(c.order) || c.order < 0) {
      throw new Error("Refused: every card order must be a non-negative integer.");
    }
  }
  const priceProvided = input.price !== undefined;
  if (priceProvided && (!Number.isFinite(input.price) || input.price! <= 0)) {
    throw new Error("Refused: price must be greater than 0.");
  }

  const db = await getDb();

  // FRESH pack row: price + scope + the CURRENT live pool (so we can scope-check,
  // verify every edited card already exists, and compute the before/after risk).
  const pack = await db.packs.findUnique({
    where: { id: packId },
    select: {
      price: true,
      active: true,
      pack_type: true,
      name: true,
      tags: true,
      pack_cards: { select: { card_id: true } },
    },
  });
  if (!pack) throw new Error("Pack not found");

  if (!EDITABLE_PACK_TYPES.includes(pack.pack_type)) {
    throw new Error(
      `Out of scope: only official packs can be edited (this is '${pack.pack_type}').`,
    );
  }

  const priceBefore = Number(pack.price.toString());
  const priceAfter = priceProvided ? input.price! : priceBefore;
  if (!(priceAfter > 0)) throw new Error("Refused: pack has no valid price.");

  // pack_creator live-pack carve-out (same gate updatePack / applyPackRetune use).
  const editedLivePackUnderCapability = await enforcePackCreatorLiveGate(
    session,
    pack.active,
  );

  // Live pool ids — kept only for the before/after card-count audit (the gate
  // below validates card IDENTITY against the cards table, not pool membership).
  const liveCardIds = new Set(pack.pack_cards.map((pc) => pc.card_id));

  // Every edited cardId must be a REAL card (exists in `cards`) so the
  // pack_cards.card_id FK holds — but it need NOT already be in this pack's
  // live pool. Adding a brand-new real card (e.g. one priced >= the pack price)
  // is exactly how an infeasible "no-win-cards" pack gets fixed inline.
  // READ-ONLY SELECT on MAIN — allowed.
  const editedIds = [...seen];
  const existingCards = await db.cards.findMany({
    where: { id: { in: editedIds } },
    select: { id: true },
  });
  const existingCardIds = new Set(existingCards.map((c) => c.id));
  const unknown = input.cards.filter((c) => !existingCardIds.has(c.cardId));
  if (unknown.length > 0) {
    throw new Error(
      `Refused: ${unknown.length} edited card(s) do not exist as real cards.`,
    );
  }

  // FRESH pool values (cards.price) for the before/after risk summary — never
  // trust client-supplied values. Keyed by cardId.
  const pool = await getPackCardValues(packId);
  const valueByCard = new Map(pool.map((c) => [c.cardId, c.value]));

  // ── RC1 pool-freshness gate (fail closed BEFORE snapshot/write) ─────────
  // Identical pattern to `applyStagedPackEditAndRetune` / `applyPackRetune`:
  // when the caller pinned the fingerprint of the pool it reviewed, refuse
  // the verbatim write if the LIVE pool/price drifted in between instead of
  // silently overwriting state the operator never saw. Absent for legacy
  // callers (drafts push).
  const approvedPoolFingerprint =
    typeof input.approvedPoolFingerprint === "string" &&
    input.approvedPoolFingerprint.length > 0
      ? input.approvedPoolFingerprint
      : null;
  if (
    approvedPoolFingerprint !== null &&
    computePoolFingerprint(priceBefore, pool) !== approvedPoolFingerprint
  ) {
    throw new Error(
      "Refused: this pack's live pool or price changed since the reviewed proposal was computed — refresh the proposals and re-review this pack before approving.",
    );
  }

  const before = computePackRisk({
    cards: pool.map((c) => ({ value: c.value, weight: c.weight })),
    price: priceBefore,
  });
  const after = computePackRisk({
    cards: input.cards.map((c) => ({
      value: valueByCard.get(c.cardId) ?? 0,
      weight: c.weight,
    })),
    price: priceAfter,
  });

  // ── HARD SERVER-SIDE FLOOR (fail-closed; no write may sneak past) ────────
  // The client-side double-confirm in the retune review is a UX defense and
  // was demonstrably bypassed once by a stale browser bundle. This server
  // guard is the absolute backstop: any edited pool whose computed edge falls
  // below `EDIT_EDGE_FLOOR` is refused BEFORE the snapshot and BEFORE the MAIN
  // transaction, so nothing reaches `pack_cards`. Audit the refusal as a
  // best-effort side-effect so the attempt is on record either way.
  if (after.edge < EDIT_EDGE_FLOOR) {
    try {
      await createAdminAuditEvent({
        adminUserId: session.userId,
        eventType: "pack_edit_refused_edge_floor",
        metadata: {
          pack_id: packId,
          name: pack.name,
          attempted_edge: after.edge,
          floor: EDIT_EDGE_FLOOR,
          attempted_max_win: after.maxWin,
          price_before: priceBefore,
          price_after: priceAfter,
          card_count_attempted: input.cards.length,
        },
      });
    } catch {
      /* best-effort — never block the refusal */
    }
    throw new Error(
      `Refused: edited pool produces ${(after.edge * 100).toFixed(2)}% house edge, below the ${(EDIT_EDGE_FLOOR * 100).toFixed(0)}% safety floor. Adjust the odds so the house keeps at least ${(EDIT_EDGE_FLOOR * 100).toFixed(0)}% margin, then re-approve.`,
    );
  }

  // The explicit rows to write — operator's weights/color/animation/order verbatim.
  const rows = input.cards.map((c) => ({
    pack_id: packId,
    card_id: c.cardId,
    weight: c.weight,
    color: c.color ?? null,
    animation: c.animation ?? false,
    order: c.order,
  }));

  // Capture the PRIOR state into the ADMIN change history BEFORE the write below,
  // so this snapshot is the state the owner can revert TO. Best-effort: a snapshot
  // failure must NOT fail the committed edit (the helper swallows + logs).
  await capturePackSnapshot({
    packId,
    action: "edit",
    capturedBy: session.userId,
  });

  // SAME delete-all-then-createMany pattern updatePack / applyPackRetune use.
  await db.$transaction(async (tx) => {
    await tx.packs.update({
      where: { id: packId },
      data: {
        ...(priceProvided ? { price: priceAfter } : {}),
        updated_at: new Date(),
      },
    });
    await tx.pack_cards.deleteMany({ where: { pack_id: packId } });
    if (rows.length > 0) {
      await tx.pack_cards.createMany({ data: rows });
    }
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "pack_edited_via_retune",
    metadata: {
      pack_id: packId,
      name: pack.name,
      card_count_before: liveCardIds.size,
      card_count_after: rows.length,
      price_before: priceBefore,
      price_after: priceAfter,
      price_changed: priceProvided && priceAfter !== priceBefore,
      before: { edge: before.edge, winRate: before.winRate, maxWin: before.maxWin },
      after: { edge: after.edge, winRate: after.winRate, maxWin: after.maxWin },
      ...(editedLivePackUnderCapability && {
        edited_live_pack_under_capability: true,
      }),
      ...(isPackStudioRetuneOperatorNonOwner(session) && {
        via_no_2fa_allowlist: true,
      }),
    },
  });

  // Refresh the ADMIN-side risk row from the edited pool (ADMIN write only). The
  // cap here is the pack's actual post-edit max win — the edit has no target cap
  // lever, so compliance is judged against the realized exposure. Best-effort:
  // the MAIN write already committed, so an ADMIN-side failure must NOT fail the
  // edit (the helper swallows + logs; the next snapshot run reconciles).
  await refreshEditedPackRiskScore(packId, after);

  reloadPacks();
  // Invalidate this pack's cached V2 plan so the next `planPackTune` reflects
  // this edit instead of a 60s-stale solve. Per-pack: ONLY this pack's plan
  // is busted (never the other 182).
  revalidateTag(packRetunePlanTag(packId));
  // The persistent "Tuned: X / N" counter reads the distinct edit/retune
  // snapshot count — this edit just captured one, so bust its 60s cache.
  revalidateTag("pack-studio-tuned-count");
  revalidatePath("/packs");
  revalidatePath(`/packs/${packId}`);

  return {
    packId,
    name: pack.name,
    status: "edited",
    cardCountBefore: liveCardIds.size,
    cardCountAfter: rows.length,
    priceBefore,
    priceAfter,
    before: { edge: before.edge, winRate: before.winRate, maxWin: before.maxWin },
    after: { edge: after.edge, winRate: after.winRate, maxWin: after.maxWin },
  };
}

/**
 * Mirror ONE pack's ADMIN-side risk row from an explicit edited pool's
 * already-computed {@link PackRisk} (ADMIN write only — never MAIN), so the Pack
 * Studio Doctor grid + Overview reflect the edit without waiting for the next
 * snapshot run. Same row shape `refreshPackRiskScore` in the pack actions writes
 * (`buildPackCompliance` + the resolved max-win cap). The edit has no target cap,
 * so compliance is judged against the resolved global cap. Best-effort: swallows
 * + logs (the MAIN write already committed; the next snapshot run reconciles).
 */
async function refreshEditedPackRiskScore(
  packId: string,
  risk: PackRisk,
  maxWinCapOverride?: number,
  // TRUE for a pct-tagged lottery pack — zero near-miss is the genre there,
  // never a compliance defect. Optional; omitted = legacy untagged judgment
  // (the next snapshot run reconciles the flag with full tag context).
  tagged?: boolean,
): Promise<void> {
  try {
    const maxWinCap = maxWinCapOverride ?? (await readMaxWinCap());
    const riskRow = {
      edge: risk.edge,
      cv: risk.cv,
      win_rate: risk.winRate,
      near_miss: risk.nearMiss,
      max_win: risk.maxWin,
      max_mult: risk.maxMult,
      risk_score: risk.riskScore0to100,
      tier: risk.tier,
      compliance: buildPackCompliance(risk, maxWinCap, { tagged }),
      computed_at: new Date(),
    };
    await adminDb.pack_risk_scores.upsert({
      where: { pack_id: packId },
      update: riskRow,
      create: { pack_id: packId, ...riskRow },
    });
    revalidateTag("pack-studio-overview");
  } catch (err) {
    console.error("applyPackEdit: pack_risk_scores refresh failed", err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  STAGED EDIT + AUTO-RETUNE
// ─────────────────────────────────────────────────────────────────────────────
//
//  `applyStagedPackEditAndRetune` is the SAFE PATH for the inline pool editor:
//  the owner picks the pool IDENTITY (which cards, in what order, with which
//  color/animation), and the SERVER picks the weights via `shapeWeights` so the
//  result is guaranteed to clear the pack's auto-targets (edge curve + tag
//  win-rate + near-miss + cap) — no hand-typed odds can land on prod with bad
//  weights.
//
//  Differences from `applyPackEdit` (the legacy verbatim writer):
//    • the client supplies cards WITHOUT a `weight` — the server shapes them.
//    • the staged pool may include brand-new real cards (read against `cards`),
//      so fixing an infeasible no-win pack by adding a card ≥ price works
//      inline (was already the behavior in `applyPackEdit` since the f64d81dc
//      identity check landed).
//    • same FAIL-CLOSED asserts as `applyPackRetune` (edge ≥ target, max-win
//      ≤ cap, |winRate − target| ≤ tol) PLUS the `EDIT_EDGE_FLOOR` backstop.
//    • snapshot action `"edit"` (the existing label — `pack_history`'s action
//      enum hasn't been extended for "edit_and_retune" and the change captures
//      the prior pool exactly like a hand-edit, so the revert path is identical).
//    • audit event `pack_edited_and_retuned`, so an audit review can separate
//      this safe path from the verbatim `pack_edited_via_retune` calls.

/** One staged pool card the OWNER picked. No weight — the SERVER shapes it. */
export type StagedPoolInputCard = {
  cardId: string;
  color?: string;
  animation?: boolean;
  order: number;
};

/**
 * Owner tag override (Retune workspace tag control, 2026-07-04). The operator
 * may REMOVE or CHANGE a pack's product tag from the workspace header and the
 * staged plan (and, on push, the write) uses the OVERRIDDEN tag instead of the
 * pack's live `packs.tags`:
 *   • `{ kind: "untag" }` — treat the pack as UNTAGGED regardless of its DB
 *     tags AND its name-prefix tag (the fast, live-anchored plan). On push,
 *     `packs.tags` is cleared to `[]`.
 *   • `{ kind: "tag"; tag; hitRate }` — pin the plan to `hitRate` (the tag's
 *     designed win-rate) and, on push, write `[tag]` to `packs.tags`.
 * Omitted ⇒ the pack's live tag is used (byte-identical legacy behavior).
 *
 * `tag` is the `pack_tag` enum NAME (validated fail-closed against the
 * selectable set); `hitRate` is echoed for the solve and re-derived + checked
 * server-side so a client can't smuggle a mismatched pair.
 */
export type StagedTagOverride =
  | { kind: "untag" }
  | { kind: "tag"; tag: "pct1" | "pct5" | "pct10" | "fifty50"; hitRate: number };

export type StagedPoolInput = {
  cards: StagedPoolInputCard[];
  /** Optional new pack price (USD). When omitted, the price is left unchanged. */
  price?: number;
  /**
   * Owner-pinned EXACT per-card odds (Retune V2 pins) — the typed percent per
   * pinned card, held verbatim through the server solve (plan AND write run
   * the same shared `resolveAndShapeStagedPool` pass, so preview ≡ write
   * includes the pins). Every pinned cardId MUST be one of `cards` (validated
   * fail-closed); feasibility (cap-dropped pin, tag/EV overshoot, edge band)
   * is judged by the solver and surfaces as the `pins-infeasible` limit.
   * Omitted / empty ⇒ legacy behavior, byte-identical.
   */
  pinnedOdds?: RetunePinnedOdds[];
  /**
   * Owner tag override (tag control) — see {@link StagedTagOverride}. When set,
   * the solve resolves its intended hit-rate from THIS override instead of the
   * pack's live `packs.tags` (plan) and the write persists the override to
   * `packs.tags` (following `updatePack`'s tags-write pattern). Omitted ⇒ the
   * pack's live tag is used.
   */
  tagOverride?: StagedTagOverride;
};

export type ApplyStagedRetuneResult = {
  packId: string;
  name: string;
  status: "edited_and_retuned";
  cardCountBefore: number;
  cardCountAfter: number;
  priceBefore: number;
  priceAfter: number;
  before: { edge: number; winRate: number; maxWin: number };
  after: { edge: number; winRate: number; maxWin: number };
  /**
   * Price-search trace — only populated when the caller passed
   * `allowPriceSearch: true`. The `chosen` price equals `priceAfter`; the
   * `base` is the price the search started from (typically the staged price
   * or the unchanged pack price). Used by the UI to show a "price adjusted
   * from $X.XX to $Y.YY for cleaner odds" toast.
   */
  priceSearch: {
    attempted: boolean;
    base: number;
    chosen: number;
    candidates: number;
    fellBackToBase: boolean;
    /**
     * Tagged-pack accuracy result — populated when the search ran in tagged
     * mode (pack name carries an X% tag AND the caller did not override the
     * win-rate target). `true` when the chosen candidate landed within 0.01pp
     * of the tag, `false` when no candidate could; `null` when tagged mode
     * was not active (untagged pack OR caller pinned a custom win-rate).
     */
    taggedAccuracyHit: boolean | null;
  } | null;
};

// ─── Shared staged-pool resolution (the write + the dry-run must not drift) ─
//
// `resolveAndShapeStagedPool` is the ONE implementation of "take a staged pool
// (identity + optional price) + target levers, resolve everything against
// FRESH MAIN truth (never client-supplied values), and shape the weights".
// Used by BOTH:
//   • `applyStagedPackEditAndRetune` (the WRITE) — throws the refusal message
//     for every non-ok outcome (byte-identical to the pre-refactor asserts),
//     then persists the shaped pool.
//   • `planPackTune`'s STAGED arm (the READ-ONLY dry-run) — returns the
//     outcome as a verdict so the workspace can judge the STAGED pool's
//     feasibility without writing anything.
// One resolver is the point: the owner-reported bug behind it was the review
// card judging feasibility off the LIVE pool while the editor had already
// staged the fix — the preview and the write must derive identically or the
// verdict lies. Malformed input / unknown pack / out-of-scope pack type THROW
// in both paths; solver + assert outcomes come back as a structured refusal so
// the dry-run can render them as a verdict.

/** Why the write path would refuse a staged pool (mirrors its throw sites). */
type StagedRefusalCode =
  | "tag-contradiction"
  | "infeasible"
  | "edge-below-target"
  | "edge-above-band"
  | "max-win-above-cap"
  | "win-rate-miss"
  | "tag-accuracy-miss"
  | "edge-floor";

type StagedShapeOutcome =
  | {
      ok: true;
      /** Server-shaped weights aligned to the staged input card order. */
      weights: number[];
      after: PackRisk;
      relaxations: ShapeWeightsRelaxation[];
      snapped: boolean | null;
      topInflationUnavoidable: boolean | null;
      /** §niceness (tagged snap only): human-nice verdict; null otherwise. */
      allNice: boolean | null;
      /** §niceness: engine exempt indexes (staged card order); null otherwise. */
      niceExemptIdx: number[] | null;
    }
  | {
      ok: false;
      code: StagedRefusalCode;
      /** The EXACT message the write path throws for this refusal. */
      message: string;
      /** Structured hard limit for the solver's infeasible arm (else null). */
      limit: ShapeWeightsLimit | null;
      /** The shaped risk when shaping succeeded but an assert refused it. */
      after: PackRisk | null;
      /**
       * Server-shaped weights (staged input card order) when shaping SUCCEEDED
       * but a fail-closed write-assert refused the result (e.g. `win-rate-miss`,
       * `edge-above-band`). Lets the infeasible untagged arm still compute the
       * degenerate-ladder guidance / pool-edit suggestion off the real vector.
       * `null` when shaping itself failed (no vector exists).
       */
      weights: number[] | null;
    };

type StagedShapeResolution = {
  packName: string;
  packActive: boolean;
  priceBefore: number;
  priceStaged: number;
  priceProvided: boolean;
  /** The price the write would persist (the search's pick, else the staged price). */
  priceAfter: number;
  liveCardIds: Set<string>;
  /** The CURRENT live pool (fresh `getPackCardValues` read). */
  livePool: { cardId: string; value: number; weight: number }[];
  /** Risk of the pack AS IT IS NOW (live pool at the live price). */
  before: PackRisk;
  /** Fresh identity + value for every STAGED card (never client-trusted). */
  cardMetaById: Map<string, { value: number; name: string; imageUrl: string }>;
  /** The targets the pool was shaped against (auto-resolved + caller pins). */
  resolved: {
    targetEdge: number;
    targetWinRate: number;
    maxWinCap: number;
    nearMissMin: number;
    winRateTol: number;
    intendedHitRate: number | null;
  };
  /**
   * Owner tag override → `packs.tags` write directive (tag control). `null`
   * when NO override was passed (the write leaves `packs.tags` untouched);
   * `[]` for "untag" (clears the tag); `[tag]` for a set tag. The write path
   * (`applyStagedPackEditAndRetune`) applies this to `packs.tags` following
   * `updatePack`'s tags-write pattern; the plan path ignores it (nothing is
   * written). `priorTags` is the pack's live tag set at read time — captured so
   * the write audit + the History snapshot can record what was replaced.
   */
  tagWrite: ("pct1" | "pct5" | "pct10" | "fifty50")[] | null;
  priorTags: string[];
  priceSearch: ApplyStagedRetuneResult["priceSearch"];
  outcome: StagedShapeOutcome;
};

/**
 * Resolve + shape a staged pool against fresh MAIN truth. READ-ONLY — writes
 * nothing; the caller decides whether to persist (write) or report (dry-run).
 * NOT exported: this lives in a "use server" module, so exporting it would
 * mint a public server-action endpoint without an auth gate. Both callers
 * gate BEFORE calling it.
 */
async function resolveAndShapeStagedPool(
  packId: string,
  input: StagedPoolInput,
  targets: {
    targetEdge?: number;
    targetWinRate?: number;
    maxWinCap?: number;
    nearMissMin?: number;
    /**
     * When TRUE the server runs `searchBestPriceForCleanSnap` around the staged
     * price (the shared ±60% retune band via `buildRetuneSearchParams`,
     * cent-stepped) and picks the candidate whose `shapeWeights` result keeps
     * `snapped=true` while staying closest to the staged price. The chosen
     * candidate becomes the final `priceAfter` written to `packs.price` (so
     * the writer's `priceProvided` path applies it cleanly). Defaults to
     * FALSE — current behavior unchanged.
     */
    allowPriceSearch?: boolean;
    /**
     * RC1 approved-artifact contract — the FINAL price the operator's preview
     * showed as "will be written". When set, the write REFUSES (no write) if
     * the price it is about to persist differs (tolerance 0). The review
     * client sends it only when `allowPriceSearch` is off (the staged price IS
     * the artifact); with the search on, the server legitimately picks the
     * price, so no client-side expectation exists to verify. Optional —
     * legacy callers are unaffected.
     */
    approvedPriceAfter?: number | null;
    /**
     * RC1 pool-freshness token — `PackTunePlan.poolFingerprint`, the
     * fingerprint of the LIVE pool (price + sorted (cardId, weight) pairs)
     * the reviewed proposal was solved from. When set, the write recomputes
     * the fingerprint over the FRESH live pool and REFUSES on mismatch
     * ("pool changed since the preview") instead of silently anchoring the
     * staged solve on drifted live state. Optional — legacy callers are
     * unaffected.
     */
    approvedPoolFingerprint?: string | null;
  },
): Promise<StagedShapeResolution> {
  if (!isUuid(packId)) throw new Error("Invalid pack id");

  // ── Validate the staged input (fail-closed BEFORE any read/write) ────────
  if (!Array.isArray(input.cards) || input.cards.length === 0) {
    throw new Error("Refused: the staged pool must contain at least one card.");
  }
  const seen = new Set<string>();
  for (const c of input.cards) {
    if (!isUuid(c.cardId)) throw new Error("Refused: a card id is invalid.");
    if (seen.has(c.cardId)) {
      throw new Error("Refused: the staged pool has a duplicate card.");
    }
    seen.add(c.cardId);
    if (!Number.isInteger(c.order) || c.order < 0) {
      throw new Error("Refused: every card order must be a non-negative integer.");
    }
  }
  const priceProvided = input.price !== undefined;
  if (priceProvided && (!Number.isFinite(input.price) || input.price! <= 0)) {
    throw new Error("Refused: price must be greater than 0.");
  }
  // Owner pins (Retune V2) — STRUCTURAL validation only, fail-closed like the
  // staged-input checks above (malformed pins = a client construction bug →
  // throw). Whether the pinned VALUES are feasible is the SOLVER's verdict
  // and comes back as data (`pins-infeasible` limit), never a throw — the
  // dry-run renders it, the write refuses with the same message.
  const pinnedOdds =
    Array.isArray(input.pinnedOdds) && input.pinnedOdds.length > 0
      ? input.pinnedOdds
      : null;
  if (pinnedOdds !== null) {
    const pinSeen = new Set<string>();
    for (const p of pinnedOdds) {
      if (!isUuid(p.cardId)) {
        throw new Error("Refused: a pinned card id is invalid.");
      }
      if (!seen.has(p.cardId)) {
        throw new Error("Refused: a pinned card is not in the staged pool.");
      }
      if (pinSeen.has(p.cardId)) {
        throw new Error("Refused: a card carries two pinned values.");
      }
      pinSeen.add(p.cardId);
      if (!Number.isFinite(p.pct) || !(p.pct > 0) || p.pct > 100) {
        throw new Error(
          "Refused: a pinned chance must be a number above 0% and at most 100%.",
        );
      }
    }
  }
  // Owner tag override (tag control) — STRUCTURAL validation, fail-closed. When
  // set, it authoritatively decides the pack's intended hit-rate for the solve
  // (below) and, on the write path, the `packs.tags` value. `hitRate` is
  // re-derived from the selectable-tag table (never trusted from the client) so
  // a mismatched {tag, hitRate} pair can't smuggle a bad target.
  const tagOverride = input.tagOverride ?? null;
  let overrideIntendedHitRate: number | null | undefined;
  if (tagOverride !== null) {
    if (tagOverride.kind === "untag") {
      overrideIntendedHitRate = null; // force UNTAGGED (ignore DB + name tag)
    } else if (tagOverride.kind === "tag") {
      const match = SELECTABLE_TAG_HIT_RATES.find(
        (t) => t.tag === tagOverride.tag,
      );
      if (!match) {
        throw new Error("Refused: unknown pack tag in the tag override.");
      }
      overrideIntendedHitRate = match.hitRate;
    } else {
      throw new Error("Refused: invalid tag override.");
    }
  }

  const db = await getDb();

  // FRESH pack row: price + scope + the CURRENT live pool (for before-risk +
  // card-count audit). Same select shape as `applyPackEdit`.
  const pack = await db.packs.findUnique({
    where: { id: packId },
    select: {
      price: true,
      active: true,
      pack_type: true,
      name: true,
      tags: true,
      pack_cards: { select: { card_id: true } },
    },
  });
  if (!pack) throw new Error("Pack not found");

  if (!EDITABLE_PACK_TYPES.includes(pack.pack_type)) {
    throw new Error(
      `Out of scope: only official packs can be edited (this is '${pack.pack_type}').`,
    );
  }

  const priceBefore = Number(pack.price.toString());
  // The staged price the operator approved. The price-search lever (below) may
  // move it within the shared ±60% retune band to land cleaner odds; the FINAL
  // `priceAfter` is assigned after the shape step, and is what gets written to
  // `packs.price`.
  const priceStaged = priceProvided ? input.price! : priceBefore;
  if (!(priceStaged > 0)) throw new Error("Refused: pack has no valid price.");
  let priceAfter = priceStaged;

  const liveCardIds = new Set(pack.pack_cards.map((pc) => pc.card_id));

  // REAL-card identity check + fresh value lookup in ONE select (we need both
  // here — `getPackCardValues` only returns cards already in the live pool,
  // which a staged pool may extend with brand-new cards). Name + image ride
  // along so the dry-run can label its per-card plan without a second probe.
  const editedIds = [...seen];
  const cardRows = await db.cards.findMany({
    where: { id: { in: editedIds } },
    select: { id: true, price: true, name: true, image_url: true },
  });
  const cardMetaById = new Map<
    string,
    { value: number; name: string; imageUrl: string }
  >();
  for (const r of cardRows) {
    cardMetaById.set(r.id, {
      value: Number(r.price.toString()),
      name: r.name,
      imageUrl: r.image_url ?? "",
    });
  }
  const unknown = input.cards.filter((c) => !cardMetaById.has(c.cardId));
  if (unknown.length > 0) {
    throw new Error(
      `Refused: ${unknown.length} staged card(s) do not exist as real cards.`,
    );
  }

  // BEFORE risk uses the LIVE pool (fresh) so the audit + return reflect the
  // actual prior state — never the staged identities.
  const livePool = await getPackCardValues(packId);

  // ── RC1 pool-freshness gate (fail closed BEFORE solving) ────────────────
  // The staged pool identity travels verbatim in `input.cards`, but the solve
  // still anchors on LIVE state: `stagedCurrentWeights` (anti-inflation
  // anchor) and `priceBefore` both come from the live pack. If another edit
  // landed between the reviewed preview and this approve, those anchors are
  // no longer what the operator saw — refuse and ask for a refresh instead of
  // silently solving against drifted inputs. Absent for legacy callers.
  const approvedPoolFingerprint =
    typeof targets.approvedPoolFingerprint === "string" &&
    targets.approvedPoolFingerprint.length > 0
      ? targets.approvedPoolFingerprint
      : null;
  if (
    approvedPoolFingerprint !== null &&
    computePoolFingerprint(priceBefore, livePool) !== approvedPoolFingerprint
  ) {
    throw new Error(
      "Refused: this pack's live pool or price changed since the reviewed proposal was computed — refresh the proposals and re-review this pack before approving.",
    );
  }

  const before = computePackRisk({
    cards: livePool.map((c) => ({ value: c.value, weight: c.weight })),
    price: priceBefore,
  });

  // ── Resolve auto-targets for the AFTER-price + the pack name (tag-aware) ──
  // Targets are resolved off the STAGED price (the operator's chosen price). If
  // the price-search lever lands on a slightly different price, the same
  // targets still apply — the edge curve / cap derive from the price the
  // operator explicitly picked, not the search's nudge.
  const cfg: ResolvedAutoTargetCfg = {
    globalCap: await readMaxWinCap(),
    maxMultCeiling: await readMaxMultCeiling(),
    edgeCurve: await readEdgeCurveConfig(),
  };
  // The DEFAULT retune price budget (±10% unless configured) — resolved ONCE
  // and threaded into the shared builder so the staged plan ≡ staged write
  // (both run THIS resolver's search branch).
  const priceBudgetPct = await readRetunePriceBudgetPct();
  // The STAGED pool's top card value — the pool is fully known here, so the
  // edge-curve premium prices the pool's ACTUAL jackpot exposure, not the
  // loosened theoretical cap (ruleset: no phantom premium on tagged packs).
  let stagedTopValue = 0;
  for (const c of input.cards) {
    const v = cardMetaById.get(c.cardId)!.value;
    if (v > stagedTopValue) stagedTopValue = v;
  }
  // LIVE top card value — a live over-cap card the owner already runs is
  // grandfathered (Pattern 5). Deliberately the LIVE top, NOT the staged top:
  // grandfathering must not bless a NEWLY-staged over-cap card (the cap stops
  // new escalation). The edge curve still prices the STAGED exposure below.
  let liveTopValue = 0;
  for (const c of livePool) if (c.value > liveTopValue) liveTopValue = c.value;
  const auto = autoRetuneTargets(
    priceStaged,
    cfg,
    // Owner tag override (tag control) wins when set: a number pins the tag,
    // `null` forces UNTAGGED (ignoring BOTH the DB tag AND the name-prefix tag —
    // the owner said "let me remove the tags... when i remove replan" makes the
    // pack plan untagged). No override ⇒ the pack's live tag: DB `tags` column
    // first (authoritative), name-prefix tag as fallback.
    overrideIntendedHitRate !== undefined
      ? (overrideIntendedHitRate ?? undefined)
      : (resolveIntendedHitRate(pack.name, pack.tags) ?? undefined),
    stagedTopValue,
    // LIVE-ANCHORED targets (owner-lens 2026-07-03) — anchored to the LIVE
    // pool's designed character (win-rate/near-miss/edge from `before`), with
    // the over-cap grandfather keyed on the LIVE top only. The write shares
    // THIS resolver, so plan ≡ write by construction.
    {
      winRate: before.winRate,
      nearMiss: before.nearMiss,
      edge: before.edge,
      topValue: liveTopValue,
    },
  );
  const targetEdge = targets.targetEdge ?? auto.targetEdge;
  const targetWinRate = targets.targetWinRate ?? auto.targetWinRate;
  const maxWinCap = targets.maxWinCap ?? auto.maxWinCap;
  // TAGGED near-miss seed (ruleset §1.2): no default floor — a lottery is
  // binary — but a live pool that GENUINELY carries near-miss mass (e.g.
  // Divine Order's designed 20% band) keeps it. Untagged keeps the 0.1 floor.
  const nearMissMin =
    targets.nearMissMin ??
    (auto.intendedHitRate !== null
      ? Math.max(TAGGED_NEAR_MISS_MIN, before.nearMiss)
      : auto.nearMissMin);
  const winRateTol = 0.02; // matches shapeWeights' default + applyPackRetune.

  const resolved: StagedShapeResolution["resolved"] = {
    targetEdge,
    targetWinRate,
    maxWinCap,
    nearMissMin,
    winRateTol,
    intendedHitRate: auto.intendedHitRate,
  };
  // Tag-write directive (tag control): `null` when NO override (leave
  // `packs.tags` untouched); `[]` for "untag" (clear it); `[tag]` for a set
  // tag. The plan path ignores this; the write path persists it. `priorTags`
  // is the live tag set (for the write's audit + the revert snapshot).
  const priorTags: string[] = Array.isArray(pack.tags)
    ? pack.tags.map((t) => String(t))
    : [];
  const tagWrite: StagedShapeResolution["tagWrite"] =
    tagOverride === null
      ? null
      : tagOverride.kind === "untag"
        ? []
        : [tagOverride.tag];
  // Shared partial for every return arm — only the outcome (+ the price the
  // search may still move) varies below.
  const base = {
    packName: pack.name,
    packActive: pack.active,
    priceBefore,
    priceStaged,
    priceProvided,
    liveCardIds,
    livePool,
    before,
    cardMetaById,
    resolved,
    tagWrite,
    priorTags,
  };

  // A pct-tagged pack's win-rate is a design CONTRACT — a pinned target that
  // contradicts the tag is refused (mirrors `applyPackRetune`). Reported as a
  // structured refusal so the dry-run can render the verdict; the write throws
  // this exact message. Tolerance 1e-6 (ruleset §0): the tag is exact — any
  // real divergence is a contradiction, not a rounding allowance (the old
  // 0.1pp window let RC2-style sentinel defeats slip through as "close
  // enough"); float round-trips of the tag itself are lossless.
  if (
    auto.intendedHitRate !== null &&
    Math.abs(targetWinRate - auto.intendedHitRate) > 1e-6
  ) {
    return {
      ...base,
      priceAfter,
      priceSearch: null,
      outcome: {
        ok: false,
        code: "tag-contradiction",
        message: `Refused: this pack is tagged ${(auto.intendedHitRate * 100).toFixed(2)}% — the requested win-rate ${(targetWinRate * 100).toFixed(2)}% contradicts the tag. Leave the win-rate on auto (tag-aware), or untag the pack first.`,
        limit: null,
        after: null,
        // Refused BEFORE shaping — no shaped vector exists.
        weights: null,
      },
    };
  }

  // The staged value vector in input ORDER (cardId rides along so the shared
  // builder can resolve owner pins to indices). The shaper picks one weight
  // per slot.
  const stagedValues = input.cards.map((c) => ({
    value: cardMetaById.get(c.cardId)!.value,
    cardId: c.cardId,
  }));

  // CURRENT weights aligned to the staged card ORDER — the anti-inflation anchor
  // for the writer so the persisted odds NEVER let a win/grail card exceed its
  // CURRENT (live-pool) odds. A card staged-IN that wasn't in the live pool has 0
  // current weight (no cap → its odds may settle naturally); a card kept from the
  // live pool carries its live weight. Mirrors the dry-run preview's anchor so
  // the WRITTEN odds match what the operator saw.
  const liveWeightByCardId = new Map<string, number>();
  for (const c of livePool) liveWeightByCardId.set(c.cardId, c.weight);
  const stagedCurrentWeights = input.cards.map(
    (c) => liveWeightByCardId.get(c.cardId) ?? 0,
  );

  // ── Optional price-search lever ───────────────────────────────────────
  // When the operator opts in (`allowPriceSearch: true`), the server sweeps
  // cent-stepped candidate prices around the staged price (the shared ±60%
  // retune band via `buildRetuneSearchParams`) and picks the one whose
  // `shapeWeights` result lands every card on a clean ladder rung
  // (snapped=true) while staying closest to the staged price.
  //
  // TAGGED LOTTERY PACKS: when the pack name carries an "X%" tag (e.g.
  // "1% 18 PLUS") AND the caller hasn't pinned a custom win-rate target, the
  // scoring elevates STRICT win-rate accuracy ABOVE clean-snap. The owner's
  // hard requirement is that a tagged X% pack achieves EXACTLY X% win-rate
  // (within 0.01pp); the lottery-skew dust-scale EV-compensation drifts the
  // achieved win-rate above the tag at the base price, so the search re-bands
  // the pool to find a price that delivers BOTH targets simultaneously.
  //
  // The chosen price becomes the FINAL `priceAfter` written to `packs.price`
  // (the existing writer already updates the price when it differs from
  // `priceBefore`). Defaults to disabled — current behavior is byte-for-byte
  // unchanged.
  const allowPriceSearch = targets.allowPriceSearch === true;
  const intendedHitRate = auto.intendedHitRate;
  // Tagged-pack mode triggers whenever the RESOLVED targetWinRate equals the
  // tag — the value-equality gate now lives INSIDE `buildRetuneSearchParams`,
  // shared with `applyPackRetune` + both `planPackTune` arms. (The review
  // client always sends the resolved target explicitly, so the old
  // `!callerPinnedWinRate` condition silently turned tagged mode OFF on every
  // UI approve while the approved preview ran WITH it — preview ≠ write. An
  // operator who adjusts the win-rate AWAY from the tag is refused above.)
  let shaped;
  let priceSearchMeta: ApplyStagedRetuneResult["priceSearch"] = null;
  if (allowPriceSearch) {
    // params come from buildRetuneSearchParams — the tolerance-0
    // approvedPriceAfter pin depends on all four sites sharing it. NOTE: the
    // builder widens this staged search from the old silent ±25% default to
    // the shared ±60% retune band (owner-sanctioned: price is a free lever).
    const search = searchBestPriceForCleanSnap(
      buildRetuneSearchParams("staged", {
        cards: stagedValues,
        basePrice: priceStaged,
        targetEdge,
        targetWinRate,
        maxWinCap,
        nearMissMin,
        winRateTol,
        // Anti-inflation anchor (same as the dry-run preview): the WRITTEN odds
        // may never let a win/grail card exceed its CURRENT (live-pool) odds.
        currentWeights: stagedCurrentWeights,
        intendedHitRate,
        priceBudgetPct,
        // Owner pins — held EXACT at every candidate price; plan and write
        // thread them through this SAME builder (preview ≡ write incl. pins).
        ...(pinnedOdds !== null ? { pinnedOdds } : {}),
      }),
    );
    shaped = search.bestResult;
    priceAfter = search.bestPrice;
    priceSearchMeta = {
      attempted: true,
      base: priceStaged,
      chosen: search.bestPrice,
      candidates: search.searched,
      fellBackToBase: search.fellBackToBase,
      taggedAccuracyHit: search.taggedAccuracyHit,
    };
  } else {
    // Pinned-price solve (the V2 `pinPrice` escape hatch) — routed through THE
    // SAME shared constructor as every search solve, with the band spread-
    // overridden to 0 so the sweep degenerates to ONE solve at EXACTLY the
    // pinned price (`searchBestPriceForCleanSnap`'s documented disabled-search
    // contract: `bestPrice === basePrice`, `searched: 1`). This branch used to
    // hand-mirror the builder's flags and drifted exactly the way the RC2
    // sentinel defeat predicted: it was missing `disperseLoss`,
    // `niceGridPolish`, the untagged `holdWinRateHard` (+ graceful fallback /
    // LAW M rescue, which live in the search wrapper), AND the lottery gate
    // (a 50/50 coin-flip pin ran the strict hard-tag contract the search arm
    // deliberately avoids) — so a one-click far-price suggestion promising
    // "fully clean (all-nice) at $X" re-planned through here to an UNPOLISHED
    // off-nice vector at that very $X. Routing through the builder makes the
    // whole skew class unconstructible; the write runs this same resolver, so
    // plan ≡ write is preserved automatically.
    const search = searchBestPriceForCleanSnap({
      ...buildRetuneSearchParams("staged", {
        cards: stagedValues,
        basePrice: priceAfter,
        targetEdge,
        targetWinRate,
        maxWinCap,
        nearMissMin,
        winRateTol,
        // Anti-inflation anchor (no win/grail card's odds exceed its current odds).
        currentWeights: stagedCurrentWeights,
        intendedHitRate,
        priceBudgetPct,
        // Owner pins — held EXACT, through the SAME builder mapping the
        // search branch uses (pinned-price plan and write solve one problem).
        ...(pinnedOdds !== null ? { pinnedOdds } : {}),
      }),
      // ANCHORED: no band — one solve at the pinned price, nothing else. The
      // budget passed above only sizes the DFS node budget (a 0 band earns
      // the default-band budget, all of it spent on this single snap).
      maxPriceChangePct: 0,
    });
    shaped = search.bestResult;
  }

  const priceSearch = priceSearchMeta;

  // ── The write's FAIL-CLOSED asserts, evaluated as a VERDICT ──
  // Same checks, same order, byte-identical messages as the pre-refactor
  // throws — the write raises the message; the dry-run renders it. A refusal
  // here means "approve WOULD be refused with exactly this error".
  if ("error" in shaped) {
    return {
      ...base,
      priceAfter,
      priceSearch,
      outcome: {
        ok: false,
        code: "infeasible",
        message: `Auto-tune infeasible: ${shaped.error}`,
        limit: shaped.limit,
        after: null,
        weights: null,
      },
    };
  }
  // RC1 approved-artifact gate: when the caller pinned the previewed final
  // price, the write must land EXACTLY it (tolerance 0). With the pool
  // fingerprint above verified fresh, a differing price means a
  // preview↔write parameter skew or a nondeterminism bug — surface it
  // honestly instead of writing a price the operator never saw.
  const approvedPriceAfter =
    targets.approvedPriceAfter != null && Number.isFinite(targets.approvedPriceAfter)
      ? targets.approvedPriceAfter
      : null;
  if (approvedPriceAfter !== null && priceAfter !== approvedPriceAfter) {
    throw new Error(
      `Refused: this write would set the price to $${priceAfter.toFixed(2)}, but the approved preview showed $${approvedPriceAfter.toFixed(2)}${
        approvedPoolFingerprint !== null
          ? " even though the pool is unchanged — this is a preview/write parameter-skew or nondeterminism bug; please report it"
          : " — the preview is likely stale"
      }. Refresh the proposals and re-review before approving.`,
    );
  }
  const after = shaped.risk;
  const refuse = (
    code: StagedRefusalCode,
    message: string,
  ): StagedShapeResolution => ({
    ...base,
    priceAfter,
    priceSearch,
    // Shaping SUCCEEDED here (a post-shape assert refused) — carry the shaped
    // weights so the untagged infeasible arm can still compute its guidance.
    outcome: { ok: false, code, message, limit: null, after, weights: shaped.weights },
  });
  if (after.edge < targetEdge - 1e-9) {
    return refuse(
      "edge-below-target",
      `Refused: resulting edge ${(after.edge * 100).toFixed(2)}% is below the target ${(targetEdge * 100).toFixed(2)}%.`,
    );
  }
  // TAGGED upper band (ruleset write assert): the one-sided-up acceptance may
  // legally land a pinned pool up to 0.25pp ABOVE the curve target — anything
  // beyond that is a solver/param anomaly, refused fail-closed. Untagged packs
  // keep their float-up semantics (no upper assert).
  if (
    intendedHitRate !== null &&
    after.edge > targetEdge + ONE_SIDED_EDGE_EXCESS_TOL + 1e-9
  ) {
    return refuse(
      "edge-above-band",
      `Refused: resulting edge ${(after.edge * 100).toFixed(3)}% sits more than ${(ONE_SIDED_EDGE_EXCESS_TOL * 100).toFixed(2)}pp above the ${(targetEdge * 100).toFixed(2)}% target — outside the accepted one-sided band for a tagged pack.`,
    );
  }
  if (after.maxWin > maxWinCap + 1e-9) {
    return refuse(
      "max-win-above-cap",
      `Refused: resulting max win $${after.maxWin.toFixed(2)} exceeds the cap $${maxWinCap.toFixed(2)}.`,
    );
  }
  if (Math.abs(after.winRate - targetWinRate) > winRateTol + 1e-9) {
    return refuse(
      "win-rate-miss",
      `Refused: resulting win-rate ${(after.winRate * 100).toFixed(2)}% misses target ${(targetWinRate * 100).toFixed(2)}% (±${(winRateTol * 100).toFixed(2)}%).`,
    );
  }
  // Tagged packs get a 20x tighter acceptance vs their TAG (0.1pp) — mirrors
  // `applyPackRetune`; the flat ±2pp band would let a "1%" pack ship at 3%.
  if (
    intendedHitRate !== null &&
    Math.abs(after.winRate - intendedHitRate) >
      TAGGED_WRITE_WINRATE_TOLERANCE + 1e-9
  ) {
    return refuse(
      "tag-accuracy-miss",
      `Refused: resulting win-rate ${(after.winRate * 100).toFixed(3)}% misses the pack tag ${(intendedHitRate * 100).toFixed(2)}% by more than ${(TAGGED_WRITE_WINRATE_TOLERANCE * 100).toFixed(1)}pp.`,
    );
  }
  // Belt-and-suspenders backstop — mirrors `applyPackEdit` + `applyPackRetune`.
  // Cannot trip if the asserts above hold (targetEdge ≥ EDIT_EDGE_FLOOR per the
  // edge-curve floor), kept for refactor safety + uniform refusal audit (the
  // write audits this refusal before throwing).
  if (after.edge < EDIT_EDGE_FLOOR) {
    return refuse(
      "edge-floor",
      `Refused: shaped pool produces ${(after.edge * 100).toFixed(2)}% house edge, below the ${(EDIT_EDGE_FLOOR * 100).toFixed(0)}% safety floor.`,
    );
  }

  return {
    ...base,
    priceAfter,
    priceSearch,
    outcome: {
      ok: true,
      weights: shaped.weights,
      after,
      relaxations: shaped.relaxations,
      snapped: shaped.snapped ?? false,
      topInflationUnavoidable: shaped.topInflationUnavoidable ?? false,
      allNice: shaped.allNice ?? null,
      niceExemptIdx: shaped.niceExemptIdx ?? null,
    },
  };
}

/**
 * Write a STAGED card pool to MAIN with SERVER-SHAPED weights — the safe inline
 * editor approve path. Owner-only AND requires a valid RETUNE token from
 * `authorizePackRetune` (the SAME 2FA scope every retune/edit carries) +
 * `__can_update_pack` + the pack_creator live-pack carve-out.
 *
 * The owner picks the pool IDENTITY (cards + order + color/animation + optional
 * new price); the SERVER picks the WEIGHTS via `shapeWeights` against the pack's
 * auto-targets (edge curve + tag-aware win-rate + near-miss + cap), so the
 * shipped pool is guaranteed to clear targets — there is no path for hand-typed
 * odds to land on prod with bad weights from this entry point.
 *
 * FAILS CLOSED before any write (all evaluated by the SHARED
 * `resolveAndShapeStagedPool` — the same pass `planPackTune`'s staged arm
 * dry-runs, so the staged plan and this write cannot drift):
 *   • token / owner / capability / scope (`official`) gate,
 *   • non-empty pool, no duplicate cardId, every cardId a valid uuid, every
 *     `order` a non-negative integer, optional price > 0,
 *   • REAL-card identity check: every cardId must exist in `cards` (so the
 *     pack_cards.card_id FK holds — but a brand-new real card can be added,
 *     exactly how an infeasible no-win pack gets fixed inline),
 *   • `shapeWeights` error arm,
 *   • resulting edge below target, max-win above cap, win-rate outside tol,
 *   • resulting edge below `EDIT_EDGE_FLOOR` (mirror of the `applyPackEdit`
 *     backstop — practically unreachable because the asserts above are tighter,
 *     kept as belt-and-suspenders so a future refactor can't sneak past).
 *
 * Captures an "edit" snapshot of the CURRENT state FIRST (revertable), then
 * writes via the SAME delete-all-then-createMany `pack_cards` transaction
 * `updatePack` / `applyPackRetune` / `applyPackEdit` use, audits
 * `pack_edited_and_retuned` with before/after card counts + a risk summary, and
 * refreshes the ADMIN risk row.
 */
export async function applyStagedPackEditAndRetune(
  packId: string,
  token: string,
  input: StagedPoolInput,
  targets: {
    targetEdge?: number;
    targetWinRate?: number;
    maxWinCap?: number;
    nearMissMin?: number;
    /**
     * When TRUE the server runs `searchBestPriceForCleanSnap` around the staged
     * price (the shared ±60% retune band via `buildRetuneSearchParams`,
     * cent-stepped) and picks the candidate whose `shapeWeights` result keeps
     * `snapped=true` while staying closest to the staged price. The chosen
     * candidate becomes the final `priceAfter` written to `packs.price` (so
     * the writer's `priceProvided` path applies it cleanly). Defaults to
     * FALSE — current behavior unchanged.
     */
    allowPriceSearch?: boolean;
    /**
     * RC1 approved-artifact contract — the FINAL price the operator's preview
     * showed as "will be written". When set, the write REFUSES (no write) if
     * the price it is about to persist differs (tolerance 0). The review
     * client sends it only when `allowPriceSearch` is off (the staged price IS
     * the artifact); with the search on, the server legitimately picks the
     * price, so no client-side expectation exists to verify. Optional —
     * legacy callers are unaffected. Enforced inside the shared
     * `resolveAndShapeStagedPool` pass.
     */
    approvedPriceAfter?: number | null;
    /**
     * RC1 pool-freshness token — `PackTunePlan.poolFingerprint`, the
     * fingerprint of the LIVE pool (price + sorted (cardId, weight) pairs)
     * the reviewed proposal was solved from. When set, the write recomputes
     * the fingerprint over the FRESH live pool and REFUSES on mismatch
     * ("pool changed since the preview") instead of silently anchoring the
     * staged solve on drifted live state. Optional — legacy callers are
     * unaffected. Enforced inside the shared `resolveAndShapeStagedPool` pass.
     */
    approvedPoolFingerprint?: string | null;
  },
): Promise<ApplyStagedRetuneResult> {
  const session = await requireRetuneOwner();
  await requireCapability(session, "__can_update_pack", "edit packs");
  if (!(await verifyRetuneToken(token, session.userId))) {
    throw new Error("2FA authorization expired or missing — re-confirm to continue.");
  }

  // RC1 audit-trace mirror of the guards `resolveAndShapeStagedPool` enforces
  // for this call (same normalization the resolver applies) — records which
  // approved-artifact pins were ACTIVE on this write.
  const approvedPoolFingerprint =
    typeof targets.approvedPoolFingerprint === "string" &&
    targets.approvedPoolFingerprint.length > 0
      ? targets.approvedPoolFingerprint
      : null;
  const approvedPriceAfter =
    targets.approvedPriceAfter != null &&
    Number.isFinite(targets.approvedPriceAfter)
      ? targets.approvedPriceAfter
      : null;

  // ONE shared resolution + shape pass (fresh MAIN reads, tag-aware auto-
  // targets, optional price search, assert evaluation, RC1 freshness/price
  // pins) — the exact pass `planPackTune`'s staged arm dry-runs, so the
  // staged plan the operator approved and this write derive identically.
  const r = await resolveAndShapeStagedPool(packId, input, targets);

  // pack_creator live-pack carve-out (same gate `applyPackEdit` enforces).
  // Enforced right after the shared resolution — a request failing BOTH this
  // gate and a resolution-level check now surfaces the resolution error first
  // (pre-refactor the gate ran before the card-identity read). The gate still
  // runs strictly BEFORE any write.
  const editedLivePackUnderCapability = await enforcePackCreatorLiveGate(
    session,
    r.packActive,
  );

  // ── FAIL-CLOSED refusals (throw → no write) ──
  // Byte-identical messages to the pre-refactor asserts; the edge-floor
  // backstop keeps its refusal audit.
  const outcome = r.outcome;
  if (!outcome.ok) {
    if (outcome.code === "edge-floor") {
      try {
        await createAdminAuditEvent({
          adminUserId: session.userId,
          eventType: "pack_edit_refused_edge_floor",
          metadata: {
            pack_id: packId,
            name: r.packName,
            source: "applyStagedPackEditAndRetune",
            attempted_edge: outcome.after?.edge ?? null,
            floor: EDIT_EDGE_FLOOR,
            attempted_max_win: outcome.after?.maxWin ?? null,
            target_edge: r.resolved.targetEdge,
          },
        });
      } catch {
        /* best-effort — never block the refusal */
      }
    }
    throw new Error(outcome.message);
  }

  const before = r.before;
  const after = outcome.after;
  const priceBefore = r.priceBefore;
  const priceAfter = r.priceAfter;
  const priceSearchMeta = r.priceSearch;

  // The rows to write — server-shaped weights paired with the OWNER's chosen
  // color/animation/order for each staged slot (NOT the live pack_cards row
  // metadata, since a staged pool may include brand-new cards).
  //
  // Cap removals (owner rule, 2026-07-03): slots the solver's cap pre-filter
  // dropped carry a shaped weight of 0 — those rows are OMITTED, so the card
  // is truly removed from the pack instead of persisting as a dead 0%-odds
  // row (recoverable via the History snapshot revert below). The plan the
  // operator approved surfaces exactly these ids as `capDroppedCardIds`.
  const rows = omitZeroWeightRows(
    input.cards.map((c, i) => ({
      pack_id: packId,
      card_id: c.cardId,
      weight: outcome.weights[i]!,
      color: c.color ?? null,
      animation: c.animation ?? false,
      order: c.order,
    })),
  );
  // Audit trace of the omission — the engine predicate over the staged pool.
  const capRemovedCardIds = computeCapDroppedCardIds(
    input.cards.map((c) => ({
      cardId: c.cardId,
      value: r.cardMetaById.get(c.cardId)?.value ?? 0,
    })),
    r.resolved.maxWinCap,
  );

  // Capture the PRIOR state into the ADMIN change history BEFORE the write.
  // The action label is "edit" (same as `applyPackEdit`) — the snapshot
  // captures the prior pool exactly like a hand-edit, so the revert path is
  // unchanged; the discriminator for "auto-tuned vs verbatim" lives in the
  // audit event (`pack_edited_and_retuned` vs `pack_edited_via_retune`).
  await capturePackSnapshot({
    packId,
    action: "edit",
    capturedBy: session.userId,
  });

  // Whether the writer should persist a new price: either the operator
  // explicitly supplied one, OR the price search nudged it off the staged
  // price (in which case the nudge is meaningless unless it lands in the DB).
  const shouldWritePrice = r.priceProvided || priceAfter !== priceBefore;

  // Owner tag override (tag control): when the operator changed/removed the
  // tag, `r.tagWrite` is the new `packs.tags` value (`[]` = untag, `[tag]` =
  // set) — persisted alongside the pool write, following `updatePack`'s
  // existing `packs.tags` write pattern EXACTLY (an already-sanctioned pack
  // mutation the /packs edit form performs). `null` = no override → tags left
  // untouched. Skip a no-op write (the override equals the live tag set).
  const priorTagSet = [...r.priorTags].sort().join(",");
  const nextTagSet =
    r.tagWrite !== null ? [...r.tagWrite].sort().join(",") : null;
  const shouldWriteTags = r.tagWrite !== null && nextTagSet !== priorTagSet;

  // SAME delete-all-then-createMany pattern used by every other writer.
  const db = await getDb();
  await db.$transaction(async (tx) => {
    await tx.packs.update({
      where: { id: packId },
      data: {
        ...(shouldWritePrice ? { price: priceAfter } : {}),
        // packs.tags is a pack_tag[] enum column (updatePack writes it the same
        // way). r.tagWrite is validated fail-closed to the selectable enum set.
        ...(shouldWriteTags ? { tags: r.tagWrite as pack_tag[] } : {}),
        updated_at: new Date(),
      },
    });
    await tx.pack_cards.deleteMany({ where: { pack_id: packId } });
    if (rows.length > 0) {
      await tx.pack_cards.createMany({ data: rows });
    }
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "pack_edited_and_retuned",
    metadata: {
      pack_id: packId,
      name: r.packName,
      card_count_before: r.liveCardIds.size,
      card_count_after: rows.length,
      price_before: priceBefore,
      price_after: priceAfter,
      price_changed: priceAfter !== priceBefore,
      // Owner tag override (tag control): the tag change this write persisted —
      // absent unless the tag actually changed.
      ...(shouldWriteTags
        ? { tags_before: r.priorTags, tags_after: r.tagWrite }
        : {}),
      // Owner pins this write held exact (Retune V2) — absent on pin-less writes.
      ...(input.pinnedOdds !== undefined && input.pinnedOdds.length > 0
        ? { pinned_odds: input.pinnedOdds }
        : {}),
      // Cap removals (owner rule, 2026-07-03): staged cards whose value
      // exceeded the resolved max-win cap — their rows were OMITTED from the
      // write (true removal). Absent when none were dropped.
      ...(capRemovedCardIds.length > 0 && {
        cap_removed_card_ids: capRemovedCardIds,
      }),
      target: {
        targetEdge: r.resolved.targetEdge,
        targetWinRate: r.resolved.targetWinRate,
        maxWinCap: r.resolved.maxWinCap,
        nearMissMin: r.resolved.nearMissMin,
      },
      auto_targets: {
        targetEdge: targets.targetEdge === undefined,
        targetWinRate: targets.targetWinRate === undefined,
        maxWinCap: targets.maxWinCap === undefined,
        nearMissMin: targets.nearMissMin === undefined,
      },
      ...(priceSearchMeta && {
        price_search_attempted: priceSearchMeta.attempted,
        price_search_base: priceSearchMeta.base,
        price_search_chosen: priceSearchMeta.chosen,
        price_search_candidates: priceSearchMeta.candidates,
        price_search_fell_back: priceSearchMeta.fellBackToBase,
        // Tagged-pack accuracy: null = tagged-mode not active; true/false =
        // whether the chosen candidate landed within 0.01pp of the tag.
        price_search_tagged_accuracy_hit: priceSearchMeta.taggedAccuracyHit,
      }),
      // RC1 trace: which approved-artifact guards this write passed (absent on
      // legacy calls) — lets an audit review split fingerprint-verified
      // approves from unguarded ones.
      ...((approvedPoolFingerprint !== null || approvedPriceAfter !== null) && {
        approved_artifact: {
          pool_fingerprint_verified: approvedPoolFingerprint !== null,
          price_after_verified: approvedPriceAfter !== null,
        },
      }),
      before: { edge: before.edge, winRate: before.winRate, maxWin: before.maxWin },
      after: { edge: after.edge, winRate: after.winRate, maxWin: after.maxWin },
      ...(editedLivePackUnderCapability && {
        edited_live_pack_under_capability: true,
      }),
      ...(isPackStudioRetuneOperatorNonOwner(session) && {
        via_no_2fa_allowlist: true,
      }),
    },
  });

  // Refresh the ADMIN-side risk row from the shaped pool (ADMIN write only).
  // The cap here is the RESOLVED target cap (the same cap `shapeWeights` shaped
  // against), so compliance is judged against the budget the auto-tune ran on.
  await refreshEditedPackRiskScore(
    packId,
    after,
    r.resolved.maxWinCap,
    r.resolved.intendedHitRate !== null,
  );

  reloadPacks();
  // Invalidate this pack's cached V2 plan so the next `planPackTune` reflects
  // this auto-tune instead of a 60s-stale solve. Per-pack: ONLY this pack's
  // plan is busted (never the other 182).
  revalidateTag(packRetunePlanTag(packId));
  // The persistent "Tuned: X / N" counter reads the distinct edit/retune
  // snapshot count — this write just captured one, so bust its 60s cache.
  revalidateTag("pack-studio-tuned-count");
  revalidatePath("/packs");
  revalidatePath(`/packs/${packId}`);

  return {
    packId,
    name: r.packName,
    status: "edited_and_retuned",
    cardCountBefore: r.liveCardIds.size,
    cardCountAfter: rows.length,
    priceBefore,
    priceAfter,
    before: { edge: before.edge, winRate: before.winRate, maxWin: before.maxWin },
    after: { edge: after.edge, winRate: after.winRate, maxWin: after.maxWin },
    priceSearch: priceSearchMeta,
  };
}

// ─── planPackTune — THE Retune V2 single plan entry (one brain) ─────────────
//
// ONE read-only server plan for ONE pack, live or staged: the result is the
// ONLY source of every number the V2 workspace shows AND the EXACT artifact
// the Push button writes (pinned by `approvedPriceAfter` tolerance 0 +
// `approvedPoolFingerprint`, both fail-closed server-side). Plan ≡ write is
// STRUCTURAL: both arms and both MAIN write actions construct their solver
// params through the shared `buildRetuneSearchParams`.
//
//   • Live arm (`staged` null) — absorbed the legacy single-pack planner's
//     body (fresh pack row, tag-aware auto targets, anchored shared-band search),
//     cached 60s per pack under `packRetunePlanTag(packId)` so ONE approve
//     invalidates ONE pack's plan (never the other 182 — the old global tag
//     busted the whole proposal blob).
//   • Staged arm — the READ phase of `applyStagedPackEditAndRetune` via the
//     SAME `resolveAndShapeStagedPool` pass the write runs (staged validation,
//     REAL card-value lookup, live-pool read, targets off the STAGED price,
//     `stagedCurrentWeights` anti-inflation anchor, shared-band search; when
//     `pinPrice`, the write's anchored `shapeWeights` else-branch verbatim).
//     Never cached (the staged key space is unique per call).
//
// Refusals are DATA, never throws: tag contradiction comes back as
// `tagContradiction`, solver infeasibility as `limit`, out-of-scope packs
// (inactive / price ≤ 0 / not found) as `null` — the workspace renders
// plain-words copy + a fix loop instead of an error boundary.

/**
 * Staged input for {@link planPackTune} — pool IDENTITY only. NO weights (the
 * server shapes them — hand-typed odds live in the Drafts flow), NO cosmetics
 * (color/animation ride the push payload only; they never affect the solve).
 */
export type PackTuneStagedInput = {
  cards: { cardId: string; order: number }[];
  /** Staged ticket price (USD). Omitted = live price. */
  price?: number;
  /** Escape hatch: solve odds-only AT the staged price (no price search). */
  pinPrice?: boolean;
  /**
   * Owner-pinned EXACT per-card odds ({cardId, typed percent}) — held
   * verbatim through the solve (and through the snap: pins are exempt from
   * ladder membership). The write receives the SAME pins via
   * `StagedPoolInput.pinnedOdds` and both run the shared
   * `resolveAndShapeStagedPool` pass, so preview ≡ write includes the pins.
   * A pin the pool can't honour comes back as `limit.kind =
   * "pins-infeasible"` with a computed suggestion — data, never a throw.
   */
  pinnedOdds?: RetunePinnedOdds[];
  /**
   * Owner tag override (tag control) — see {@link StagedTagOverride}. Threaded
   * verbatim to the SAME `resolveAndShapeStagedPool` pass the write runs, so
   * the staged plan the operator reviews and the write derive the intended
   * hit-rate from the SAME overridden tag (plan ≡ write). Omitted ⇒ the pack's
   * live tag is used.
   */
  tagOverride?: StagedTagOverride;
  /**
   * Owner edge-target override (wave 4, the `price-edge-exact` one-click):
   * the plan resolves `targets.targetEdge` from this fraction (0..0.9)
   * instead of the price-curve auto target. The write carries NO counterpart
   * field — it receives the frozen plan's resolved `targets.targetEdge`
   * verbatim through the `targets` argument, so plan ≡ write holds by
   * construction. Every engine law (edge floor, tag accuracy, never-inflate,
   * snap) still gates the resulting plan — an unlawful override REFUSES, it
   * never ships silently.
   */
  edgeTargetOverride?: number;
};

export type PackTunePlan = {
  packId: string;
  name: string;
  slug: string;
  arm: "live" | "staged";
  /** Wall-clock stamp of the solve (cached live plans age up to 60s). */
  computedAtIso: string;
  /**
   * `computePoolFingerprint(livePrice, livePool)` at solve time — THE write
   * pin (`approvedPoolFingerprint`), always over the LIVE pool (both writes
   * verify against live state, staged or not).
   */
  poolFingerprint: string;
  /** LIVE ticket price (USD). */
  price: number;
  /** The staged price the operator typed, or null (live arm / not staged). */
  stagedPrice: number | null;
  /** The price the write would persist (the search's pick). */
  priceAfter: number;
  /**
   * FULL after-vector in staged order (pool order on the live arm):
   * `pct` = the planned draw probability in percent; `livePct` = the card's
   * CURRENT live probability, null for a staged-in (added) card. Empty when
   * the plan is infeasible/refused (no shaped vector exists).
   */
  planned: { cardId: string; pct: number; livePct: number | null }[];
  /** Live-pool cards the staged pool removes (staged arm; empty on live). */
  removedCardIds: string[];
  /**
   * Cards the solver's max-win-cap pre-filter DROPS (value > the resolved
   * `targets.maxWinCap` — the strict engine predicate, shared via
   * `computeCapDroppedCardIds`). Populated on BOTH arms. These are true
   * REMOVALS (owner rule, 2026-07-03): the write omits their rows from the
   * `pack_cards` createMany, so pushing removes the card from the pack
   * (recoverable via the History snapshot revert). Kept SEPARATE from
   * `removedCardIds`, which means "the operator staged this card out" — a
   * cap drop is the engine's verdict over cards still IN the staged pool,
   * and merging the two would break the staged-identity round-trip
   * (`buildCardDiffRows` sources staged removals from the staged pool state,
   * and the write payload still carries the cap-dropped card's identity —
   * the omission is re-derived server-side from the re-solved weights, never
   * client-trusted). `maxWin`/tiles already reflect the drop (risk is
   * computed over positive-weight cards only). The pool fingerprint is over
   * the LIVE pool and is unaffected.
   */
  capDroppedCardIds: string[];
  /** Risk AS IT IS NOW (live pool at the live price). */
  before: PackRisk;
  /**
   * Risk after the plan. Non-null even for some staged refusals (shaping
   * succeeded but a fail-closed assert would refuse the write) so the UI can
   * show WHAT would be refused; null when shaping itself failed.
   */
  after: PackRisk | null;
  feasible: boolean;
  relaxations: ShapeWeightsRelaxation[];
  /** Structured hard limit when genuinely infeasible (else null). */
  limit: ShapeWeightsLimit | null;
  /**
   * The staged arm's tag-contradiction refusal returned as DATA (the write
   * throws this exact message) — null when no contradiction.
   */
  tagContradiction: string | null;
  /**
   * The human-readable reason a staged plan was REFUSED by a fail-closed
   * post-shape write-assert (e.g. `win-rate-miss`, `edge-above-band`,
   * `max-win-above-cap`, `edge-below-target`). These refusals carry NO
   * structured `limit` (limit stays null) and — when the refused pool is not
   * degenerate — no pool-edit guidance either, which previously left the panel
   * blank with only the rose "Infeasible" badge. Carried verbatim so the UI
   * ALWAYS renders the WHY as a guaranteed fallback banner. `null` when the
   * plan is feasible or was refused via a path that already surfaces its reason
   * (a structured `limit` or `tagContradiction`).
   */
  refusalMessage: string | null;
  /** The refusal's machine code paired with {@link refusalMessage}. `null` otherwise. */
  refusalCode:
    | "edge-below-target"
    | "edge-above-band"
    | "max-win-above-cap"
    | "win-rate-miss"
    | "tag-accuracy-miss"
    | "edge-floor"
    | "infeasible"
    | null;
  snapped: boolean | null;
  /**
   * cardIds whose planned pct is NOT clean (amber dots). UNTAGGED packs:
   * off the log clean ladder. TAGGED packs (§niceness): off the HUMAN-NICE
   * rung grid ({@link isOnNiceGridPct}) — exactly the cards the owner would
   * complain about; the engine's exempt indexes (dust buffer, owner pins,
   * forced single winner) are never flagged.
   */
  offLadderCards: string[];
  /**
   * Tagged + snapped only (§niceness): all non-exempt planned odds landed on
   * the human-nice rung grid. `false` = per-100k-exact but not pretty — the
   * plan panel renders the honesty banner (push stays enabled). `null` =
   * untagged pack, error, or unsnapped plan.
   */
  allNice: boolean | null;
  topInflationUnavoidable: boolean | null;
  intendedHitRate: number | null;
  /** RESOLVED targets — the client threads these verbatim to the write. */
  targets: {
    targetEdge: number;
    targetWinRate: number;
    maxWinCap: number;
    nearMissMin: number;
  };
  taggedAccuracyHit: boolean | null;
  searchMeta: { candidates: number; fellBackToBase: boolean } | null;
  /**
   * The owner pins this plan was solved WITH, echoed verbatim (staged arm
   * only — the live arm never carries pins). Part of the frozen artifact:
   * the client threads the SAME pins into the write, and the plan payload
   * carrying them makes the artifact self-describing for the parity harness
   * and the F9 "Copy details" dump. `null` = no pins.
   */
  pinnedOdds: RetunePinnedOdds[] | null;
  /**
   * The guidance verdict (ruleset §2) — populated for TAGGED packs when the
   * plan is infeasible, off-tag, or dirty-odds: the LAW-1 feasibility
   * interval + a RANKED list of typed, engine-proven suggestions
   * (`price-move` / `price-edge-exact` / `add-card` with a $ band /
   * `edge-bump` / `raise-cap` / `repair-monotone` / `retag` / dead-card
   * hints). ALSO populated for UNTAGGED packs whose FEASIBLE plan carries a
   * degenerate loss ladder (cards pinned at the 0.0001% quantization floor /
   * win-rate float onto a single carrier card — the owner's "Captive" case):
   * `add-card` (mid, with the spread band + fix price), `remove-dead-card`
   * per pinned card, and `accept-as-is`. `null` otherwise.
   */
  guidance: TagGuidance | null;
  /**
   * §shape-guard (owner-lens §2 / Pattern 1): the plan-vs-live ladder quality
   * of a FEASIBLE plan. `degenerate === true` when the planned ladder collapsed
   * onto one carrier / crushed healthy live cards (the owner's flagged
   * screenshot) — the plan stays feasible + pushable (it is mathematically
   * sound), but the UI demotes + badges it and leads with pool edits. `null`
   * when the plan is infeasible (no vector to score). A no-op replan scores 0.
   */
  shape: LadderShape | null;
  /**
   * §risk-leverage (owner-lens §4 / Pattern 6): the CV band this pack's retune
   * should stay inside (tag-law for lottery packs, fleet price-bracket for
   * standard, widened to the pack's live CV). A POST-CHECK — never a solver
   * constraint. `null` when the plan is infeasible (no landed CV).
   */
  riskBand: RiskBand | null;
  /**
   * TRUE when the landed `after.cv` sits OUTSIDE {@link riskBand} — the UI
   * badges a risk-delta warning (rose on a tier flip too, amber otherwise).
   * Never blocks the push: the pack's risk tier is a product decision the owner
   * makes knowingly. `false` when infeasible or in-band.
   */
  riskBandExit: boolean;
  /**
   * §pool-edits-first (owner-lens §3 / Patterns 1, 10): the PRIMARY
   * recommendation when the fixed-pool plan is DEGENERATE, INFEASIBLE, or exits
   * its risk band WITH a tier flip — a solver-verified add-card / remove-dead-
   * card / pinned-price pool edit derived from the plan's own guidance. The UI
   * leads with this and demotes the fixed-pool plan to the secondary. Advisory
   * payload only — it never changes `planned`/`priceAfter` (the write artifact
   * stays the fixed-pool plan until the owner stages the edit). `null` when the
   * plan is healthy or the guidance carries no actionable pool lever.
   */
  poolEditPlan: PoolEditPlan | null;
  /**
   * v9 (Retune V3 wave 2b): THE one-line product verdict, derived server-side
   * from the fields above ({@link buildPackTuneVerdict} — pure, so payload and
   * panel can never disagree). Ranked worst-first (refusals above quality
   * flags; typed engine verdicts `pins-infeasible` / `monotone-unreachable` /
   * `tag-unreachable` above the generic arm). Carries the LAW T `fitRange`
   * (the wave-2c retag-slider bound) and, on a pins refusal, the
   * solver-verified {@link PinRemedy} list + shortfall copy in one shape.
   */
  verdict: PackTuneVerdict;
};

/**
 * Plan ONE pack's tune (live pool, or a staged pool). Owner + Pack-Studio
 * operator gated (auth OUTSIDE the cache). READ-ONLY — writes nothing.
 * Returns `null` when the pack is out of scope (inactive / price ≤ 0 / not
 * found). `opts.fresh` bypasses the 60s live-arm cache (the manual Re-plan
 * recovery path); staged calls are always uncached.
 */
export async function planPackTune(
  packId: string,
  staged?: PackTuneStagedInput | null,
  opts?: { fresh?: boolean } | null,
): Promise<PackTunePlan | null> {
  await requireRetuneOwner();
  if (!isUuid(packId)) throw new Error("Invalid pack id");

  if (staged != null) {
    return planPackTuneStagedUncached(packId, staged);
  }
  if (opts?.fresh === true) {
    return planPackTuneLiveUncached(packId);
  }
  // Per-pack cache: keyed on the packId, tagged with the PER-PACK tag only —
  // every write site revalidates `packRetunePlanTag(id)`, so approving one
  // pack re-plans ONE pack. (The wrapper is created per call so the tag can
  // carry the dynamic packId; `unstable_cache` still dedupes by keyParts.)
  // v2: the plan shape gained `guidance` (+ tagged targets/seeds changed).
  // v3: the plan shape gained `pinnedOdds` — key bumped so persisted older
  // entries (the data cache survives deploys) can never surface a
  // shape-mismatched plan.
  // v4: the plan shape gained `allNice` (§niceness) + tagged offLadderCards
  // switched to the human-nice grid — key bumped for the same reason.
  // v5: the plan shape gained `capDroppedCardIds` (cap removals) — key bumped
  // for the same reason.
  // v6: the plan shape gained `shape` (§shape-guard) + the default price budget
  // changed to ±10% (targets are now live-anchored) — persisted v5 entries must
  // never surface.
  // v7: the plan shape gained `riskBand` + `riskBandExit` (§risk-leverage) —
  // key bumped for the same reason.
  // v8: the plan shape gained `poolEditPlan` (§pool-edits-first) + a
  // §1.4 wide-probe `price-move` suggestion may now ride the guidance — key
  // bumped so persisted v7 entries never surface.
  // v9: the plan shape gained `verdict` (Retune V3 wave 2b: the verdict-first
  // server contract — LAW T `fitRange` + pin remedies ride the plan) — key
  // bumped so persisted v8 entries never surface.
  return unstable_cache(
    () => planPackTuneLiveUncached(packId),
    ["pack-studio.retune.plan-pack.v9", packId],
    { revalidate: 60, tags: [packRetunePlanTag(packId)] },
  )();
}

/**
 * Shared per-card projection: weights vector → planned rows + off-ladder ids.
 * `tagged` switches the "clean" definition: an UNTAGGED pack is clean on the
 * log-ladder rungs ({@link isOnCleanLadderPct}); a TAGGED pack is clean on
 * the HUMAN-NICE rung grid ({@link isOnNiceGridPct} — §niceness: 0.05% /
 * 0.25% / 0.35% / 2.5% …, what the OWNER reads as clean; the previous
 * per-100k-integer definition let 0.047% pass as "clean"). The engine's
 * `niceExemptIdx` (dust buffer, pins, forced single winner) is threaded in so
 * the projection and the engine's `allNice` can never disagree.
 */
function projectPlannedVector(
  cardIds: string[],
  weights: number[],
  livePctByCardId: Map<string, number>,
  tagged: boolean,
  /**
   * Owner-pinned cardIds — EXEMPT from the off-ladder flag: a pin is an
   * owner-chosen number, not a dirty residual (its row renders a pin chip,
   * never the amber dot, and it must not count toward the dirty-odds banner).
   */
  pinnedCardIds?: ReadonlySet<string>,
  /**
   * The engine's niceness-exempt indexes (into `weights`/`cardIds` order) —
   * dust buffer / pins / forced single winner. Never pushed into
   * `offLadderCards`. Only set for tagged snapped plans.
   */
  niceExemptIdx?: readonly number[],
): {
  planned: PackTunePlan["planned"];
  offLadderCards: string[];
} {
  let total = 0;
  for (const w of weights) {
    if (Number.isFinite(w) && w > 0) total += w;
  }
  const planned = cardIds.map((cardId, i) => {
    const w = weights[i] ?? 0;
    return {
      cardId,
      pct: total > 0 && w > 0 ? (w / total) * 100 : 0,
      livePct: livePctByCardId.get(cardId) ?? null,
    };
  });
  const cleanPct = tagged ? isOnNiceGridPct : isOnCleanLadderPct;
  const exemptIdx = new Set(niceExemptIdx ?? []);
  const offLadderCards = planned
    .filter(
      (row, i) =>
        row.pct > 0 &&
        !cleanPct(row.pct) &&
        !exemptIdx.has(i) &&
        !(pinnedCardIds?.has(row.cardId) ?? false),
    )
    .map((row) => row.cardId);
  return { planned, offLadderCards };
}

/**
 * §1.4 wide-probe: merge a beyond-budget `price-move` suggestion into a plan's
 * guidance. When the plan already has guidance, prepend the suggestion (it is
 * rank-0 by construction) unless an EQUAL price-move is already present (dedupe
 * within 1¢ — the guidance's own price-move stays, the probe's is redundant).
 * When guidance is null, wrap the suggestion in a passthrough `TagGuidance`
 * with a `direction: "ok"` feasibility stub (the probe found a solvable far
 * price; the default plan's own feasibility is carried elsewhere).
 */
function mergeWideProbeSuggestion(
  guidance: TagGuidance | null,
  suggestion: TuneSuggestion | null,
): TagGuidance | null {
  if (suggestion === null) return guidance;
  if (guidance === null) {
    return {
      feasibility: {
        evTarget: 0,
        evMin: 0,
        evMax: 0,
        feasible: true,
        saturated: false,
        direction: "ok",
        components: { winEvMin: 0, winEvMax: 0, nmMass: 0, dustMass: 0, capSum: 0 },
      },
      suggestions: [suggestion],
    };
  }
  const probePrice = Number(suggestion.params.price);
  const dupe = guidance.suggestions.some(
    (s) =>
      (s.kind === "price-move" || s.kind === "price-edge-exact") &&
      Math.abs(Number(s.params.price) - probePrice) <= 0.01 + 1e-9,
  );
  if (dupe) return guidance;
  return { ...guidance, suggestions: [suggestion, ...guidance.suggestions] };
}

/** Live-pool probabilities in percent, keyed by cardId (null-safe totals). */
function livePctMap(
  pool: readonly { cardId: string; weight: number }[],
): Map<string, number> {
  let total = 0;
  for (const c of pool) {
    if (Number.isFinite(c.weight) && c.weight > 0) total += c.weight;
  }
  const out = new Map<string, number>();
  for (const c of pool) {
    out.set(c.cardId, total > 0 && c.weight > 0 ? (c.weight / total) * 100 : 0);
  }
  return out;
}

/** One-pack pool read row (pack_cards ⋈ cards; Decimals cast to text). */
type BatchedPoolRow = {
  pack_id: string;
  card_id: string;
  value: string | null;
  weight: number;
  name: string;
  image_url: string;
};

/**
 * The LIVE arm — the legacy single-pack planner's read/solve body (fresh
 * identity + scope from the composition view, one-pack batched pool read,
 * tag-aware auto targets) with the solve routed through the shared
 * `buildRetuneSearchParams` and the result mapped to {@link PackTunePlan}.
 * NOT gated (the public `planPackTune` gates before dispatch); NOT exported.
 */
async function planPackTuneLiveUncached(
  packId: string,
): Promise<PackTunePlan | null> {
  const cfg: ResolvedAutoTargetCfg = {
    globalCap: await readMaxWinCap(),
    maxMultCeiling: await readMaxMultCeiling(),
    edgeCurve: await readEdgeCurveConfig(),
  };
  // The DEFAULT retune price budget (±10% unless configured). Resolved ONCE
  // here and threaded to the shared builder so plan ≡ write (the tolerance-0
  // approvedPriceAfter pin depends on the same band on both sides).
  // `readPackSystemConfig` is request-cached, so this is a free re-read.
  const priceBudgetPct = await readRetunePriceBudgetPct();

  // Fresh identity + scope from the same composition view the legacy sweep
  // uses, so the scope predicate stays in lockstep.
  const comps = await getPacksPoolComposition({ packIds: [packId] });
  const p = comps[0];
  if (!p || !p.active || !(p.price > 0)) return null;

  // One-pack pool read (same composite-index probe as the legacy single arm).
  const db = await getDb();
  const rows = await db.$queryRawUnsafe<BatchedPoolRow[]>(
    `
      SELECT
        pc.pack_id      AS pack_id,
        pc.card_id      AS card_id,
        c.price::text   AS value,
        pc.weight       AS weight,
        c.name          AS name,
        c.image_url     AS image_url
      FROM pack_cards pc
      JOIN cards c ON c.id = pc.card_id
      WHERE pc.pack_id = $1::uuid
      ORDER BY pc.order ASC
    `,
    packId,
  );
  const cards = rows.map((r) => ({
    cardId: r.card_id,
    value: Number(r.value ?? 0),
    weight: Number(r.weight),
  }));

  const poolFingerprint = computePoolFingerprint(p.price, cards);
  const before = computePackRisk({
    cards: cards.map((c) => ({ value: c.value, weight: c.weight })),
    price: p.price,
  });
  // Pool-aware curve input: the pool is fully known on the live arm, so the
  // edge premium prices the ACTUAL top card, not the loosened theoretical cap
  // (no phantom premium — ruleset §1.2 edge-target rule).
  const poolTopValue = cards.reduce((m, c) => (c.value > m ? c.value : m), 0);
  const autoTargets = autoRetuneTargets(
    p.price,
    cfg,
    resolveIntendedHitRate(p.name, p.tags) ?? undefined,
    poolTopValue,
    // LIVE-ANCHORED targets (owner-lens 2026-07-03): an UNTAGGED pack targets
    // its OWN live win-rate/near-miss (not the flat 20% recipe), the retune
    // never refunds an above-target live edge, and a live over-cap card is
    // grandfathered. TAGGED packs are unaffected (tag stays exact). Passed on
    // the PLAN path → the write inherits these via the frozen `plan.targets`.
    {
      winRate: before.winRate,
      nearMiss: before.nearMiss,
      edge: before.edge,
      topValue: poolTopValue,
    },
  );
  // TAGGED near-miss seed (ruleset §1.2): zero floor — binary lottery — but a
  // live pool that genuinely carries near-miss mass keeps its designed band.
  const nearMissMin =
    autoTargets.intendedHitRate !== null
      ? Math.max(TAGGED_NEAR_MISS_MIN, before.nearMiss)
      : autoTargets.nearMissMin;
  const computedAtIso = new Date().toISOString();
  const targets = {
    targetEdge: autoTargets.targetEdge,
    targetWinRate: autoTargets.targetWinRate,
    maxWinCap: autoTargets.maxWinCap,
    nearMissMin,
  };
  const tagged =
    autoTargets.intendedHitRate !== null &&
    Math.abs(autoTargets.intendedHitRate - autoTargets.targetWinRate) < 1e-9;
  const base = {
    packId: p.id,
    name: p.name,
    slug: p.slug,
    arm: "live" as const,
    computedAtIso,
    poolFingerprint,
    price: p.price,
    stagedPrice: null,
    removedCardIds: [] as string[],
    // Cap removals (both arms): the strict engine predicate over the SOLVE
    // pool — the write omits exactly these rows (weight 0 by construction).
    capDroppedCardIds: computeCapDroppedCardIds(cards, targets.maxWinCap),
    before,
    tagContradiction: null,
    // The live arm surfaces infeasibility via a structured `limit` (never a
    // post-shape write-assert), so it never carries a refusal message.
    refusalMessage: null,
    refusalCode: null,
    intendedHitRate: autoTargets.intendedHitRate,
    targets,
    // The live arm never carries owner pins (pins are staged edits by
    // construction — any pin flips the workspace to the staged arm).
    pinnedOdds: null,
  };

  if (cards.length === 0) {
    const emptyLimit: ShapeWeightsLimit = {
      kind: "empty-pool",
      detail:
        "This pack has no cards in its pool, so there is nothing to retune.",
      suggestion: "Add cards to the pack in the Builder before retuning it.",
    };
    return {
      ...base,
      priceAfter: p.price,
      planned: [],
      after: null,
      feasible: false,
      relaxations: [],
      limit: emptyLimit,
      snapped: null,
      offLadderCards: [],
      allNice: null,
      topInflationUnavoidable: null,
      taggedAccuracyHit: null,
      searchMeta: null,
      guidance: null,
      shape: null,
      riskBand: null,
      riskBandExit: false,
      poolEditPlan: null,
      verdict: buildPackTuneVerdict({
        feasible: false,
        limit: emptyLimit,
        tagContradiction: null,
        refusalMessage: null,
        refusalCode: null,
        tagged,
        taggedAccuracyHit: null,
        snapped: null,
        allNice: null,
        shapeDegenerate: null,
        guidance: null,
        price: p.price,
        targetEdge: autoTargets.targetEdge,
      }),
    };
  }

  // params come from buildRetuneSearchParams — the tolerance-0
  // approvedPriceAfter pin depends on all four sites sharing it.
  const search = searchBestPriceForCleanSnap(
    buildRetuneSearchParams("live", {
      cards: cards.map((c) => ({ value: c.value })),
      basePrice: p.price,
      targetEdge: autoTargets.targetEdge,
      targetWinRate: autoTargets.targetWinRate,
      maxWinCap: autoTargets.maxWinCap,
      nearMissMin,
      // The solver's default win-rate tolerance, pinned explicitly so the
      // plan's params deep-equal the write's (`applyPackRetune` sends 0.02).
      // (For a TAGGED pack the shared builder tightens this to the strict
      // 0.01pp solver tolerance — LAW 15 — on plan AND write alike.)
      winRateTol: 0.02,
      // Anti-inflation anchor: no win/grail card's odds may exceed its
      // current odds (the jackpot stays rare; raising the edge only trims
      // the expensive tail).
      currentWeights: cards.map((c) => c.weight),
      intendedHitRate: autoTargets.intendedHitRate,
      priceBudgetPct,
    }),
  );
  const shaped = search.bestResult;
  const searchMeta = {
    candidates: search.searched,
    fellBackToBase: search.fellBackToBase,
  };

  // Tag guidance (ruleset §2): whenever a TAGGED plan fails, misses the tag,
  // or ships dirty odds, compute the LAW-1 feasibility verdict + the ranked,
  // engine-proven fix list — no tagged pack is ever told "infeasible" without
  // a concrete suggestion.
  const guidanceFor = (needed: boolean): TagGuidance | null =>
    tagged && needed
      ? computeTagGuidance({
          cards: cards.map((c) => ({ value: c.value })),
          currentWeights: cards.map((c) => c.weight),
          cardIds: cards.map((c) => c.cardId),
          price: p.price,
          targetEdge: autoTargets.targetEdge,
          tag: autoTargets.targetWinRate,
          nearMissMin,
          maxWinCap: autoTargets.maxWinCap,
          cfg: {
            globalCap: cfg.globalCap,
            maxMultCeiling: cfg.maxMultCeiling,
            ...(cfg.edgeCurve ? { edgeCurve: cfg.edgeCurve } : {}),
          },
          liveWinRate: before.winRate,
          liveNearMiss: before.nearMiss,
        })
      : null;

  // ── §1.4 WIDE-PRICE PROBE ────────────────────────────────────────────────
  // The DEFAULT plan is constrained to ±priceBudgetPct; the full ±60% band
  // survives only as a bounded SUGGESTION. When the in-budget plan is NOT
  // materially clean, run ONE ±60% probe solve — if it crosses a quality rung
  // (infeasible→feasible / tag miss→hit / unsnapped→snapped / off-nice→
  // all-nice / degenerate→healthy), emit a ranked, beyond-budget `price-move`
  // suggestion carrying the exact far price (NEVER auto-applied). The live arm
  // is cached 60s so probing on every not-clean state is cheap.
  const defaultFeasible = !("error" in shaped);
  // Default plan's shape (computed inline — the feasible-path `shape` var below
  // is derived the same way; this keeps the probe self-contained).
  let defaultShapeDegenerate: boolean | null = null;
  if (defaultFeasible) {
    const dt = shaped.weights.reduce(
      (a, w) => a + (Number.isFinite(w) && w > 0 ? w : 0),
      0,
    );
    defaultShapeDegenerate =
      dt > 0
        ? ladderShape(
            cards.map((c) => c.value),
            cards.map((c) => (livePctMap(cards).get(c.cardId) ?? 0) / 100),
            shaped.weights.map((w) =>
              Number.isFinite(w) && w > 0 ? w / dt : 0,
            ),
            search.bestPrice,
          ).degenerate
        : null;
  }
  const defaultNotMateriallyClean = defaultFeasible
    ? tagged
      ? search.taggedAccuracyHit === false ||
        shaped.snapped !== true ||
        shaped.allNice === false ||
        defaultShapeDegenerate === true
      : shaped.snapped !== true || defaultShapeDegenerate === true
    : true; // infeasible default → always probe
  let wideProbeSuggestion: TuneSuggestion | null = null;
  if (defaultNotMateriallyClean && priceBudgetPct < RETUNE_MAX_PRICE_CHANGE_PCT) {
    const wideSearch = searchBestPriceForCleanSnap({
      ...buildRetuneSearchParams("live", {
        cards: cards.map((c) => ({ value: c.value })),
        basePrice: p.price,
        targetEdge: autoTargets.targetEdge,
        targetWinRate: autoTargets.targetWinRate,
        maxWinCap: autoTargets.maxWinCap,
        nearMissMin,
        winRateTol: 0.02,
        currentWeights: cards.map((c) => c.weight),
        intendedHitRate: autoTargets.intendedHitRate,
        priceBudgetPct,
      }),
      // Spread-override the band to the full ±60% SUGGESTION band — the probe
      // is NOT a plan and never becomes the write artifact.
      maxPriceChangePct: RETUNE_MAX_PRICE_CHANGE_PCT,
    });
    const wideShaped = wideSearch.bestResult;
    let wideShapeDegenerate: boolean | null = null;
    let wideEdge = 0;
    let wideWinRate = 0;
    if (!("error" in wideShaped)) {
      wideEdge = wideShaped.risk.edge;
      wideWinRate = wideShaped.risk.winRate;
      const wt = wideShaped.weights.reduce(
        (a, w) => a + (Number.isFinite(w) && w > 0 ? w : 0),
        0,
      );
      wideShapeDegenerate =
        wt > 0
          ? ladderShape(
              cards.map((c) => c.value),
              cards.map((c) => (livePctMap(cards).get(c.cardId) ?? 0) / 100),
              wideShaped.weights.map((w) =>
                Number.isFinite(w) && w > 0 ? w / wt : 0,
              ),
              wideSearch.bestPrice,
            ).degenerate
          : null;
    }
    wideProbeSuggestion = buildWidePriceProbeSuggestion({
      livePrice: p.price,
      tagged,
      tag: autoTargets.targetWinRate,
      def: {
        feasible: defaultFeasible,
        price: search.bestPrice,
        allNice: defaultFeasible ? (shaped.allNice ?? null) : null,
        snapped: defaultFeasible ? (shaped.snapped ?? false) : null,
        taggedAccuracyHit: search.taggedAccuracyHit,
        shapeDegenerate: defaultShapeDegenerate,
      },
      wide: {
        feasible: !("error" in wideShaped),
        price: wideSearch.bestPrice,
        allNice: !("error" in wideShaped) ? (wideShaped.allNice ?? null) : null,
        snapped: !("error" in wideShaped) ? (wideShaped.snapped ?? false) : null,
        taggedAccuracyHit: wideSearch.taggedAccuracyHit,
        shapeDegenerate: wideShapeDegenerate,
      },
      wideEdge,
      wideWinRate,
    });
  }

  if ("error" in shaped) {
    // §3 pool-edits-first: an INFEASIBLE default leads with the solver-verified
    // pool edit (add/remove card) that makes a clean solve exist.
    const infeasibleGuidance = mergeWideProbeSuggestion(
      guidanceFor(true),
      wideProbeSuggestion,
    );
    return {
      ...base,
      priceAfter: p.price,
      planned: [],
      after: null,
      feasible: false,
      relaxations: [],
      limit: shaped.limit,
      snapped: null,
      offLadderCards: [],
      allNice: null,
      topInflationUnavoidable: null,
      taggedAccuracyHit: search.taggedAccuracyHit,
      searchMeta,
      guidance: infeasibleGuidance,
      shape: null,
      riskBand: null,
      riskBandExit: false,
      poolEditPlan: derivePoolEditPlan(
        infeasibleGuidance,
        "infeasible",
        p.price,
        priceBudgetPct,
      ),
      // The live arm never carries pins, so a live `pins-infeasible` cannot
      // occur and no remedies are computed here.
      verdict: buildPackTuneVerdict({
        feasible: false,
        limit: shaped.limit,
        tagContradiction: null,
        refusalMessage: null,
        refusalCode: null,
        tagged,
        taggedAccuracyHit: search.taggedAccuracyHit,
        snapped: null,
        allNice: null,
        shapeDegenerate: null,
        guidance: infeasibleGuidance,
        price: p.price,
        targetEdge: autoTargets.targetEdge,
      }),
    };
  }

  const { planned, offLadderCards } = projectPlannedVector(
    cards.map((c) => c.cardId),
    shaped.weights,
    livePctMap(cards),
    tagged,
    undefined,
    shaped.niceExemptIdx,
  );

  // UNTAGGED degenerate-loss-ladder guidance (the owner's "Captive" case):
  // a FEASIBLE untagged plan whose loss mass collapsed onto one carrier card
  // (floor-pinned cards / forced loss average / win-rate float) gets the
  // ranked add-mid-card / remove-dead-cards / accept-as-is verdict. Returns
  // null for healthy plans — most packs pay nothing here.
  let untaggedGuidance: TagGuidance | null = null;
  if (!tagged) {
    const shapedTotal = shaped.weights.reduce(
      (a, w) => a + (Number.isFinite(w) && w > 0 ? w : 0),
      0,
    );
    untaggedGuidance =
      shapedTotal > 0
        ? computeUntaggedGuidance({
            cards: cards.map((c) => ({ value: c.value })),
            currentWeights: cards.map((c) => c.weight),
            cardIds: cards.map((c) => c.cardId),
            livePrice: p.price,
            price: search.bestPrice,
            targetEdge: autoTargets.targetEdge,
            targetWinRate: autoTargets.targetWinRate,
            nearMissMin,
            maxWinCap: autoTargets.maxWinCap,
            plannedShares: shaped.weights.map((w) =>
              Number.isFinite(w) && w > 0 ? w / shapedTotal : 0,
            ),
            relaxations: shaped.relaxations,
            // owner-lens §2.3: feed the shape guard's verdict as a NEW detection
            // trigger so complaint (B) "Tails?" (which the three legacy
            // signatures miss) gets the pool-edit guidance — and so the
            // accept-as-is copy shares the degenerate verdict (Pattern 9c).
            shapeDegenerate: defaultShapeDegenerate === true,
          })
        : null;
  }

  // §shape-guard: score the FEASIBLE plan's ladder against the live pool. Live
  // shares from the live pool (`livePctMap` is in percent → fractions); planned
  // shares from the shaped weights. Pure post-check — never a solver input.
  const shapeTotal = shaped.weights.reduce(
    (a, w) => a + (Number.isFinite(w) && w > 0 ? w : 0),
    0,
  );
  const livePcts = livePctMap(cards);
  const shape: LadderShape | null =
    shapeTotal > 0
      ? ladderShape(
          cards.map((c) => c.value),
          cards.map((c) => (livePcts.get(c.cardId) ?? 0) / 100),
          shaped.weights.map((w) =>
            Number.isFinite(w) && w > 0 ? w / shapeTotal : 0,
          ),
          search.bestPrice,
          cards.map((c) => c.cardId),
        )
      : null;

  // §risk-leverage: the CV band this pack should stay inside (widened to its
  // live CV), and whether the landed CV exits it. Pure post-check.
  const riskBand = packRiskBand({
    tag: autoTargets.intendedHitRate,
    price: p.price,
    liveCv: before.cv,
  });
  const riskBandExit = isRiskBandExit(shaped.risk.cv, riskBand);
  const tierFlip = shaped.risk.tier !== before.tier;

  // §niceness: a pinned-but-valid plan (exact grid, not pretty) gets the ranked
  // fixes too. §1.4: a materially-better beyond-budget far price rides as a
  // ranked `price-move` SUGGESTION on top (never auto-applied). Pattern 9h: drop
  // any price suggestion equal to the plan's OWN landed price (a no-op "move").
  const feasibleGuidance = pruneNoOpSuggestions(
    mergeWideProbeSuggestion(
      tagged
        ? guidanceFor(
            shaped.snapped !== true ||
              search.taggedAccuracyHit === false ||
              shaped.allNice === false,
          )
        : untaggedGuidance,
      wideProbeSuggestion,
    ),
    search.bestPrice,
  );

  // §3 pool-edits-first: a FEASIBLE-but-degenerate plan (or one that exits its
  // risk band WITH a tier flip) leads with the solver-verified pool edit; the
  // fixed-pool plan becomes the explicit secondary. Advisory only — the write
  // artifact stays the fixed-pool plan until the owner stages the edit.
  const poolEditReason =
    shape?.degenerate === true
      ? ("degenerate-shape" as const)
      : riskBandExit && tierFlip
        ? ("risk-band-exit" as const)
        : // Pattern 10: a feasible-but-dirty plan that fell back after the full
          // sweep is a dead end — no clean value exists in-band. Lead with the
          // pool edit that makes one exist, never "nudge the price".
          shaped.snapped !== true && searchMeta.fellBackToBase
          ? ("dirty-dead-end" as const)
          : null;
  const poolEditPlan =
    poolEditReason !== null
      ? derivePoolEditPlan(
          feasibleGuidance,
          poolEditReason,
          p.price,
          priceBudgetPct,
        )
      : null;

  return {
    ...base,
    priceAfter: search.bestPrice,
    planned,
    after: shaped.risk,
    feasible: true,
    relaxations: shaped.relaxations,
    limit: null,
    snapped: shaped.snapped ?? false,
    offLadderCards,
    allNice: shaped.allNice ?? null,
    topInflationUnavoidable: shaped.topInflationUnavoidable ?? false,
    taggedAccuracyHit: search.taggedAccuracyHit,
    searchMeta,
    guidance: feasibleGuidance,
    shape,
    riskBand,
    riskBandExit,
    poolEditPlan,
    verdict: buildPackTuneVerdict({
      feasible: true,
      limit: null,
      tagContradiction: null,
      refusalMessage: null,
      refusalCode: null,
      tagged,
      taggedAccuracyHit: search.taggedAccuracyHit,
      snapped: shaped.snapped ?? false,
      allNice: shaped.allNice ?? null,
      shapeDegenerate: shape?.degenerate ?? null,
      guidance: feasibleGuidance,
      price: p.price,
      targetEdge: autoTargets.targetEdge,
    }),
  };
}

/**
 * The STAGED arm — the write's read/solve phase via the SAME
 * `resolveAndShapeStagedPool` pass `applyStagedPackEditAndRetune` runs, with
 * its solve already routed through the shared `buildRetuneSearchParams` (or,
 * when `pinPrice`, the write's anchored `shapeWeights` else-branch verbatim).
 * NOT gated (the public `planPackTune` gates before dispatch); NOT exported.
 * NO payload fat: no card names/images/currentWeights — the client already
 * holds the pool from `getPackEditPool`.
 */
async function planPackTuneStagedUncached(
  packId: string,
  staged: PackTuneStagedInput,
): Promise<PackTunePlan | null> {
  // Scope probe (indexed PK read): a plan for an inactive / unpriced /
  // deleted pack is out of scope — return null (data, not a throw) so the
  // workspace renders the neutral out-of-scope state. Also carries the slug
  // the resolver doesn't read.
  const db = await getDb();
  const pack = await db.packs.findUnique({
    where: { id: packId },
    select: { slug: true, active: true, price: true },
  });
  if (!pack || !pack.active || !(Number(pack.price.toString()) > 0)) {
    return null;
  }

  // Structural validation of the edge-target override (fail-closed, mirrors
  // the resolver's own input checks): a fraction strictly inside (0, 0.9).
  if (
    staged.edgeTargetOverride !== undefined &&
    !(
      Number.isFinite(staged.edgeTargetOverride) &&
      staged.edgeTargetOverride > 0 &&
      staged.edgeTargetOverride < 0.9
    )
  ) {
    throw new Error(
      "Refused: the edge-target override must be a fraction between 0 and 0.9.",
    );
  }

  const input: StagedPoolInput = {
    cards: staged.cards.map((c) => ({ cardId: c.cardId, order: c.order })),
    ...(staged.price !== undefined ? { price: staged.price } : {}),
    // Owner pins ride the SAME resolver input shape the write receives.
    ...(staged.pinnedOdds !== undefined && staged.pinnedOdds.length > 0
      ? { pinnedOdds: staged.pinnedOdds }
      : {}),
    // Owner tag override rides the SAME resolver input the write receives, so
    // the plan resolves its intended hit-rate from the overridden tag exactly
    // as the write will (plan ≡ write).
    ...(staged.tagOverride !== undefined
      ? { tagOverride: staged.tagOverride }
      : {}),
  };
  const r = await resolveAndShapeStagedPool(packId, input, {
    // Price search is ALWAYS ON (owner directive: price is a free lever);
    // `pinPrice` is the rare odds-only escape hatch — the write's anchored
    // no-search branch.
    allowPriceSearch: staged.pinPrice !== true,
    // Owner edge-target override (`price-edge-exact` one-click): resolved
    // targets carry it, the frozen plan freezes it, the write inherits it.
    ...(staged.edgeTargetOverride !== undefined
      ? { targetEdge: staged.edgeTargetOverride }
      : {}),
  });
  const outcome = r.outcome;

  // THE write pin: always the LIVE pool at the LIVE price — both writes
  // verify their `approvedPoolFingerprint` against live state.
  const poolFingerprint = computePoolFingerprint(r.priceBefore, r.livePool);
  const livePcts = livePctMap(r.livePool);
  const stagedIds = new Set(input.cards.map((c) => c.cardId));
  const removedCardIds = r.livePool
    .filter((c) => !stagedIds.has(c.cardId))
    .map((c) => c.cardId);

  const taggedStaged =
    r.resolved.intendedHitRate !== null &&
    Math.abs(r.resolved.intendedHitRate - r.resolved.targetWinRate) < 1e-9;

  const { planned, offLadderCards } = outcome.ok
    ? projectPlannedVector(
        input.cards.map((c) => c.cardId),
        outcome.weights,
        livePcts,
        taggedStaged,
        // Pinned rows are exempt from the off-ladder flag (owner numbers).
        input.pinnedOdds !== undefined
          ? new Set(input.pinnedOdds.map((p) => p.cardId))
          : undefined,
        outcome.niceExemptIdx ?? undefined,
      )
    : { planned: [], offLadderCards: [] };

  // Tag guidance for the STAGED pool: same trigger as the live arm (failed /
  // off-tag / dirty), computed over the staged identities at the staged price
  // with the live-weight anchor (added cards ride a 0 → uncapped, LAW 6).
  const stagedNeedsGuidance =
    !outcome.ok ||
    outcome.snapped !== true ||
    r.priceSearch?.taggedAccuracyHit === false ||
    // §niceness: exact-but-not-pretty plans get the ranked fixes too.
    outcome.allNice === false;
  let guidance: TagGuidance | null = null;
  const isTagContradiction = !outcome.ok && outcome.code === "tag-contradiction";
  // §shape-guard: score the FEASIBLE staged plan against the live pool (computed
  // HERE, before the guidance, so its verdict can feed the untagged guidance as
  // a §2.3 detection trigger for complaint B + the Pattern 9c accept-as-is copy).
  // The `planned` rows already carry per-card pct + livePct (null for a staged-in
  // card → live share 0), aligned to the staged pool order — exactly the shape
  // inputs. Values come from the resolved card meta.
  const stagedShape: LadderShape | null =
    outcome.ok && planned.length > 0
      ? ladderShape(
          input.cards.map((c) => r.cardMetaById.get(c.cardId)?.value ?? 0),
          planned.map((row) => (row.livePct ?? 0) / 100),
          planned.map((row) => row.pct / 100),
          r.priceAfter,
          planned.map((row) => row.cardId),
        )
      : null;
  const stagedShapeDegenerate: boolean = stagedShape?.degenerate === true;
  // UNTAGGED guidance runs on the FEASIBLE arm (degenerate-loss-ladder fix
  // loop) AND on a REFUSED arm whose shaping still produced a vector (the
  // post-shape write-assert refusals — `win-rate-miss`, `edge-above-band`,
  // etc. — carry `outcome.weights`). Surfacing guidance on the refused arm
  // yields the solver-verified pool-edit suggestion WITHOUT flipping the plan
  // to feasible (`feasible` stays `outcome.ok === false`; Push stays blocked).
  // The shaping-error `infeasible` refusal carries no vector (weights null) →
  // guidance stays null and the refusalMessage fallback banner covers the WHY.
  const liveWeightByCardId = new Map<string, number>();
  for (const c of r.livePool) liveWeightByCardId.set(c.cardId, c.weight);
  // Owner pins mapped to the SAME index space the staged solve used — shared
  // by the tagged guidance model and the pins-infeasible remedy probe below.
  const stagedPinnedShares =
    input.pinnedOdds !== undefined && input.pinnedOdds.length > 0
      ? mapPinnedOddsToShares(
          input.cards.map((c) => ({
            value: r.cardMetaById.get(c.cardId)?.value ?? 0,
            cardId: c.cardId,
          })),
          input.pinnedOdds,
        )
      : null;
  const stagedGuidanceWeights: number[] | null = outcome.ok
    ? outcome.weights
    : outcome.weights;
  if (!taggedStaged && stagedGuidanceWeights !== null) {
    const stagedTotal = stagedGuidanceWeights.reduce(
      (a, w) => a + (Number.isFinite(w) && w > 0 ? w : 0),
      0,
    );
    guidance =
      stagedTotal > 0
        ? computeUntaggedGuidance({
            cards: input.cards.map((c) => ({
              value: r.cardMetaById.get(c.cardId)?.value ?? 0,
            })),
            currentWeights: input.cards.map(
              (c) => liveWeightByCardId.get(c.cardId) ?? 0,
            ),
            cardIds: input.cards.map((c) => c.cardId),
            livePrice: r.priceBefore,
            price: r.priceAfter,
            targetEdge: r.resolved.targetEdge,
            targetWinRate: r.resolved.targetWinRate,
            nearMissMin: r.resolved.nearMissMin,
            maxWinCap: r.resolved.maxWinCap,
            plannedShares: stagedGuidanceWeights.map((w) =>
              Number.isFinite(w) && w > 0 ? w / stagedTotal : 0,
            ),
            // Owner pins — the SAME index mapping the staged solve uses (the
            // tagged branch below threads them since the Bidoof fix; an
            // untagged pinned pool needs the same treatment or its fixes are
            // modeled against a constraint set the solve doesn't run).
            ...(stagedPinnedShares !== null
              ? { pinnedShares: stagedPinnedShares }
              : {}),
            // A refused arm ran no relaxations (there is no accepted plan).
            relaxations: outcome.ok ? outcome.relaxations : [],
            pinPrice: staged.pinPrice === true,
            shapeDegenerate: stagedShapeDegenerate,
          })
        : null;
  } else if (taggedStaged && stagedNeedsGuidance && !isTagContradiction) {
    guidance = computeTagGuidance({
      cards: input.cards.map((c) => ({
        value: r.cardMetaById.get(c.cardId)?.value ?? 0,
      })),
      currentWeights: input.cards.map(
        (c) => liveWeightByCardId.get(c.cardId) ?? 0,
      ),
      cardIds: input.cards.map((c) => c.cardId),
      // Owner pins — the SAME index mapping the staged solve uses, so the
      // guidance models the constraint set the solve actually enforces (a
      // live-odds model emits "solver-verified" fixes the pinned solve then
      // refuses — the owner's stuck "1% Bidoof" incident).
      ...(stagedPinnedShares !== null
        ? { pinnedShares: stagedPinnedShares }
        : {}),
      price: r.priceStaged,
      targetEdge: r.resolved.targetEdge,
      tag: r.resolved.targetWinRate,
      nearMissMin: r.resolved.nearMissMin,
      maxWinCap: r.resolved.maxWinCap,
      cfg: {
        globalCap: await readMaxWinCap(),
        maxMultCeiling: await readMaxMultCeiling(),
        edgeCurve: await readEdgeCurveConfig(),
      },
      pinPrice: staged.pinPrice === true,
      liveWinRate: r.before.winRate,
      liveNearMiss: r.before.nearMiss,
    });
  }
  // ── §1.4 WIDE-PRICE PROBE (staged-arm parity) ────────────────────────────
  // The LIVE arm has probed the full ±60% suggestion band since wave 4
  // whenever its in-budget default is not materially clean; the STAGED arm —
  // the owner's primary iteration surface — never did, so the moment ANY edit
  // was staged (pool change, pin, price) the "move the price to $X → fully
  // clean" suggestion vanished from the guidance. Same gate as live (tagged:
  // accuracy/snap/nice/degenerate; untagged: snap/degenerate; a refused solve
  // always probes), same one-probe budget, same crossing detector, merged
  // BEFORE the no-op prune so the verdict + pool-edit derivation see it —
  // mirroring the live arm's ordering exactly. Deliberately NOT gated on
  // `pinPrice`: the probe is a SUGGESTION (never auto-applied), and an owner
  // whose pinned price is not clean is precisely who needs the far clean
  // price surfaced; applying it re-pins at the suggested cent, which the
  // builder-routed anchored solve above re-verifies fail-closed.
  const stagedProbeBudgetPct = await readRetunePriceBudgetPct();
  const stagedNotMateriallyClean = outcome.ok
    ? taggedStaged
      ? r.priceSearch?.taggedAccuracyHit === false ||
        outcome.snapped !== true ||
        outcome.allNice === false ||
        stagedShapeDegenerate === true
      : outcome.snapped !== true || stagedShapeDegenerate === true
    : true; // refused staged solve → always probe
  let stagedWideProbeSuggestion: TuneSuggestion | null = null;
  if (
    stagedNotMateriallyClean &&
    stagedProbeBudgetPct < RETUNE_MAX_PRICE_CHANGE_PCT
  ) {
    const stagedValuesForProbe = input.cards.map(
      (c) => r.cardMetaById.get(c.cardId)?.value ?? 0,
    );
    const wideSearch = searchBestPriceForCleanSnap({
      ...buildRetuneSearchParams("staged", {
        cards: input.cards.map((c) => ({
          cardId: c.cardId,
          value: r.cardMetaById.get(c.cardId)?.value ?? 0,
        })),
        basePrice: r.priceStaged,
        targetEdge: r.resolved.targetEdge,
        targetWinRate: r.resolved.targetWinRate,
        maxWinCap: r.resolved.maxWinCap,
        nearMissMin: r.resolved.nearMissMin,
        winRateTol: 0.02,
        currentWeights: input.cards.map(
          (c) => liveWeightByCardId.get(c.cardId) ?? 0,
        ),
        intendedHitRate: r.resolved.intendedHitRate,
        priceBudgetPct: stagedProbeBudgetPct,
        // Owner pins — held EXACT at every probed cent, same builder mapping
        // as the staged solve (a far price the pins refuse is never suggested).
        ...(input.pinnedOdds !== undefined && input.pinnedOdds.length > 0
          ? { pinnedOdds: input.pinnedOdds }
          : {}),
      }),
      // Spread-override the band to the full ±60% SUGGESTION band — the probe
      // is NOT a plan and never becomes the write artifact.
      maxPriceChangePct: RETUNE_MAX_PRICE_CHANGE_PCT,
    });
    const wideShaped = wideSearch.bestResult;
    let wideShapeDegenerate: boolean | null = null;
    let wideEdge = 0;
    let wideWinRate = 0;
    if (!("error" in wideShaped)) {
      wideEdge = wideShaped.risk.edge;
      wideWinRate = wideShaped.risk.winRate;
      const wt = wideShaped.weights.reduce(
        (a, w) => a + (Number.isFinite(w) && w > 0 ? w : 0),
        0,
      );
      wideShapeDegenerate =
        wt > 0
          ? ladderShape(
              stagedValuesForProbe,
              input.cards.map((c) => (livePcts.get(c.cardId) ?? 0) / 100),
              wideShaped.weights.map((w) =>
                Number.isFinite(w) && w > 0 ? w / wt : 0,
              ),
              wideSearch.bestPrice,
            ).degenerate
          : null;
    }
    stagedWideProbeSuggestion = buildWidePriceProbeSuggestion({
      // The probe's anchor: the STAGED price (the band is measured from it).
      livePrice: r.priceStaged,
      tagged: taggedStaged,
      tag: r.resolved.targetWinRate,
      def: {
        feasible: outcome.ok,
        price: r.priceAfter,
        allNice: outcome.ok ? (outcome.allNice ?? null) : null,
        snapped: outcome.ok ? (outcome.snapped ?? false) : null,
        taggedAccuracyHit: r.priceSearch?.taggedAccuracyHit ?? null,
        shapeDegenerate: outcome.ok ? stagedShapeDegenerate : null,
      },
      wide: {
        feasible: !("error" in wideShaped),
        price: wideSearch.bestPrice,
        allNice: !("error" in wideShaped) ? (wideShaped.allNice ?? null) : null,
        snapped: !("error" in wideShaped) ? (wideShaped.snapped ?? false) : null,
        taggedAccuracyHit: wideSearch.taggedAccuracyHit,
        shapeDegenerate: wideShapeDegenerate,
      },
      wideEdge,
      wideWinRate,
    });
  }
  // §1.4 merge + Pattern 9h: drop any staged price suggestion equal to the
  // plan's own landed price (a no-op "move") — merge FIRST, prune SECOND,
  // exactly the live arm's ordering, so the verdict + pool-edit derivation
  // below consume the merged guidance.
  guidance = pruneNoOpSuggestions(
    mergeWideProbeSuggestion(guidance, stagedWideProbeSuggestion),
    r.priceAfter,
  );

  // Wave 2b: a pins refusal ships the smallest SOLVER-VERIFIED single-pin
  // fixes IN the plan (`verdict.pinRemedies` + the shortfall copy) — the
  // remedy probe re-verifies every candidate through the same engine the
  // staged solve ran, so a claimed fix is a plan the write would accept.
  let stagedPinRemedies: PinRemedy[] | null = null;
  if (
    !outcome.ok &&
    outcome.limit?.kind === "pins-infeasible" &&
    stagedPinnedShares !== null
  ) {
    stagedPinRemedies = computePinRemedies({
      cards: input.cards.map((c) => ({
        value: r.cardMetaById.get(c.cardId)?.value ?? 0,
      })),
      // Stable identity per remedy (wave 5 one-click apply): the client
      // applies a pin fix by cardId, never by index — row reorders are not
      // solve-relevant, so indices can outlive the order they were minted in.
      cardIds: input.cards.map((c) => c.cardId),
      currentWeights: input.cards.map(
        (c) => liveWeightByCardId.get(c.cardId) ?? 0,
      ),
      price: r.priceStaged,
      targetEdge: r.resolved.targetEdge,
      targetWinRate: r.resolved.targetWinRate,
      nearMissMin: r.resolved.nearMissMin,
      maxWinCap: r.resolved.maxWinCap,
      pinnedShares: stagedPinnedShares,
      intendedHitRate: r.resolved.intendedHitRate,
      pinPrice: staged.pinPrice === true,
      priceBudgetPct: await readRetunePriceBudgetPct(),
    });
  }

  // §risk-leverage: the CV band (widened to the live CV) + landed-CV exit. Band
  // is over the LIVE pack (tag + live price + live CV); the exit is judged
  // against the staged plan's landed `after.cv`.
  const stagedRiskBand: RiskBand | null =
    outcome.ok && outcome.after !== null
      ? packRiskBand({
          tag: r.resolved.intendedHitRate,
          price: r.priceBefore,
          liveCv: r.before.cv,
        })
      : null;
  const stagedRiskBandExit =
    stagedRiskBand !== null && outcome.ok && outcome.after !== null
      ? isRiskBandExit(outcome.after.cv, stagedRiskBand)
      : false;

  // §3 pool-edits-first (staged arm): an infeasible / degenerate / risk-flip
  // staged plan leads with the solver-verified pool edit derived from the
  // staged guidance. `readRetunePriceBudgetPct` is request-cached (free here).
  const stagedTierFlip =
    outcome.ok && outcome.after !== null && outcome.after.tier !== r.before.tier;
  const stagedPoolEditReason: PoolEditReason | null = !outcome.ok
    ? "infeasible"
    : stagedShape?.degenerate === true
      ? "degenerate-shape"
      : stagedRiskBandExit && stagedTierFlip
        ? "risk-band-exit"
        : // Pattern 10: dirty dead end after the full sweep — pool edit first.
          outcome.snapped !== true && r.priceSearch?.fellBackToBase === true
          ? "dirty-dead-end"
          : null;
  const stagedPoolEditPlan =
    stagedPoolEditReason !== null
      ? derivePoolEditPlan(
          guidance,
          stagedPoolEditReason,
          r.priceBefore,
          await readRetunePriceBudgetPct(),
        )
      : null;

  // Refusal WHY fields, computed ONCE — the payload and the verdict share
  // them so they can never disagree (see the field docs on the return).
  const stagedTagContradiction =
    !outcome.ok && outcome.code === "tag-contradiction"
      ? outcome.message
      : null;
  const stagedRefusalMessage =
    !outcome.ok &&
    outcome.limit === null &&
    outcome.code !== "tag-contradiction"
      ? outcome.message
      : null;
  const stagedRefusalCode =
    !outcome.ok &&
    outcome.limit === null &&
    outcome.code !== "tag-contradiction"
      ? outcome.code
      : null;
  const stagedVerdict = buildPackTuneVerdict({
    feasible: outcome.ok,
    limit: outcome.ok ? null : outcome.limit,
    tagContradiction: stagedTagContradiction,
    refusalMessage: stagedRefusalMessage,
    refusalCode: stagedRefusalCode,
    tagged: taggedStaged,
    taggedAccuracyHit: r.priceSearch?.taggedAccuracyHit ?? null,
    snapped: outcome.ok ? outcome.snapped : null,
    allNice: outcome.ok ? outcome.allNice : null,
    shapeDegenerate: stagedShape?.degenerate ?? null,
    guidance,
    price: r.priceStaged,
    targetEdge: r.resolved.targetEdge,
    pinRemedies: stagedPinRemedies,
  });

  return {
    packId,
    name: r.packName,
    slug: pack.slug,
    arm: "staged",
    computedAtIso: new Date().toISOString(),
    poolFingerprint,
    price: r.priceBefore,
    stagedPrice: staged.price ?? null,
    priceAfter: r.priceAfter,
    planned,
    removedCardIds,
    // Cap removals over the STAGED identities at the resolved cap — the same
    // predicate the write's row filter enforces (weight 0 by construction).
    capDroppedCardIds: computeCapDroppedCardIds(
      input.cards.map((c) => ({
        cardId: c.cardId,
        value: r.cardMetaById.get(c.cardId)?.value ?? 0,
      })),
      r.resolved.maxWinCap,
    ),
    before: r.before,
    after: outcome.after,
    feasible: outcome.ok,
    relaxations: outcome.ok ? outcome.relaxations : [],
    limit: outcome.ok ? null : outcome.limit,
    tagContradiction: stagedTagContradiction,
    // Guaranteed WHY fallback for a REFUSED plan that carries NO structured
    // `limit` and is NOT a tag-contradiction (the post-shape write-assert
    // refusals: win-rate-miss / edge-above-band / max-win-above-cap /
    // edge-below-target / tag-accuracy-miss / edge-floor). Surfacing-only —
    // the plan stays `feasible: false` and non-pushable.
    refusalMessage: stagedRefusalMessage,
    refusalCode: stagedRefusalCode,
    snapped: outcome.ok ? outcome.snapped : null,
    offLadderCards,
    allNice: outcome.ok ? outcome.allNice : null,
    topInflationUnavoidable: outcome.ok ? outcome.topInflationUnavoidable : null,
    intendedHitRate: r.resolved.intendedHitRate,
    targets: {
      targetEdge: r.resolved.targetEdge,
      targetWinRate: r.resolved.targetWinRate,
      maxWinCap: r.resolved.maxWinCap,
      nearMissMin: r.resolved.nearMissMin,
    },
    taggedAccuracyHit: r.priceSearch?.taggedAccuracyHit ?? null,
    searchMeta: r.priceSearch
      ? {
          candidates: r.priceSearch.candidates,
          fellBackToBase: r.priceSearch.fellBackToBase,
        }
      : null,
    // Echo the pins the solve ran WITH (frozen-artifact self-description).
    pinnedOdds: input.pinnedOdds ?? null,
    guidance,
    shape: stagedShape,
    riskBand: stagedRiskBand,
    riskBandExit: stagedRiskBandExit,
    poolEditPlan: stagedPoolEditPlan,
    verdict: stagedVerdict,
  };
}
