import type { CreatorDealResponse } from "@/lib/backend-api";

/**
 * Canonical creator-deal economics — the SINGLE source of truth for how a
 * deal costs the house and how much wager it needs to break even. Every
 * surface (Profitability Active + Past Deals, the dashboard "4 Weeks" tiles,
 * roster deal-value, the forecast tab, compare, the profitable-algo help
 * text) MUST route its cost math through here so the numbers reconcile.
 *
 * ─── The owner's rule (2026-07-05, worked example reconciled to the cent) ──
 * A "deal" is a LEADERBOARD FRAME: the frame window is the leaderboard's
 * [start, end], so the deal length = the leaderboard length (weekly or
 * bi-weekly). Inside that window sit the weekly fill-deals (≈ one per week);
 * a deal that starts a day early or ends a day late still counts (any overlap
 * with the frame counts it in).
 *
 *   dealCost = Σ over the weekly deals in the frame of
 *                ( FULL withdraw cap                                 // not the used amount
 *                  + (tip/stream + sponsor/stream) × fills_allowed ) // per-stream caps recur per fill
 *              + leaderboard net prize × stored house-share %
 *   expectedWager = dealCost / 7.5%                                  // house value rate
 *
 * There is NO separate per-fill / daily-fill cost — the withdraw cap already
 * bounds the house's fill exposure, so adding a fill leg double-counts.
 *
 * Worked example (a 2-week frame = two identical weekly deals, $2,000 LB):
 *   cap        = 2 × $2,250          = $4,500
 *   tip+sponsor= 2 × ($10 + $20) × 7 = $420
 *   leaderboard= $2,000 × 50%        = $1,000
 *   dealCost   = $5,920  →  expectedWager = $5,920 / 0.075 = $78,933.33
 *
 * This module is pure math (no DB, no `server-only`) so client components
 * (the profitable-algo calculator) can import the constants too.
 */

/** House value generated per $ wagered. `expectedWager = dealCost / HOUSE_EDGE`. */
export const HOUSE_EDGE = 0.075;

/** Explicit 50/50 modeling assumption used only by opt-in calculators. */
export const LB_HOUSE_SHARE = 0.5;

/** Missing admin sponsorship annotations mean the house funds the full pool. */
export const DEFAULT_LB_HOUSE_SHARE_PCT = 100;

export function normalizeLeaderboardHouseSharePct(
  value: string | number | null | undefined,
  fallback = DEFAULT_LB_HOUSE_SHARE_PCT,
): number {
  if (value == null || value === "") return fallback;
  const pct = typeof value === "number" ? value : Number(value);
  return Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : fallback;
}

/** Coerce a backend string|number|null money field to a finite number (0 fallback). */
export function toFiniteNumber(
  value: string | number | null | undefined,
): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * House cost of a single leaderboard prize pool, weighted by its house share.
 * The one place LB house cost is defined — use it everywhere (deal cost AND the
 * standalone Leaderboard-Spend figures) so a board's LB cost is identical
 * across the app. Replaces the old admin per-board "sponsored %" (which
 * defaulted to 100% for un-annotated boards and over-counted).
 */
export function leaderboardHouseCost(
  prizeUsd: string | number | null | undefined,
  refundUsd: string | number | null | undefined = 0,
  houseSharePct: string | number | null | undefined =
    DEFAULT_LB_HOUSE_SHARE_PCT,
): number {
  const net = Math.max(0, toFiniteNumber(prizeUsd) - toFiniteNumber(refundUsd));
  return net * (normalizeLeaderboardHouseSharePct(
    houseSharePct,
    DEFAULT_LB_HOUSE_SHARE_PCT,
  ) / 100);
}

/**
 * The weekly withdraw-cap + tip/sponsor cost of ONE weekly fill-deal (NO
 * leaderboard leg — the LB is per-frame, added once by {@link computeDealCost}).
 *
 *   full withdraw cap + (tip/stream + sponsor/stream) × fills_allowed
 */
export function weeklyDealTermCost(deal: CreatorDealResponse): number {
  const cap = toFiniteNumber(deal.total_withdraw_cap_usd);
  const tip = toFiniteNumber(deal.max_tip_per_stream_usd);
  const sponsor = toFiniteNumber(deal.max_sponsorship_per_stream_usd);
  const fills = Math.max(0, deal.fills_allowed ?? 0);
  return cap + (tip + sponsor) * fills;
}

/**
 * The weekly fill-deals whose window overlaps a frame `[frameStartMs, frameEndMs]`.
 * ANY overlap counts (handles the "started a day early / ended a day late"
 * fuzz the owner described). Deals with unparseable dates are dropped.
 */
export function weeklyDealsInFrame(
  frameStartMs: number,
  frameEndMs: number,
  deals: CreatorDealResponse[],
  approvalRequestId?: string | null,
): CreatorDealResponse[] {
  return deals.filter((d) => {
    const ds = Date.parse(d.week_start_utc);
    const de = Date.parse(d.week_end_utc);
    if (!Number.isFinite(ds) || !Number.isFinite(de)) return false;
    if (Math.min(frameEndMs, de) <= Math.max(frameStartMs, ds)) return false;
    if (approvalRequestId == null) return true;
    if (d.terms == null || typeof d.terms !== "object") return false;
    return (d.terms as Record<string, unknown>).creator_approval_request_id
      === approvalRequestId;
  });
}

/** The itemized cost of a deal frame + the wager it needs to break even. */
export type DealCost = {
  /** Σ full withdraw cap over the frame's weekly deals. */
  capUsd: number;
  /** Σ (tip/stream + sponsor/stream) × fills over the frame's weekly deals. */
  tipSponsorUsd: number;
  /** Leaderboard net prize × the supplied house share. */
  leaderboardUsd: number;
  /** capUsd + tipSponsorUsd + leaderboardUsd. */
  dealCost: number;
  /** dealCost / HOUSE_EDGE — wager needed for the deal to pay for itself. */
  expectedWager: number;
};

/**
 * Canonical deal cost for a leaderboard frame, per the owner's rule.
 *
 * @param weeklyDeals the weekly fill-deals inside the frame (see
 *        {@link weeklyDealsInFrame}); their FULL caps + tip/sponsor allowances
 *        are summed.
 * @param lbPrizeUsd the frame's leaderboard total prize (net of `lbRefundUsd`).
 */
export function computeDealCost(args: {
  weeklyDeals: CreatorDealResponse[];
  lbPrizeUsd: string | number | null | undefined;
  lbRefundUsd?: string | number | null | undefined;
  lbHouseSharePct?: string | number | null | undefined;
}): DealCost {
  let capUsd = 0;
  let tipSponsorUsd = 0;
  for (const d of args.weeklyDeals) {
    capUsd += toFiniteNumber(d.total_withdraw_cap_usd);
    const tip = toFiniteNumber(d.max_tip_per_stream_usd);
    const sponsor = toFiniteNumber(d.max_sponsorship_per_stream_usd);
    const fills = Math.max(0, d.fills_allowed ?? 0);
    tipSponsorUsd += (tip + sponsor) * fills;
  }
  const leaderboardUsd = leaderboardHouseCost(
    args.lbPrizeUsd,
    args.lbRefundUsd,
    args.lbHouseSharePct,
  );
  const dealCost = capUsd + tipSponsorUsd + leaderboardUsd;
  const expectedWager = HOUSE_EDGE > 0 ? dealCost / HOUSE_EDGE : 0;
  return { capUsd, tipSponsorUsd, leaderboardUsd, dealCost, expectedWager };
}
