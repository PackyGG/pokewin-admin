import "server-only";

import {
  getKickProfile,
  getKickStreams,
  type KickProfileResult,
  type KickStreamsResult,
} from "./kick";
import {
  getLatestTweets,
  getTwitterProfile,
  scanBrandMentions,
  type MentionScanResult,
  type TweetsResult,
  type TwitterProfileResult,
} from "./twitter";
import { normalizeHandle } from "./cache";

/**
 * Creator-Hub external integrations — public surface.
 *
 * The tabs (`creator/[id]` Kick + Twitter), the "Creator Check" recon tool,
 * and the dashboard "Live now" layer all import from here. Everything is
 * SERVER-ONLY (the modules import `server-only`); call from Server Components /
 * Server Actions, never from a client component.
 *
 * No-spam guarantees live in `cache.ts` and are honored by every function:
 * served-from-DB within a TTL, throttled on `last_fetched_at`, manual-only
 * forced refresh, every call wrapped in a timeout. No loops, no pollers.
 */

export {
  // Kick
  getKickProfile,
  getKickStreams,
  getKickLive,
  refetchKickProfile,
  refetchKickStreams,
} from "./kick";
export type {
  KickProfile,
  KickStream,
  KickLiveInfo,
  KickProfileResult,
  KickStreamsResult,
} from "./kick";

export {
  // Twitter
  getTwitterProfile,
  getLatestTweets,
  scanBrandMentions,
  refetchTwitterProfile,
  refetchLatestTweets,
} from "./twitter";
export type {
  TwitterProfile,
  Tweet,
  TwitterProfileResult,
  TweetsResult,
  MentionScanResult,
} from "./twitter";

export {
  // Shared helpers / config
  normalizeHandle,
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

// ─── Creator Check: one-shot fetch of EVERYTHING for a handle pair ──────────

/**
 * Aggregate result for the "Creator Check" tool and the per-creator tabs when
 * they want both platforms at once. Each side is the platform's own result
 * union (so the caller still sees `no_key_configured` / `null` / data per
 * platform). A platform with no handle provided is `null` (→ "No account
 * linked" empty state).
 */
export type CreatorCheckResult = {
  kick: {
    handle: string | null;
    profile: KickProfileResult | null;
    streams: KickStreamsResult | null;
  };
  twitter: {
    handle: string | null;
    profile: TwitterProfileResult | null;
    tweets: TweetsResult | null;
    mentions: MentionScanResult | null;
  };
};

/**
 * Fetch ALL available data from both APIs for a (kick, twitter) handle pair,
 * persisting into the ADMIN-DB cache and returning the combined typed result.
 * At least one handle should be provided; a missing handle yields `null` for
 * that platform (the UI renders the "No account linked" state).
 *
 * Honors the no-spam contract: each underlying call is TTL/throttle-gated, so
 * re-checking the same handle within the window serves from the DB. Pass
 * `force` to drive a manual Refetch (still anti-mash throttled).
 *
 * All four sub-fetches run in parallel (independent resources), each already
 * wrapped in its own timeout + graceful-degrade, so one platform failing never
 * blocks the other.
 */
export async function runCreatorCheck(
  input: { kick?: string | null; twitter?: string | null },
  opts: { force?: boolean } = {},
): Promise<CreatorCheckResult> {
  const kickHandle = normalizeHandle(input.kick);
  const twitterHandle = normalizeHandle(input.twitter);
  const force = opts.force === true;

  const [kickProfile, kickStreams, twitterProfile, tweets, mentions] =
    await Promise.all([
      kickHandle ? getKickProfile(kickHandle, { force }) : Promise.resolve(null),
      kickHandle ? getKickStreams(kickHandle, { force }) : Promise.resolve(null),
      twitterHandle
        ? getTwitterProfile(twitterHandle, { force })
        : Promise.resolve(null),
      twitterHandle
        ? getLatestTweets(twitterHandle, { force })
        : Promise.resolve(null),
      twitterHandle
        ? scanBrandMentions(twitterHandle, { force })
        : Promise.resolve(null),
    ]);

  return {
    kick: { handle: kickHandle, profile: kickProfile, streams: kickStreams },
    twitter: {
      handle: twitterHandle,
      profile: twitterProfile,
      tweets,
      mentions,
    },
  };
}
