"use server";

import { isUuid } from "@/lib/utils/ids";
import { getDb } from "@/lib/db";
import { requirePackStudioAccess } from "@/lib/require-pack-studio-access";
import { isRepriceOwner } from "@/lib/reprice-access";
import { getPacksPoolComposition } from "@/lib/queries/packs";
import { getPackCardValues } from "@/lib/queries/pack-card-values";
import {
  computePackRisk,
  computePackRiskFromAggregates,
  shapeWeights,
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
  readEdgeCurveConfig,
  readMaxWinCap,
  readMaxMultCeiling,
  readPackSystemConfig,
  type EdgeCurveConfig,
  type ResolvedAutoTargetCfg,
} from "../_lib/risk-config";
import {
  computePortfolioProfile,
  derivePortfolioTargets,
  resolvePortfolioSystemConfig,
  type PortfolioProfile,
  type PortfolioSystemConfig,
  type PortfolioSystemPlan,
  type PortfolioPackInput,
  type PortfolioPackTargets,
} from "../_lib/portfolio";

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

/** Owner + Pack-Studio gate shared by every read in this module. */
async function requireRetuneOwner() {
  const session = await requirePackStudioAccess(
    "Not authorized to access the pack re-tune tools.",
  );
  if (!isRepriceOwner(session)) {
    throw new Error("The pack re-tune tools are restricted to the owner.");
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
): Promise<PlanAllRetunesResult> {
  await requireRetuneOwner();

  // Resolve the auto-target config ONCE for the whole run.
  const cfg: ResolvedAutoTargetCfg = {
    globalCap: await readMaxWinCap(),
    maxMultCeiling: await readMaxMultCeiling(),
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
        pc.weight       AS weight
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

  // Default: every pack on its INDEPENDENT auto-targets. In portfolio mode the
  // system balancer overrides the offenders' targets so the WHOLE catalog lands
  // inside the system bounds; `systemPlan` explains the tightening.
  let targetsByPack: Map<string, PortfolioPackTargets> = new Map(
    inScope.map((p) => [p.id, autoRetuneTargets(p.price, cfg)]),
  );
  let systemPlan: PortfolioSystemPlan | null = null;

  if (mode === "portfolio") {
    const sysCfg = await readPortfolioSystemConfigResolved(cfg);
    const balancerInput: PortfolioPackInput[] = inScope.map((p) => ({
      packId: p.id,
      price: p.price,
      cards: (cardsByPack.get(p.id) ?? []).map((c) => ({ value: c.value })),
      currentRisk: beforeByPack.get(p.id)!,
    }));
    const derived = derivePortfolioTargets(balancerInput, sysCfg);
    targetsByPack = derived.targetsByPack;
    systemPlan = derived.systemPlan;
  }

  const proposals: PlanAllProposal[] = inScope.map((p) => {
    const cards = cardsByPack.get(p.id) ?? [];
    const autoTargets: PortfolioPackTargets =
      targetsByPack.get(p.id) ?? autoRetuneTargets(p.price, cfg);
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
        cards,
        currentWeights,
        autoTargets,
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

    const shaped = shapeWeights({
      cards: cards.map((c) => ({ value: c.value })),
      price: p.price,
      targetEdge: autoTargets.targetEdge,
      targetWinRate: autoTargets.targetWinRate,
      maxWinCap: autoTargets.maxWinCap,
      nearMissMin: autoTargets.nearMissMin,
      floorRatioMin: autoTargets.floorRatioMin,
    });

    if ("error" in shaped) {
      return {
        packId: p.id,
        name: p.name,
        slug: p.slug,
        price: p.price,
        cards,
        currentWeights,
        autoTargets,
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
      cards,
      currentWeights,
      autoTargets,
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
