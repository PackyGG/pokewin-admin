import "server-only";

import { withTimeout } from "@/lib/errors/safe-query";

/**
 * Kick profile fallback via AeroKick public stats pages.
 *
 * RapidAPI Kick endpoints often fail (missing key, unsubscribed plan, upstream
 * 403 from kick.com). AeroKick mirrors public channel stats and is already used
 * for follower scraping in `socials-public.ts`. This module centralizes HTML
 * parsing for Creator-Hub profile hydration.
 */

const AEROKICK_TIMEOUT_MS = 12_000;

export type AerokickKickProfile = {
  username: string;
  kickUserId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  followerCount: number | null;
};

function toInt(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Fetch a Kick channel profile by scraping the AeroKick stats page for a slug.
 * Returns null when the channel is missing or the page has no recognizable data.
 */
export async function fetchKickProfileFromAerokick(
  handle: string,
): Promise<AerokickKickProfile | null> {
  const slug = handle.trim().toLowerCase();
  if (!slug) return null;

  const url = `https://aerokick.app/stats/channels/${encodeURIComponent(slug)}`;
  const res = await withTimeout(
    () =>
      fetch(url, {
        method: "GET",
        cache: "no-store",
        signal: AbortSignal.timeout(AEROKICK_TIMEOUT_MS),
      }),
    AEROKICK_TIMEOUT_MS,
  );

  if (!res.ok) return null;
  const html = await res.text();

  const followerCount = toInt(
    html.match(/followers\\",(\d+)/)?.[1] ??
      html.match(/followers<\/h3>[\s\S]{0,400}?(\d[\d,]*)/)?.[1]?.replace(/,/g, ""),
  );

  const avatarMatch = html.match(
    /(https:\/\/files\.kick\.com\/images\/user\/(\d+)\/profile_image\/[^"'\s]+)/,
  );
  const avatarUrl = avatarMatch?.[1] ?? null;
  const kickUserId = avatarMatch?.[2] ?? null;

  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const displayName =
    titleMatch?.[1]?.replace(/\s+Stats\s*\|\s*AeroKick\s*$/i, "").trim() ?? null;

  const bioMatch = html.match(
    /<p class="text-lg text-foreground">([^<]*)<\/p>/i,
  );
  const bio = bioMatch?.[1]?.trim() || null;

  if (followerCount == null && !avatarUrl && !displayName) {
    return null;
  }

  return {
    username: slug,
    kickUserId,
    displayName: displayName ?? slug,
    avatarUrl,
    bio,
    followerCount,
  };
}
