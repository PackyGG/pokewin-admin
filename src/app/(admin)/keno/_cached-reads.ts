import "server-only";

import { unstable_cache } from "next/cache";

import { getKenoConfig } from "@/lib/backend-api/keno-config";
import { readDbEnv } from "@/lib/db-env";

export const KENO_CONFIG_CACHE_TAG = "keno-config";

const cachedKenoConfig = unstable_cache(
  () => getKenoConfig(),
  ["keno-config-v2"],
  { revalidate: 300, tags: [KENO_CONFIG_CACHE_TAG] },
);

/**
 * Production reads are cached because this value changes only through the
 * admin action below. A dev-toggled admin always reads the selected backend
 * directly because the environment cookie is request-scoped.
 */
export async function getCachedKenoConfig(): ReturnType<typeof getKenoConfig> {
  const env = await readDbEnv();
  return env === "prod" ? cachedKenoConfig() : getKenoConfig();
}
