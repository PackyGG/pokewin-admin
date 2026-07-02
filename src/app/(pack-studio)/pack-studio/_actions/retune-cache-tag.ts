/**
 * Per-pack cache tag for the Retune V2 single-pack plan (`planPackTune`'s
 * cached live arm). A write that changes ONE pack's pool/price revalidates
 * ONLY that pack's plan (`revalidateTag(packRetunePlanTag(id))`) — approving
 * one pack must NOT invalidate the other 182 plans (the retired global
 * `pack-studio-retune-proposals` tag busted the whole proposal blob; it died
 * with the plan-all surface in Retune V2 Push 3).
 *
 * Pure module (no `"use server"`) so both the read surface
 * (`doctor/retune-actions.ts`) and the write surface (`packs/actions.ts`) can
 * import the same helper — both files are `"use server"`, which can't export
 * a non-async const directly.
 */
export const packRetunePlanTag = (packId: string): string =>
  `pack-retune-plan:${packId}`;
