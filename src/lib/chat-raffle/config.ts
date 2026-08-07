import { z } from "zod";

/**
 * config.ts — the scoring model of the Chat Raffle, in one client-safe file.
 *
 * Client-safe on purpose (no `server-only`, no DB import): the round dialog,
 * the standings table and the server-side scorer all read the SAME bounds and
 * labels, so the form can never offer a value the scorer rejects.
 *
 * ─── How a message becomes a ticket ──────────────────────────────────────
 *
 *   1. Only non-deleted `chat_messages` inside the round window count. A
 *      moderator soft-deleting spam retroactively removes its points, right
 *      up until the draw freezes the standings.
 *   2. A message shorter than `minMessageChars` (trimmed) scores nothing.
 *   3. Inside each `bucketMinutes` window a user gets at most
 *      `maxMessagesPerBucket` counted messages — this is the anti-farm cap.
 *      Everything above it in that bucket is dropped.
 *   4. With `dedupeIdentical`, the same text (trimmed, case-insensitive)
 *      counts once per bucket.
 *   5. A surviving message is worth `pointsPerMessage`.
 *   6. Manual per-user adjustments (chat_raffle_adjustments) are added.
 *   7. Anyone left on 0 or fewer points is out; otherwise 1 point = 1 ticket.
 *
 * Every knob lives on the ROUND, not in a global settings row, so retuning
 * the weights can never retroactively rewrite how a past round was scored.
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
const CHAT_RAFFLE_STATUSES = ["open", "drawn", "cancelled"] as const;
type ChatRaffleStatus = (typeof CHAT_RAFFLE_STATUSES)[number];

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
  "Staff, admins and creators never qualify",
  "Blacklisted users never qualify",
  "Muted users never qualify",
  "One user can win more than one place",
] as const;

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
const CHAT_RAFFLE_POSITION_COLORS: Record<number, string> = {
  1: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  2: "bg-zinc-400/15 text-zinc-500 dark:text-zinc-400 border-zinc-400/30",
  3: "bg-amber-700/15 text-amber-700 dark:text-amber-500 border-amber-700/30",
};

/** Fourth place and beyond. */
const CHAT_RAFFLE_POSITION_FALLBACK =
  "bg-muted text-muted-foreground border-border";

/** Medal class for a 1-based place. */
export function positionColor(position: number): string {
  return CHAT_RAFFLE_POSITION_COLORS[position] ?? CHAT_RAFFLE_POSITION_FALLBACK;
}

/** The scoring knobs of a round. */
export type ChatRaffleScoring = {
  pointsPerMessage: number;
  minMessageChars: number;
  bucketMinutes: number;
  maxMessagesPerBucket: number;
  dedupeIdentical: boolean;
};

/**
 * Defaults for a brand-new round when there is no previous one to copy.
 * Tuned to reward conversation over volume: 10 counted messages per 10
 * minutes is far above what a real chatter sends and far below what a
 * scripted spammer would want.
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
