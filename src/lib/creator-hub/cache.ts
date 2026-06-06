import "server-only";

import { getAdminSetting } from "@/lib/admin-settings";
import { logWarn } from "@/lib/errors/logger";

/**
 * Creator-Hub external-integration cache + throttle layer (Kick + Twitter).
 *
 * Owner rule (LOCKED 2026-06-06): RapidAPI is paid + rate-limited, so spam =
 * cost + bans. This module enforces the STRICT no-spam contract shared by
 * `kick.ts` and `twitter.ts`:
 *
 *   • Static profile data (pfp / username / followers / bio) is fetched ONCE
 *     into the ADMIN DB and only ever re-fetched when a manager clicks the
 *     manual Refetch button (`forceRefetch`).
 *   • "Live-ish" data (latest streams / latest tweets) may refresh on demand
 *     but is SERVED FROM THE DB within a TTL and min-interval throttled on
 *     `last_fetched_at`, so repeated page views / multiple managers viewing
 *     the same creator do NOT re-hit the API.
 *   • There are NO loops, NO background pollers, NO per-render fetch. The only
 *     forced refresh is an explicit `forceRefetch` from a manager action.
 *
 * Every outbound API call additionally runs through {@link withTimeout}
 * (see `@/lib/errors/safe-query`) at the call sites so a stuck upstream
 * degrades to the cached/empty value instead of hanging the request.
 *
 * SECURITY: the RapidAPI keys are secrets. They are read SERVER-ONLY from the
 * ADMIN DB `admin_settings` table (this file is `server-only`) and are never
 * returned to a caller or shipped to the client. Callers receive typed data
 * objects only.
 */

// ─── API-key storage (admin_settings, server-only) ──────────────────────────

/**
 * `admin_settings` keys that hold the RapidAPI secrets. Stored in the ADMIN DB
 * via the Settings page (server action), masked in the UI, never sent to the
 * browser. Import these rather than hardcoding the strings.
 */
export const INTEGRATION_SETTINGS_KEYS = {
  KICK_RAPIDAPI_KEY: "integration_kick_rapidapi_key",
  TWITTER_RAPIDAPI_KEY: "integration_twitter_rapidapi_key",
} as const;

/** RapidAPI hosts (LOCKED in the plan's RECON blueprint). */
export const RAPIDAPI_HOSTS = {
  KICK: "kick-com-api.p.rapidapi.com",
  TWITTER: "twitter241.p.rapidapi.com",
} as const;

/**
 * Returned by the service functions when the relevant RapidAPI key is not
 * configured in `admin_settings`. Lets callers degrade gracefully (render a
 * "no key configured" hint + a link to Settings) instead of erroring.
 */
export type NoKeyConfigured = { ok: false; reason: "no_key_configured" };

/** The single marker value for an absent key — referentially stable. */
export const NO_KEY_CONFIGURED: NoKeyConfigured = {
  ok: false,
  reason: "no_key_configured",
};

export function isNoKeyConfigured(value: unknown): value is NoKeyConfigured {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as NoKeyConfigured).ok === false &&
    (value as NoKeyConfigured).reason === "no_key_configured"
  );
}

/**
 * Read a RapidAPI key from the ADMIN DB. Returns `null` if unset (or the
 * `admin_settings` table is missing — {@link getAdminSetting} already degrades
 * that to `null`). A blank/whitespace value is treated as unset. SERVER-ONLY.
 */
export async function getKickApiKey(): Promise<string | null> {
  const raw = await getAdminSetting(INTEGRATION_SETTINGS_KEYS.KICK_RAPIDAPI_KEY);
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

export async function getTwitterApiKey(): Promise<string | null> {
  const raw = await getAdminSetting(
    INTEGRATION_SETTINGS_KEYS.TWITTER_RAPIDAPI_KEY,
  );
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

// ─── TTL / throttle config (no-spam) ────────────────────────────────────────

const MINUTE = 60_000;

/**
 * Cache freshness windows. A cached row is "fresh" if its `last_fetched_at` is
 * within the TTL → served straight from the DB, NO API call. Outside the TTL,
 * the NEXT view (or an explicit refetch) may refresh it; static profiles only
 * ever refresh on an explicit `forceRefetch`.
 *
 * `forceRefetch` STILL respects a hard min-interval floor ({@link MIN_REFETCH_INTERVAL_MS})
 * so a manager mashing the Refetch button can't spam the API.
 */
export const CACHE_TTL_MS = {
  /**
   * Static profile data (Kick + Twitter). Long TTL — these change rarely and
   * the owner rule is "fetch once, refresh only on manual Refetch". The TTL
   * here is the upper bound a normal view will tolerate before *allowing* (not
   * forcing) a refresh; in practice the manual button is the refresh path.
   */
  PROFILE: 6 * 60 * MINUTE, // 6 hours
  /** Latest streams (Kick "live-ish"). */
  STREAMS: 10 * MINUTE,
  /** Latest tweets (Twitter "live-ish") + 7-day mention scan. */
  TWEETS: 10 * MINUTE,
} as const;

/**
 * Hard floor between two forced refetches of the SAME resource. Even an
 * explicit manual Refetch is rejected (served from DB instead) if the row was
 * fetched more recently than this — the anti-mash guard. Distinct from the TTL
 * (which governs passive freshness); this governs the forced path.
 */
export const MIN_REFETCH_INTERVAL_MS = 30_000; // 30s

/**
 * Decide whether an outbound API call is allowed for a resource, given its
 * last fetch time and whether this is a forced (manual Refetch) request.
 *
 *   • No prior fetch (`lastFetchedAt == null`)            → fetch.
 *   • Forced + older than the min-interval floor          → fetch.
 *   • Forced + within the floor (anti-mash)               → serve cache.
 *   • Not forced + older than the TTL                     → fetch.
 *   • Not forced + within the TTL                         → serve cache.
 *
 * This is the ONE gate every service read goes through — there is no other
 * path that hits the API, which is what keeps the no-spam guarantee provable.
 */
export function shouldFetch(
  lastFetchedAt: Date | null | undefined,
  ttlMs: number,
  force: boolean,
  now: number = Date.now(),
): boolean {
  if (lastFetchedAt == null) return true;
  const ageMs = now - lastFetchedAt.getTime();
  if (force) return ageMs >= MIN_REFETCH_INTERVAL_MS;
  return ageMs >= ttlMs;
}

/** True if a cached row is still within its TTL (i.e. "fresh"). */
export function isFresh(
  lastFetchedAt: Date | null | undefined,
  ttlMs: number,
  now: number = Date.now(),
): boolean {
  if (lastFetchedAt == null) return false;
  return now - lastFetchedAt.getTime() < ttlMs;
}

// ─── Handle normalization ───────────────────────────────────────────────────

/**
 * Normalize a user-entered handle to the natural key used everywhere in the
 * cache tables (lowercased, no leading `@`, no surrounding whitespace, and —
 * for pasted profile URLs — the trailing path segment). Returns `null` for an
 * empty / unusable input so callers can show the "No account linked" state.
 *
 * Examples:
 *   "@PackyGG"                         → "packygg"
 *   "https://kick.com/Trainwreckstv/"  → "trainwreckstv"
 *   "x.com/packydotgg?lang=en"         → "packydotgg"
 */
export function normalizeHandle(input: string | null | undefined): string | null {
  if (!input) return null;
  let h = input.trim();
  if (!h) return null;

  // If it looks like a URL, take the first non-empty path segment.
  if (/^https?:\/\//i.test(h) || h.includes("/")) {
    try {
      const url = new URL(h.startsWith("http") ? h : `https://${h}`);
      const seg = url.pathname.split("/").filter(Boolean)[0];
      if (seg) h = seg;
    } catch {
      // Not a parseable URL — fall through and clean the raw string.
      const seg = h.split("/").filter(Boolean).pop();
      if (seg) h = seg;
    }
  }

  h = h.replace(/^@+/, "").trim().toLowerCase();
  // Strip an accidental query/fragment tail if the URL parse didn't catch it.
  h = h.split(/[?#]/)[0];
  // Valid Kick/Twitter handles are word-chars + dot/underscore/hyphen.
  if (!/^[a-z0-9._-]+$/.test(h)) {
    logWarn(
      "creator-hub.integration",
      `normalizeHandle rejected an unexpected handle shape (len=${h.length})`,
    );
    return null;
  }
  return h;
}

// ─── Brand mention keywords (Twitter 7-day scan) ────────────────────────────

/**
 * OUR brand keywords for the 7-day Twitter mention scan. Matched
 * case-insensitively against tweet text. Kept lowercase here; the matcher
 * lowercases the tweet text once and tests `includes`.
 */
export const BRAND_KEYWORDS = [
  "packydotgg",
  "@packydotgg",
  "packygg",
  "packy.gg",
] as const;

/**
 * Return the brand keyword(s) a tweet's text matches, case-insensitive. Empty
 * array = no mention. Used both to set `tweets.mentions_us` at store time and
 * to tag `twitter_mentions.matched_keyword`.
 */
export function matchBrandKeywords(text: string | null | undefined): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  return BRAND_KEYWORDS.filter((kw) => lower.includes(kw));
}

/** Convenience: does this tweet mention us at all? */
export function mentionsBrand(text: string | null | undefined): boolean {
  return matchBrandKeywords(text).length > 0;
}

/** The mention-scan lookback window (owner spec: last 7 days). */
export const MENTION_SCAN_WINDOW_MS = 7 * 24 * 60 * MINUTE;
