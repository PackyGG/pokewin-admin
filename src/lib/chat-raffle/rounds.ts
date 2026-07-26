import "server-only";

import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/drizzle";
import {
  admin_users,
  chat_raffle_adjustments,
  chat_raffle_entries,
  chat_raffle_prizes,
  chat_raffle_rounds,
} from "@/lib/db-schema/admin/schema";
import {
  DEFAULT_CHAT_RAFFLE_SCORING,
  deriveRoundPhase,
  type ChatRafflePhase,
  type ChatRaffleScoring,
} from "./config";

/**
 * rounds.ts — the admin-DB side of the Chat Raffle.
 *
 * Everything here reads/writes the ADMIN database only. The main DB is
 * touched by ./standings.ts (read-only scoring) and, when a winner is paid,
 * by the existing `adjustBalance` server action — nowhere else.
 */

/**
 * The persisted row shape the scoring knobs live on.
 *
 * Eligibility (staff/blacklist/mute) and repeat winners are NOT here: they
 * are fixed rules, not per-round columns — see CHAT_RAFFLE_FIXED_RULES.
 */
type RoundConfigColumns = {
  points_per_message: number;
  min_message_chars: number;
  bucket_minutes: number;
  max_messages_per_bucket: number;
  dedupe_identical: boolean;
};

/** DB row → the typed scoring config the scorer + the form both speak. */
export function scoringFromRow(row: RoundConfigColumns): ChatRaffleScoring {
  return {
    pointsPerMessage: row.points_per_message,
    minMessageChars: row.min_message_chars,
    bucketMinutes: row.bucket_minutes,
    maxMessagesPerBucket: row.max_messages_per_bucket,
    dedupeIdentical: row.dedupe_identical,
  };
}

/** Typed scoring config → the column bag for a create/update. */
export function scoringToColumns(s: ChatRaffleScoring): RoundConfigColumns {
  return {
    points_per_message: s.pointsPerMessage,
    min_message_chars: s.minMessageChars,
    bucket_minutes: s.bucketMinutes,
    max_messages_per_bucket: s.maxMessagesPerBucket,
    dedupe_identical: s.dedupeIdentical,
  };
}

export type ChatRafflePrizeView = {
  id: string;
  position: number;
  amountUsd: number;
  label: string | null;
  winnerUserId: string | null;
  winnerUsername: string | null;
  winnerTickets: number | null;
  paidAt: string | null;
  ledgerTxId: string | null;
};

export type ChatRaffleRoundView = {
  id: string;
  name: string;
  status: string;
  phase: ChatRafflePhase;
  startsAt: string;
  endsAt: string;
  scoring: ChatRaffleScoring;
  prizePoolUsd: number;
  prizes: ChatRafflePrizeView[];
  drawnAt: string | null;
  entrantsAtDraw: number | null;
  ticketsAtDraw: number | null;
  drawSeed: string | null;
  /** How many prizes still owe the winner their balance. */
  unpaidPrizes: number;
};

type RoundWithPrizes = RoundConfigColumns & {
  id: string;
  name: string;
  status: string;
  starts_at: string;
  ends_at: string;
  drawn_at: string | null;
  draw_seed: string | null;
  entrants_at_draw: number | null;
  tickets_at_draw: number | null;
  prizes: {
    id: string;
    position: number;
    amount_usd: string;
    label: string | null;
    winner_user_id: string | null;
    winner_username: string | null;
    winner_tickets: number | null;
    paid_at: string | null;
    ledger_tx_id: string | null;
  }[];
};

/**
 * Money is Decimal(20,2) in the DB. Go through `toString()` → `Number` and
 * never touch the Decimal with JS float arithmetic (house rule).
 */
function decimalToNumber(d: { toString(): string } | string): number {
  return Number(d.toString());
}

function toRoundView(row: RoundWithPrizes, now: Date): ChatRaffleRoundView {
  const prizes = row.prizes
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((p) => ({
      id: p.id,
      position: p.position,
      amountUsd: decimalToNumber(p.amount_usd),
      label: p.label,
      winnerUserId: p.winner_user_id,
      winnerUsername: p.winner_username,
      winnerTickets: p.winner_tickets,
      paidAt: p.paid_at ? new Date(p.paid_at).toISOString() : null,
      ledgerTxId: p.ledger_tx_id,
    }));

  return {
    id: row.id,
    name: row.name,
    status: row.status,
    phase: deriveRoundPhase(
      {
        ...row,
        starts_at: new Date(row.starts_at),
        ends_at: new Date(row.ends_at),
      },
      now,
    ),
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    scoring: scoringFromRow(row),
    prizePoolUsd: prizes.reduce((sum, p) => sum + p.amountUsd, 0),
    prizes,
    drawnAt: row.drawn_at ? new Date(row.drawn_at).toISOString() : null,
    entrantsAtDraw: row.entrants_at_draw,
    ticketsAtDraw: row.tickets_at_draw,
    drawSeed: row.draw_seed,
    unpaidPrizes: prizes.filter((p) => p.winnerUserId && !p.paidAt).length,
  };
}

async function attachPrizes(
  rows: Array<Omit<RoundWithPrizes, "prizes">>,
): Promise<RoundWithPrizes[]> {
  if (rows.length === 0) return [];
  const prizes = await adminDrizzle
    .select()
    .from(chat_raffle_prizes)
    .where(inArray(chat_raffle_prizes.round_id, rows.map((row) => row.id)))
    .orderBy(asc(chat_raffle_prizes.position));
  const byRound = new Map<string, RoundWithPrizes["prizes"]>();
  for (const prize of prizes) {
    const list = byRound.get(prize.round_id) ?? [];
    list.push(prize);
    byRound.set(prize.round_id, list);
  }
  return rows.map((row) => ({ ...row, prizes: byRound.get(row.id) ?? [] }));
}

/**
 * The round the page opens on.
 *
 * Picks by URGENCY, not just recency: a round whose window has closed and is
 * waiting to be drawn outranks one that is still running, which outranks one
 * that hasn't started. Ordering by date alone would let a round scheduled for
 * next month hide the one that needs drawing today. Ties break newest-first.
 *
 * Null when every round has been drawn or cancelled — the page then falls
 * back to a live preview of today.
 */
const PHASE_PRIORITY: Record<ChatRafflePhase, number> = {
  ready: 0,
  running: 1,
  scheduled: 2,
  drawn: 3,
  cancelled: 4,
};

/**
 * Pick the round to feature out of an already-fetched list. Exported so the
 * page's history section can exclude the SAME round the active section is
 * showing without issuing a second query.
 */
export function pickActiveRound(
  rounds: ChatRaffleRoundView[],
): ChatRaffleRoundView | null {
  const open = rounds.filter((r) => r.status === "open");
  if (open.length === 0) return null;
  // Array.sort is stable, so equal-phase rounds keep the caller's
  // newest-first order.
  return open
    .slice()
    .sort((a, b) => PHASE_PRIORITY[a.phase] - PHASE_PRIORITY[b.phase])[0];
}

export async function getActiveChatRaffleRound(): Promise<ChatRaffleRoundView | null> {
  const now = new Date();
  const rows = await attachPrizes(
    await adminDrizzle
      .select()
      .from(chat_raffle_rounds)
      .where(eq(chat_raffle_rounds.status, "open"))
      .orderBy(desc(chat_raffle_rounds.starts_at))
      .limit(50),
  );
  return pickActiveRound(rows.map((r) => toRoundView(r, now)));
}

export async function getChatRaffleRound(
  id: string,
): Promise<ChatRaffleRoundView | null> {
  const row = (
    await attachPrizes(
      await adminDrizzle
        .select()
        .from(chat_raffle_rounds)
        .where(eq(chat_raffle_rounds.id, id))
        .limit(1),
    )
  )[0];
  return row ? toRoundView(row, new Date()) : null;
}

/** Every round, newest first. Small table — one page is the whole history. */
export async function getChatRaffleRounds(
  limit = 50,
): Promise<ChatRaffleRoundView[]> {
  const now = new Date();
  const rows = await attachPrizes(
    await adminDrizzle
      .select()
      .from(chat_raffle_rounds)
      .orderBy(desc(chat_raffle_rounds.starts_at))
      .limit(Math.min(Math.max(limit, 1), 200)),
  );
  return rows.map((r) => toRoundView(r, now));
}

/** user_id → signed point delta, summed across the round's corrections. */
export async function getRoundAdjustmentTotals(
  roundId: string,
): Promise<Map<string, number>> {
  const grouped = await adminDrizzle
    .select({
      user_id: chat_raffle_adjustments.user_id,
      points: sql<number>`COALESCE(SUM(${chat_raffle_adjustments.points}), 0)::int`,
    })
    .from(chat_raffle_adjustments)
    .where(eq(chat_raffle_adjustments.round_id, roundId))
    .groupBy(chat_raffle_adjustments.user_id);
  return new Map(grouped.map((g) => [g.user_id, g.points]));
}

export type ChatRaffleAdjustmentView = {
  id: string;
  userId: string;
  points: number;
  reason: string;
  createdAt: string;
  adminUsername: string | null;
};

export async function getRoundAdjustments(
  roundId: string,
): Promise<ChatRaffleAdjustmentView[]> {
  const rows = await adminDrizzle
    .select({
      id: chat_raffle_adjustments.id,
      user_id: chat_raffle_adjustments.user_id,
      points: chat_raffle_adjustments.points,
      reason: chat_raffle_adjustments.reason,
      created_at: chat_raffle_adjustments.created_at,
      adminUsername: admin_users.username,
    })
    .from(chat_raffle_adjustments)
    .leftJoin(admin_users, eq(admin_users.id, chat_raffle_adjustments.created_by))
    .where(eq(chat_raffle_adjustments.round_id, roundId))
    .orderBy(desc(chat_raffle_adjustments.created_at));
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    points: r.points,
    reason: r.reason,
    createdAt: new Date(r.created_at).toISOString(),
    adminUsername: r.adminUsername,
  }));
}

export type ChatRaffleEntryView = {
  userId: string;
  username: string | null;
  messageCount: number;
  basePoints: number;
  adjustmentPoints: number;
  tickets: number;
  position: number;
};

/** The frozen snapshot a drawn round was decided on. */
export async function getRoundEntries(
  roundId: string,
  limit = 200,
): Promise<ChatRaffleEntryView[]> {
  const rows = await adminDrizzle
    .select()
    .from(chat_raffle_entries)
    .where(eq(chat_raffle_entries.round_id, roundId))
    .orderBy(asc(chat_raffle_entries.position))
    .limit(Math.min(Math.max(limit, 1), 1_000));
  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    messageCount: r.message_count,
    basePoints: r.base_points,
    adjustmentPoints: r.adjustment_points,
    tickets: r.tickets,
    position: r.position,
  }));
}

/**
 * Scoring defaults for a NEW round: copy the most recent round so an operator
 * doesn't re-type a tuned config every week. Falls back to the built-in
 * defaults for the very first round.
 */
export async function getDefaultScoringForNewRound(): Promise<ChatRaffleScoring> {
  const latest = (
    await adminDrizzle
      .select()
      .from(chat_raffle_rounds)
      .orderBy(desc(chat_raffle_rounds.created_at))
      .limit(1)
  )[0];
  return latest ? scoringFromRow(latest) : DEFAULT_CHAT_RAFFLE_SCORING;
}
