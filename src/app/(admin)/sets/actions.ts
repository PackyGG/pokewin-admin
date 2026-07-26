"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { sql } from "drizzle-orm";
import { getDrizzleDb, type MainDrizzleDb } from "@/lib/db";
import { SETS_CACHE_TAG } from "@/lib/queries/sets";
import { verifySession } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { uploadImage } from "@/lib/imagekit";
import {
  ok,
  fail,
  type ServerActionResult,
} from "@/lib/errors/server-action-result";
import { logError } from "@/lib/errors/logger";

export async function uploadSetImage(formData: FormData): Promise<string> {
  const session = await verifySession();
  await requireCapability(session, "__can_upload_set_image", "upload set images");

  const file = formData.get("file");
  if (!(file instanceof File)) throw new Error("No file provided");
  if (!file.type.startsWith("image/")) throw new Error("File must be an image");
  if (file.size > 5 * 1024 * 1024) throw new Error("File must be under 5MB");

  const buffer = Buffer.from(await file.arrayBuffer());
  const url = await uploadImage(buffer, file.name, "/sets");
  return url;
}

// ────────────────────────────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────────────────────────────

/**
 * The `sets` table requires `tcgplayer_id` (Int NOT NULL UNIQUE) and
 * `image_url` (String NOT NULL). Both fields are now hidden from the
 * /sets UI — we keep the columns intact so existing data isn't lost,
 * but newly created sets need synthetic values.
 *
 * We follow the existing convention from `cards/set-actions.ts` →
 * `createSetForCards`: real TCGPlayer IDs are always positive, so we
 * allocate the next free negative integer (-1, -2, …) which can never
 * collide with imported sets. Returns the new ID. UNIQUE collisions
 * on the rare race are retried up to 3 times by the caller.
 */
async function nextNegativeTcgplayerId(
  tx: Pick<MainDrizzleDb, "execute">,
): Promise<number> {
  const result = await tx.execute<{ min_id: number | null }>(sql`
    SELECT MIN(tcgplayer_id)::int AS min_id FROM sets
  `);
  const baseline = result.rows[0]?.min_id ?? 0;
  return baseline < 0 ? baseline - 1 : -1;
}

function postgresErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as { code?: string }).code;
  if (code) return code;
  return postgresErrorCode(error.cause);
}

// ────────────────────────────────────────────────────────────────────
//  createSet
// ────────────────────────────────────────────────────────────────────

export async function createSet(data: { name: string }): Promise<string> {
  const db = await getDrizzleDb();
  const session = await verifySession();

  if (!data.name.trim()) throw new Error("Name is required");

  await requireCapability(session, "__can_create_set", "create sets");

  // `series` and `language` are NOT NULL with no default and `release_date`
  // is nullable (see the MAIN Drizzle `sets` table). The dialog is now
  // name-only, so create-time inserts default to an empty `series`, the
  // project-standard language `"en"` (same value used by `seedInitialSets`
  // below), and a null `release_date`. Existing rows keep their values;
  // admins who need to backfill use the import scripts, not this dialog.
  // Retry on rare UNIQUE collision when two admins create simultaneously.
  let attempt = 0;
  while (attempt < 3) {
    try {
      const set = await db.transaction(async (tx) => {
        const nextId = await nextNegativeTcgplayerId(tx);
        const result = await tx.execute<{
          id: string;
          name: string;
          tcgplayer_id: number;
        }>(sql`
          INSERT INTO sets (
            name, series, image_url, language, tcgplayer_id, release_date
          ) VALUES (${data.name.trim()}, '', '', 'en', ${nextId}, NULL)
          RETURNING id, name, tcgplayer_id
        `);
        const row = result.rows[0];
        if (!row) throw new Error("Set insert returned no row");
        return row;
      });

      await createAdminAuditEvent({
        adminUserId: session.userId,
        eventType: "set_created",
        metadata: {
          set_id: set.id,
          name: set.name,
          tcgplayer_id: set.tcgplayer_id,
        },
      });

      revalidateTag(SETS_CACHE_TAG);
      revalidatePath("/sets");
      // The card-create dropdown reads from the same table.
      revalidatePath("/cards");
      return set.id;
    } catch (e) {
      if (
        postgresErrorCode(e) === "23505"
      ) {
        attempt += 1;
        continue;
      }
      throw e;
    }
  }

  throw new Error("Could not allocate a unique TCGPlayer ID — try again");
}

// ────────────────────────────────────────────────────────────────────
//  updateSet
// ────────────────────────────────────────────────────────────────────

export async function updateSet(
  id: string,
  data: {
    name: string;
  },
): Promise<void> {
  const db = await getDrizzleDb();
  const session = await verifySession();

  if (!id) throw new Error("Set id is required");
  if (!data.name.trim()) throw new Error("Name is required");

  await requireCapability(session, "__can_update_set", "update sets");

  const existingResult = await db.execute<{ id: string; name: string }>(sql`
    SELECT id, name FROM sets WHERE id = ${id}::uuid LIMIT 1
  `);
  const existing = existingResult.rows[0];
  if (!existing) throw new Error("Set not found");

  // `series`, `language` and `release_date` are intentionally NOT touched
  // here — the UI no longer exposes them and historical values are managed
  // by import scripts. Keeping them out of the update payload prevents
  // admins from accidentally clearing them via this surface.
  await db.execute(sql`
    UPDATE sets
    SET name = ${data.name.trim()}, updated_at = NOW()
    WHERE id = ${id}::uuid
  `);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "set_updated",
    metadata: {
      set_id: id,
      previous: existing,
      next: {
        name: data.name.trim(),
      },
    },
  });

  revalidateTag(SETS_CACHE_TAG);
  revalidatePath("/sets");
  revalidatePath("/cards");
}

// ────────────────────────────────────────────────────────────────────
//  seedInitialSets
//
//  One-time backfill triggered by an explicit admin click on /sets.
//  Idempotent:
//    - "Pokemon" and "OnePiece" sets are upserted by name (no duplicates).
//    - All `cards` rows with `set_id IS NULL` are assigned to Pokemon.
//      Cards that already belong to a set are NOT touched.
//  Everything runs inside a single database transaction so the creates and
//  the bulk update commit together — partial state is impossible.
// ────────────────────────────────────────────────────────────────────

export async function seedInitialSets(): Promise<{
  pokemonSetId: string;
  onepieceSetId: string;
  cardsMoved: number;
  pokemonCreated: boolean;
  onepieceCreated: boolean;
}> {
  const db = await getDrizzleDb();
  const session = await verifySession();
  await requireCapability(
    session,
    "__can_seed_initial_sets",
    "seed initial sets",
  );

  const POKEMON_NAME = "Pokemon";
  const ONEPIECE_NAME = "OnePiece";
  const DEFAULT_SERIES = "Catalog";
  const DEFAULT_LANGUAGE = "en";

  const result = await db.transaction(async (tx) => {
    // 1. Upsert Pokemon by name (idempotent).
    let pokemonCreated = false;
    let pokemon = (
      await tx.execute<{ id: string; name: string }>(sql`
        SELECT id, name FROM sets WHERE name = ${POKEMON_NAME} LIMIT 1
      `)
    ).rows[0];
    if (!pokemon) {
      const nextId = await nextNegativeTcgplayerId(tx);
      pokemon = (
        await tx.execute<{ id: string; name: string }>(sql`
          INSERT INTO sets (
            name, series, image_url, language, tcgplayer_id
          ) VALUES (
            ${POKEMON_NAME}, ${DEFAULT_SERIES}, '', ${DEFAULT_LANGUAGE}, ${nextId}
          )
          RETURNING id, name
        `)
      ).rows[0];
      if (!pokemon) throw new Error("Pokemon set insert returned no row");
      pokemonCreated = true;
    }

    // 2. Upsert OnePiece by name (idempotent).
    let onepieceCreated = false;
    let onepiece = (
      await tx.execute<{ id: string; name: string }>(sql`
        SELECT id, name FROM sets WHERE name = ${ONEPIECE_NAME} LIMIT 1
      `)
    ).rows[0];
    if (!onepiece) {
      const nextId = await nextNegativeTcgplayerId(tx);
      onepiece = (
        await tx.execute<{ id: string; name: string }>(sql`
          INSERT INTO sets (
            name, series, image_url, language, tcgplayer_id
          ) VALUES (
            ${ONEPIECE_NAME}, ${DEFAULT_SERIES}, '', ${DEFAULT_LANGUAGE}, ${nextId}
          )
          RETURNING id, name
        `)
      ).rows[0];
      if (!onepiece) throw new Error("OnePiece set insert returned no row");
      onepieceCreated = true;
    }

    // 3. Bulk-move every card with NULL set_id into Pokemon. Cards that
    //    already have a set assignment are left alone.
    const moveResult = await tx.execute<{ id: string }>(sql`
      UPDATE cards
      SET set_id = ${pokemon.id}::uuid, updated_at = NOW()
      WHERE set_id IS NULL
      RETURNING id
    `);

    return {
      pokemonSetId: pokemon.id,
      onepieceSetId: onepiece.id,
      cardsMoved: moveResult.rowCount ?? moveResult.rows.length,
      pokemonCreated,
      onepieceCreated,
    };
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "initial_sets_seeded",
    metadata: {
      pokemon_set_id: result.pokemonSetId,
      onepiece_set_id: result.onepieceSetId,
      pokemon_created: result.pokemonCreated,
      onepiece_created: result.onepieceCreated,
      cards_moved: result.cardsMoved,
    },
  });

  revalidateTag(SETS_CACHE_TAG);
  revalidatePath("/sets");
  revalidatePath("/cards");
  return result;
}

// ────────────────────────────────────────────────────────────────────
//  forceAbsorbIntoPokemon
//
//  Bulk-reassignment for the "we have ~50k cards from legacy TCGPlayer
//  imports that the initial seed missed" case. The initial seed
//  (`seedInitialSets` above) only moved cards with `set_id IS NULL` —
//  cards already assigned to one of the legacy TCGPlayer-import sets
//  were left in place. This action sweeps EVERYTHING that isn't
//  OnePiece into Pokemon.
//
//  Idempotent:
//    - Cards already in Pokemon stay there (no-op).
//    - Cards in OnePiece are excluded (never touched).
//    - Cards with NULL set_id move to Pokemon.
//    - Cards in any other set move to Pokemon.
//  Empty legacy sets (any set NOT named Pokemon / OnePiece with zero
//  cards remaining) are deleted in a separate cleanup pass after the
//  move — running this on a clean catalog deletes nothing.
//
//  Requires Pokemon AND OnePiece to already exist (run `seedInitialSets`
//  first). The action throws if either is missing rather than guessing.
// ────────────────────────────────────────────────────────────────────

export async function forceAbsorbIntoPokemon(): Promise<{
  pokemonSetId: string;
  onepieceSetId: string;
  cardsMoved: number;
  legacySetsDeleted: number;
}> {
  const db = await getDrizzleDb();
  const session = await verifySession();
  await requireCapability(
    session,
    "__can_force_absorb_cards",
    "force-absorb cards into Pokemon",
  );

  const POKEMON_NAME = "Pokemon";
  const ONEPIECE_NAME = "OnePiece";

  // 1. Resolve Pokemon + OnePiece set IDs. Both must already exist —
  //    this action is the second step of the catalog bootstrap, the
  //    first being `seedInitialSets` which creates both sets.
  const pokemon = (
    await db.execute<{ id: string }>(sql`
      SELECT id FROM sets WHERE name = ${POKEMON_NAME} LIMIT 1
    `)
  ).rows[0];
  if (!pokemon) {
    throw new Error("Pokemon set not found — run \"Seed initial sets\" first.");
  }
  const onepiece = (
    await db.execute<{ id: string }>(sql`
      SELECT id FROM sets WHERE name = ${ONEPIECE_NAME} LIMIT 1
    `)
  ).rows[0];
  if (!onepiece) {
    throw new Error("OnePiece set not found — run \"Seed initial sets\" first.");
  }

  // 2. The bulk move. Single updateMany inside a transaction so a
  //    partial update is impossible if Postgres flinches. Sweeps:
  //      - cards already in legacy import sets
  //      - cards with NULL set_id
  //      - cards already in Pokemon (no-op, idempotent)
  //    The ONLY rows skipped are those whose set_id is the OnePiece UUID.
  const cardsMoved = await db.transaction(async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      UPDATE cards
      SET set_id = ${pokemon.id}::uuid, updated_at = NOW()
      WHERE set_id IS DISTINCT FROM ${onepiece.id}::uuid
      RETURNING id
    `);
    return result.rowCount ?? result.rows.length;
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "cards_force_absorbed_into_pokemon",
    metadata: {
      pokemon_set_id: pokemon.id,
      onepiece_set_id: onepiece.id,
      cards_moved: cardsMoved,
    },
  });

  // 3. Cleanup pass — delete any set that isn't Pokemon or OnePiece AND
  //    has zero remaining cards. After step 2, every legacy import set
  //    is empty by definition; the relation filter `cards: { none: {} }`
  //    is a defensive net in case a stray card lingered (e.g. a row
  //    inserted between steps 2 and 3 against a legacy set_id).
  //
  //    Logged as a separate audit event so the move and the cleanup are
  //    auditable independently, even though they almost always run as
  //    a pair from the UI button.
  const deleteResult = await db.execute<{ id: string }>(sql`
    DELETE FROM sets s
    WHERE s.name NOT IN (${POKEMON_NAME}, ${ONEPIECE_NAME})
      AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.set_id = s.id)
    RETURNING s.id
  `);
  const legacySetsDeleted =
    deleteResult.rowCount ?? deleteResult.rows.length;
  if (legacySetsDeleted > 0) {

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "empty_legacy_sets_deleted",
      metadata: {
        legacy_sets_deleted: legacySetsDeleted,
      },
    });
  }

  revalidateTag(SETS_CACHE_TAG);
  revalidatePath("/sets");
  revalidatePath("/cards");
  return {
    pokemonSetId: pokemon.id,
    onepieceSetId: onepiece.id,
    cardsMoved,
    legacySetsDeleted,
  };
}

// ────────────────────────────────────────────────────────────────────
//  deleteSet
//
//  Deletes a set WITHOUT touching the cards' rows themselves. The
//  cards.set_id FK is declared `onDelete: Cascade` in the schema, so
//  a direct `sets.delete()` would wipe every card in the set — the
//  opposite of what an admin wants when retiring a series. We nullify
//  set_id first in the same transaction so the cards survive as
//  orphan rows and can be bulk-reassigned via /cards.
// ────────────────────────────────────────────────────────────────────

export async function deleteSet(
  id: string,
): Promise<ServerActionResult<{ id: string; cardsOrphaned: number }>> {
  const db = await getDrizzleDb();
  const session = await verifySession();

  try {
    await requireCapability(session, "__can_delete_set", "delete sets");
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : "Permission denied",
      "FORBIDDEN",
    );
  }

  if (!id) {
    return fail("Set id is required.", "VALIDATION");
  }

  const existing = (
    await db.execute<{ id: string; name: string }>(sql`
      SELECT id, name FROM sets WHERE id = ${id}::uuid LIMIT 1
    `)
  ).rows[0];
  if (!existing) {
    return fail("Set not found.", "NOT_FOUND");
  }

  let cardsOrphaned = 0;
  try {
    const result = await db.transaction(async (tx) => {
      // Orphan the cards FIRST so the cascade FK on cards.set_id has
      // nothing left to chain through when we delete the set below.
      // Bumping updated_at mirrors the convention used by
      // seedInitialSets for bulk cards.updateMany.
      const updated = await tx.execute<{ id: string }>(sql`
        UPDATE cards
        SET set_id = NULL, updated_at = NOW()
        WHERE set_id = ${id}::uuid
        RETURNING id
      `);
      const deleted = await tx.execute<{ id: string }>(sql`
        DELETE FROM sets WHERE id = ${id}::uuid RETURNING id
      `);
      if (deleted.rows.length === 0) throw new Error("SET_NOT_FOUND");
      return { count: updated.rowCount ?? updated.rows.length };
    });
    cardsOrphaned = result.count;
  } catch (err) {
    logError("sets.delete", `delete transaction failed for ${id}`, err);
    if (
      err instanceof Error && err.message === "SET_NOT_FOUND"
    ) {
      return fail("Set not found.", "NOT_FOUND");
    }
    return fail("Couldn't delete this set — please try again.");
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "set_deleted",
    metadata: {
      set_id: id,
      name: existing.name,
      cards_orphaned: cardsOrphaned,
    },
  });

  revalidateTag(SETS_CACHE_TAG);
  revalidatePath("/sets");
  // Orphan cards now show on /cards with no set assignment.
  revalidatePath("/cards");

  return ok({ id, cardsOrphaned });
}
