"use client";

import { CryptoFeesCard } from "@/app/(admin)/security/crypto-fees-card";
import {
  CRYPTO_FEE_ASSETS,
  type CryptoFeeAsset,
} from "@/lib/backend-api/crypto-fees-assets";
import type {
  CryptoFees,
  CryptoFeeConfig,
} from "@/lib/backend-api/crypto-fees";

/**
 * Static, representative crypto-fee config for the dev-only fixture: the
 * backend defaults (35–45 bps, disabled) for most coins, with a few rows
 * flipped on / widened so both Switch states and non-default % values
 * render.
 */
const defaults = (): CryptoFeeConfig => ({
  enabled: false,
  min_bps: 35,
  max_bps: 45,
});

const buildDirection = (
  overrides: Partial<Record<CryptoFeeAsset, CryptoFeeConfig>>,
): Record<CryptoFeeAsset, CryptoFeeConfig> => {
  const out = {} as Record<CryptoFeeAsset, CryptoFeeConfig>;
  for (const asset of CRYPTO_FEE_ASSETS) {
    out[asset] = overrides[asset] ?? defaults();
  }
  return out;
};

const FIXTURE_FEES: CryptoFees = {
  deposit: buildDirection({
    BTC: { enabled: true, min_bps: 35, max_bps: 45 },
    USDT_TRC20: { enabled: true, min_bps: 0, max_bps: 500 },
  }),
  withdrawal: buildDirection({
    ETH: { enabled: true, min_bps: 100, max_bps: 125 },
  }),
};

export function CryptoFeesFixtureClient() {
  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Populated (backend reachable)
        </h2>
        <CryptoFeesCard initial={FIXTURE_FEES} />
      </section>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Degraded (awaiting backend deploy)
        </h2>
        <CryptoFeesCard initial={null} />
      </section>
    </div>
  );
}
