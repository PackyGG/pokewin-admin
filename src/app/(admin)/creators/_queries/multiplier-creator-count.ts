import "server-only";

import { creatorsApi, multiplierDealsApi } from "@/lib/backend-api";

// The backend exposes multiplier deals only per-creator — there is no
// global list or count endpoint — so counting creators who have one is
// a whole-creator-base fan-out. It is therefore cross-request cached for
// 5 minutes; the /creators KPI strip tolerates a slightly stale count.
const TTL_MS = 5 * 60 * 1000;
const PAGE_SIZE = 100;
// 5,000 creators — well above the current/projected pool; a guard
// against a runaway loop if `total` is ever reported wrong.
const MAX_PAGES = 50;

let cache: { at: number; count: number } | null = null;

/**
 * Number of creators with at least one multiplier deal (any status) —
 * the "Multiplier Creators" KPI on /creators, paired with the
 * fill-creator count from getCreatorsGlobalStats.
 *
 * Walks the full creator list, then checks each creator's multiplier
 * deals (`limit: 1` — only the `total` count is needed). Best-effort: a
 * total failure returns null (the tile renders "—"); a single creator's
 * failed lookup just drops that creator from the count.
 */
export async function getMultiplierCreatorCount(): Promise<number | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.count;
  try {
    const count = await computeCount();
    cache = { at: Date.now(), count };
    return count;
  } catch (e) {
    console.error(
      "[multiplier-creator-count] failed (KPI tile renders '—'):",
      e,
    );
    return null;
  }
}

async function computeCount(): Promise<number> {
  // Walk every creator — first page tells us the total, then the rest
  // in parallel (mirrors getCreatorsGlobalStats' pagination).
  const firstPage = await creatorsApi.list({ offset: 0, limit: PAGE_SIZE });
  const creators = [...firstPage.data];

  const pagesNeeded = Math.min(
    MAX_PAGES,
    Math.ceil(firstPage.total / PAGE_SIZE),
  );
  const rest: Promise<typeof firstPage>[] = [];
  for (let p = 1; p < pagesNeeded; p++) {
    rest.push(creatorsApi.list({ offset: p * PAGE_SIZE, limit: PAGE_SIZE }));
  }
  for (const page of await Promise.all(rest)) creators.push(...page.data);

  // Per-creator: does this creator have ≥1 multiplier deal? allSettled
  // so one creator's failed lookup doesn't blank the whole count.
  const settled = await Promise.allSettled(
    creators.map((c) =>
      multiplierDealsApi.list(c.id, { limit: 1 }).then((r) => r.total > 0),
    ),
  );
  let count = 0;
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) count += 1;
  }
  return count;
}
