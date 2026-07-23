import type { PackStats } from "@/lib/queries/packs";
import {
  fetchPackDetailStats,
  fetchPackGamesSafe,
  type PackFullDetail,
} from "./actions";

type GamesPage = Awaited<ReturnType<typeof fetchPackGamesSafe>>;

const inflightStats = new Map<string, Promise<PackStats | null>>();
const gamesCache = new Map<string, GamesPage>();
const inflightGames = new Map<string, Promise<GamesPage>>();

/** Drop cached modal payloads. Pass a pack id to bust one pack only. */
export function invalidatePackDetailCache(packId?: string): void {
  if (packId) {
    inflightStats.delete(packId);
    gamesCache.delete(packId);
    inflightGames.delete(packId);
    return;
  }
  inflightStats.clear();
  gamesCache.clear();
  inflightGames.clear();
}

export function loadPackStats(
  packId: string,
  detail: NonNullable<PackFullDetail["detail"]>,
  opts?: { force?: boolean },
): Promise<PackStats | null> {
  const force = opts?.force ?? false;

  if (!force) {
    const inflight = inflightStats.get(packId);
    if (inflight) return inflight;
  } else {
    inflightStats.delete(packId);
  }

  const promise = fetchPackDetailStats(packId, detail).finally(() => {
    inflightStats.delete(packId);
  });

  inflightStats.set(packId, promise);
  return promise;
}

export function loadPackGamesPage(
  packId: string,
  opts?: { force?: boolean },
): Promise<GamesPage> {
  const force = opts?.force ?? false;

  if (!force) {
    const cached = gamesCache.get(packId);
    if (cached) return Promise.resolve(cached);
    const inflight = inflightGames.get(packId);
    if (inflight) return inflight;
  } else {
    gamesCache.delete(packId);
    inflightGames.delete(packId);
  }

  const promise = fetchPackGamesSafe(packId, 1, 20)
    .then((res) => {
      gamesCache.set(packId, res);
      return res;
    })
    .finally(() => {
      inflightGames.delete(packId);
    });

  inflightGames.set(packId, promise);
  return promise;
}
