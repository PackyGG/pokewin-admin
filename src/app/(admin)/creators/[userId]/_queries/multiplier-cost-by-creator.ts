import "server-only";

import { unstable_cache } from "next/cache";

import {
  multiplierDealsApi,
  type MultiplierDealResponse,
} from "@/lib/backend-api";
import { CREATOR_COST_CACHE_TTL_SECONDS } from "./_cost-cache";

// Backend caps `limit`; 100 per page mirrors the other creator walks. A
// single creator with >100 multiplier deals is implausible, but
// MAX_PAGES guards a runaway loop if `total` is ever reported wrong.
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export type CreatorMultiplierCost = {
  /**
   * Net house cost the multiplier program has booked against this
   * creator, House-POV. Built from the same money the backend ledger
   * records as `creator_multiplier_payout` (the withdrawable payout
   * voucher) plus the net `creator_fill_*` lifecycle (platform credit
   * funded minus the unspent fill refunded back):
   *
   *   payoutUsd = Σ withdrawable_voucher_usd        (settled deals)
   *   netFillUsd = Σ (platform_funding_usd − fill_refunded_usd)
   *   costUsd   = payoutUsd + netFillUsd
   *
   * `platform_funding_usd` is the house-credit injected at activation
   * (the multiplier inflation, `creator_fill_activation`); the unspent
   * remainder is returned (`creator_fill_refund`), so subtracting
   * `fill_refunded_usd` leaves only the fill the house actually ate.
   * The payout voucher is the separate end-of-stream `creator_multiplier_
   * payout`. Both are house costs → the caller renders them rose.
   */
  costUsd: number;
  /** Withdrawable payout vouchers issued at settlement (`creator_multiplier_payout`). */
  payoutUsd: number;
  /** Net house fill funded across deals (`creator_fill_activation` − `creator_fill_refund`). */
  netFillUsd: number;
  /** Total deals seen (any status) — context for the metric. */
  dealCount: number;
};

function num(v: string | null): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Per-creator multiplier-deal house cost — the `creator_multiplier_
 * payout` + net `creator_fill_*` outflow, summed from the backend's
 * multiplier-deal records for this creator.
 *
 * Reuses the existing `multiplierDealsApi.list` (the same source the
 * creator detail page already pulls the multiplier deals from) and
 * walks every page so the aggregate covers the creator's full history,
 * not just the 25-row page-1 slice the deal list renders.
 *
 * Best-effort by design: the caller (a Suspense'd panel) catches
 * failures and renders the metric in its empty state.
 */
async function computeCreatorMultiplierCost(
  creatorUserId: string,
): Promise<CreatorMultiplierCost> {
  const firstPage = await multiplierDealsApi.list(creatorUserId, {
    offset: 0,
    limit: PAGE_SIZE,
  });

  const all: MultiplierDealResponse[] = [...firstPage.data];
  const pagesNeeded = Math.min(
    MAX_PAGES,
    Math.ceil(firstPage.total / PAGE_SIZE),
  );
  const rest: Promise<typeof firstPage>[] = [];
  for (let p = 1; p < pagesNeeded; p++) {
    rest.push(
      multiplierDealsApi.list(creatorUserId, {
        offset: p * PAGE_SIZE,
        limit: PAGE_SIZE,
      }),
    );
  }
  for (const page of await Promise.all(rest)) {
    all.push(...page.data);
  }

  let payoutUsd = 0;
  let netFillUsd = 0;
  for (const d of all) {
    // Payout voucher is only set once a deal settles with a withdrawable
    // amount; null on offers / forfeited deals → contributes 0.
    payoutUsd += num(d.withdrawable_voucher_usd);
    // Net house fill = credit injected at activation minus the unspent
    // remainder refunded back. platform_funding_usd is null pre-
    // activation → 0.
    netFillUsd += num(d.platform_funding_usd) - num(d.fill_refunded_usd);
  }

  // Net fill can't go below zero (a deal can't refund more than was
  // funded), but clamp defensively so a backend data quirk can't render
  // a negative "cost".
  if (netFillUsd < 0) netFillUsd = 0;

  return {
    costUsd: payoutUsd + netFillUsd,
    payoutUsd,
    netFillUsd,
    dealCount: all.length,
  };
}

// Cached per creator id — the cost is a lifetime aggregate over every
// multiplier deal this creator has, built from a paginated backend walk. A
// few-minutes TTL stops repeat loads / "Refresh to retry" from re-walking
// every page. The backend client resolves env via the same cookie→prod
// fallback as getDb() inside an unstable_cache scope (see `_cost-cache.ts`).
// A thrown error is NOT cached, so the caller's best-effort `.catch()` still
// degrades the lines on a real failure.
const cachedCreatorMultiplierCost = unstable_cache(
  computeCreatorMultiplierCost,
  ["creators-detail-multiplier-cost-v1"],
  { revalidate: CREATOR_COST_CACHE_TTL_SECONDS },
);

export async function getCreatorMultiplierCost(
  creatorUserId: string,
): Promise<CreatorMultiplierCost> {
  return cachedCreatorMultiplierCost(creatorUserId);
}
