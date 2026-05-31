import "server-only";
import { unstable_cache } from "next/cache";
import {
  fireblocksConfigured,
  FireblocksError,
} from "@/lib/fireblocks/client";
import { getAllVaultBalances } from "@/lib/fireblocks/vault";
import {
  coinGeckoIdsFor,
  resolveUsdPerUnit,
  PRICED_ASSETS,
  STABLE_ASSETS,
} from "@/lib/fireblocks/asset-mapping";

/**
 * Public shape rendered by the dashboard tile.
 *
 * `state` distinguishes the three render paths the tile needs to handle
 * without throwing across the RSC boundary:
 *   - `ok`             → numbers are real, render the headline + breakdown.
 *   - `unconfigured`   → env vars missing — calm muted state, no error.
 *   - `error`          → API call failed or the secret was rejected.
 *
 * Errors carry a short, generic `message` only — never the upstream body.
 */
export type FireblocksVaultSnapshot =
  | {
      state: "ok";
      totalUsd: number;
      /** Per-asset slice, sorted by usdValue desc. Unmapped assets have
       *  `usdValue: null`. */
      assets: Array<{
        assetId: string;
        amount: number;
        usdPerUnit: number | null;
        usdValue: number | null;
      }>;
      /** Asset IDs returned by Fireblocks that we have no mapping for.
       *  Excluded from `totalUsd` but listed so an operator notices. */
      unmappedAssetIds: string[];
      generatedAt: string;
    }
  | {
      state: "unconfigured";
    }
  | {
      state: "error";
      /** Short, safe message — endpoint + status only, no body. */
      message: string;
    };

/** Shape from CoinGecko's simple/price endpoint. */
type CoinGeckoPriceResponse = Record<string, { usd?: number }>;

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

/**
 * Fetch USD prices for the given CoinGecko IDs. Wrapped in its own
 * `unstable_cache` (60s) so multiple tile renders within a minute share
 * the same price lookup, AND the cache key is keyed on the full ID
 * list — adding a new asset to PRICED_ASSETS naturally invalidates the
 * cache the next time the new ID is requested.
 *
 * On failure returns an empty object — the caller then renders priced
 * assets as "unpriced", which is degraded but still useful (the tile
 * still shows native amounts).
 */
async function fetchCoinGeckoPricesUncached(
  ids: string[],
): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const idsParam = ids.join(",");
  const url = `${COINGECKO_BASE}/simple/price?ids=${encodeURIComponent(
    idsParam,
  )}&vs_currencies=usd`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn(
        `[fireblocks-balance] CoinGecko ${res.status} for ${ids.length} ids`,
      );
      return {};
    }
    const raw = (await res.json()) as CoinGeckoPriceResponse;
    const out: Record<string, number> = {};
    for (const [cgId, body] of Object.entries(raw)) {
      const px = body?.usd;
      if (typeof px === "number" && Number.isFinite(px) && px > 0) {
        out[cgId] = px;
      }
    }
    return out;
  } catch {
    console.warn("[fireblocks-balance] CoinGecko fetch failed");
    return {};
  }
}

/**
 * Cached CoinGecko price lookup. Keyed on the sorted ID list so two
 * vault snapshots that need the same coins share one upstream call.
 * 60s revalidate matches the tile's refresh cadence — there's no point
 * pricing more often than we render.
 */
const cachedCoinGeckoPrices = unstable_cache(
  async (ids: string[]) => fetchCoinGeckoPricesUncached(ids),
  ["coingecko-prices-v1"],
  { revalidate: 60, tags: ["fireblocks-vault"] },
);

/**
 * The actual aggregate fetch + USD math. Pulled out of the public
 * accessor so the unstable_cache wrapper sees a stable arg list.
 */
async function buildVaultSnapshotUncached(): Promise<FireblocksVaultSnapshot> {
  if (!fireblocksConfigured()) {
    return { state: "unconfigured" };
  }

  let balances;
  try {
    balances = await getAllVaultBalances();
  } catch (err) {
    if (err instanceof FireblocksError) {
      // err.status + err.endpoint are safe; err.message is constructed
      // by FireblocksError to be safe (no body, no key, no JWT).
      return {
        state: "error",
        message:
          err.status === 0
            ? `${err.endpoint} failed`
            : `${err.endpoint} returned ${err.status}`,
      };
    }
    return { state: "error", message: "Vault fetch failed" };
  }

  // 1. Figure out which CoinGecko IDs we need to price (only non-stable
  //    assets we have a mapping for; stables short-circuit to 1.00).
  const needsPricing = balances
    .map((b) => b.assetId)
    .filter((id) => !STABLE_ASSETS.has(id) && Boolean(PRICED_ASSETS[id]));
  const cgIds = coinGeckoIdsFor(needsPricing);
  const cgPrices = await cachedCoinGeckoPrices(cgIds);

  // 2. Compute USD per row + roll up the grand total.
  let totalUsd = 0;
  const unmapped: string[] = [];
  const assets = balances.map((b) => {
    const usdPerUnit = resolveUsdPerUnit(b.assetId, cgPrices);
    const usdValue =
      usdPerUnit !== null ? b.totalNum * usdPerUnit : null;
    if (usdValue === null) {
      // Mapped but priceless (CoinGecko returned nothing), or fully
      // unmapped. Track unmapped separately so the UI can surface them.
      if (!PRICED_ASSETS[b.assetId] && !STABLE_ASSETS.has(b.assetId)) {
        unmapped.push(b.assetId);
      }
    } else {
      totalUsd += usdValue;
    }
    return {
      assetId: b.assetId,
      amount: b.totalNum,
      usdPerUnit,
      usdValue,
    };
  });

  // 3. Sort: priced rows desc by USD, then unmapped rows trailing.
  assets.sort((a, b) => {
    if (a.usdValue === null && b.usdValue === null) {
      return a.assetId.localeCompare(b.assetId);
    }
    if (a.usdValue === null) return 1;
    if (b.usdValue === null) return -1;
    return b.usdValue - a.usdValue;
  });

  return {
    state: "ok",
    totalUsd,
    assets,
    unmappedAssetIds: unmapped,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Public accessor. Cached for 60s under the `fireblocks-vault` tag so
 * a future server action can call `revalidateTag("fireblocks-vault")`
 * to force a refresh if needed.
 */
export const getFireblocksVaultSnapshot = unstable_cache(
  buildVaultSnapshotUncached,
  ["fireblocks-vault-usd-v1"],
  { revalidate: 60, tags: ["fireblocks-vault"] },
);
