"use server";

import { isUuid } from "@/lib/utils/ids";
import { getDb } from "@/lib/db";
import { requirePackStudioAccess } from "@/lib/require-pack-studio-access";
import { isRepriceOwner } from "@/lib/reprice-access";
import { getPacksPoolComposition } from "@/lib/queries/packs";
import { getPackCardValues } from "@/lib/queries/pack-card-values";
import { computePackRisk, type PackRisk } from "@/app/(admin)/insights/edge-calc/risk";
import {
  planPackReprice,
  REPRICE_ACCEPT_TOLERANCE,
  REPRICE_HARD_TOLERANCE,
  type RepriceAction,
} from "@/app/(admin)/insights/edge-calc/math";
import { readMaxWinCap } from "../_lib/risk-config";

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
 *   • planCustomRepin   — a READ-ONLY dry-run for the "Re-pin custom packs to
 *     ≥ target" action: re-derives each below-target CUSTOM pack's round-up
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
  action: RepriceAction;
  reason: string;
};

export type CustomRepinPlan = {
  /** The target edge fraction this plan was computed for. */
  target: number;
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
 * READ-ONLY dry-run for the "Re-pin custom packs to ≥ target" action. Given the
 * candidate CUSTOM pack ids (the below-target customs the doctor grid already
 * surfaced), re-read each pack's FRESH composition from MAIN and re-derive its
 * round-up price/edge via the SAME `planPackReprice` the global re-price uses
 * (round-up scope: a custom pack only ever moves its price UP to reach target).
 *
 * Writes nothing — the operator confirms, then the existing
 * `authorizeReprice` + `repricePackToTargetEdge` loop performs the per-pack
 * 2FA-guarded writes (that single-pack write already accepts `custom` packs).
 * Out-of-scope ids (a pack that's no longer custom/active, or now on target)
 * surface as skipped/unchanged so a stale grid can't force a bad write.
 */
export async function planCustomRepin(
  packIds: string[],
  target: number,
): Promise<CustomRepinPlan> {
  await requireRetuneOwner();

  if (!Number.isFinite(target) || target <= 0 || target >= 1) {
    throw new Error("Invalid target edge.");
  }

  const ids = packIds.filter((id) => isUuid(id));
  const comps = ids.length > 0 ? await getPacksPoolComposition({ packIds: ids }) : [];

  const rows: CustomRepinRow[] = comps.map((p) => {
    // Defense-in-depth: the per-pack write re-checks scope anyway, but skip
    // here too so the preview never promises a write the action would reject.
    if (p.packType !== "custom" || !p.active || !(p.price > 0)) {
      return {
        packId: p.id,
        name: p.name,
        slug: p.slug,
        priceBefore: p.price,
        priceAfter: null,
        edgeBefore: 0,
        edgeAfter: null,
        action: "skip" as RepriceAction,
        reason: !p.active
          ? "Out of scope: pack is not active."
          : p.packType !== "custom"
            ? `Out of scope: not a custom pack ('${p.packType}').`
            : "Out of scope: pack has no price.",
      };
    }
    const plan = planPackReprice({
      currentPrice: p.price,
      cardsPerOpen: p.cardsPerOpen,
      totalWeight: p.totalWeight,
      weightedPriceSum: p.weightedPriceSum,
      targetEdge: target,
    });
    return {
      packId: p.id,
      name: p.name,
      slug: p.slug,
      priceBefore: p.price,
      priceAfter: plan.newPrice,
      edgeBefore: plan.currentEdge,
      edgeAfter: plan.newEdge,
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
    acceptMin: target - REPRICE_ACCEPT_TOLERANCE,
    acceptMax: target + REPRICE_ACCEPT_TOLERANCE,
    hardMin: target - REPRICE_HARD_TOLERANCE,
    hardMax: target + REPRICE_HARD_TOLERANCE,
    toReprice,
    unchanged,
    skipped,
  };
}
