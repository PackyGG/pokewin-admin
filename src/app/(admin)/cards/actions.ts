"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { uploadImage } from "@/lib/imagekit";

export async function uploadCardImage(formData: FormData): Promise<string> {
  await requireAdmin();

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
}): Promise<string> {
  const session = await requireAdmin();

  if (!data.name.trim()) throw new Error("Name is required");
  if (!data.imageUrl) throw new Error("Image is required");
  if (data.price < 0) throw new Error("Price must be 0 or greater");

  const card = await db.cards.create({
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
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "card_created",
    metadata: { card_id: card.id, name: data.name },
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
  const session = await requireAdmin();

  if (!data.name.trim()) throw new Error("Name is required");
  if (!data.imageUrl) throw new Error("Image is required");
  if (data.price < 0) throw new Error("Price must be 0 or greater");

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
  const session = await requireAdmin();

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
