/**
 * Per-creator Onboarding Checklist — shared, serializable contract.
 *
 * This module holds ONLY plain types + constants (no `server-only`, no React),
 * so it can be imported from both the server query/component side and the
 * `"use client"` panel. Nothing here ever crosses the RSC boundary as a
 * function prop — the client gets plain data + string enums only.
 *
 * Owner spec (plan: "Per-creator Onboarding Checklist"): a checklist with
 * AUTO items derived live from existing data + MANUAL items the manager
 * toggles, that AUTO-HIDES once every item is satisfied. The compact progress
 * badge ("5/8") renders on the roster surface.
 */

/** Stable id for every checklist item (auto + manual). */
export type ChecklistItemId =
  | "two_socials"
  | "first_deal"
  | "leaderboard"
  | "lb_funds_collected"
  | "api_key"
  | "has_pfp"
  | "twitter_giveaway"
  | "streaming_assets";

/**
 * AUTO items are derived from live data each render (never persisted as a
 * checkbox). MANUAL items are manager-controlled and persisted in the ADMIN-DB
 * `creator_onboarding_checklist` row.
 */
export type ChecklistItemKind = "auto" | "manual";

/** One resolved checklist item, ready to render. Fully serializable. */
export type ChecklistItem = {
  id: ChecklistItemId;
  kind: ChecklistItemKind;
  /** Short label shown on the row. */
  label: string;
  /** One-line helper explaining how the item is satisfied. */
  hint: string;
  /** Whether this item currently counts as done. */
  done: boolean;
  /**
   * For an AUTO item that is not yet done, a tiny note nudging the manager to
   * the surface that completes it (e.g. "Set 2 of {Twitter, Kick, Discord}").
   * Empty for done items / where no nudge applies.
   */
  detail?: string;
};

/**
 * The full checklist payload for one creator. `complete` mirrors "every item
 * done"; `completedAt` is the persisted auto-hide snapshot (ISO) so the dock
 * knows it has been finished before. The dock hides the panel when
 * `complete === true`.
 */
export type CreatorChecklistData = {
  targetUserId: string;
  items: ChecklistItem[];
  doneCount: number;
  totalCount: number;
  complete: boolean;
  completedAt: string | null;
  /** Persisted manual fields the client renders as inputs/toggles. */
  manual: ChecklistManualState;
  /**
   * True when a best-effort AUTO source failed to load (e.g. backend deal/LB
   * lookup timed out). The checklist still renders, but auto-hide is
   * suppressed while `partial` so a transient miss can't make a not-yet-done
   * creator's panel vanish.
   */
  partial: boolean;
};

/**
 * The persisted manual portion (the columns on
 * `creator_onboarding_checklist`). Serializable; dates are ISO strings.
 */
export type ChecklistManualState = {
  twitterGiveawayDone: boolean;
  twitterGiveawayUrl: string | null;
  streamingAssetsProvided: boolean;
  lbFundsCollected: boolean;
  lbPrepaidCoin: string | null;
  lbPrepaidTxUrl: string | null;
};

/** Default manual state when no DB row exists yet (everything off/empty). */
export const EMPTY_MANUAL_STATE: ChecklistManualState = {
  twitterGiveawayDone: false,
  twitterGiveawayUrl: null,
  streamingAssetsProvided: false,
  lbFundsCollected: false,
  lbPrepaidCoin: null,
  lbPrepaidTxUrl: null,
};

/**
 * Which manual boolean a toggle action targets. Mirrors the persisted
 * columns; validated at the action boundary so the client can't write an
 * arbitrary field.
 */
export const MANUAL_TOGGLE_FIELDS = [
  "twitter_giveaway",
  "streaming_assets",
  "lb_funds_collected",
] as const;
export type ManualToggleField = (typeof MANUAL_TOGGLE_FIELDS)[number];

/** Minimum distinct linked socials for the "≥ 2 socials set" auto item. */
export const MIN_SOCIALS = 2;
