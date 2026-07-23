"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminDb } from "@/lib/admin-db";
import {
  getUserPermissions,
  requirePageAccess,
  sessionIsAdmin,
  sessionIsOwner,
} from "@/lib/dal";
import { pageAccessGranted } from "@/lib/admin-pages";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { usdAmountSchema } from "@/lib/utils/money";
import {
  CHAT_RAFFLE_MAX_PRIZES,
  CHAT_RAFFLE_MAX_PRIZE_USD,
  CHAT_RAFFLE_MAX_WINDOW_DAYS,
  canDrawRound,
  canEditRound,
  chatRaffleScoringSchema,
  deriveRoundPhase,
} from "@/lib/chat-raffle/config";
import { drawWinners, generateDrawSeed } from "@/lib/chat-raffle/draw";
import {
  getRoundAdjustmentTotals,
  scoringFromRow,
  scoringToColumns,
} from "@/lib/chat-raffle/rounds";
import { getChatRaffleStandings } from "@/lib/chat-raffle/standings";
import { adjustBalance } from "@/app/(admin)/users/[id]/actions";

/**
 * Chat Raffle server actions.
 *
 * Everything writes the ADMIN DB only, with ONE exception: paying a winner
 * delegates to the existing `adjustBalance` action, which is the single
 * sanctioned main-DB balance path (balances update + ledger row in one
 * transaction, per-admin limits, wager-debt accrual, audit). It is reused
 * rather than reimplemented — and because it enforces its own
 * `requirePageAccess("/users")` + TOTP, paying a raffle prize requires the
 * operator to hold balance-adjustment access too. That is deliberate: a draw
 * is a raffle decision, a payout is a money decision.
 */

const MS_PER_DAY = 86_400_000;

/**
 * Revalidate BOTH raffle surfaces after a mutation.
 *
 * `revalidatePath("/chat-raffle")` alone does not cover `/chat-raffle/[id]`,
 * so paying a prize from a round's detail page used to leave that page
 * showing a stale "Pay" button after a successful payout. The second call
 * passes the route PATTERN + `"page"` so every round-detail instance is
 * invalidated, not just one id.
 */
function revalidateChatRaffle(): void {
  revalidatePath("/chat-raffle");
  revalidatePath("/chat-raffle/[id]", "page");
}

type ActionResult<T = undefined> =
  | ({ success: true } & (T extends undefined ? object : { data: T }))
  | { success: false; error: string };

const prizeInputSchema = z.object({
  position: z.number().int().min(1).max(CHAT_RAFFLE_MAX_PRIZES),
  amountUsd: usdAmountSchema()
    .refine((n) => n > 0, { message: "Prize amount must be positive" })
    .refine((n) => n <= CHAT_RAFFLE_MAX_PRIZE_USD, {
      message: `Prize amount can't exceed $${CHAT_RAFFLE_MAX_PRIZE_USD.toLocaleString()}`,
    }),
  label: z.string().trim().max(120).optional(),
});

const roundInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  scoring: chatRaffleScoringSchema,
  prizes: z.array(prizeInputSchema).min(1).max(CHAT_RAFFLE_MAX_PRIZES),
});

/** Window sanity + the hard cap that keeps the scorer off a lifetime scan. */
function validateWindow(
  startsAt: Date,
  endsAt: Date,
): { ok: true } | { ok: false; error: string } {
  if (!(endsAt > startsAt)) {
    return { ok: false, error: "The round must end after it starts" };
  }
  if (endsAt.getTime() - startsAt.getTime() > CHAT_RAFFLE_MAX_WINDOW_DAYS * MS_PER_DAY) {
    return {
      ok: false,
      error: `A round can't run longer than ${CHAT_RAFFLE_MAX_WINDOW_DAYS} days`,
    };
  }
  return { ok: true };
}

/** Positions must be 1..n with no gaps or duplicates. */
function validatePrizePositions(
  prizes: { position: number }[],
): { ok: true } | { ok: false; error: string } {
  const positions = prizes.map((p) => p.position).sort((a, b) => a - b);
  const expected = positions.every((p, i) => p === i + 1);
  if (!expected) {
    return { ok: false, error: "Prize places must be numbered 1, 2, 3 … with no gaps" };
  }
  return { ok: true };
}

export async function createChatRaffleRound(input: {
  name: string;
  startsAt: string;
  endsAt: string;
  scoring: z.infer<typeof chatRaffleScoringSchema>;
  prizes: { position: number; amountUsd: number; label?: string }[];
}): Promise<ActionResult<{ roundId: string }>> {
  const session = await requirePageAccess("/chat-raffle");

  const parsed = roundInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const startsAt = new Date(data.startsAt);
  const endsAt = new Date(data.endsAt);
  const window = validateWindow(startsAt, endsAt);
  if (!window.ok) return { success: false, error: window.error };
  const places = validatePrizePositions(data.prizes);
  if (!places.ok) return { success: false, error: places.error };

  const round = await adminDb.chat_raffle_rounds.create({
    data: {
      name: data.name,
      status: "open",
      starts_at: startsAt,
      ends_at: endsAt,
      created_by: session.userId,
      ...scoringToColumns(data.scoring),
      prizes: {
        create: data.prizes.map((p) => ({
          position: p.position,
          amount_usd: p.amountUsd,
          label: p.label || null,
        })),
      },
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "chat_raffle_round_created",
    metadata: {
      roundId: round.id,
      name: data.name,
      startsAt: data.startsAt,
      endsAt: data.endsAt,
      prizePoolUsd: data.prizes.reduce((sum, p) => sum + p.amountUsd, 0),
    },
  });

  revalidateChatRaffle();
  return { success: true, data: { roundId: round.id } };
}

export async function updateChatRaffleRound(input: {
  roundId: string;
  name: string;
  startsAt: string;
  endsAt: string;
  scoring: z.infer<typeof chatRaffleScoringSchema>;
  prizes: { position: number; amountUsd: number; label?: string }[];
}): Promise<ActionResult> {
  const session = await requirePageAccess("/chat-raffle");

  const parsed = roundInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const round = await adminDb.chat_raffle_rounds.findUnique({
    where: { id: input.roundId },
  });
  if (!round) return { success: false, error: "Round not found" };
  if (!canEditRound(deriveRoundPhase(round, new Date()))) {
    return { success: false, error: "A drawn or cancelled round can't be edited" };
  }

  const startsAt = new Date(data.startsAt);
  const endsAt = new Date(data.endsAt);
  const window = validateWindow(startsAt, endsAt);
  if (!window.ok) return { success: false, error: window.error };
  const places = validatePrizePositions(data.prizes);
  if (!places.ok) return { success: false, error: places.error };

  // Prizes are replaced wholesale. Safe because an editable round has no
  // winners yet (the phase guard above), so nothing with a payout link is
  // being thrown away.
  await adminDb.$transaction([
    adminDb.chat_raffle_prizes.deleteMany({ where: { round_id: round.id } }),
    adminDb.chat_raffle_rounds.update({
      where: { id: round.id },
      data: {
        name: data.name,
        starts_at: startsAt,
        ends_at: endsAt,
        ...scoringToColumns(data.scoring),
        prizes: {
          create: data.prizes.map((p) => ({
            position: p.position,
            amount_usd: p.amountUsd,
            label: p.label || null,
          })),
        },
      },
    }),
  ]);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "chat_raffle_round_updated",
    metadata: { roundId: round.id, name: data.name },
  });

  revalidateChatRaffle();
  return { success: true };
}

export async function cancelChatRaffleRound(input: {
  roundId: string;
}): Promise<ActionResult> {
  const session = await requirePageAccess("/chat-raffle");

  const round = await adminDb.chat_raffle_rounds.findUnique({
    where: { id: input.roundId },
  });
  if (!round) return { success: false, error: "Round not found" };
  if (round.status !== "open") {
    return { success: false, error: "Only an open round can be cancelled" };
  }

  await adminDb.chat_raffle_rounds.update({
    where: { id: round.id },
    data: { status: "cancelled" },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "chat_raffle_round_cancelled",
    metadata: { roundId: round.id, name: round.name },
  });

  revalidateChatRaffle();
  return { success: true };
}

const adjustmentSchema = z.object({
  roundId: z.string().uuid(),
  userId: z.string().trim().min(1).max(64),
  points: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((n) => n !== 0, { message: "A zero adjustment does nothing" }),
  reason: z.string().trim().min(3).max(500),
});

/**
 * Add a manual point correction for one user in one round. Additive — the
 * corrections stack and the history survives, so "who moved this user's
 * tickets, and why" is always answerable.
 */
export async function addChatRaffleAdjustment(input: {
  roundId: string;
  userId: string;
  points: number;
  reason: string;
}): Promise<ActionResult> {
  const session = await requirePageAccess("/chat-raffle");

  const parsed = adjustmentSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const round = await adminDb.chat_raffle_rounds.findUnique({
    where: { id: data.roundId },
  });
  if (!round) return { success: false, error: "Round not found" };
  if (!canEditRound(deriveRoundPhase(round, new Date()))) {
    return {
      success: false,
      error: "A drawn or cancelled round's points can't be changed",
    };
  }

  await adminDb.chat_raffle_adjustments.create({
    data: {
      round_id: data.roundId,
      user_id: data.userId,
      points: data.points,
      reason: data.reason,
      created_by: session.userId,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "chat_raffle_points_adjusted",
    targetUserId: data.userId,
    metadata: {
      roundId: data.roundId,
      points: data.points,
      reason: data.reason,
    },
  });

  revalidateChatRaffle();
  return { success: true };
}

/**
 * Close a round: freeze the standings, then pick a winner per prize place
 * with the seeded draw.
 *
 * The freeze is the point. The live scorer would return different numbers the
 * moment a moderator soft-deletes an old message, so the snapshot the draw ran
 * on is persisted and the round is never re-scored afterwards.
 */
export async function drawChatRaffleRound(input: {
  roundId: string;
}): Promise<ActionResult<{ winners: number }>> {
  const session = await requirePageAccess("/chat-raffle");

  const round = await adminDb.chat_raffle_rounds.findUnique({
    where: { id: input.roundId },
    include: { prizes: true },
  });
  if (!round) return { success: false, error: "Round not found" };

  const phase = deriveRoundPhase(round, new Date());
  if (!canDrawRound(phase)) {
    return {
      success: false,
      error:
        phase === "drawn"
          ? "This round has already been drawn"
          : phase === "cancelled"
            ? "This round was cancelled"
            : "The round window hasn't closed yet",
    };
  }
  if (round.prizes.length === 0) {
    return { success: false, error: "Add at least one prize before drawing" };
  }

  const scoring = scoringFromRow(round);
  const adjustments = await getRoundAdjustmentTotals(round.id);
  const { standings, totalTickets, entrants, truncated } =
    await getChatRaffleStandings({
      startsAt: round.starts_at,
      endsAt: round.ends_at,
      scoring,
      adjustments,
    });

  if (truncated) {
    // Refuse rather than draw from a silently clipped pool — the entrants
    // beyond the cap would have zero chance without anyone noticing.
    return {
      success: false,
      error:
        "Too many entrants to snapshot safely — drawing now would give everyone past the cut a silent zero chance. Shorten the round window or raise the minimum message length, then draw.",
    };
  }
  if (entrants === 0 || totalTickets === 0) {
    return { success: false, error: "Nobody qualified for this round" };
  }

  const seed = generateDrawSeed();

  // Cumulative ticket ranges, in display order — persisted so the draw can be
  // replayed from the snapshot alone.
  let cursor = 0;
  const entryRows = standings.map((s) => {
    const ticketStart = cursor;
    cursor += s.tickets;
    return {
      round_id: round.id,
      user_id: s.userId,
      username: s.username,
      message_count: s.messageCount,
      base_points: s.basePoints,
      adjustment_points: s.adjustmentPoints,
      tickets: s.tickets,
      ticket_start: BigInt(ticketStart),
      position: s.position,
    };
  });

  const winners = drawWinners({
    roundId: round.id,
    seed,
    entries: standings.map((s) => ({
      userId: s.userId,
      username: s.username,
      tickets: s.tickets,
    })),
    prizeCount: round.prizes.length,
  });

  const prizesByPosition = new Map(round.prizes.map((p) => [p.position, p]));

  // CLAIM the round inside the transaction, before writing anything else.
  // Two operators hitting Draw at the same moment would otherwise both pass
  // the phase check above, both generate their own seed, and both write a
  // DIFFERENT set of winners — last writer wins, with two "drawn" audit
  // events to explain it afterwards. The conditional status flip lets exactly
  // one through; the loser rolls back having written nothing.
  const CONCURRENT_DRAW = "chat-raffle:concurrent-draw";
  try {
    await adminDb.$transaction(async (tx) => {
      const claim = await tx.chat_raffle_rounds.updateMany({
        where: { id: round.id, status: "open" },
        data: {
          status: "drawn",
          draw_seed: seed,
          drawn_at: new Date(),
          drawn_by: session.userId,
          entrants_at_draw: entrants,
          tickets_at_draw: totalTickets,
        },
      });
      if (claim.count !== 1) throw new Error(CONCURRENT_DRAW);

      await tx.chat_raffle_entries.deleteMany({ where: { round_id: round.id } });
      await tx.chat_raffle_entries.createMany({ data: entryRows });

      for (const w of winners) {
        const prize = prizesByPosition.get(w.position);
        if (!prize) continue;
        await tx.chat_raffle_prizes.update({
          where: { id: prize.id },
          data: {
            winner_user_id: w.userId,
            winner_username: w.username,
            winner_tickets: w.tickets,
            winning_ticket: w.winningTicket,
          },
        });
      }
    });
  } catch (err) {
    if (err instanceof Error && err.message === CONCURRENT_DRAW) {
      return {
        success: false,
        error: "This round was just drawn by someone else. Reload to see the winners.",
      };
    }
    console.error("[drawChatRaffleRound] Transaction failed:", err);
    return { success: false, error: "Couldn't draw the round — please try again." };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "chat_raffle_round_drawn",
    metadata: {
      roundId: round.id,
      name: round.name,
      entrants,
      totalTickets,
      winners: winners.map((w) => ({
        position: w.position,
        userId: w.userId,
        tickets: w.tickets,
      })),
    },
  });

  revalidateChatRaffle();
  return { success: true, data: { winners: winners.length } };
}

/**
 * Credit a drawn winner's prize to their balance.
 *
 * Delegates to `adjustBalance` — the one sanctioned main-DB money path — with
 * the `chat_raffle` category, which stamps the round + place onto the ledger
 * row's metadata so the credit is traceable back to this draw. The prize row
 * is only marked paid AFTER the ledger write succeeds, so a failure here can
 * be retried without double-paying.
 */
export async function payChatRafflePrize(input: {
  prizeId: string;
  totpCode: string;
}): Promise<ActionResult<{ ledgerTxId: string }>> {
  const session = await requirePageAccess("/chat-raffle");

  // `adjustBalance` enforces `requirePageAccess("/users")` itself, but that
  // gate REDIRECTS rather than returning — which from inside this action would
  // yank the operator off the page with no explanation. Pre-check the same
  // grant here so the answer comes back as a clean toast instead.
  if (!sessionIsAdmin(session) && !sessionIsOwner(session)) {
    const allowed = await getUserPermissions(session.userId);
    if (!pageAccessGranted(allowed, "/users")) {
      return {
        success: false,
        error:
          "Paying a prize needs balance-adjustment access (/users). Ask an admin to draw or pay it.",
      };
    }
  }

  const prize = await adminDb.chat_raffle_prizes.findUnique({
    where: { id: input.prizeId },
    include: { round: true },
  });
  if (!prize) return { success: false, error: "Prize not found" };
  if (!prize.winner_user_id) {
    return { success: false, error: "This place hasn't been drawn yet" };
  }
  if (prize.paid_at) {
    return { success: false, error: "This prize has already been paid" };
  }

  const amount = Number(prize.amount_usd.toString());
  if (!(amount > 0)) {
    return { success: false, error: "Prize amount is not payable" };
  }

  // CLAIM the prize before moving any money. Two operators hitting Pay at the
  // same time would both pass the `paid_at` check above and both credit the
  // winner; this conditional update lets exactly one of them through. The
  // claim is released again if the credit fails, so a declined 2FA code is
  // retryable. If the process dies between the claim and the credit the prize
  // is left marked paid with no ledger link — visible, and recoverable by
  // hand, which is strictly better than double-paying real money.
  const claim = await adminDb.chat_raffle_prizes.updateMany({
    where: { id: prize.id, paid_at: null },
    data: { paid_at: new Date(), paid_by: session.userId },
  });
  if (claim.count !== 1) {
    return { success: false, error: "This prize is already being paid" };
  }

  const result = await adjustBalance({
    userId: prize.winner_user_id,
    amount,
    category: "chat_raffle",
    reason: `Chat raffle: ${prize.round.name} — place #${prize.position}`,
    totpCode: input.totpCode,
    details: {
      chatRaffleRoundId: prize.round_id,
      chatRafflePosition: prize.position,
    },
  });

  if (!result.success) {
    await adminDb.chat_raffle_prizes.updateMany({
      where: { id: prize.id, ledger_tx_id: null },
      data: { paid_at: null, paid_by: null },
    });
    return { success: false, error: result.error };
  }

  await adminDb.chat_raffle_prizes.update({
    where: { id: prize.id },
    data: { ledger_tx_id: result.ledgerTxId },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "chat_raffle_prize_paid",
    targetUserId: prize.winner_user_id,
    metadata: {
      roundId: prize.round_id,
      position: prize.position,
      amountUsd: amount,
      ledgerTxId: result.ledgerTxId,
    },
  });

  revalidateChatRaffle();
  return { success: true, data: { ledgerTxId: result.ledgerTxId } };
}
