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
