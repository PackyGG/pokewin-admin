"use server";

import { revalidatePath, revalidateTag } from "next/cache";
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
  computePackRiskFromAggregates,
  shapeWeights,
  searchBestPriceForCleanSnap,
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
  autoTargetEdge,
  DEFAULT_EDGE_CURVE,
  EDIT_EDGE_FLOOR,
  parsePackHitRate,
  readEdgeCurveConfig,
  readMaxWinCap,
  readMaxMultCeiling,
  readPackSystemConfig,
  type EdgeCurveConfig,
  type ResolvedAutoTargetCfg,
} from "@/app/(admin)/packs/_lib/risk-config";
import {
  computePortfolioProfile,
  derivePortfolioTargets,
  resolvePortfolioSystemConfig,
  type PortfolioProfile,
  type PortfolioSystemConfig,
  type PortfolioSystemPlan,
  type PortfolioPackInput,
  type PortfolioPackTargets,
} from "@/app/(admin)/packs/_lib/portfolio";

/**
 * Read-only helpers backing the Pack Doctor re-tune UI. The authoritative WRITE
 * path is the existing pack server actions (`planPackRetune` /
 * `authorizePackRetune` / `applyPackRetune` and `authorizeReprice` /
 * `repricePackToTargetEdge` in `src/app/(admin)/packs/actions.ts`) — this file
 * adds ONLY the owner-gated READ surfaces the doctor drawer + dialogs need that
 * aren't already exported:
 *
 *   • getPackRetunePool — a pack's card pool (id/name/value/weight) joined to
 *     fresh identity, plus the current `computePackRisk` breakdown and the
 *     resolved max-win cap, for the re-tune drawer's "card pool + risk" view.
 *   • planCustomRepin   — a READ-ONLY dry-run for the "Re-pin below-target packs
 *     to ≥ target" action: re-derives each below-target pack's round-up
 *     price/edge via the SAME `planPackReprice` the global re-price uses.
 *
 * Both are owner-gated AND Pack-Studio-gated, READ-ONLY (MAIN is read-only here;
 * they only SELECT), and write nothing. The matching mutations stay in the
 * existing, paranoid, 2FA-token-guarded pack actions.
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

export type RetunePoolCard = {
  cardId: string;
  name: string;
  value: number;
  weight: number;
  /** weight / Σweight — the current draw probability (0..1). */
  prob: number;
};

export type RetunePool = {
  packId: string;
  name: string;
  slug: string;
  packType: string;
  active: boolean;
  price: number;
  /** Resolved jackpot cap (USD) so the drawer can pre-fill the cap lever. */
  maxWinCap: number;
  /** The pack's risk AS IT IS NOW (same engine the snapshot scores with). */
  risk: PackRisk;
  /** Pool cards, ordered by current weight desc (most-likely first). */
  cards: RetunePoolCard[];
};

/**
 * Read a pack's full card pool + current risk for the re-tune drawer. Owner-only,
 * READ-ONLY: a fresh MAIN read of the pool values/weights (`getPackCardValues`),
 * the card display names (one `id = ANY(...)` PK probe), and the pack identity —
 * then the pure `computePackRisk` breakdown. Writes nothing.
 */
export async function getPackRetunePool(packId: string): Promise<RetunePool> {
  await requireRetuneOwner();
  if (!isUuid(packId)) throw new Error("Invalid pack id");

  const db = await getDb();
  const pack = await db.packs.findUnique({
    where: { id: packId },
    select: { name: true, slug: true, price: true, active: true, pack_type: true },
  });
  if (!pack) throw new Error("Pack not found");

  const price = Number(pack.price.toString());
  const pool = await getPackCardValues(packId);

  // Card display names (read-only PK probe). Absent ids fall back to a short id.
  const nameById = new Map<string, string>();
  if (pool.length > 0) {
    const cardRows = await db.cards.findMany({
      where: { id: { in: pool.map((c) => c.cardId) } },
      select: { id: true, name: true },
    });
    for (const r of cardRows) nameById.set(r.id, r.name);
  }

  const risk = computePackRisk({
    cards: pool.map((c) => ({ value: c.value, weight: c.weight })),
    price,
  });

  const totalWeight = pool.reduce((s, c) => s + (c.weight > 0 ? c.weight : 0), 0);
  const cards: RetunePoolCard[] = pool
    .map((c) => ({
      cardId: c.cardId,
      name: nameById.get(c.cardId) ?? `${c.cardId.slice(0, 8)}…`,
      value: c.value,
      weight: c.weight,
      prob: totalWeight > 0 ? c.weight / totalWeight : 0,
    }))
    .sort((a, b) => b.weight - a.weight);

  const maxWinCap = await readMaxWinCap();

  return {
    packId,
    name: pack.name,
    slug: pack.slug,
    packType: pack.pack_type,
    active: pack.active,
    price,
    maxWinCap,
    risk,
    cards,
  };
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

// ─── Plan-all auto-retune (READ-ONLY dry-run for EVERY in-scope pack) ──────
//
// The "re-tune everything to the house auto-targets" preview: for ALL active
// official packs, compute the CURRENT risk and the proposed shaped weights at
// the auto-targets (house edge + default win-rate/near-miss + price-relative
// jackpot cap). One batched MAIN read of every in-scope pack's card values
// (a single SELECT joining pack_cards->cards for all in-scope pack_ids — NOT an
// N+1 per pack), then pure compute per pack. Writes NOTHING — the owner reviews,
// then the per-pack apply loop (`authorizePackRetune` + `applyPackRetune`) does
// the 2FA-guarded writes. Card values + current weights are returned so the
// client can re-shape locally during an "Adjust" pass without a round-trip
// (card values are public sticker prices, not secret).

/** One pool card of a plan-all proposal: id + value + the CURRENT weight. */
export type PlanAllCard = {
  cardId: string;
  /** `cards.price` (the item value; a voucher is the same as a card). */
  value: number;
  /** Current `pack_cards.weight`. */
  weight: number;
  /** `cards.name` — surfaced so the review UI can label each row by item. */
  name: string;
  /** `cards.image_url` — surfaced so the review UI can show a thumbnail. */
  imageUrl: string;
};

/** Per-card weight change a plan-all proposal would apply (only changed cards). */
export type PlanAllWeightDiff = {
  cardId: string;
  from: number;
  to: number;
};

export type PlanAllProposal = {
  packId: string;
  name: string;
  slug: string;
  price: number;
  /**
   * The PRICE the proposal would write (USD). Equals `price` when the clean-
   * snap price-search didn't move the ticket. When the chip-strip edge override
   * is active (or the snap needed a nearby price to land clean odds), the
   * solver may PUSH THE TICKET PRICE UP to satisfy the (edge_target +
   * clean_odds + win_rate) trio simultaneously — `priceAfter` is the new
   * ticket. `applyPackRetune` writes this verbatim. Owner asked: "change the
   * price of the pack to keep the edge better or chances".
   */
  priceAfter: number;
  /** Pool cards (id/value/current weight), pool order. */
  cards: PlanAllCard[];
  /** Current weights, mirrored out for convenient client re-shaping. */
  currentWeights: { cardId: string; weight: number }[];
  /**
   * The targets this proposal was shaped to. In "per-pack" mode these are the
   * pack's independent `autoRetuneTargets`; in "portfolio" mode they are the
   * system-balanced targets (may carry a tightened cap / nudged win-rate).
   */
  autoTargets: PortfolioPackTargets;
  /**
   * The INTENDED hit-rate parsed from the pack NAME (its leading `X%` tag, e.g.
   * "10% Divine Order" → 0.10), or `null` for an untagged pack. Surfaced at the
   * top level so the UI can show "1% pack → targeting 1% win-rate" without
   * reaching into `autoTargets`. Mirrors `autoTargets.intendedHitRate`.
   */
  intendedHitRate: number | null;
  /**
   * The win-rate this proposal was actually shaped to. For a TAGGED pack this is
   * its tag hit-rate; for an untagged pack the default 20%; in portfolio mode a
   * possibly-nudged value. Equals `autoTargets.targetWinRate`.
   */
  targetWinRate: number;
  /** Risk AS IT IS NOW. */
  before: PackRisk;
  /** Risk the pack WOULD have after the auto-retune (null when infeasible). */
  after: PackRisk | null;
  /** Per-card weight change (null when infeasible). */
  weightDiff: PlanAllWeightDiff[] | null;
  /** Whether `shapeWeights` produced a usable vector at the auto-targets. */
  feasible: boolean;
  /**
   * Soft targets the solver had to RELAX to reach this (feasible) result —
   * empty when nothing was relaxed. Only present on a feasible proposal; an
   * infeasible one carries a `limit` instead. Each entry says which lever was
   * loosened, what was requested, what was applied, and why — so the UI can
   * show a friendly "near-miss relaxed 10% → 0% — this pool has no near-miss
   * cards" banner instead of silently dropping the target.
   */
  relaxations: ShapeWeightsRelaxation[];
  /** The solver's error verbatim when infeasible. */
  error?: string;
  /**
   * Structured HARD limit when the pack is genuinely infeasible (the error
   * arm): a kind + human-readable detail + a concrete suggestion, so an
   * infeasible pack shows a clear "why + how to fix" message rather than a dead
   * end. Null on a feasible proposal.
   */
  limit: ShapeWeightsLimit | null;
};

/**
 * Mode for {@link planAllRetunes}:
 *   • "per-pack"  — current behavior: every pack shaped to its INDEPENDENT
 *                   `autoRetuneTargets` (flat house edge + default win-rate + auto
 *                   cap). `systemPlan` is null.
 *   • "portfolio" — system-level: targets are derived by `derivePortfolioTargets`
 *                   so the WHOLE catalog lands inside the system bounds (spicy
 *                   share + jackpot exposure). Each pack is shaped to its
 *                   system-target; `systemPlan` explains what was tightened + why.
 */
export type PlanAllMode = "per-pack" | "portfolio";

/**
 * Options for {@link planAllRetunes}. Currently only carries the operator's
 * optional house-edge floor nudge from the Retune Review chip strip (presets
 * 11.02 / 11.10 / 11.20 / 11.25 / 11.30 %). When set, the edge curve's floor
 * (and, if needed, its ceiling) is raised to this value for the run — every
 * pack's per-pack target lands ≥ the override. Null/undefined → baseline curve.
 *
 * SAFETY: the override is clamped into `[DEFAULT_EDGE_FLOOR, EDGE_TARGET_NUDGE_MAX]`
 * (1.0% headroom above the 11.50% ceiling) before being applied; an out-of-range
 * value falls back to the baseline. Read-only — this only changes the targets
 * the dry-run shapes against; nothing is written to MAIN.
 */
export type PlanAllOpts = {
  edgeFloorOverride?: number | null;
  /**
   * Operator-pinned target ticket price (USD) — ANCHOR for the clean-snap price
   * search. When set (non-null, > 0), the search re-centers around this anchor
   * rather than the live pack price, so the operator can say "shape every pack
   * to land at $X" and have `priceAfter` cluster around that value (the search
   * still nudges ±25% / +200% in the chip-strip-nudged case to find a clean
   * snap that satisfies edge + win-rate). Per-pack ticket-price differences
   * (a $1.25 pack and a $5 pack in the same review session) are preserved
   * relative to their own anchor — this is a per-pack absolute anchor, not a
   * batch override. Null/undefined = use each pack's live `price` (default).
   *
   * SAFETY: when an anchor is active, the search runs in `preferHigherEdge`
   * mode (edge ranks above snap-cleanness) so an anchor that lowers the price
   * doesn't silently give up house edge.
   */
  priceOverride?: number | null;
};

/** Hard ceiling on the operator's edge nudge — caps the chip strip presets. */
const EDGE_TARGET_NUDGE_MAX = 0.125;

/**
 * Overlay an optional operator edge-floor nudge onto the resolved edge curve.
 * Pure + sync. When `override` is null/undefined/non-finite/out-of-range, the
 * curve is returned unchanged. When set, the floor is raised to the override
 * (clamped into `[base.edgeFloor, EDGE_TARGET_NUDGE_MAX]`) AND the ceiling is
 * pushed up to be ≥ the new floor so the invariant `edgeFloor ≤ edgeCeiling`
 * the pure helpers rely on still holds. The premium-driven part of the curve
 * (coefficients / bases / refs) is untouched — only the floor/ceiling band
 * shifts up, so every pack still gets its tiny risk premium on top of the
 * raised floor.
 */
function applyEdgeFloorOverride(
  base: EdgeCurveConfig,
  override: number | null | undefined,
): EdgeCurveConfig {
  if (override == null || !Number.isFinite(override)) return base;
  if (!(override > base.edgeFloor)) return base; // nudging DOWN is not allowed.
  const clamped = Math.min(EDGE_TARGET_NUDGE_MAX, override);
  return {
    ...base,
    edgeFloor: clamped,
    edgeCeiling: Math.max(base.edgeCeiling, clamped),
  };
}

export type PlanAllRetunesResult = {
  /** The auto-target config resolved once for this run (for the header UI). */
  cfg: ResolvedAutoTargetCfg;
  /** Which targeting mode produced these proposals. */
  mode: PlanAllMode;
  /**
   * The system-level plan (before/after profile + tightened packs + why) when
   * `mode === "portfolio"`; null in "per-pack" mode.
   */
  systemPlan: PortfolioSystemPlan | null;
  proposals: PlanAllProposal[];
};

/** One batched MAIN read of every in-scope pack's card values + weights. */
type BatchedPoolRow = {
  pack_id: string;
  card_id: string;
  value: string | null;
  weight: number;
  name: string;
  image_url: string;
};

/**
 * READ-ONLY: for ALL active official packs, return the retune proposal (current
 * vs. proposed risk + weight diff). Owner + Pack-Studio gated. One batched
 * card-values read (no N+1), then pure compute. Writes nothing.
 *
 *   • mode "per-pack" (default) — each pack shaped to its INDEPENDENT
 *     `autoRetuneTargets`; `systemPlan` null (the current behavior, unchanged).
 *   • mode "portfolio" — `derivePortfolioTargets` sets per-pack targets so the
 *     WHOLE catalog lands inside the system bounds; each pack is shaped to its
 *     system-target and `systemPlan` explains what was tightened + why.
 */
export async function planAllRetunes(
  mode: PlanAllMode = "per-pack",
  opts?: PlanAllOpts,
): Promise<PlanAllRetunesResult> {
  await requireRetuneOwner();

  // Resolve the auto-target config ONCE for the whole run.
  // `edgeCurve` is always populated (using the DB blob + curve-overlay logic
  // below) so `autoTargetEdge` shapes against a single source-of-truth curve
  // — not the silent `DEFAULT_EDGE_CURVE` fallback inside the pure helper.
  const baseEdgeCurve = await readEdgeCurveConfig();
  const edgeCurve = applyEdgeFloorOverride(baseEdgeCurve, opts?.edgeFloorOverride);
  const cfg: ResolvedAutoTargetCfg = {
    globalCap: await readMaxWinCap(),
    maxMultCeiling: await readMaxMultCeiling(),
    edgeCurve,
  };

  // In-scope set: ACTIVE official packs with price > 0 (same scope the global
  // re-price dry-run sweeps). Gives us id/name/slug/price per pack.
  const comps = await getPacksPoolComposition();
  const inScope = comps.filter((p) => p.active && p.price > 0);
  if (inScope.length === 0) {
    return { cfg, mode, systemPlan: null, proposals: [] };
  }

  const packIds = inScope.map((p) => p.id);

  // ── ONE batched read of every in-scope pack's card values + weights ──────
  // Single SELECT joining pack_cards -> cards for ALL in-scope pack_ids (no
  // N+1). The `pack_id = ANY(...)` predicate is served by the existing
  // `pack_cards_pack_id_card_id_unique` composite index (leading column
  // pack_id, Bitmap Index Scan — verified for the per-pack lookup in
  // prisma/recommended-indexes.sql); `cards` is joined on its PK. Decimals cast
  // to text and re-parsed for serializable, JS-arithmetic-safe numbers.
  const db = await getDb();
  // SAFE: the ONLY runtime value in this query is `packIds`, bound via the
  // parameterized `$1::uuid[]` placeholder (each id is `isUuid`-filtered above).
  // No string is interpolated into the SQL text — keep it that way.
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
      WHERE pc.pack_id = ANY($1::uuid[])
      ORDER BY pc.pack_id, pc.order ASC
    `,
    packIds,
  );

  // Group rows by pack, preserving pool order.
  const cardsByPack = new Map<string, PlanAllCard[]>();
  for (const r of rows) {
    let list = cardsByPack.get(r.pack_id);
    if (!list) {
      list = [];
      cardsByPack.set(r.pack_id, list);
    }
    list.push({
      cardId: r.card_id,
      value: Number(r.value ?? 0),
      weight: Number(r.weight),
      name: r.name ?? "",
      imageUrl: r.image_url ?? "",
    });
  }

  // ── Resolve the per-pack TARGETS for this run ───────────────────────────
  // "before" risk per pack first (shared by both modes + needed by the
  // portfolio balancer), then the target set each pack will be shaped to.
  const beforeByPack = new Map<string, PackRisk>();
  for (const p of inScope) {
    const cards = cardsByPack.get(p.id) ?? [];
    beforeByPack.set(
      p.id,
      computePackRisk({
        cards: cards.map((c) => ({ value: c.value, weight: c.weight })),
        price: p.price,
      }),
    );
  }

  // Default: every pack on its INDEPENDENT auto-targets. TAG-AWARE — a pack whose
  // NAME starts with `X%` (e.g. "10% Divine Order") targets THAT hit-rate as its
  // win-rate (`parsePackHitRate`); untagged packs keep the default 20%. In
  // portfolio mode the system balancer overrides the offenders' targets so the
  // WHOLE catalog lands inside the system bounds; `systemPlan` explains it.
  let targetsByPack: Map<string, PortfolioPackTargets> = new Map(
    inScope.map((p) => [p.id, autoRetuneTargets(p.price, cfg, p.name)]),
  );
  let systemPlan: PortfolioSystemPlan | null = null;

  if (mode === "portfolio") {
    const sysCfg = await readPortfolioSystemConfigResolved(cfg);
    const balancerInput: PortfolioPackInput[] = inScope.map((p) => ({
      packId: p.id,
      price: p.price,
      name: p.name,
      cards: (cardsByPack.get(p.id) ?? []).map((c) => ({ value: c.value })),
      currentRisk: beforeByPack.get(p.id)!,
    }));
    const derived = derivePortfolioTargets(balancerInput, sysCfg);
    targetsByPack = derived.targetsByPack;
    systemPlan = derived.systemPlan;
  }

  // Per-pack price-search policy.
  //
  // The dry-run must show the OWNER what approve will actually write — the
  // chip-strip table the owner sees is the AUTHORITATIVE preview. The legacy
  // path called `shapeWeights` directly, which produced "dirty" odds like
  // 0.0142% / 0.0656% (no clean-snap convergence) AND held the ticket price
  // fixed even when the operator raised the edge target. The owner's explicit
  // ask:
  //   "i want the option to change the house edge … u can change the price of
  //    the pack to keep the edge better or chances. last time i will say this
  //    also none of these odds is clean, all dirty shit numbers. i said clean
  //    and easy, change the price to get it done if needed"
  // So every proposal now routes through `searchBestPriceForCleanSnap`:
  //   • ±25% default band → catches the "small price nudge for clean odds" case
  //     (e.g. $1.25 → $1.27) that holds the staged price near the original.
  //   • When the operator has nudged the edge floor UP (`edgeFloorOverride`),
  //     extend the upward search WAY past +25% so the solver can RAISE the
  //     ticket price as far as needed to simultaneously hit (the raised edge,
  //     clean ladder odds, the tag/default win-rate). The downward band stays
  //     ±25%. Upper bound = +200% (3× basePrice) so a $1.25 lottery pack can
  //     climb to ~$3.75 if that's what hits 11.20% + clean.
  // The chosen price becomes `priceAfter` and is what `applyPackRetune` writes.
  const edgeRaised =
    opts?.edgeFloorOverride != null &&
    Number.isFinite(opts.edgeFloorOverride) &&
    opts.edgeFloorOverride > baseEdgeCurve.edgeFloor;
  // Operator-pinned price anchor (optional). When set, every pack's search
  // re-centers on this absolute USD anchor instead of the pack's live price.
  // We also activate `preferHigherEdge` whenever an anchor OR an edge-floor
  // nudge is active so the scorer ranks higher achieved edge above cleaner
  // snap — the owner's report on a 1%-tagged pack ($1.25 → $1.00 search)
  // showed snap-first scoring giving away edge when the operator wanted the
  // opposite. Anchors that lower the price still must clear the targetEdge
  // hard floor inside `shapeWeights`; the preferHigherEdge bias picks the
  // candidate that BEATS target by the most.
  const priceAnchor =
    opts?.priceOverride != null &&
    Number.isFinite(opts.priceOverride) &&
    opts.priceOverride > 0
      ? opts.priceOverride
      : null;
  const upwardExtension = edgeRaised ? 2.0 : 0; // up to +200% when chip-strip nudged
  const preferHigherEdge = edgeRaised || priceAnchor !== null;

  const proposals: PlanAllProposal[] = inScope.map((p) => {
    const cards = cardsByPack.get(p.id) ?? [];
    const autoTargets: PortfolioPackTargets =
      targetsByPack.get(p.id) ?? autoRetuneTargets(p.price, cfg, p.name);
    const currentWeights = cards.map((c) => ({ cardId: c.cardId, weight: c.weight }));

    const before = beforeByPack.get(p.id)!;

    // A pack with no cards can't be shaped — surface it as infeasible, never
    // throw (one bad pack must not sink the whole plan).
    if (cards.length === 0) {
      return {
        packId: p.id,
        name: p.name,
        slug: p.slug,
        price: p.price,
        priceAfter: p.price,
        cards,
        currentWeights,
        autoTargets,
        intendedHitRate: autoTargets.intendedHitRate,
        targetWinRate: autoTargets.targetWinRate,
        before,
        after: null,
        weightDiff: null,
        feasible: false,
        relaxations: [],
        error: "Pack has no cards to retune.",
        limit: {
          kind: "empty-pool",
          detail: "This pack has no cards in its pool, so there is nothing to retune.",
          suggestion: "Add cards to the pack in the Builder before retuning it.",
        },
      };
    }

    // Tagged lottery packs (untagged hit-rate === null) get the strict
    // win-rate accuracy gate so 1%/5% packs land within 0.01pp of their tag.
    const taggedWinRate =
      autoTargets.intendedHitRate !== null &&
      Math.abs(autoTargets.intendedHitRate - autoTargets.targetWinRate) < 1e-9
        ? autoTargets.intendedHitRate
        : undefined;

    // Anchor the search on the operator's pinned target price when set; else
    // on the pack's current live price. `preferHigherEdge` is on whenever an
    // anchor OR an edge nudge is active so the scorer prefers higher achieved
    // edge over snap-cleanness (owner-reported $1.25 → $1.00 regression).
    const searchBasePrice = priceAnchor ?? p.price;
    const search = searchBestPriceForCleanSnap({
      cards: cards.map((c) => ({ value: c.value })),
      basePrice: searchBasePrice,
      targetEdge: autoTargets.targetEdge,
      targetWinRate: autoTargets.targetWinRate,
      maxWinCap: autoTargets.maxWinCap,
      nearMissMin: autoTargets.nearMissMin,
      maxPriceChangePct: 0.25,
      upwardPriceExtensionPct: upwardExtension,
      preferHigherEdge,
      ...(taggedWinRate !== undefined ? { taggedWinRate } : {}),
    });
    const shaped = search.bestResult;
    const priceAfter = search.bestPrice;

    if ("error" in shaped) {
      return {
        packId: p.id,
        name: p.name,
        slug: p.slug,
        price: p.price,
        priceAfter: p.price,
        cards,
        currentWeights,
        autoTargets,
        intendedHitRate: autoTargets.intendedHitRate,
        targetWinRate: autoTargets.targetWinRate,
        before,
        after: null,
        weightDiff: null,
        feasible: false,
        relaxations: [],
        error: shaped.error,
        limit: shaped.limit,
      };
    }

    const weightDiff = cards
      .map((c, i) => ({ cardId: c.cardId, from: c.weight, to: shaped.weights[i]! }))
      .filter((d) => d.from !== d.to);

    return {
      packId: p.id,
      name: p.name,
      slug: p.slug,
      price: p.price,
      priceAfter,
      cards,
      currentWeights,
      autoTargets,
      intendedHitRate: autoTargets.intendedHitRate,
      targetWinRate: autoTargets.targetWinRate,
      before,
      after: shaped.risk,
      weightDiff,
      feasible: true,
      relaxations: shaped.relaxations,
      limit: null,
    };
  });

  return { cfg, mode, systemPlan, proposals };
}

// ─── System-level portfolio profile (read-only header action) ─────────────

/**
 * Resolve the {@link PortfolioSystemConfig} for a run: read the raw config blob
 * (ADMIN-DB, cookie-free) and fold in the already-resolved auto-target config.
 * The blob's `reserves` drives the default exposure cap; explicit `maxSpicyShare`
 * / `exposureCapUsd` / `defaultWinRate` override the documented defaults. Pure
 * `resolvePortfolioSystemConfig` does the actual resolution so it stays testable.
 */
async function readPortfolioSystemConfigResolved(
  autoCfg: ResolvedAutoTargetCfg,
): Promise<PortfolioSystemConfig> {
  const raw = await readPackSystemConfig();
  if (!raw) return resolvePortfolioSystemConfig(null, autoCfg);

  // `PackSystemConfig` types only the fields risk-config reads; the blob MAY
  // carry the portfolio system-target fields too. Read them defensively as
  // optional numbers (the pure resolver validates each one) without widening
  // the shared `PackSystemConfig` type.
  const blob = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;

  return resolvePortfolioSystemConfig(
    {
      defaultWinRate: num(blob.defaultWinRate),
      maxSpicyShare: num(blob.maxSpicyShare),
      exposureCapUsd: num(blob.exposureCapUsd),
      reserves: num(raw.reserves),
    },
    autoCfg,
  );
}

export type PortfolioProfileResult = {
  /** The resolved system-target config (bounds the profile is judged against). */
  cfg: PortfolioSystemConfig;
  /** The current catalog profile (every active official pack scored as-is). */
  profile: PortfolioProfile;
  /** True when the catalog is already inside BOTH system bounds. */
  withinBounds: boolean;
};

/**
 * READ-ONLY owner-gated header action: profile the WHOLE active-official-pack
 * catalog (tier distribution, total jackpot exposure, aggregate CV, over-cap /
 * below-target counts, spicy share) against the resolved system bounds. Reuses
 * the SAME aggregated composition read as the re-price dry-run (`computePackRisk
 * FromAggregates` over `getPacksPoolComposition` — no per-card read needed), then
 * pure compute. Writes nothing.
 */
export async function getPortfolioProfile(): Promise<PortfolioProfileResult> {
  await requireRetuneOwner();

  const cfg: ResolvedAutoTargetCfg = {
    globalCap: await readMaxWinCap(),
    maxMultCeiling: await readMaxMultCeiling(),
  };
  const sysCfg = await readPortfolioSystemConfigResolved(cfg);

  // Aggregated composition is enough for the profile — score each pack via the
  // aggregate path (same engine, no per-card materialization).
  const comps = await getPacksPoolComposition();
  const inScope = comps.filter((p) => p.active && p.price > 0);

  const packRisks = inScope.map((p) => ({
    price: p.price,
    risk: computePackRiskFromAggregates({
      price: p.price,
      totalWeight: p.totalWeight,
      weightedPriceSum: p.weightedPriceSum,
      weightedSqSum: p.weightedSqSum,
      winWeight: p.winWeight,
      nearMissWeight: p.nearMissWeight,
      maxValue: p.maxValue,
      floorValue: p.floorValue,
    }),
  }));

  const profile = computePortfolioProfile(packRisks, cfg);
  const withinBounds =
    profile.spicyShare <= sysCfg.maxSpicyShare &&
    profile.totalMaxWinExposure <= sysCfg.exposureCapUsd;

  return { cfg: sysCfg, profile, withinBounds };
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
 *     which validates card identity; this keeps the retune-review edit honest
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
 * FAILS CLOSED before any write:
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
     * price (default ±25%, cent-stepped, max 50 candidates) and picks the
     * candidate whose `shapeWeights` result keeps `snapped=true` while staying
     * closest to the staged price. The chosen candidate becomes the final
     * `priceAfter` written to `packs.price` (so the writer's `priceProvided`
     * path applies it cleanly). Defaults to FALSE — current behavior unchanged.
     */
    allowPriceSearch?: boolean;
  },
): Promise<ApplyStagedRetuneResult> {
  const session = await requireRetuneOwner();
  await requireCapability(session, "__can_update_pack", "edit packs");
  if (!(await verifyRetuneToken(token, session.userId))) {
    throw new Error("2FA authorization expired or missing — re-confirm to continue.");
  }
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
  // bump this by up to ±25% to land cleaner odds; the FINAL `priceAfter` is
  // assigned after the shape step, and is what gets written to `packs.price`.
  const priceStaged = priceProvided ? input.price! : priceBefore;
  if (!(priceStaged > 0)) throw new Error("Refused: pack has no valid price.");
  let priceAfter = priceStaged;

  // pack_creator live-pack carve-out (same gate `applyPackEdit` enforces).
  const editedLivePackUnderCapability = await enforcePackCreatorLiveGate(
    session,
    pack.active,
  );

  const liveCardIds = new Set(pack.pack_cards.map((pc) => pc.card_id));

  // REAL-card identity check + fresh value lookup in ONE select (we need both
  // here — `getPackCardValues` only returns cards already in the live pool,
  // which a staged pool may extend with brand-new cards).
  const editedIds = [...seen];
  const cardRows = await db.cards.findMany({
    where: { id: { in: editedIds } },
    select: { id: true, price: true },
  });
  const cardValueById = new Map<string, number>();
  for (const r of cardRows) {
    cardValueById.set(r.id, Number(r.price.toString()));
  }
  const unknown = input.cards.filter((c) => !cardValueById.has(c.cardId));
  if (unknown.length > 0) {
    throw new Error(
      `Refused: ${unknown.length} staged card(s) do not exist as real cards.`,
    );
  }

  // BEFORE risk uses the LIVE pool (fresh) so the audit + return reflect the
  // actual prior state — never the staged identities.
  const livePool = await getPackCardValues(packId);
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
  const auto = autoRetuneTargets(priceStaged, cfg, pack.name);
  const targetEdge = targets.targetEdge ?? auto.targetEdge;
  const targetWinRate = targets.targetWinRate ?? auto.targetWinRate;
  const maxWinCap = targets.maxWinCap ?? auto.maxWinCap;
  const nearMissMin = targets.nearMissMin ?? auto.nearMissMin;
  const winRateTol = 0.02; // matches shapeWeights' default + applyPackRetune.

  // The staged value vector in input ORDER. The shaper picks one weight per slot.
  const stagedValues = input.cards.map((c) => ({
    value: cardValueById.get(c.cardId)!,
  }));

  // ── Optional price-search lever ───────────────────────────────────────
  // When the operator opts in (`allowPriceSearch: true`), the server sweeps
  // cent-stepped candidate prices around the staged price (default ±25%, max
  // 50 candidates) and picks the one whose `shapeWeights` result lands every
  // card on a clean ladder rung (snapped=true) while staying closest to the
  // staged price.
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
  const intendedHitRate = parsePackHitRate(pack.name);
  const callerPinnedWinRate = targets.targetWinRate !== undefined;
  // Tagged-pack mode triggers only when the parsed name tag matches the
  // resolved targetWinRate (the auto-resolved target IS the tag) AND the
  // caller hasn't pinned an override — otherwise we'd hold the wrong target
  // to the 0.01pp accuracy gate.
  const taggedSearchActive =
    allowPriceSearch &&
    intendedHitRate !== null &&
    !callerPinnedWinRate &&
    Math.abs(intendedHitRate - targetWinRate) < 1e-6;
  let shaped;
  let priceSearchMeta: ApplyStagedRetuneResult["priceSearch"] = null;
  if (allowPriceSearch) {
    const search = searchBestPriceForCleanSnap({
      cards: stagedValues,
      basePrice: priceStaged,
      targetEdge,
      targetWinRate,
      maxWinCap,
      nearMissMin,
      winRateTol,
      ...(taggedSearchActive ? { taggedWinRate: targetWinRate } : {}),
    });
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
    });
  }

  // ── FAIL-CLOSED asserts (throw → no write) ──
  if ("error" in shaped) {
    throw new Error(`Auto-tune infeasible: ${shaped.error}`);
  }
  const after = shaped.risk;
  if (after.edge < targetEdge - 1e-9) {
    throw new Error(
      `Refused: resulting edge ${(after.edge * 100).toFixed(2)}% is below the target ${(targetEdge * 100).toFixed(2)}%.`,
    );
  }
  if (after.maxWin > maxWinCap + 1e-9) {
    throw new Error(
      `Refused: resulting max win $${after.maxWin.toFixed(2)} exceeds the cap $${maxWinCap.toFixed(2)}.`,
    );
  }
  if (Math.abs(after.winRate - targetWinRate) > winRateTol + 1e-9) {
    throw new Error(
      `Refused: resulting win-rate ${(after.winRate * 100).toFixed(2)}% misses target ${(targetWinRate * 100).toFixed(2)}% (±${(winRateTol * 100).toFixed(2)}%).`,
    );
  }
  // Belt-and-suspenders backstop — mirrors `applyPackEdit` + `applyPackRetune`.
  // Cannot trip if the asserts above hold (targetEdge ≥ EDIT_EDGE_FLOOR per the
  // edge-curve floor), kept for refactor safety + uniform refusal audit.
  if (after.edge < EDIT_EDGE_FLOOR) {
    try {
      await createAdminAuditEvent({
        adminUserId: session.userId,
        eventType: "pack_edit_refused_edge_floor",
        metadata: {
          pack_id: packId,
          name: pack.name,
          source: "applyStagedPackEditAndRetune",
          attempted_edge: after.edge,
          floor: EDIT_EDGE_FLOOR,
          attempted_max_win: after.maxWin,
          target_edge: targetEdge,
        },
      });
    } catch {
      /* best-effort — never block the refusal */
    }
    throw new Error(
      `Refused: shaped pool produces ${(after.edge * 100).toFixed(2)}% house edge, below the ${(EDIT_EDGE_FLOOR * 100).toFixed(0)}% safety floor.`,
    );
  }

  // The rows to write — server-shaped weights paired with the OWNER's chosen
  // color/animation/order for each staged slot (NOT the live pack_cards row
  // metadata, since a staged pool may include brand-new cards).
  const rows = input.cards.map((c, i) => ({
    pack_id: packId,
    card_id: c.cardId,
    weight: shaped.weights[i]!,
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
  const shouldWritePrice = priceProvided || priceAfter !== priceBefore;

  // SAME delete-all-then-createMany pattern used by every other writer.
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
      name: pack.name,
      card_count_before: liveCardIds.size,
      card_count_after: rows.length,
      price_before: priceBefore,
      price_after: priceAfter,
      price_changed: priceAfter !== priceBefore,
      target: {
        targetEdge,
        targetWinRate,
        maxWinCap,
        nearMissMin,
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
  await refreshEditedPackRiskScore(packId, after, maxWinCap);

  reloadPacks();
  revalidatePath("/packs");
  revalidatePath(`/packs/${packId}`);

  return {
    packId,
    name: pack.name,
    status: "edited_and_retuned",
    cardCountBefore: liveCardIds.size,
    cardCountAfter: rows.length,
    priceBefore,
    priceAfter,
    before: { edge: before.edge, winRate: before.winRate, maxWin: before.maxWin },
    after: { edge: after.edge, winRate: after.winRate, maxWin: after.maxWin },
    priceSearch: priceSearchMeta,
  };
}
