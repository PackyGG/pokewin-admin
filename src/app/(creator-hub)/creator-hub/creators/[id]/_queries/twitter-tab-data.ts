import "server-only";

import { adminDb } from "@/lib/admin-db";
import { logWarn } from "@/lib/errors/logger";
import {
  getLatestTweets,
  getTwitterProfile,
  isNoKeyConfigured,
  scanBrandMentions,
  normalizeHandle,
  BRAND_KEYWORDS,
  type Tweet,
  type TwitterProfile,
} from "@/lib/creator-hub";

/**
 * Data layer for the `creators/[id]` **Twitter** tab.
 *
 * Resolves the creator's linked Twitter handle from the ADMIN DB
 * (`creator_socials`, `platform = "twitter"`) and then pulls the cached X
 * profile + latest tweets + the 7-day brand-mention scan from the server-only
 * integration barrel (`@/lib/creator-hub`).
 *
 * NO-SPAM CONTRACT (honored by the integration): the profile is fetch-once /
 * manual-Refetch and the tweets/mentions are served from the ADMIN-DB cache
 * within a TTL + min-interval throttle. This loader NEVER loops/polls — it
 * makes at most one read per integration function, and `force` (the manual
 * Refetch) is still throttle-gated upstream.
 *
 * SCHEMA SAFETY: the cache tables (`twitter_profiles` / `tweets` /
 * `twitter_mentions`) are part of the substrate wave, but a DB snapshot might
 * be missing them. {@link ensureTwitterTables} runs an idempotent
 * `CREATE TABLE IF NOT EXISTS` guard (ADMIN DB is writable) before the reads,
 * and every integration call is additionally try/caught so a Postgres
 * `42P01` (undefined_table) / Prisma `P2021` degrades to the empty state
 * instead of throwing the tab.
 *
 * DB POLICY: MAIN/prod game DB is NEVER touched here — the handle and all
 * cached social data live in the ADMIN DB. No data is fabricated; a missing
 * handle yields `linked: false` (→ "No account linked"), and an absent API
 * key yields `noKey: true` (→ a Settings hint).
 */

/** Brand keywords surfaced to the UI for the mention-scan caption. */
export const TWITTER_BRAND_KEYWORDS: readonly string[] = BRAND_KEYWORDS;

export type TwitterTabData =
  | {
      /** No Twitter handle linked for this creator → empty state. */
      linked: false;
    }
  | {
      linked: true;
      /** The normalized handle the data was fetched for. */
      handle: string;
      /** True when the Twitter RapidAPI key isn't configured in settings. */
      noKey: boolean;
      /** Cached X profile (null if never fetched / unresolvable). */
      profile: TwitterProfile | null;
      /** Latest tweets (most-recent first), served from the DB cache. */
      tweets: Tweet[];
      /** How many of the last-7d tweets mention us. */
      mentionCount: number;
      /** The 7-day window length (days) used for the mention scan. */
      mentionWindowDays: number;
      /** When the tweets cache was last refreshed (ISO), or null. */
      lastFetchedAt: string | null;
      /** True if any region was served from cache (vs a fresh fetch). */
      fromCache: boolean;
      /**
       * A non-fatal upstream error message (e.g. a scraper miss), if the data
       * shown is stale/partial. Never a secret — just a short reason.
       */
      staleError: string | null;
    };

/**
 * Idempotent `CREATE TABLE IF NOT EXISTS` guard for the Twitter cache tables.
 * Mirrors the live `prisma/admin/schema.prisma` definitions so a DB snapshot
 * that predates the substrate wave still serves the tab. ADMIN DB only; safe to
 * call repeatedly (no-op once the tables exist). A failure here is swallowed —
 * the read paths below independently tolerate a missing table.
 */
let ensuredOnce = false;
async function ensureTwitterTables(): Promise<void> {
  if (ensuredOnce) return;
  try {
    await adminDb.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "twitter_profiles" (
        "id" UUID NOT NULL DEFAULT gen_random_uuid(),
        "username" TEXT NOT NULL,
        "twitter_user_id" TEXT,
        "display_name" TEXT,
        "avatar_url" TEXT,
        "bio" TEXT,
        "follower_count" INTEGER,
        "following_count" INTEGER,
        "tweet_count" INTEGER,
        "is_verified" BOOLEAN,
        "raw_json" JSONB,
        "last_fetched_at" TIMESTAMPTZ(6),
        "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
        CONSTRAINT "twitter_profiles_pkey" PRIMARY KEY ("id")
      );
    `);
    await adminDb.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "twitter_profiles_username_key" ON "twitter_profiles" ("username");`,
    );
    await adminDb.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "tweets" (
        "id" UUID NOT NULL DEFAULT gen_random_uuid(),
        "username" TEXT NOT NULL,
        "tweet_id" TEXT NOT NULL,
        "text" TEXT NOT NULL,
        "like_count" INTEGER,
        "retweet_count" INTEGER,
        "reply_count" INTEGER,
        "view_count" INTEGER,
        "mentions_us" BOOLEAN NOT NULL DEFAULT false,
        "url" TEXT,
        "posted_at" TIMESTAMPTZ(6),
        "raw_json" JSONB,
        "last_fetched_at" TIMESTAMPTZ(6),
        "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
        CONSTRAINT "tweets_pkey" PRIMARY KEY ("id")
      );
    `);
    await adminDb.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "tweets_username_tweet_id_key" ON "tweets" ("username", "tweet_id");`,
    );
    await adminDb.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "twitter_mentions" (
        "id" UUID NOT NULL DEFAULT gen_random_uuid(),
        "username" TEXT NOT NULL,
        "tweet_id" TEXT NOT NULL,
        "text" TEXT NOT NULL,
        "matched_keyword" TEXT,
        "url" TEXT,
        "posted_at" TIMESTAMPTZ(6),
        "last_fetched_at" TIMESTAMPTZ(6),
        "raw_json" JSONB,
        "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
        CONSTRAINT "twitter_mentions_pkey" PRIMARY KEY ("id")
      );
    `);
    await adminDb.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "twitter_mentions_tweet_unique" ON "twitter_mentions" ("tweet_id");`,
    );
    ensuredOnce = true;
  } catch (err) {
    // Non-fatal: the read paths each tolerate a missing table. Don't block the
    // tab on a DDL hiccup (e.g. insufficient privilege on a read-replica).
    logWarn(
      "creator-hub.twitter-tab",
      "ensureTwitterTables guard failed (continuing; reads degrade safely)",
      err,
    );
  }
}

/** Read the creator's linked Twitter handle from the ADMIN DB (or null). */
async function getLinkedTwitterHandle(userId: string): Promise<string | null> {
  const row = (await adminDb.creator_socials
    .findUnique({
      where: {
        target_user_id_platform: {
          target_user_id: userId,
          platform: "twitter",
        },
      },
      select: { username: true },
    })
    .catch((err) => {
      logWarn(
        "creator-hub.twitter-tab",
        "creator_socials read failed",
        err,
      );
      return null;
    })) as { username: string } | null;
  return normalizeHandle(row?.username ?? null);
}

/**
 * Load everything the Twitter tab renders for a creator. Returns
 * `{ linked: false }` when no handle is linked. Each integration call is
 * individually guarded so a single failure (or a missing cache table) never
 * blanks the whole tab.
 *
 * @param userId  the creator's MAIN-DB user id (attribution key).
 * @param force   manual Refetch — still throttle-gated by the integration.
 */
export async function getTwitterTabData(
  userId: string,
  opts: { force?: boolean } = {},
): Promise<TwitterTabData> {
  const handle = await getLinkedTwitterHandle(userId);
  if (!handle) return { linked: false };

  await ensureTwitterTables();
  const force = opts.force === true;

  // Profile + tweets + 7-day mention scan in parallel (independent reads, each
  // already TTL/throttle-gated and timeout-wrapped inside the integration).
  // `scanBrandMentions` internally reuses the tweets cache, so this is at most
  // one id-resolve + one tweets fetch + cheap windowed counts — no API spam.
  const [profileRes, tweetsRes, mentionRes] = await Promise.all([
    getTwitterProfile(handle, { force }).catch((err) => {
      logWarn("creator-hub.twitter-tab", "getTwitterProfile threw", err);
      return null;
    }),
    getLatestTweets(handle, { force }).catch((err) => {
      logWarn("creator-hub.twitter-tab", "getLatestTweets threw", err);
      return null;
    }),
    scanBrandMentions(handle, { force }).catch((err) => {
      logWarn("creator-hub.twitter-tab", "scanBrandMentions threw", err);
      return null;
    }),
  ]);

  // "No key configured" if EITHER read reports it AND we have nothing cached to
  // show. The integration returns the no-key marker only when there's also no
  // cached row; if a profile is cached it returns the data with `fromCache`.
  const noKey =
    (isNoKeyConfigured(profileRes) || profileRes === null) &&
    isNoKeyConfigured(tweetsRes);

  const profile =
    profileRes && !isNoKeyConfigured(profileRes) ? profileRes.profile : null;

  const tweets =
    tweetsRes && !isNoKeyConfigured(tweetsRes) ? tweetsRes.tweets : [];

  const mentionCount =
    mentionRes && !isNoKeyConfigured(mentionRes) ? mentionRes.count : 0;
  const mentionWindowDays =
    mentionRes && !isNoKeyConfigured(mentionRes) ? mentionRes.windowDays : 7;

  const lastFetchedAt =
    (tweetsRes && !isNoKeyConfigured(tweetsRes) ? tweetsRes.lastFetchedAt : null) ??
    (mentionRes && !isNoKeyConfigured(mentionRes) ? mentionRes.lastFetchedAt : null) ??
    profile?.lastFetchedAt ??
    null;

  const fromCache =
    (profileRes && !isNoKeyConfigured(profileRes) ? profileRes.fromCache : true) &&
    (tweetsRes && !isNoKeyConfigured(tweetsRes) ? tweetsRes.fromCache : true);

  const staleError =
    (profileRes && !isNoKeyConfigured(profileRes)
      ? profileRes.staleError
      : undefined) ??
    (tweetsRes && !isNoKeyConfigured(tweetsRes)
      ? tweetsRes.staleError
      : undefined) ??
    null;

  return {
    linked: true,
    handle,
    noKey,
    profile,
    tweets,
    mentionCount,
    mentionWindowDays,
    lastFetchedAt,
    fromCache,
    staleError: staleError ?? null,
  };
}
