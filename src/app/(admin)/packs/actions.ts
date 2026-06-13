"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { requirePageAccess, sessionHasRole } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import {
  getPackDetail,
  getPackGames,
  getPackStats,
  type PackStats,
} from "@/lib/queries/packs";
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
