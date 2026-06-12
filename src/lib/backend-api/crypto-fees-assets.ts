/**
 * Crypto-fee asset list shared by the server-only crypto-fees API module
 * and the client card on /security.
 *
 * This file is deliberately NOT "server-only": the card needs the runtime
 * constant to render one row per coin, and a VALUE import from
 * crypto-fees.ts would drag `import "server-only"` into the client bundle
 * and fail the build (type-only imports are erased, value imports are not).
 * Same rationale as the security/*-keys.ts plain-constant modules.
 *
 * Source of truth: packy-backend/src/routes/v1/admin/crypto-fees.ts —
 * GET always returns all 11 assets.
 */
export const CRYPTO_FEE_ASSETS = [
  "BTC",
  "ETH",
  "LTC",
  "SOL",
  "USDT_ERC20",
  "USDT_TRC20",
  "USDT_SOL",
  "USDC_ERC20",
  "USDC_SOL",
  "DOGE",
  "XRP",
] as const;

export type CryptoFeeAsset = (typeof CRYPTO_FEE_ASSETS)[number];
