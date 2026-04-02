/**
 * Fetch public social stats by username (no OAuth required).
 * Primary: ScrapeCreators API for Twitter, YouTube, Instagram.
 * Kick uses its own public API.
 * Social Blade kept as fallback for YouTube/Instagram.
 */

export type PublicSocialStats = {
  followerCount: number | null;
  platformUserId?: string | null;
};

export async function fetchPublicStats(
  platform: string,
  username: string
): Promise<PublicSocialStats> {
  try {
    switch (platform) {
      case "twitter":
        return await fetchTwitter(username);
      case "youtube":
        return await fetchYouTube(username);
      case "kick":
        return await fetchKick(username);
      case "instagram":
        return await fetchInstagram(username);
      default:
        return { followerCount: null };
    }
  } catch (error) {
    console.error(`Failed to fetch public ${platform} stats for @${username}:`, error);
    return { followerCount: null };
  }
}

// --- Shared ScrapeCreators helper ---
const SCRAPE_BASE = "https://api.scrapecreators.com/v1";

function scrapeHeaders(): Record<string, string> | null {
  const apiKey = process.env.SCRAPECREATORS_API_KEY;
  if (!apiKey) return null;
  return { "x-api-key": apiKey };
}

// --- Twitter / X (ScrapeCreators → fallback twitterapi.io) ---
async function fetchTwitter(username: string): Promise<PublicSocialStats> {
  const headers = scrapeHeaders();
  if (headers) {
    const res = await fetch(
      `${SCRAPE_BASE}/twitter/profile?handle=${encodeURIComponent(username)}`,
      { headers, signal: AbortSignal.timeout(10000) }
    );
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.legacy) {
        return {
          followerCount: data.legacy.followers_count ?? null,
          platformUserId: data.core?.screen_name ?? null,
        };
      }
    }
  }

  // Fallback: twitterapi.io
  const apiKey = process.env.TWITTER_API_IO_KEY;
  if (!apiKey) return { followerCount: null };

  const res = await fetch(
    `https://api.twitterapi.io/twitter/user/info?userName=${encodeURIComponent(username)}`,
    {
      headers: { "X-API-Key": apiKey },
      signal: AbortSignal.timeout(10000),
    }
  );
  if (!res.ok) return { followerCount: null };
  const data = await res.json();
  return {
    followerCount: data.data?.followers ?? null,
    platformUserId: data.data?.id ?? null,
  };
}

// --- YouTube (ScrapeCreators → fallback Social Blade) ---
async function fetchYouTube(username: string): Promise<PublicSocialStats> {
  const headers = scrapeHeaders();
  if (headers) {
    const res = await fetch(
      `${SCRAPE_BASE}/youtube/channel?handle=${encodeURIComponent(username)}`,
      { headers, signal: AbortSignal.timeout(10000) }
    );
    if (res.ok) {
      const data = await res.json();
      if (data.success && !data.accountDoesNotExist) {
        return {
          followerCount: data.subscriberCount ?? null,
          platformUserId: data.channelId ?? null,
        };
      }
    }
  }

  // Fallback: Social Blade
  return fetchSocialBlade("youtube", username);
}

// --- Kick (via aerokick.app scraping) ---
async function fetchKick(username: string): Promise<PublicSocialStats> {
  const res = await fetch(
    `https://aerokick.app/stats/channels/${encodeURIComponent(username)}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return { followerCount: null };
  const html = await res.text();

  // Extract follower count from hydration data: followers\",{NUMBER}
  const match = html.match(/followers\\",(\d+)/);
  if (match) {
    return {
      followerCount: parseInt(match[1], 10),
      platformUserId: null,
    };
  }

  return { followerCount: null };
}

// --- Instagram (ScrapeCreators → fallback Social Blade) ---
async function fetchInstagram(username: string): Promise<PublicSocialStats> {
  const headers = scrapeHeaders();
  if (headers) {
    const res = await fetch(
      `${SCRAPE_BASE}/instagram/profile?handle=${encodeURIComponent(username)}`,
      { headers, signal: AbortSignal.timeout(10000) }
    );
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        return {
          followerCount: data.data?.user?.edge_followed_by?.count ?? null,
          platformUserId: data.data?.user?.id ?? null,
        };
      }
    }
  }

  // Fallback: Social Blade
  return fetchSocialBlade("instagram", username);
}

// --- Social Blade (fallback for YouTube/Instagram) ---
async function fetchSocialBlade(
  platform: "youtube" | "instagram",
  username: string
): Promise<PublicSocialStats> {
  const clientId = process.env.SOCIALBLADE_CLIENT_ID;
  const token = process.env.SOCIALBLADE_TOKEN;
  if (!clientId || !token) return { followerCount: null };

  const res = await fetch(
    `https://matrix.sbapis.com/b/${platform}/statistics?query=${encodeURIComponent(username)}`,
    {
      headers: { clientid: clientId, token },
      signal: AbortSignal.timeout(10000),
    }
  );
  if (!res.ok) return { followerCount: null };
  const data = await res.json();

  const stats = data.data?.statistics?.total;
  if (!stats) return { followerCount: null };

  const count = platform === "youtube" ? stats.subscribers : stats.followers;

  return {
    followerCount: count != null ? Number(count) : null,
    platformUserId: data.data?.id?.id ?? null,
  };
}
