import "server-only";

import { getDb } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { escapeBlacklistIds } from "@/lib/queries/_blacklist";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { CUSTOMER_EXCLUDED_ROLES } from "@/lib/metrics/scope";
import {
  CHAT_RAFFLE_MAX_ENTRIES,
  type ChatRaffleScoring,
} from "./config";

/**
 * standings.ts — turn chat activity into raffle tickets.
 *
 * READ-ONLY against the MAIN (prod game) DB. One aggregate over
 * `chat_messages`, bounded to the round window.
 *
 * ─── Index safety ────────────────────────────────────────────────────────
 *
 * The window predicate (`is_deleted = false AND created_at >= … AND < …`) is
 * served by the partial index `idx_chat_messages_created_at_user_id`
 * (created_at, user_id) WHERE is_deleted = false — applied + verified on prod,
 * see prisma/recommended-indexes.sql #33. The scorer additionally needs each
 * message's LENGTH and a dedupe key, which no index can cover, so the matched
 * rows are heap-fetched: an Index Scan over the window plus a heap visit per
 * row in it. That is bounded work — the window is capped at
 * CHAT_RAFFLE_MAX_WINDOW_DAYS and the whole table is small (~61k rows at the
 * time of writing) — but it is deliberately NOT a lifetime scan, and callers
 * must keep it behind `safeQuery` + a timeout.
 *
 * The scoring model itself is documented in ./config.ts.
 */

/**
 * `chat_messages.created_at` (and `user_mutes.*`) are `timestamp without time
 * zone`. Passing a JS Date through the pg driver would apply a timezone
 * conversion; the codebase's convention for these naive columns is to compare
 * against a naive 'YYYY-MM-DD HH:MM:SS' string built from the UTC instant
 * (same as the live race standings in src/lib/queries/races.ts).
 */
function toNaiveUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export type ChatRaffleStanding = {
  userId: string;
  username: string | null;
  image: string | null;
  role: string;
  messageCount: number;
  /** Points scored from chat activity alone. */
  basePoints: number;
  /** Signed total of the operator's manual corrections. */
  adjustmentPoints: number;
  /** basePoints + adjustmentPoints, clamped to the per-user cap. */
  points: number;
  /** 1 point = 1 ticket. */
  tickets: number;
  position: number;
  /** Share of the total ticket pool, 0–1. */
  winChance: number;
};

export type ChatRaffleStandings = {
  standings: ChatRaffleStanding[];
  totalTickets: number;
  entrants: number;
  /**
   * True when more eligible users existed than CHAT_RAFFLE_MAX_ENTRIES. Never
   * silently swallowed — the page surfaces it and the draw refuses to run.
   */
  truncated: boolean;
};

type ScoredRow = {
  user_id: string;
  username: string | null;
  image: string | null;
  role: string;
  message_count: number;
  base_points: number;
};

/**
 * Score every eligible chatter in the window and turn their points into
 * tickets.
 *
 * `adjustments` maps user_id → signed point delta (the operator's manual
 * corrections for this round). Applied AFTER the chat score and BEFORE the
 * per-user cap and the entry floor, so a correction can both rescue a user
 * who fell short and knock a farmer out of the draw.
 */
export async function getChatRaffleStandings(params: {
  startsAt: Date;
  endsAt: Date;
  scoring: ChatRaffleScoring;
  adjustments?: Map<string, number>;
  limit?: number;
}): Promise<ChatRaffleStandings> {
  const { startsAt, endsAt, scoring } = params;
  const adjustments = params.adjustments ?? new Map<string, number>();
  const limit = Math.min(params.limit ?? CHAT_RAFFLE_MAX_ENTRIES, CHAT_RAFFLE_MAX_ENTRIES);

  if (!(endsAt > startsAt)) {
    return { standings: [], totalTickets: 0, entrants: 0, truncated: false };
  }

  const db = await getDb();
  const bucketSeconds = scoring.bucketMinutes * 60;

  /**
   * Push the entry floor DOWN INTO the SQL.
   *
   * This matters for correctness, not just speed: the `LIMIT` below is what
   * decides `truncated`, and `truncated` BLOCKS the draw. If the floor were
   * only applied in JS afterwards, a round with a high floor and a busy chat
   * would fetch `limit` rows of unqualified chatters, report truncation, and
   * refuse to draw — while the real entrant count sat far under the cap.
   *
   * A positive manual adjustment can rescue a user who scored under the
   * floor, so the SQL threshold is lowered by the largest positive adjustment
   * in the round. That keeps every possible qualifier in the result set; the
   * exact per-user check still happens in JS below. Negative adjustments and
   * the per-user cap only ever push a total DOWN, so they can't produce a
   * qualifier that this bound excluded.
   */
  let maxPositiveAdjustment = 0;
  for (const points of adjustments.values()) {
    if (points > maxPositiveAdjustment) maxPositiveAdjustment = points;
  }
  const sqlPointsFloor = Math.max(
    1,
    scoring.minPointsToEnter - maxPositiveAdjustment,
  );

  // Eligibility fragments. Each is a hardcoded predicate — no user input is
  // interpolated; the blacklist ids go through the canonical escaper.
  const roleFilter = scoring.excludeStaff
    ? Prisma.raw(
        `AND u.role::text NOT IN (${CUSTOMER_EXCLUDED_ROLES.map((r) => `'${r}'`).join(", ")})`,
      )
    : Prisma.empty;

  let blacklistFilter: Prisma.Sql = Prisma.empty;
  if (scoring.excludeBlacklisted) {
    const excluded = await getExcludedUserIds();
    if (excluded.length > 0) {
      blacklistFilter = Prisma.raw(
        `AND s.user_id NOT IN (${escapeBlacklistIds(excluded)})`,
      );
    }
  }

  const muteFilter = scoring.excludeMuted
    ? Prisma.raw(`AND NOT EXISTS (
        SELECT 1 FROM user_mutes um
        WHERE um.user_id = s.user_id
          AND um.unmuted_at IS NULL
          AND (um.expires_at IS NULL OR um.expires_at > (now() AT TIME ZONE 'utc'))
      )`)
    : Prisma.empty;

  // Identical text counts once per bucket when the knob is on; otherwise the
  // dedupe rank is ignored.
  const dedupePredicate = scoring.dedupeIdentical
    ? Prisma.raw("WHERE d.dupe_rn = 1")
    : Prisma.empty;

  // One extra row so "more entrants than we render" is detectable rather than
  // silently truncated.
  const rows = await db.$queryRaw<ScoredRow[]>`
    WITH raw AS (
      SELECT
        cm.user_id,
        cm.created_at,
        length(btrim(cm.content))                                             AS len,
        lower(btrim(cm.content))                                              AS norm,
        floor(extract(epoch FROM cm.created_at) / ${bucketSeconds}::numeric)  AS bucket
      FROM chat_messages cm
      WHERE cm.is_deleted = false
        AND cm.created_at >= ${toNaiveUtc(startsAt)}::timestamp
        AND cm.created_at <  ${toNaiveUtc(endsAt)}::timestamp
        AND length(btrim(cm.content)) >= ${scoring.minMessageChars}
    ),
    deduped AS (
      SELECT raw.*,
             ROW_NUMBER() OVER (
               PARTITION BY raw.user_id, raw.bucket, raw.norm
               ORDER BY raw.created_at
             ) AS dupe_rn
      FROM raw
    ),
    kept AS (
      SELECT d.*,
             ROW_NUMBER() OVER (
               PARTITION BY d.user_id, d.bucket
               ORDER BY d.created_at
             ) AS bucket_rn
      FROM deduped d
      ${dedupePredicate}
    ),
    scored AS (
      SELECT
        k.user_id,
        COUNT(*)::int AS message_count,
        SUM(
          ${scoring.pointsPerMessage}::int
          + CASE WHEN k.len >= ${scoring.longMessageChars}::int
                 THEN ${scoring.longMessageBonusPoints}::int ELSE 0 END
        )::int AS base_points
      FROM kept k
      WHERE k.bucket_rn <= ${scoring.maxMessagesPerBucket}::int
      GROUP BY k.user_id
    )
    SELECT s.user_id, u.username, u.image, u.role::text AS role,
           s.message_count, s.base_points
    FROM scored s
    JOIN "user" u ON u.id = s.user_id
    WHERE s.base_points >= ${sqlPointsFloor}::int
      ${roleFilter}
      ${blacklistFilter}
      ${muteFilter}
    ORDER BY s.base_points DESC, s.user_id ASC
    LIMIT ${limit + 1}
  `;

  const truncated = rows.length > limit;
  const capped = truncated ? rows.slice(0, limit) : rows;

  // Fold in the manual adjustments, clamp, then drop everyone under the floor.
  // A user with ONLY an adjustment (never chatted) is deliberately not
  // resurrected here — the adjustment corrects a chatter's score, it is not a
  // back door for entering someone who never took part.
  const scoredEntries = capped
    .map((r) => {
      const adjustmentPoints = adjustments.get(r.user_id) ?? 0;
      const raw = r.base_points + adjustmentPoints;
      const clamped =
        scoring.maxPointsPerUser === null
          ? raw
          : Math.min(raw, scoring.maxPointsPerUser);
      const points = Math.max(0, clamped);
      return {
        userId: r.user_id,
        username: r.username,
        image: r.image,
        role: r.role,
        messageCount: r.message_count,
        basePoints: r.base_points,
        adjustmentPoints,
        points,
      };
    })
    .filter((e) => e.points >= scoring.minPointsToEnter)
    // Re-sort: adjustments and the cap can reorder the raw SQL ranking.
    .sort((a, b) =>
      b.points !== a.points ? b.points - a.points : a.userId.localeCompare(b.userId),
    );

  const totalTickets = scoredEntries.reduce((sum, e) => sum + e.points, 0);

  return {
    standings: scoredEntries.map((e, i) => ({
      ...e,
      tickets: e.points,
      position: i + 1,
      winChance: totalTickets > 0 ? e.points / totalTickets : 0,
    })),
    totalTickets,
    entrants: scoredEntries.length,
    truncated,
  };
}
