/**
 * ONE status-badge color source for the creator detail folder.
 *
 * Previously the deal STATUS_COLORS map and the leaderboard approval/time
 * badge maps were copy-pasted across four files (deal-card,
 * previous-deals-dialog, leaderboards-card, previous-leaderboards-dialog) —
 * a drift hazard. Server-safe (plain constants, no client hooks); importable
 * from RSC and client components alike.
 */

/** Deal lifecycle → badge classes (pattern from `src/lib/constants.ts`). */
export const DEAL_STATUS_COLORS: Record<string, string> = {
  active:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  scheduled:
    "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  completed:
    "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  terminated:
    "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
};

export type LeaderboardApprovalStatus = "pending" | "approved" | "rejected";
export type LeaderboardTimeStatus = "upcoming" | "active" | "ended";

/** Leaderboard approval status → badge classes. */
export const LEADERBOARD_APPROVAL_COLORS: Record<
  LeaderboardApprovalStatus,
  string
> = {
  pending:
    "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  approved:
    "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  rejected: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
};

/** Leaderboard time status → badge classes. */
export const LEADERBOARD_TIME_COLORS: Record<LeaderboardTimeStatus, string> = {
  upcoming:
    "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  active:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  ended: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};
