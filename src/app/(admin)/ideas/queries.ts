import { adminDb } from "@/lib/admin-db";
import type { Idea, IdeaStatus } from "./types";
import { isValidStatus } from "./types";

/**
 * Load all ideas, ordered by sort_order ascending. Pre-migration the
 * table may not exist yet — we swallow the missing-table error and
 * return [] so the page can render an empty board + instructions
 * instead of a 500.
 */
export async function getIdeas(): Promise<Idea[]> {
  try {
    const rows = await adminDb.admin_ideas.findMany({
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        created_at: true,
        created_by: { select: { id: true, username: true } },
      },
      orderBy: [{ sort_order: "asc" }, { created_at: "asc" }],
    });

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      status: (isValidStatus(r.status) ? r.status : "neutral") as IdeaStatus,
      createdAt: r.created_at.toISOString(),
      createdBy: r.created_by
        ? { id: r.created_by.id, username: r.created_by.username }
        : null,
    }));
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const missing =
      code === "P2021" ||
      code === "P2022" ||
      (err instanceof Error && /relation .* does not exist/i.test(err.message));
    if (missing) return [];
    throw err;
  }
}
