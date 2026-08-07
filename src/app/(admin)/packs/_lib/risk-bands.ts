/**
 * PURE, dependency-free per-pack RISK LEVERAGE bands (owner-lens §4 / Pattern
 * 6): the CV band a pack's retune should stay inside so the catalog's designed
 * spread of tight / spicy / coin-flip products doesn't silently converge to
 * mid-variance mush (54/183 plans flipped tier, overwhelmingly downward).
 *
 * CV (coefficient of variation of the payout) is a DERIVED OUTPUT of the shaped
 * pool — it appears in no solver constraint and no scorer tier. Putting it in
 * the lexicographic scorer would re-order golden fixtures fleet-wide and fight
 * the tag/edge/nice tiers it must never outrank. So this module is a POST-CHECK
 * only: the planner computes the band, compares the landed CV/tier against it,
 * and BADGES a band exit (never blocks the push — the risk tier is a product
 * decision the owner makes knowingly).
 *
 * Side-effect-free + DB-free so the `packs/__checks__/` harness can pin it via
 * `npx tsx`.
 */

/**
 * Lottery (tagged) CV law (ruleset §1.2): a binary win-or-dust product's CV
 * scales as `k · sqrt((1−t)/t)` in its tag hit-rate `t`. The k-band is
 * fleet-calibrated (live tag-law k medians 1.29/1.12/1.27 across 1%/5%/10%;
 * p10–p90 span 0.85–2.27) — [0.9, 1.8] covers the designed envelope while the
 * widen-to-live guard below carries the owner's deliberate hot-runners.
 */
const TAG_CV_K_LO = 0.9;
const TAG_CV_K_HI = 1.8;

/**
 * Standard (untagged) CV bands by price bracket — the live-fleet p10–p90 of CV
 * within each bracket (183 pools, 2026-07-03). The first bracket a pack's price
 * is strictly BELOW wins (so `maxPrice` is an exclusive upper edge).
 */
const STANDARD_CV_BANDS: readonly {
  maxPrice: number;
  lo: number;
  hi: number;
}[] = [
  { maxPrice: 5, lo: 1.1, hi: 5.7 },
  { maxPrice: 25, lo: 1.2, hi: 3.5 },
  { maxPrice: 100, lo: 1.0, hi: 3.2 },
  { maxPrice: Infinity, lo: 0.8, hi: 2.5 },
];

/** How much (15%) headroom the widen-to-live guard adds around the live CV. */
const RISK_BAND_LIVE_HEADROOM = 0.15;

export type RiskBand = {
  /** Band lower edge (CV). */
  lo: number;
  /** Band upper edge (CV). */
  hi: number;
  /** Which law supplied the base band. */
  source: "tag-law" | "fleet-bracket";
  /** TRUE when the base band was widened to include the pack's live CV. */
  widenedToLive: boolean;
};

/**
 * The per-pack CV leverage band. For a TAGGED pack the lottery CV law gives the
 * base band; for an untagged pack the fleet price-bracket band does. Either way
 * the band is then WIDENED to include the pack's live CV (±15% headroom) — the
 * owner's deliberate outliers (e.g. a live 10%-tag pack at CV ≈ 8.7 vs the
 * tag-law 2.85–5.70) define their OWN leverage; a retune must never force a
 * tier change as a side effect. `widenedToLive` records when that happened.
 *
 * Pure + sync. NaN-/degenerate-safe: a non-finite / non-positive live CV skips
 * the widen (the base band stands).
 */
export function packRiskBand(input: {
  tag: number | null;
  price: number;
  liveCv: number;
}): RiskBand {
  let lo: number;
  let hi: number;
  let source: RiskBand["source"];
  if (input.tag !== null && input.tag > 0 && input.tag < 1) {
    const s = Math.sqrt((1 - input.tag) / input.tag);
    lo = TAG_CV_K_LO * s;
    hi = TAG_CV_K_HI * s;
    source = "tag-law";
  } else {
    const b =
      STANDARD_CV_BANDS.find(
        (x) => Number.isFinite(input.price) && input.price < x.maxPrice,
      ) ?? STANDARD_CV_BANDS[STANDARD_CV_BANDS.length - 1]!;
    lo = b.lo;
    hi = b.hi;
    source = "fleet-bracket";
  }
  // WIDEN TO LIVE: the owner's deliberate leverage defines the band — never
  // force a tier flip as a retune side effect.
  const liveCv = Number.isFinite(input.liveCv) && input.liveCv > 0 ? input.liveCv : 0;
  const widened =
    liveCv > 0 &&
    (liveCv * (1 - RISK_BAND_LIVE_HEADROOM) < lo ||
      liveCv * (1 + RISK_BAND_LIVE_HEADROOM) > hi);
  if (liveCv > 0) {
    lo = Math.min(lo, liveCv * (1 - RISK_BAND_LIVE_HEADROOM));
    hi = Math.max(hi, liveCv * (1 + RISK_BAND_LIVE_HEADROOM));
  }
  return { lo, hi, source, widenedToLive: widened };
}

/**
 * TRUE when a landed CV sits OUTSIDE the band (a small epsilon absorbs snap
 * rounding at the edges). The planner badges this; it never blocks the push.
 */
export function isRiskBandExit(cv: number, band: RiskBand): boolean {
  if (!Number.isFinite(cv) || cv <= 0) return false;
  return cv < band.lo - 1e-9 || cv > band.hi + 1e-9;
}
