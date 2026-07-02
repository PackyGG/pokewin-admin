"use server";

import { revalidatePath, revalidateTag, unstable_cache } from "next/cache";
import { isUuid } from "@/lib/utils/ids";
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
  shapeWeights,
  searchBestPriceForCleanSnap,
  isOnCleanLadderPct,
  type PackRisk,
  type ShapeWeightsRelaxation,
  type ShapeWeightsLimit,
} from "@/app/(admin)/insights/edge-calc/risk";
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
  TAGGED_WRITE_WINRATE_TOLERANCE,
  autoTargetEdge,
  DEFAULT_EDGE_CURVE,
  EDIT_EDGE_FLOOR,
  readEdgeCurveConfig,
  readMaxWinCap,
  readMaxMultCeiling,
  type EdgeCurveConfig,
  type ResolvedAutoTargetCfg,
} from "@/app/(admin)/packs/_lib/risk-config";
import { computePoolFingerprint } from "@/app/(admin)/packs/_lib/pool-fingerprint";
import { buildRetuneSearchParams } from "@/app/(admin)/packs/_lib/retune-params";
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
      compliance: buildPackCompliance(risk, maxWinCap),
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

export type StagedPoolInput = {
  cards: StagedPoolInputCard[];
  /** Optional new pack price (USD). When omitted, the price is left unchanged. */
  price?: number;
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
  const auto = autoRetuneTargets(
    priceStaged,
    cfg,
    // DB `tags` column first (authoritative), name-prefix tag as fallback.
    resolveIntendedHitRate(pack.name, pack.tags) ?? undefined,
  );
  const targetEdge = targets.targetEdge ?? auto.targetEdge;
  const targetWinRate = targets.targetWinRate ?? auto.targetWinRate;
  const maxWinCap = targets.maxWinCap ?? auto.maxWinCap;
  const nearMissMin = targets.nearMissMin ?? auto.nearMissMin;
  const winRateTol = 0.02; // matches shapeWeights' default + applyPackRetune.

  const resolved: StagedShapeResolution["resolved"] = {
    targetEdge,
    targetWinRate,
    maxWinCap,
    nearMissMin,
    winRateTol,
    intendedHitRate: auto.intendedHitRate,
  };
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
  };

  // A pct-tagged pack's win-rate is a design CONTRACT — a pinned target that
  // contradicts the tag is refused (mirrors `applyPackRetune`). Reported as a
  // structured refusal so the dry-run can render the verdict; the write throws
  // this exact message.
  if (
    auto.intendedHitRate !== null &&
    Math.abs(targetWinRate - auto.intendedHitRate) >
      TAGGED_WRITE_WINRATE_TOLERANCE
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
      },
    };
  }

  // The staged value vector in input ORDER. The shaper picks one weight per slot.
  const stagedValues = input.cards.map((c) => ({
    value: cardMetaById.get(c.cardId)!.value,
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
    shaped = shapeWeights({
      cards: stagedValues,
      price: priceAfter,
      targetEdge,
      targetWinRate,
      maxWinCap,
      nearMissMin,
      winRateTol,
      // Anti-inflation anchor (no win/grail card's odds exceed its current odds).
      currentWeights: stagedCurrentWeights,
    });
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
    outcome: { ok: false, code, message, limit: null, after },
  });
  if (after.edge < targetEdge - 1e-9) {
    return refuse(
      "edge-below-target",
      `Refused: resulting edge ${(after.edge * 100).toFixed(2)}% is below the target ${(targetEdge * 100).toFixed(2)}%.`,
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
  const rows = input.cards.map((c, i) => ({
    pack_id: packId,
    card_id: c.cardId,
    weight: outcome.weights[i]!,
    color: c.color ?? null,
    animation: c.animation ?? false,
    order: c.order,
  }));

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

  // SAME delete-all-then-createMany pattern used by every other writer.
  const db = await getDb();
  await db.$transaction(async (tx) => {
    await tx.packs.update({
      where: { id: packId },
      data: {
        ...(shouldWritePrice ? { price: priceAfter } : {}),
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
  await refreshEditedPackRiskScore(packId, after, r.resolved.maxWinCap);

  reloadPacks();
  // Invalidate this pack's cached V2 plan so the next `planPackTune` reflects
  // this auto-tune instead of a 60s-stale solve. Per-pack: ONLY this pack's
  // plan is busted (never the other 182).
  revalidateTag(packRetunePlanTag(packId));
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
  snapped: boolean | null;
  /** cardIds whose planned pct is NOT on the clean ladder (amber dots). */
  offLadderCards: string[];
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
  return unstable_cache(
    () => planPackTuneLiveUncached(packId),
    ["pack-studio.retune.plan-pack.v1", packId],
    { revalidate: 60, tags: [packRetunePlanTag(packId)] },
  )();
}

/** Shared per-card projection: weights vector → planned rows + off-ladder ids. */
function projectPlannedVector(
  cardIds: string[],
  weights: number[],
  livePctByCardId: Map<string, number>,
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
  const offLadderCards = planned
    .filter((row) => !isOnCleanLadderPct(row.pct))
    .map((row) => row.cardId);
  return { planned, offLadderCards };
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

  const autoTargets = autoRetuneTargets(
    p.price,
    cfg,
    resolveIntendedHitRate(p.name, p.tags) ?? undefined,
  );
  const poolFingerprint = computePoolFingerprint(p.price, cards);
  const before = computePackRisk({
    cards: cards.map((c) => ({ value: c.value, weight: c.weight })),
    price: p.price,
  });
  const computedAtIso = new Date().toISOString();
  const targets = {
    targetEdge: autoTargets.targetEdge,
    targetWinRate: autoTargets.targetWinRate,
    maxWinCap: autoTargets.maxWinCap,
    nearMissMin: autoTargets.nearMissMin,
  };
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
    before,
    tagContradiction: null,
    intendedHitRate: autoTargets.intendedHitRate,
    targets,
  };

  if (cards.length === 0) {
    return {
      ...base,
      priceAfter: p.price,
      planned: [],
      after: null,
      feasible: false,
      relaxations: [],
      limit: {
        kind: "empty-pool",
        detail:
          "This pack has no cards in its pool, so there is nothing to retune.",
        suggestion: "Add cards to the pack in the Builder before retuning it.",
      },
      snapped: null,
      offLadderCards: [],
      topInflationUnavoidable: null,
      taggedAccuracyHit: null,
      searchMeta: null,
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
      nearMissMin: autoTargets.nearMissMin,
      // The solver's default win-rate tolerance, pinned explicitly so the
      // plan's params deep-equal the write's (`applyPackRetune` sends 0.02).
      winRateTol: 0.02,
      // Anti-inflation anchor: no win/grail card's odds may exceed its
      // current odds (the jackpot stays rare; raising the edge only trims
      // the expensive tail).
      currentWeights: cards.map((c) => c.weight),
      intendedHitRate: autoTargets.intendedHitRate,
    }),
  );
  const shaped = search.bestResult;
  const searchMeta = {
    candidates: search.searched,
    fellBackToBase: search.fellBackToBase,
  };

  if ("error" in shaped) {
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
      topInflationUnavoidable: null,
      taggedAccuracyHit: search.taggedAccuracyHit,
      searchMeta,
    };
  }

  const { planned, offLadderCards } = projectPlannedVector(
    cards.map((c) => c.cardId),
    shaped.weights,
    livePctMap(cards),
  );

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
    topInflationUnavoidable: shaped.topInflationUnavoidable ?? false,
    taggedAccuracyHit: search.taggedAccuracyHit,
    searchMeta,
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

  const input: StagedPoolInput = {
    cards: staged.cards.map((c) => ({ cardId: c.cardId, order: c.order })),
    ...(staged.price !== undefined ? { price: staged.price } : {}),
  };
  const r = await resolveAndShapeStagedPool(packId, input, {
    // Price search is ALWAYS ON (owner directive: price is a free lever);
    // `pinPrice` is the rare odds-only escape hatch — the write's anchored
    // no-search branch.
    allowPriceSearch: staged.pinPrice !== true,
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

  const { planned, offLadderCards } = outcome.ok
    ? projectPlannedVector(
        input.cards.map((c) => c.cardId),
        outcome.weights,
        livePcts,
      )
    : { planned: [], offLadderCards: [] };

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
    before: r.before,
    after: outcome.after,
    feasible: outcome.ok,
    relaxations: outcome.ok ? outcome.relaxations : [],
    limit: outcome.ok ? null : outcome.limit,
    tagContradiction:
      !outcome.ok && outcome.code === "tag-contradiction"
        ? outcome.message
        : null,
    snapped: outcome.ok ? outcome.snapped : null,
    offLadderCards,
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
  };
}
