/**
 * types.ts — the GENERIC, reward-agnostic forecast models + the per-reward
 * `ForecastConfig` contract.
 *
 * This is the FOUNDATION every reward forecast builds on. It was extracted from
 * the deposit-bonus reference (`rewards/deposit-bonus/_forecast/types.ts`) and
 * generalized so the SAME orchestration (`simulateSet`, `scaleResultMoney`,
 * `buildDailySeries`, `recommend`) and the SAME UI island (`_forecast-ui`) can
 * drive a forecast for ANY reward type.
 *
 * ── Serialization rule (Next 15 RSC boundary) ───────────────────────────────
 * Everything here except the `simulate` FUNCTION on `ForecastConfig` is a PLAIN
 * data shape — no functions, no Decimal, no Date. It round-trips through
 * `JSON.parse(JSON.stringify(x))` unchanged so:
 *   • a server component can pass `realBaseline` + the SERIALIZABLE half of the
 *     config as props into the `"use client"` island, and
 *   • a scenario / lever state can be saved / shared / exported as plain JSON.
 *
 * The `simulate` function is the ONE non-serializable member. It is therefore
 * NEVER passed across the server→client boundary as a prop. The client island
 * imports the reward's `simulate` directly (via the reward's config module,
 * which is a client-importable barrel) — exactly the data-flow the reference
 * uses, where the engine is a pure module the island calls in `useMemo`.
 *
 * ── House-POV (CLAUDE.md, strict) ───────────────────────────────────────────
 * Every money output is from the HOUSE perspective. A reward PAID OUT is a house
 * OUTFLOW (render rose/amber); SAVINGS against the house and NGR accretion are
 * house GAINS (render emerald). The generic UI hard-codes that mapping; a reward
 * only supplies accent hints, never an inverted convention.
 */

import type { AccentColor } from "./constants";

// ─── Result models (reward-agnostic) ─────────────────────────────────────────

/**
 * Per-segment forecast breakdown. All money in USD, House-POV.
 *
 * `segment` is an OPAQUE stable string id — a reward defines its own segment id
 * union (e.g. deposit-bonus's `SegmentId`) and the generic engine treats it as a
 * plain string. The `label` travels with the row so the UI never needs the
 * reward's segment metadata to render a breakdown.
 */
export type PerSegment = {
  /** Stable segment id (reward-defined). Opaque to the generic engine. */
  segment: string;
  /** Human label for this segment (carried so the UI is reward-agnostic). */
  label: string;
  /** Claimants attributed to this segment over the horizon. */
  claimants: number;
  /** Reward cost (USD) attributable to this segment over the horizon. */
  bonusCost: number;
  /** Cost leaked to abusive behaviour (USD), after stricter-policy capture. */
  abuseLeakage: number;
  /** Retained downstream revenue (USD) from legit reward to this segment. */
  retainedRevenue: number;
  /** NGR delta (USD) attributable to this segment, House-POV. */
  ngrImpact: number;
  /** The $ ceiling this segment effectively faces under the scenario. */
  effectiveCapUsd: number;
};

/** One day of the projected horizon. House-POV money. */
export type DailyPoint = {
  /** 0-indexed day within the horizon. */
  day: number;
  /** Reward cost paid on this day (USD). */
  bonusCost: number;
  /** Running total reward cost through this day (USD). */
  cumulativeCost: number;
  /** Savings vs the baseline scenario on this day (USD, +ve = cheaper). */
  savingsVsBaseline: number;
  /** Abuse leakage on this day (USD). */
  abuseLeakage: number;
};

/**
 * The complete forecast for a single scenario. Every field is House-POV:
 *   • positive `ngrImpact` / `netSavingsVsBaseline` = good for the house
 *     (render emerald),
 *   • `bonusCost` / `abuseLeakage` are house outflows (render rose / amber).
 *
 * Reward-agnostic — the deposit-bonus engine returns exactly this shape and so
 * must every other reward engine, so the shared orchestration + UI can consume
 * any reward's results uniformly.
 */
export type SimulationResult = {
  scenarioId: string;
  /** Total projected reward payout cost over the horizon (USD). */
  bonusCost: number;
  /**
   * Net house P&L attributable to the program over the horizon (USD).
   * = -netLoss. Positive = the program nets the house money.
   */
  marginImpact: number;
  /** Net house loss attributable to the program (USD, ≥0 when loss-making). */
  netLoss: number;
  /** GROSS savings vs the baseline scenario (USD, before retention loss). */
  savingsVsBaseline: number;
  /**
   * NET savings vs baseline AFTER subtracting retained-revenue / conversion
   * loss caused by tightening (USD). The honest "what we actually save"
   * number — always ≤ `savingsVsBaseline` for stricter scenarios.
   */
  netSavingsVsBaseline: number;
  /** Cost leaked to abusive behaviour over the horizon (USD). */
  abuseLeakage: number;
  /** Retained downstream revenue from legit reward over the horizon (USD). */
  retainedRevenue: number;
  /**
   * NGR delta = downstream GGR proxy − bonusCost (USD), House-POV.
   * Positive = the program is NGR-accretive.
   */
  ngrImpact: number;
  /** UX friction composite, 0-100 (higher = worse experience). */
  frictionScore: number;
  /** ±band on the projected `bonusCost` (USD). low ≤ mid ≤ high. */
  confidenceBand: { low: number; mid: number; high: number };
  /** Per-segment breakdown. */
  perSegment: PerSegment[];
  /** Day-by-day series over the horizon. */
  dailySeries: DailyPoint[];
};

// ─── Assumptions (the tunable levers, reward-agnostic core) ───────────────────

/**
 * The reward-agnostic CORE of the tunable lever set. Every reward's
 * `Assumptions` MUST be a superset of this (the generic orchestration only
 * reads these fields). Reward-specific levers (e.g. deposit-bonus's
 * `segmentMix` / `abuseShare` / `cannibalizationRate`) are added on top in the
 * reward's own `_forecast/types.ts`.
 *
 * Rates / probabilities / multipliers — never raw money except `avgBonusUsd`.
 * The engine normalizes / clamps everything defensively, but callers should
 * keep fractions in [0,1].
 *
 * VOLUME is anchored to the REAL measured claimant count (no synthetic
 * population): `baselineClaimants` over `baselinePeriodDays` is scaled to the
 * forecast horizon and modulated by the claim-probability lever relative to its
 * REAL measured default (`baselineClaimProbability`). See {@link ForecastBaseline}.
 */
export type BaseAssumptions = {
  /** REAL distinct claimants measured over `baselinePeriodDays`. The volume anchor. */
  baselineClaimants: number;
  /** Day-span the real `baselineClaimants` was measured over (≥1). */
  baselinePeriodDays: number;
  /**
   * REAL measured claim probability the slider defaults to — the reference the
   * tunable `claimProbability` is normalized against (so the default lever
   * leaves the real claimant volume unchanged). 0-1.
   */
  baselineClaimProbability: number;
  /** Baseline deposit/qualifying-event frequency per user within one window. */
  depositsPerUserPerWindow: number;
  /**
   * P(claims the reward | qualified), 0-1. Defaults to the REAL measured ratio
   * (`baselineClaimProbability`); tunable for what-if. The engine scales the
   * real claimant volume by `claimProbability / baselineClaimProbability`.
   */
  claimProbability: number;
  /** Baseline average reward (USD) BEFORE any cap clamp is applied. */
  avgBonusUsd: number;
  /** Forecast horizon in days (e.g. 7 / 30 / 90). */
  windowDays: number;
};

// ─── Recommendations (reward-agnostic) ────────────────────────────────────────

/** Which award a recommendation carries (drives the Badge variant). */
export type RecommendationBadge =
  | "highest-savings"
  | "lowest-friction"
  | "best-balance";

/** A rule-based insight pointing at one winning scenario. */
export type Recommendation = {
  /** The scenario this recommendation crowns. */
  scenarioId: string;
  badge: RecommendationBadge;
  /** Short headline, e.g. "Best net savings". */
  headline: string;
  /** One-line rationale with the concrete numbers. */
  detail: string;
};

// ─── Baseline anchor (real production input, reward-agnostic) ─────────────────

/**
 * The REAL baseline the server fetches once (from a reward's canonical queries)
 * and hands the engine so the forecast anchors on production numbers instead of
 * recomputing cost from a separate rollup.
 *
 * Every field is REAL (measured) — the behavioural assumptions (claim prob,
 * abuse share, retention uplift, …) are NOT here; those are tunable seeds in the
 * reward's `Assumptions`. A reward maps its own overview/ROI query outputs onto
 * this shape in its server tab (see the deposit-bonus reference
 * `_components/forecast-tab.tsx`).
 */
export type ForecastBaseline = {
  /** Real total reward cost in the source window (USD). */
  totalCost: number;
  /** Real distinct claimants. */
  uniqueClaimants: number;
  /**
   * Day-span the baseline was measured over (the selected period; lifetime is
   * bounded to a standard lookback). The volume anchor scales `uniqueClaimants`
   * from this span to the forecast horizon. Always ≥1.
   */
  periodDays: number;
  /**
   * Real measured claim probability = `uniqueClaimants / distinct qualifiers`
   * in the SAME window + scope. The claim-probability slider defaults to this.
   * `null` when there were no qualifiers (divide-by-zero guard → empty state).
   */
  claimProbability: number | null;
  /** Real average reward (USD). */
  avgBonusUsd: number;
  /** Real largest single reward = empirical cap (USD). */
  empiricalCapUsd: number;
  /** Real cap-hit rate, 0-1. May be null if unavailable. */
  capHitRate: number | null;
  /** Real blended ROI (downstream GGR / cost). May be null. */
  blendedRoi: number | null;
  /** Real avg downstream GGR per claimant (USD). */
  avgGgrPerClaimant: number;
};

// ─── Generic scenario config ──────────────────────────────────────────────────

/**
 * The reward-agnostic CORE of a scenario definition. A reward's own
 * `ScenarioConfig` extends this with a reward-specific `cap` (or other policy)
 * shape — the generic orchestration only reads `id` (for baseline matching) and
 * passes the whole object back to the reward's `simulate`.
 *
 * `schemaVersion` is pinned so saved/exported scenarios can be migrated forward.
 */
export type BaseScenarioConfig = {
  /** Stable key, e.g. "A-baseline". */
  id: string;
  label: string;
  description: string;
  /** Bump-safe version tag for persisted scenarios. */
  schemaVersion: 1;
};

// ─── Segment metadata (serializable, for the config) ──────────────────────────

/**
 * A reward's segment, as a SERIALIZABLE descriptor the UI can render without
 * importing the reward's engine. Mirrors the deposit-bonus `SEGMENTS` rows but
 * dep-free (`id` is a plain string here so this is reward-agnostic).
 */
export type SegmentMeta = {
  /** Stable segment id (reward-defined). */
  id: string;
  /** Display label. */
  label: string;
  /** Stable accent color (house TILE_COLORS token). */
  accent: AccentColor;
};

// ─── Lever descriptors (drive the generic controls) ───────────────────────────

/**
 * How a lever's value is FORMATTED in the UI. A plain string enum (NOT a
 * function) so the whole `ForecastConfig` stays serializable and can cross the
 * RSC boundary / be persisted. The generic controls map this to the shared
 * formatter (`percent` → formatPct, `currency` → formatCurrency, `number` →
 * toFixed(decimals), `multiplier` → `${v}×`).
 */
export type LeverFormat = "percent" | "currency" | "number" | "multiplier";

/** Accent tint for a lever's value text (house-POV semantics). */
export type LeverAccent = "amber" | "emerald" | "neutral";

/**
 * A single tunable slider in the generic controls panel. `key` indexes into the
 * reward's `Assumptions` (a numeric field). The generic controls render a
 * shadcn Slider + numeric Input for every lever the reward lists, in order.
 *
 * Fully serializable (no functions) so the config crosses the RSC boundary.
 */
export type LeverConfig = {
  /** Numeric `Assumptions` field this slider edits. */
  key: string;
  /** Slider label. */
  label: string;
  /** Tooltip hint shown on the label. */
  hint: string;
  /** Lucide icon NAME is not serializable — the UI maps a stable key. See {@link LeverIcon}. */
  icon: LeverIcon;
  min: number;
  max: number;
  step: number;
  /** How to format the value badge. */
  format: LeverFormat;
  /** Optional decimal places for `format: "number"` (default 1). */
  decimals?: number;
  /** Optional value-text accent (house-POV). */
  accent?: LeverAccent;
  /**
   * Optional group separator BEFORE this lever (renders a divider). Used to
   * visually split "volume" levers from "behavioural" levers etc.
   */
  groupBreak?: boolean;
};

/**
 * Stable lever-icon keys the generic controls map to a `lucide-react` icon.
 * A NAME (not the component) keeps `ForecastConfig` serializable. Extend this
 * union + the `LEVER_ICONS` map in the UI kit when a reward needs a new glyph.
 */
export type LeverIcon =
  | "percent"
  | "coins"
  | "shield-alert"
  | "magnet"
  | "gauge"
  | "hand-coins"
  | "repeat"
  | "calendar-range"
  | "pie-chart"
  | "trending-down"
  | "users";

/**
 * Optional config for a segment-mix control block (a row of sliders, one per
 * segment, auto-normalized). Omit when a reward has no per-segment mix lever.
 */
export type SegmentMixLeverConfig = {
  /** The `Assumptions` field holding the `Record<segmentId, number>` mix. */
  key: string;
  /** Block label. */
  label: string;
};

/** Accent palette a reward hands the UI (house-POV; all optional with sane defaults). */
export type ForecastColors = {
  /** Accent for the "baseline cost" KPI (house outflow). Default "rose". */
  cost?: AccentColor;
  /** Accent for "abuse leakage" (house outflow). Default "amber". */
  leakage?: AccentColor;
  /** Accent for "retained revenue" / positive savings (house gain). Default "emerald". */
  retained?: AccentColor;
  /** Accent for the page hero icon chip. Default "rose". */
  hero?: AccentColor;
};

// ─── The per-reward ForecastConfig contract ──────────────────────────────────

/**
 * THE CONTRACT every reward forecast provides. Generic over the reward's own
 * `Assumptions` (A, a superset of {@link BaseAssumptions}) and `ScenarioConfig`
 * (S, a superset of {@link BaseScenarioConfig}).
 *
 * SERIALIZABLE except `simulate` + `defaults`'s function-free payload. The
 * server passes the SERIALIZABLE half (everything except `simulate`) + the real
 * baseline to the client island; the island imports `simulate` directly from
 * the reward's config module (NEVER as a prop) and runs it in `useMemo`.
 *
 * To add a reward X, implement this in `rewards/X/_forecast/config.ts`:
 *
 * ```ts
 * export const X_FORECAST_CONFIG: ForecastConfig<XAssumptions, XScenarioConfig> = {
 *   rewardType: "rakeback",
 *   label: "Rakeback",
 *   scenarios: X_SCENARIO_LIBRARY,
 *   baselineScenarioId: X_BASELINE_ID,
 *   whatifSet: X_WHATIF_SET,            // optional secondary comparison set
 *   segments: X_SEGMENTS,               // SegmentMeta[]
 *   defaults: (baseline) => ({ ... }),  // seed Assumptions from the real baseline
 *   levers: [ ... ],                     // LeverConfig[] (+ optional segmentMix)
 *   colors: { hero: "violet", ... },
 *   simulate: xSimulate,                 // the reward's pure engine entry
 *   capLabel: (sc) => xCapLogicLabel(sc),// optional table "policy" column
 * };
 * ```
 */
export type ForecastConfig<
  A extends BaseAssumptions = BaseAssumptions,
  S extends BaseScenarioConfig = BaseScenarioConfig,
> = {
  /** Stable reward-type key — matches the hub's `?reward=` value & registry key. */
  rewardType: string;
  /** Human label, e.g. "Deposit bonus". */
  label: string;
  /** The full scenario library (baseline first). */
  scenarios: S[];
  /** Id of the reference (baseline) scenario in `scenarios`. */
  baselineScenarioId: string;
  /**
   * Optional SECONDARY comparison set (e.g. deposit-bonus's split-cap set). When
   * present the UI shows a "compare set" toggle. Omit for a single set.
   */
  whatifSet?: S[];
  /**
   * Optional: derive the LIVE scenario set from the REAL baseline at render time,
   * so the baseline scenario + what-ifs reflect the actual production POLICY (the
   * configured rates/tiers fetched at request time and threaded onto the
   * baseline), not a hard-coded placeholder. Returns the full library, the
   * optional what-if comparison set, and the id of the reference (baseline)
   * scenario. When present, the UI uses these in place of the static `scenarios`
   * / `whatifSet` / `baselineScenarioId`. Return `null` to fall back to the
   * static set (e.g. when the real config could not be threaded). PURE +
   * serializable output — the island calls it in a memo and on reset.
   *
   * Rewards whose baseline is fully captured by the static library (e.g. deposit-
   * bonus) omit this; rewards whose baseline is a live DB policy (rakeback,
   * affiliate) implement it from the real config carried on `ForecastBaseline`.
   */
  buildScenarios?: (
    baseline: ForecastBaseline,
  ) => { scenarios: S[]; whatifSet?: S[]; baselineScenarioId: string } | null;
  /** Serializable segment metadata for the breakdown panels + charts. */
  segments: SegmentMeta[];
  /**
   * Seed the lever state from the REAL baseline. PURE + serializable output (a
   * plain `Assumptions` object) — the island calls this to build the initial
   * state and on reset.
   */
  defaults: (baseline: ForecastBaseline) => A;
  /** The tunable sliders, in display order. */
  levers: LeverConfig[];
  /** Optional segment-mix control block. */
  segmentMixLever?: SegmentMixLeverConfig;
  /** House-POV accent hints (all optional). */
  colors?: ForecastColors;
  /**
   * THE PURE ENGINE ENTRY. Runs ONE scenario. NEVER passed as a server→client
   * prop — the client island imports it directly from this module. Must be
   * side-effect-free, dep-free, primitives-only (mirrors the reference engine).
   */
  simulate: (scenario: S, assumptions: A, window: { days: number }) => SimulationResult;
  /**
   * Optional: resolve a scenario's daily pacing front-load factor (1 = flat,
   * >1 = front-loaded) for the post-savings daily series rebuild in
   * `simulateSet`. Defaults to flat (1) when omitted.
   */
  pacingFrontload?: (scenario: S) => number;
  /**
   * Optional: a short human "policy logic" label for the comparison table's
   * policy column (e.g. "$100 / 24h"). Falls back to the scenario label.
   */
  capLabel?: (scenario: S) => string;
  /**
   * Optional: operational-complexity rank (1 simplest … 3 most moving parts)
   * for the comparison table. Defaults to 1 when omitted.
   */
  capComplexity?: (scenario: S) => 1 | 2 | 3;
};

/**
 * The SERIALIZABLE projection of a {@link ForecastConfig} that is safe to pass
 * across the RSC boundary as a prop (it drops `simulate`, `defaults`,
 * `pacingFrontload`, `capLabel`, `capComplexity` — every function member). The
 * client island receives this for rendering metadata (labels, levers, segments,
 * colors, scenarios) and obtains the FUNCTION members by importing the reward's
 * config module directly.
 *
 * Built by `toSerializableConfig` in the engine barrel.
 */
export type SerializableForecastConfig = {
  rewardType: string;
  label: string;
  scenarios: BaseScenarioConfig[];
  baselineScenarioId: string;
  whatifSet?: BaseScenarioConfig[];
  segments: SegmentMeta[];
  levers: LeverConfig[];
  segmentMixLever?: SegmentMixLeverConfig;
  colors?: ForecastColors;
};
