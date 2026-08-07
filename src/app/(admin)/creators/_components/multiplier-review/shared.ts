import type { MultiplierDealStatus } from "@/lib/backend-api";

/**
 * Status → tailwind class map for multiplier deal badges. Mirrors the
 * `STATUS_COLORS` pattern in lib/constants but specific to the multiplier
 * lifecycle so existing fill-deal colors don't collide.
 *
 * Color choices follow the house-perspective rule loosely (settlements
 * that pay the user out are red, settlements that keep deposit are green
 * etc.) but most badges here are neutral lifecycle indicators.
 */
export const MULTIPLIER_STATUS_BADGE: Record<MultiplierDealStatus, string> = {
  // Offer states — slate / blue
  pending_deposit:
    "bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-500/30",
  funded:
    "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  // Live — emerald (positive lifecycle signal, not financial)
  live: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  // Awaiting review — amber (attention)
  pending_review:
    "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  flagged:
    "bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30",
  // Terminal — neutral after settlement
  approved:
    "bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/30",
  rejected:
    "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  cancelled:
    "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  completed:
    "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

export const MULTIPLIER_STATUS_LABEL: Record<MultiplierDealStatus, string> = {
  pending_deposit: "Pending Deposit",
  funded: "Funded",
  live: "Live",
  pending_review: "Pending Review",
  flagged: "Flagged",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
  completed: "Completed",
};

/**
 * Statuses where the review-side actions (approve / reject / flag) are
 * meaningful. Live deals get force-end instead.
 */
const REVIEWABLE_STATUSES: MultiplierDealStatus[] = [
  "pending_review",
  "flagged",
];

/**
 * Statuses where the offer-management actions (edit / cancel) are
 * meaningful — the deal hasn't yet kicked off the stream lifecycle.
 */
const OFFER_STATUSES: MultiplierDealStatus[] = [
  "pending_deposit",
  "funded",
];

/**
 * Statuses considered "in flight" for KPI counts on the review page.
 */
const IN_FLIGHT_STATUSES: MultiplierDealStatus[] = [
  "funded",
  "live",
  "pending_review",
  "flagged",
];

/**
 * Format a bps (basis points) value as a human-readable percentage.
 *   10000 → "100.00%"
 *   2000  → "20.00%"
 *   50000 → "500.00%"  (multiplier_bps semantically; "5.00x" formatter below)
 */
export const formatBps = (bps: number): string =>
  `${(bps / 100).toFixed(2)}%`;

/**
 * Format multiplier_bps as a multiplier label (50000 → "5.00x").
 * Used in deal contracts where bps represents inflation factor, not a
 * percentage cap.
 */
export const formatMultiplier = (bps: number): string =>
  `${(bps / 10000).toFixed(2)}x`;

/**
 * Stringified USD amount (decimal string from backend) → tile-friendly
 * display. Backend returns "1234.50"; we render "$1,234.50".
 */
export const formatStringUsd = (value: string | null | undefined): string => {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
};

/**
 * Human-readable flag code. Strips the `MANUAL:` prefix so manual flags
 * read as "Custom Reason" instead of "MANUAL:Custom Reason".
 */
export const formatFlagCode = (code: string): string => {
  if (code.startsWith("MANUAL:")) return code.slice("MANUAL:".length);
  return code
    .toLowerCase()
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
};
