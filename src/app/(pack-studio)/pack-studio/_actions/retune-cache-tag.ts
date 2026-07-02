/**
 * Cache tag string for the Pack Studio Bulk Re-tune Review's heavy proposal
 * compute (`planAllRetunes`'s default-opts arm + `getPortfolioProfile`).
 *
 * The proposal blob caches the result of `searchBestPriceForCleanSnap` run
 * against every in-scope pack — the page's CPU-dominant work. Any write that
 * changes a pack's pool, price, or compliance state must call
 * `revalidateTag(PACK_STUDIO_RETUNE_CACHE_TAG)` so the next render
 * re-computes against fresh truth (otherwise the operator could see a stale
 * dry-run that already shipped).
 *
 * Pure module (no `"use server"`) so both the read surface
 * (`retune-actions.ts`) and the write surface (`packs/actions.ts`) can import
 * the same constant — both files are `"use server"`, which can't export a
 * non-async const directly.
 */
export const PACK_STUDIO_RETUNE_CACHE_TAG = "pack-studio-retune-proposals";

/**
 * Per-pack cache tag for the Retune V2 single-pack plan (`planPackTune`'s
 * cached live arm). A write that changes ONE pack's pool/price revalidates
 * ONLY that pack's plan (`revalidateTag(packRetunePlanTag(id))`) — approving
 * one pack must NOT invalidate the other 182 plans the way the global
 * {@link PACK_STUDIO_RETUNE_CACHE_TAG} busts the whole proposal blob. The
 * global tag stays alongside until the legacy plan-all surface dies.
 */
export const packRetunePlanTag = (packId: string): string =>
  `pack-retune-plan:${packId}`;
