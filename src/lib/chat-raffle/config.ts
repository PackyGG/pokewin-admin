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
 *   5. A surviving message is worth `pointsPerMessage`, plus
 *      `longMessageBonusPoints` when it is at least `longMessageChars` long.
 *      That is the "weight" knob: it pays for saying something over spamming
 *      "gg".
 *   6. Manual per-user adjustments (chat_raffle_adjustments) are added.
 *   7. The total is clamped to `maxPointsPerUser` when set.
 *   8. Users below `minPointsToEnter` drop out of the draw entirely.
 *   9. 1 point = 1 ticket. Tickets are the draw weight.
 *
 * Every knob lives on the ROUND, not in a global settings row, so retuning
 * the weights can never retroactively rewrite how a past round was scored.
 */

/** Lifecycle flag persisted on the row. */
export const CHAT_RAFFLE_STATUSES = ["open", "drawn", "cancelled"] as const;
export type ChatRaffleStatus = (typeof CHAT_RAFFLE_STATUSES)[number];

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
 * rule governs amounts, and prize amounts below use it).
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

/** The scoring knobs of a round. */
export type ChatRaffleScoring = {
  pointsPerMessage: number;
  minMessageChars: number;
  longMessageChars: number;
  longMessageBonusPoints: number;
  bucketMinutes: number;
  maxMessagesPerBucket: number;
  dedupeIdentical: boolean;
  /** null = uncapped. */
  maxPointsPerUser: number | null;
  minPointsToEnter: number;
  excludeStaff: boolean;
  excludeBlacklisted: boolean;
  excludeMuted: boolean;
  allowRepeatWinners: boolean;
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
  longMessageChars: 40,
  longMessageBonusPoints: 1,
  bucketMinutes: 10,
  maxMessagesPerBucket: 10,
  dedupeIdentical: true,
  maxPointsPerUser: null,
  minPointsToEnter: 1,
  excludeStaff: true,
  excludeBlacklisted: true,
  excludeMuted: true,
  allowRepeatWinners: false,
};

/**
 * Hard ceiling on a round's window. The scorer reads every message in the
 * window (it needs the text length + dedupe key, which the covering index
 * can't supply), so an unbounded window would turn into a lifetime scan —
 * exactly what the Active-Timeframe-Only rule forbids.
 */
export const CHAT_RAFFLE_MAX_WINDOW_DAYS = 90;

/** Most rows the live standings table will render / the draw will snapshot. */
export const CHAT_RAFFLE_MAX_ENTRIES = 1000;

/** Most prize places one round can pay out. */
export const CHAT_RAFFLE_MAX_PRIZES = 20;

/** Single-prize ceiling — a typo guard on real money, not a policy. */
export const CHAT_RAFFLE_MAX_PRIZE_USD = 10_000;

export const chatRaffleScoringSchema = z.object({
  pointsPerMessage: z.number().int().min(1).max(100),
  minMessageChars: z.number().int().min(1).max(500),
  longMessageChars: z.number().int().min(1).max(2000),
  longMessageBonusPoints: z.number().int().min(0).max(100),
  bucketMinutes: z.number().int().min(1).max(1440),
  maxMessagesPerBucket: z.number().int().min(1).max(1000),
  dedupeIdentical: z.boolean(),
  maxPointsPerUser: z.number().int().min(1).max(1_000_000).nullable(),
  minPointsToEnter: z.number().int().min(1).max(100_000),
  excludeStaff: z.boolean(),
  excludeBlacklisted: z.boolean(),
  excludeMuted: z.boolean(),
  allowRepeatWinners: z.boolean(),
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
  ];
  if (scoring.longMessageBonusPoints > 0) {
    parts.push(
      `+${scoring.longMessageBonusPoints} at ${scoring.longMessageChars} chars`,
    );
  }
  parts.push(
    `max ${scoring.maxMessagesPerBucket}/${scoring.bucketMinutes}min`,
  );
  if (scoring.maxPointsPerUser !== null) {
    parts.push(`cap ${scoring.maxPointsPerUser} pts`);
  }
  return parts.join(" · ");
}
