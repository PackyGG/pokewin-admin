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

export type RiskSignal = {
  id: string;
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

export type RiskScoreBreakdown = {
  score: number;
  tier: RiskTier;
  signals: RiskSignal[];
  sharedIpCount: number;
  sharedFingerprintCount: number;
  /** Epoch ms of the aggregation. Useful for cache introspection. */
  computedAt: number;
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

export function tierForScore(score: number): RiskTier {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 30) return "medium";
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
