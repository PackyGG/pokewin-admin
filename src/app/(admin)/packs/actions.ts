"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { adminDb } from "@/lib/admin-db";
import { requirePageAccess, sessionHasRole } from "@/lib/dal";
import { isRepriceOwner } from "@/lib/reprice-access";
import { requireCapability } from "@/lib/require-capability";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import {
  getPackDetail,
  getPackGames,
  getPackStats,
  getPacksPoolComposition,
  REPRICE_INCLUDED_PACK_TYPES,
  type PackStats,
} from "@/lib/queries/packs";
import {
  planPackReprice,
  repriceEdgeWithinHardBand,
  clampRepriceTarget,
  REPRICE_TARGET_DEFAULT,
  REPRICE_TARGET_MIN,
  REPRICE_TARGET_MAX,
  REPRICE_ACCEPT_TOLERANCE,
  REPRICE_HARD_TOLERANCE,
  type RepriceAction,
} from "@/app/(admin)/insights/edge-calc/math";
import { require2FA } from "@/lib/require-2fa";
import { signRepriceToken, verifyRepriceToken } from "@/lib/reprice-token";
import { safeQuery } from "@/lib/errors/safe-query";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { uploadImage } from "@/lib/imagekit";
import { getCards, getRarities, getSets } from "@/lib/queries/cards";
import { reloadPacks } from "@/app/(admin)/rewards/actions";
import type { pack_tag } from "@/generated/prisma/enums";

/**
 * Persists a pack's `shard_cost` via raw SQL. The column is on the dev schema
 * only (not prod), and the shared Prisma client can't type a column that's
 * absent on one DB — so writing it through `packs.create/update` data would
 * be a type error AND would P2022 on prod. Done as a separate post-commit
 * UPDATE (never inside the caller's transaction, so a missing column can't
 * poison it) and swallowed when the column is absent. Intersection-schema +
 * raw pattern, matching the read side in queries/packs.ts.
 */
async function writeShardCost(
  db: Awaited<ReturnType<typeof getDb>>,
  packId: string,
  shardCost: number | null,
): Promise<void> {
  try {
    await db.$executeRawUnsafe(
      `UPDATE packs SET shard_cost = $1 WHERE id = $2`,
      shardCost,
      packId,
    );
  } catch {
    // shard_cost column absent on this DB (e.g. prod) — shard packs aren't
    // supported here, so there's nothing to persist.
  }
}

export type CardPickerItem = {
  id: string;
  name: string;
  imageUrl: string;
  priceUsd: number;
  rarity: string | null;
  setName: string | null;
};

export async function searchCardsForPicker(params: {
  page?: number;
  perPage?: number;
  search?: string;
  rarity?: string;
  setId?: string;
  minPrice?: string;
  maxPrice?: string;
}) {
  await requirePageAccess("/packs");
  const result = await getCards({
    page: params.page,
    perPage: params.perPage,
    search: params.search,
    rarity: params.rarity,
    setId: params.setId,
    minPrice: params.minPrice,
    maxPrice: params.maxPrice,
    sortBy: "name",
    sortOrder: "asc",
  });
  return {
    data: result.data.map((c) => ({
      id: c.id,
      name: c.name,
      imageUrl: c.imageUrl,
      priceUsd: c.priceUsd,
      rarity: c.rarity,
      setName: c.setName,
    })),
    total: result.total,
    page: result.page,
    totalPages: result.totalPages,
  };
}

export async function getCardPickerFilters() {
  await requirePageAccess("/packs");
  const [sets, rarities] = await Promise.all([getSets(), getRarities()]);
  return {
    sets,
    rarities: rarities.filter((r): r is string => r != null),
  };
}

export async function togglePackActive(packId: string, active: boolean) {
  const db = await getDb();
  const session = await requirePageAccess("/packs");
  await requireCapability(session, "__can_toggle_pack_active", "toggle pack active state");

  await db.packs.update({
    where: { id: packId },
    data: { active },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: active ? "pack_activated" : "pack_deactivated",
    metadata: { pack_id: packId },
  });

  reloadPacks();

  revalidatePath("/packs");
  revalidatePath(`/packs/${packId}`);
}

export async function uploadPackImage(formData: FormData): Promise<string> {
  const session = await requirePageAccess("/packs");
  await requireCapability(session, "__can_upload_pack_image", "upload pack images");

  const file = formData.get("file");
  if (!(file instanceof File)) throw new Error("No file provided");
  if (!file.type.startsWith("image/")) throw new Error("File must be an image");
  if (file.size > 20 * 1024 * 1024) throw new Error("File must be under 20MB");

  const buffer = Buffer.from(await file.arrayBuffer());
  const url = await uploadImage(buffer, file.name, "/packs");
  return url;
}

export type PackCardInput = {
  cardId: string;
  weight: number;
  color: string | null;
  animation: boolean;
  order: number;
};

/**
 * Resolve the `shard_cost` column value for a pack write.
 *   - pack_type === 'shard'  → requires an integer >= 1 (throws otherwise).
 *   - any other pack_type    → always null (a non-shard pack never carries
 *                              a shard cost, even if one was sent).
 * Keeps the column a single source of truth so the dedicated /rewards/shards
 * page, the /packs create/edit flow, and the backend all agree.
 */
function normalizeShardCost(
  packType: string,
  shardCost: number | null | undefined,
): number | null {
  if (packType !== "shard") return null;
  if (
    shardCost == null ||
    !Number.isFinite(shardCost) ||
    !Number.isInteger(shardCost) ||
    shardCost < 1
  ) {
    throw new Error("Shard packs require a shard cost of at least 1");
  }
  return shardCost;
}

export async function createPack(data: {
  name: string;
  slug: string;
  description: string;
  price: number;
  cardsPerOpen: number;
  packType: string;
  // Cost in shards to buy & open this pack. Required (>=1) when
  // packType === 'shard'; forced to null for every other type.
  shardCost?: number | null;
  imageUrl: string | null;
  tags: pack_tag[];
  difficulty: number | null;
  cards: PackCardInput[];
}): Promise<string> {
  const db = await getDb();
  const session = await requirePageAccess("/packs");

  if (!data.name.trim()) throw new Error("Name is required");
  if (!data.slug.trim()) throw new Error("Slug is required");
  if (data.price <= 0) throw new Error("Price must be greater than 0");

  // Shard packs carry a shard cost (an integer >= 1); every other type
  // never stores one. Normalize here so the column is the single source
  // of truth regardless of what the client sent.
  const shardCost = normalizeShardCost(data.packType, data.shardCost);

  await requireCapability(session, "__can_create_pack", "create packs");

  const pack = await db.$transaction(async (tx) => {
    const pack = await tx.packs.create({
      data: {
        name: data.name.trim(),
        slug: data.slug.trim(),
        description: data.description.trim() || null,
        image_url: data.imageUrl,
        price: data.price,
        cards_per_open: data.cardsPerOpen,
        pack_type: data.packType,
        tags: data.tags,
        difficulty: data.difficulty,
        active: false,
      },
    });

    if (data.cards.length > 0) {
      await tx.pack_cards.createMany({
        data: data.cards.map((c) => ({
          pack_id: pack.id,
          card_id: c.cardId,
          weight: c.weight,
          color: c.color,
          animation: c.animation,
          order: c.order,
        })),
      });
    }

    return pack;
  });

  // shard_cost is dev-only — persist it outside the transaction (no-op on a
  // DB without the column). Shard packs are a dev feature, so this only
  // matters where the column exists.
  await writeShardCost(db, pack.id, shardCost);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "pack_created",
    metadata: { pack_id: pack.id, name: data.name, card_count: data.cards.length },
  });

  reloadPacks();

  revalidatePath("/packs");
  return pack.id;
}

export async function updatePack(
  id: string,
  data: {
    name: string;
    slug: string;
    description: string;
    price: number;
    cardsPerOpen: number;
    packType: string;
    // See createPack: required (>=1) for shard packs, forced null otherwise.
    shardCost?: number | null;
    imageUrl: string | null;
    tags: pack_tag[];
    difficulty: number | null;
    cards: PackCardInput[];
  },
): Promise<void> {
  const db = await getDb();
  const session = await requirePageAccess("/packs");

  if (!data.name.trim()) throw new Error("Name is required");
  if (!data.slug.trim()) throw new Error("Slug is required");
  if (data.price <= 0) throw new Error("Price must be greater than 0");

  const shardCost = normalizeShardCost(data.packType, data.shardCost);

  await requireCapability(session, "__can_update_pack", "update packs");

  // Pack creators can iterate on their demo packs (active=false) but
  // are blocked from editing packs already live in production —
  // unless they've been granted the `__can_edit_live_packs`
  // capability. The capability is the explicit per-user opt-in for
  // changing card pool / price / house edge on an in-production
  // pack; without it the previous "demo-only" behaviour is kept.
  // Admin / support / marketing with __can_update_pack still edit
  // anything as before — this gate is pack_creator-specific. Applies to
  // ANY user holding the pack_creator role (primary OR secondary in a
  // multi-role set) so the demo-only restriction can't be sidestepped by
  // stacking pack_creator under a higher-priority primary role. A real
  // admin short-circuits earlier in requireCapability, so this branch is
  // never reached for admins.
  let editedLivePackUnderCapability = false;
  if (sessionHasRole(session, "pack_creator")) {
    const target = await db.packs.findUnique({
      where: { id },
      select: { active: true },
    });
    if (!target) throw new Error("Pack not found");
    if (target.active) {
      // Look up the admin user's allowed_pages once — same shape the
      // rest of the codebase uses for capability checks against
      // non-admin roles.
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
      editedLivePackUnderCapability = true;
    }
  }

  await db.$transaction(async (tx) => {
    await tx.packs.update({
      where: { id },
      data: {
        name: data.name.trim(),
        slug: data.slug.trim(),
        description: data.description.trim() || null,
        image_url: data.imageUrl,
        price: data.price,
        cards_per_open: data.cardsPerOpen,
        pack_type: data.packType,
        tags: data.tags,
        difficulty: data.difficulty,
        updated_at: new Date(),
      },
    });

    await tx.pack_cards.deleteMany({ where: { pack_id: id } });

    if (data.cards.length > 0) {
      await tx.pack_cards.createMany({
        data: data.cards.map((c) => ({
          pack_id: id,
          card_id: c.cardId,
          weight: c.weight,
          color: c.color,
          animation: c.animation,
          order: c.order,
        })),
      });
    }
  });

  // shard_cost is dev-only — persist it outside the transaction (no-op on a
  // DB without the column). Writing null clears it when a pack is no longer
  // a shard pack.
  await writeShardCost(db, id, shardCost);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "pack_updated",
    metadata: {
      pack_id: id,
      name: data.name,
      card_count: data.cards.length,
      // Flag the rare case: a pack_creator edited an ACTIVE pack via
      // the explicit `__can_edit_live_packs` capability. Lets audit
      // reviews answer "who changed the house edge on a live pack?"
      // without re-deriving from role + pack.active at the time.
      ...(editedLivePackUnderCapability && {
        edited_live_pack_under_capability: true,
      }),
    },
  });

  reloadPacks();

  revalidatePath("/packs");
  revalidatePath(`/packs/${id}`);
}

export async function deletePack(packId: string): Promise<void> {
  const db = await getDb();
  const session = await requirePageAccess("/packs");
  await requireCapability(session, "__can_delete_pack", "delete packs");

  const pack = await db.packs.findUnique({
    where: { id: packId },
    select: { name: true },
  });
  if (!pack) throw new Error("Pack not found");

  await db.$transaction(async (tx) => {
    await tx.pack_cards.deleteMany({ where: { pack_id: packId } });
    await tx.packs.delete({ where: { id: packId } });
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "pack_deleted",
    metadata: { pack_id: packId, name: pack.name },
  });

  reloadPacks();

  revalidatePath("/packs");
}

export async function fetchPackGames(
  packId: string,
  page: number,
  perPage: number,
  filters?: {
    dateFrom?: string;
    dateTo?: string;
    search?: string;
    sortBy?: string;
    sortOrder?: string;
    type?: string;
  }
) {
  await requirePageAccess("/packs");
  return getPackGames(packId, page, perPage, filters);
}

const MODAL_DETAIL_TIMEOUT_MS = 12_000;
const MODAL_STATS_TIMEOUT_MS = 15_000;
const MODAL_GAMES_TIMEOUT_MS = 15_000;

const EMPTY_GAMES_PAGE = {
  data: [] as Awaited<ReturnType<typeof getPackGames>>["data"],
  total: 0,
  page: 1,
  perPage: 20,
  totalPages: 0,
};

/** Lightweight identity read for modal header when the pack isn't on the list page. */
export async function fetchPackListSeed(packId: string) {
  await requirePageAccess("/packs");
  const db = await getDb();
  const pack = await db.packs.findUnique({
    where: { id: packId },
    select: {
      id: true,
      name: true,
      slug: true,
      image_url: true,
      price: true,
      active: true,
      pack_type: true,
    },
  });
  if (!pack) return null;
  return {
    id: pack.id,
    name: pack.name,
    slug: pack.slug,
    imageUrl: pack.image_url,
    priceUsd: Number(pack.price),
    active: pack.active,
    packType: pack.pack_type as string | null,
  };
}

export async function fetchPackDetailCore(packId: string) {
  await requirePageAccess("/packs");
  const { data } = await safeQuery(
    () => getPackDetail(packId),
    null,
    "packs.modal.detail",
    MODAL_DETAIL_TIMEOUT_MS,
  );
  return data;
}

export async function fetchPackDetailStats(
  packId: string,
  detail: NonNullable<Awaited<ReturnType<typeof getPackDetail>>>,
): Promise<PackStats | null> {
  await requirePageAccess("/packs");
  const { data } = await safeQuery(
    () =>
      getPackStats(packId, detail.priceUsd, {
        totalPayout: detail.totalPayout,
        actualRtp: detail.actualRtp,
      }),
    null,
    "packs.modal.stats",
    MODAL_STATS_TIMEOUT_MS,
  );
  return data;
}

export async function fetchPackGamesSafe(
  packId: string,
  page: number,
  perPage: number,
) {
  await requirePageAccess("/packs");
  const { data, error } = await safeQuery(
    () => getPackGames(packId, page, perPage),
    EMPTY_GAMES_PAGE,
    "packs.modal.games",
    MODAL_GAMES_TIMEOUT_MS,
  );
  if (error) throw new Error("Games query timed out or failed");
  return data;
}

/** Full detail payload for the centered pack modal opened from the list. */
export type PackFullDetail = {
  /** The same shape the /packs/[id] page renders from `getPackDetail`. */
  detail: NonNullable<Awaited<ReturnType<typeof getPackDetail>>>;
  /**
   * Below-the-fold chart stats (the same `getPackStats` the page defers behind
   * <PackStatsLazy>). `null` when the two heavy JSON scans timed out / failed —
   * the modal then shows a stats-error tile while detail + card pool still
   * render. Never blocks the detail.
   */
  stats: PackStats | null;
};

/**
 * Lazy-load the FULL pack detail for the big centered modal opened from a
 * /packs list row — the in-app replacement for navigating to /packs/[id]. It
 * returns exactly the data the full page renders: the pack detail (identity +
 * economics + complete card pool from `getPackDetail`) and the deferred chart
 * stats (`getPackStats`). Called on the modal's FIRST open per pack and cached
 * client-side, so the /packs list itself never eager-loads any pack's detail.
 *
 * Read-only + page-access gated (same `/packs` gate as the deep-link page).
 * Returns null when the pack is missing or its detail read failed, so the
 * modal can show a 404 / error state. The stats sub-fetch is wrapped in
 * safeQuery+timeout so a slow scan degrades that block alone — detail + the
 * card pool still render, mirroring the page's <PackStatsLazy> boundary.
 *
 * Prefer `loadPackFullDetail` from pack-detail-cache.ts on the client — it
 * dedupes in-flight requests so double-clicks don't double-query.
 */
export async function fetchPackFullDetail(
  packId: string,
): Promise<PackFullDetail | null> {
  const detail = await fetchPackDetailCore(packId);
  if (!detail) return null;
  const stats = await fetchPackDetailStats(packId, detail);
  return { detail, stats };
}

/**
 * Focused quick-edit from the list drawer: set a pack's price and/or its
 * active state without opening the full editor. Preserves every gate the
 * full flow enforces:
 *   - Changing PRICE requires `__can_update_pack` and, for a pack_creator
 *     touching a LIVE pack, the same `__can_edit_live_packs` carve-out the
 *     full `updatePack` enforces (price is a house-edge lever).
 *   - Changing ACTIVE requires `__can_toggle_pack_active`.
 * Each applied change writes its own audit event, mirroring the dedicated
 * actions. No card-pool mutation happens here — that stays in the full editor.
 */
export async function quickUpdatePack(
  packId: string,
  data: { price?: number; active?: boolean },
): Promise<void> {
  const db = await getDb();
  const session = await requirePageAccess("/packs");

  const priceChanging = typeof data.price === "number";
  const activeChanging = typeof data.active === "boolean";
  if (!priceChanging && !activeChanging) return;

  if (priceChanging && (!Number.isFinite(data.price) || data.price! <= 0)) {
    throw new Error("Price must be greater than 0");
  }

  // Load the current pack once — needed for the live-pack gate, the audit
  // before/after, and the no-op short-circuit.
  const current = await db.packs.findUnique({
    where: { id: packId },
    select: { active: true, price: true, name: true },
  });
  if (!current) throw new Error("Pack not found");

  // ── Capability gates ───────────────────────────────────────────────
  if (priceChanging) {
    await requireCapability(session, "__can_update_pack", "update packs");
    // pack_creator live-pack carve-out: editing the price of an ACTIVE pack
    // is a house-edge change, blocked for pack_creators without the explicit
    // __can_edit_live_packs capability — identical to updatePack's gate.
    if (sessionHasRole(session, "pack_creator") && current.active) {
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
    }
  }
  if (activeChanging) {
    await requireCapability(
      session,
      "__can_toggle_pack_active",
      "toggle pack active state",
    );
  }

  // ── Apply (only the fields that actually changed) ──────────────────
  const update: { price?: number; active?: boolean; updated_at?: Date } = {};
  const priceChanged =
    priceChanging && Number(current.price) !== data.price;
  const activeChanged = activeChanging && current.active !== data.active;
  if (priceChanged) update.price = data.price;
  if (activeChanged) update.active = data.active;
  if (Object.keys(update).length === 0) return; // nothing actually changed
  update.updated_at = new Date();

  await db.packs.update({ where: { id: packId }, data: update });

  // ── Audit each applied change (mirrors the dedicated actions) ──────
  if (activeChanged) {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: data.active ? "pack_activated" : "pack_deactivated",
      metadata: { pack_id: packId, via: "quick_edit" },
    });
  }
  if (priceChanged) {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "pack_updated",
      metadata: {
        pack_id: packId,
        name: current.name,
        via: "quick_edit",
        price_before: Number(current.price),
        price_after: data.price,
      },
    });
  }

  reloadPacks();

  revalidatePath("/packs");
  revalidatePath(`/packs/${packId}`);
}

// ─── Global re-price to a target house edge (default 10.99%) ──────────
//
// Scope: ACTIVE, OFFICIAL packs only (never inactive, never promo / custom /
// reward / shard). The tool ONLY ever adjusts a pack's `price` — it NEVER
// touches card odds (the pack_cards pool is read to compute EV, never written).
// The single most dangerous action in the panel; deliberately defensive:
//   1. `planRepriceAllPacks(target)` is a READ-ONLY dry-run — computes the full
//      before/after plan and writes NOTHING. Owner-only (no 2FA: it can't
//      change anything).
//   2. `authorizeReprice(totp)` verifies the owner's 2FA ONCE and mints a
//      short-lived signed token for the run.
//   3. `repricePackToTargetEdge(packId, token, target)` writes ONE pack at a
//      time (the client loops for live progress), requires a valid 2FA token,
//      re-derives the price server-side from fresh DB truth (never a
//      client-supplied price), and HARD-asserts the resulting edge is within
//      the hard tolerance of the target before persisting.
// The target + band rule live in the dep-free math module (`planPackReprice`)
// so the dry-run and the write share one implementation.

/** Validate + normalize a target edge fraction; throws on out-of-range input. */
function resolveRepriceTarget(target: number | undefined): number {
  const t = target ?? REPRICE_TARGET_DEFAULT;
  if (!Number.isFinite(t) || t < REPRICE_TARGET_MIN || t > REPRICE_TARGET_MAX) {
    throw new Error(
      `Target edge must be between ${(REPRICE_TARGET_MIN * 100).toFixed(0)}% and ${(REPRICE_TARGET_MAX * 100).toFixed(0)}%.`,
    );
  }
  return clampRepriceTarget(t);
}

export type RepricePlanRow = {
  packId: string;
  name: string;
  slug: string;
  packType: string;
  active: boolean;
  priceBefore: number;
  priceAfter: number | null;
  /** House-edge fractions (0.1099 = 10.99%). */
  edgeBefore: number;
  edgeAfter: number | null;
  action: RepriceAction;
  reason: string;
};

export type RepricePlanSummary = {
  /** Which game DB the writes would hit — surfaced so the operator can't
   *  confuse a prod run with a dev run. */
  dbEnv: DbEnv;
  /** The target edge this plan was computed for (fraction). */
  target: number;
  acceptMin: number;
  acceptMax: number;
  hardMin: number;
  hardMax: number;
  counts: {
    total: number;
    toReprice: number;
    unchanged: number;
    skipped: number;
  };
  /** Packs that WILL change, sorted by largest absolute price swing first so
   *  the scariest moves surface at the top of the preview. */
  toReprice: RepricePlanRow[];
  unchanged: RepricePlanRow[];
  skipped: RepricePlanRow[];
};

/**
 * READ-ONLY dry-run for the global re-price at `targetEdge` (default 10.99%).
 * Computes every in-scope (active, official) pack's current→new price and edge
 * and buckets them. Writes nothing — safe to run even against prod. Owner-only.
 */
export async function planRepriceAllPacks(
  targetEdge?: number,
): Promise<RepricePlanSummary> {
  const session = await requirePageAccess("/packs");
  if (!isRepriceOwner(session)) {
    throw new Error("The global re-price tool is restricted to the owner.");
  }
  const target = resolveRepriceTarget(targetEdge);

  const dbEnv = await readDbEnv();
  const packs = await getPacksPoolComposition(); // scoped: active official, price > 0

  const rows: RepricePlanRow[] = packs.map((p) => {
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
      packType: p.packType,
      active: p.active,
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
    dbEnv,
    target,
    acceptMin: target - REPRICE_ACCEPT_TOLERANCE,
    acceptMax: target + REPRICE_ACCEPT_TOLERANCE,
    hardMin: target - REPRICE_HARD_TOLERANCE,
    hardMax: target + REPRICE_HARD_TOLERANCE,
    counts: {
      total: rows.length,
      toReprice: toReprice.length,
      unchanged: unchanged.length,
      skipped: skipped.length,
    },
    toReprice,
    unchanged,
    skipped,
  };
}

/**
 * Verify the owner's 2FA ONCE and mint a short-lived token authorizing a
 * re-price run. The client passes this token to each per-pack write so TOTP
 * isn't re-prompted per pack (and a long run can't expire mid-way). Owner-only.
 */
export async function authorizeReprice(
  totpCode: string,
): Promise<{ token: string }> {
  const session = await requirePageAccess("/packs");
  if (!isRepriceOwner(session)) {
    throw new Error("The global re-price tool is restricted to the owner.");
  }
  // Throws "Invalid TOTP code" / "2FA not enabled" / "code required" verbatim.
  await require2FA(session.userId, totpCode);
  return { token: await signRepriceToken(session.userId) };
}

export type RepriceResult = {
  packId: string;
  name: string;
  status: "repriced" | "unchanged" | "skipped" | "failed";
  priceBefore: number;
  priceAfter: number | null;
  edgeBefore: number;
  edgeAfter: number | null;
  reason: string;
};

/**
 * Re-price ONE pack to `targetEdge` (default 10.99%). The client loops over the
 * dry-run's `toReprice` ids, calling this per pack so the run is visible,
 * stoppable, and each pack is its own audited write.
 *
 * Authoritative & paranoid:
 *   - Owner-only, AND requires a valid 2FA token from `authorizeReprice`.
 *   - Re-fetches the pack's pool FRESH from the DB — the client supplies only an
 *     id + the token + the target, never a price.
 *   - Re-validates scope server-side (active / official / price) independently
 *     of the dry-run filter.
 *   - HARD-asserts the resulting edge is within the hard tolerance of the target
 *     and THROWS otherwise, so a logic regression fails closed (no write).
 *   - Writes ONLY `price` (+ updated_at); never touches realized stats / pool.
 */
export async function repricePackToTargetEdge(
  packId: string,
  token: string,
  targetEdge?: number,
): Promise<RepriceResult> {
  const session = await requirePageAccess("/packs");
  if (!isRepriceOwner(session)) {
    throw new Error("The global re-price tool is restricted to the owner.");
  }
  await requireCapability(session, "__can_update_pack", "update packs");
  // 2FA gate: the run must carry a valid token minted by `authorizeReprice`.
  // Auth/token/target failures stay THROWS — they abort the whole run.
  if (!(await verifyRepriceToken(token, session.userId))) {
    throw new Error("2FA authorization expired or missing — re-confirm to continue.");
  }
  const target = resolveRepriceTarget(targetEdge);

  // Everything pack-specific is wrapped so ONE pack's failure surfaces its REAL
  // message — a value returned from a server action is NOT masked the way a
  // thrown error is in production ("An error occurred in the Server Components
  // render…") — and the client can keep going through the rest of the batch.
  let comp: Awaited<ReturnType<typeof getPacksPoolComposition>>[number] | undefined;
  try {
    const db = await getDb();
    [comp] = await getPacksPoolComposition({ packIds: [packId] });
    if (!comp) {
      return {
        packId,
        name: packId,
        status: "failed",
        priceBefore: 0,
        priceAfter: null,
        edgeBefore: 0,
        edgeAfter: null,
        reason: "Pack not found.",
      };
    }

    // Defense-in-depth scope re-check (independent of the dry-run's WHERE):
    // active official packs only.
    const skip = (reason: string): RepriceResult => ({
      packId,
      name: comp!.name,
      status: "skipped",
      priceBefore: comp!.price,
      priceAfter: null,
      edgeBefore: 0,
      edgeAfter: null,
      reason,
    });
    if (!(REPRICE_INCLUDED_PACK_TYPES as readonly string[]).includes(comp.packType)) {
      return skip(`Out of scope: only official packs are re-priced (this is '${comp.packType}').`);
    }
    if (!comp.active) {
      return skip("Out of scope: only active packs are re-priced.");
    }
    if (!(comp.price > 0)) {
      return skip("Out of scope: pack has no price.");
    }

    const plan = planPackReprice({
      currentPrice: comp.price,
      cardsPerOpen: comp.cardsPerOpen,
      totalWeight: comp.totalWeight,
      weightedPriceSum: comp.weightedPriceSum,
      targetEdge: target,
    });

    if (plan.action !== "reprice" || plan.newPrice === null || plan.newEdge === null) {
      return {
        packId,
        name: comp.name,
        status: plan.action === "unchanged" ? "unchanged" : "skipped",
        priceBefore: comp.price,
        priceAfter: plan.newPrice,
        edgeBefore: plan.currentEdge,
        edgeAfter: plan.newEdge,
        reason: plan.reason,
      };
    }

    // HARD BACKSTOP — never persist a price whose edge escapes the hard
    // tolerance of the target. Returned as a `failed` result (not thrown) so the
    // run continues; unreachable in normal operation (accept ⊂ hard).
    if (!repriceEdgeWithinHardBand(plan.newEdge, target)) {
      return {
        packId,
        name: comp.name,
        status: "failed",
        priceBefore: comp.price,
        priceAfter: null,
        edgeBefore: plan.currentEdge,
        edgeAfter: plan.newEdge,
        reason: `Refused: resulting edge ${(plan.newEdge * 100).toFixed(2)}% is outside the hard band around ${(target * 100).toFixed(2)}%.`,
      };
    }

    // ONLY the price is written (+ updated_at). Card odds (pack_cards) are never
    // touched — re-pricing moves the sticker price, nothing else.
    await db.packs.update({
      where: { id: packId },
      data: { price: plan.newPrice, updated_at: new Date() },
    });

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "pack_updated",
      metadata: {
        pack_id: packId,
        name: comp.name,
        via: "reprice_to_target_edge",
        target_edge: target,
        price_before: comp.price,
        price_after: plan.newPrice,
        edge_before: plan.currentEdge,
        edge_after: plan.newEdge,
      },
    });

    reloadPacks();
    revalidatePath("/packs");
    revalidatePath(`/packs/${packId}`);

    return {
      packId,
      name: comp.name,
      status: "repriced",
      priceBefore: comp.price,
      priceAfter: plan.newPrice,
      edgeBefore: plan.currentEdge,
      edgeAfter: plan.newEdge,
      reason: "",
    };
  } catch (err) {
    // The REAL cause (DB error, audit write, etc.) — returned as data so prod
    // doesn't mask it behind the generic digest message.
    return {
      packId,
      name: comp?.name ?? packId,
      status: "failed",
      priceBefore: comp?.price ?? 0,
      priceAfter: null,
      edgeBefore: 0,
      edgeAfter: null,
      reason: err instanceof Error ? err.message : "Write failed.",
    };
  }
}
