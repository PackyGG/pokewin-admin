"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import { verifySession, requireAdmin } from "@/lib/dal";
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
  const session = await verifySession();
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
  const session = await verifySession();

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
  const session = await verifySession();

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
  const session = await verifySession();
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

// ────────────────────────────────────────────────────────────────────
//  deleteCards  (admin-only bulk delete from the /cards selection toolbar)
// ────────────────────────────────────────────────────────────────────

// Hard cap on a single bulk-delete. Mirrors `bulkMoveCardsToSet`'s 500-id
// ceiling so the selection toolbar's "select all matching" (also capped at
// 500) can be deleted in one call, and a tampered RPC can't request an
// unbounded destructive scan.
const BULK_DELETE_MAX = 500;

const deleteCardsSchema = z.object({
  ids: z
    .array(z.string().uuid("Invalid card id"))
    .min(1, "Select at least one card")
    .max(BULK_DELETE_MAX, `Up to ${BULK_DELETE_MAX} cards at a time`),
});

/** Per-card reason a card was skipped instead of deleted. */
type BlockedCard = {
  id: string;
  name: string;
  reason: "in_packs" | "in_inventory";
  packCount: number;
  inventoryCount: number;
};

/**
 * Bulk-delete cards selected on /cards. ADMIN-ONLY — `requireAdmin()` is the
 * hard server-side gate (the client toolbar also hides the button for
 * non-admins, but the server never trusts that).
 *
 * FK-/data-integrity safety (this is a MAIN-DB production write):
 *
 *   `cards` is referenced two ways —
 *     1. `pack_cards.card_id`  → a real FK (onDelete: Cascade). The existing
 *        single-delete (`deleteCard`) already BLOCKS when a card is in any
 *        pack so a delete never silently rips a card out of a live pack pool;
 *        we apply the SAME rule here.
 *     2. `user_inventory.card_id` → a SOFT reference: in the Prisma schema
 *        `user_inventory` has only an INDEX on `card_id` and NO `@relation`/FK
 *        back to `cards`. So a raw `cards.delete()` would SUCCEED at the DB
 *        level even while real users hold that card, orphaning every matching
 *        `user_inventory` row (its name/image/price can no longer resolve).
 *        We therefore also BLOCK any card that is held in inventory rather
 *        than orphan a user's items.
 *
 * Cards that are referenced either way are skipped and reported back (per-card
 * reason) so the operator sees exactly why; only fully-unreferenced cards are
 * deleted. Nothing is cascaded into packs or inventory.
 */
export async function deleteCards(input: {
  ids: string[];
}): Promise<
  ServerActionResult<{
    deletedCount: number;
    deletedIds: string[];
    blocked: BlockedCard[];
  }>
> {
  // Admin-only: hard server-side enforcement, independent of the client UI.
  const session = await requireAdmin();

  const parsed = deleteCardsSchema.safeParse(input);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid input", "VALIDATION");
  }
  // De-dup just in case the client passed duplicate ids.
  const ids = Array.from(new Set(parsed.data.ids));

  const db = await getDb();

  try {
    // Load each candidate with its pack-reference list (same shape the
    // single-delete reads). Missing ids simply don't come back.
    const cards = await db.cards.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        pack_cards: { select: { id: true } },
      },
    });

    if (cards.length === 0) {
      return fail("None of the selected cards still exist.", "NOT_FOUND");
    }

    // Inventory is a soft reference (no FK) — count holdings per card so we
    // can block instead of orphaning. One grouped query over the candidate
    // set, not an N+1.
    const inventoryGroups = await db.user_inventory.groupBy({
      by: ["card_id"],
      where: { card_id: { in: cards.map((c) => c.id) } },
      _count: { _all: true },
    });
    const inventoryCountByCard = new Map<string, number>(
      inventoryGroups.map((g) => [g.card_id, g._count._all]),
    );

    const blocked: BlockedCard[] = [];
    const deletableIds: string[] = [];
    for (const card of cards) {
      const packCount = card.pack_cards.length;
      const inventoryCount = inventoryCountByCard.get(card.id) ?? 0;
      if (packCount > 0) {
        blocked.push({
          id: card.id,
          name: card.name,
          reason: "in_packs",
          packCount,
          inventoryCount,
        });
      } else if (inventoryCount > 0) {
        blocked.push({
          id: card.id,
          name: card.name,
          reason: "in_inventory",
          packCount,
          inventoryCount,
        });
      } else {
        deletableIds.push(card.id);
      }
    }

    if (deletableIds.length === 0) {
      // Nothing safe to delete — surface a clear, specific reason rather than
      // a silent no-op so the operator understands why.
      const inPacks = blocked.filter((b) => b.reason === "in_packs").length;
      const inInv = blocked.filter((b) => b.reason === "in_inventory").length;
      const parts: string[] = [];
      if (inPacks > 0)
        parts.push(`${inPacks} still used in pack${inPacks === 1 ? "" : "s"}`);
      if (inInv > 0) parts.push(`${inInv} held in user inventory`);
      return fail(
        `No cards deleted — ${parts.join(" and ")}. Remove them from packs first; cards held in any user's inventory can't be deleted.`,
        "BLOCKED",
      );
    }

    const result = await db.cards.deleteMany({
      where: { id: { in: deletableIds } },
    });

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "cards_bulk_deleted",
      metadata: {
        deleted_count: result.count,
        deleted_card_ids: deletableIds,
        blocked_count: blocked.length,
        blocked_card_ids: blocked.map((b) => b.id),
      },
    });

    revalidatePath("/cards");
    return ok({
      deletedCount: result.count,
      deletedIds: deletableIds,
      blocked,
    });
  } catch (err) {
    logError("cards.deleteCards", "bulk delete failed", err);
    return fail("Something went wrong deleting cards — please try again.");
  }
}
