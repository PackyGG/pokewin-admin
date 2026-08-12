import "server-only";

import { getConvertedFromVouchersTotal } from "./converted-from-vouchers-total";
import { getWithdrawnFromConvertedTotal } from "./withdrawn-from-converted-total";

/**
 * Global figures for the /creators "Converted" KPI tile.
 *
 * ─── 2026-08-12: the backend roster walk was removed ──────────────────
 *
 * This module used to await `cachedCreatorGlobalCounts()` FIRST — a full
 * paginated `creatorsApi.list` walk (up to 50 backend round-trips) that
 * produced `totalCreators` / `fillCreatorCount` / `activeDealCount` /
 * `liveCount`. Not one of those four fields had a consumer anywhere in the
 * repo: `/creators/page.tsx` is the only caller and it reads exactly the
 * three voucher figures below. So the walk was computed and discarded.
 *
 * It was not merely wasted work, it was the tile's failure mode. Because it
 * was awaited as a SERIAL PREFIX and it THROWS on a backend outage, an
 * unreachable/slow backend made this whole read reject (or blow the page's
 * 10s budget) and the Converted tile rendered "—" plus a "backend
 * unavailable" hint — even though every number it displays comes from the
 * MAIN DB and was perfectly readable.
 *
 * The remaining two reads are Main-DB voucher aggregates that already run in
 * parallel and already catch their own failures, so this read now has NO
 * backend dependency at all. Displayed values are unchanged.
 */
export type CreatorsGlobalStats = {
  /**
   * Total "Converted" — combined value of the end-of-session payout
   * vouchers (`vouchers.origin = 'creator_fill_conversion'`) MINTED
   * across EVERY creator ever (LIFETIME, no active/scheduled-deal
   * filter): how much stream earnings have ever been converted into
   * payout vouchers (§2 of the creator model). Sourced from the Main-DB
   * `vouchers` table — the SAME voucher set the withdrawn sub-line reads
   * — NOT the backend deal's `withdraw_cap_used_usd` cap-consumption
   * counter (admin-mutable and per deal-version, the wrong source for a
   * minted-voucher figure). Best-effort — a query failure leaves this at
   * 0 rather than crashing the tile.
   */
  convertedTotal: number;
  /**
   * Of `convertedTotal` (payout vouchers minted from conversion), how
   * much has actually left the platform via a completed
   * card_withdrawal_requests row — LIFETIME, across every creator (same
   * unscoped lens as `convertedTotal`). Reads the SAME
   * `creator_fill_conversion` voucher set as `convertedTotal`, so
   * `withdrawn ≤ converted` holds by construction.
   */
  withdrawnFromConvertedTotal: number;
  /**
   * Same scope as `withdrawnFromConvertedTotal` (lifetime / all
   * creators), but for in-flight withdraw requests (pending / processing
   * / shipped) — i.e. already requested but not yet terminal.
   */
  withdrawPendingFromConvertedTotal: number;
};

export async function getCreatorsGlobalStats(): Promise<CreatorsGlobalStats> {
  // "Converted" — sum the MINTED `creator_fill_conversion` payout
  // vouchers across EVERY creator ever (LIFETIME, no active/scheduled-
  // deal filter — owner scope decision; §2 of the creator model). Single
  // Main-DB whole-table aggregate over the fixed origin. This is the real
  // money converted into payout vouchers, NOT the backend deal's
  // `withdraw_cap_used_usd` cap-consumption counter (admin-mutable, per
  // deal-version — the wrong source for a minted-voucher figure). A
  // failure leaves the total at 0 so the tile drops to "—" rather than
  // showing a wrong number.
  //
  // "Withdrawn from converted" runs in parallel — a second Main-DB
  // round-trip over the SAME voucher set (vouchers join
  // card_withdrawal_requests), same lifetime/all-creators scope. Sharing
  // the source guarantees `withdrawn ≤ converted`. A failure leaves the
  // breakdown at 0 so the tile still shows the converted total.
  const [convertedTotalResult, withdrawnTotalResult] = await Promise.all([
    getConvertedFromVouchersTotal().catch((err) => {
      console.error(
        "[creators-stats] converted-from-vouchers total query failed (tile renders 0):",
        err,
      );
      return 0;
    }),
    getWithdrawnFromConvertedTotal().catch((err) => {
      console.error(
        "[creators-stats] withdrawn-from-converted total query failed (sub-line hidden):",
        err,
      );
      return { withdrawnUsd: 0, withdrawPendingUsd: 0 };
    }),
  ]);
  const convertedTotal = convertedTotalResult;
  const withdrawnFromConvertedTotal = withdrawnTotalResult.withdrawnUsd;
  const withdrawPendingFromConvertedTotal =
    withdrawnTotalResult.withdrawPendingUsd;

  return {
    convertedTotal,
    withdrawnFromConvertedTotal,
    withdrawPendingFromConvertedTotal,
  };
}
