import "server-only";

import { creatorsApi } from "@/lib/backend-api";

export type CreatorTopCounts = {
  /**
   * Creators streaming right now — `active_session_id` is non-null on
   * the CreatorListItem. The backend marks a stream session "active"
   * while it's in progress; this counts those creators.
   */
  liveNow: number;
  /**
   * Creators whose `current_deal.status === "active"`. Scheduled deals
   * are NOT counted here — only the deal that's actually running this
   * week. Matches the strict reading of "active deal".
   */
  activeDeals: number;
};

/**
 * Pulls the full creator list from the backend and tallies two
 * top-level KPI counts for the /creators page hero. The backend
 * exposes no dedicated aggregate endpoint, so we paginate through
 * `creatorsApi.list` once and count.
 *
 * Sizing: backend has tens of creators today (low double-digits in
 * practice — creator tier is selective). The 200-per-page loop with
 * a 1000-row safety stop matches the cap used by `socials-by-user`
 * and keeps the call cheap on a hot page render. If the platform
 * grows past ~1000 creators the safety stop kicks in and the count
 * will silently truncate — at that point we'd want a real aggregate
 * endpoint on the backend rather than scaling the cap further.
 *
 * Best-effort on errors — the caller catches and falls back to
 * `null` counts so a backend hiccup never crashes the page; the
 * tiles just show "—" in that case.
 */
export async function getCreatorTopCounts(): Promise<CreatorTopCounts> {
  let liveNow = 0;
  let activeDeals = 0;
  const limit = 200;
  const max = 1000;
  let offset = 0;

  while (offset < max) {
    const { data, total } = await creatorsApi.list({ offset, limit });
    for (const c of data) {
      if (c.active_session_id) liveNow++;
      if (c.current_deal?.status === "active") activeDeals++;
    }
    offset += limit;
    if (offset >= total || data.length < limit) break;
  }

  return { liveNow, activeDeals };
}
