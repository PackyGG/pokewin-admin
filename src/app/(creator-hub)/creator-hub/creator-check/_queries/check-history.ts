import "server-only";

import { unstable_cache } from "next/cache";

import { adminDb } from "@/lib/admin-db";
import { logWarn } from "@/lib/errors/logger";
import {
  getKickStreams,
  getLatestTweets,
  scanBrandMentions,
  type KickStream,
  type Tweet,
} from "@/lib/creator-hub";

/**
 * Creator Check — read layer.
 *
 * The "Creator Check" recon tool works for ANY handle (not just signed-up
 * creators). It SHARES the same fetch+store services + ADMIN-DB substrate
 * tables as the per-creator Kick/Twitter tabs:
 *   • Kick profiles    → `kick_profiles`     (one row per lowercased handle)
 *   • Kick streams     → `kick_streams`      (latest VODs per handle)
 *   • Twitter profiles → `twitter_profiles`  (one row per lowercased handle)
 *   • Tweets           → `tweets`            (latest tweets per handle, with a
 *                                             precomputed `mentions_us` flag)
 *
 * There is NO separate "check history" table — the history shown on the page
 * IS the set of substrate rows we've ever fetched (each profile we pulled is a
 * box). This keeps the tool a thin read over the same data the tabs use (no
 * schema change) and means a profile fetched by a creator tab also appears in
 * the Creator Check history, and vice-versa.
 *
 * No-spam contract: this module NEVER calls the external APIs. The history +
 * the detail view are pure reads of the ADMIN DB. Forced/throttled refreshes
 * only ever happen through the Creator Check server action (`runCheck`), which
 * routes through the barrel's TTL/throttle gate.
 *
 * Resilience: every read is wrapped so a missing substrate table (P2021 /
 * 42P01 — e.g. the table hasn't been applied to this environment's ADMIN DB)
 * degrades to an empty result + a `substrateUnavailable` flag instead of
 * crashing the page.
 */

// ─── Missing-table guard (P2021 / 42P01 / "does not exist") ─────────────────

/**
 * True if the error is Postgres/Prisma's "relation does not exist" for one of
 * our substrate tables. Lets the page render a clean empty state when the
 * Creator-Hub substrate hasn't been applied to this ADMIN DB yet, rather than
 * white-screening.
 */
function isMissingTableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.includes("P2021") ||
    msg.includes("42P01") ||
    msg.includes("UndefinedTable") ||
    (msg.includes("does not exist") &&
      (msg.includes("kick_profiles") ||
        msg.includes("kick_streams") ||
        msg.includes("twitter_profiles") ||
        msg.includes("tweets")))
  );
}

/**
 * Run a substrate read; on a missing-table error return the supplied fallback
 * and mark it. Any OTHER error is logged and also degrades to the fallback (a
 * read for a recon-history list should never take the page down).
 */
async function safeRead<T>(
  fn: () => Promise<T>,
  fallback: T,
  ctx: string,
): Promise<{ value: T; missing: boolean }> {
  try {
    return { value: await fn(), missing: false };
  } catch (err) {
    if (isMissingTableError(err)) {
      return { value: fallback, missing: true };
    }
    logWarn("creator-hub.creator-check", `${ctx} read failed`, err);
    return { value: fallback, missing: false };
  }
}

// ─── Public shapes ──────────────────────────────────────────────────────────

/** A Kick profile box on the history grid (summary only — details on open). */
export type KickCheckSummary = {
  platform: "kick";
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  followerCount: number | null;
  isVerified: boolean | null;
  isLive: boolean;
  /** Count of cached VODs for this handle (drives the "N streams" badge). */
  streamCount: number;
  /** ISO of when we last refreshed this profile (null = never). */
  lastFetchedAt: string | null;
  /** Profile URL on the platform. */
  profileUrl: string;
};

/** A Twitter profile box on the history grid. */
export type TwitterCheckSummary = {
  platform: "twitter";
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  followerCount: number | null;
  followingCount: number | null;
  tweetCount: number | null;
  isVerified: boolean | null;
  /** Count of cached tweets we hold for this handle. */
  cachedTweetCount: number;
  /** How many of the cached tweets mention us in the last 7 days. */
  mentionCount7d: number;
  lastFetchedAt: string | null;
  profileUrl: string;
};

export type CheckSummary = KickCheckSummary | TwitterCheckSummary;

export type CheckHistory = {
  kick: KickCheckSummary[];
  twitter: TwitterCheckSummary[];
  /** Distinct handles checked across both platforms. */
  totalProfiles: number;
  /** True if a substrate table was missing on this ADMIN DB. */
  substrateUnavailable: boolean;
};

// ─── Row shapes (only the columns we read) ──────────────────────────────────

type KickProfileRow = {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  follower_count: number | null;
  is_verified: boolean | null;
  is_live: boolean;
  last_fetched_at: Date | null;
};

type TwitterProfileRow = {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  follower_count: number | null;
  following_count: number | null;
  tweet_count: number | null;
  is_verified: boolean | null;
  last_fetched_at: Date | null;
};

// ─── History (substrate read, cached) ───────────────────────────────────────

const MENTION_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * Build the Creator Check history: every profile we've ever fetched, newest
 * first, as summary boxes. Pure ADMIN-DB read (no external API). Cached 60s
 * keyed on the route so repeated views / multiple managers don't re-query the
 * DB on every paint; the cache is busted by `revalidatePath` in the action.
 */
export const getCheckHistory = unstable_cache(
  async (): Promise<CheckHistory> => {
    let substrateUnavailable = false;
    const since = new Date(Date.now() - MENTION_WINDOW_MS);

    // Kick profiles we've fetched (last_fetched_at set = actually pulled).
    const kickRes = await safeRead(
      () =>
        adminDb.kick_profiles.findMany({
          where: { last_fetched_at: { not: null } },
          orderBy: { last_fetched_at: "desc" },
          take: 200,
          select: {
            username: true,
            display_name: true,
            avatar_url: true,
            bio: true,
            follower_count: true,
            is_verified: true,
            is_live: true,
            last_fetched_at: true,
          },
        }) as Promise<KickProfileRow[]>,
      [] as KickProfileRow[],
      "kick_profiles",
    );
    substrateUnavailable = substrateUnavailable || kickRes.missing;

    const twitterRes = await safeRead(
      () =>
        adminDb.twitter_profiles.findMany({
          where: { last_fetched_at: { not: null } },
          orderBy: { last_fetched_at: "desc" },
          take: 200,
          select: {
            username: true,
            display_name: true,
            avatar_url: true,
            bio: true,
            follower_count: true,
            following_count: true,
            tweet_count: true,
            is_verified: true,
            last_fetched_at: true,
          },
        }) as Promise<TwitterProfileRow[]>,
      [] as TwitterProfileRow[],
      "twitter_profiles",
    );
    substrateUnavailable = substrateUnavailable || twitterRes.missing;

    // Per-handle cached-stream / cached-tweet counts (grouped, cheap). Done in
    // one grouped query each rather than N per box.
    const kickHandles = kickRes.value.map((r) => r.username);
    const twitterHandles = twitterRes.value.map((r) => r.username);

    const streamCounts = new Map<string, number>();
    if (kickHandles.length > 0) {
      try {
        const grp = await adminDb.kick_streams.groupBy({
          by: ["username"],
          where: { username: { in: kickHandles } },
          _count: { _all: true },
        });
        for (const g of grp) streamCounts.set(g.username, g._count._all);
      } catch (err) {
        if (isMissingTableError(err)) substrateUnavailable = true;
        else logWarn("creator-hub.creator-check", "kick_streams.groupBy", err);
      }
    }

    const tweetCounts = new Map<string, number>();
    const mentionCounts = new Map<string, number>();
    if (twitterHandles.length > 0) {
      try {
        const grpAll = await adminDb.tweets.groupBy({
          by: ["username"],
          where: { username: { in: twitterHandles } },
          _count: { _all: true },
        });
        for (const g of grpAll) tweetCounts.set(g.username, g._count._all);
      } catch (err) {
        if (isMissingTableError(err)) substrateUnavailable = true;
        else logWarn("creator-hub.creator-check", "tweets.groupBy", err);
      }

      try {
        const grpMentions = await adminDb.tweets.groupBy({
          by: ["username"],
          where: {
            username: { in: twitterHandles },
            mentions_us: true,
            posted_at: { gte: since },
          },
          _count: { _all: true },
        });
        for (const g of grpMentions)
          mentionCounts.set(g.username, g._count._all);
      } catch (err) {
        if (isMissingTableError(err)) substrateUnavailable = true;
        else
          logWarn("creator-hub.creator-check", "tweets.groupBy(mentions)", err);
      }
    }

    const kick: KickCheckSummary[] = kickRes.value.map((r) => ({
      platform: "kick",
      handle: r.username,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      bio: r.bio,
      followerCount: r.follower_count,
      isVerified: r.is_verified,
      isLive: r.is_live,
      streamCount: streamCounts.get(r.username) ?? 0,
      lastFetchedAt: r.last_fetched_at?.toISOString() ?? null,
      profileUrl: `https://kick.com/${r.username}`,
    }));

    const twitter: TwitterCheckSummary[] = twitterRes.value.map((r) => ({
      platform: "twitter",
      handle: r.username,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      bio: r.bio,
      followerCount: r.follower_count,
      followingCount: r.following_count,
      tweetCount: r.tweet_count,
      isVerified: r.is_verified,
      cachedTweetCount: tweetCounts.get(r.username) ?? 0,
      mentionCount7d: mentionCounts.get(r.username) ?? 0,
      lastFetchedAt: r.last_fetched_at?.toISOString() ?? null,
      profileUrl: `https://x.com/${r.username}`,
    }));

    const distinct = new Set<string>([
      ...kick.map((k) => `kick:${k.handle}`),
      ...twitter.map((t) => `twitter:${t.handle}`),
    ]);

    return {
      kick,
      twitter,
      totalProfiles: distinct.size,
      substrateUnavailable,
    };
  },
  ["creator-check-history-v1"],
  { revalidate: 60, tags: ["creator-check-history"] },
);

// ─── Per-handle detail (DB-served, for the detail modal) ────────────────────

export type KickCheckDetail = {
  summary: KickCheckSummary;
  streams: KickStream[];
};

export type TwitterCheckDetail = {
  summary: TwitterCheckSummary;
  tweets: Tweet[];
  mentions: Tweet[];
};

/**
 * Read the full cached Kick detail for one handle from the ADMIN DB — profile
 * summary + latest cached streams. NO external API hit (uses the barrel's
 * cache path, which serves from the DB within its TTL). Returns null if the
 * handle isn't in our cache.
 */
export async function getKickCheckDetail(
  handle: string,
): Promise<KickCheckDetail | null> {
  const row = (await adminDb.kick_profiles
    .findUnique({
      where: { username: handle },
      select: {
        username: true,
        display_name: true,
        avatar_url: true,
        bio: true,
        follower_count: true,
        is_verified: true,
        is_live: true,
        last_fetched_at: true,
      },
    })
    .catch((err) => {
      logWarn("creator-hub.creator-check", "kick detail read failed", err);
      return null;
    })) as KickProfileRow | null;
  if (!row) return null;

  // Served from DB within TTL (no forced fetch here — detail view never spams).
  const streamsRes = await getKickStreams(handle, { limit: 20 }).catch(() => null);
  const streams =
    streamsRes && streamsRes.ok ? streamsRes.streams : ([] as KickStream[]);

  const streamCount = streams.length;
  return {
    summary: {
      platform: "kick",
      handle: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      bio: row.bio,
      followerCount: row.follower_count,
      isVerified: row.is_verified,
      isLive: row.is_live,
      streamCount,
      lastFetchedAt: row.last_fetched_at?.toISOString() ?? null,
      profileUrl: `https://kick.com/${row.username}`,
    },
    streams,
  };
}

/**
 * Read the full cached Twitter detail for one handle — profile summary +
 * latest cached tweets + the 7-day brand-mention list. DB-served (no forced
 * external fetch). Returns null if the handle isn't cached.
 */
export async function getTwitterCheckDetail(
  handle: string,
): Promise<TwitterCheckDetail | null> {
  const row = (await adminDb.twitter_profiles
    .findUnique({
      where: { username: handle },
      select: {
        username: true,
        display_name: true,
        avatar_url: true,
        bio: true,
        follower_count: true,
        following_count: true,
        tweet_count: true,
        is_verified: true,
        last_fetched_at: true,
      },
    })
    .catch((err) => {
      logWarn("creator-hub.creator-check", "twitter detail read failed", err);
      return null;
    })) as TwitterProfileRow | null;
  if (!row) return null;

  const tweetsRes = await getLatestTweets(handle, { limit: 20 }).catch(() => null);
  const tweets = tweetsRes && tweetsRes.ok ? tweetsRes.tweets : ([] as Tweet[]);

  const mentionRes = await scanBrandMentions(handle).catch(() => null);
  const mentions =
    mentionRes && mentionRes.ok ? mentionRes.mentions : ([] as Tweet[]);

  return {
    summary: {
      platform: "twitter",
      handle: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      bio: row.bio,
      followerCount: row.follower_count,
      followingCount: row.following_count,
      tweetCount: row.tweet_count,
      isVerified: row.is_verified,
      cachedTweetCount: tweets.length,
      mentionCount7d: mentions.length,
      lastFetchedAt: row.last_fetched_at?.toISOString() ?? null,
      profileUrl: `https://x.com/${row.username}`,
    },
    tweets,
    mentions,
  };
}
