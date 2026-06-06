import "server-only";

import { adminDb } from "@/lib/admin-db";
import { logError, logWarn } from "@/lib/errors/logger";
import { withTimeout } from "@/lib/errors/safe-query";
import {
  CACHE_TTL_MS,
  getTwitterApiKey,
  matchBrandKeywords,
  MENTION_SCAN_WINDOW_MS,
  NO_KEY_CONFIGURED,
  type NoKeyConfigured,
  normalizeHandle,
  RAPIDAPI_HOSTS,
  shouldFetch,
} from "./cache";

/**
 * Twitter/X integration service (RapidAPI `twitter241`).
 *
 * Reads the cached X profile + latest tweets from the ADMIN DB and refreshes
 * them through RapidAPI under the STRICT no-spam contract in `cache.ts`:
 *   • profile = fetch-once, refresh only on manual Refetch (`force`);
 *   • tweets  = served from DB within a TTL, throttled on `last_fetched_at`.
 * Every outbound call is wrapped in {@link withTimeout}. The RapidAPI key is
 * read SERVER-ONLY from `admin_settings`; absent → {@link NO_KEY_CONFIGURED}.
 *
 * Endpoints (RECON blueprint, host `twitter241.p.rapidapi.com`):
 *   • profile   GET /user?username=<handle>     → result...user.result.rest_id + legacy{...}
 *   • tweets    GET /user-tweets?user=<rest_id> ⚠ user = NUMERIC rest_id, NOT the handle
 *   • followings GET /followings?user=<rest_id>
 *
 * The handle→rest_id resolution is cached on `twitter_profiles.twitter_user_id`
 * so the tweets path doesn't re-resolve every time.
 */

const TWITTER_TIMEOUT_MS = 12_000;

// ─── Public typed shapes ────────────────────────────────────────────────────

export type TwitterProfile = {
  username: string;
  /** Numeric rest_id (as text) — needed for the tweets/followings endpoints. */
  twitterUserId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  followerCount: number | null;
  followingCount: number | null;
  tweetCount: number | null;
  isVerified: boolean | null;
  lastFetchedAt: string | null;
};

export type Tweet = {
  tweetId: string;
  text: string;
  likeCount: number | null;
  retweetCount: number | null;
  replyCount: number | null;
  viewCount: number | null;
  /** True if `text` matches one of OUR brand keywords. */
  mentionsUs: boolean;
  url: string | null;
  postedAt: string | null;
};

export type TwitterProfileResult =
  | NoKeyConfigured
  | {
      ok: true;
      profile: TwitterProfile | null;
      fromCache: boolean;
      staleError?: string;
    };

export type TweetsResult =
  | NoKeyConfigured
  | {
      ok: true;
      tweets: Tweet[];
      lastFetchedAt: string | null;
      fromCache: boolean;
      staleError?: string;
    };

/** Result of the 7-day brand-mention scan. */
export type MentionScanResult =
  | NoKeyConfigured
  | {
      ok: true;
      /** How many of the user's tweets in the last 7d mention us. */
      count: number;
      /** The matching tweets (most-recent first). */
      mentions: Tweet[];
      windowDays: number;
      lastFetchedAt: string | null;
      fromCache: boolean;
      staleError?: string;
    };

// ─── Coercion helpers ───────────────────────────────────────────────────────

function toStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function toInt(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toIso(v: unknown): string | null {
  const s = toStr(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ─── Low-level fetch helper ─────────────────────────────────────────────────

async function twitterGet<T>(
  path: string,
  apiKey: string,
): Promise<T | null> {
  const url = `https://${RAPIDAPI_HOSTS.TWITTER}${path}`;
  const res = await withTimeout(
    () =>
      fetch(url, {
        method: "GET",
        headers: {
          "x-rapidapi-key": apiKey,
          "x-rapidapi-host": RAPIDAPI_HOSTS.TWITTER,
        },
        cache: "no-store",
      }),
    TWITTER_TIMEOUT_MS,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Twitter API ${res.status} ${res.statusText} for ${path}`);
  }
  return (await res.json()) as T;
}

// ─── Profile payload parsing (twitter241 /user) ─────────────────────────────
//
// twitter241 nests the user under a few possible shapes depending on the
// account; we probe the documented path first then fall back. We never throw
// on a shape miss — we return null and log, so the tab shows a clean state.

type TwitterLegacy = {
  screen_name?: string | null;
  name?: string | null;
  followers_count?: number | null;
  friends_count?: number | null;
  statuses_count?: number | null;
  description?: string | null;
  location?: string | null;
  verified?: boolean | null;
  profile_image_url_https?: string | null;
};

type TwitterUserResult = {
  rest_id?: string | number | null;
  is_blue_verified?: boolean | null;
  legacy?: TwitterLegacy | null;
  // Newer payloads put some fields under `core` / `avatar`.
  core?: { name?: string | null; screen_name?: string | null } | null;
  avatar?: { image_url?: string | null } | null;
};

type TwitterUserEnvelope = {
  result?: {
    data?: { user?: { result?: TwitterUserResult | null } | null } | null;
    // Alternative flatter shapes.
    user?: { result?: TwitterUserResult | null } | null;
  } | null;
  data?: { user?: { result?: TwitterUserResult | null } | null } | null;
};

function extractUserResult(
  env: TwitterUserEnvelope | null,
): TwitterUserResult | null {
  if (!env) return null;
  return (
    env.result?.data?.user?.result ??
    env.result?.user?.result ??
    env.data?.user?.result ??
    null
  );
}

function userResultToProfileFields(
  handle: string,
  u: TwitterUserResult,
): {
  twitter_user_id: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  follower_count: number | null;
  following_count: number | null;
  tweet_count: number | null;
  is_verified: boolean | null;
} {
  const legacy = u.legacy ?? {};
  return {
    twitter_user_id: toStr(u.rest_id),
    display_name: toStr(legacy.name ?? u.core?.name) ?? handle,
    avatar_url: toStr(legacy.profile_image_url_https ?? u.avatar?.image_url),
    bio: toStr(legacy.description),
    follower_count: toInt(legacy.followers_count),
    following_count: toInt(legacy.friends_count),
    tweet_count: toInt(legacy.statuses_count),
    is_verified: legacy.verified ?? u.is_blue_verified ?? null,
  };
}

// ─── Tweets payload parsing (twitter241 /user-tweets) ───────────────────────
//
// The tweets endpoint returns a GraphQL-style timeline:
//   result.timeline.instructions[] → entries[] → content.itemContent.tweet_results.result
// We walk it defensively and pull a flat list of tweet objects.

type TweetLegacy = {
  full_text?: string | null;
  text?: string | null;
  created_at?: string | null;
  favorite_count?: number | null;
  retweet_count?: number | null;
  reply_count?: number | null;
};

type TweetResult = {
  rest_id?: string | number | null;
  legacy?: TweetLegacy | null;
  views?: { count?: string | number | null } | null;
  // note_tweet carries long-form text beyond 280 chars
  note_tweet?: {
    note_tweet_results?: { result?: { text?: string | null } | null } | null;
  } | null;
  core?: {
    user_results?: { result?: { legacy?: { screen_name?: string | null } | null } | null } | null;
  } | null;
};

function deepFindTweetResults(node: unknown, out: TweetResult[], depth = 0): void {
  if (depth > 8 || node == null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  // A tweet_results node has a `result` with a legacy/full_text or __typename Tweet.
  const tr = obj.tweet_results as { result?: unknown } | undefined;
  if (tr && tr.result && typeof tr.result === "object") {
    const r = tr.result as Record<string, unknown>;
    const inner =
      (r.__typename === "TweetWithVisibilityResults" && r.tweet) || r;
    if (inner && typeof inner === "object") {
      out.push(inner as TweetResult);
    }
  }
  for (const key of Object.keys(obj)) {
    deepFindTweetResults(obj[key], out, depth + 1);
  }
}

function tweetResultToRow(
  username: string,
  t: TweetResult,
): {
  tweet_id: string;
  text: string;
  like_count: number | null;
  retweet_count: number | null;
  reply_count: number | null;
  view_count: number | null;
  url: string | null;
  posted_at: Date | null;
} | null {
  const tweetId = toStr(t.rest_id);
  if (!tweetId) return null;
  const legacy = t.legacy ?? {};
  const noteText = t.note_tweet?.note_tweet_results?.result?.text;
  const text = toStr(noteText ?? legacy.full_text ?? legacy.text) ?? "";
  const postedIso = toIso(legacy.created_at);
  const screenName =
    toStr(t.core?.user_results?.result?.legacy?.screen_name) ?? username;
  return {
    tweet_id: tweetId,
    text,
    like_count: toInt(legacy.favorite_count),
    retweet_count: toInt(legacy.retweet_count),
    reply_count: toInt(legacy.reply_count),
    view_count: toInt(t.views?.count),
    url: `https://x.com/${screenName}/status/${tweetId}`,
    posted_at: postedIso ? new Date(postedIso) : null,
  };
}

// ─── DB row → public shape ──────────────────────────────────────────────────

type TwitterProfileRow = {
  username: string;
  twitter_user_id: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  follower_count: number | null;
  following_count: number | null;
  tweet_count: number | null;
  is_verified: boolean | null;
  last_fetched_at: Date | null;
};

function rowToProfile(row: TwitterProfileRow): TwitterProfile {
  return {
    username: row.username,
    twitterUserId: row.twitter_user_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    followerCount: row.follower_count,
    followingCount: row.following_count,
    tweetCount: row.tweet_count,
    isVerified: row.is_verified,
    lastFetchedAt: row.last_fetched_at?.toISOString() ?? null,
  };
}

type TweetRow = {
  tweet_id: string;
  text: string;
  like_count: number | null;
  retweet_count: number | null;
  reply_count: number | null;
  view_count: number | null;
  mentions_us: boolean;
  url: string | null;
  posted_at: Date | null;
};

function rowToTweet(row: TweetRow): Tweet {
  return {
    tweetId: row.tweet_id,
    text: row.text,
    likeCount: row.like_count,
    retweetCount: row.retweet_count,
    replyCount: row.reply_count,
    viewCount: row.view_count,
    mentionsUs: row.mentions_us,
    url: row.url,
    postedAt: row.posted_at?.toISOString() ?? null,
  };
}

// ─── Profile: fetch-once, refresh on manual Refetch ─────────────────────────

/**
 * Get an X profile for a handle, served from the ADMIN-DB cache. Same
 * no-spam semantics as the Kick profile (TTL + manual force + anti-mash).
 * Also caches the resolved `rest_id` so the tweets path can reuse it.
 */
export async function getTwitterProfile(
  rawHandle: string,
  opts: { force?: boolean } = {},
): Promise<TwitterProfileResult> {
  const handle = normalizeHandle(rawHandle);
  if (!handle) return { ok: true, profile: null, fromCache: true };

  const apiKey = await getTwitterApiKey();

  const cached = (await adminDb.twitter_profiles
    .findUnique({ where: { username: handle } })
    .catch((err) => {
      logWarn("creator-hub.twitter", "twitter_profiles read failed", err);
      return null;
    })) as TwitterProfileRow | null;

  if (!apiKey) {
    if (cached) {
      return { ok: true, profile: rowToProfile(cached), fromCache: true };
    }
    return NO_KEY_CONFIGURED;
  }

  const force = opts.force === true;
  if (
    !shouldFetch(cached?.last_fetched_at ?? null, CACHE_TTL_MS.PROFILE, force)
  ) {
    return {
      ok: true,
      profile: cached ? rowToProfile(cached) : null,
      fromCache: true,
    };
  }

  try {
    const env = await twitterGet<TwitterUserEnvelope>(
      `/user?username=${encodeURIComponent(handle)}`,
      apiKey,
    );
    const user = extractUserResult(env);
    if (!user) {
      if (cached) {
        return { ok: true, profile: rowToProfile(cached), fromCache: true };
      }
      return { ok: true, profile: null, fromCache: false };
    }

    const fields = userResultToProfileFields(handle, user);
    const data = {
      username: handle,
      ...fields,
      raw_json: env as unknown as object,
      last_fetched_at: new Date(),
    };
    const saved = (await adminDb.twitter_profiles.upsert({
      where: { username: handle },
      update: data,
      create: data,
    })) as unknown as TwitterProfileRow;
    return { ok: true, profile: rowToProfile(saved), fromCache: false };
  } catch (err) {
    logError("creator-hub.twitter", `getTwitterProfile failed for ${handle}`, err);
    if (cached) {
      return {
        ok: true,
        profile: rowToProfile(cached),
        fromCache: true,
        staleError: err instanceof Error ? err.message : "Twitter fetch failed",
      };
    }
    return {
      ok: true,
      profile: null,
      fromCache: false,
      staleError: err instanceof Error ? err.message : "Twitter fetch failed",
    };
  }
}

// ─── rest_id resolution (cached) ────────────────────────────────────────────

/**
 * Resolve a handle to its numeric rest_id, preferring the cached value on
 * `twitter_profiles`. Falls back to a single profile fetch (which also caches
 * the id). Returns null if unresolvable. Used by the tweets path so it never
 * re-resolves on every view. SERVER-ONLY.
 */
async function resolveRestId(
  handle: string,
  apiKey: string,
  force: boolean,
): Promise<string | null> {
  if (!force) {
    const cached = (await adminDb.twitter_profiles
      .findUnique({
        where: { username: handle },
        select: { twitter_user_id: true },
      })
      .catch(() => null)) as { twitter_user_id: string | null } | null;
    if (cached?.twitter_user_id) return cached.twitter_user_id;
  }
  // No cached id — resolve via the profile endpoint (also caches it).
  try {
    const env = await twitterGet<TwitterUserEnvelope>(
      `/user?username=${encodeURIComponent(handle)}`,
      apiKey,
    );
    const user = extractUserResult(env);
    const restId = toStr(user?.rest_id);
    if (user && restId) {
      const fields = userResultToProfileFields(handle, user);
      const data = {
        username: handle,
        ...fields,
        raw_json: env as unknown as object,
        last_fetched_at: new Date(),
      };
      await adminDb.twitter_profiles
        .upsert({ where: { username: handle }, update: data, create: data })
        .catch((err) =>
          logWarn("creator-hub.twitter", "rest_id upsert failed", err),
        );
    }
    return restId;
  } catch (err) {
    logError("creator-hub.twitter", `resolveRestId failed for ${handle}`, err);
    return null;
  }
}

// ─── Latest tweets: served from DB within TTL, throttled ────────────────────

/**
 * Get the latest tweets for a handle, served from the ADMIN-DB cache and
 * refreshed under the tweets TTL/throttle. Resolves the handle→rest_id first
 * (cached), then `/user-tweets?user=<rest_id>`. Stores each tweet with a
 * precomputed `mentions_us` flag so the 7-day mention count is a cheap WHERE.
 *
 * One read + at most (one id-resolve + one tweets fetch). No loops/polling.
 */
export async function getLatestTweets(
  rawHandle: string,
  opts: { force?: boolean; limit?: number } = {},
): Promise<TweetsResult> {
  const handle = normalizeHandle(rawHandle);
  if (!handle) {
    return { ok: true, tweets: [], lastFetchedAt: null, fromCache: true };
  }
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 20);
  const apiKey = await getTwitterApiKey();

  const newest = (await adminDb.tweets
    .findFirst({
      where: { username: handle },
      orderBy: { last_fetched_at: "desc" },
      select: { last_fetched_at: true },
    })
    .catch((err) => {
      logWarn("creator-hub.twitter", "tweets freshness read failed", err);
      return null;
    })) as { last_fetched_at: Date | null } | null;

  const readCache = async (): Promise<Tweet[]> => {
    const rows = (await adminDb.tweets
      .findMany({
        where: { username: handle },
        orderBy: { posted_at: "desc" },
        take: limit,
      })
      .catch((err) => {
        logWarn("creator-hub.twitter", "tweets read failed", err);
        return [];
      })) as unknown as TweetRow[];
    return rows.map(rowToTweet);
  };

  if (!apiKey) {
    const tweets = await readCache();
    if (tweets.length > 0 || newest) {
      return {
        ok: true,
        tweets,
        lastFetchedAt: newest?.last_fetched_at?.toISOString() ?? null,
        fromCache: true,
      };
    }
    return NO_KEY_CONFIGURED;
  }

  const force = opts.force === true;
  if (!shouldFetch(newest?.last_fetched_at ?? null, CACHE_TTL_MS.TWEETS, force)) {
    return {
      ok: true,
      tweets: await readCache(),
      lastFetchedAt: newest?.last_fetched_at?.toISOString() ?? null,
      fromCache: true,
    };
  }

  try {
    const restId = await resolveRestId(handle, apiKey, force);
    if (!restId) {
      const tweets = await readCache();
      return {
        ok: true,
        tweets,
        lastFetchedAt: newest?.last_fetched_at?.toISOString() ?? null,
        fromCache: true,
        staleError: "Could not resolve Twitter user id",
      };
    }

    const env = await twitterGet<unknown>(
      `/user-tweets?user=${encodeURIComponent(restId)}&count=${limit}`,
      apiKey,
    );
    const found: TweetResult[] = [];
    deepFindTweetResults(env, found);

    const now = new Date();
    let upserts = 0;
    for (const t of found) {
      const row = tweetResultToRow(handle, t);
      if (!row) continue;
      const mentions_us = matchBrandKeywords(row.text).length > 0;
      const payload = {
        username: handle,
        ...row,
        mentions_us,
        raw_json: t as unknown as object,
        last_fetched_at: now,
      };
      await adminDb.tweets.upsert({
        where: {
          username_tweet_id: { username: handle, tweet_id: row.tweet_id },
        },
        update: payload,
        create: payload,
      });
      // Also feed the cross-handle brand-mention ledger when relevant.
      if (mentions_us) {
        const matched = matchBrandKeywords(row.text)[0] ?? null;
        await adminDb.twitter_mentions
          .upsert({
            where: { tweet_id: row.tweet_id },
            update: {
              username: handle,
              text: row.text,
              matched_keyword: matched,
              url: row.url,
              posted_at: row.posted_at,
              last_fetched_at: now,
              raw_json: t as unknown as object,
            },
            create: {
              username: handle,
              tweet_id: row.tweet_id,
              text: row.text,
              matched_keyword: matched,
              url: row.url,
              posted_at: row.posted_at,
              last_fetched_at: now,
              raw_json: t as unknown as object,
            },
          })
          .catch((err) =>
            logWarn("creator-hub.twitter", "twitter_mentions upsert failed", err),
          );
      }
      upserts++;
    }

    if (upserts === 0) {
      logWarn("creator-hub.twitter", `getLatestTweets parsed 0 tweets for ${handle}`);
    }

    return {
      ok: true,
      tweets: await readCache(),
      lastFetchedAt: now.toISOString(),
      fromCache: false,
    };
  } catch (err) {
    logError("creator-hub.twitter", `getLatestTweets failed for ${handle}`, err);
    return {
      ok: true,
      tweets: await readCache(),
      lastFetchedAt: newest?.last_fetched_at?.toISOString() ?? null,
      fromCache: true,
      staleError: err instanceof Error ? err.message : "Twitter fetch failed",
    };
  }
}

// ─── 7-day brand-mention scan ───────────────────────────────────────────────

/**
 * Scan a handle's recent tweets for OUR brand keywords over the last 7 days
 * and return the count + matching tweets. This REUSES {@link getLatestTweets}
 * (so it shares the cache/throttle and never adds its own API spam) and then
 * counts from the DB via the precomputed `mentions_us` flag, windowed to 7d.
 *
 * `force` triggers a fresh tweets pull (subject to the same throttle) before
 * counting — used by the manual Refetch on the Twitter tab. Without a key →
 * {@link NO_KEY_CONFIGURED}.
 */
export async function scanBrandMentions(
  rawHandle: string,
  opts: { force?: boolean } = {},
): Promise<MentionScanResult> {
  const handle = normalizeHandle(rawHandle);
  const windowDays = Math.round(MENTION_SCAN_WINDOW_MS / (24 * 60 * 60_000));
  if (!handle) {
    return {
      ok: true,
      count: 0,
      mentions: [],
      windowDays,
      lastFetchedAt: null,
      fromCache: true,
    };
  }

  // Refresh the tweet cache (throttled) so the scan reflects recent activity.
  const refreshed = await getLatestTweets(handle, { force: opts.force });
  if (refreshed.ok === false) return refreshed; // NO_KEY_CONFIGURED

  const since = new Date(Date.now() - MENTION_SCAN_WINDOW_MS);
  const rows = (await adminDb.tweets
    .findMany({
      where: {
        username: handle,
        mentions_us: true,
        posted_at: { gte: since },
      },
      orderBy: { posted_at: "desc" },
      take: 100,
    })
    .catch((err) => {
      logWarn("creator-hub.twitter", "mention scan read failed", err);
      return [];
    })) as unknown as TweetRow[];

  return {
    ok: true,
    count: rows.length,
    mentions: rows.map(rowToTweet),
    windowDays,
    lastFetchedAt: refreshed.lastFetchedAt,
    fromCache: refreshed.fromCache,
    staleError: refreshed.staleError,
  };
}

/** Force a profile refresh (manual Refetch). */
export function refetchTwitterProfile(
  rawHandle: string,
): Promise<TwitterProfileResult> {
  return getTwitterProfile(rawHandle, { force: true });
}

/** Force a tweets refresh (manual Refetch). */
export function refetchLatestTweets(
  rawHandle: string,
  limit?: number,
): Promise<TweetsResult> {
  return getLatestTweets(rawHandle, { force: true, limit });
}
