import "server-only";

import { adminDb } from "@/lib/admin-db";
import { logWarn } from "@/lib/errors/logger";
import {
  getKickProfile,
  getKickStreams,
  isNoKeyConfigured,
  type KickProfile,
  type KickStream,
} from "@/lib/creator-hub";
import { getMergedLinkedHandle } from "../../../../../(admin)/creators/_queries/socials-by-user";

/**
 * Data layer for the `creators/[id]` **Kick** tab.
 *
 * Resolves the creator's linked Kick handle from the ADMIN DB
 * (`creator_socials` where `platform = 'kick'`), then serves the channel
 * profile + past streams through the shared Creator-Hub Kick service
 * (`@/lib/creator-hub`), which reads from the ADMIN-DB cache and only hits
 * RapidAPI under the strict no-spam contract (profile = fetch-once + manual
 * Refetch; streams = served-from-DB-within-TTL + manual Refetch).
 *
 * Dual-DB discipline: the only reads here are the ADMIN DB (the linked handle
 * + the cached Kick rows the service owns). NOTHING touches MAIN/prod.
 *
 * LAZY: this runs only when the Kick tab is opened (the tab is its own keyed
 * Suspense boundary on the detail page), per the active-tab-only rule. There
 * is NO loop / poll / per-render forced fetch — the service decides whether a
 * single conditional fetch is allowed.
 *
 * Resilience: the substrate tables (`creator_socials`, `kick_profiles`,
 * `kick_streams`) are expected to exist on prod, but a missing relation
 * (Postgres 42P01 / Prisma P2021) on a not-yet-migrated environment is caught
 * and degraded to an empty/linked-but-no-data state rather than crashing the
 * tab.
 */

/** A missing-relation error (table not migrated): Prisma P2021 / Postgres 42P01. */
function isMissingRelation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === "P2021" || code === "42P01";
}

export type KickTabData = {
  /** Normalized Kick handle (slug) linked on the Creator tab, or null. */
  handle: string | null;
  /**
   * True when the Kick RapidAPI key is not configured in `admin_settings`.
   * The tab still renders cached data if any exists; otherwise it shows a
   * "no key" hint. Only meaningful when `handle` is set.
   */
  noKeyConfigured: boolean;
  /** Cached channel profile (null = never fetched / unknown handle). */
  profile: KickProfile | null;
  /**
   * Channel geo from the cached raw payload (`kick_profiles.raw_json`). The
   * public `KickProfile` type doesn't promote these to columns, so they're
   * read from the stored raw JSON here — never fabricated (null when absent).
   */
  country: string | null;
  state: string | null;
  city: string | null;
  /** Most-recent past streams / VODs (cached). */
  streams: KickStream[];
  /** ISO of the last streams refresh (drives the "updated" hint). */
  streamsLastFetchedAt: string | null;
  /** Set if the live profile/streams fetch failed but stale cache was served. */
  profileStaleError: string | null;
  streamsStaleError: string | null;
};

/** Resolve the creator's linked Kick handle (merged admin + backend), or null. */
async function getLinkedKickHandle(userId: string): Promise<string | null> {
  try {
    return await getMergedLinkedHandle(userId, "kick");
  } catch (err) {
    if (isMissingRelation(err)) {
      logWarn(
        "creator-hub.kick-tab",
        "creator_socials relation missing — treating Kick as unlinked",
      );
      return null;
    }
    logWarn("creator-hub.kick-tab", "linked Kick handle read failed", err);
    return null;
  }
}

/**
 * Read the cached channel geo out of `kick_profiles.raw_json` for a handle.
 * The RapidAPI Kick payload nests country/state/city under `user`; the
 * service stores the full payload in `raw_json` but doesn't promote these to
 * typed columns, so we read them from the stored JSON here. Best-effort:
 * any miss (no row, missing relation, unexpected shape) yields all-null.
 */
async function getCachedGeo(
  handle: string,
): Promise<{ country: string | null; state: string | null; city: string | null }> {
  const empty = { country: null, state: null, city: null };
  try {
    const row = await adminDb.kick_profiles.findUnique({
      where: { username: handle },
      select: { raw_json: true },
    });
    const raw = row?.raw_json as
      | { user?: { country?: unknown; state?: unknown; city?: unknown } | null }
      | null
      | undefined;
    const user = raw?.user ?? null;
    if (!user) return empty;
    const str = (v: unknown): string | null => {
      if (v == null) return null;
      const s = String(v).trim();
      return s ? s : null;
    };
    return {
      country: str(user.country),
      state: str(user.state),
      city: str(user.city),
    };
  } catch (err) {
    if (!isMissingRelation(err)) {
      logWarn("creator-hub.kick-tab", "kick_profiles geo read failed", err);
    }
    return empty;
  }
}

/**
 * Fetch the full Kick tab bundle for a creator. Never throws — a missing
 * handle yields the "No account linked" shape (`handle: null`), a missing key
 * yields `noKeyConfigured: true`, and any upstream/cache failure degrades to
 * whatever was cached (with the stale-error string surfaced).
 *
 * @param force when true, drives the manual Refetch (still anti-mash
 *        throttled inside the service); otherwise serves cache within the TTL.
 */
export async function getKickTabData(
  userId: string,
  opts: { force?: boolean } = {},
): Promise<KickTabData> {
  const handle = await getLinkedKickHandle(userId);

  if (!handle) {
    return {
      handle: null,
      noKeyConfigured: false,
      profile: null,
      country: null,
      state: null,
      city: null,
      streams: [],
      streamsLastFetchedAt: null,
      profileStaleError: null,
      streamsStaleError: null,
    };
  }

  const force = opts.force === true;

  // Profile + streams are independent resources — fetch in parallel. The
  // service wraps each upstream call in its own timeout + graceful-degrade, so
  // one failing never blocks the other and neither hangs the tab.
  const [profileResult, streamsResult] = await Promise.all([
    getKickProfile(handle, { force }),
    getKickStreams(handle, { force, limit: 20 }),
  ]);

  const noKeyConfigured =
    isNoKeyConfigured(profileResult) || isNoKeyConfigured(streamsResult);

  const profile = isNoKeyConfigured(profileResult)
    ? null
    : profileResult.profile;
  const profileStaleError = isNoKeyConfigured(profileResult)
    ? null
    : profileResult.staleError ?? null;

  const streams = isNoKeyConfigured(streamsResult) ? [] : streamsResult.streams;
  const streamsLastFetchedAt = isNoKeyConfigured(streamsResult)
    ? null
    : streamsResult.lastFetchedAt;
  const streamsStaleError = isNoKeyConfigured(streamsResult)
    ? null
    : streamsResult.staleError ?? null;

  const geo = await getCachedGeo(handle);

  return {
    handle,
    noKeyConfigured,
    profile,
    country: geo.country,
    state: geo.state,
    city: geo.city,
    streams,
    streamsLastFetchedAt,
    profileStaleError,
    streamsStaleError,
  };
}
