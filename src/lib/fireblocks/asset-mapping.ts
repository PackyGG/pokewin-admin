/**
 * Fireblocks asset ID → CoinGecko ID mapping.
 *
 * Fireblocks names assets per-network (e.g. `USDC_POLYGON`, `USDT_TRX`),
 * but for treasury USD valuation we only care about the underlying coin.
 * Stablecoins short-circuit to 1.00 USD without ever touching the price
 * feed — that's both faster and more accurate than asking CoinGecko for
 * "stable to USD" prices.
 *
 * The list is intentionally NOT exhaustive. The vault page tolerates
 * unknown asset IDs: they're rendered with their native amount only,
 * excluded from the USD grand total, and surfaced as "unmapped" in the
 * call-site logs so an operator can request a mapping.
 *
 * To add a new asset:
 *   - If it's a stablecoin pegged to 1 USD → add to STABLE_ASSETS.
 *   - Otherwise → add to PRICED_ASSETS with the matching CoinGecko ID
 *     from https://api.coingecko.com/api/v3/coins/list.
 */

/**
 * Fireblocks asset IDs treated as 1.00 USD. The price feed is skipped
 * entirely for these — saves an API call and avoids transient mispriced
 * stables when CoinGecko has a hiccup.
 */
export const STABLE_ASSETS: ReadonlySet<string> = new Set([
  "USDC",
  "USDC_ETH",
  "USDC_POLYGON",
  "USDC_ARB",
  "USDC_BSC",
  "USDC_SOL",
  "USDC_AVAX",
  "USDC_BASE",
  "USDT",
  "USDT_ERC20",
  "USDT_TRX",
  "USDT_BSC",
  "USDT_POLYGON",
  "USDT_ARB",
  "USDT_SOL",
  "USDT_AVAX",
  "DAI",
  "BUSD",
  "USD",
]);

/**
 * Fireblocks asset ID → CoinGecko coin ID. Lower-case CoinGecko IDs are
 * required (their API is case-sensitive).
 *
 * Asset names verified against Fireblocks' "Asset list" reference:
 * https://developers.fireblocks.com/reference/supported-assets
 */
export const PRICED_ASSETS: Readonly<Record<string, string>> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  ETH_TEST5: "ethereum", // sepolia testnet — same price as mainnet for display
  ETH_ARB: "ethereum",
  ETH_BASE: "ethereum",
  ETH_OPT: "ethereum",
  SOL: "solana",
  MATIC_POLYGON: "matic-network",
  POL_POLYGON: "matic-network",
  BNB_BSC: "binancecoin",
  BNB_TEST_BSC: "binancecoin",
  AVAX: "avalanche-2",
  LTC: "litecoin",
  DOGE: "dogecoin",
  XRP: "ripple",
  TRX: "tron",
  BCH: "bitcoin-cash",
  ADA: "cardano",
  DOT: "polkadot",
  ATOM: "cosmos",
  NEAR: "near",
  XLM: "stellar",
  ALGO: "algorand",
};

export type AssetPriceLookup = (assetId: string) => number | null;

/**
 * Resolve a Fireblocks asset ID to USD per unit, or `null` if the asset
 * isn't mapped. Stablecoins return 1; priced assets defer to the supplied
 * price map (keyed by CoinGecko ID, e.g. `bitcoin → 95_000`).
 */
export function resolveUsdPerUnit(
  assetId: string,
  cgPrices: Record<string, number>,
): number | null {
  if (STABLE_ASSETS.has(assetId)) return 1;
  const cgId = PRICED_ASSETS[assetId];
  if (!cgId) return null;
  const price = cgPrices[cgId];
  return typeof price === "number" && Number.isFinite(price) ? price : null;
}

/**
 * Distinct CoinGecko IDs needed for a set of Fireblocks asset IDs. Used
 * by the price fetcher to build the `ids=` query string for CoinGecko's
 * /simple/price endpoint.
 */
export function coinGeckoIdsFor(assetIds: Iterable<string>): string[] {
  const ids = new Set<string>();
  for (const a of assetIds) {
    const cgId = PRICED_ASSETS[a];
    if (cgId) ids.add(cgId);
  }
  return [...ids].sort();
}
