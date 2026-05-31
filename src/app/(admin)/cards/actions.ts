"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { uploadImage } from "@/lib/imagekit";
import {
  ONEPIECE_RARITY_VALUES,
  isOnePieceSetName,
} from "./_constants/onepiece";

// Pokemon rarities accepted by the create dialog. Kept in sync with
// the POKEMON_RARITIES array in `create-card-button.tsx` — when one
// changes, the other has to follow. Server-side validation is the
// source of truth (client UI just shows the matching options).
const POKEMON_RARITY_VALUES = [
  "Common",
  "Uncommon",
  "Rare",
  "Ultra Rare",
  "Secret",
] as const;

// Reasonable upper bounds for OnePiece game-design columns: cost caps
// at 20 (highest printed costs are around 10, the headroom absorbs
// future printings); power caps at 20000 (current OP printings top
// out at 13k, again headroom for new design space).
const createCardSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  imageUrl: z.string().min(1, "Image is required"),
  price: z.number().min(0, "Price must be 0 or greater"),
  hp: z.number().int().min(0).default(0),
  rarity: z.string().min(1, "Rarity is required"),
  artist: z.string(),
  tcgplayerId: z.number().int().nullable(),
  type: z.string().min(1, "Type is required"),
  cardNumber: z.string().nullable(),
  setId: z.string().uuid("Invalid set id").nullable(),
  cost: z.number().int().min(0).max(20).nullable().optional(),
  power: z.number().int().min(0).max(20000).nullable().optional(),
});

export async function uploadCardImage(formData: FormData): Promise<string> {
  const session = await requireAdmin();
  await requireCapability(session, "__can_upload_card_image", "upload card images");

  const file = formData.get("file");
  if (!(file instanceof File)) throw new Error("No file provided");
  if (!file.type.startsWith("image/")) throw new Error("File must be an image");
  if (file.size > 5 * 1024 * 1024) throw new Error("File must be under 5MB");

  const buffer = Buffer.from(await file.arrayBuffer());
  const url = await uploadImage(buffer, file.name, "/cards");
  return url;
}

export async function createCard(data: {
  name: string;
  imageUrl: string;
  price: number;
  hp: number;
  rarity: string;
  artist: string;
  tcgplayerId: number | null;
  type: string;
  cardNumber: string | null;
  setId: string | null;
  cost?: number | null;
  power?: number | null;
}): Promise<string> {
  const db = await getDb();
  const session = await requireAdmin();

  const parsed = createCardSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const input = parsed.data;

  await requireCapability(session, "__can_create_card", "create cards");

  // Variant-specific rarity validation. The set name is the single
  // source of truth for "what kind of card is this" — same rule the
  // dialog uses (`isOnePieceSetName`). When no set is selected we
  // fall back to the Pokemon rarity list since OnePiece cards are
  // expected to live under their set.
  let isOnePiece = false;
  if (input.setId) {
    const set = await db.sets.findUnique({
      where: { id: input.setId },
      select: { id: true, name: true },
    });
    if (!set) throw new Error("Set not found");
    isOnePiece = isOnePieceSetName(set.name);
  }

  if (isOnePiece) {
    if (!ONEPIECE_RARITY_VALUES.includes(input.rarity as never)) {
      throw new Error("Invalid OnePiece rarity");
    }
  } else {
    if (!POKEMON_RARITY_VALUES.includes(input.rarity as never)) {
      throw new Error("Invalid Pokemon rarity");
    }
    // Cost / power are OnePiece-only — silently drop if a non-OP
    // caller sends them.
    input.cost = null;
    input.power = null;
  }

  const card = await db.cards.create({
    data: {
      name: input.name,
      image_url: input.imageUrl,
      price: input.price,
      price_raw: input.price,
      hp: input.hp,
      rarity: input.rarity,
      artist: input.artist?.trim() ? input.artist.trim() : null,
      tcgplayer_id: input.tcgplayerId,
      type: input.type,
      card_number: input.cardNumber?.trim() || null,
      set_id: input.setId,
      cost: input.cost ?? null,
      power: input.power ?? null,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "card_created",
    metadata: {
      card_id: card.id,
      name: input.name,
      variant: isOnePiece ? "onepiece" : "pokemon",
    },
  });

  revalidatePath("/cards");
  return card.id;
}

export async function updateCard(
  id: string,
  data: {
    name: string;
    imageUrl: string;
    price: number;
    hp: number | null;
    rarity: string | null;
    artist: string | null;
    tcgplayerId: number | null;
    type: string;
    cardNumber: string | null;
    setId: string | null;
  },
): Promise<void> {
  const db = await getDb();
  const session = await requireAdmin();

  if (!data.name.trim()) throw new Error("Name is required");
  if (!data.imageUrl) throw new Error("Image is required");
  if (data.price < 0) throw new Error("Price must be 0 or greater");

  await requireCapability(session, "__can_update_card", "update cards");

  await db.cards.update({
    where: { id },
    data: {
      name: data.name.trim(),
      image_url: data.imageUrl,
      price: data.price,
      price_raw: data.price,
      hp: data.hp,
      rarity: data.rarity,
      artist: data.artist?.trim() ?? null,
      tcgplayer_id: data.tcgplayerId,
      type: data.type,
      card_number: data.cardNumber?.trim() || null,
      set_id: data.setId || null,
      updated_at: new Date(),
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "card_updated",
    metadata: { card_id: id, name: data.name },
  });

  revalidatePath("/cards");
  revalidatePath(`/cards/${id}`);
}

export async function deleteCard(cardId: string): Promise<void> {
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_delete_card", "delete cards");

  const card = await db.cards.findUnique({
    where: { id: cardId },
    select: {
      name: true,
      pack_cards: {
        select: { packs: { select: { name: true } } },
      },
    },
  });

  if (!card) throw new Error("Card not found");

  if (card.pack_cards.length > 0) {
    const packNames = card.pack_cards.map((pc) => pc.packs.name).join(", ");
    throw new Error(
      `Card is used in ${card.pack_cards.length} pack(s): ${packNames}. Remove it from those packs first.`,
    );
  }

  await db.cards.delete({ where: { id: cardId } });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "card_deleted",
    metadata: { card_id: cardId, name: card.name },
  });

  revalidatePath("/cards");
}
