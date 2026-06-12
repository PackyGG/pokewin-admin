import "server-only";

import { backendApi } from "./client";

/**
 * Crypto deposit/withdrawal exchange-rate fee admin API.
 *
 * Per coin and per direction (deposit / withdrawal) the backend can apply a
 * hidden exchange-rate fee: an on/off toggle plus a min/max range in basis
 * points (0..500 = 0–5%). Each transaction rolls a random integer fee in
 * [min_bps, max_bps]. Deposits credit at price × (1 − fee); withdrawals send
 * at price × (1 + fee). Backend defaults: 35–45 bps (0.35–0.45%), disabled.
 *
 * Source of truth (request/response shapes):
 *   packy-backend/src/routes/v1/admin/crypto-fees.ts
 *
 * `backendApi`'s base URL already includes `/v1`, so paths are `/admin/...`.
 * Errors surface as BackendApiError / BackendNetworkError — callers degrade
 * gracefully (the /security card renders an "awaiting backend deploy" state
 * until the backend branch ships).
 */

// All 11 supported assets — GET always returns every one of them. The
// list lives in crypto-fees-assets.ts (no "server-only") so the client
// card can import the runtime constant; re-exported here for server
// consumers (page + action).
export {
  CRYPTO_FEE_ASSETS,
  type CryptoFeeAsset,
} from "./crypto-fees-assets";
import type { CryptoFeeAsset } from "./crypto-fees-assets";

/** One coin+direction config. bps are ints in 0..500 (100 bps = 1%). */
export type CryptoFeeConfig = {
  enabled: boolean;
  min_bps: number;
  max_bps: number;
};

/** Full GET shape: both directions, always all 11 assets present. */
export type CryptoFees = {
  deposit: Record<CryptoFeeAsset, CryptoFeeConfig>;
  withdrawal: Record<CryptoFeeAsset, CryptoFeeConfig>;
};

/**
 * Partial-update payload for the PUT. At least one value (across any
 * direction/asset) must be present — the backend rejects an empty body, and
 * 400s if a merged pair would end up with min_bps > max_bps.
 */
export type UpdateCryptoFeesInput = {
  deposit?: Partial<Record<CryptoFeeAsset, Partial<CryptoFeeConfig>>>;
  withdrawal?: Partial<Record<CryptoFeeAsset, Partial<CryptoFeeConfig>>>;
};

type Success<T> = { success: boolean; data: T };

export const getCryptoFees = () =>
  backendApi.get<Success<CryptoFees>>("/admin/crypto-fees").then((r) => r.data);

export const updateCryptoFees = (input: UpdateCryptoFeesInput) =>
  backendApi
    .put<Success<CryptoFees>>("/admin/crypto-fees", input)
    .then((r) => r.data);
