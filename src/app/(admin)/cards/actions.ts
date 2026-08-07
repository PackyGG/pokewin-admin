"use server";

import { pgArrayParam } from "@/lib/drizzle-array-param";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { getPrimaryDrizzleDb, type MainDrizzleDb } from "@/lib/db";
// requirePageAccess (not bare verifySession): capabilities and page keys are
// granted INDEPENDENTLY in this panel, so a role holding `__can_update_card`
// without `/cards` could mutate cards it can never see. The read siblings
// already gate on the page key — the writers now match.
import { requirePageAccess, requireAdmin } from "@/lib/dal";
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
  isPostgresError,
  postgresErrorMessages,
} from "@/lib/postgres-errors";
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
 * "column does not exist" errors.
 *
 * We match the engine code first (stable across messages) and fall back
 * to the message text so we still recognise it if a future engine
 * version reports it differently. The message check is scoped to
 * cost/power so we never silently swallow an unrelated missing column.
 */
function isMissingCostPowerColumnError(e: unknown): boolean {
  return (
    isPostgresError(e, "42703") ||
    /column\b[^]*\b(cost|power)\b[^]*does not exist/i.test(
      postgresErrorMessages(e),
    )
  );
}

async function uploadCardImage(formData: FormData): Promise<string> {
  const session = await requirePageAccess("/cards");
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
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/cards");

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
    const set = (
      await db.execute<{ id: string; name: string }>(sql`
        SELECT id, name FROM sets WHERE id = ${input.setId}::uuid LIMIT 1
      `)
    ).rows[0];
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
  // passing `null`) keeps those columns out of the INSERT
  // column list — so the write succeeds even on a DB where the
  // cost/power migration hasn't run. `select: { id: true }` is the other
  // half of that: it restricts the RETURNING clause to `id` only,
  // and the explicit RETURNING avoids unrelated model columns
  // (including cost/power) and would fail before we ever read the row.
  const insertCard = async (includeStats: boolean): Promise<{ id: string }> => {
    const result = includeStats
      ? await db.execute<{ id: string }>(sql`
          INSERT INTO cards (
            name, image_url, price, price_raw, hp, rarity, artist,
            tcgplayer_id, type, card_number, set_id, cost, power
          ) VALUES (
            ${input.name}, ${input.imageUrl}, ${input.price}, ${input.price},
            ${input.hp}, ${input.rarity},
            ${input.artist?.trim() ? input.artist.trim() : null},
            ${input.tcgplayerId}, ${input.type},
            ${input.cardNumber?.trim() || null}, ${input.setId}::uuid,
            ${input.cost ?? null}, ${input.power ?? null}
          )
          RETURNING id
        `)
      : await db.execute<{ id: string }>(sql`
          INSERT INTO cards (
            name, image_url, price, price_raw, hp, rarity, artist,
            tcgplayer_id, type, card_number, set_id
          ) VALUES (
            ${input.name}, ${input.imageUrl}, ${input.price}, ${input.price},
            ${input.hp}, ${input.rarity},
            ${input.artist?.trim() ? input.artist.trim() : null},
            ${input.tcgplayerId}, ${input.type},
            ${input.cardNumber?.trim() || null}, ${input.setId}::uuid
          )
          RETURNING id
        `);
    const row = result.rows[0];
    if (!row) throw new Error("Card insert returned no row");
    return row;
  };

  let card: { id: string };
  try {
    try {
      card = await insertCard(input.cost != null || input.power != null);
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
        card = await insertCard(false);
      } else {
        throw err;
      }
    }
  } catch (err) {
    // Real database error → server log (Vercel function logs) so the
    // on-call sees the column / constraint that actually failed. The
    // client gets the message too (no secrets in a database schema/
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
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/cards");

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
  // Return only the id so the update does not depend on unrelated columns.
  // listing every model column — including cost/power — and the write
  // fails with 42703 on a DB that hasn't run the cost/power migration.
  // Restricting RETURNING to `id` keeps update working regardless.
  try {
    const result = await db.execute<{ id: string }>(sql`
      UPDATE cards
      SET name = ${data.name.trim()},
          image_url = ${data.imageUrl},
          price = ${data.price},
          price_raw = ${data.price},
          hp = ${data.hp},
          rarity = ${data.rarity},
          artist = ${data.artist?.trim() ?? null},
          tcgplayer_id = ${data.tcgplayerId},
          type = ${data.type},
          card_number = ${data.cardNumber?.trim() || null},
          set_id = ${data.setId || null}::uuid,
          updated_at = NOW()
      WHERE id = ${id}::uuid
      RETURNING id
    `);
    if (result.rows.length === 0) return fail("Card not found", "NOT_FOUND");
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
    // client toast — same reasoning as createCard.
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
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/cards");
  await requireCapability(session, "__can_delete_card", "delete cards");

  const card = (
    await db.execute<{
      name: string;
      pack_names: string[];
    }>(sql`
      SELECT c.name,
             COALESCE(array_agg(p.name) FILTER (WHERE p.id IS NOT NULL),
                      ARRAY[]::text[]) AS pack_names
      FROM cards c
      LEFT JOIN pack_cards pc ON pc.card_id = c.id
      LEFT JOIN packs p ON p.id = pc.pack_id
      WHERE c.id = ${cardId}::uuid
      GROUP BY c.id
    `)
  ).rows[0];

  if (!card) throw new Error("Card not found");

  // Keep the rich pack-names message (most common, most actionable case)…
  if (card.pack_names.length > 0) {
    const packNames = card.pack_names.join(", ");
    throw new Error(
      `Card is used in ${card.pack_names.length} pack(s): ${packNames}. Remove it from those packs first.`,
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

  const deleted = await db.execute<{ id: string }>(sql`
    DELETE FROM cards WHERE id = ${cardId}::uuid RETURNING id
  `);
  if (deleted.rows.length === 0) throw new Error("Card not found");

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
 * are ordered most-actionable first: packs → inventory → upgrader → fairness).
 */
type CardReferenceCheck = {
  /** ids that have NO reference of any kind → safe to delete. */
  deletableIds: string[];
  /** first-matched reason per blocked id. */
  blockedById: Map<string, BlockedReason>;
  /** pack reference count per candidate id (0 when none). */
  packCountById: Map<string, number>;
  /** inventory holding count per candidate id (0 when none). */
  inventoryCountById: Map<string, number>;
};

/**
 * Run ALL five read-only reference checks over `ids` and return the safe set
 * plus per-card reasons. This is the single source of truth for "is this card
 * safe to delete" — both the bulk `deleteCards` and the single `deleteCard`
 * go through it so the rules can never drift between callers.
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
  db: Pick<MainDrizzleDb, "execute">,
  ids: string[],
): Promise<CardReferenceCheck> {
  // De-dup defensively so counts/maps are keyed once per id.
  const uniqueIds = Array.from(new Set(ids));

  if (uniqueIds.length === 0) {
    return {
      deletableIds: [],
      blockedById: new Map(),
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
    db.execute<{ card_id: string; count: string }>(sql`
      SELECT card_id, COUNT(*)::text AS count
      FROM pack_cards
      WHERE card_id = ANY(${pgArrayParam(uniqueIds)}::uuid[])
      GROUP BY card_id
    `),
    // 2. user_inventory — soft reference (no FK); count holdings per card.
    db.execute<{ card_id: string; count: string }>(sql`
      SELECT card_id, COUNT(*)::text AS count
      FROM user_inventory
      WHERE card_id = ANY(${pgArrayParam(uniqueIds)}::uuid[])
      GROUP BY card_id
    `),
    // 3. upgrader_output_cards — card_id is UNIQUE, so just fetch the ids that
    //    appear; presence ⇒ blocked.
    db.execute<{ card_id: string }>(sql`
      SELECT card_id FROM upgrader_output_cards
      WHERE card_id = ANY(${pgArrayParam(uniqueIds)}::uuid[])
    `),
    // 4. upgrader_games.target_card_id — RESTRICT FK; group so we know which
    //    candidate ids are referenced as an upgrader target.
    db.execute<{ target_card_id: string }>(sql`
      SELECT DISTINCT target_card_id
      FROM upgrader_games
      WHERE target_card_id = ANY(${pgArrayParam(uniqueIds)}::uuid[])
    `),
    // 5. provably_fair_results.result_metadata — Json soft reference. A card id
    //    can sit at the top level as the rolled `card_id` OR (for upgrader
    //    rolls) nested as `target_card_id`. Each branch probes with jsonb
    //    containment (`@> ANY(ARRAY[...])`) so it is served by the
    //    `idx_pf_result_metadata_gin` (jsonb_path_ops) index as a Bitmap Index
    //    Scan. The `->>'…' IN (...)` text-extraction form a jsonb_path_ops GIN
    //    CANNOT use — it seq-scans the whole 3.4M-row table (~1s); EXPLAIN
    //    against prod confirms the `@>` form is the index lookup (cost ~1.3k vs
    //    ~379k). The SELECT still extracts the matched id; Drizzle safely
    //    parameterises each id (no string interpolation).
    db.execute<{ card_id: string }>(sql`
      SELECT DISTINCT t.card_id FROM (
        SELECT (result_metadata->>'card_id') AS card_id
          FROM provably_fair_results
         WHERE result_metadata @> ANY (
           SELECT jsonb_build_object('card_id', id)
           FROM unnest(${pgArrayParam(uniqueIds)}::text[]) AS ids(id)
         )
        UNION ALL
        SELECT (result_metadata->>'target_card_id') AS card_id
          FROM provably_fair_results
         WHERE result_metadata @> ANY (
           SELECT jsonb_build_object('target_card_id', id)
           FROM unnest(${pgArrayParam(uniqueIds)}::text[]) AS ids(id)
         )
      ) t
    `),
  ]);

  const packCountById = new Map<string, number>(
    packGroups.rows.map((g) => [g.card_id, Number(g.count)]),
  );
  const inventoryCountById = new Map<string, number>(
    inventoryGroups.rows.map((g) => [g.card_id, Number(g.count)]),
  );
  const upgraderOutputIds = new Set(upgraderOutputs.rows.map((r) => r.card_id));
  const upgraderTargetIds = new Set(
    upgraderTargetGroups.rows
      .map((g) => g.target_card_id)
      .filter((id): id is string => id != null),
  );
  const provablyFairIds = new Set(
    provablyFairRows.rows
      .map((r) => r.card_id)
      .filter((id): id is string => id != null),
  );

  const deletableIds: string[] = [];
  const blockedById = new Map<string, BlockedReason>();

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
    }
  }

  return {
    deletableIds,
    blockedById,
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
 *     2. `user_inventory.card_id` → a SOFT reference: in the application schema
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

  const db = await getPrimaryDrizzleDb();

  try {
    // Load the candidate cards (for their names in the blocked report). Missing
    // ids simply don't come back; we only ever delete ids that still exist.
    const cards = (
      await db.execute<{ id: string; name: string }>(sql`
        SELECT id, name FROM cards WHERE id = ANY(${pgArrayParam(ids)}::uuid[])
      `)
    ).rows;

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

    // TOCTOU guard: between the reference check above and the delete a card
    // could gain a SOFT reference (a `user_inventory` row or a `provably_fair`
    // record — neither is FK-backed, so the DB would NOT block deleting an
    // in-window-referenced card and we'd orphan that reference). Re-run the
    // reference check for the deletable subset INSIDE a serializable transaction
    // immediately before `deleteMany`, and delete only the ids that are STILL
    // unreferenced. FK-backed classes (pack_cards, upgrader) are already caught
    // by their constraints; this closes the soft-ref window too. Ids that became
    // referenced in the window are reported back as freshly blocked.
    const { result, lateBlockedIds } = await db.transaction(
      async (tx) => {
        const recheck = await checkCardReferences(tx, deletableIds);
        const safeNow = recheck.deletableIds;
        const lateBlocked = deletableIds.filter(
          (id) => !recheck.deletableIds.includes(id),
        );
        if (safeNow.length === 0) {
          return { result: { count: 0 }, lateBlockedIds: lateBlocked };
        }
        const deleted = await tx.execute<{ id: string }>(sql`
          DELETE FROM cards WHERE id = ANY(${pgArrayParam(safeNow)}::uuid[]) RETURNING id
        `);
        return {
          result: { count: deleted.rowCount ?? deleted.rows.length },
          lateBlockedIds: lateBlocked,
        };
      },
      { isolationLevel: "serializable" },
    );

    // The ids actually removed (the deletable set minus any that became
    // referenced inside the window).
    const deletedIds = deletableIds.filter((id) => !lateBlockedIds.includes(id));

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "cards_bulk_deleted",
      metadata: {
        deleted_count: result.count,
        deleted_card_ids: deletedIds,
        blocked_count: blocked.length,
        blocked_card_ids: blocked.map((b) => b.id),
        ...(lateBlockedIds.length > 0 && {
          late_blocked_card_ids: lateBlockedIds,
        }),
      },
    });

    revalidatePath("/cards");
    return ok({
      deletedCount: result.count,
      deletedIds,
      blocked,
    });
  } catch (err) {
    logError("cards.deleteCards", "bulk delete failed", err);
    return fail("Something went wrong deleting cards — please try again.");
  }
}
