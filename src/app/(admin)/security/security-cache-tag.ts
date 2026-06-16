/**
 * Shared cache-invalidation tag for every cached /security config read
 * (see `_cached-reads.ts`). The security server actions call
 * `revalidateTag(SECURITY_CACHE_TAG)` right next to their existing
 * `revalidatePath("/security")` so an admin edit busts the cached value
 * immediately instead of waiting out the revalidate window.
 */
export const SECURITY_CACHE_TAG = "security-config";
