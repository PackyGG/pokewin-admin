"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { adminDb } from "@/lib/admin-db";
import { Prisma } from "@/generated/admin-prisma/client";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import { isUuid } from "@/lib/utils/ids";
import { requirePackStudioAccess } from "@/lib/require-pack-studio-access";
import {
  isPackStudioRetuneOperator,
  isPackStudioRetuneOperatorNonOwner,
} from "@/lib/reprice-access";
import { signRetuneToken } from "@/lib/reprice-token";

import {
  computePackRisk,
  type PackRisk,
} from "@/app/(admin)/insights/edge-calc/risk";
import {
  planPackReprice,
  clampRepriceTarget,
  REPRICE_TARGET_DEFAULT,
} from "@/app/(admin)/insights/edge-calc/math";
import {
  autoTargetEdge,
  DEFAULT_EDGE_CURVE,
  readEdgeCurveConfig,
  type EdgeCurveConfig,
} from "@/app/(admin)/packs/_lib/risk-config";

import {
  applyPackEdit,
  getPackEditPool,
  type EditPoolCard,
  type EditPoolInputCard,
  type ApplyPackEditResult,
  type WriteRefusal,
} from "@/app/(pack-studio)/pack-studio/doctor/retune-actions";

import {
  planPackRetune,
  type PackRetuneTargets,
} from "@/app/(admin)/packs/actions";
import { getPacksPoolComposition } from "@/lib/queries/packs";

/**
 * Pack Studio — RETUNE / EDIT / REPRICE DRAFTS (staging layer).
 *
 * One pending DRAFT per source pack — the operator stages a retune / edit /
 * reprice on a draft, and only `pushDraftToProd` / `pushAllDrafts` ever touch
 * MAIN. Every push wraps the existing paranoid `applyPackEdit` so the
 * server-side EDIT_EDGE_FLOOR, fresh re-read, transactional pack_cards write,
 * snapshot, audit, and ADMIN risk-row refresh all still fire.
 *
 * Gate: `isPackStudioRetuneOperator` (owners + demee) on EVERY action AND on
 * the page. Per owner request (2026-06-27), this surface carries NO 2FA — the
 * operator-allowlist 2FA bypass that already exists for non-owner operators
 * (`isPackStudioRetuneOperatorNonOwner` in `src/lib/reprice-access.ts`) is
 * extended here to OWNERS too: the draft push mints a synthetic retune token
 * internally (`signRetuneToken`) so `applyPackEdit`'s `verifyRetuneToken` is
 * satisfied without prompting TOTP. The push audit metadata flags this
 * (`via_no_2fa_draft_push: true`) so a review can separate draft pushes from
 * direct retune writes.
 *
 * Strict dual-DB discipline:
 *   • Every draft mutation writes ADMIN-DB only.
 *   • Reads of source pack state (seed, auto-retune plan, auto-reprice plan)
 *     go through existing READ-ONLY MAIN helpers (`getPackEditPool`,
 *     `planPackRetune`, `getPacksPoolComposition`).
 *   • Only `pushDraftToProd` writes MAIN, and only via the existing
 *     `applyPackEdit` writer.
 */

// ─── Shared validators ──────────────────────────────────────────────────

/**
 * EditPoolInputCard mirror — Zod-validated on every write so a buggy client
 * payload can't put malformed JSON into the JSONB column. Mirrors the
 * `Number.isInteger + > 0` weight rule `applyPackEdit` enforces.
 */
const editPoolCardSchema = z.object({
  cardId: z.string().uuid(),
  weight: z.number().int().positive(),
  color: z.string().nullable().optional(),
  animation: z.boolean().optional(),
  order: z.number().int().nonnegative(),
});

const editPoolArraySchema = z
  .array(editPoolCardSchema)
  .min(1, "Pool must contain at least one card");

const updateDraftInputSchema = z.object({
  pool: editPoolArraySchema,
  price: z.number().positive().optional(),
  notes: z.string().max(2000).optional(),
});

// ─── Internal helpers ───────────────────────────────────────────────────

/**
 * Operator + Pack-Studio gate shared by every action in this file. Owners and
 * the hard-coded retune operator allowlist (`isPackStudioRetuneOperator` —
 * owners + demee) pass; everyone else gets a thrown error the UI can surface.
 * NO TOTP gate anywhere on this surface (per owner request).
 */
async function requireDraftOperator() {
  const session = await requirePackStudioAccess(
    "Not authorized to access the pack draft tools.",
  );
  if (!isPackStudioRetuneOperator(session)) {
    throw new Error(
      "The pack draft tools are restricted to authorized operators.",
    );
  }
  return session;
}

/** Best-effort audit — never block a write on audit availability. */
async function tryAudit(
  adminUserId: string,
  eventType: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await createAdminAuditEvent({ adminUserId, eventType, metadata });
  } catch {
    /* swallow */
  }
}

/** Convert a fresh `EditPoolCard[]` into the JSONB-safe pool shape. */
function poolFromEditCards(cards: EditPoolCard[]): EditPoolInputCard[] {
  return cards.map((c) => ({
    cardId: c.cardId,
    weight: c.weight,
    color: c.color ?? undefined,
    animation: c.animation,
    order: c.order,
  }));
}

/** Compute `PackRisk` for a pool + price using the captured per-card values. */
function riskForPool(
  pool: EditPoolInputCard[],
  valueByCard: Map<string, number>,
  price: number,
): PackRisk {
  return computePackRisk({
    cards: pool.map((c) => ({
      value: valueByCard.get(c.cardId) ?? 0,
      weight: c.weight,
    })),
    price,
  });
}

/** Map source `EditPool` → `source_snapshot` JSON for the diff UI. */
function buildSourceSnapshot(source: Awaited<ReturnType<typeof getPackEditPool>>) {
  // PackRisk for the source pack at its current price — best-effort.
  let risk: PackRisk | null = null;
  try {
    risk = computePackRisk({
      cards: source.cards.map((c) => ({ value: c.value, weight: c.weight })),
      price: source.price,
    });
  } catch {
    risk = null;
  }
  return {
    name: source.name,
    slug: source.slug,
    packType: source.packType,
    active: source.active,
    price: source.price,
    pool: source.cards.map((c) => ({
      cardId: c.cardId,
      name: c.name,
      imageUrl: c.imageUrl,
      value: c.value,
      weight: c.weight,
      color: c.color,
      animation: c.animation,
      order: c.order,
    })),
    risk,
  };
}

/** Pull a `valueByCard` lookup out of a source_snapshot JSON blob. */
function valueByCardFromSnapshot(
  snapshot: Prisma.JsonValue,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
    return out;
  const pool = (snapshot as Record<string, unknown>).pool;
  if (!Array.isArray(pool)) return out;
  for (const raw of pool) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const cardId = typeof r.cardId === "string" ? r.cardId : null;
    const value =
      typeof r.value === "number" && Number.isFinite(r.value) ? r.value : 0;
    if (cardId) out.set(cardId, value);
  }
  return out;
}

// ─── Public types ───────────────────────────────────────────────────────

export type SeedDraftResult = {
  draftId: string;
  /** True when a fresh draft row was created; false when an existing pending draft was returned. */
  created: boolean;
};

export type BulkSeedScope = {
  /**
   * When true (default), only ACTIVE official cash packs with price > 0 are
   * seeded — matches the scope `planRepriceAllPacks` / `planAllRetunes` use.
   */
  onlyActiveCashPacks?: boolean;
};

export type BulkSeedResult = {
  seeded: number;
  skipped: number;
  errors: { packId: string; error: string }[];
};

export type UpdateDraftResult = {
  draftId: string;
  risk: PackRisk;
};

export type ApplyAutoRetuneToDraftResult = {
  draftId: string;
  risk: PackRisk;
  feasible: boolean;
  error?: string;
};

export type AutoRepriceMode = {
  /** Explicit flat target edge (e.g. 0.1099) OR `"per-pack"` for the edge curve. */
  targetEdge?: number | "per-pack";
};

export type ApplyAutoRepriceToDraftResult = {
  draftId: string;
  newPrice: number;
  newEdge: number;
  action: "reprice" | "unchanged" | "skip";
  reason?: string;
};

export type DiscardDraftResult = { draftId: string };

export type PushDraftSummary = {
  edge: number;
  winRate: number;
  maxWin: number;
  price: number;
};

export type PushDraftResult = {
  packId: string;
  draftId: string;
  status: "pushed";
  before: PushDraftSummary;
  after: PushDraftSummary;
};

export type PushAllDraftsResult = {
  pushed: PushDraftResult[];
  failed: { packId: string; draftId: string | null; error: string }[];
};
type DraftWriteRefusal = { refusedMessage: string };

// ─── seedDraftForPack ───────────────────────────────────────────────────

/**
 * Seed a pending DRAFT row mirroring the current MAIN state of `packId`.
 * Reads MAIN via the existing read-only `getPackEditPool`, captures
 * { price, pool, risk } into `source_snapshot`, seeds `proposed_price` +
 * `proposed_pool` from the source verbatim, computes `computed_risk` once.
 * Writes ADMIN-DB only.
 *
 * Idempotent: when a pending draft already exists for the pack (enforced by
 * the `pack_retune_drafts_one_pending_per_pack` partial unique index), returns
 * { draftId: existing.id, created: false } instead of throwing — the UI opens
 * the existing draft rather than seeding a duplicate.
 */
export async function seedDraftForPack(
  packId: string,
): Promise<SeedDraftResult> {
  const session = await requireDraftOperator();
  if (!isUuid(packId)) throw new Error("Invalid pack id");

  // READ MAIN (read-only) — pool + price + identity for the source snapshot.
  // `getPackEditPool` already gates on `requireRetuneOwner` internally, so
  // re-running it here is safe + free of an extra MAIN write surface.
  const source = await getPackEditPool(packId);
  const proposedPool: EditPoolInputCard[] = poolFromEditCards(source.cards);
  const valueByCard = new Map(source.cards.map((c) => [c.cardId, c.value]));
  const computedRisk = riskForPool(proposedPool, valueByCard, source.price);
  const sourceSnapshot = buildSourceSnapshot(source);

  try {
    const row = await adminDb.pack_retune_drafts.create({
      data: {
        pack_id: packId,
        status: "draft",
        proposed_price: source.price,
        proposed_pool: proposedPool as unknown as Prisma.InputJsonValue,
        computed_risk: computedRisk as unknown as Prisma.InputJsonValue,
        source_snapshot: sourceSnapshot as unknown as Prisma.InputJsonValue,
        created_by: session.userId,
        last_edited_by: session.userId,
      },
      select: { id: true },
    });

    await tryAudit(session.userId, "pack_draft_seeded", {
      pack_id: packId,
      draft_id: row.id,
      via: "drafts",
    });
    revalidatePath("/pack-studio/drafts");
    revalidateTag("pack-retune-drafts");
    return { draftId: row.id, created: true };
  } catch (err) {
    // Partial-unique collision → a pending draft already exists. Return its id.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const existing = await adminDb.pack_retune_drafts.findFirst({
        where: { pack_id: packId, status: "draft" },
        select: { id: true },
      });
      if (existing) {
        return { draftId: existing.id, created: false };
      }
    }
    throw err;
  }
}

// ─── bulkSeedAllActiveDrafts ────────────────────────────────────────────

/**
 * Seed a draft for every in-scope pack that doesn't already have a pending
 * draft. Defaults to the SAME scope `planRepriceAllPacks` / `planAllRetunes`
 * use: ACTIVE official cash packs with price > 0.
 *
 * Sequential per-pack `seedDraftForPack` calls — a small N (≤ ~200 packs)
 * keeps wall-clock under the function budget, and per-pack failures are
 * collected, never abort the run. A single bulk audit event summarizes the
 * counts on top of the per-pack `pack_draft_seeded` events.
 *
 * Reads MAIN read-only; writes ADMIN-DB only.
 */
export async function bulkSeedAllActiveDrafts(
  scope?: BulkSeedScope,
): Promise<BulkSeedResult> {
  const session = await requireDraftOperator();
  const onlyActiveCashPacks = scope?.onlyActiveCashPacks ?? true;

  // `getPacksPoolComposition()` (no args) already returns ACTIVE official packs
  // with price > 0 — the canonical in-scope set the live tools sweep. When the
  // caller widens the scope to "every pack", reuse the same query with no
  // packIds filter (it's still the same scope today; widening would require a
  // dedicated query, deferred).
  const comps = await getPacksPoolComposition();
  const inScope = onlyActiveCashPacks
    ? comps.filter((p) => p.active && p.price > 0)
    : comps;

  // Drop packs that already have a pending draft so we don't churn through
  // them on every bulk-seed click.
  const ids = inScope.map((p) => p.id).filter((id) => isUuid(id));
  if (ids.length === 0) {
    return { seeded: 0, skipped: 0, errors: [] };
  }
  const existing = await adminDb.pack_retune_drafts.findMany({
    where: { pack_id: { in: ids }, status: "draft" },
    select: { pack_id: true },
  });
  const alreadyPending = new Set(existing.map((r) => r.pack_id));

  let seeded = 0;
  let skipped = alreadyPending.size;
  const errors: { packId: string; error: string }[] = [];

  for (const packId of ids) {
    if (alreadyPending.has(packId)) continue;
    try {
      const r = await seedDraftForPack(packId);
      if (r.created) seeded += 1;
      else skipped += 1;
    } catch (err) {
      errors.push({
        packId,
        error: err instanceof Error ? err.message : "Seed failed",
      });
    }
  }

  await tryAudit(session.userId, "pack_drafts_bulk_seeded", {
    via: "drafts",
    scope: onlyActiveCashPacks ? "active_cash_packs" : "all",
    seeded,
    skipped,
    error_count: errors.length,
  });
  revalidatePath("/pack-studio/drafts");
  revalidateTag("pack-retune-drafts");

  return { seeded, skipped, errors };
}

// ─── updateDraftPool ────────────────────────────────────────────────────

/**
 * Update a pending draft's proposed pool / price / notes. Validates the pool
 * with the same per-card rules `applyPackEdit` enforces (uuid cardId, positive
 * int weight, no duplicates, ≥ 1 card, non-negative order). Recomputes
 * `computed_risk` against the captured `source_snapshot` card values so the
 * cached risk can never drift from the proposed pool/price.
 *
 * ADMIN-DB only — no MAIN read or write.
 */
export async function updateDraftPool(
  packId: string,
  input: {
    pool: EditPoolInputCard[];
    price?: number;
    notes?: string;
  },
): Promise<UpdateDraftResult> {
  const session = await requireDraftOperator();
  if (!isUuid(packId)) throw new Error("Invalid pack id");

  const parsed = updateDraftInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid draft input");
  }
  const { pool, price, notes } = parsed.data;

  // Reject duplicate cardIds in the same pool.
  const seenIds = new Set<string>();
  for (const c of pool) {
    if (seenIds.has(c.cardId)) {
      throw new Error("Refused: the edited pool has a duplicate card.");
    }
    seenIds.add(c.cardId);
  }

  const existing = await adminDb.pack_retune_drafts.findFirst({
    where: { pack_id: packId, status: "draft" },
    select: {
      id: true,
      proposed_price: true,
      source_snapshot: true,
    },
  });
  if (!existing) throw new Error("No pending draft for this pack.");

  const valueByCard = valueByCardFromSnapshot(existing.source_snapshot);
  const nextPrice = price ?? Number(existing.proposed_price.toString());
  if (!(nextPrice > 0)) {
    throw new Error("Refused: price must be greater than 0.");
  }
  const computedRisk = riskForPool(
    pool as EditPoolInputCard[],
    valueByCard,
    nextPrice,
  );

  await adminDb.pack_retune_drafts.update({
    where: { id: existing.id },
    data: {
      proposed_pool: pool as unknown as Prisma.InputJsonValue,
      proposed_price: nextPrice,
      computed_risk: computedRisk as unknown as Prisma.InputJsonValue,
      last_edited_by: session.userId,
      ...(notes !== undefined ? { notes } : {}),
    },
  });

  await tryAudit(session.userId, "pack_draft_edited", {
    pack_id: packId,
    draft_id: existing.id,
    via: "drafts",
    pool_size: pool.length,
    new_price: nextPrice,
  });
  revalidatePath("/pack-studio/drafts");
  revalidateTag("pack-retune-drafts");

  return { draftId: existing.id, risk: computedRisk };
}

// ─── applyAutoRetuneToDraft ─────────────────────────────────────────────

/**
 * Run the existing READ-ONLY `planPackRetune` against MAIN and write the
 * result into the draft. Same shaper, same auto-targets, NO MAIN write. The
 * resulting plan may be infeasible — we store the proposed pool anyway when
 * feasible and surface the verdict so the UI can warn before push.
 *
 * The plan's `weightDiff` is sparse (only changed cards). We carry through
 * the unchanged cards from the source_snapshot.pool so `proposed_pool` is a
 * COMPLETE pool ready to write to MAIN on push.
 */
export async function applyAutoRetuneToDraft(
  packId: string,
  targets?: PackRetuneTargets,
): Promise<ApplyAutoRetuneToDraftResult> {
  const session = await requireDraftOperator();
  if (!isUuid(packId)) throw new Error("Invalid pack id");

  const existing = await adminDb.pack_retune_drafts.findFirst({
    where: { pack_id: packId, status: "draft" },
    select: {
      id: true,
      proposed_price: true,
      proposed_pool: true,
      source_snapshot: true,
    },
  });
  if (!existing) throw new Error("No pending draft for this pack.");

  // READ-ONLY MAIN dry-run via the existing planner (owner/operator-gated).
  const plan = await planPackRetune(packId, targets ?? {});

  if (!plan.feasible || plan.after === null) {
    return {
      draftId: existing.id,
      risk: plan.before,
      feasible: false,
      error: plan.error ?? "Auto-retune infeasible.",
    };
  }

  // Merge the sparse weightDiff into the current proposed_pool (or, on a
  // first-pass, the source_snapshot.pool) so we ship a COMPLETE pool.
  const basePool = Array.isArray(existing.proposed_pool)
    ? (existing.proposed_pool as unknown as EditPoolInputCard[])
    : [];
  const weightById = new Map(plan.weightDiff.map((d) => [d.cardId, d.to]));
  const nextPool: EditPoolInputCard[] = basePool.map((c) =>
    weightById.has(c.cardId) ? { ...c, weight: weightById.get(c.cardId)! } : c,
  );

  // Recompute risk against the captured source card values + the draft price.
  const valueByCard = valueByCardFromSnapshot(existing.source_snapshot);
  const price = Number(existing.proposed_price.toString());
  const computedRisk = riskForPool(nextPool, valueByCard, price);

  await adminDb.pack_retune_drafts.update({
    where: { id: existing.id },
    data: {
      proposed_pool: nextPool as unknown as Prisma.InputJsonValue,
      computed_risk: computedRisk as unknown as Prisma.InputJsonValue,
      last_edited_by: session.userId,
    },
  });

  await tryAudit(session.userId, "pack_draft_auto_retuned", {
    pack_id: packId,
    draft_id: existing.id,
    via: "drafts",
    targets: targets ?? null,
    intended_hit_rate: plan.intendedHitRate,
    target_win_rate: plan.targetWinRate,
  });
  revalidatePath("/pack-studio/drafts");
  revalidateTag("pack-retune-drafts");

  return { draftId: existing.id, risk: computedRisk, feasible: true };
}

// ─── applyAutoRepriceToDraft ────────────────────────────────────────────

/**
 * Run the existing `planPackReprice` math against MAIN (read-only via
 * `getPacksPoolComposition`) and update only the draft's `proposed_price`.
 * Pool stays as-is; risk is recomputed at the new price against the existing
 * proposed_pool (price-only change leaves identities + weights intact).
 *
 * `mode.targetEdge` selects the target:
 *   • a number — flat owner-chosen target.
 *   • "per-pack" — derive from the pack's edge curve (`autoTargetEdge`).
 *   • omitted — defaults to `REPRICE_TARGET_DEFAULT` (10.99%).
 */
export async function applyAutoRepriceToDraft(
  packId: string,
  mode?: AutoRepriceMode,
): Promise<ApplyAutoRepriceToDraftResult> {
  const session = await requireDraftOperator();
  if (!isUuid(packId)) throw new Error("Invalid pack id");

  const existing = await adminDb.pack_retune_drafts.findFirst({
    where: { pack_id: packId, status: "draft" },
    select: {
      id: true,
      proposed_price: true,
      proposed_pool: true,
      source_snapshot: true,
    },
  });
  if (!existing) throw new Error("No pending draft for this pack.");

  // Fresh aggregate composition (read-only MAIN) — same path the live reprice
  // tool uses. Throws on a missing pack rather than silently no-oping.
  const [comp] = await getPacksPoolComposition({ packIds: [packId] });
  if (!comp) throw new Error("Pack not found for reprice.");

  const targetEdgeArg = mode?.targetEdge ?? REPRICE_TARGET_DEFAULT;
  let edgeCurve: EdgeCurveConfig = DEFAULT_EDGE_CURVE;
  let resolvedTarget: number;
  if (targetEdgeArg === "per-pack") {
    edgeCurve = await readEdgeCurveConfig();
    resolvedTarget = clampRepriceTarget(
      autoTargetEdge(
        { price: comp.price, maxWin: comp.maxValue },
        edgeCurve,
      ),
    );
  } else {
    if (
      !Number.isFinite(targetEdgeArg) ||
      targetEdgeArg <= 0 ||
      targetEdgeArg >= 1
    ) {
      throw new Error("Invalid target edge.");
    }
    resolvedTarget = clampRepriceTarget(targetEdgeArg);
  }

  const plan = planPackReprice({
    currentPrice: comp.price,
    cardsPerOpen: comp.cardsPerOpen,
    totalWeight: comp.totalWeight,
    weightedPriceSum: comp.weightedPriceSum,
    targetEdge: resolvedTarget,
    // Mirror the live reprice writer's "up" mode — never overcharge to force
    // a fit; the chosen cent's edge is ALWAYS ≥ target.
    roundingMode: "up",
  });

  if (
    plan.action !== "reprice" ||
    plan.newPrice === null ||
    plan.newEdge === null
  ) {
    return {
      draftId: existing.id,
      newPrice: comp.price,
      newEdge: plan.currentEdge,
      action: plan.action,
      reason: plan.reason,
    };
  }

  // Recompute risk at the new price against the existing proposed_pool.
  const valueByCard = valueByCardFromSnapshot(existing.source_snapshot);
  const pool = Array.isArray(existing.proposed_pool)
    ? (existing.proposed_pool as unknown as EditPoolInputCard[])
    : [];
  const computedRisk = riskForPool(pool, valueByCard, plan.newPrice);

  await adminDb.pack_retune_drafts.update({
    where: { id: existing.id },
    data: {
      proposed_price: plan.newPrice,
      computed_risk: computedRisk as unknown as Prisma.InputJsonValue,
      last_edited_by: session.userId,
    },
  });

  await tryAudit(session.userId, "pack_draft_auto_repriced", {
    pack_id: packId,
    draft_id: existing.id,
    via: "drafts",
    target_edge: resolvedTarget,
    target_mode: targetEdgeArg === "per-pack" ? "per-pack" : "flat",
    price_before: comp.price,
    price_after: plan.newPrice,
    edge_before: plan.currentEdge,
    edge_after: plan.newEdge,
  });
  // `edgeCurve` is informational on the audit-time read; not surfaced here.
  void edgeCurve;

  revalidatePath("/pack-studio/drafts");
  revalidateTag("pack-retune-drafts");

  return {
    draftId: existing.id,
    newPrice: plan.newPrice,
    newEdge: plan.newEdge,
    action: "reprice",
  };
}

// ─── discardDraft ───────────────────────────────────────────────────────

/**
 * Discard a pending draft — flips status to 'discarded' so the row survives
 * for audit and a fresh draft for the same pack can be seeded immediately
 * (the partial unique index only constrains `status='draft'`). Optionally
 * appends a reason to `notes`.
 *
 * ADMIN-DB only.
 */
export async function discardDraft(
  packId: string,
  reason?: string,
): Promise<DiscardDraftResult> {
  const session = await requireDraftOperator();
  if (!isUuid(packId)) throw new Error("Invalid pack id");

  const existing = await adminDb.pack_retune_drafts.findFirst({
    where: { pack_id: packId, status: "draft" },
    select: { id: true, notes: true },
  });
  if (!existing) throw new Error("No pending draft for this pack.");

  const nextNotes =
    reason && reason.trim().length > 0
      ? `${existing.notes ? `${existing.notes}\n` : ""}[discarded] ${reason.trim()}`
      : existing.notes;

  await adminDb.pack_retune_drafts.update({
    where: { id: existing.id },
    data: {
      status: "discarded",
      discarded_at: new Date(),
      discarded_by: session.userId,
      last_edited_by: session.userId,
      ...(nextNotes !== existing.notes ? { notes: nextNotes } : {}),
    },
  });

  await tryAudit(session.userId, "pack_draft_discarded", {
    pack_id: packId,
    draft_id: existing.id,
    via: "drafts",
    reason: reason ?? null,
  });
  revalidatePath("/pack-studio/drafts");
  revalidateTag("pack-retune-drafts");

  return { draftId: existing.id };
}

// ─── pushDraftToProd (THE ONLY MAIN-WRITE PATH) ─────────────────────────

/**
 * Push a pending draft to MAIN. Internally:
 *   1. Loads the draft (must be status='draft').
 *   2. Mints a synthetic retune token via `signRetuneToken(session.userId)`
 *      — bypasses the TOTP prompt (NO 2FA on this surface per owner request).
 *   3. Calls `applyPackEdit(packId, syntheticToken, { cards, price })` —
 *      THE existing paranoid live writer (fresh MAIN re-read, every cardId
 *      validated, before/after risk, EDIT_EDGE_FLOOR backstop,
 *      pack_state_snapshots capture, transactional pack_cards delete-all-
 *      then-createMany, audit `pack_edited_via_retune`, ADMIN risk-row
 *      refresh).
 *   4. On success, flips the draft to status='pushed' and stamps push
 *      metadata.
 *
 * Any failure inside `applyPackEdit` bubbles up verbatim and the draft stays
 * in 'draft' status — the operator can fix and re-push.
 *
 * REFUSALS ARE DATA, NOT THROWS (incident 2026-07-11): the exported action
 * catches inner throws and returns `{ refusedMessage }` so the drafts client
 * sees the real reason in prod (Next.js masks server-action throws).
 */
export async function pushDraftToProd(
  packId: string,
): Promise<PushDraftResult | DraftWriteRefusal> {
  try {
    return await pushDraftToProdInner(packId);
  } catch (err) {
    unstable_rethrow(err);
    return {
      refusedMessage:
        err instanceof Error ? err.message : "The push failed unexpectedly.",
    };
  }
}
async function pushDraftToProdInner(
  packId: string,
): Promise<PushDraftResult> {
  const session = await requireDraftOperator();
  if (!isUuid(packId)) throw new Error("Invalid pack id");

  const draft = await adminDb.pack_retune_drafts.findFirst({
    where: { pack_id: packId, status: "draft" },
    select: {
      id: true,
      proposed_price: true,
      proposed_pool: true,
    },
  });
  if (!draft) throw new Error("No pending draft for this pack.");

  const pool = Array.isArray(draft.proposed_pool)
    ? (draft.proposed_pool as unknown as EditPoolInputCard[])
    : [];
  if (pool.length === 0) {
    throw new Error("Refused: draft has no cards to push.");
  }
  const price = Number(draft.proposed_price.toString());

  // NO 2FA — owner-allowed bypass for the draft push surface (operators +
  // owners both skip TOTP here). Mint a synthetic retune token internally so
  // `applyPackEdit`'s `verifyRetuneToken` is satisfied.
  const token = await signRetuneToken(session.userId);

  // THE ONLY MAIN WRITE — runs through `applyPackEdit`'s full guard rail.
  // applyPackEdit returns `{ refusedMessage }` instead of throwing (incident
  // 2026-07-11 fix) — propagate it so the client sees the real reason.
  const writeResult: ApplyPackEditResult | WriteRefusal = await applyPackEdit(
    packId,
    token,
    { cards: pool, price },
  );
  if ("refusedMessage" in writeResult) {
    throw new Error(writeResult.refusedMessage);
  }
  const result: ApplyPackEditResult = writeResult;

  // Flip the draft to 'pushed' (kept as audit). Best-effort wrt admin-DB: the
  // MAIN write already committed, so a failure here is logged but NOT thrown.
  try {
    await adminDb.pack_retune_drafts.update({
      where: { id: draft.id },
      data: {
        status: "pushed",
        pushed_at: new Date(),
        pushed_by: session.userId,
        last_edited_by: session.userId,
      },
    });
  } catch (err) {
    console.error("pushDraftToProd: draft status flip failed", err);
  }

  await tryAudit(session.userId, "pack_draft_pushed", {
    pack_id: packId,
    draft_id: draft.id,
    via: "drafts",
    // Flag the deliberate owner-2FA-bypass so an audit review can separate
    // draft pushes from direct retune writes. Also stamp the operator-
    // allowlist bypass when applicable (so the existing flag stays consistent
    // with `applyPackEdit`'s own audit).
    via_no_2fa_draft_push: true,
    ...(isPackStudioRetuneOperatorNonOwner(session) && {
      via_no_2fa_allowlist: true,
    }),
    price_before: result.priceBefore,
    price_after: result.priceAfter,
    edge_before: result.before.edge,
    edge_after: result.after.edge,
  });

  revalidatePath("/pack-studio/drafts");
  revalidateTag("pack-retune-drafts");

  return {
    packId,
    draftId: draft.id,
    status: "pushed",
    before: {
      edge: result.before.edge,
      winRate: result.before.winRate,
      maxWin: result.before.maxWin,
      price: result.priceBefore,
    },
    after: {
      edge: result.after.edge,
      winRate: result.after.winRate,
      maxWin: result.after.maxWin,
      price: result.priceAfter,
    },
  };
}

// ─── pushAllDrafts ──────────────────────────────────────────────────────

/**
 * Push every status='draft' row to MAIN. Sequential — `applyPackEdit` is
 * per-pack atomic and the operator surface is rare-use, so we keep the loop
 * serial to avoid hammering MAIN. Per-pack failures are collected and never
 * abort the run. Each per-pack push mints its own synthetic token (no shared
 * token state to worry about).
 */
export async function pushAllDrafts(): Promise<
  PushAllDraftsResult | DraftWriteRefusal
> {
  try {
    return await pushAllDraftsInner();
  } catch (err) {
    unstable_rethrow(err);
    return {
      refusedMessage:
        err instanceof Error ? err.message : "The push failed unexpectedly.",
    };
  }
}
async function pushAllDraftsInner(): Promise<PushAllDraftsResult> {
  const session = await requireDraftOperator();

  const drafts = await adminDb.pack_retune_drafts.findMany({
    where: { status: "draft" },
    orderBy: { last_edited_at: "desc" },
    select: { id: true, pack_id: true },
  });

  const pushed: PushDraftResult[] = [];
  const failed: { packId: string; draftId: string | null; error: string }[] = [];

  for (const d of drafts) {
    try {
      const r = await pushDraftToProdInner(d.pack_id);
      pushed.push(r);
    } catch (err) {
      unstable_rethrow(err);
      failed.push({
        packId: d.pack_id,
        draftId: d.id,
        error: err instanceof Error ? err.message : "Push failed",
      });
    }
  }

  await tryAudit(session.userId, "pack_drafts_bulk_pushed", {
    via: "drafts",
    via_no_2fa_draft_push: true,
    pushed_count: pushed.length,
    failed_count: failed.length,
    total: drafts.length,
  });

  revalidatePath("/pack-studio/drafts");
  revalidateTag("pack-retune-drafts");

  return { pushed, failed };
}
