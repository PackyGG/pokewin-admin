import "server-only";

import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { getProdReadDrizzleDb } from "@/lib/db";
import { enqueueDiscordEvent } from "@/lib/discord-notifications/router";
import { pgArrayParam } from "@/lib/drizzle-array-param";

export const RAIN_ABUSE_DETECTOR_VERSION = "rain-v1.2";
export const REWARD_ABUSE_PAGE_SIZE = 40;

export type RewardAbuseStatus = "pending" | "confirmed" | "dismissed";
export type RainAbuseMetrics = {
  entries: number;
  entryDays: number;
  wins: number;
  rainUsd: number;
  rainTipsUsd: number;
  netRainUsd: number;
  deposits30dUsd: number;
  lifetimeDepositsUsd: number;
  withdrawn30dUsd: number;
  lifetimeWithdrawnUsd: number;
  lifetimeRainUsd: number;
  lifetimeRainTipsUsd: number;
  wagerUsd: number;
  games: number;
  packGames: number;
  packWagerUsd: number;
  bonusFundedPackUsd: number;
  bonusFundedPackRatio: number;
  packGameRatio: number;
  tipsReceived30dUsd: number;
  sponsoredBattleReceived30dUsd: number;
};

export type RewardAbuseReview = {
  id: string;
  userId: string;
  username: string | null;
  status: RewardAbuseStatus;
  score: number;
  severity: "medium" | "high" | "critical";
  reasons: string[];
  metrics: RainAbuseMetrics;
  windowStartedAt: string;
  windowEndedAt: string;
  firstDetectedAt: string;
  lastDetectedAt: string;
  reviewedAt: string | null;
  reviewReason: string | null;
  reviewerUsername: string | null;
  rainLockApplied: boolean;
};

type CandidateRow = {
  user_id: string;
  username: string | null;
  entries: number;
  entry_days: number;
  wins: number;
  rain_usd: string;
  rain_tips_usd: string;
  deposits_30d_usd: string;
  lifetime_deposits_usd: string;
  withdrawn_30d_usd: string;
  lifetime_withdrawn_usd: string;
  lifetime_rain_usd: string;
  lifetime_rain_tips_usd: string;
  wager_usd: string;
  games: number;
  pack_games: number;
  pack_wager_usd: string;
  bonus_funded_pack_usd: string;
  tips_received_30d_usd: string;
  sponsored_battle_received_30d_usd: string;
};

function money(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0
    ? Math.round((numerator / denominator) * 1_000) / 1_000
    : 0;
}

export function scoreRainAbuse(metrics: RainAbuseMetrics): {
  score: number;
  reasons: string[];
} {
  let score = 0;
  const reasons: string[] = [];
  if (metrics.entries >= 75 && metrics.entryDays >= 14) {
    score += 30;
    reasons.push(`${metrics.entries} rain entries across ${metrics.entryDays} days`);
  }
  if (metrics.entries >= 180) {
    score += 20;
    reasons.push("Entered at least 180 rains in 30 days");
  }
  if (metrics.deposits30dUsd <= metrics.netRainUsd * 0.25) {
    score += 25;
    reasons.push("30-day deposits are at most 25% of net rain retained");
  }
  if (
    metrics.lifetimeDepositsUsd <=
    Math.max(10, Math.max(0, metrics.lifetimeRainUsd - metrics.lifetimeRainTipsUsd) * 2)
  ) {
    score += 15;
    reasons.push("Lifetime deposits are minimal compared with net rain retained");
  }
  if (metrics.wagerUsd <= metrics.netRainUsd * 5) {
    score += 15;
    reasons.push("Low real-money play compared with net rain retained");
  }
  if (
    metrics.packGames >= 3 &&
    metrics.packGameRatio >= 0.8 &&
    metrics.bonusFundedPackRatio >= 0.6
  ) {
    score += 20;
    reasons.push("Pack-heavy play is mostly funded from the general bonus balance");
  }
  if (metrics.rainTipsUsd >= metrics.rainUsd * 0.5) score -= 15;
  if (metrics.deposits30dUsd >= metrics.netRainUsd) score -= 25;
  if (
    metrics.lifetimeDepositsUsd >=
    Math.max(100, Math.max(0, metrics.lifetimeRainUsd - metrics.lifetimeRainTipsUsd) * 10)
  ) score -= 30;
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

async function loadRainCandidates(): Promise<CandidateRow[]> {
  const db = getProdReadDrizzleDb();
  const result = await db.execute<CandidateRow>(sql`
    WITH rain_activity AS (
      SELECT
        entry.user_id,
        count(*)::int AS entries,
        count(DISTINCT entry.created_at::date)::int AS entry_days
      FROM rain_entries AS entry
      JOIN rains AS rain ON rain.id = entry.rain_id
      WHERE entry.created_at >= now() - interval '30 days'
        AND rain.currency::text = 'real'
        AND rain.status::text = 'completed'
      GROUP BY entry.user_id
      HAVING count(*) >= 50
        AND count(DISTINCT entry.created_at::date) >= 7
    )
    SELECT
      activity.user_id,
      COALESCE(account.display_username, account.username, account.name) AS username,
      activity.entries,
      activity.entry_days,
      COALESCE(ledger.wins, 0)::int AS wins,
      COALESCE(ledger.rain_usd, 0)::text AS rain_usd,
      COALESCE(ledger.rain_tips_usd, 0)::text AS rain_tips_usd,
      COALESCE(ledger.deposits_30d_usd, 0)::text AS deposits_30d_usd,
      COALESCE(ledger.lifetime_deposits_usd, 0)::text AS lifetime_deposits_usd,
      (COALESCE(ledger.manual_withdrawn_30d_usd, 0) + COALESCE(withdrawal.withdrawn_30d_usd, 0))::text
        AS withdrawn_30d_usd,
      (COALESCE(balance.total_withdrawn::numeric, 0) + COALESCE(withdrawal.lifetime_withdrawn_usd, 0))::text
        AS lifetime_withdrawn_usd,
      COALESCE(ledger.lifetime_rain_usd, 0)::text AS lifetime_rain_usd,
      COALESCE(ledger.lifetime_rain_tips_usd, 0)::text AS lifetime_rain_tips_usd,
      COALESCE(ledger.wager_usd, 0)::text AS wager_usd,
      COALESCE(play.games, 0)::int AS games,
      COALESCE(play.pack_games, 0)::int AS pack_games,
      COALESCE(play.pack_wager_usd, 0)::text AS pack_wager_usd,
      COALESCE(play.bonus_funded_pack_usd, 0)::text AS bonus_funded_pack_usd,
      COALESCE(ledger.tips_received_30d_usd, 0)::text AS tips_received_30d_usd,
      COALESCE(sponsored.received_30d_usd, 0)::text AS sponsored_battle_received_30d_usd
    FROM rain_activity AS activity
    JOIN "user" AS account ON account.id = activity.user_id
    LEFT JOIN user_feature_locks AS feature_lock
      ON feature_lock.user_id = activity.user_id
    LEFT JOIN balances AS balance ON balance.user_id = activity.user_id
    JOIN LATERAL (
      SELECT
        count(*) FILTER (
          WHERE tx.type::text = 'rain_win'
            AND tx.created_at >= now() - interval '30 days'
        ) AS wins,
        sum(tx.amount::numeric) FILTER (
          WHERE tx.type::text = 'rain_win'
            AND tx.created_at >= now() - interval '30 days'
        ) AS rain_usd,
        sum(tx.amount::numeric) FILTER (
          WHERE tx.type::text = 'rain_tip'
            AND tx.created_at >= now() - interval '30 days'
        ) AS rain_tips_usd,
        sum(tx.amount::numeric) FILTER (
          WHERE tx.type::text = 'deposit'
            AND tx.created_at >= now() - interval '30 days'
        ) AS deposits_30d_usd,
        sum(tx.amount::numeric) FILTER (WHERE tx.type::text = 'deposit')
          AS lifetime_deposits_usd,
        sum(COALESCE(
          NULLIF(tx.metadata->>'withdrawal_amount_usd', '')::numeric,
          abs(tx.amount::numeric)
        )) FILTER (
          WHERE tx.type::text = 'admin_balance_adjustment'
            AND tx.description ILIKE 'Manual withdrawal:%'
            AND tx.created_at >= now() - interval '30 days'
        ) AS manual_withdrawn_30d_usd,
        sum(tx.amount::numeric) FILTER (WHERE tx.type::text = 'rain_win')
          AS lifetime_rain_usd,
        sum(tx.amount::numeric) FILTER (WHERE tx.type::text = 'rain_tip')
          AS lifetime_rain_tips_usd,
        sum(abs(tx.amount::numeric)) FILTER (
          WHERE tx.type::text IN ('pack_opening', 'battle_bet', 'upgrader_bet', 'keno_bet')
            AND tx.created_at >= now() - interval '30 days'
        ) AS wager_usd,
        sum(tx.amount::numeric) FILTER (
          WHERE tx.type::text = 'creator_tip'
            AND tx.created_at >= now() - interval '30 days'
            AND CASE
              WHEN tx.metadata->>'direction' = 'received' THEN true
              WHEN tx.metadata->>'direction' = 'sent' THEN false
              ELSE tx.balance_after::numeric > tx.balance_before::numeric
            END
        ) AS tips_received_30d_usd
      FROM ledger_transactions AS tx
      WHERE tx.user_id = activity.user_id AND tx.status::text = 'completed'
    ) AS ledger ON true
    LEFT JOIN LATERAL (
      SELECT
        count(*)::int AS games,
        count(*) FILTER (WHERE session.game_type::text = 'pack')::int AS pack_games,
        sum(session.bet_amount::numeric) FILTER (
          WHERE session.game_type::text = 'pack'
        ) AS pack_wager_usd,
        sum(LEAST(
          session.bet_amount::numeric,
          GREATEST(session.bet_from_bonus_other::numeric, 0)
        )) FILTER (WHERE session.game_type::text = 'pack') AS bonus_funded_pack_usd
      FROM game_sessions AS session
      WHERE session.user_id = activity.user_id
        AND session.currency::text = 'real'
        AND session.created_at >= now() - interval '30 days'
        AND session.bet_ledger_tx_id IS NOT NULL
        AND session.bet_amount::numeric > 0
    ) AS play ON true
    LEFT JOIN LATERAL (
      SELECT
        sum(request.total_value_usd::numeric) FILTER (
          WHERE COALESCE(request.shipped_at, request.completed_at) >= now() - interval '30 days'
        ) AS withdrawn_30d_usd,
        sum(request.total_value_usd::numeric) AS lifetime_withdrawn_usd
      FROM card_withdrawal_requests AS request
      WHERE request.user_id = activity.user_id
        AND request.status::text IN ('completed', 'shipped')
    ) AS withdrawal ON true
    LEFT JOIN LATERAL (
      SELECT sum(round(
        (COALESCE(items.value_usd, 0) + COALESCE(vouchers.value_usd, 0))
        * battle.sponsorship_percentage
      ) / 100) AS received_30d_usd
      FROM battle_participants AS participant
      JOIN battles AS battle ON battle.id = participant.battle_id
      LEFT JOIN LATERAL (
        SELECT sum(inventory.value_at_obtained::numeric) AS value_usd
        FROM user_inventory AS inventory
        WHERE inventory.user_id = activity.user_id
          AND inventory.source_type::text = 'battle'
          AND inventory.source_id = participant.game_session_id
      ) AS items ON true
      LEFT JOIN LATERAL (
        SELECT sum(voucher.value::numeric) AS value_usd
        FROM vouchers AS voucher
        WHERE voucher.user_id = activity.user_id
          AND voucher.origin::text = 'battle_excess_to_voucher'
          AND voucher.origin_id = participant.game_session_id
      ) AS vouchers ON true
      WHERE participant.user_id = activity.user_id
        AND participant.created_at >= now() - interval '30 days'
        AND battle.currency::text = 'real'
        AND battle.status::text = 'completed'
        AND battle.sponsorship_percentage > 0
    ) AS sponsored ON true
    WHERE COALESCE(ledger.rain_usd, 0) >= 2
      AND account.role::text = 'user'
      AND NOT (account.roles && ARRAY['support', 'admin', 'creator']::user_role[])
      AND NOT ('rain' = ANY(COALESCE(feature_lock.locked_reward_categories, '{}'::text[])))
    ORDER BY activity.entries DESC
    LIMIT 500
  `);
  return result.rows;
}

function candidateMetrics(row: CandidateRow): RainAbuseMetrics {
  const games = Number(row.games);
  const packGames = Number(row.pack_games);
  const packWagerUsd = money(row.pack_wager_usd);
  const bonusFundedPackUsd = money(row.bonus_funded_pack_usd);
  const rainUsd = money(row.rain_usd);
  const rainTipsUsd = money(row.rain_tips_usd);
  return {
    entries: Number(row.entries),
    entryDays: Number(row.entry_days),
    wins: Number(row.wins),
    rainUsd,
    rainTipsUsd,
    netRainUsd: Math.max(0, Math.round((rainUsd - rainTipsUsd) * 100) / 100),
    deposits30dUsd: money(row.deposits_30d_usd),
    lifetimeDepositsUsd: money(row.lifetime_deposits_usd),
    withdrawn30dUsd: money(row.withdrawn_30d_usd),
    lifetimeWithdrawnUsd: money(row.lifetime_withdrawn_usd),
    lifetimeRainUsd: money(row.lifetime_rain_usd),
    lifetimeRainTipsUsd: money(row.lifetime_rain_tips_usd),
    wagerUsd: money(row.wager_usd),
    games,
    packGames,
    packWagerUsd,
    bonusFundedPackUsd,
    bonusFundedPackRatio: ratio(bonusFundedPackUsd, packWagerUsd),
    packGameRatio: ratio(packGames, games),
    tipsReceived30dUsd: money(row.tips_received_30d_usd),
    sponsoredBattleReceived30dUsd: money(row.sponsored_battle_received_30d_usd),
  };
}

export async function runRainAbuseDetection(): Promise<{
  scanned: number;
  qualified: number;
  created: number;
  updated: number;
  discordEnqueued: number;
}> {
  const candidates = await loadRainCandidates();
  const windowEndedAt = new Date();
  const windowStartedAt = new Date(windowEndedAt.getTime() - 30 * 86_400_000);
  let qualified = 0;
  let created = 0;
  let updated = 0;

  for (const candidate of candidates) {
    const metrics = candidateMetrics(candidate);
    const scored = scoreRainAbuse(metrics);
    const lowRecentDeposits = metrics.deposits30dUsd <= metrics.netRainUsd * 0.25;
    const lowRealPlay = metrics.wagerUsd <= metrics.netRainUsd * 5;
    const paidPackPattern =
      metrics.packGames >= 3 &&
      metrics.packGameRatio >= 0.8 &&
      metrics.bonusFundedPackRatio >= 0.6;
    // Frequency alone is not abuse. Rain is wager-weighted, so a legitimate
    // active player can enter often and earn more. Require meaningful net
    // extraction, minimal deposits, and either little paid play or the
    // paid-pack/general-bonus behavior the detector is intended to review.
    if (
      metrics.netRainUsd < 2 ||
      !lowRecentDeposits ||
      (!lowRealPlay && !paidPackPattern) ||
      scored.score < 60
    ) continue;
    qualified += 1;
    const severity = scored.score >= 90 ? "critical" : scored.score >= 75 ? "high" : "medium";
    const result = await adminDrizzle.execute<{ id: string; inserted: boolean }>(sql`
      INSERT INTO reward_abuse_reviews (
        target_user_id, target_username, detector, detector_version, score,
        severity, window_started_at, window_ended_at, metrics, reasons
      )
      SELECT
        ${candidate.user_id}, ${candidate.username}, 'rain_farming',
        ${RAIN_ABUSE_DETECTOR_VERSION}, ${scored.score}, ${severity},
        ${windowStartedAt.toISOString()}::timestamptz,
        ${windowEndedAt.toISOString()}::timestamptz,
        ${JSON.stringify(metrics)}::jsonb, ${pgArrayParam(scored.reasons)}::text[]
      WHERE NOT EXISTS (
        SELECT 1 FROM reward_abuse_reviews previous
        WHERE previous.target_user_id = ${candidate.user_id}
          AND previous.detector = 'rain_farming'
          AND (
            previous.status IN ('confirmed', 'dismissed')
            AND previous.reviewed_at >= now() - interval '30 days'
          )
      )
      ON CONFLICT (target_user_id, detector) WHERE status = 'pending'
      DO UPDATE SET
        target_username = EXCLUDED.target_username,
        detector_version = EXCLUDED.detector_version,
        score = EXCLUDED.score,
        severity = EXCLUDED.severity,
        window_started_at = EXCLUDED.window_started_at,
        window_ended_at = EXCLUDED.window_ended_at,
        metrics = EXCLUDED.metrics,
        reasons = EXCLUDED.reasons,
        last_detected_at = now(),
        updated_at = now()
      RETURNING id::text, (xmax = 0) AS inserted
    `);
    const review = result.rows[0];
    if (!review) continue;
    if (review.inserted) {
      created += 1;
    } else updated += 1;
  }

  let discordEnqueued = 0;
  const unalerted = await adminDrizzle.execute<{ id: string; score: number }>(sql`
    SELECT id::text, score
    FROM reward_abuse_reviews
    WHERE status = 'pending' AND discord_alerted_at IS NULL
    ORDER BY created_at, id
    LIMIT 500
  `);
  if (unalerted.rows.length > 0) {
    const batch = unalerted.rows;
    const critical = batch.filter((review) => review.score >= 90).length;
    const high = batch.filter((review) => review.score >= 75 && review.score < 90).length;
    const dashboardUrl = "https://fraud.packydash.com/reward-abuse";
    const queued = await enqueueDiscordEvent({
      guildId: process.env.ADMIN_GUILD_ID ?? "",
      eventKey: "antifraud.reward_abuse_rain",
      dedupeKey: `rain-abuse-batch:${batch[0].id}:${batch[batch.length - 1].id}`,
      embed: {
        title: "🌧️ Rain reward-abuse reviews ready",
        color: critical > 0 ? 0xef4444 : high > 0 ? 0xf97316 : 0xf59e0b,
        url: dashboardUrl,
        fields: [
          { name: "New reviews", value: String(batch.length), inline: true },
          { name: "High / critical", value: `${high} / ${critical}`, inline: true },
          { name: "Detector", value: "Rain farming · 30-day behavior", inline: true },
        ],
        footer: { text: `Reward Abuse Monitor · ${RAIN_ABUSE_DETECTOR_VERSION}` },
        timestamp: windowEndedAt.toISOString(),
      },
    });
    discordEnqueued = queued.enqueued;
    if (queued.enqueued > 0 || queued.duplicate > 0) {
      await adminDrizzle.execute(sql`
        UPDATE reward_abuse_reviews
        SET discord_alerted_at = now(), updated_at = now()
        WHERE id = ANY(${pgArrayParam(batch.map((review) => review.id))}::uuid[])
          AND discord_alerted_at IS NULL
      `);
    }
  }
  return { scanned: candidates.length, qualified, created, updated, discordEnqueued };
}

type ReviewRow = {
  id: string;
  target_user_id: string;
  target_username: string | null;
  status: RewardAbuseStatus;
  score: number;
  severity: "medium" | "high" | "critical";
  reasons: string[];
  metrics: RainAbuseMetrics;
  window_started_at: string;
  window_ended_at: string;
  first_detected_at: string;
  last_detected_at: string;
  reviewed_at: string | null;
  review_reason: string | null;
  reviewer_username: string | null;
  rain_lock_applied: boolean;
};

function mapReview(row: ReviewRow): RewardAbuseReview {
  return {
    id: row.id, userId: row.target_user_id, username: row.target_username,
    status: row.status, score: row.score, severity: row.severity,
    reasons: row.reasons, metrics: row.metrics,
    windowStartedAt: row.window_started_at, windowEndedAt: row.window_ended_at,
    firstDetectedAt: row.first_detected_at, lastDetectedAt: row.last_detected_at,
    reviewedAt: row.reviewed_at, reviewReason: row.review_reason,
    reviewerUsername: row.reviewer_username, rainLockApplied: row.rain_lock_applied,
  };
}

export async function listRewardAbuseReviews(input: {
  status: RewardAbuseStatus;
  search?: string;
}): Promise<RewardAbuseReview[]> {
  const search = input.search?.trim() || null;
  const result = await adminDrizzle.execute<ReviewRow>(sql`
    SELECT review.id::text, review.target_user_id, review.target_username,
      review.status, review.score, review.severity, review.reasons, review.metrics,
      review.window_started_at::text, review.window_ended_at::text,
      review.first_detected_at::text, review.last_detected_at::text,
      review.reviewed_at::text, review.review_reason, reviewer.username AS reviewer_username,
      review.rain_lock_applied
    FROM reward_abuse_reviews review
    LEFT JOIN admin_users reviewer ON reviewer.id = review.reviewed_by
    WHERE review.status = ${input.status}
      AND (${search}::text IS NULL OR review.target_user_id ILIKE '%' || ${search} || '%'
        OR COALESCE(review.target_username, '') ILIKE '%' || ${search} || '%')
    ORDER BY review.score DESC, review.last_detected_at DESC, review.id DESC
    LIMIT ${REWARD_ABUSE_PAGE_SIZE}
  `);
  return result.rows.map(mapReview);
}

export async function getRewardAbuseCounts(): Promise<Record<RewardAbuseStatus, number>> {
  const result = await adminDrizzle.execute<{ status: RewardAbuseStatus; count: number }>(sql`
    SELECT status, count(*)::int AS count FROM reward_abuse_reviews GROUP BY status
  `);
  const counts = { pending: 0, confirmed: 0, dismissed: 0 };
  for (const row of result.rows) counts[row.status] = Number(row.count);
  return counts;
}
