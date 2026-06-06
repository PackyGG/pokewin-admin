import "server-only";

import { adminDb } from "@/lib/admin-db";
import { logError, logWarn } from "@/lib/errors/logger";
import { withTimeout } from "@/lib/errors/safe-query";
import {
  CACHE_TTL_MS,
  getKickApiKey,
  NO_KEY_CONFIGURED,
  type NoKeyConfigured,
  normalizeHandle,
  RAPIDAPI_HOSTS,
  shouldFetch,
} from "./cache";

/**
 * Kick integration service (RapidAPI `kick-com-api` / KickLib).
 *
 * Reads the cached Kick profile + streams from the ADMIN DB and refreshes them
 * through RapidAPI under the STRICT no-spam contract in `cache.ts`:
 *   • profile = fetch-once, refresh only on manual Refetch (`force`);
 *   • streams = served from DB within a TTL, throttled on `last_fetched_at`.
 * Every outbound call is wrapped in {@link withTimeout} so a stuck upstream
 * degrades to the cached value. The RapidAPI key is read SERVER-ONLY from
 * `admin_settings`; if absent the functions return {@link NO_KEY_CONFIGURED}.
 *
 * Endpoints (RECON blueprint, host `kick-com-api.p.rapidapi.com`, key = slug):
 *   • profile        GET /api/v1/channels/{slug}
 *   • followers      GET /api/v1/channels/{slug}/followers-count
 *   • livestream     GET /api/v1/channels/{slug}/livestream
 *   • past streams   GET /api/v2/channels/{slug}/videos
 */

/** Per-call upstream timeout. Kept tight so a tab never hangs on Kick. */
const KICK_TIMEOUT_MS = 12_000;

// ─── Public typed shapes (what tabs / Creator-Check consume) ────────────────

export type KickLiveInfo = {
  isLive: boolean;
  viewerCount: number | null;
  /** Stream start (→ uptime). */
  startedAt: string | null;
  title: string | null;
  category: string | null;
};

export type KickProfile = {
  username: string;
  kickUserId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  followerCount: number | null;
  isVerified: boolean | null;
  isLive: boolean;
  /** ISO string of when WE last refreshed this from the API (null = never). */
  lastFetchedAt: string | null;
};

export type KickStream = {
  kickStreamId: string;
  title: string | null;
  category: string | null;
  thumbnailUrl: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  vodViews: number | null;
  peakViewers: number | null;
  vodUrl: string | null;
};

/** Profile read result: data (or null = not linked / never fetched) + flags. */
export type KickProfileResult =
  | NoKeyConfigured
  | {
      ok: true;
      profile: KickProfile | null;
      /** True when this response was served from the DB cache (no API hit). */
      fromCache: boolean;
      /** Set if the live API call failed but stale cache was returned. */
      staleError?: string;
    };

export type KickStreamsResult =
  | NoKeyConfigured
  | {
      ok: true;
      streams: KickStream[];
      lastFetchedAt: string | null;
      fromCache: boolean;
      staleError?: string;
    };

// ─── RapidAPI raw payload shapes (only the fields we read) ───────────────────

type KickRawSocials = {
  twitter?: string | null;
  youtube?: string | null;
  discord?: string | null;
  tiktok?: string | null;
  instagram?: string | null;
  facebook?: string | null;
};

type KickRawUser = {
  id?: number | string | null;
  username?: string | null;
  bio?: string | null;
  profile_pic?: string | null;
  agreed_to_terms?: boolean | null;
} & KickRawSocials;

type KickRawCategory = { name?: string | null } | null;

type KickRawLivestream = {
  is_live?: boolean | null;
  viewer_count?: number | null;
  viewers?: number | null;
  created_at?: string | null;
  start_time?: string | null;
  session_title?: string | null;
  duration?: number | null;
  categories?: KickRawCategory[] | null;
} | null;

type KickRawChannel = {
  id?: number | string | null;
  user_id?: number | string | null;
  slug?: string | null;
  followersCount?: number | null;
  followers_count?: number | null;
  verified?: boolean | null;
  is_banned?: boolean | null;
  user?: KickRawUser | null;
  livestream?: KickRawLivestream;
  previous_livestreams?: KickRawVideo[] | null;
};

type KickRawVideo = {
  id?: number | string | null;
  session_title?: string | null;
  created_at?: string | null;
  start_time?: string | null;
  duration?: number | null;
  thumbnail?: { src?: string | null; srcset?: string | null } | string | null;
  categories?: KickRawCategory[] | null;
  views?: number | null;
  video?: {
    uuid?: string | null;
    views?: number | null;
    id?: number | string | null;
  } | null;
};

// ─── Low-level fetch helper ─────────────────────────────────────────────────

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

/**
 * One RapidAPI GET against the Kick host. Returns parsed JSON or throws. A
 * 404 (channel not found) is normalized to `null` so callers can treat it as
 * "no such handle" rather than an error.
 */
async function kickGet<T>(
  path: string,
  apiKey: string,
): Promise<T | null> {
  const url = `https://${RAPIDAPI_HOSTS.KICK}${path}`;
  const res = await withTimeout(
    () =>
      fetch(url, {
        method: "GET",
        headers: {
          "X-RapidAPI-Key": apiKey,
          "X-RapidAPI-Host": RAPIDAPI_HOSTS.KICK,
        },
        cache: "no-store",
      }),
    KICK_TIMEOUT_MS,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    // 429 = rate limited; surface it distinctly so callers can back off.
    throw new Error(`Kick API ${res.status} ${res.statusText} for ${path}`);
  }
  return (await res.json()) as T;
}

// ─── Mappers: DB row → public shape ─────────────────────────────────────────

type KickProfileRow = {
  username: string;
  kick_user_id: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  follower_count: number | null;
  is_verified: boolean | null;
  is_live: boolean;
  last_fetched_at: Date | null;
};

function rowToProfile(row: KickProfileRow): KickProfile {
  return {
    username: row.username,
    kickUserId: row.kick_user_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    followerCount: row.follower_count,
    isVerified: row.is_verified,
    isLive: row.is_live,
    lastFetchedAt: row.last_fetched_at?.toISOString() ?? null,
  };
}

type KickStreamRow = {
  kick_stream_id: string;
  title: string | null;
  category: string | null;
  thumbnail_url: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  duration_seconds: number | null;
  vod_views: number | null;
  peak_viewers: number | null;
  vod_url: string | null;
};

function rowToStream(row: KickStreamRow): KickStream {
  return {
    kickStreamId: row.kick_stream_id,
    title: row.title,
    category: row.category,
    thumbnailUrl: row.thumbnail_url,
    startedAt: row.started_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    durationSeconds: row.duration_seconds,
    vodViews: row.vod_views,
    peakViewers: row.peak_viewers,
    vodUrl: row.vod_url,
  };
}

// ─── Live-info extraction (shared by profile + getKickLive) ─────────────────

function extractLive(ls: KickRawLivestream): KickLiveInfo {
  if (!ls || ls.is_live === false || ls.is_live == null) {
    // Some payloads omit the livestream entirely when offline.
    const isLive = ls?.is_live === true;
    if (!isLive) {
      return {
        isLive: false,
        viewerCount: null,
        startedAt: null,
        title: null,
        category: null,
      };
    }
  }
  return {
    isLive: ls?.is_live === true,
    viewerCount: toInt(ls?.viewer_count ?? ls?.viewers),
    startedAt: toIso(ls?.created_at ?? ls?.start_time),
    title: toStr(ls?.session_title),
    category: toStr(ls?.categories?.[0]?.name),
  };
}

// ─── Thumbnail extraction (videos payload) ──────────────────────────────────

function extractThumb(thumb: KickRawVideo["thumbnail"]): string | null {
  if (!thumb) return null;
  if (typeof thumb === "string") return toStr(thumb);
  return toStr(thumb.src);
}

// ─── VOD → stream-row mapping ───────────────────────────────────────────────

function videoToStreamRow(
  username: string,
  v: KickRawVideo,
): {
  kick_stream_id: string;
  title: string | null;
  category: string | null;
  thumbnail_url: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  duration_seconds: number | null;
  vod_views: number | null;
  peak_viewers: number | null;
  vod_url: string | null;
  raw_json: KickRawVideo;
} | null {
  // Stable per-stream id: prefer the video uuid, then the numeric ids.
  const streamId =
    toStr(v.video?.uuid) ?? toStr(v.id) ?? toStr(v.video?.id);
  if (!streamId) return null;
  const startedAtIso = toIso(v.created_at ?? v.start_time);
  const startedAt = startedAtIso ? new Date(startedAtIso) : null;
  const durationSeconds = toInt(v.duration);
  // Kick `duration` is milliseconds on the videos payload; normalize to s if
  // it's implausibly large for seconds (> 24h) — defensive, the UI shows s.
  const normalizedDuration =
    durationSeconds != null && durationSeconds > 86_400
      ? Math.round(durationSeconds / 1000)
      : durationSeconds;
  const endedAt =
    startedAt && normalizedDuration != null
      ? new Date(startedAt.getTime() + normalizedDuration * 1000)
      : null;
  const uuid = toStr(v.video?.uuid);
  return {
    kick_stream_id: streamId,
    title: toStr(v.session_title),
    category: toStr(v.categories?.[0]?.name),
    thumbnail_url: extractThumb(v.thumbnail),
    started_at: startedAt,
    ended_at: endedAt,
    duration_seconds: normalizedDuration,
    vod_views: toInt(v.video?.views ?? v.views),
    peak_viewers: null, // not provided by this endpoint
    vod_url: uuid ? `https://kick.com/video/${uuid}` : null,
    raw_json: v,
  };
}

// ─── Profile: fetch-once, refresh on manual Refetch ─────────────────────────

/**
 * Get a Kick channel profile for a handle, served from the ADMIN-DB cache.
 *
 * Behaviour:
 *   • `force=false` (default): if a cached row exists and is within the
 *     profile TTL it's returned with NO API call. If there's no row (or the
 *     TTL lapsed) ONE profile fetch is made, stored, and returned.
 *   • `force=true` (manual Refetch): one fetch is made (subject to the hard
 *     anti-mash min-interval in `shouldFetch`), stored, returned.
 *   • No key configured → {@link NO_KEY_CONFIGURED}.
 *   • Upstream failure with a stale cache present → stale row + `staleError`.
 *   • Unknown handle (404) with no cache → `profile: null`.
 *
 * NEVER loops or polls — one read, at most one conditional fetch.
 */
export async function getKickProfile(
  rawHandle: string,
  opts: { force?: boolean } = {},
): Promise<KickProfileResult> {
  const handle = normalizeHandle(rawHandle);
  if (!handle) return { ok: true, profile: null, fromCache: true };

  const apiKey = await getKickApiKey();

  // Load the cached row first (also used as the stale fallback).
  const cached = (await adminDb.kick_profiles
    .findUnique({ where: { username: handle } })
    .catch((err) => {
      logWarn("creator-hub.kick", "kick_profiles read failed", err);
      return null;
    })) as KickProfileRow | null;

  if (!apiKey) {
    // Without a key we can still serve whatever we cached earlier.
    if (cached) {
      return { ok: true, profile: rowToProfile(cached), fromCache: true };
    }
    return NO_KEY_CONFIGURED;
  }

  const force = opts.force === true;
  if (!shouldFetch(cached?.last_fetched_at ?? null, CACHE_TTL_MS.PROFILE, force)) {
    return {
      ok: true,
      profile: cached ? rowToProfile(cached) : null,
      fromCache: true,
    };
  }

  // Fetch fresh. One call returns profile + (current) live status.
  try {
    const channel = await kickGet<KickRawChannel>(
      `/api/v1/channels/${encodeURIComponent(handle)}`,
      apiKey,
    );
    if (!channel) {
      // 404 — unknown handle. Don't write a row; return cache if any.
      if (cached) {
        return { ok: true, profile: rowToProfile(cached), fromCache: true };
      }
      return { ok: true, profile: null, fromCache: false };
    }

    const live = extractLive(channel.livestream ?? null);
    const data = {
      username: handle,
      kick_user_id: toStr(channel.user_id ?? channel.id ?? channel.user?.id),
      display_name: toStr(channel.user?.username) ?? handle,
      avatar_url: toStr(channel.user?.profile_pic),
      bio: toStr(channel.user?.bio),
      follower_count: toInt(channel.followersCount ?? channel.followers_count),
      is_verified: channel.verified ?? null,
      is_live: live.isLive,
      raw_json: channel as unknown as object,
      last_fetched_at: new Date(),
    };

    const saved = (await adminDb.kick_profiles.upsert({
      where: { username: handle },
      update: data,
      create: data,
    })) as unknown as KickProfileRow;

    return { ok: true, profile: rowToProfile(saved), fromCache: false };
  } catch (err) {
    logError("creator-hub.kick", `getKickProfile failed for ${handle}`, err);
    if (cached) {
      return {
        ok: true,
        profile: rowToProfile(cached),
        fromCache: true,
        staleError: err instanceof Error ? err.message : "Kick fetch failed",
      };
    }
    // Re-throw shape as a graceful empty so the tab renders an error state.
    return {
      ok: true,
      profile: null,
      fromCache: false,
      staleError: err instanceof Error ? err.message : "Kick fetch failed",
    };
  }
}

// ─── Past streams: served from DB within TTL, throttled ─────────────────────

/**
 * Get the latest Kick streams/VODs for a handle (owner wants PAST streams),
 * served from the ADMIN-DB cache and refreshed under the streams TTL/throttle.
 *
 * One read + at most one conditional fetch (no loops). `force=true` is the
 * manual Refetch path (still anti-mash throttled). `limit` caps how many rows
 * are returned (most-recent first).
 */
export async function getKickStreams(
  rawHandle: string,
  opts: { force?: boolean; limit?: number } = {},
): Promise<KickStreamsResult> {
  const handle = normalizeHandle(rawHandle);
  if (!handle) {
    return { ok: true, streams: [], lastFetchedAt: null, fromCache: true };
  }
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const apiKey = await getKickApiKey();

  // Newest cached row tells us when we last refreshed this channel's streams.
  const newest = (await adminDb.kick_streams
    .findFirst({
      where: { username: handle },
      orderBy: { last_fetched_at: "desc" },
      select: { last_fetched_at: true },
    })
    .catch((err) => {
      logWarn("creator-hub.kick", "kick_streams freshness read failed", err);
      return null;
    })) as { last_fetched_at: Date | null } | null;

  const readCache = async (): Promise<KickStream[]> => {
    const rows = (await adminDb.kick_streams
      .findMany({
        where: { username: handle },
        orderBy: { started_at: "desc" },
        take: limit,
      })
      .catch((err) => {
        logWarn("creator-hub.kick", "kick_streams read failed", err);
        return [];
      })) as unknown as KickStreamRow[];
    return rows.map(rowToStream);
  };

  if (!apiKey) {
    const streams = await readCache();
    if (streams.length > 0 || newest) {
      return {
        ok: true,
        streams,
        lastFetchedAt: newest?.last_fetched_at?.toISOString() ?? null,
        fromCache: true,
      };
    }
    return NO_KEY_CONFIGURED;
  }

  const force = opts.force === true;
  if (!shouldFetch(newest?.last_fetched_at ?? null, CACHE_TTL_MS.STREAMS, force)) {
    return {
      ok: true,
      streams: await readCache(),
      lastFetchedAt: newest?.last_fetched_at?.toISOString() ?? null,
      fromCache: true,
    };
  }

  // Fetch fresh VODs and upsert each.
  try {
    const videos = await kickGet<KickRawVideo[] | { data?: KickRawVideo[] }>(
      `/api/v2/channels/${encodeURIComponent(handle)}/videos`,
      apiKey,
    );
    const list: KickRawVideo[] = Array.isArray(videos)
      ? videos
      : Array.isArray(videos?.data)
        ? videos.data
        : [];

    const now = new Date();
    let upserts = 0;
    for (const v of list.slice(0, 50)) {
      const row = videoToStreamRow(handle, v);
      if (!row) continue;
      const { kick_stream_id, raw_json, ...rest } = row;
      const payload = {
        username: handle,
        kick_stream_id,
        ...rest,
        raw_json: raw_json as unknown as object,
        last_fetched_at: now,
      };
      await adminDb.kick_streams.upsert({
        where: {
          username_kick_stream_id: {
            username: handle,
            kick_stream_id,
          },
        },
        update: payload,
        create: payload,
      });
      upserts++;
    }

    if (upserts === 0) {
      // Nothing returned — still stamp freshness via the newest existing row's
      // absence; just return whatever cache we have so we don't refetch in a
      // tight loop on an empty channel.
      logWarn(
        "creator-hub.kick",
        `getKickStreams returned no VODs for ${handle}`,
      );
    }

    return {
      ok: true,
      streams: await readCache(),
      lastFetchedAt: now.toISOString(),
      fromCache: false,
    };
  } catch (err) {
    logError("creator-hub.kick", `getKickStreams failed for ${handle}`, err);
    const streams = await readCache();
    return {
      ok: true,
      streams,
      lastFetchedAt: newest?.last_fetched_at?.toISOString() ?? null,
      fromCache: true,
      staleError: err instanceof Error ? err.message : "Kick fetch failed",
    };
  }
}

// ─── Live status (current) — direct, NOT cached as a poll ───────────────────

/**
 * Fetch the CURRENT live status for a handle directly from the livestream
 * endpoint. This is a point-in-time read for a "Live now" badge; it does NOT
 * poll and is only called when a surface explicitly needs the live flag at
 * render. Returns {@link NO_KEY_CONFIGURED} without a key, or `null` on a
 * 404 / failure (caller treats as offline/unknown).
 *
 * NOTE: prefer reading `profile.isLive` from {@link getKickProfile} for the
 * cached snapshot; use this only when an up-to-the-second live flag is needed.
 */
export async function getKickLive(
  rawHandle: string,
): Promise<NoKeyConfigured | { ok: true; live: KickLiveInfo | null }> {
  const handle = normalizeHandle(rawHandle);
  if (!handle) return { ok: true, live: null };
  const apiKey = await getKickApiKey();
  if (!apiKey) return NO_KEY_CONFIGURED;
  try {
    const ls = await kickGet<KickRawLivestream | { data?: KickRawLivestream }>(
      `/api/v1/channels/${encodeURIComponent(handle)}/livestream`,
      apiKey,
    );
    if (!ls) return { ok: true, live: extractLive(null) };
    const payload: KickRawLivestream =
      ls && typeof ls === "object" && "data" in ls
        ? (ls.data ?? null)
        : (ls as KickRawLivestream);
    return { ok: true, live: extractLive(payload) };
  } catch (err) {
    logError("creator-hub.kick", `getKickLive failed for ${handle}`, err);
    return { ok: true, live: null };
  }
}

/** Force a profile refresh (manual Refetch button). Thin alias for clarity. */
export function refetchKickProfile(rawHandle: string): Promise<KickProfileResult> {
  return getKickProfile(rawHandle, { force: true });
}

/** Force a streams refresh (manual Refetch button). */
export function refetchKickStreams(
  rawHandle: string,
  limit?: number,
): Promise<KickStreamsResult> {
  return getKickStreams(rawHandle, { force: true, limit });
}
