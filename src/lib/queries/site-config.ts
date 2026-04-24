import { getDb } from "@/lib/db";

/**
 * Read one or more keys from the generic site_config table in a single
 * query. Returns a Record keyed by the requested keys; values are
 * returned as raw strings (site_config.value is a String column).
 * Missing keys are omitted from the result — callers handle defaults.
 *
 * The site_config table is a small, append-mostly K/V store shared
 * between this admin panel and the game backend, so reads are cheap
 * and don't need to be cached beyond the request.
 */
export async function getSiteConfigValues(
  keys: string[],
): Promise<Record<string, string>> {
  if (keys.length === 0) return {};

  const db = await getDb();
  const rows = await db.site_config.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true },
  });

  const out: Record<string, string> = {};
  for (const row of rows) {
    out[row.key] = row.value;
  }
  return out;
}
