"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { uploadImage } from "@/lib/imagekit";

export async function uploadSetImage(formData: FormData): Promise<string> {
  const session = await requireAdmin();
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
  tx: Prisma.TransactionClient,
): Promise<number> {
  const min = await tx.sets.aggregate({ _min: { tcgplayer_id: true } });
  const baseline = min._min.tcgplayer_id ?? 0;
  return baseline < 0 ? baseline - 1 : -1;
}

// ────────────────────────────────────────────────────────────────────
//  createSet
// ────────────────────────────────────────────────────────────────────

export async function createSet(data: {
  name: string;
  language: string;
}): Promise<string> {
  const db = await getDb();
  const session = await requireAdmin();

  if (!data.name.trim()) throw new Error("Name is required");
  if (!data.language.trim()) throw new Error("Language is required");

  await requireCapability(session, "__can_create_set", "create sets");

  // `series` is NOT NULL with no default and `release_date` is nullable
  // (see prisma/schema.prisma `model sets`). The UI no longer exposes
  // either field, so create-time inserts default to an empty `series`
  // and a null `release_date`. Existing rows keep their values; admins
  // who need to backfill use the import scripts, not this dialog.
  // Retry on rare UNIQUE collision when two admins create simultaneously.
  let attempt = 0;
  while (attempt < 3) {
    try {
      const set = await db.$transaction(async (tx) => {
        const nextId = await nextNegativeTcgplayerId(tx);
        return tx.sets.create({
          data: {
            name: data.name.trim(),
            series: "",
            image_url: "",
            language: data.language.trim(),
            tcgplayer_id: nextId,
            release_date: null,
          },
        });
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

      revalidatePath("/sets");
      // The card-create dropdown reads from the same table.
      revalidatePath("/cards");
      return set.id;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
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
    language: string;
  },
): Promise<void> {
  const db = await getDb();
  const session = await requireAdmin();

  if (!id) throw new Error("Set id is required");
  if (!data.name.trim()) throw new Error("Name is required");
  if (!data.language.trim()) throw new Error("Language is required");

  await requireCapability(session, "__can_update_set", "update sets");

  const existing = await db.sets.findUnique({
    where: { id },
    select: { id: true, name: true, language: true },
  });
  if (!existing) throw new Error("Set not found");

  // `series` and `release_date` are intentionally NOT touched here —
  // the UI no longer exposes them and historical values are managed
  // by import scripts. Keeping them out of the update payload prevents
  // admins from accidentally clearing them via this surface.
  await db.sets.update({
    where: { id },
    data: {
      name: data.name.trim(),
      language: data.language.trim(),
      updated_at: new Date(),
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "set_updated",
    metadata: {
      set_id: id,
      previous: existing,
      next: {
        name: data.name.trim(),
        language: data.language.trim(),
      },
    },
  });

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
//  Everything runs inside a single Prisma transaction so the creates and
//  the bulk update commit together — partial state is impossible.
// ────────────────────────────────────────────────────────────────────

export async function seedInitialSets(): Promise<{
  pokemonSetId: string;
  onepieceSetId: string;
  cardsMoved: number;
  pokemonCreated: boolean;
  onepieceCreated: boolean;
}> {
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(
    session,
    "__can_seed_initial_sets",
    "seed initial sets",
  );

  const POKEMON_NAME = "Pokemon";
  const ONEPIECE_NAME = "OnePiece";
  const DEFAULT_SERIES = "Catalog";
  const DEFAULT_LANGUAGE = "en";

  const result = await db.$transaction(async (tx) => {
    // 1. Upsert Pokemon by name (idempotent).
    let pokemonCreated = false;
    let pokemon = await tx.sets.findFirst({
      where: { name: POKEMON_NAME },
      select: { id: true, name: true },
    });
    if (!pokemon) {
      const nextId = await nextNegativeTcgplayerId(tx);
      pokemon = await tx.sets.create({
        data: {
          name: POKEMON_NAME,
          series: DEFAULT_SERIES,
          image_url: "",
          language: DEFAULT_LANGUAGE,
          tcgplayer_id: nextId,
        },
        select: { id: true, name: true },
      });
      pokemonCreated = true;
    }

    // 2. Upsert OnePiece by name (idempotent).
    let onepieceCreated = false;
    let onepiece = await tx.sets.findFirst({
      where: { name: ONEPIECE_NAME },
      select: { id: true, name: true },
    });
    if (!onepiece) {
      const nextId = await nextNegativeTcgplayerId(tx);
      onepiece = await tx.sets.create({
        data: {
          name: ONEPIECE_NAME,
          series: DEFAULT_SERIES,
          image_url: "",
          language: DEFAULT_LANGUAGE,
          tcgplayer_id: nextId,
        },
        select: { id: true, name: true },
      });
      onepieceCreated = true;
    }

    // 3. Bulk-move every card with NULL set_id into Pokemon. Cards that
    //    already have a set assignment are left alone.
    const moveResult = await tx.cards.updateMany({
      where: { set_id: null },
      data: { set_id: pokemon.id, updated_at: new Date() },
    });

    return {
      pokemonSetId: pokemon.id,
      onepieceSetId: onepiece.id,
      cardsMoved: moveResult.count,
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

  revalidatePath("/sets");
  revalidatePath("/cards");
  return result;
}
