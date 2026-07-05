import "server-only";

/**
 * Creator-Hub shared server helpers — public surface.
 *
 * Exposes the per-creator activity-series helpers (used by the creator detail
 * Overview tab) plus the shared handle/normalization + cache config utilities
 * used across the Hub.
 *
 * NOTE: the Kick + Twitter/X RapidAPI data layer (`./kick`, `./twitter`), the
 * per-creator Kick/Twitter tabs, the "Creator Check" recon tool, and the
 * integration API-key Settings page were removed. `cache.ts` is kept because
 * `resolveLinkedHandle` (+ friends) are still consumed by All Sessions and the
 * admin socials queries.
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

export {
  // Shared helpers / config
  normalizeHandle,
  resolveLinkedHandle,
  isNoKeyConfigured,
  matchBrandKeywords,
  mentionsBrand,
  getKickApiKey,
  getTwitterApiKey,
  INTEGRATION_SETTINGS_KEYS,
  RAPIDAPI_HOSTS,
  NO_KEY_CONFIGURED,
  BRAND_KEYWORDS,
} from "./cache";
export type { NoKeyConfigured } from "./cache";
