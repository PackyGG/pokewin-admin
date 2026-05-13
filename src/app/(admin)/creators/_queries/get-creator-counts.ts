import "server-only";

import { creatorsApi } from "@/lib/backend-api";

export type CreatorTopCounts = {
  /**
   * Creators streaming right now — `active_session_id` is non-null on
   * the CreatorListItem. Same signal the per-creator card uses for
   * its pulsing-dot "Live" indicator, so the count stays consistent
   * with what an admin sees on the cards below.
   */
  liveNow: number;
  /**
   * Creators whose `current_deal.status === "active"`. Scheduled deals
   * are NOT counted here — only the deal that's actually running this
   * week. Matches the strict reading of "active deal" and the
   * emerald-tinted badge the card shows for that status.
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
 * practice — creator tier is selective). The first pass tried
 * `limit: 200` per page but the backend caps `limit` at 100 (same
 * upper bound as the frontend zod schema in `_lib/search-params.ts`).
 * Anything above silently 400'd and the helper threw, which the
 * page's `.catch` swallowed → tiles read "—" with no number.
 *
 * Loop with `limit: 100` matches the proven cap. 1000-row safety
 * stop means up to 10 iterations max; in practice the platform
 * tops out at one round-trip. If the platform grows past ~1000
 * creators the safety stop kicks in and the count silently
 * truncates — at that point we'd want a real aggregate endpoint
 * on the backend rather than scaling the cap further.
 *
 * Best-effort on errors — the caller catches and falls back to
 * `null` counts so a backend hiccup never crashes the page; the
 * tiles just show "—" in that case. We also log here with the
 * failing offset so a future regression is grepable from Vercel
 * logs without having to dig.
 */
export async function getCreatorTopCounts(): Promise<CreatorTopCounts> {
  let liveNow = 0;
  let activeDeals = 0;
  const limit = 100;
  const max = 1000;
  let offset = 0;

  while (offset < max) {
    let page;
    try {
      page = await creatorsApi.list({ offset, limit });
    } catch (err) {
      // Re-throw so the page's `.catch` logs + falls back to null —
      // but enrich the message with where we were so the cause is
      // legible in Vercel logs without having to re-derive it.
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        `getCreatorTopCounts: creatorsApi.list failed at offset=${offset} limit=${limit}: ${cause}`,
        { cause: err },
      );
    }
    const { data, total } = page;
    for (const c of data) {
      if (c.active_session_id) liveNow++;
      if (c.current_deal?.status === "active") activeDeals++;
    }
    offset += limit;
    if (offset >= total || data.length < limit) break;
  }

  return { liveNow, activeDeals };
}
