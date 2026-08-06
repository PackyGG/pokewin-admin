import type { FastifyBaseLogger } from "fastify";
import { isIP } from "node:net";
import type pg from "pg";

import type { Config } from "./config.js";
import type { Databases } from "./db.js";
import { DiscordAlerts } from "./discord.js";
import { listActiveNetworkClusterHighRiskMembers } from "./network-risk.js";
import { drainOutbox } from "./outbox.js";
import { severity } from "./scoring.js";

const INITIAL_LOOKBACK_DAYS = 30;
const SOURCE_BATCH_SIZE = 250;
const DELIVERY_BATCH_SIZE = 8;
const SOURCE_SETTLEMENT_DELAY_SECONDS = 30;
const RISK_CREATOR_CACHE_MS = 30_000;
const FRAUD_KYC_REASON =
  /(fraud|scam|fiat deposit risk review|blacklist|suspicious|sumsub.*red)/i;

export type CreatorRiskKind =
  | "kyc_rejected"
  | "fraud_kyc_required"
  | "suspected_alt"
  | "antifraud_flagged"
  | "network_cluster";

export type CreatorRisk = {
  kind: CreatorRiskKind;
  detail: string;
  points: 40 | 80;
};

export type CreatorSourceState = {
  creator_kyc_required: boolean;
  creator_kyc_status: string;
  creator_kyc_admin_decision: string;
  creator_kyc_reason: string | null;
  creator_is_suspected_alt: boolean;
};

export type FreeBattleCandidate = {
  participant_id: string;
  battle_id: string;
  game_session_id: string;
  participant_user_id: string;
  participant_username: string | null;
  participant_email: string | null;
  participant_avatar_url: string | null;
  participant_signup_ip: string | null;
  participant_country: string | null;
  participant_country_code: string | null;
  participant_continent_code: string | null;
  participant_state: string | null;
  participant_city: string | null;
  participant_affiliate_code: string | null;
  participant_referred_by: string | null;
  participant_created_at: Date;
  creator_user_id: string;
  creator_username: string | null;
  occurred_at: Date;
  sponsorship_percentage: number;
  is_free_battle: boolean;
};

type CreatorAntifraudState = {
  user_id: string;
  score: number;
};

type CreatorCursor = {
  creator_user_id: string;
  occurred_at: Date;
  source_id: string;
};

type PendingAlert = {
  participant_user_id: string;
  alert_level: "high" | "critical";
  payload: Record<string, unknown>;
  attempt_count: number;
};

type EligibleContainment = {
  participant_user_id: string;
  match_count: number;
  battle_count: number;
  creator_count: number;
  occurred_at: Date;
};

export function classifyCreatorRisk(
  candidate: CreatorSourceState,
  antifraudScore = 0,
): CreatorRisk | null {
  if (
    candidate.creator_kyc_status === "rejected" ||
    candidate.creator_kyc_admin_decision === "rejected"
  ) {
    return {
      kind: "kyc_rejected",
      detail: "The battle creator has a rejected KYC decision.",
      points: 80,
    };
  }
  if (
    candidate.creator_kyc_required &&
    candidate.creator_kyc_reason &&
    FRAUD_KYC_REASON.test(candidate.creator_kyc_reason)
  ) {
    return {
      kind: "fraud_kyc_required",
      detail: candidate.creator_kyc_reason.slice(0, 500),
      points: 40,
    };
  }
  if (candidate.creator_is_suspected_alt) {
    return {
      kind: "suspected_alt",
      detail: "The battle creator is flagged as a suspected alternate account.",
      points: 40,
    };
  }
  if (antifraudScore >= 60) {
    return {
      kind: "antifraud_flagged",
      detail: `The battle creator has an active Antifraud score of ${antifraudScore}.`,
      points: 40,
    };
  }
  return null;
}

export function crossedRiskBand(
  previousScore: number,
  nextScore: number,
): 40 | 80 | 100 | null {
  for (const threshold of [100, 80, 40] as const) {
    if (previousScore < threshold && nextScore >= threshold) return threshold;
  }
  return null;
}

export function relationshipScoreForBattleCount(battleCount: number): number {
  return Math.min(100, Math.max(0, Math.trunc(battleCount)) * 40);
}

export function serializeCreatorRisks(
  risks: Map<string, CreatorRisk>,
): string {
  return JSON.stringify(
    [...risks].map(([creator_user_id, risk]) => ({
      creator_user_id,
      creator_risk_kind: risk.kind,
      creator_risk_detail: risk.detail,
      risk_points: risk.points,
    })),
  );
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function alertPayload(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export class FreeBattleRiskMonitor {
  private readonly discord: DiscordAlerts;
  private riskCache:
    | { at: number; creators: Map<string, CreatorRisk> }
    | null = null;

  constructor(
    private readonly config: Config,
    private readonly db: Databases,
    private readonly log: FastifyBaseLogger,
  ) {
    this.discord = new DiscordAlerts(config, log);
  }

  async ensureCursor(): Promise<void> {
    await this.db.antifraud.query(
      "SELECT 1 FROM free_battle_creator_cursors LIMIT 0",
    );
  }

  async process(): Promise<number> {
    const risks = await this.riskCreators();
    if (risks.size === 0) {
      await this.reconcileContainments();
      await this.deliverAlerts();
      return 0;
    }
    await this.syncCreatorCursors(risks);
    const cursors = await this.db.antifraud.query<CreatorCursor>(
      `
        SELECT creator_user_id, occurred_at, source_id
        FROM free_battle_creator_cursors
        WHERE creator_user_id = ANY($1::text[])
        ORDER BY creator_user_id
      `,
      [[...risks.keys()]],
    );
    let inserted = 0;
    for (const cursor of cursors.rows) {
      const risk = risks.get(cursor.creator_user_id);
      if (!risk) continue;
      const candidates = await this.fetchCandidates(cursor);
      if (candidates.length === 0) continue;
      const client = await this.db.antifraud.connect();
      try {
        await client.query("BEGIN");
        for (const candidate of candidates) {
          if (!candidate.is_free_battle) continue;
          inserted += await this.recordMatch(client, candidate, risk);
        }
        const last = candidates.at(-1)!;
        await client.query(
          `
            UPDATE free_battle_creator_cursors
            SET occurred_at = $2, source_id = $3, updated_at = now()
            WHERE creator_user_id = $1
          `,
          [cursor.creator_user_id, last.occurred_at, last.participant_id],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    await this.reconcileContainments();
    await this.deliverAlerts();
    return inserted;
  }

  private async riskCreators(): Promise<Map<string, CreatorRisk>> {
    const now = Date.now();
    if (
      this.riskCache &&
      now - this.riskCache.at < RISK_CREATOR_CACHE_MS
    ) {
      return this.riskCache.creators;
    }
    const source = await this.db.source.query<
      CreatorSourceState & { creator_user_id: string }
    >(
      `
        SELECT
          creator.id AS creator_user_id,
          creator.is_suspected_alt AS creator_is_suspected_alt,
          COALESCE(kyc.kyc_required, false) AS creator_kyc_required,
          COALESCE(kyc.status::text, 'none') AS creator_kyc_status,
          COALESCE(kyc.admin_decision::text, 'pending')
            AS creator_kyc_admin_decision,
          kyc.kyc_required_reason AS creator_kyc_reason
        FROM "user" AS creator
        LEFT JOIN user_kyc AS kyc ON kyc.user_id = creator.id
        WHERE creator.is_suspected_alt = true
          OR kyc.kyc_required = true
          OR kyc.status::text = 'rejected'
          OR kyc.admin_decision::text = 'rejected'
      `,
    );
    const antifraud = await this.creatorAntifraudStates();
    const creators = new Map<string, CreatorRisk>();
    for (const row of source.rows) {
      const risk = classifyCreatorRisk(
        row,
        antifraud.get(row.creator_user_id) ?? 0,
      );
      if (risk) creators.set(row.creator_user_id, risk);
    }
    for (const [userId, score] of antifraud) {
      if (creators.has(userId)) continue;
      creators.set(userId, {
        kind: "antifraud_flagged",
        detail: `The battle creator has an active Antifraud score of ${score}.`,
        points: 40,
      });
    }
    // Additive evidence only: a creator whose account/device/IP network already contains a
    // confirmed high-risk account (network-risk.ts's cluster graph) now also qualifies, on top
    // of -- never instead of -- the direct KYC/suspected-alt/Antifraud-score checks above.
    const clustered = await listActiveNetworkClusterHighRiskMembers(this.db);
    for (const userId of clustered) {
      if (creators.has(userId)) continue;
      creators.set(userId, {
        kind: "network_cluster",
        detail:
          "The battle creator's account network contains a confirmed high-risk account " +
          "(suspected alt or an elevated Antifraud score).",
        points: 40,
      });
    }
    this.riskCache = { at: now, creators };
    return creators;
  }

  private async syncCreatorCursors(
    risks: Map<string, CreatorRisk>,
  ): Promise<void> {
    await this.db.antifraud.query(
      `
        INSERT INTO free_battle_creator_cursors (
          creator_user_id, occurred_at, source_id,
          creator_risk_kind, creator_risk_detail, risk_points
        )
        SELECT
          row.creator_user_id,
          now() - ($2::text || ' days')::interval,
          '00000000-0000-0000-0000-000000000000'::uuid,
          row.creator_risk_kind,
          row.creator_risk_detail,
          row.risk_points
        FROM jsonb_to_recordset($1::jsonb) AS row(
          creator_user_id text,
          creator_risk_kind text,
          creator_risk_detail text,
          risk_points integer
        )
        ON CONFLICT (creator_user_id) DO UPDATE SET
          creator_risk_kind = EXCLUDED.creator_risk_kind,
          creator_risk_detail = EXCLUDED.creator_risk_detail,
          risk_points = EXCLUDED.risk_points,
          updated_at = now()
      `,
      [
        serializeCreatorRisks(risks),
        INITIAL_LOOKBACK_DAYS,
      ],
    );
  }

  private async fetchCandidates(
    cursor: CreatorCursor,
  ): Promise<FreeBattleCandidate[]> {
    const result = await this.db.source.query<FreeBattleCandidate>(
      `
        SELECT
          bp.id::text AS participant_id,
          bp.battle_id::text AS battle_id,
          bp.game_session_id::text AS game_session_id,
          bp.user_id AS participant_user_id,
          COALESCE(
            NULLIF(BTRIM(participant.display_username), ''),
            NULLIF(BTRIM(participant.username), ''),
            NULLIF(BTRIM(participant.name), '')
          ) AS participant_username,
          participant.email AS participant_email,
          participant.image AS participant_avatar_url,
          participant.signup_ip AS participant_signup_ip,
          participant.country AS participant_country,
          participant.country_code AS participant_country_code,
          participant.continent_code AS participant_continent_code,
          participant.state AS participant_state,
          participant.city AS participant_city,
          participant.affiliate_code AS participant_affiliate_code,
          participant.referred_by AS participant_referred_by,
          participant.created_at AT TIME ZONE 'UTC' AS participant_created_at,
          battle.user_id AS creator_user_id,
          COALESCE(
            NULLIF(BTRIM(creator.display_username), ''),
            NULLIF(BTRIM(creator.username), ''),
            NULLIF(BTRIM(creator.name), '')
          ) AS creator_username,
          date_trunc('milliseconds', bp.created_at) AT TIME ZONE 'UTC'
            AS occurred_at,
          battle.sponsorship_percentage,
          NOT EXISTS (
            SELECT 1
            FROM ledger_transactions AS ledger
            WHERE ledger.type::text = 'battle_bet'
              AND ledger.game_session_id = bp.game_session_id
              AND ledger.user_id = bp.user_id
          ) AS is_free_battle
        FROM battles AS battle
        JOIN battle_participants AS bp ON bp.battle_id = battle.id
        JOIN "user" AS participant ON participant.id = bp.user_id
        JOIN "user" AS creator ON creator.id = battle.user_id
        WHERE battle.user_id = $1
          AND (
            date_trunc('milliseconds', bp.created_at),
            bp.id
          ) > (
            date_trunc('milliseconds', $2::timestamptz AT TIME ZONE 'UTC'),
            $3::uuid
          )
          AND bp.created_at <=
            (now() AT TIME ZONE 'UTC')
              - ($4::text || ' seconds')::interval
          AND bp.user_id IS NOT NULL
          AND bp.bot_id IS NULL
          AND bp.user_id <> battle.user_id
        ORDER BY date_trunc('milliseconds', bp.created_at), bp.id
        LIMIT $5
      `,
      [
        cursor.creator_user_id,
        cursor.occurred_at,
        cursor.source_id,
        SOURCE_SETTLEMENT_DELAY_SECONDS,
        SOURCE_BATCH_SIZE,
      ],
    );
    return result.rows;
  }

  private async creatorAntifraudStates(): Promise<Map<string, number>> {
    const result = await this.db.antifraud.query<CreatorAntifraudState>(
      `
        WITH flagged AS (
          SELECT user_id, score
          FROM signup_assessments
          WHERE score >= 60
          UNION ALL
          SELECT user_id, peak_score AS score
          FROM cases
          WHERE subject_type = 'account'
            AND status IN ('open','monitoring','in_review','escalated')
            AND peak_score >= 80
        )
        SELECT user_id, MAX(score)::int AS score
        FROM flagged
        GROUP BY user_id
      `,
    );
    return new Map(result.rows.map((row) => [row.user_id, number(row.score)]));
  }

  private async recordMatch(
    client: pg.PoolClient,
    candidate: FreeBattleCandidate,
    risk: CreatorRisk,
  ): Promise<number> {
    await client.query(
      `
        INSERT INTO subjects (
          user_id, username, email, avatar_url, signup_ip, country,
          country_code, continent_code, state, city, affiliate_code,
          referred_by, source_created_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
        )
        ON CONFLICT (user_id) DO UPDATE SET
          username = EXCLUDED.username,
          email = EXCLUDED.email,
          avatar_url = EXCLUDED.avatar_url,
          signup_ip = COALESCE(EXCLUDED.signup_ip, subjects.signup_ip),
          country = EXCLUDED.country,
          country_code = EXCLUDED.country_code,
          continent_code = EXCLUDED.continent_code,
          state = EXCLUDED.state,
          city = EXCLUDED.city,
          affiliate_code = EXCLUDED.affiliate_code,
          referred_by = EXCLUDED.referred_by,
          updated_at = now()
      `,
      [
        candidate.participant_user_id,
        candidate.participant_username,
        candidate.participant_email,
        candidate.participant_avatar_url,
        isIP(candidate.participant_signup_ip ?? "")
          ? candidate.participant_signup_ip
          : null,
        candidate.participant_country,
        candidate.participant_country_code,
        candidate.participant_continent_code,
        candidate.participant_state,
        candidate.participant_city,
        candidate.participant_affiliate_code,
        candidate.participant_referred_by,
        candidate.participant_created_at,
      ],
    );
    const match = await client.query(
      `
        INSERT INTO free_battle_risk_matches (
          participant_id, battle_id, game_session_id,
          participant_user_id, creator_user_id, creator_username,
          creator_risk_kind, creator_risk_detail, risk_points,
          sponsorship_percentage, occurred_at
        ) VALUES (
          $1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11
        )
        ON CONFLICT (participant_id) DO NOTHING
        RETURNING participant_id
      `,
      [
        candidate.participant_id,
        candidate.battle_id,
        candidate.game_session_id,
        candidate.participant_user_id,
        candidate.creator_user_id,
        candidate.creator_username,
        risk.kind,
        risk.detail,
        risk.points,
        candidate.sponsorship_percentage,
        candidate.occurred_at,
      ],
    );
    if (match.rowCount === 0) return 0;

    const aggregate = await client.query<{
      match_count: number;
      battle_count: number;
      creator_count: number;
      previous_battle_count: number;
    }>(
      `
        SELECT
          COUNT(*)::int AS match_count,
          COUNT(DISTINCT battle_id)::int AS battle_count,
          COUNT(DISTINCT creator_user_id)::int AS creator_count,
          COUNT(DISTINCT battle_id) FILTER (
            WHERE participant_id <> $2::uuid
          )::int AS previous_battle_count
        FROM free_battle_risk_matches
        WHERE participant_user_id = $1
      `,
      [candidate.participant_user_id, candidate.participant_id],
    );
    const evidence = aggregate.rows[0];
    if (!evidence) throw new Error("Free-battle risk aggregate is missing");
    const previousScore = relationshipScoreForBattleCount(
      number(evidence.previous_battle_count),
    );
    const nextScore = relationshipScoreForBattleCount(
      number(evidence.battle_count),
    );
    const threshold = crossedRiskBand(previousScore, nextScore);

    let caseId: string | null = null;
    if (nextScore >= 80) {
      caseId = await this.ensureCase(
        client,
        candidate.participant_user_id,
        nextScore,
      );
      await this.insertContainmentEvent(client, {
        participant_user_id: candidate.participant_user_id,
        match_count: number(evidence.match_count),
        battle_count: number(evidence.battle_count),
        creator_count: number(evidence.creator_count),
        occurred_at: candidate.occurred_at,
      }, caseId);
    }

    if (threshold === null) return 1;

    const detail =
      `${evidence.match_count} free/sponsored battle joins link this account ` +
      `to ${evidence.creator_count} flagged creator` +
      `${number(evidence.creator_count) === 1 ? "" : "s"}.`;
    const payload = {
      battleId: candidate.battle_id,
      participantId: candidate.participant_id,
      creatorUserId: candidate.creator_user_id,
      creatorUsername: candidate.creator_username,
      creatorRiskKind: risk.kind,
      creatorRiskDetail: risk.detail,
      matchCount: number(evidence.match_count),
      qualifyingBattleCount: number(evidence.battle_count),
      distinctFlaggedCreators: number(evidence.creator_count),
      relationshipScore: nextScore,
      threshold,
      sponsorshipPercentage: candidate.sponsorship_percentage,
    };
    const event = await client.query<{ id: string }>(
      `
        INSERT INTO risk_events (
          case_id, session_id, user_id, event_type, source, source_ref,
          score_delta, score_after, title, detail, payload, occurred_at
        ) VALUES (
          $1,NULL,$2,'risky_free_battle_network','battle_participants',$3,
          $4,$5,'Risky free-battle network detected',$6,$7,$8
        )
        ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL
        DO NOTHING
        RETURNING id
      `,
      [
        caseId,
        candidate.participant_user_id,
        `${candidate.participant_id}:risky-creator`,
        nextScore - previousScore,
        nextScore,
        detail,
        payload,
        candidate.occurred_at,
      ],
    );
    const eventId = event.rows[0]?.id;
    if (!eventId) return 1;

    if (nextScore >= 80) {
      await client.query(
        `
          INSERT INTO free_battle_alert_outbox (
            participant_user_id, alert_level, risk_event_id, payload
          ) VALUES ($1,$2,$3,$4)
          ON CONFLICT (participant_user_id, alert_level) DO NOTHING
        `,
        [
          candidate.participant_user_id,
          nextScore >= 100 ? "critical" : "high",
          eventId,
          {
            ...payload,
            caseId,
            participantUsername: candidate.participant_username,
            detail,
          },
        ],
      );
    }
    return 1;
  }

  private async ensureCase(
    client: pg.PoolClient,
    userId: string,
    score: number,
  ): Promise<string> {
    const caseResult = await client.query<{ id: string }>(
      `
        INSERT INTO cases (
          user_id, subject_type, status, severity, score, peak_score, summary
        ) VALUES (
          $1, 'account', 'open', $2, $3, $3,
          'Free-battle links to flagged creators'
        )
        ON CONFLICT (user_id) WHERE subject_type = 'account'
          AND status IN ('open','monitoring','in_review','escalated')
        DO UPDATE SET
          score = GREATEST(cases.score, EXCLUDED.score),
          peak_score = GREATEST(cases.peak_score, EXCLUDED.peak_score),
          severity = CASE
            WHEN cases.peak_score >= EXCLUDED.peak_score
              THEN cases.severity
            ELSE EXCLUDED.severity
          END,
          updated_at = now()
        RETURNING id
      `,
      [userId, severity(score), score],
    );
    const caseId = caseResult.rows[0]?.id;
    if (!caseId) throw new Error("Free-battle risk case was not created");
    return caseId;
  }

  private async insertContainmentEvent(
    client: pg.PoolClient,
    evidence: EligibleContainment,
    caseId: string,
  ): Promise<void> {
    if (evidence.battle_count < 2) return;
    const score = relationshipScoreForBattleCount(evidence.battle_count);
    const detail =
      `${evidence.match_count} free/sponsored joins across ` +
      `${evidence.battle_count} battles link this account to ` +
      `${evidence.creator_count} flagged fraud creator` +
      `${evidence.creator_count === 1 ? "" : "s"}. ` +
      "Automatic KYC and withdrawal locks are required.";
    await client.query(
      `
        INSERT INTO risk_events (
          case_id, session_id, user_id, event_type, source, source_ref,
          score_delta, score_after, title, detail, payload, occurred_at
        ) VALUES (
          $1,NULL,$2,'risky_free_battle_containment',
          'free_battle_risk_matches',$3,$4,$5,
          'Risky free-battle account containment',$6,$7,$8
        )
        ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL
        DO NOTHING
      `,
      [
        caseId,
        evidence.participant_user_id,
        `free-battle-containment:${evidence.participant_user_id}`,
        Math.min(80, score),
        score,
        detail,
        {
          containmentRequired: true,
          matchCount: evidence.match_count,
          qualifyingBattleCount: evidence.battle_count,
          distinctFlaggedCreators: evidence.creator_count,
          relationshipScore: score,
        },
        evidence.occurred_at,
      ],
    );
  }

  private async reconcileContainments(): Promise<void> {
    const eligible = await this.db.antifraud.query<EligibleContainment>(
      `
        SELECT
          match.participant_user_id,
          COUNT(*)::int AS match_count,
          COUNT(DISTINCT match.battle_id)::int AS battle_count,
          COUNT(DISTINCT match.creator_user_id)::int AS creator_count,
          MAX(match.occurred_at) AS occurred_at
        FROM free_battle_risk_matches AS match
        WHERE NOT EXISTS (
          SELECT 1
          FROM risk_events AS event
          WHERE event.source = 'free_battle_risk_matches'
            AND event.source_ref =
              'free-battle-containment:' || match.participant_user_id
        )
        GROUP BY match.participant_user_id
        HAVING COUNT(DISTINCT match.battle_id) >= 2
        ORDER BY MAX(match.occurred_at)
        LIMIT 50
      `,
    );
    for (const evidence of eligible.rows) {
      const client = await this.db.antifraud.connect();
      try {
        await client.query("BEGIN");
        const score = relationshipScoreForBattleCount(
          number(evidence.battle_count),
        );
        const caseId = await this.ensureCase(
          client,
          evidence.participant_user_id,
          score,
        );
        await this.insertContainmentEvent(client, {
          ...evidence,
          match_count: number(evidence.match_count),
          battle_count: number(evidence.battle_count),
          creator_count: number(evidence.creator_count),
        }, caseId);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  }

  private async deliverAlerts(): Promise<void> {
    const pending = await this.db.antifraud.query<PendingAlert>(
      `
        SELECT participant_user_id, alert_level, payload, attempt_count
        FROM free_battle_alert_outbox
        WHERE delivered_at IS NULL AND next_attempt_at <= now()
        ORDER BY created_at
        LIMIT $1
      `,
      [DELIVERY_BATCH_SIZE],
    );
    await drainOutbox<PendingAlert>({
      fetchPending: async () => pending.rows,
      attemptCount: (row) => row.attempt_count,
      attempt: async (row) => {
        const payload = alertPayload(row.payload);
        const caseId = text(payload.caseId);
        const username = text(payload.participantUsername);
        const creatorUsername =
          text(payload.creatorUsername) ?? text(payload.creatorUserId);
        const score = number(payload.relationshipScore);
        return {
          delivered: await this.discord.send(
            "antifraud.rule_matched",
            `free-battle-network:${row.participant_user_id}:${row.alert_level}`,
            {
              title: "Risky free-battle network detected",
              description:
                text(payload.detail) ??
                "Multiple free battles link this account to flagged creators.",
              urgent: row.alert_level === "critical",
              userId: row.participant_user_id,
              username,
              caseId: caseId ?? undefined,
              score,
              severity: severity(score),
              scoreDelta: number(payload.threshold),
              trigger: "free battles from flagged creators",
              outcome: "manual_review",
              signals: [{
                title: creatorUsername
                  ? `Flagged creator: ${creatorUsername}`
                  : "Flagged battle creator",
                detail:
                  text(payload.creatorRiskDetail) ??
                  "The battle creator has active fraud evidence.",
                points: number(payload.threshold),
              }],
            },
          ),
        };
      },
      record: async (row, outcome) => {
        await this.db.antifraud.query(
          `
            UPDATE free_battle_alert_outbox
            SET
              delivered_at = CASE
                WHEN $3::boolean THEN COALESCE(delivered_at, now())
                ELSE delivered_at
              END,
              attempt_count = $4,
              next_attempt_at = CASE
                WHEN $3::boolean THEN now()
                ELSE now() + ($5::text || ' seconds')::interval
              END,
              last_error = CASE
                WHEN $3::boolean THEN NULL
                ELSE 'Discord delivery failed'
              END,
              updated_at = now()
            WHERE participant_user_id = $1 AND alert_level = $2
          `,
          [
            row.participant_user_id,
            row.alert_level,
            outcome.delivered,
            outcome.attempt,
            outcome.retrySeconds,
          ],
        );
      },
      onRecorded: (row, outcome) => {
        if (outcome.delivered) {
          this.log.info(
            {
              userId: row.participant_user_id,
              alertLevel: row.alert_level,
            },
            "Free-battle risk alert delivered",
          );
        }
      },
    });
  }
}
