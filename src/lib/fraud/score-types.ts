/**
 * Pure types + client-safe helpers for the risk/trust scoring system.
 *
 * Split out of `./score.ts` so UI components can import the tier colors
 * + types WITHOUT pulling the server-only Prisma imports (db / adminDb)
 * into the client bundle. Importing from `./score.ts` in a "use client"
 * file caused Turbopack to attempt bundling `@prisma/client` for the
 * browser, which crashed the build with a `node:module` error.
 *
 * Rule: client components MUST import from this file. Server code may
 * import from either this file or `./score.ts` (which re-exports from
 * here).
 */

export type RiskTier = "low" | "medium" | "high" | "critical";
export type RiskCategory =
  | "velocity"
  | "gameplay"
  | "rewards"
  | "network"
  | "account";

// Signal id catalog lives in ./signal-catalog so server + client can
// import it without pulling the score aggregator's DB imports.
import type { SignalId } from "./signal-catalog";
export type { SignalId } from "./signal-catalog";

export type RiskSignal = {
  id: SignalId;
  category: RiskCategory;
  label: string;
  /** Final contribution to the score if triggered. */
  weight: number;
  triggered: boolean;
  /** Human-readable value or metric that supports the explanation. */
  value?: string | number;
  /** Full sentence the moderator sees. */
  explanation: string;
};

/**
 * An actionable hint the UI surfaces alongside the score. Every item is
 * grounded in at least one triggered signal — we never fabricate advice.
 * The moderator still has to click the button; nothing auto-executes.
 */
export type RiskActionSuggestion = {
  kind:
    | "manual_review"
    | "lock_account"
    | "block_withdrawal"
    | "investigate_multi_account"
    | "investigate_bonus_abuse"
    | "monitor";
  label: string;
  /** 1-2 sentences explaining the "why" to the moderator. */
  reason: string;
  /** Which signal IDs justify this suggestion. */
  causedBy: SignalId[];
};

/**
 * A single event on the 7-day fraud timeline. Kept client-safe — no
 * Prisma enums, the `kind` is a discrete union the UI can style.
 */
export type RiskTimelineEvent = {
  kind:
    | "deposit"
    | "withdrawal"
    | "wager"
    | "bonus"
    | "reward"
    | "login"
    | "mute"
    | "signup"
    | "withdrawal_attempt"
    | "withdrawal_failed";
  label: string;
  /** USD amount if applicable, null for non-money events. */
  amountUsd: number | null;
  /** ISO timestamp (UTC). */
  at: string;
};

export type RiskScoreBreakdown = {
  score: number;
  tier: RiskTier;
  signals: RiskSignal[];
  /** Top 5 triggered signals by weight — prominent in the UI. */
  topReasons: RiskSignal[];
  /** Server-computed action suggestions — never auto-applied. */
  suggestions: RiskActionSuggestion[];
  /** Last 7 days of fraud-relevant events. */
  timeline: RiskTimelineEvent[];
  sharedIpCount: number;
  sharedFingerprintCount: number;
  /** Number of OTHER users in the shared-identity set who are currently banned. */
  sharedBannedCount: number;
  /** Number of OTHER users in the shared-identity set who are currently locked. */
  sharedLockedCount: number;
  /** Epoch ms of the aggregation. Useful for cache introspection + "last computed" label. */
  computedAt: number;
  /** Wall-clock duration (ms) of the score computation. Purely diagnostic. */
  computeDurationMs: number;
};

export type RiskScoreLite = {
  score: number;
  tier: RiskTier;
  sharedIpCount: number;
  sharedFingerprintCount: number;
};

// ---------------------------------------------------------------------------
// Tier / coloring helpers (pure — safe on client)
// ---------------------------------------------------------------------------

/**
 * Tier thresholds — tuned for the v2 signal set (40+ signals, max single
 * weight 18, max triggered-weight total before clamp ≈ 180).
 *
 * Rationale:
 *   - low (≤19)       clean users land here. 1-2 minor signals at
 *                     weight 3-5 still keep the score visibly "green".
 *   - medium (20-49)  3-5 real concerns. Worth a glance, not urgent.
 *   - high (50-74)    multiple hard signals. Manual review due.
 *   - critical (≥75)  at least one textbook laundering / bonus-abuse
 *                     pattern has fired with full force, OR enough
 *                     independent signals have stacked to make the case
 *                     inescapable.
 *
 * Any re-tune MUST keep these ordered (low < medium < high < critical)
 * and MUST keep the lowest threshold ≥ 10 so very minor noise (e.g. a
 * single chat mute on an otherwise clean account) doesn't flip the
 * account into medium.
 */
export function tierForScore(score: number): RiskTier {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 20) return "medium";
  return "low";
}

export function tierLabel(tier: RiskTier): string {
  return tier === "low"
    ? "Low"
    : tier === "medium"
      ? "Medium"
      : tier === "high"
        ? "High"
        : "Critical";
}

/**
 * Tailwind classes for a tier badge. CLAUDE.md house-perspective:
 * a high-risk user is bad for the HOUSE (rose/red). Low risk =
 * house safe = emerald. Between are graded amber/orange.
 */
export const RISK_TIER_COLORS: Record<RiskTier, string> = {
  low: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  medium: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  high: "bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30",
  critical: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
};
