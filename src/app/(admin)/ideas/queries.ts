import { adminDb } from "@/lib/admin-db";
import type { Idea, IdeaStatus } from "./types";
import { isValidStatus } from "./types";

function isMissingTable(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code === "P2021") return true;
  return err instanceof Error && /relation .* does not exist/i.test(err.message);
}

function isMissingColumn(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code === "P2022") return true;
  return err instanceof Error && /column .* does not exist/i.test(err.message);
}

// Module-level flag so we only run the ALTER statements once per
// server process. Reset to false on failure so the next caller retries.
let positionColumnsEnsured = false;

/**
 * Add the position_x / position_y columns to admin_ideas if they
 * aren't there yet. Uses ADD COLUMN IF NOT EXISTS so concurrent
 * callers can't race (PostgreSQL serializes the ALTER via an
 * ACCESS EXCLUSIVE lock, and IF NOT EXISTS makes the second run a
 * no-op). Callers invoke this lazily on the missing-column error
 * path — nothing fires if the columns are already present.
 *
 * Why auto-apply here instead of a real migration? The column
 * additions are nullable-equivalent (NOT NULL with a default) and
 * never drop or rewrite data, so running them as an app-side
 * idempotent patch is safe. Avoids requiring ops access to the
 * Railway console just to toggle a feature.
 */
export async function ensureIdeaPositionColumns(): Promise<void> {
  if (positionColumnsEnsured) return;
  await adminDb.$executeRawUnsafe(
    `ALTER TABLE "admin_ideas" ADD COLUMN IF NOT EXISTS "position_x" DOUBLE PRECISION NOT NULL DEFAULT 0`,
  );
  await adminDb.$executeRawUnsafe(
    `ALTER TABLE "admin_ideas" ADD COLUMN IF NOT EXISTS "position_y" DOUBLE PRECISION NOT NULL DEFAULT 0`,
  );
  positionColumnsEnsured = true;
}

/**
 * Load all ideas. Two defensive tiers:
 *   1. Table is missing entirely → return []. The page renders an empty
 *      board with a "run the migration" banner.
 *   2. Table exists but the position_x/position_y columns haven't been
 *      applied yet → re-query without those columns and synthesize a
 *      staggered grid so cards are at least visible. The user can't
 *      persist their positions until they run the column migration.
 */
export async function getIdeas(): Promise<Idea[]> {
  try {
    const rows = await adminDb.admin_ideas.findMany({
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        position_x: true,
        position_y: true,
        created_at: true,
        created_by: { select: { id: true, username: true } },
      },
      orderBy: [{ created_at: "asc" }],
    });

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      status: (isValidStatus(r.status) ? r.status : "neutral") as IdeaStatus,
      positionX: r.position_x,
      positionY: r.position_y,
      createdAt: r.created_at.toISOString(),
      createdBy: r.created_by
        ? { id: r.created_by.id, username: r.created_by.username }
        : null,
    }));
  } catch (err) {
    if (isMissingTable(err)) return [];

    if (isMissingColumn(err)) {
      // Columns aren't there yet → add them on the fly, then retry.
      // See ensureIdeaPositionColumns for the safety story.
      try {
        await ensureIdeaPositionColumns();
      } catch (ensureErr) {
        console.error(
          "[ideas] auto-apply of position columns failed — falling back to synthesized layout",
          ensureErr,
        );
        // If the ALTER itself fails (permissions, etc.) we still
        // render the board with a synthesized stagger so the UI
        // isn't broken.
        const rows = await adminDb.admin_ideas.findMany({
          select: {
            id: true,
            title: true,
            description: true,
            status: true,
            created_at: true,
            created_by: { select: { id: true, username: true } },
          },
          orderBy: [{ created_at: "asc" }],
        });
        return rows.map((r, idx) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          status: (isValidStatus(r.status) ? r.status : "neutral") as IdeaStatus,
          positionX: 120 + (idx % 6) * 280,
          positionY: 120 + Math.floor(idx / 6) * 200,
          createdAt: r.created_at.toISOString(),
          createdBy: r.created_by
            ? { id: r.created_by.id, username: r.created_by.username }
            : null,
        }));
      }

      // Retry once with positions now that the columns exist.
      const rows = await adminDb.admin_ideas.findMany({
        select: {
          id: true,
          title: true,
          description: true,
          status: true,
          position_x: true,
          position_y: true,
          created_at: true,
          created_by: { select: { id: true, username: true } },
        },
        orderBy: [{ created_at: "asc" }],
      });
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        status: (isValidStatus(r.status) ? r.status : "neutral") as IdeaStatus,
        positionX: r.position_x,
        positionY: r.position_y,
        createdAt: r.created_at.toISOString(),
        createdBy: r.created_by
          ? { id: r.created_by.id, username: r.created_by.username }
          : null,
      }));
    }

    throw err;
  }
}
