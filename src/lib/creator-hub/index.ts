import "server-only";

/**
 * Creator-Hub shared server helpers — public surface.
 *
 * Exposes the per-creator activity-series helpers (used by the creator detail
 * Overview tab) plus the social-handle normalizer used by All Sessions and the
 * admin socials query.
 *
 * NOTE: the Kick + Twitter/X RapidAPI data layer (`./kick`, `./twitter`), the
 * per-creator Kick/Twitter tabs, the "Creator Check" recon tool, and the
 * integration API-key Settings page were removed. Their cache/TTL/throttle +
 * brand-keyword helpers went with them (`cache.ts` deleted); only the handle
 * normalizer survives, in `handles.ts`.
 *
 * Everything is SERVER-ONLY (this module imports `server-only`); call from
 * Server Components / Server Actions, never from a client component.
 */

export {
  getCreatorActivitySeries,
  parseCreatorActivityPeriod,
  CREATOR_ACTIVITY_PERIODS,
  DEFAULT_CREATOR_ACTIVITY_PERIOD,
  CREATOR_ACTIVITY_PERIOD_LABELS,
} from "./creator-activity-series";
export type {
  CreatorActivityPeriod,
  CreatorActivityPoint,
  CreatorActivitySeries,
} from "./creator-activity-series";

export { normalizeHandle, resolveLinkedHandle } from "./handles";
