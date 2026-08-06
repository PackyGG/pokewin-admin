import type { FastifyBaseLogger } from "fastify";

import type { Databases } from "./db.js";
import { findNetworkClusterHighRiskMembers } from "./network-risk.js";
import { severity } from "./scoring.js";

const STREAM = "fresh-behavior-v1";
const BATCH_SIZE = 100;
// Additive score bump applied when a candidate (or, for creator-tip rows, the tip sender)
// belongs to a confirmed high-risk network cluster. Capped by the existing 100-point ceiling
// used everywhere else in this file -- it never opens a new containment path, only raises the
// score/severity that the existing containment-required rows already carry.
const NETWORK_CLUSTER_SCORE_BONUS = 30;

type Candidate = {
  user_id: string;
  username: string | null;
  email: string | null;
  signup_ip: string | null;
  country: string | null;
  country_code: string | null;
  source_created_at: Date;
  is_creator: boolean;
  event_type: string;
  source: string;
  source_ref: string;
  title: string;
  detail: string;
  score: number;
  containment_required: boolean;
  reason_code: string;
  occurred_at: Date;
  payload: Record<string, unknown>;
};

export function isExpectedCreatorBehavior(
  isCreator: boolean,
  eventType: string,
): boolean {
  return isCreator
    && (
      eventType === "fresh_creator_tip"
      || eventType === "fresh_sponsored_battle"
    );
}

export class FreshBehaviorMonitor {
  constructor(
    private readonly db: Databases,
    private readonly log: FastifyBaseLogger,
  ) {}

  async ensureCursor(): Promise<void> {
    await this.db.antifraud.query(
      `
        INSERT INTO source_cursors(stream, occurred_at, source_id)
        VALUES ($1, now() - interval '2 minutes', '')
        ON CONFLICT (stream) DO NOTHING
      `,
      [STREAM],
    );
  }

  async process(): Promise<number> {
    const cursor = await this.db.antifraud.query<{
      occurred_at: Date;
      source_id: string;
    }>(
      "SELECT occurred_at, source_id FROM source_cursors WHERE stream=$1",
      [STREAM],
    );
    const current = cursor.rows[0];
    if (!current) return 0;
    const candidates = await this.fetch(current);
    await this.applyNetworkClusterSignal(candidates);
    let processed = 0;
    for (const candidate of candidates) {
      await this.persist(candidate);
      processed += 1;
    }
    if (processed > 0) {
      this.log.info({ processed }, "Fresh behavior monitor advanced");
    }
    return processed;
  }

  private async fetch(cursor: {
    occurred_at: Date;
    source_id: string;
  }): Promise<Candidate[]> {
    const result = await this.db.source.query<Candidate>(
      `
        WITH candidates AS (
          SELECT
            account.id AS user_id,
            account.username,
            account.email,
            account.signup_ip,
            account.country,
            account.country_code,
            account.created_at AT TIME ZONE 'UTC' AS source_created_at,
            (
              COALESCE(account.role::text, '') = 'creator'
              OR 'creator' = ANY(COALESCE(account.roles::text[], ARRAY[]::text[]))
            ) AS is_creator,
            CASE
              WHEN ledger.type::text = 'promo_code_redeemed'
                THEN 'fresh_third_promo_redemption'
              WHEN ledger.type::text = 'creator_tip'
                THEN 'fresh_creator_tip'
              ELSE 'fresh_minimum_withdrawal_runup'
            END AS event_type,
            'ledger' AS source,
            ledger.id::text AS source_ref,
            CASE
              WHEN ledger.type::text = 'promo_code_redeemed'
                THEN 'Third promo redemption on fresh account'
              WHEN ledger.type::text = 'creator_tip'
                THEN 'Creator tip immediately after signup'
              ELSE 'Quick reward run-up to minimum withdrawal'
            END AS title,
            CASE
              WHEN ledger.type::text = 'promo_code_redeemed'
                THEN 'The account redeemed its third promotion within 30 days of signup.'
              WHEN ledger.type::text = 'creator_tip'
                THEN 'A normal account received a creator tip within 15 minutes of signup.'
              ELSE 'Reward-derived value reached the minimum withdrawal level before any completed deposit.'
            END AS detail,
            CASE
              WHEN ledger.type::text = 'promo_code_redeemed' THEN 100
              WHEN ledger.type::text = 'creator_tip'
                AND (
                  sender.is_banned
                  OR sender.is_locked
                  OR sender.is_suspected_alt
                  OR COALESCE(sender_kyc.kyc_required, false)
                  OR COALESCE(sender_locks.locked_withdrawals_items, false)
                  OR COALESCE(cardinality(sender_locks.locked_withdrawals_crypto), 0) > 0
                )
                THEN 100
              WHEN ledger.type::text = 'creator_tip' THEN 70
              ELSE 55
            END AS score,
            ledger.type::text IN ('promo_code_redeemed','creator_tip')
              AS containment_required,
            CASE
              WHEN ledger.type::text = 'promo_code_redeemed'
                THEN 'promotion.third_redemption'
              WHEN ledger.type::text = 'creator_tip'
                AND (
                  sender.is_banned
                  OR sender.is_locked
                  OR sender.is_suspected_alt
                  OR COALESCE(sender_kyc.kyc_required, false)
                  OR COALESCE(sender_locks.locked_withdrawals_items, false)
                  OR COALESCE(cardinality(sender_locks.locked_withdrawals_crypto), 0) > 0
                )
                THEN 'funds.restricted_downstream_active_use'
              WHEN ledger.type::text = 'creator_tip' THEN 'fresh_creator_tip'
              ELSE 'fresh_minimum_withdrawal_runup'
            END AS reason_code,
            ledger.created_at AT TIME ZONE 'UTC' AS occurred_at,
            jsonb_build_object(
              'ledgerId', ledger.id::text,
              'ledgerType', ledger.type::text,
              'amountUsd', ledger.amount::text,
              'senderUserId', NULLIF(ledger.metadata->>'sender_user_id', ''),
              'senderRestricted', (
                sender.is_banned
                OR sender.is_locked
                OR sender.is_suspected_alt
                OR COALESCE(sender_kyc.kyc_required, false)
                OR COALESCE(sender_locks.locked_withdrawals_items, false)
                OR COALESCE(cardinality(sender_locks.locked_withdrawals_crypto), 0) > 0
              ),
              'promoCount30d', CASE
                WHEN ledger.type::text = 'promo_code_redeemed'
                  THEN (
                    SELECT COUNT(*)::int
                    FROM ledger_transactions promo
                    WHERE promo.user_id = ledger.user_id
                      AND promo.type::text = 'promo_code_redeemed'
                      AND promo.status::text = 'completed'
                      AND promo.created_at BETWEEN
                        ledger.created_at - interval '30 days'
                        AND ledger.created_at
                  )
                ELSE NULL
              END
            ) AS payload
          FROM ledger_transactions ledger
          JOIN "user" account ON account.id = ledger.user_id
          LEFT JOIN "user" sender
            ON sender.id = NULLIF(ledger.metadata->>'sender_user_id', '')
          LEFT JOIN user_kyc sender_kyc ON sender_kyc.user_id = sender.id
          LEFT JOIN user_feature_locks sender_locks
            ON sender_locks.user_id = sender.id
          WHERE ledger.status::text = 'completed'
            AND (
              ledger.created_at AT TIME ZONE 'UTC',
              'ledger:' || ledger.id::text
            ) > ($1::timestamptz, $2::text)
            AND ledger.created_at <=
              (now() AT TIME ZONE 'UTC') - interval '30 seconds'
            AND (
              (
                ledger.type::text = 'promo_code_redeemed'
                AND account.created_at >= ledger.created_at - interval '30 days'
                AND (
                  SELECT COUNT(*)
                  FROM ledger_transactions promo
                  WHERE promo.user_id = ledger.user_id
                    AND promo.type::text = 'promo_code_redeemed'
                    AND promo.status::text = 'completed'
                    AND promo.created_at BETWEEN
                      ledger.created_at - interval '30 days'
                      AND ledger.created_at
                ) = 3
              )
              OR (
                ledger.type::text = 'creator_tip'
                AND account.created_at >= ledger.created_at - interval '15 minutes'
              )
              OR (
                ledger.type::text IN (
                  'balance_reward_claim',
                  'gift_card_redeemed',
                  'challenge_prize',
                  'race_prize',
                  'affiliate_leaderboard_prize'
                )
                AND account.created_at >= ledger.created_at - interval '30 days'
                AND ledger.amount > 0
                AND ledger.balance_after >= 10
                AND NOT EXISTS (
                  SELECT 1
                  FROM ledger_transactions deposit
                  WHERE deposit.user_id = ledger.user_id
                    AND deposit.type::text = 'deposit'
                    AND deposit.status::text = 'completed'
                    AND deposit.created_at <= ledger.created_at
                )
              )
            )

          UNION ALL

          SELECT
            participant.id,
            participant.username,
            participant.email,
            participant.signup_ip,
            participant.country,
            participant.country_code,
            participant.created_at AT TIME ZONE 'UTC',
            (
              COALESCE(participant.role::text, '') = 'creator'
              OR 'creator' = ANY(COALESCE(participant.roles::text[], ARRAY[]::text[]))
            ),
            'fresh_sponsored_battle',
            'battle_participants',
            bp.id::text,
            'Sponsored battle immediately after signup',
            'A normal account joined a free or sponsored battle within 15 minutes of signup.',
            70,
            true,
            'fresh_sponsored_battle',
            bp.created_at AT TIME ZONE 'UTC',
            jsonb_build_object(
              'battleId', bp.battle_id::text,
              'creatorUserId', battle.user_id,
              'creatorHasSiteRole', (
                COALESCE(creator.role::text, '') = 'creator'
                OR 'creator' = ANY(COALESCE(creator.roles::text[], ARRAY[]::text[]))
              ),
              'sponsorshipPercentage', battle.sponsorship_percentage,
              'isFree', NOT EXISTS (
                SELECT 1 FROM ledger_transactions bet
                WHERE bet.user_id = bp.user_id
                  AND bet.game_session_id = bp.game_session_id
                  AND bet.type::text = 'battle_bet'
              )
            )
          FROM battle_participants bp
          JOIN battles battle ON battle.id = bp.battle_id
          JOIN "user" participant ON participant.id = bp.user_id
          JOIN "user" creator ON creator.id = battle.user_id
          WHERE bp.user_id IS NOT NULL
            AND bp.bot_id IS NULL
            AND (
              bp.created_at AT TIME ZONE 'UTC',
              'battle_participants:' || bp.id::text
            ) > ($1::timestamptz, $2::text)
            AND bp.created_at <=
              (now() AT TIME ZONE 'UTC') - interval '30 seconds'
            AND participant.created_at >= bp.created_at - interval '15 minutes'
            AND (
              battle.sponsorship_percentage > 0
              OR bp.source_session_id IS NOT NULL
              OR NOT EXISTS (
                SELECT 1 FROM ledger_transactions bet
                WHERE bet.user_id = bp.user_id
                  AND bet.game_session_id = bp.game_session_id
                  AND bet.type::text = 'battle_bet'
              )
            )

          UNION ALL

          SELECT
            account.id,
            account.username,
            account.email,
            account.signup_ip,
            account.country,
            account.country_code,
            account.created_at AT TIME ZONE 'UTC',
            (
              COALESCE(account.role::text, '') = 'creator'
              OR 'creator' = ANY(COALESCE(account.roles::text[], ARRAY[]::text[]))
            ),
            CASE
              WHEN account.created_at < current_session.created_at - interval '30 days'
                AND previous.created_at < current_session.created_at - interval '30 days'
                AND COALESCE(previous.user_agent, '')
                  <> COALESCE(current_session."userAgent", '')
                THEN 'dormant_device_switch'
              ELSE 'session_hopping'
            END,
            'session',
            current_session.id,
            CASE
              WHEN account.created_at < current_session.created_at - interval '30 days'
                AND previous.created_at < current_session.created_at - interval '30 days'
                AND COALESCE(previous.user_agent, '')
                  <> COALESCE(current_session."userAgent", '')
                THEN 'Dormant account activated on a new device'
              ELSE 'Rapid session hopping'
            END,
            CASE
              WHEN account.created_at < current_session.created_at - interval '30 days'
                AND previous.created_at < current_session.created_at - interval '30 days'
                AND COALESCE(previous.user_agent, '')
                  <> COALESCE(current_session."userAgent", '')
                THEN 'The account returned after at least 30 inactive days using a different device signature.'
              ELSE 'The account changed device plus exact IP or country repeatedly within 30 minutes.'
            END,
            CASE
              WHEN account.created_at < current_session.created_at - interval '30 days'
                AND previous.created_at < current_session.created_at - interval '30 days'
                AND COALESCE(previous.user_agent, '')
                  <> COALESCE(current_session."userAgent", '')
                THEN 60
              ELSE 50
            END,
            false,
            CASE
              WHEN account.created_at < current_session.created_at - interval '30 days'
                AND previous.created_at < current_session.created_at - interval '30 days'
                AND COALESCE(previous.user_agent, '')
                  <> COALESCE(current_session."userAgent", '')
                THEN 'dormant_device_switch'
              ELSE 'session_hopping'
            END,
            current_session.created_at AT TIME ZONE 'UTC',
            jsonb_build_object(
              'deviceKey', md5(COALESCE(current_session."userAgent", 'unknown')),
              'ipKey', md5(COALESCE(current_session."ipAddress", 'unknown')),
              'countryCode', current_session.country_code,
              'deviceCount30m', recent.device_count,
              'ipCount30m', recent.ip_count,
              'countryCount30m', recent.country_count,
              'previousSessionAt', previous.created_at,
              'inactivityDays', FLOOR(
                EXTRACT(
                  EPOCH FROM (current_session.created_at - previous.created_at)
                ) / 86400
              )
            )
          FROM session current_session
          JOIN "user" account ON account.id = current_session."userId"
          JOIN LATERAL (
            SELECT prior.created_at, prior."userAgent" AS user_agent
            FROM session prior
            WHERE prior."userId" = current_session."userId"
              AND (prior.created_at, prior.id)
                < (current_session.created_at, current_session.id)
            ORDER BY prior.created_at DESC, prior.id DESC
            LIMIT 1
          ) previous ON true
          JOIN LATERAL (
            SELECT
              COUNT(DISTINCT md5(COALESCE(recent_session."userAgent", 'unknown')))::int
                AS device_count,
              COUNT(DISTINCT md5(COALESCE(recent_session."ipAddress", 'unknown')))::int
                AS ip_count,
              COUNT(DISTINCT UPPER(recent_session.country_code)) FILTER (
                WHERE recent_session.country_code IS NOT NULL
              )::int AS country_count
            FROM session recent_session
            WHERE recent_session."userId" = current_session."userId"
              AND recent_session.created_at BETWEEN
                current_session.created_at - interval '30 minutes'
                AND current_session.created_at
          ) recent ON true
          WHERE (
              (
                recent.device_count >= 3
                AND (recent.ip_count >= 3 OR recent.country_count >= 2)
              )
              OR (
                account.created_at
                  < current_session.created_at - interval '30 days'
                AND previous.created_at
                  < current_session.created_at - interval '30 days'
                AND COALESCE(previous.user_agent, '')
                  <> COALESCE(current_session."userAgent", '')
              )
            )
            AND (
              current_session.created_at AT TIME ZONE 'UTC',
              'session:' || current_session.id
            ) > ($1::timestamptz, $2::text)
            AND current_session.created_at <=
              (now() AT TIME ZONE 'UTC') - interval '30 seconds'
        )
        SELECT *
        FROM candidates
        WHERE (occurred_at, source || ':' || source_ref) >
          ($1::timestamptz, $2::text)
          AND occurred_at <= now() - interval '30 seconds'
        ORDER BY occurred_at, source || ':' || source_ref
        LIMIT $3
      `,
      [cursor.occurred_at, cursor.source_id, BATCH_SIZE],
    );
    return result.rows;
  }

  /**
   * Additive evidence only: if a candidate account (or, for creator-tip rows, the tip sender)
   * belongs to a confirmed high-risk network cluster (network-risk.ts's account/device/IP
   * graph), fold that in as one more input to this file's existing per-row scoring -- the same
   * way `senderRestricted` already raises a creator-tip row's score above. This never changes
   * `containment_required`, which stays governed purely by event_type as before, so it cannot
   * open a new auto-ban/auto-KYC path.
   */
  private async applyNetworkClusterSignal(
    candidates: Candidate[],
  ): Promise<void> {
    const subjectIds = new Set<string>();
    for (const candidate of candidates) {
      subjectIds.add(candidate.user_id);
      const senderUserId = candidate.payload?.senderUserId;
      if (typeof senderUserId === "string" && senderUserId) {
        subjectIds.add(senderUserId);
      }
    }
    if (subjectIds.size === 0) return;
    const clustered = await findNetworkClusterHighRiskMembers(
      this.db,
      [...subjectIds],
    );
    if (clustered.size === 0) return;
    for (const candidate of candidates) {
      const senderUserId = candidate.payload?.senderUserId;
      const flagged =
        clustered.has(candidate.user_id)
        || (typeof senderUserId === "string" && clustered.has(senderUserId));
      if (!flagged) continue;
      candidate.score = Math.min(100, candidate.score + NETWORK_CLUSTER_SCORE_BONUS);
      candidate.detail =
        `${candidate.detail} The account network also contains a confirmed high-risk account.`;
      candidate.payload = { ...candidate.payload, networkClusterFlagged: true };
    }
  }

  private async persist(candidate: Candidate): Promise<void> {
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO subjects (
            user_id, username, email, signup_ip, country, country_code,
            source_created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (user_id) DO UPDATE SET
            username=EXCLUDED.username,
            email=EXCLUDED.email,
            updated_at=now()
        `,
        [
          candidate.user_id,
          candidate.username,
          candidate.email,
          candidate.signup_ip,
          candidate.country,
          candidate.country_code,
          candidate.source_created_at,
        ],
      );
      const expectedCreatorActivity = isExpectedCreatorBehavior(
        candidate.is_creator,
        candidate.event_type,
      );
      if (!expectedCreatorActivity) {
        const caseResult = await client.query<{ id: string }>(
          `
            INSERT INTO cases (
              user_id, subject_type, status, severity, score, peak_score, summary
            ) VALUES ($1,'account','in_review',$2,$3,$3,$4)
            ON CONFLICT (user_id) WHERE subject_type='account'
              AND status IN ('open','monitoring','in_review','escalated')
            DO UPDATE SET
              status='in_review',
              score=GREATEST(cases.score,EXCLUDED.score),
              peak_score=GREATEST(cases.peak_score,EXCLUDED.peak_score),
              severity=EXCLUDED.severity,
              updated_at=now()
            RETURNING id
          `,
          [
            candidate.user_id,
            severity(candidate.score),
            candidate.score,
            candidate.title,
          ],
        );
        const caseId = caseResult.rows[0]?.id;
        if (!caseId) throw new Error("Fresh behavior case was not created");
        await client.query(
          `
            INSERT INTO risk_events (
              case_id, session_id, user_id, event_type, source, source_ref,
              score_delta, score_after, title, detail, payload, occurred_at
            ) VALUES ($1,NULL,$2,$3,$4,$5,$6,$6,$7,$8,$9::jsonb,$10)
            ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL
            DO NOTHING
          `,
          [
            caseId,
            candidate.user_id,
            candidate.event_type,
            candidate.source,
            candidate.source_ref,
            candidate.score,
            candidate.title,
            candidate.detail,
            JSON.stringify({
              ...candidate.payload,
              modelVersion: "behavior-v1",
              reasonCode: candidate.reason_code,
            }),
            candidate.occurred_at,
          ],
        );
        if (candidate.containment_required) {
          await client.query(
            `
              INSERT INTO risk_events (
                case_id, session_id, user_id, event_type, source, source_ref,
                score_delta, score_after, title, detail, payload, occurred_at
              ) VALUES (
                $1,NULL,$2,'behavioral_withdrawal_containment',
                'fresh_behavior',$3,0,$4,'Behavioral withdrawal containment',
                'A specific fresh-account behavior requires an idempotent withdrawal and item lock.',
                $5::jsonb,$6
              )
              ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL
              DO NOTHING
            `,
            [
              caseId,
              candidate.user_id,
              `${candidate.source}:${candidate.source_ref}:containment`,
              candidate.score,
              JSON.stringify({
                containmentRequired: true,
                modelVersion: "behavior-v1",
                reasonCode: candidate.reason_code,
                evidenceSource: candidate.source,
                evidenceRef: candidate.source_ref,
              }),
              candidate.occurred_at,
            ],
          );
        }
      }
      await client.query(
        `
          UPDATE source_cursors
          SET occurred_at=$2, source_id=$3, updated_at=now()
          WHERE stream=$1
            AND (occurred_at,source_id) < ($2,$3)
        `,
        [
          STREAM,
          candidate.occurred_at,
          `${candidate.source}:${candidate.source_ref}`,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
