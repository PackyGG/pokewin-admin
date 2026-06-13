import type { PackStats } from "@/lib/queries/packs";
import {
  fetchPackDetailCore,
  fetchPackDetailStats,
  fetchPackGamesSafe,
  type PackFullDetail,
} from "./actions";

type GamesPage = Awaited<ReturnType<typeof fetchPackGamesSafe>>;

const readyCache = new Map<string, PackFullDetail>();
const inflightFull = new Map<string, Promise<PackFullDetail | null>>();
const inflightStats = new Map<string, Promise<PackStats | null>>();
const gamesCache = new Map<string, GamesPage>();
const inflightGames = new Map<string, Promise<GamesPage>>();

/** Drop cached modal payloads. Pass a pack id to bust one pack only. */
export function invalidatePackDetailCache(packId?: string): void {
  if (packId) {
    readyCache.delete(packId);
    inflightFull.delete(packId);
    inflightStats.delete(packId);
    gamesCache.delete(packId);
    inflightGames.delete(packId);
    return;
  }
  readyCache.clear();
  inflightFull.clear();
  inflightStats.clear();
  gamesCache.clear();
  inflightGames.clear();
}

export function getCachedPackDetail(packId: string): PackFullDetail | undefined {
  return readyCache.get(packId);
}

/**
 * Load the modal payload with in-flight dedupe so double-clicks / rapid reopens
 * share one server round-trip per pack id.
 */
export function loadPackFullDetail(
  packId: string,
  opts?: { force?: boolean },
): Promise<PackFullDetail | null> {
  const force = opts?.force ?? false;

  if (!force) {
    const cached = readyCache.get(packId);
    if (cached) return Promise.resolve(cached);
    const inflight = inflightFull.get(packId);
    if (inflight) return inflight;
  } else {
    readyCache.delete(packId);
    inflightFull.delete(packId);
  }

  const promise = (async () => {
    const detail = await fetchPackDetailCore(packId);
    if (!detail) return null;

    const stats = await loadPackStats(packId, detail, { force });
    const payload: PackFullDetail = { detail, stats };
    readyCache.set(packId, payload);
    return payload;
  })().finally(() => {
    inflightFull.delete(packId);
  });

  inflightFull.set(packId, promise);
  return promise;
}

export function loadPackStats(
  packId: string,
  detail: NonNullable<PackFullDetail["detail"]>,
  opts?: { force?: boolean },
): Promise<PackStats | null> {
  const force = opts?.force ?? false;
  const cached = readyCache.get(packId);
  if (!force && cached?.stats) return Promise.resolve(cached.stats);

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
