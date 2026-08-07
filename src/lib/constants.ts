export const ROLES = ["user", "support", "admin", "creator"] as const;
type Role = (typeof ROLES)[number];

const WITHDRAWAL_STATUSES = [
  "pending",
  "processing",
  "shipped",
  "completed",
  "failed",
  "cancelled",
] as const;
type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];

export const ROLE_COLORS: Record<string, string> = {
  admin: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  support: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  marketing: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  creator: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  pack_creator: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  creator_manager: "bg-pink-500/15 text-pink-600 dark:text-pink-400 border-pink-500/30",
  user: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

export const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  processing: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  shipped: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  completed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  failed: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  cancelled: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

export const AFFILIATE_LEVEL_COLORS: Record<number, string> = {
  1: "bg-zinc-400/15 text-zinc-500 dark:text-zinc-300 border-zinc-400/30",
  2: "bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30",
  3: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  4: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  5: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
  6: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  7: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  8: "bg-pink-500/15 text-pink-600 dark:text-pink-400 border-pink-500/30",
};

export const AFFILIATE_LEVEL_LABELS: Record<number, string> = {
  1: "Level 1",
  2: "Level 2",
  3: "Level 3",
  4: "Level 4",
  5: "Level 5",
  6: "Level 6",
  7: "Level 7",
  8: "Level 8",
};

export const USER_STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  banned: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  locked: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
};

/**
 * Above this many OTHER accounts on the same `signup_ip`, sharing stops being
 * evidence of anything.
 *
 * Measured against prod (read-only, 2026-07-22): 16,521 users, 12,458 distinct
 * signup IPs — 11,043 unique, ~1,000 pairs, then a long tail up to a single
 * address carrying 667 users. 33% of the user base shares an IP, and nine
 * addresses alone account for ~1,490 of them (CGNAT, VPN exits, office NAT).
 *
 * So a small cluster is worth a look and a large one is infrastructure. Shared
 * by the /users list icon and the /users/[id] hero chip so the two can never
 * disagree about what "suspicious" means.
 */
export const IP_CLUSTER_SUSPICIOUS_MAX = 4;

/**
 * ─── CHART_COLORS ─────────────────────────────────────────────────────────
 *
 * The literal hexes every Recharts surface in the app was re-declaring by
 * hand (`const EMERALD = "#10b981"`, `PNL_UP`, `ROSE`, `BLUE`, `rgb(16 185
 * 129)`, …) — ~30 copies across nine chart files. Recharts needs a concrete
 * color string, so these cannot be the `--chart-*` CSS variables the rest of
 * the app uses; centralizing the literals is the next best thing and stops
 * "the same emerald" from drifting into two shades.
 *
 * Values are the Tailwind 500-step hexes, byte-identical to the copies they
 * replace — importing this is a zero-visual-diff change.
 *
 * House-POV (CLAUDE.md §7) semantics for the money hues:
 *   emerald → house gained (wager, deposits, GGR/NGR/P&L positive)
 *   rose    → house paid out (payouts, reward cost, P&L negative)
 *   blue    → neutral, non-money event (signups, counts, gross lines)
 * `cyan` / `amber` / `purple` are neutral series hues for telling two
 * non-money lines apart in one chart — they carry no money meaning.
 */
export const CHART_COLORS = {
  /** emerald-500 — house gained. */
  emerald: "#10b981",
  /** emerald-300 — a lighter emerald for a second house-gain series. */
  emeraldLight: "#6ee7b7",
  /** rose-500 — house paid out. */
  rose: "#f43f5e",
  /** blue-500 — neutral / non-money. */
  blue: "#3b82f6",
  /** cyan-500 — neutral series hue. */
  cyan: "#06b6d4",
  /** amber-500 — neutral series hue. */
  amber: "#f59e0b",
  /** purple-500 — neutral series hue. */
  purple: "#a855f7",
} as const;
