"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
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
import { TCGPLAYER_LINK_ERROR } from "./_constants/tcgplayer";

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
    // OnePiece cards require a TCGplayer product reference. The client form
    // captures it as a product LINK and parses the numeric product id out
    // of the URL before calling this action, so what arrives here is the
    // integer id (there is no url/text column — only `tcgplayer_id Int?`,
    // so the link is the INPUT/OUTPUT format and the id is what persists).
    // Re-validate authoritatively: a present, positive integer id. A non-OP
    // client tampering past the UI still can't create an OnePiece card
    // without a valid product id.
    if (input.tcgplayerId == null || input.tcgplayerId <= 0) {
      return fail(TCGPLAYER_LINK_ERROR, "VALIDATION");
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

  // Keep the rich pack-names message (most common, most actionable case)…
  if (card.pack_cards.length > 0) {
    const packNames = card.pack_cards.map((pc) => pc.packs.name).join(", ");
    throw new Error(
      `Card is used in ${card.pack_cards.length} pack(s): ${packNames}. Remove it from those packs first.`,
    );
  }

  // …and run the same full reference check the bulk delete uses, so a single
  // delete can't orphan inventory / upgrader / provably-fair references either.
  const check = await checkCardReferences(db, [cardId]);
  const reason = check.blockedById.get(cardId);
  if (reason) {
    throw new Error(
      `Card can't be deleted — it is ${BLOCKED_REASON_LABEL[reason]}.`,
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

/**
 * Why a card can't be deleted. Each reason maps to a real reference that a
 * raw `cards.delete()` would either break (orphan a soft reference) or be
 * blocked on by a RESTRICT foreign key:
 *
 *   - `in_packs`           → `pack_cards.card_id` (FK, Cascade) — would rip the
 *                            card out of a live pack pool.
 *   - `in_inventory`       → `user_inventory.card_id` (soft ref, NO FK) —
 *                            would orphan a user's held item.
 *   - `in_upgrader_output` → `upgrader_output_cards.card_id` (FK, Cascade,
 *                            UNIQUE) — would silently remove the card from the
 *                            upgrader output pool.
 *   - `in_upgrader_target` → `upgrader_games.target_card_id` (FK, RESTRICT —
 *                            the relation has no onDelete, so Postgres blocks
 *                            the delete with a constraint violation anyway).
 *   - `in_provably_fair`   → referenced inside `provably_fair_results.
 *                            result_metadata` (Json, soft ref) as the rolled
 *                            `card_id` or the upgrader `target_card_id` —
 *                            deleting the card would make the immutable
 *                            fairness record point at a row that no longer
 *                            resolves.
 */
type BlockedReason =
  | "in_packs"
  | "in_inventory"
  | "in_upgrader_output"
  | "in_upgrader_target"
  | "in_provably_fair";

/** Per-card reason a card was skipped instead of deleted. */
type BlockedCard = {
  id: string;
  name: string;
  reason: BlockedReason;
  packCount: number;
  inventoryCount: number;
};

/**
 * Result of running every read-only reference check over a candidate set of
 * card ids. `blockedById` carries the *first-matched* reason per card (checks
 * are ordered most-actionable first: packs → inventory → upgrader → fairness),
 * `blockedReasonsById` carries every reason that matched (so callers can show
 * the full picture if they want).
 */
type CardReferenceCheck = {
  /** ids that have NO reference of any kind → safe to delete. */
  deletableIds: string[];
  /** first-matched reason per blocked id. */
  blockedById: Map<string, BlockedReason>;
  /** all matched reasons per blocked id. */
  blockedReasonsById: Map<string, BlockedReason[]>;
  /** pack reference count per candidate id (0 when none). */
  packCountById: Map<string, number>;
  /** inventory holding count per candidate id (0 when none). */
  inventoryCountById: Map<string, number>;
};

/**
 * Run ALL five read-only reference checks over `ids` and return the safe set
 * plus per-card reasons. This is the single source of truth for "is this card
 * safe to delete" — both the bulk `deleteCards` and the single `deleteCard`
 * (and the UI preview via `getDeletableCardIds`) go through it so the rules
 * can never drift between callers.
 *
 * Every query here is a READ (SELECT/COUNT) on the MAIN production DB — nothing
 * is mutated. Checks are issued concurrently and each is scoped to the
 * candidate id set so no check ever scans more than it must.
 *
 * Reference shapes (see `BlockedReason` for the FK/onDelete details):
 *   1. pack_cards.card_id            (typed relation, per-card count)
 *   2. user_inventory.card_id        (soft ref, grouped count)
 *   3. upgrader_output_cards.card_id (typed relation, unique)
 *   4. upgrader_games.target_card_id (typed relation, grouped existence)
 *   5. provably_fair_results.result_metadata->>'card_id' / 'target_card_id'
 *      (Json soft ref — a single combined scan over the candidate set, see
 *      `prisma/recommended-indexes.sql` for the GIN index that turns this into
 *      an index lookup once the owner applies it).
 */
async function checkCardReferences(
  db: PrismaClient,
  ids: string[],
): Promise<CardReferenceCheck> {
  // De-dup defensively so counts/maps are keyed once per id.
  const uniqueIds = Array.from(new Set(ids));

  if (uniqueIds.length === 0) {
    return {
      deletableIds: [],
      blockedById: new Map(),
      blockedReasonsById: new Map(),
      packCountById: new Map(),
      inventoryCountById: new Map(),
    };
  }

  const [
    packGroups,
    inventoryGroups,
    upgraderOutputs,
    upgraderTargetGroups,
    provablyFairRows,
  ] = await Promise.all([
    // 1. pack_cards — count references per candidate card.
    db.pack_cards.groupBy({
      by: ["card_id"],
      where: { card_id: { in: uniqueIds } },
      _count: { _all: true },
    }),
    // 2. user_inventory — soft reference (no FK); count holdings per card.
    db.user_inventory.groupBy({
      by: ["card_id"],
      where: { card_id: { in: uniqueIds } },
      _count: { _all: true },
    }),
    // 3. upgrader_output_cards — card_id is UNIQUE, so just fetch the ids that
    //    appear; presence ⇒ blocked.
    db.upgrader_output_cards.findMany({
      where: { card_id: { in: uniqueIds } },
      select: { card_id: true },
    }),
    // 4. upgrader_games.target_card_id — RESTRICT FK; group so we know which
    //    candidate ids are referenced as an upgrader target.
    db.upgrader_games.groupBy({
      by: ["target_card_id"],
      where: { target_card_id: { in: uniqueIds } },
      _count: { _all: true },
    }),
    // 5. provably_fair_results.result_metadata — Json soft reference. A card id
    //    can sit at the top level as the rolled `card_id` OR (for upgrader
    //    rolls) nested as `target_card_id`. One combined scan returns the
    //    distinct candidate ids that appear in EITHER position. Uses jsonb
    //    containment (`@>`) so it becomes index-eligible once the recommended
    //    GIN index lands; correct on a seq scan today. `Prisma.join` safely
    //    parameterises the id list (no string interpolation).
    db.$queryRaw<{ card_id: string }[]>(Prisma.sql`
      SELECT DISTINCT t.card_id FROM (
        SELECT (result_metadata->>'card_id') AS card_id
          FROM provably_fair_results
         WHERE result_metadata->>'card_id' IN (${Prisma.join(uniqueIds)})
        UNION ALL
        SELECT (result_metadata->>'target_card_id') AS card_id
          FROM provably_fair_results
         WHERE result_metadata->>'target_card_id' IN (${Prisma.join(uniqueIds)})
      ) t
    `),
  ]);

  const packCountById = new Map<string, number>(
    packGroups.map((g) => [g.card_id, g._count._all]),
  );
  const inventoryCountById = new Map<string, number>(
    inventoryGroups.map((g) => [g.card_id, g._count._all]),
  );
  const upgraderOutputIds = new Set(upgraderOutputs.map((r) => r.card_id));
  const upgraderTargetIds = new Set(
    upgraderTargetGroups
      .map((g) => g.target_card_id)
      .filter((id): id is string => id != null),
  );
  const provablyFairIds = new Set(
    provablyFairRows
      .map((r) => r.card_id)
      .filter((id): id is string => id != null),
  );

  const deletableIds: string[] = [];
  const blockedById = new Map<string, BlockedReason>();
  const blockedReasonsById = new Map<string, BlockedReason[]>();

  for (const id of uniqueIds) {
    const reasons: BlockedReason[] = [];
    if ((packCountById.get(id) ?? 0) > 0) reasons.push("in_packs");
    if ((inventoryCountById.get(id) ?? 0) > 0) reasons.push("in_inventory");
    if (upgraderOutputIds.has(id)) reasons.push("in_upgrader_output");
    if (upgraderTargetIds.has(id)) reasons.push("in_upgrader_target");
    if (provablyFairIds.has(id)) reasons.push("in_provably_fair");

    if (reasons.length === 0) {
      deletableIds.push(id);
    } else {
      blockedById.set(id, reasons[0]);
      blockedReasonsById.set(id, reasons);
    }
  }

  return {
    deletableIds,
    blockedById,
    blockedReasonsById,
    packCountById,
    inventoryCountById,
  };
}

/** Human-readable label per blocked reason, reused in error messages. */
const BLOCKED_REASON_LABEL: Record<BlockedReason, string> = {
  in_packs: "used in pack(s)",
  in_inventory: "held in user inventory",
  in_upgrader_output: "in the upgrader output pool",
  in_upgrader_target: "an upgrader target card",
  in_provably_fair: "referenced by provably-fair records",
};

/**
 * Read-only preview helper for a mass-delete: runs every reference check over
 * `ids` and returns the safe set plus per-id reasons. ADMIN-ONLY — same gate as
 * the destructive `deleteCards`, since it reads which cards are referenced
 * across the platform. Nothing is mutated.
 */
export async function getDeletableCardIds(ids: string[]): Promise<{
  deletable: string[];
  blocked: { id: string; reason: BlockedReason }[];
}> {
  await requireAdmin();

  const parsed = deleteCardsSchema.safeParse({ ids });
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");
  }

  const db = await getDb();
  const check = await checkCardReferences(db, parsed.data.ids);

  return {
    deletable: check.deletableIds,
    blocked: Array.from(check.blockedById.entries()).map(([id, reason]) => ({
      id,
      reason,
    })),
  };
}

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
    // Load the candidate cards (for their names in the blocked report). Missing
    // ids simply don't come back; we only ever delete ids that still exist.
    const cards = await db.cards.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });

    if (cards.length === 0) {
      return fail("None of the selected cards still exist.", "NOT_FOUND");
    }

    const existingIds = cards.map((c) => c.id);
    const nameById = new Map(cards.map((c) => [c.id, c.name]));

    // Single source of truth for every reference check (packs, inventory,
    // upgrader output, upgrader target, provably-fair). Read-only.
    const check = await checkCardReferences(db, existingIds);

    const blocked: BlockedCard[] = Array.from(check.blockedById.entries()).map(
      ([id, reason]) => ({
        id,
        name: nameById.get(id) ?? id,
        reason,
        packCount: check.packCountById.get(id) ?? 0,
        inventoryCount: check.inventoryCountById.get(id) ?? 0,
      }),
    );
    const deletableIds = check.deletableIds;

    if (deletableIds.length === 0) {
      // Nothing safe to delete — surface a clear, specific breakdown rather than
      // a silent no-op so the operator understands why. Count by first-matched
      // reason (same precedence the per-card reason uses).
      const counts = new Map<BlockedReason, number>();
      for (const b of blocked) {
        counts.set(b.reason, (counts.get(b.reason) ?? 0) + 1);
      }
      const parts = Array.from(counts.entries()).map(
        ([reason, n]) => `${n} ${BLOCKED_REASON_LABEL[reason]}`,
      );
      return fail(
        `No cards deleted — ${parts.join(", ")}. Remove cards from packs first; cards held in inventory, used by the upgrader, or referenced by provably-fair records can't be deleted.`,
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
