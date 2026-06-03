import { getPackGames } from "@/lib/queries/packs";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { GamesTable } from "./pack-tabs";

/**
 * GamesTabSection — server boundary for the lazily-loaded "Games" tab on
 * /packs/[id].
 *
 * Why this is its own async server component (and not part of the page's
 * upfront Promise.all): the games feed is sourced from
 * `provably_fair_results` filtered on `result_metadata->>'pack_id'`, an
 * unindexed JSON predicate that forces a full scan over the openings
 * table. The old page eager-fetched this on every mount to hydrate the
 * client <GamesTable>, even though the tab is hidden behind the default
 * Cards view — exactly the "hidden tab doing heavy work before it's
 * opened" anti-pattern the Active-Tab-Only rule forbids.
 *
 * Now the page only renders this section when `packTab === "games"`
 * (inside a keyed <Suspense>), so the scan runs on the first click, not
 * on initial load. The fetch is wrapped in `safeQuery` with a wall-clock
 * timeout so a pathological scan degrades to a fallback tile instead of
 * blocking the segment until the platform kills the request.
 */

// The initial games page is a bounded LIMIT/OFFSET slice (perPage rows),
// but the COUNT(*) over the JSON predicate is still a full scan. Bound the
// wait so a slow scan degrades rather than hanging the Games panel.
const GAMES_QUERY_TIMEOUT_MS = 15_000;

const EMPTY_GAMES = {
  data: [] as Awaited<ReturnType<typeof getPackGames>>["data"],
  total: 0,
  page: 1,
  perPage: 20,
  totalPages: 0,
};

export async function GamesTabSection({ packId }: { packId: string }) {
  const { data, error } = await safeQuery(
    () => getPackGames(packId, 1, 20),
    EMPTY_GAMES,
    "packs.detail.games",
    GAMES_QUERY_TIMEOUT_MS,
  );

  if (error) {
    return (
      <TileErrorFallback
        label="Games"
        hint="The pack games feed timed out or failed. Server logs hold the digest."
        size="panel"
      />
    );
  }

  return <GamesTable packId={packId} initialGames={data} />;
}
