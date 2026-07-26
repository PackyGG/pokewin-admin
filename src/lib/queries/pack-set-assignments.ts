import "server-only";

import { sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import type { PackSetFilter } from "@/lib/queries/packs";
import {
  isPostgresError,
  postgresErrorMessages,
} from "@/lib/postgres-errors";

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
 * The `pack_set_assignments` table is provisioned through reviewed ADMIN SQL.
 * Treat a migration-lagged environment as "no overrides" and degrade to the
 * card-derived classification.
 */
function isMissingTableError(e: unknown): boolean {
  if (isPostgresError(e, "42P01", "42703")) return true;
  const msg = postgresErrorMessages(e).toLowerCase();
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
    const result = await adminDrizzle.execute<{
      pack_id: string;
      pack_set: string;
    }>(sql`
      SELECT pack_id, pack_set
      FROM pack_set_assignments
    `);
    const byId = new Map<string, PackSetFilter>();
    const idsBySet: Partial<Record<PackSetFilter, string[]>> = {};
    const allIds: string[] = [];
    for (const r of result.rows) {
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
    const result = await adminDrizzle.execute<{ pack_set: string }>(sql`
      SELECT pack_set
      FROM pack_set_assignments
      WHERE pack_id = ${packId}
      LIMIT 1
    `);
    const row = result.rows[0];
    return row ? asPool(row.pack_set) : null;
  } catch (e) {
    if (isMissingTableError(e)) return null;
    throw e;
  }
}
