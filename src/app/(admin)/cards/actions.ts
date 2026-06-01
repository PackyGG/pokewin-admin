"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { uploadImage } from "@/lib/imagekit";
import {
  ok,
  fail,
  type ServerActionResult,
} from "@/lib/errors/server-action-result";
import { logError, logWarn } from "@/lib/errors/logger";
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

/**
 * True when the DB rejected the write because a `cost`/`power` column
 * doesn't exist on this database. These are OnePiece-only game-design
 * columns added by a later migration; on a DB where that migration
 * hasn't run yet, any INSERT/UPDATE that names them fails with Postgres
 * "column does not exist" → Prisma surfaces it as P2022.
 *
 * We match the engine code first (stable across messages) and fall back
 * to the message text so we still recognise it if a future engine
 * version reports it differently. The message check is scoped to
 * cost/power so we never silently swallow an unrelated missing column.
 */
function isMissingCostPowerColumnError(e: unknown): boolean {
  if (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    e.code === "P2022"
  ) {
    return true;
  }
  if (e instanceof Error) {
    return /column\b[^]*\b(cost|power)\b[^]*does not exist/i.test(e.message);
  }
  return false;
}

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
}): Promise<ServerActionResult<{ id: string }>> {
  const db = await getDb();
  const session = await requireAdmin();

  const parsed = createCardSchema.safeParse(data);
  if (!parsed.success) {
    return fail(
      parsed.error.issues[0]?.message ?? "Invalid input",
      "VALIDATION",
    );
  }
  const input = parsed.data;

  try {
    await requireCapability(session, "__can_create_card", "create cards");
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : "Permission denied",
      "FORBIDDEN",
    );
  }

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
    if (!set) return fail("Set not found", "NOT_FOUND");
    isOnePiece = isOnePieceSetName(set.name);
  }

  if (isOnePiece) {
    if (!ONEPIECE_RARITY_VALUES.includes(input.rarity as never)) {
      return fail("Invalid OnePiece rarity", "VALIDATION");
    }
  } else {
    if (!POKEMON_RARITY_VALUES.includes(input.rarity as never)) {
      return fail("Invalid Pokemon rarity", "VALIDATION");
    }
    // Cost / power are OnePiece-only — silently drop if a non-OP
    // caller sends them.
    input.cost = null;
    input.power = null;
  }

  // Build the row WITHOUT cost/power first. Omitting them entirely (vs.
  // passing `null`) keeps those columns out of Prisma's generated INSERT
  // column list — so the write succeeds even on a DB where the
  // cost/power migration hasn't run. `select: { id: true }` is the other
  // half of that: it restricts the RETURNING clause to `id` only,
  // otherwise Prisma's default RETURNING lists every model column
  // (including cost/power) and would fail before we ever read the row.
  const baseData = {
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
  };
  // Only OnePiece cards with real values include cost/power. (Pokemon
  // had them forced to null above, so this spread is empty for them.)
  const withStats = {
    ...baseData,
    ...(input.cost != null ? { cost: input.cost } : {}),
    ...(input.power != null ? { power: input.power } : {}),
  };

  let card: { id: string };
  try {
    try {
      card = await db.cards.create({ data: withStats, select: { id: true } });
    } catch (err) {
      // OnePiece path: we tried to write cost/power but this DB doesn't
      // have the columns yet. Retry without them so the card is still
      // created; the cost/power values are dropped (they'll persist once
      // the migration runs). Warn so the missing migration is visible in
      // the Vercel logs.
      if (isMissingCostPowerColumnError(err)) {
        logWarn(
          "cards.createCard",
          "cost/power columns missing on this DB — inserting without them; run the cards cost/power migration to persist these fields",
          err,
        );
        card = await db.cards.create({ data: baseData, select: { id: true } });
      } else {
        throw err;
      }
    }
  } catch (err) {
    // Real Prisma error → server log (Vercel function logs) so the
    // on-call sees the column / constraint that actually failed. The
    // client gets the message too (no secrets in a Prisma schema/
    // constraint message) so the toast finally shows the real cause
    // instead of an opaque 500 digest.
    logError("cards.createCard", "db.cards.create failed", err);
    const msg =
      err instanceof Error ? err.message : "Database error creating card";
    return fail(msg);
  }

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
  return ok({ id: card.id });
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
): Promise<ServerActionResult<{ id: string }>> {
  const db = await getDb();
  const session = await requireAdmin();

  if (!data.name.trim()) return fail("Name is required", "VALIDATION");
  if (!data.imageUrl) return fail("Image is required", "VALIDATION");
  if (data.price < 0)
    return fail("Price must be 0 or greater", "VALIDATION");

  try {
    await requireCapability(session, "__can_update_card", "update cards");
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : "Permission denied",
      "FORBIDDEN",
    );
  }

  // The update payload never names cost/power (those are set only at
  // create time for OnePiece). The resilience that matters here is
  // `select: { id: true }`: without it, Prisma's UPDATE adds a RETURNING
  // listing every model column — including cost/power — and the write
  // fails with P2022 on a DB that hasn't run the cost/power migration.
  // Restricting RETURNING to `id` keeps update working regardless.
  try {
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
      select: { id: true },
    });
  } catch (err) {
    // Defence in depth: if a future change adds cost/power to the update
    // payload, the missing-column case is still recognised and surfaced
    // as a clear warning rather than an opaque failure. The row write
    // itself can't be retried-without-stats here because there's nothing
    // to drop today, so we just log and fall through to the real-error
    // handling below.
    if (isMissingCostPowerColumnError(err)) {
      logWarn(
        "cards.updateCard",
        `cost/power columns missing on this DB for ${id} — run the cards cost/power migration`,
        err,
      );
    }
    // Surface the real DB failure server-side (Vercel logs) and to the
    // client toast — same reasoning as createCard. Prisma P2025 =
    // record not found.
    logError("cards.updateCard", `db.cards.update failed for ${id}`, err);
    if (err instanceof Error && /No record was found/i.test(err.message)) {
      return fail("Card not found", "NOT_FOUND");
    }
    const msg =
      err instanceof Error ? err.message : "Database error updating card";
    return fail(msg);
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "card_updated",
    metadata: { card_id: id, name: data.name },
  });

  revalidatePath("/cards");
  revalidatePath(`/cards/${id}`);
  return ok({ id });
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
