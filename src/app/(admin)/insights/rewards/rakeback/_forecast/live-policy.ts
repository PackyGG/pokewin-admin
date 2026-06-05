/**
 * live-policy.ts — derive the rakeback forecast's BASELINE + what-if scenarios
 * from the REAL production rakeback policy (`rakeback_config`), instead of the
 * fabricated "flat 5% / Flat 3–7%" placeholders.
 *
 * WHY this exists
 * ───────────────
 * The real rakeback policy is THREE per-cadence programs, each a small % of
 * wager with its own expiry (e.g. daily 0.25% · weekly 0.1% · monthly 0.05%) —
 * NOT a single flat 5%. The owner caught the forecast modeling a flat 5%
 * headline that is ~20× the truth. The fix: the BASELINE scenario must describe
 * the REAL per-cadence policy, and the what-ifs must be realistic moves around
 * those REAL rates (trim a cadence's %, drop a cadence, shift cadence, change
 * expiry) — not a flat 3–7% gradient.
 *
 * HOW it threads the real config (read-only, request-time)
 * ────────────────────────────────────────────────────────
 * The server tab fetches `getRakebackConfigs()` (read-only, runs server-side at
 * request time) and attaches the per-cadence rows onto the `ForecastBaseline`
 * via the `cadenceConfig` extension field (the same serialization trick the
 * existing `blendedRate` / `totalWager` extensions use — extra plain props
 * survive the RSC boundary). `buildRakebackScenarios(baseline)` reads that and
 * builds the live scenario library.
 *
 * HOW the engine stays faithful (anchored cost + real blended rate)
 * ─────────────────────────────────────────────────────────────────
 * The engine cost is `wager × blendedEffectiveRate × (1 − breakage)`, ANCHORED
 * by `simulateSet` so the BASELINE scenario reproduces the real total cost
 * EXACTLY. A scenario's cost therefore scales with its blended effective rate
 * relative to the baseline's. We express the policy's rate axis as the REAL
 * HEADLINE RAKEBACK RATE (the sum of the enabled cadences' %s — what a user can
 * earn across all cadences), mapped into the engine's blended-rate units:
 *
 *   modeledRate(variant) = baselineBlendedRate × (variantHeadline / realHeadline)
 *
 * so the BASELINE (variantHeadline == realHeadline) models exactly
 * `baselineBlendedRate` → tightness 0 → savings 0 → anchored on the real total,
 * and every what-if's modeled rate moves in lock-step with how it changes the
 * real headline rate. Cadence / expiry variants additionally route through the
 * engine's `cadence_gated` / `expiry_capped` breakage channels.
 *
 * Everything here is PURE + serializable (plain `ScenarioConfig` objects), so it
 * round-trips the RSC boundary and feeds straight into `simulate()`.
 */

import type { ForecastBaseline } from "../../../_forecast-engine";
import { BASELINE_RATE_FALLBACK } from "./constants";
import type { ClaimCadence, ScenarioConfig } from "./types";

/** One real `rakeback_config` row, narrowed to what the forecast needs. */
export type RakebackCadenceConfig = {
  /** Claim cadence — the `rakeback_config.type` (daily / weekly / monthly). */
  cadence: ClaimCadence;
  /** Rate as a decimal fraction of wager (e.g. 0.0025 = 0.25%). */
  rate: number;
  /** Days of unclaimed accrual before it expires (`expiration_days`). */
  expiryDays: number;
  /** Whether this cadence is currently enabled. */
  enabled: boolean;
};

/**
 * The rakeback real-config extension fields the server tab attaches onto the
 * `ForecastBaseline`. `blendedRate` / `totalWager` already ride along for the
 * engine's `defaults`; `cadenceConfig` is the per-cadence real policy this
 * module reads to build the live scenarios.
 */
export type RakebackBaselineExt = ForecastBaseline & {
  blendedRate?: number;
  totalWager?: number;
  cadenceConfig?: RakebackCadenceConfig[];
};

/** Canonical cadence display order (fastest → slowest). */
const CADENCE_ORDER: ClaimCadence[] = ["daily", "weekly", "monthly"];

/** Title-case a cadence for labels ("daily" → "Daily"). */
function cadenceLabel(c: ClaimCadence): string {
  return c.charAt(0).toUpperCase() + c.slice(1);
}

/** Format a 0-1 rate fraction as a percent-of-wager string, e.g. 0.0025 → "0.25%". */
function pct(rate: number): string {
  const v = rate * 100;
  if (v === 0) return "0%";
  // Rakeback rates are tiny (sub-1%); show up to 3 decimals, trimmed.
  const s = v.toFixed(3).replace(/\.?0+$/, "");
  return `${s}%`;
}

/** Sort + sanitize the raw config rows into canonical cadence order. */
function orderedCadences(cfg: RakebackCadenceConfig[]): RakebackCadenceConfig[] {
  return CADENCE_ORDER.map((c) => cfg.find((r) => r.cadence === c)).filter(
    (r): r is RakebackCadenceConfig => r != null,
  );
}

/**
 * The REAL HEADLINE rakeback rate = the sum of the ENABLED cadences' rates (the
 * total fraction of wager a user can earn across every active cadence). This is
 * the number every what-if is measured against. 0 if nothing is enabled.
 */
export function realHeadlineRate(cfg: RakebackCadenceConfig[]): number {
  return cfg.filter((r) => r.enabled).reduce((a, r) => a + Math.max(0, r.rate), 0);
}

/**
 * A short "real baseline" note for the KPI strip, listing the enabled cadences
 * and their real rates, e.g. "Daily 0.25% · Weekly 0.1% · Monthly 0.05%".
 * Falls back to a generic blended-% note when no per-cadence config is present.
 */
export function rakebackBaselineNote(baseline: ForecastBaseline): string {
  const ext = baseline as RakebackBaselineExt;
  const cfg = ext.cadenceConfig ? orderedCadences(ext.cadenceConfig) : [];
  const enabled = cfg.filter((r) => r.enabled);
  if (enabled.length > 0) {
    return enabled.map((r) => `${cadenceLabel(r.cadence)} ${pct(r.rate)}`).join(" · ");
  }
  // No real config threaded → blended % of the measured rate (or the fallback).
  const rate = typeof ext.blendedRate === "number" && ext.blendedRate > 0 ? ext.blendedRate : BASELINE_RATE_FALLBACK;
  return `~${pct(rate)} blended`;
}

// ─── Multi-cadence helpers (combined daily+weekly+monthly what-ifs) ───────────

/**
 * Build a `multi_cadence` policy from the REAL per-cadence rates × a per-cadence
 * MULTIPLIER, RE-SCALED so the three modeled per-cadence rates sum to the
 * scenario's modeled blended rate.
 *
 * WHY the rescale: the engine reads a `multi_cadence` policy's effective rate as
 * the literal SUM of its three rates, while the live builder anchors every
 * scenario through `toModeled(headline)` (the measured blended rate scaled by
 * how the REAL headline moves). To keep that anchor — so the baseline reproduces
 * the real total and this scenario stays a coherent fraction of it — we map the
 * variant's real headline (Σ realRate×mult) into modeled units, then split THAT
 * across the three cadences in the same proportion as (realRate×mult). The sum
 * therefore equals the modeled blended rate (anchor-faithful), while the
 * per-cadence breakdown still renders in the policy column.
 *
 * @param enabled    the enabled real cadence rows (each `.cadence` + `.rate`)
 * @param mult       per-cadence multiplier (e.g. { daily: 0.8, weekly: 0.8, monthly: 0.8 })
 * @param toModeled  the live builder's real-headline → modeled-blended mapper
 */
function buildMultiCadencePolicy(
  enabled: RakebackCadenceConfig[],
  mult: Record<ClaimCadence, number>,
  toModeled: (variantHeadline: number) => number,
): { policy: Extract<ScenarioConfig["policy"], { kind: "multi_cadence" }>; realHeadline: number } {
  // Real per-cadence rate after the multiplier (0 for any cadence not enabled).
  const realRate: Record<ClaimCadence, number> = { daily: 0, weekly: 0, monthly: 0 };
  for (const r of enabled) {
    realRate[r.cadence] = Math.max(0, r.rate) * Math.max(0, mult[r.cadence] ?? 1);
  }
  const variantHeadline = realRate.daily + realRate.weekly + realRate.monthly;
  const modeledBlended = Math.max(0, toModeled(variantHeadline));
  // Split the modeled blended rate across cadences in proportion to realRate, so
  // Σ perCadenceRate == modeledBlended (anchor-faithful). Degenerate → all zero.
  const scale = variantHeadline > 0 ? modeledBlended / variantHeadline : 0;
  const perCadenceRate: Record<ClaimCadence, number> = {
    daily: realRate.daily * scale,
    weekly: realRate.weekly * scale,
    monthly: realRate.monthly * scale,
  };
  // Dominant settlement cadence: the fastest enabled cadence (daily > weekly >
  // monthly) — the breakage / pacing channel reads it.
  const dominantCadence: ClaimCadence = realRate.daily > 0 ? "daily" : realRate.weekly > 0 ? "weekly" : "monthly";
  return {
    policy: { kind: "multi_cadence", perCadenceRate, cadence: dominantCadence },
    realHeadline: variantHeadline,
  };
}

/**
 * A short per-cadence breakdown of the REAL (multiplier-applied) rates for a
 * multi-cadence scenario description, e.g. "Daily 0.2% · Weekly 0.08% · Monthly
 * 0.04%". Drops cadences that aren't enabled.
 */
function multiCadenceRealNote(enabled: RakebackCadenceConfig[], mult: Record<ClaimCadence, number>): string {
  return CADENCE_ORDER.filter((c) => enabled.some((r) => r.cadence === c))
    .map((c) => {
      const real = enabled.find((r) => r.cadence === c)!;
      return `${cadenceLabel(c)} ${pct(Math.max(0, real.rate) * Math.max(0, mult[c] ?? 1))}`;
    })
    .join(" · ");
}

// ─── Scenario builder ─────────────────────────────────────────────────────────

const SCHEMA = 1 as const;

/**
 * Build the LIVE rakeback scenario library from the real per-cadence policy on
 * the baseline. Returns `null` when no real per-cadence config was threaded (the
 * caller then falls back to the static library).
 *
 * The modeled rate axis is the real HEADLINE rate (Σ enabled cadence rates),
 * mapped into the engine's blended-rate units via the baseline measured blended
 * rate so the BASELINE reproduces the real total cost exactly (see file header).
 *
 * Scenario families (all anchored on the REAL rates):
 *   • Baseline       — the live policy, labeled with every enabled cadence + %.
 *   • Trim a cadence — halve the daily rate (the dominant cost driver).
 *   • Drop a cadence — disable the monthly (or smallest) cadence.
 *   • Daily-only     — keep only the daily cadence (drop weekly + monthly).
 *   • Cadence shift  — same headline rate but swept weekly / monthly (breakage).
 *   • Expiry change  — tighter / looser expiry on the daily accrual.
 *   • Multi-cadence  — change daily + weekly + monthly TOGETHER (all −20/−35/−50%,
 *                      daily/monthly-weighted, balanced trims) as ONE scenario,
 *                      with the per-cadence breakdown in the policy column.
 *   • Pre-claim      — the SAME baseline policy with the instant pre-claim model
 *                      on (cash out everything now at a discount).
 */
export function buildRakebackScenarios(
  baseline: ForecastBaseline,
): { scenarios: ScenarioConfig[]; whatifSet: ScenarioConfig[]; baselineScenarioId: string } | null {
  const ext = baseline as RakebackBaselineExt;
  const rawCfg = ext.cadenceConfig;
  if (!rawCfg || rawCfg.length === 0) return null;

  const cfg = orderedCadences(rawCfg);
  const enabled = cfg.filter((r) => r.enabled);
  if (enabled.length === 0) return null;

  const headline = realHeadlineRate(cfg);
  if (!(headline > 0)) return null;

  // The engine reference rate. Prefer the REAL measured blended rate (the anchor
  // the baseline reproduces); fall back to the headline itself if absent.
  const baselineBlended =
    typeof ext.blendedRate === "number" && ext.blendedRate > 0 ? ext.blendedRate : headline;

  // Map a "variant headline rate" into the engine's blended-rate units so the
  // baseline (== headline) models exactly the measured blended rate.
  const toModeled = (variantHeadline: number): number =>
    baselineBlended * (headline > 0 ? variantHeadline / headline : 1);

  // The cadence carrying the LARGEST enabled rate (the dominant cost driver) and
  // the SMALLEST (the cheapest to drop). Used to scope the realistic what-ifs.
  const byRateDesc = [...enabled].sort((a, b) => b.rate - a.rate);
  const dominant = byRateDesc[0];
  const smallest = byRateDesc[byRateDesc.length - 1];

  // Representative expiry for the modeled daily accrual = the daily cadence's
  // real expiry when present, else the dominant cadence's.
  const dailyCfg = enabled.find((r) => r.cadence === "daily") ?? dominant;
  const realDailyExpiry = Math.max(1, Math.round(dailyCfg.expiryDays));

  const enabledList = enabled.map((r) => `${cadenceLabel(r.cadence)} ${pct(r.rate)}`).join(" · ");

  // ── A · Baseline — the REAL current policy ──
  const baselineScenario: ScenarioConfig = {
    id: "A-baseline",
    label: "A · Current policy",
    description: `The live rakeback policy: ${enabledList} of wager (headline ${pct(headline)} across cadences). The reference every other scenario is measured against — savings vs baseline = 0; cost anchors to the real total.`,
    // Model the baseline at the measured blended rate on the dominant cadence so
    // tightness is 0 and the anchor reproduces the real cost exactly.
    policy: { kind: "flat_rate", rate: baselineBlended, cadence: dominant.cadence },
    schemaVersion: SCHEMA,
  };

  const scenarios: ScenarioConfig[] = [baselineScenario];
  const whatifSet: ScenarioConfig[] = [baselineScenario];

  // ── B · Trim the dominant cadence rate −25% / −50% ──
  // Trimming the biggest cadence's % is the highest-leverage realistic cut.
  for (const [cutLabel, cutFrac] of [
    ["−25%", 0.25],
    ["−50%", 0.5],
  ] as const) {
    const newDominantRate = dominant.rate * (1 - cutFrac);
    const newHeadline = headline - dominant.rate + newDominantRate;
    const sc: ScenarioConfig = {
      id: `B-trim-${dominant.cadence}-${Math.round(cutFrac * 100)}`,
      label: `B · ${cadenceLabel(dominant.cadence)} ${cutLabel}`,
      description: `Trim the ${dominant.cadence} rate ${cutLabel} (${pct(dominant.rate)} → ${pct(newDominantRate)}); other cadences unchanged. Headline ${pct(headline)} → ${pct(newHeadline)}. The single highest-leverage cut — the ${dominant.cadence} cadence carries the most cost.`,
      policy: { kind: "flat_rate", rate: toModeled(newHeadline), cadence: dominant.cadence },
      schemaVersion: SCHEMA,
    };
    scenarios.push(sc);
    whatifSet.push(sc);
  }

  // ── C · Drop the smallest cadence (when >1 cadence is live) ──
  if (enabled.length > 1) {
    const newHeadline = headline - smallest.rate;
    const sc: ScenarioConfig = {
      id: `C-drop-${smallest.cadence}`,
      label: `C · Drop ${smallest.cadence}`,
      description: `Disable the ${smallest.cadence} cadence (${pct(smallest.rate)}); keep the others. Headline ${pct(headline)} → ${pct(newHeadline)}. Retires the smallest, lowest-impact rebate stream.`,
      policy: { kind: "flat_rate", rate: toModeled(newHeadline), cadence: dominant.cadence },
      schemaVersion: SCHEMA,
    };
    scenarios.push(sc);
    whatifSet.push(sc);
  }

  // ── C · Daily-only (drop every non-daily cadence) ──
  // Only meaningful when there IS a daily cadence and at least one other.
  const dailyEnabled = enabled.find((r) => r.cadence === "daily");
  if (dailyEnabled && enabled.length > 1) {
    const newHeadline = dailyEnabled.rate;
    const sc: ScenarioConfig = {
      id: "C-daily-only",
      label: "C · Daily only",
      description: `Keep only the daily cadence (${pct(dailyEnabled.rate)}); drop weekly + monthly. Headline ${pct(headline)} → ${pct(newHeadline)}. The leanest single-stream policy — simplest to operate, biggest direct cost cut.`,
      policy: { kind: "flat_rate", rate: toModeled(newHeadline), cadence: "daily" },
      schemaVersion: SCHEMA,
    };
    scenarios.push(sc);
  }

  // ── D · Cadence shift — same headline rate, swept to a slower cadence ──
  // Holds the gross accrual fixed but routes it through a slower claim cadence,
  // so MORE lapses unclaimed (higher breakage) → lower realized cost, at more
  // claim friction. Models the breakage channel, not a rate change.
  for (const target of ["weekly", "monthly"] as ClaimCadence[]) {
    if (dominant.cadence === target) continue;
    const sc: ScenarioConfig = {
      id: `D-shift-${target}`,
      label: `D · Shift to ${target}`,
      description: `Hold the headline rate (${pct(headline)}) but settle on a ${target} claim cadence instead of ${dominant.cadence}. Same gross accrual, but more lapses unclaimed (higher breakage) → lower realized cost, at more claim friction.`,
      policy: { kind: "cadence_gated", rate: baselineBlended, cadence: target },
      schemaVersion: SCHEMA,
    };
    scenarios.push(sc);
  }

  // ── E · Expiry change on the daily accrual ──
  // Tighter expiry forfeits more accrual (anti-hoarding, lower realized cost);
  // a looser expiry forfeits less (slightly higher realized cost). Anchored to
  // the REAL daily expiry so the moves are relative to production.
  const tighterExpiry = Math.max(1, Math.round(realDailyExpiry / 2));
  const looserExpiry = Math.max(realDailyExpiry + 7, Math.round(realDailyExpiry * 2));
  if (tighterExpiry < realDailyExpiry) {
    scenarios.push({
      id: "E-expiry-tighter",
      label: `E · ${tighterExpiry}d expiry`,
      description: `Headline rate held, but unclaimed accrual expires after ${tighterExpiry} days instead of ${realDailyExpiry}. A tighter anti-hoarding control — forfeits more accrual (higher breakage) → lower realized cost, modest added urgency.`,
      policy: { kind: "expiry_capped", rate: baselineBlended, cadence: dominant.cadence, expiryDays: tighterExpiry },
      schemaVersion: SCHEMA,
    });
  }
  scenarios.push({
    id: "E-expiry-looser",
    label: `E · ${looserExpiry}d expiry`,
    description: `Headline rate held, but unclaimed accrual expires after ${looserExpiry} days instead of ${realDailyExpiry}. A looser window — fewer lapses (lower breakage) → slightly higher realized cost, the least claim urgency.`,
    policy: { kind: "expiry_capped", rate: baselineBlended, cadence: dominant.cadence, expiryDays: looserExpiry },
    schemaVersion: SCHEMA,
  });

  // ── F · Multi-cadence — change daily + weekly + monthly TOGETHER ──
  // Each scenario applies a per-cadence MULTIPLIER to the REAL configured rates
  // and re-scales the result into the engine's modeled-blended units (so the
  // anchor holds). The per-cadence breakdown renders in the policy column (the
  // `multi_cadence` kind) + the description, so a combined-cadence policy move is
  // a single, clearly-labeled row. Only meaningful when ≥2 cadences are live —
  // with a single cadence "change all three together" degenerates to a flat trim
  // (already covered by family B), so we gate on enabled.length > 1.
  if (enabled.length > 1) {
    const MULTI_CADENCE_VARIANTS: Array<{
      id: string;
      label: string;
      blurb: string;
      mult: Record<ClaimCadence, number>;
      inWhatif?: boolean;
    }> = [
      {
        id: "F-all-minus-20",
        label: "F · All cadences −20%",
        blurb:
          "Trim every cadence 20% together — a uniform, proportional pull-down of the whole program that preserves the daily/weekly/monthly balance. The simplest combined-cadence cost cut.",
        mult: { daily: 0.8, weekly: 0.8, monthly: 0.8 },
        inWhatif: true,
      },
      {
        id: "F-all-minus-35",
        label: "F · All cadences −35%",
        blurb:
          "Trim every cadence 35% together — a firmer uniform cut across all three programs. Bigger direct savings, more genuine-conversion sacrifice.",
        mult: { daily: 0.65, weekly: 0.65, monthly: 0.65 },
      },
      {
        id: "F-all-minus-50",
        label: "F · All cadences −50%",
        blurb:
          "Halve every cadence together — the deepest uniform combined-cadence cut. The largest direct cost reduction, the steepest retention/wager headwind.",
        mult: { daily: 0.5, weekly: 0.5, monthly: 0.5 },
        inWhatif: true,
      },
      {
        id: "F-daily-weighted",
        label: "F · Daily-weighted",
        blurb:
          "Shift the mix toward DAILY: raise daily +20% while cutting weekly −40% and monthly −60%. Rewards frequent, reliable claiming (lowest breakage) and starves the slow, hoardable cadences.",
        mult: { daily: 1.2, weekly: 0.6, monthly: 0.4 },
        inWhatif: true,
      },
      {
        id: "F-monthly-weighted",
        label: "F · Monthly-weighted",
        blurb:
          "Shift the mix toward MONTHLY: cut daily −40% while raising monthly +50% and holding weekly. Leans on the slow cadence — higher breakage lowers realized cost, at more claim friction.",
        mult: { daily: 0.6, weekly: 1.0, monthly: 1.5 },
        inWhatif: true,
      },
      {
        id: "F-balanced-trim",
        label: "F · Balanced trim",
        blurb:
          "A gentle balanced trim: daily −10%, weekly −15%, monthly −25% — leans the cut harder on the slower, more hoardable cadences while keeping daily nearly intact.",
        mult: { daily: 0.9, weekly: 0.85, monthly: 0.75 },
      },
      {
        id: "F-deep-balanced-trim",
        label: "F · Balanced trim (deep)",
        blurb:
          "A deeper balanced trim: daily −20%, weekly −30%, monthly −45% — same taper-toward-the-slow-cadences shape, cut harder while still shielding daily claimers most.",
        mult: { daily: 0.8, weekly: 0.7, monthly: 0.55 },
      },
    ];

    for (const v of MULTI_CADENCE_VARIANTS) {
      const { policy, realHeadline: variantHeadline } = buildMultiCadencePolicy(enabled, v.mult, toModeled);
      const note = multiCadenceRealNote(enabled, v.mult);
      const sc: ScenarioConfig = {
        id: v.id,
        label: v.label,
        description: `${v.blurb} Per-cadence: ${note} (headline ${pct(headline)} → ${pct(variantHeadline)}).`,
        policy,
        schemaVersion: SCHEMA,
      };
      scenarios.push(sc);
      if (v.inWhatif) whatifSet.push(sc);
    }
  }

  // ── G · Instant pre-claim @ discount (the 65% cash-out lever) ──
  // SAME headline policy as the baseline, but with the instant pre-claim model
  // ON: the adopting fraction (the `preClaimAdoption` lever) cashes out ALL their
  // accrued rakeback (daily + weekly + monthly combined) immediately for the
  // `preClaimDiscount` (default 65%) — no breakage on that portion. The realized
  // cost uses the pre-claim-blended factor, so this row's net savings vs the
  // baseline read directly. Tune the magnitude with the discount + adoption
  // sliders. A planning model — it never changes live data.
  const preClaimScenario: ScenarioConfig = {
    id: "G-preclaim-65",
    label: "G · Pre-claim @ 65%",
    description: `Offer an INSTANT pre-claim: a user cashes out ALL their accrued rakeback (${enabledList}) immediately for a discounted fraction of its worth (the pre-claim discount lever, default 65%). Same headline policy as the baseline — the adopting share (pre-claim adoption lever) takes the discount now (no breakage), everyone else claims normally. A saving whenever the discount sits below the normal breakage-adjusted payout. Tune the discount + adoption sliders. Planning model — does not change live data.`,
    policy: { kind: "flat_rate", rate: baselineBlended, cadence: dominant.cadence },
    preClaim: true,
    schemaVersion: SCHEMA,
  };
  scenarios.push(preClaimScenario);
  whatifSet.push(preClaimScenario);

  return { scenarios, whatifSet, baselineScenarioId: baselineScenario.id };
}
