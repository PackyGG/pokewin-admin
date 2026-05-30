"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";

// Hard cap on a single bulk-move so an accidental "select all" of a giant
// page can't lock up the row-level locks for minutes. 500 lines up with
// roughly 12 default-pages worth of cards which covers any realistic
// human-driven bulk operation.
const BULK_MOVE_MAX = 500;

// ────────────────────────────────────────────────────────────────────
//  bulkMoveCardsToSet
// ────────────────────────────────────────────────────────────────────

const bulkMoveSchema = z.object({
  cardIds: z
    .array(z.string().uuid("Invalid card id"))
    .min(1, "Select at least one card")
    .max(BULK_MOVE_MAX, `Up to ${BULK_MOVE_MAX} cards at a time`),
  setId: z.string().uuid("Invalid set id"),
});

export async function bulkMoveCardsToSet(input: {
  cardIds: string[];
  setId: string;
}): Promise<{ count: number; setName: string }> {
  const session = await requirePageAccess("/cards");
  await requireCapability(session, "__can_update_card", "update cards");

  const parsed = bulkMoveSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const { cardIds, setId } = parsed.data;

  const db = await getDb();

  // Validate the target set exists up-front so we can surface a clean
  // error instead of letting `updateMany` quietly affect 0 rows when the
  // FK target was deleted between the dialog opening and the submit.
  const set = await db.sets.findUnique({
    where: { id: setId },
    select: { id: true, name: true },
  });
  if (!set) throw new Error("Set not found");

  // De-dup just-in-case the client passed duplicate ids.
  const uniqueIds = Array.from(new Set(cardIds));

  const result = await db.cards.updateMany({
    where: { id: { in: uniqueIds } },
    data: { set_id: set.id, updated_at: new Date() },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "cards_bulk_moved_to_set",
    metadata: {
      setId: set.id,
      setName: set.name,
      count: result.count,
      cardIds: uniqueIds,
    },
  });

  revalidatePath("/cards");
  return { count: result.count, setName: set.name };
}

// ────────────────────────────────────────────────────────────────────
//  createSetForCards
// ────────────────────────────────────────────────────────────────────

const createSetSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100, "Name is too long"),
  series: z
    .string()
    .trim()
    .min(1, "Series is required")
    .max(100, "Series is too long"),
  language: z
    .string()
    .trim()
    .min(1, "Language is required")
    .max(20, "Language is too long"),
  releaseDate: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

/**
 * Create a brand-new `sets` row from the bulk-move dialog. The schema
 * requires `image_url` and a UNIQUE `tcgplayer_id` (positive ints come
 * from the TCGPlayer import). We pick:
 *
 *   - `image_url = ""`  — the column is NOT NULL but the existing
 *     <SetsContent /> table tolerates empty strings via its `imageUrl ?`
 *     fallback. Operator can attach an image later from /sets if needed.
 *   - `tcgplayer_id = <next negative>` — real TCG IDs are always positive,
 *     so a monotonically decreasing negative pool ( -1, -2, ... ) can
 *     never collide with imported sets. We compute it via `MIN(tcgplayer_id)`
 *     and subtract one; the table's UNIQUE constraint catches any race.
 */
export async function createSetForCards(input: {
  name: string;
  series: string;
  language: string;
  releaseDate: string | null;
}): Promise<{ id: string; name: string }> {
  const session = await requirePageAccess("/cards");
  await requireCapability(session, "__can_create_set", "create sets");

  const parsed = createSetSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const { name, series, language, releaseDate } = parsed.data;

  let parsedReleaseDate: Date | null = null;
  if (releaseDate) {
    const d = new Date(releaseDate);
    if (Number.isNaN(d.getTime())) throw new Error("Invalid release date");
    parsedReleaseDate = d;
  }

  const db = await getDb();

  // Generate the next free negative tcgplayer_id. Retry on the rare
  // UNIQUE-collision (two admins creating simultaneously) by recomputing.
  let attempt = 0;
  while (attempt < 3) {
    const min = await db.sets.aggregate({ _min: { tcgplayer_id: true } });
    const baseline = min._min.tcgplayer_id ?? 0;
    // If the only existing sets have positive ids, start at -1. Otherwise
    // step one below the current minimum.
    const nextId = baseline < 0 ? baseline - 1 : -1;

    try {
      const set = await db.sets.create({
        data: {
          name,
          series,
          image_url: "",
          language,
          tcgplayer_id: nextId,
          release_date: parsedReleaseDate,
        },
      });

      await createAdminAuditEvent({
        adminUserId: session.userId,
        eventType: "set_created",
        metadata: {
          set_id: set.id,
          name,
          series,
          source: "bulk_move_dialog",
          tcgplayer_id: nextId,
        },
      });

      revalidatePath("/cards");
      revalidatePath("/sets");
      return { id: set.id, name: set.name };
    } catch (e) {
      // Re-roll on UNIQUE collision and bubble anything else up unchanged.
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
