import { z } from "zod";

/**
 * config.ts — the lifecycle and legacy scoring model of the Chat Raffle.
 *
 * Client-safe on purpose (no `server-only`, no DB import): lifecycle labels,
 * fixed eligibility rules and legacy round config are shared by server and UI.
 *
 * New and open rounds use the canonical Community XP decisions written by
 * `discord-community-xp.ts`: qualifying Discord and linked on-site messages
 * inside the round window contribute their awarded XP, and 1 XP = 1 ticket.
 * The five scoring columns remain on old round rows for compatibility and to
 * keep historical records readable; operators no longer tune them here.
 *
 * ─── What is NOT configurable (deliberately) ─────────────────────────────
 *
 * The eligibility rules below are ALWAYS applied — see
 * {@link CHAT_RAFFLE_FIXED_RULES}. They were briefly per-round toggles; the
 * owner removed them because there is no legitimate round that wants staff
 * winning a player raffle, and a muted user cannot chat in the first place.
 * Removing the switches removes the way to get them wrong.
 */

/** Lifecycle flag persisted on the row. */
export const CHAT_RAFFLE_STATUSES = ["open", "drawn", "cancelled"] as const;
export type ChatRaffleStatus = (typeof CHAT_RAFFLE_STATUSES)[number];

/** How winners are selected after the shared Community XP window closes. */
export const CHAT_COMPETITION_TYPES = ["raffle", "leaderboard"] as const;
export type ChatCompetitionType = (typeof CHAT_COMPETITION_TYPES)[number];

export const CHAT_COMPETITION_LABEL: Record<ChatCompetitionType, string> = {
  raffle: "Raffle",
  leaderboard: "XP Leaderboard",
};

/**
 * The always-on rules, stated once so the UI can show them and the scorer
 * can enforce them without either side inventing its own wording.
 *
 * Repeat winners are ALLOWED: tickets are the whole weighting model, so
 * removing a winner from the pool between places would silently re-weight
 * everyone else's odds mid-draw. Letting the pool stand keeps each place an
 * independent draw at the published odds — and keeps the frozen snapshot's
 * ticket ranges valid for every pick, not just the first.
 */
export const CHAT_RAFFLE_FIXED_RULES = [
  "Discord and linked on-site chat XP both count",
  "Staff, admins and creators never qualify",
  "Blacklisted users never qualify",
  "Muted users never qualify",
  "One user can win more than one place",
] as const;

export const CHAT_LEADERBOARD_FIXED_RULES = [
  "Discord and linked on-site chat XP both count",
  "Staff, admins and creators never qualify",
  "Blacklisted users never qualify",
  "Muted users never qualify",
  "Each prize goes to a different ranked player",
  "Equal XP ranks whoever reached that score first",
] as const;

export function competitionRules(type: ChatCompetitionType): readonly string[] {
  return type === "leaderboard"
    ? CHAT_LEADERBOARD_FIXED_RULES
    : CHAT_RAFFLE_FIXED_RULES;
}

/**
 * What an operator actually sees. `scheduled` / `running` / `ready` are all
 * DERIVED from the window — there is no cron in this admin, so nothing flips
 * a status on a timer.
 */
export type ChatRafflePhase =
  | "scheduled"
  | "running"
  | "ready"
  | "drawn"
  | "cancelled";

export const CHAT_RAFFLE_PHASE_LABEL: Record<ChatRafflePhase, string> = {
  scheduled: "Scheduled",
  running: "Running",
  ready: "Ready to draw",
  drawn: "Drawn",
  cancelled: "Cancelled",
};

export function competitionPhaseLabel(
  phase: ChatRafflePhase,
  type: ChatCompetitionType,
): string {
  if (type === "leaderboard") {
    if (phase === "ready") return "Ready to finalize";
    if (phase === "drawn") return "Finalized";
  }
  return CHAT_RAFFLE_PHASE_LABEL[phase];
}

/**
 * Phase badge colours. Neutral / informational states only — these are NOT
 * money figures, so the house-POV red/green rule does not apply here (that
 * rule governs amounts, and prize amounts use it).
 */
export const CHAT_RAFFLE_PHASE_COLOR: Record<ChatRafflePhase, string> = {
  scheduled:
    "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  running:
    "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
  ready:
    "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  drawn:
    "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  cancelled: "bg-muted text-muted-foreground border-border",
};

/**
 * Medal colours for a prize place / standings rank. Gold, silver, bronze,
 * then neutral. Shared by the list page, the round detail page and the round
 * form so the same place is never two different colours.
 */
export const CHAT_RAFFLE_POSITION_COLORS: Record<number, string> = {
  1: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  2: "bg-zinc-400/15 text-zinc-500 dark:text-zinc-400 border-zinc-400/30",
  3: "bg-amber-700/15 text-amber-700 dark:text-amber-500 border-amber-700/30",
};

/** Fourth place and beyond. */
export const CHAT_RAFFLE_POSITION_FALLBACK =
  "bg-muted text-muted-foreground border-border";

/** Medal class for a 1-based place. */
export function positionColor(position: number): string {
  return CHAT_RAFFLE_POSITION_COLORS[position] ?? CHAT_RAFFLE_POSITION_FALLBACK;
}

/** Legacy per-round scoring columns retained for old records/API shape. */
export type ChatRaffleScoring = {
  pointsPerMessage: number;
  minMessageChars: number;
  bucketMinutes: number;
  maxMessagesPerBucket: number;
  dedupeIdentical: boolean;
};

/**
 * Compatibility values written to the legacy columns of a new round. The
 * Community XP event pipeline, not these values, now decides ticket awards.
 */
export const DEFAULT_CHAT_RAFFLE_SCORING: ChatRaffleScoring = {
  pointsPerMessage: 1,
  minMessageChars: 3,
  bucketMinutes: 10,
  maxMessagesPerBucket: 10,
  dedupeIdentical: true,
};

/**
 * Hard ceiling on a round's window. The scorer reads every message in the
 * window (it needs the text length + dedupe key, which the covering index
 * can't supply), so an unbounded window would turn into a lifetime scan —
 * exactly what the Active-Timeframe-Only rule forbids.
 */
export const CHAT_RAFFLE_MAX_WINDOW_DAYS = 90;

/**
 * Most entrants one round can snapshot. Generous on purpose: with no
 * entry-points floor, EVERY user who sends one qualifying message is an
 * entrant, so this is the only backstop against an unbounded snapshot. The
 * draw refuses rather than silently clipping the pool (see the truncation
 * handling in standings.ts / the draw action).
 */
export const CHAT_RAFFLE_MAX_ENTRIES = 10_000;

/** Most prize places one round can pay out. */
export const CHAT_RAFFLE_MAX_PRIZES = 20;

/** Single-prize ceiling — a typo guard on real money, not a policy. */
export const CHAT_RAFFLE_MAX_PRIZE_USD = 10_000;

export const chatRaffleScoringSchema = z.object({
  pointsPerMessage: z.number().int().min(1).max(100),
  minMessageChars: z.number().int().min(1).max(500),
  bucketMinutes: z.number().int().min(1).max(1440),
  maxMessagesPerBucket: z.number().int().min(1).max(1000),
  dedupeIdentical: z.boolean(),
});

/**
 * Derive what an operator sees from the persisted status + the window.
 * `now` is passed in so server and client agree on the instant instead of
 * each reading their own clock mid-render.
 */
export function deriveRoundPhase(
  round: { status: string; starts_at: Date; ends_at: Date },
  now: Date,
): ChatRafflePhase {
  if (round.status === "cancelled") return "cancelled";
  if (round.status === "drawn") return "drawn";
  if (now < round.starts_at) return "scheduled";
  if (now < round.ends_at) return "running";
  return "ready";
}

/** A round can only be drawn once its window has closed and it is still open. */
export function canDrawRound(phase: ChatRafflePhase): boolean {
  return phase === "ready";
}

/** Config + prizes stay editable until the draw freezes the round. */
export function canEditRound(phase: ChatRafflePhase): boolean {
  return phase === "scheduled" || phase === "running" || phase === "ready";
}

/**
 * Plain-English one-liner describing the scoring, for the config summary row.
 * Kept here so the page and the dialog can never describe the same config
 * two different ways.
 */
export function describeScoring(scoring: ChatRaffleScoring): string {
  const parts = [
    `${scoring.pointsPerMessage} pt/msg`,
    `≥${scoring.minMessageChars} chars`,
    `max ${scoring.maxMessagesPerBucket}/${scoring.bucketMinutes}min`,
  ];
  if (scoring.dedupeIdentical) parts.push("no repeats");
  return parts.join(" · ");
}
