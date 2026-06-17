import "server-only";

import { adminDb } from "@/lib/admin-db";
import type { PackSetFilter } from "@/lib/queries/packs";

// Runtime pool list kept LOCAL (not imported from packs.ts) so this admin-DB
// helper doesn't create a runtime import cycle with the main-DB query module
// — only the PackSetFilter *type* is imported (erased at runtime).
const VALID_POOLS = ["pokemon", "onepiece", "rewards", "meme"] as const;

export type PackSetAssignments = {
  /** pack_id → assigned pool. */
  byId: Map<string, PackSetFilter>;
  /** assigned pack ids grouped by pool. */
  idsBySet: Partial<Record<PackSetFilter, string[]>>;
  /** every pack id that has an explicit assignment. */
  allIds: string[];
};

const EMPTY: PackSetAssignments = {
  byId: new Map(),
  idsBySet: {},
  allIds: [],
};

/**
 * The `pack_set_assignments` table is provisioned via a runtime ensure-schema
 * fallback, so on a fresh env it may not exist yet. Treat "table/relation does
 * not exist" as "no overrides" and degrade to the card-derived classification,
 * exactly like the other admin self-heal tables (src/lib/admin-settings.ts).
 */
function isMissingTableError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const code = (e as { code?: string }).code;
  if (code === "P2021" || code === "P2022") return true;
  const msg = ((e as { message?: string }).message ?? "").toLowerCase();
  return msg.includes("42p01") || msg.includes("does not exist");
}

function asPool(value: string): PackSetFilter | null {
  return (VALID_POOLS as readonly string[]).includes(value)
    ? (value as PackSetFilter)
    : null;
}

/** All per-pack set overrides, grouped for the /packs pool predicates. */
export async function getPackSetAssignmentsGrouped(): Promise<PackSetAssignments> {
  try {
    const rows = await adminDb.pack_set_assignments.findMany({
      select: { pack_id: true, pack_set: true },
    });
    const byId = new Map<string, PackSetFilter>();
    const idsBySet: Partial<Record<PackSetFilter, string[]>> = {};
    const allIds: string[] = [];
    for (const r of rows) {
      const pool = asPool(r.pack_set);
      if (!pool) continue;
      byId.set(r.pack_id, pool);
      (idsBySet[pool] ??= []).push(r.pack_id);
      allIds.push(r.pack_id);
    }
    return { byId, idsBySet, allIds };
  } catch (e) {
    if (isMissingTableError(e)) return EMPTY;
    throw e;
  }
}

/** A single pack's explicit set override (null = none → card-derived). */
export async function getPackSetAssignment(
  packId: string,
): Promise<PackSetFilter | null> {
  try {
    const row = await adminDb.pack_set_assignments.findUnique({
      where: { pack_id: packId },
      select: { pack_set: true },
    });
    return row ? asPool(row.pack_set) : null;
  } catch (e) {
    if (isMissingTableError(e)) return null;
    throw e;
  }
}
