import type pg from "pg";
import { z } from "zod";

import { createPromiseCache } from "./promise-cache.js";

const CREATOR_IDS_CACHE_MS = 30_000;
const creatorIdLoaders = new WeakMap<
  pg.Pool,
  () => Promise<readonly string[]>
>();
const excludedUsersHeaderSchema = z
  .string()
  .min(2)
  .max(100_000)
  .transform((value, context): unknown => {
    try {
      return JSON.parse(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Invalid excluded-users header.",
      });
      return z.NEVER;
    }
  })
  .pipe(z.array(z.string().trim().min(1).max(100)));

export function excludedUserIds(headers: Record<string, unknown>): string[] {
  return excludedUsersHeaderSchema.parse(headers["x-antifraud-excluded-users"]);
}

export async function userIsCreator(
  source: pg.Pool,
  userId: string,
): Promise<boolean> {
  const result = await source.query<{ creator: boolean }>(
    `
      SELECT (
        role::text = 'creator'
        OR 'creator' = ANY(COALESCE(roles::text[], ARRAY[]::text[]))
      ) AS creator
      FROM "user"
      WHERE id = $1
    `,
    [userId],
  );
  return result.rows[0]?.creator ?? false;
}

/**
 * Creator exclusion is shared by the fiat and withdrawal list routes. Query
 * the bounded creator population directly and cache it, rather than scanning
 * every historical assessment and shipping that ever-growing id set to MAIN
 * on each request.
 */
export function cachedCreatorUserIds(
  source: pg.Pool,
): Promise<readonly string[]> {
  let load = creatorIdLoaders.get(source);
  if (!load) {
    const cached = createPromiseCache<"all", readonly string[]>(
      async () => {
        const creators = await source.query<{ id: string }>(
          `
            SELECT id
            FROM "user"
            WHERE role::text = 'creator'
               OR 'creator' = ANY(COALESCE(roles::text[], ARRAY[]::text[]))
          `,
        );
        return creators.rows.map((row) => row.id);
      },
      CREATOR_IDS_CACHE_MS,
    );
    load = () => cached("all");
    creatorIdLoaders.set(source, load);
  }
  return load();
}
