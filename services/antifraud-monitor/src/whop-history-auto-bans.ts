import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";

import type { Databases } from "./db.js";
import { severity } from "./scoring.js";

export const WHOP_HISTORY_AUTO_BAN_EVENT = "whop_history_auto_ban";
const CURSOR_STREAM = "whop-history-auto-bans";
const SOURCE = "whop-history";
const AUTO_BAN_SCORE = 100;
const BATCH_SIZE = 100;

type SourceWebhookRow = {
  id: string;
  provider_event_id: string;
  provider_resource_id: string | null;
  event_type: string;
  payload: unknown;
  received_at: Date;
  user_id: string | null;
  username: string | null;
  email: string | null;
  image: string | null;
  signup_ip: string | null;
  country: string | null;
  country_code: string | null;
  continent_code: string | null;
  state: string | null;
  city: string | null;
  affiliate_code: string | null;
  referred_by: string | null;
  account_created_at: Date | null;
};

export type ReconciledWhopPayment = {
  paymentId: string;
  userId: string | null;
  payload: unknown;
  updatedAt: Date;
};

export type WhopHistoryEvidence = {
  paymentId: string;
  depositIntentId: string;
  priorDisputeCount: number;
  priorRefundCount: number;
  priorFraudDeclines: number;
  highRiskSessions: number;
  providerRiskScore: number | null;
  paymentStatus: string | null;
  declineCode: string | null;
  threeDsVerified: boolean | null;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, 1_000_000)
    : 0;
}

function nullableNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableString(value: unknown, max = 120): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : null;
}

/**
 * Parse only the Whop fields approved for automatic ban admission. The
 * payment id and Packy intent binding are mandatory; dashboard-only fields
 * such as source IP/location are deliberately not guessed.
 */
export function whopHistoryEvidence(
  payload: unknown,
  providerResourceId: string | null,
): WhopHistoryEvidence | null {
  const data = record(record(payload).data);
  const metadata = record(data.metadata);
  const paymentId = nullableString(data.id ?? providerResourceId, 80);
  const depositIntentId = nullableString(metadata.deposit_intent_id, 80);
  if (
    !paymentId ||
    !/^pay_[A-Za-z0-9]+$/.test(paymentId) ||
    !depositIntentId ||
    !/^[0-9a-f-]{36}$/i.test(depositIntentId)
  ) {
    return null;
  }

  const signals = Array.isArray(record(data.risk_signals).signals)
    ? (record(data.risk_signals).signals as unknown[])
    : [];
  const byKey = new Map<string, unknown>();
  for (const raw of signals) {
    const signal = record(raw);
    if (typeof signal.key === "string") byKey.set(signal.key, signal.value);
  }
  const priorDisputeCount = finiteCount(byKey.get("prior_dispute_count"));
  const priorRefundCount = finiteCount(byKey.get("prior_refund_count"));
  const paymentStatus = nullableString(data.substatus ?? data.status, 80);
  const normalizedStatus = paymentStatus?.toLowerCase() ?? "";
  const currentDispute = normalizedStatus.includes("dispute")
    || nullableString(data.dispute_alerted_at, 80) !== null;
  const currentRefund = normalizedStatus.includes("refund")
    || nullableString(data.refunded_at, 80) !== null
    || data.auto_refunded === true;
  const admittedDisputes = Math.max(priorDisputeCount, currentDispute ? 1 : 0);
  const admittedRefunds = Math.max(priorRefundCount, currentRefund ? 1 : 0);
  if (admittedDisputes === 0 && admittedRefunds === 0) return null;

  return {
    paymentId,
    depositIntentId,
    priorDisputeCount: admittedDisputes,
    priorRefundCount: admittedRefunds,
    priorFraudDeclines: finiteCount(byKey.get("prior_fraud_declines")),
    highRiskSessions: finiteCount(byKey.get("user_high_risk_sessions")),
    providerRiskScore: nullableNumber(data.risk_score),
    paymentStatus,
    declineCode: nullableString(data.decline_code, 120),
    threeDsVerified:
      typeof data.three_ds_verified === "boolean"
        ? data.three_ds_verified
        : null,
  };
}

function autoBanDetail(evidence: WhopHistoryEvidence): string {
  return (
    "Whop reports prior buyer payment abuse: " +
    `${evidence.priorDisputeCount} dispute(s) and ` +
    `${evidence.priorRefundCount} refund(s). The Packy account must be ` +
    "banned automatically and reviewed."
  ).slice(0, 1_000);
}

/**
 * Continuous Whop-history detector. Source is read-only; all durable work is
 * written to Antifraud first and handed to the dashboard's signed containment
 * outbox. Discord is queued only after MAIN confirms the automatic ban.
 */
export class WhopHistoryAutoBans {
  constructor(
    private readonly db: Databases,
    private readonly log: FastifyBaseLogger,
  ) {}

  async ensureCursor(): Promise<void> {
    await this.db.antifraud.query(
      `
        INSERT INTO source_cursors(stream, occurred_at, source_id)
        VALUES ($1, now() - interval '24 hours', '')
        ON CONFLICT (stream) DO NOTHING
      `,
      [CURSOR_STREAM],
    );
  }

  async process(): Promise<number> {
    let detected = 0;
    for (;;) {
      const rows = await this.loadSourceBatch();
      if (rows.length === 0) break;
      detected += await this.storeBatch(rows);
      if (rows.length < BATCH_SIZE) break;
    }
    await this.queueConfirmedNotifications();
    return detected;
  }

  /**
   * Admit API-reconciled payments through the exact same idempotent auto-ban
   * path as webhooks. Source remains read-only; the poller only reads account
   * metadata and writes durable evidence to Antifraud.
   */
  async storeReconciledPayments(
    payments: readonly ReconciledWhopPayment[],
  ): Promise<number> {
    const candidates = payments.flatMap((payment) => {
      const evidence = whopHistoryEvidence(payment.payload, payment.paymentId);
      return evidence && payment.userId
        ? [{ payment, evidence }]
        : [];
    });
    if (candidates.length === 0) return 0;

    const userIds = [...new Set(candidates.map(({ payment }) => payment.userId!))];
    const accounts = await this.db.source.query<Omit<
      SourceWebhookRow,
      "id" | "provider_event_id" | "provider_resource_id" | "event_type"
        | "payload" | "received_at"
    >>(
      `
        SELECT
          account.id AS user_id, account.username, account.email,
          account.image, account.signup_ip, account.country,
          account.country_code, account.continent_code, account.state,
          account.city, account.affiliate_code, account.referred_by,
          account.created_at AS account_created_at
        FROM "user" AS account
        WHERE account.id=ANY($1::text[])
          AND account.is_banned=false
          AND COALESCE(account.role::text, '') NOT IN (
            'admin', 'support', 'creator'
          )
          AND NOT COALESCE(account.roles::text[], ARRAY[]::text[])
            && ARRAY['admin','support','creator']::text[]
      `,
      [userIds],
    );
    const byUser = new Map(accounts.rows.map((account) => [account.user_id, account]));
    const client = await this.db.antifraud.connect();
    let detected = 0;
    try {
      await client.query("BEGIN");
      for (const { payment, evidence } of candidates) {
        const account = byUser.get(payment.userId!);
        if (!account) continue;
        const row: SourceWebhookRow = {
          id: `reconciled:${payment.paymentId}`,
          provider_event_id: `reconciled:${payment.paymentId}`,
          provider_resource_id: payment.paymentId,
          event_type: "payment.reconciled",
          payload: payment.payload,
          received_at: payment.updatedAt,
          ...account,
        };
        if (await this.insertAutoBanEvent(client, row, evidence)) detected += 1;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return detected;
  }

  private async loadSourceBatch(): Promise<SourceWebhookRow[]> {
    const cursor = await this.db.antifraud.query<{
      occurred_at: Date;
      source_id: string;
    }>(
      `SELECT occurred_at, source_id FROM source_cursors WHERE stream=$1`,
      [CURSOR_STREAM],
    );
    const current = cursor.rows[0];
    if (!current) throw new Error("Whop history auto-ban cursor is missing");

    const result = await this.db.source.query<SourceWebhookRow>(
      `
        SELECT
          event.id::text,
          event.provider_event_id,
          event.provider_resource_id,
          event.event_type,
          event.payload,
          event.received_at,
          account.id AS user_id,
          account.username,
          account.email,
          account.image,
          account.signup_ip,
          account.country,
          account.country_code,
          account.continent_code,
          account.state,
          account.city,
          account.affiliate_code,
          account.referred_by,
          account.created_at AS account_created_at
        FROM payment_webhook_events AS event
        LEFT JOIN "user" AS account
          ON account.id = event.payload#>>'{data,metadata,internal_user_id}'
        WHERE event.provider = 'whop'
          AND event.event_type IN (
            'payment.created',
            'payment.failed',
            'payment.succeeded'
          )
          AND (event.received_at, event.id::text) > ($1, $2)
          AND (
            account.id IS NULL
            OR (
              account.is_banned = false
              AND COALESCE(account.role::text, '') NOT IN (
                'admin', 'support', 'creator'
              )
              AND NOT COALESCE(account.roles::text[], ARRAY[]::text[])
                && ARRAY['admin','support','creator']::text[]
            )
          )
        ORDER BY event.received_at, event.id::text
        LIMIT $3
      `,
      [current.occurred_at, current.source_id, BATCH_SIZE],
    );
    return result.rows;
  }

  private async storeBatch(rows: SourceWebhookRow[]): Promise<number> {
    const client = await this.db.antifraud.connect();
    let detected = 0;
    try {
      await client.query("BEGIN");
      for (const row of rows) {
        if (!row.user_id || !row.account_created_at) continue;
        const evidence = whopHistoryEvidence(
          row.payload,
          row.provider_resource_id,
        );
        if (!evidence) continue;
        const inserted = await this.insertAutoBanEvent(
          client,
          row,
          evidence,
        );
        if (inserted) detected += 1;
      }
      const last = rows.at(-1);
      if (!last) throw new Error("Whop history source batch was empty");
      await client.query(
        `
          UPDATE source_cursors
          SET occurred_at=$2, source_id=$3, updated_at=now()
          WHERE stream=$1
        `,
        [CURSOR_STREAM, last.received_at, last.id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return detected;
  }

  private async insertAutoBanEvent(
    client: pg.PoolClient,
    row: SourceWebhookRow,
    evidence: WhopHistoryEvidence,
  ): Promise<boolean> {
    if (!row.user_id || !row.account_created_at) return false;
    await client.query(
      `
        INSERT INTO subjects (
          user_id, username, email, avatar_url, signup_ip, country,
          country_code, continent_code, state, city, affiliate_code,
          referred_by, source_created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (user_id) DO UPDATE SET
          username=COALESCE(EXCLUDED.username, subjects.username),
          email=COALESCE(EXCLUDED.email, subjects.email),
          avatar_url=COALESCE(EXCLUDED.avatar_url, subjects.avatar_url),
          signup_ip=COALESCE(EXCLUDED.signup_ip, subjects.signup_ip),
          country=COALESCE(EXCLUDED.country, subjects.country),
          country_code=COALESCE(EXCLUDED.country_code, subjects.country_code),
          continent_code=COALESCE(
            EXCLUDED.continent_code,
            subjects.continent_code
          ),
          state=COALESCE(EXCLUDED.state, subjects.state),
          city=COALESCE(EXCLUDED.city, subjects.city),
          affiliate_code=COALESCE(
            EXCLUDED.affiliate_code,
            subjects.affiliate_code
          ),
          referred_by=COALESCE(EXCLUDED.referred_by, subjects.referred_by),
          updated_at=now()
      `,
      [
        row.user_id,
        row.username,
        row.email,
        row.image,
        row.signup_ip,
        row.country,
        row.country_code,
        row.continent_code,
        row.state,
        row.city,
        row.affiliate_code,
        row.referred_by,
        row.account_created_at,
      ],
    );

    const caseResult = await client.query<{ id: string }>(
      `
        INSERT INTO cases (
          user_id, subject_type, status, severity, score, peak_score, summary
        ) VALUES (
          $1, 'account', 'open', $2, $3, $3,
          'Automatic Whop payment-history ban'
        )
        ON CONFLICT (user_id) WHERE subject_type='account'
          AND status IN ('open','monitoring','in_review','escalated')
        DO UPDATE SET
          score=GREATEST(cases.score, EXCLUDED.score),
          peak_score=GREATEST(cases.peak_score, EXCLUDED.peak_score),
          severity=CASE
            WHEN cases.peak_score >= EXCLUDED.peak_score THEN cases.severity
            ELSE EXCLUDED.severity
          END,
          updated_at=now()
        RETURNING id
      `,
      [row.user_id, severity(AUTO_BAN_SCORE), AUTO_BAN_SCORE],
    );
    const caseId = caseResult.rows[0]?.id;
    if (!caseId) throw new Error("whop_history_auto_ban_case_not_created");

    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO risk_events (
          case_id, session_id, user_id, event_type, source, source_ref,
          score_delta, score_after, title, detail, payload, occurred_at
        ) VALUES (
          $1,NULL,$2,$3,$4,$5,0,$6,
          'Automatic Whop payment-history ban',$7,$8::jsonb,$9
        )
        ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL
        DO NOTHING
        RETURNING id
      `,
      [
        caseId,
        row.user_id,
        WHOP_HISTORY_AUTO_BAN_EVENT,
        SOURCE,
        `whop-history:${evidence.paymentId}`,
        AUTO_BAN_SCORE,
        autoBanDetail(evidence),
        JSON.stringify({
          containmentRequired: true,
          containmentAction: "ban",
          environment: "prod",
          provider: "whop",
          providerEventId: row.provider_event_id,
          eventType: row.event_type,
          ...evidence,
        }),
        row.received_at,
      ],
    );
    return inserted.rows.length === 1;
  }

  private async queueConfirmedNotifications(): Promise<void> {
    const pending = await this.db.antifraud.query<{
      source_ref: string;
      user_id: string;
      username: string | null;
      payload: Record<string, unknown>;
      occurred_at: Date;
    }>(
      `
        SELECT event.source_ref, event.user_id, subject.username,
               event.payload, event.occurred_at
        FROM risk_events AS event
        JOIN subjects AS subject ON subject.user_id=event.user_id
        WHERE event.event_type=$1
          AND event.dashboard_delivered_at IS NOT NULL
          AND event.recorded_at >= now() - interval '90 days'
          AND NOT EXISTS (
            SELECT 1
            FROM fiat_problem_alert_outbox AS alert
            WHERE alert.source_kind='payment_webhook'
              AND alert.source_id='auto-ban:' ||
                split_part(event.source_ref, ':', 2)
          )
        ORDER BY event.recorded_at DESC, event.id DESC
        LIMIT 500
      `,
      [WHOP_HISTORY_AUTO_BAN_EVENT],
    );
    if (pending.rows.length === 0) return;

    const userIds = [...new Set(pending.rows.map((row) => row.user_id))];
    const confirmed = await this.db.source.query<{
      id: string;
      banned_reason: string | null;
      banned_at: Date | null;
    }>(
      `
        SELECT id, banned_reason, banned_at
        FROM "user"
        WHERE id=ANY($1::text[])
          AND is_banned=true
          AND banned_reason LIKE 'Automatic Whop history ban:%'
      `,
      [userIds],
    );
    const byUser = new Map(confirmed.rows.map((row) => [row.id, row]));
    const alerts = pending.rows.flatMap((row) => {
      const account = byUser.get(row.user_id);
      const paymentId = row.source_ref.split(":", 2)[1];
      if (!account || !paymentId) return [];
      return [{
        sourceKind: "payment_webhook",
        sourceId: `auto-ban:${paymentId}`,
        userId: row.user_id,
        username: row.username,
        occurredAt: account.banned_at ?? row.occurred_at,
        details: {
          ...row.payload,
          banReason: account.banned_reason,
          bannedAt: account.banned_at?.toISOString() ?? null,
        },
      }];
    });
    if (alerts.length === 0) return;

    await this.db.antifraud.query(
      `
        INSERT INTO fiat_problem_alert_outbox (
          source_kind, source_id, problem_code, user_id, username,
          details, occurred_at
        )
        SELECT *
        FROM unnest(
          $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
          $6::jsonb[], $7::timestamptz[]
        )
        ON CONFLICT (source_kind, source_id) DO NOTHING
      `,
      [
        alerts.map((alert) => alert.sourceKind),
        alerts.map((alert) => alert.sourceId),
        alerts.map(() => WHOP_HISTORY_AUTO_BAN_EVENT),
        alerts.map((alert) => alert.userId),
        alerts.map((alert) => alert.username),
        alerts.map((alert) => JSON.stringify(alert.details)),
        alerts.map((alert) => alert.occurredAt),
      ],
    );
    this.log.info(
      { count: alerts.length },
      "Confirmed Whop history auto-ban notifications queued",
    );
  }
}
