"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { requirePageAccess, sessionHasRole } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { getPackGames } from "@/lib/queries/packs";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { uploadImage } from "@/lib/imagekit";
import { getCards, getRarities, getSets } from "@/lib/queries/cards";
import { reloadPacks } from "@/app/(admin)/rewards/actions";
import type { pack_tag } from "@/generated/prisma/enums";

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

export async function createPack(data: {
  name: string;
  slug: string;
  description: string;
  price: number;
  cardsPerOpen: number;
  packType: string;
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
