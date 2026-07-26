/**
 * Antifraud vocabulary â€” statuses, severities, question shapes, and the label /
 * colour maps for each.
 *
 * WHY THIS FILE EXISTS SEPARATELY: `reviews.ts` / `quiz.ts` are `server-only`
 * (they touch `adminDb`), but the dialogs and editors that WRITE these values
 * are Client Components and need the same vocabulary. Importing the server
 * modules from a client component drags Prisma â€” and therefore `tls`, `node:module`
 * and the rest of the Node graph â€” into the browser bundle, which is exactly
 * the class of error `npm run build` exists to catch.
 *
 * So: every pure constant lives HERE (no imports, no DB, isomorphic), and the
 * server modules re-export them so existing server call sites keep their
 * imports unchanged.
 */

// â”€â”€â”€ Review status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const REVIEW_STATUSES = [
  "open",
  "in_review",
  "cleared",
  "flagged",
  "escalated",
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export function isReviewStatus(value: string): value is ReviewStatus {
  return (REVIEW_STATUSES as readonly string[]).includes(value);
}

/** Statuses that still need work â€” what the queue defaults to. */
export const OPEN_REVIEW_STATUSES: readonly ReviewStatus[] = [
  "open",
  "in_review",
  "escalated",
];

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  open: "Open",
  in_review: "In review",
  cleared: "Cleared",
  flagged: "Flagged",
  escalated: "Escalated",
};
/**
 * Status badge colours. These are RISK colours, not money colours â€” the
 * House-POV money rule governs amounts, and a review carries none. "Cleared" is
 * emerald because a clean account is the good outcome for the house;
 * "flagged" / "escalated" are the bad ones.
 */
export const REVIEW_STATUS_COLORS: Record<ReviewStatus, string> = {
  open: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  in_review:
    "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  cleared:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  flagged: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  escalated:
    "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
};

// â”€â”€â”€ Review severity â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const REVIEW_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export function isReviewSeverity(value: string): value is ReviewSeverity {
  return (REVIEW_SEVERITIES as readonly string[]).includes(value);
}

export const REVIEW_SEVERITY_LABELS: Record<ReviewSeverity, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export const REVIEW_SEVERITY_COLORS: Record<ReviewSeverity, string> = {
  low: "bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/30",
  medium: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  high: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  critical:
    "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
};
