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
      // Pre-position-migration fallback — read without the new columns
      // and synthesize a staggered layout so the board isn't a pile at
      // (0,0).
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

    throw err;
  }
}
