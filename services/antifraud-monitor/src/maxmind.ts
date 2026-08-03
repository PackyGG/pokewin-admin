import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";

import type { Config } from "./config.js";
import {
  maxmindAccessIssue,
  providerFailureAccessIssue,
  type ProviderAccessIssue,
} from "./provider-access-alerts.js";

type JsonObject = Record<string, unknown>;

export type MaxMindEventType =
  | "account_creation"
  | "account_login"
  | "email_change"
  | "password_reset"
  | "fund_transfer"
  | "payout_change"
  | "purchase"
  | "recurring_purchase"
  | "referral"
  | "survey";

export type MaxMindEvaluationInput = {
  eventKey: string;
  transactionId: string;
  eventType: MaxMindEventType;
  userId: string;
  occurredAt: Date;
  shopId: string;
  username?: string | null;
  email?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  amount?: number | null;
  currency?: string | null;
  billingCountry?: string | null;
  billingRegion?: string | null;
  billingCity?: string | null;
  cardLast4?: string | null;
  paymentMethod?:
    | "bank_debit"
    | "bank_redirect"
    | "bank_transfer"
    | "buy_now_pay_later"
    | "card"
    | "crypto"
    | "digital_wallet"
    | "gift_card"
    | "real_time_payment"
    | "rewards";
  paymentWasAuthorized?: boolean | null;
  was3dSecureSuccessful?: boolean | null;
};

export type MaxMindRiskSignal = {
  key: string;
  label: string;
  detail: string;
  points: number;
};

export type MaxMindEvaluation = {
  status: "success" | "failed";
  minfraudId: string | null;
  riskScore: number | null;
  ipRisk: number | null;
  disposition: string | null;
  signals: MaxMindRiskSignal[];
  response: JsonObject | null;
  errorCode: string | null;
};

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function path(value: unknown, ...parts: string[]): unknown {
  let current = value;
  for (const part of parts) current = object(current)[part];
  return current;
}

function number(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function compact(value: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (entry === undefined || entry === null || entry === "") return false;
      if (typeof entry === "object" && !Array.isArray(entry)) {
        return Object.keys(entry as JsonObject).length > 0;
      }
      return true;
    }),
  );
}

function boundedEvidence(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => boundedEvidence(entry, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonObject)
      .filter(([key]) => !["address", "phone_number"].includes(key.toLowerCase()))
      .slice(0, 200)
      .map(([key, entry]) => [key, boundedEvidence(entry, depth + 1)]),
  );
}

export function maxMindRiskPoints(riskScore: number): number {
  return riskScore >= 85
    ? 55
    : riskScore >= 70
      ? 40
      : riskScore >= 50
        ? 25
        : riskScore >= 25
          ? 10
          : riskScore < 5
            ? -5
            : 0;
}

export function verifyMaxMindAlertSignature(
  secret: string,
  rawQuery: string,
  signature: string,
): boolean {
  const expected = createHmac("sha256", secret).update(rawQuery).digest("hex");
  const supplied = signature.trim().toLowerCase();
  return supplied.length === expected.length
    && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function signalsFor(raw: JsonObject, riskScore: number): MaxMindRiskSignal[] {
  const result: MaxMindRiskSignal[] = [{
    key: "maxmind_factors_risk",
    label: "MaxMind minFraud Factors",
    detail: `MaxMind assessed this event at ${riskScore.toFixed(2)} risk.`,
    points: maxMindRiskPoints(riskScore),
  }];
  if (Array.isArray(raw.risk_score_reasons) && raw.risk_score_reasons.length) {
    result.push({
      key: "maxmind_risk_reasons",
      label: "MaxMind risk reasons",
      detail: "MaxMind returned the model factors that moved its risk score.",
      points: 0,
    });
  }
  return result;
}

export class MaxMindService {
  constructor(
    private readonly config: Config,
    private readonly pool: Pool,
    private readonly log?: FastifyBaseLogger,
    private readonly reportProviderAccessIssue?: (
      issue: ProviderAccessIssue,
    ) => void | Promise<unknown>,
  ) {}

  private reportAccessIssue(issue: ProviderAccessIssue | undefined): void {
    if (!issue || !this.reportProviderAccessIssue) return;
    void Promise.resolve(this.reportProviderAccessIssue(issue)).catch(() => {
      // Provider evidence and containment must not depend on alert transport.
    });
  }

  private scrub(value: string): string {
    const licenseKey = this.config.MAXMIND_LICENSE_KEY;
    return (licenseKey ? value.replaceAll(licenseKey, "[redacted]") : value)
      .slice(0, 200);
  }

  async evaluate(input: MaxMindEvaluationInput): Promise<MaxMindEvaluation> {
    if (!this.config.MAXMIND_ACCOUNT_ID || !this.config.MAXMIND_LICENSE_KEY) {
      this.reportAccessIssue({ provider: "maxmind", kind: "missing_credential" });
      throw new Error("maxmind_not_configured");
    }
    const cached = await this.pool.query<{
      status: "success" | "failed";
      minfraud_id: string | null;
      risk_score: string | null;
      ip_risk: string | null;
      disposition: string | null;
      normalized_signals: MaxMindRiskSignal[];
      response: JsonObject | null;
      error_code: string | null;
    }>(
      `SELECT status, minfraud_id::text, risk_score::text, ip_risk::text,
              disposition, normalized_signals, response, error_code
         FROM maxmind_evaluations
        WHERE event_key=$1 AND status='success'`,
      [input.eventKey],
    );
    const existing = cached.rows[0];
    if (existing) return {
      status: existing.status,
      minfraudId: existing.minfraud_id,
      riskScore: number(existing.risk_score),
      ipRisk: number(existing.ip_risk),
      disposition: existing.disposition,
      signals: existing.normalized_signals ?? [],
      response: existing.response,
      errorCode: existing.error_code,
    };

    let evaluation: MaxMindEvaluation;
    try {
      const normalizedUsername = input.username?.trim().toLowerCase();
      const body = compact({
        device: compact({
          ip_address: input.ipAddress?.trim(),
          user_agent: input.userAgent?.trim().slice(0, 512),
        }),
        event: {
          transaction_id: input.transactionId,
          shop_id: input.shopId,
          type: input.eventType,
          time: input.occurredAt.toISOString(),
          party: "customer",
        },
        account: compact({
          user_id: input.userId,
          username_md5: normalizedUsername
            ? createHash("md5").update(normalizedUsername).digest("hex")
            : undefined,
        }),
        email: input.email?.trim() ? { address: input.email.trim().toLowerCase() } : undefined,
        billing: compact({
          country: input.billingCountry?.trim().toUpperCase().slice(0, 2),
          region: input.billingRegion?.trim().slice(0, 255),
          city: input.billingCity?.trim().slice(0, 255),
        }),
        payment: compact({
          method: input.paymentMethod,
          was_authorized: input.paymentWasAuthorized,
        }),
        credit_card: input.cardLast4?.trim()
          ? compact({
              last_digits: input.cardLast4.trim().slice(-4),
              was_3d_secure_successful: input.was3dSecureSuccessful,
            })
          : input.was3dSecureSuccessful !== null
              && input.was3dSecureSuccessful !== undefined
            ? { was_3d_secure_successful: input.was3dSecureSuccessful }
            : undefined,
        order: input.amount !== null && input.amount !== undefined
          ? compact({ amount: Math.max(0, input.amount), currency: input.currency?.toUpperCase() })
          : undefined,
      });
      const authorization = Buffer.from(
        `${this.config.MAXMIND_ACCOUNT_ID}:${this.config.MAXMIND_LICENSE_KEY}`,
      ).toString("base64");
      const provider = await fetch(
        "https://minfraud.maxmind.com/minfraud/v2.0/factors",
        {
          method: "POST",
          signal: AbortSignal.timeout(8_000),
          headers: {
            accept: "application/json",
            authorization: `Basic ${authorization}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      if (!provider.ok) throw new Error(`http_${provider.status}`);
      const text = await provider.text();
      if (text.length > 512_000) throw new Error("response_too_large");
      const raw = object(JSON.parse(text));
      this.reportAccessIssue(maxmindAccessIssue(raw));
      const riskScore = number(raw.risk_score);
      const minfraudId = string(raw.id);
      if (riskScore === null || riskScore < 0 || riskScore > 100 || !minfraudId) {
        throw new Error("invalid_response");
      }
      evaluation = {
        status: "success",
        minfraudId,
        riskScore,
        ipRisk: number(path(raw, "ip_address", "risk")),
        disposition: string(path(raw, "disposition", "action")),
        signals: signalsFor(raw, riskScore),
        response: {
          evidence_contract: "maxmind-factors-sanitized-v1",
          ...boundedEvidence(raw) as JsonObject,
        },
        errorCode: null,
      };
    } catch (error) {
      const message = error instanceof Error
        ? `${error.name}:${error.message}`
        : "unknown_error";
      this.reportAccessIssue(providerFailureAccessIssue("maxmind", message));
      evaluation = {
        status: "failed",
        minfraudId: null,
        riskScore: null,
        ipRisk: null,
        disposition: null,
        signals: [],
        response: null,
        errorCode: this.scrub(message),
      };
    }

    await this.pool.query(
      `INSERT INTO maxmind_evaluations(
         event_key,user_id,event_type,transaction_id,minfraud_id,status,
         risk_score,ip_risk,disposition,response,normalized_signals,error_code,
         occurred_at,checked_at
       ) VALUES ($1,$2,$3,$4,$5::uuid,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,now())
       ON CONFLICT (event_key) DO UPDATE SET
         minfraud_id=EXCLUDED.minfraud_id,status=EXCLUDED.status,
         risk_score=EXCLUDED.risk_score,ip_risk=EXCLUDED.ip_risk,
         disposition=EXCLUDED.disposition,response=EXCLUDED.response,
         normalized_signals=EXCLUDED.normalized_signals,error_code=EXCLUDED.error_code,
         checked_at=now()`,
      [
        input.eventKey,
        input.userId,
        input.eventType,
        input.transactionId,
        evaluation.minfraudId,
        evaluation.status,
        evaluation.riskScore,
        evaluation.ipRisk,
        evaluation.disposition,
        evaluation.response ? JSON.stringify(evaluation.response) : null,
        JSON.stringify(evaluation.signals),
        evaluation.errorCode,
        input.occurredAt,
      ],
    );
    return evaluation;
  }

  async queueCaseFeedback(
    client: PoolClient,
    input: { caseId: string; userId: string; decision: "resolved_safe" | "resolved_fraud" },
  ): Promise<void> {
    const tag = input.decision === "resolved_safe" ? "not_fraud" : "suspected_fraud";
    await client.query(
      `INSERT INTO maxmind_report_outbox(minfraud_id,user_id,tag,source_ref)
       SELECT DISTINCT minfraud_id,$1,$2,$3
       FROM (
         SELECT minfraud_id FROM maxmind_evaluations
          WHERE user_id=$1 AND status='success' AND minfraud_id IS NOT NULL
         UNION
         SELECT request_id::uuid FROM provider_checks
          WHERE user_id=$1 AND provider='maxmind' AND status='success'
            AND request_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       ) evidence
       ON CONFLICT DO NOTHING`,
      [input.userId, tag, `case:${input.caseId}`],
    );
  }

  async drainReports(): Promise<number> {
    if (!this.config.MAXMIND_ACCOUNT_ID || !this.config.MAXMIND_LICENSE_KEY) {
      return 0;
    }
    const pending = await this.pool.query<{
      id: string;
      minfraud_id: string;
      tag: string;
    }>(
      `SELECT id::text,minfraud_id::text,tag FROM maxmind_report_outbox
        WHERE delivered_at IS NULL AND next_attempt_at<=now()
        ORDER BY created_at LIMIT 25`,
    );
    for (const row of pending.rows) {
      try {
        const authorization = Buffer.from(
          `${this.config.MAXMIND_ACCOUNT_ID}:${this.config.MAXMIND_LICENSE_KEY}`,
        ).toString("base64");
        const response = await fetch(
          "https://minfraud.maxmind.com/minfraud/v2.0/transactions/report",
          {
            method: "POST",
            signal: AbortSignal.timeout(8_000),
            headers: {
              authorization: `Basic ${authorization}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ minfraud_id: row.minfraud_id, tag: row.tag }),
          },
        );
        if (!response.ok) throw new Error(`http_${response.status}`);
        await this.pool.query(
          `UPDATE maxmind_report_outbox SET delivered_at=now(),last_error=NULL WHERE id=$1`,
          [row.id],
        );
      } catch (error) {
        const message = this.scrub(error instanceof Error ? error.message : "unknown_error");
        this.reportAccessIssue(providerFailureAccessIssue("maxmind", message));
        await this.pool.query(
          `UPDATE maxmind_report_outbox SET attempts=attempts+1,last_error=$2,
             next_attempt_at=now()+make_interval(secs=>LEAST(3600,30*power(2,LEAST(attempts,7))::int))
           WHERE id=$1`,
          [row.id, message],
        );
        this.log?.warn({ outboxId: row.id, err: message }, "MaxMind feedback delivery failed");
      }
    }
    return pending.rows.length;
  }

  verifyAlert(rawQuery: string, signature: string | string[] | undefined): boolean {
    if (!this.config.MAXMIND_ALERT_WEBHOOK_SECRET || typeof signature !== "string") return false;
    return verifyMaxMindAlertSignature(
      this.config.MAXMIND_ALERT_WEBHOOK_SECRET,
      rawQuery,
      signature,
    );
  }

  async acceptAlert(rawQuery: string): Promise<void> {
    const query = new URLSearchParams(rawQuery);
    const minfraudId = query.get("minfraud_id");
    if (!minfraudId || !/^[0-9a-f-]{36}$/i.test(minfraudId)) {
      throw new Error("invalid_minfraud_id");
    }
    const newRisk = number(query.get("new_risk_score"));
    const oldRisk = number(query.get("old_risk_score"));
    const updatedAtRaw = query.get("updated_at");
    const updatedAt = updatedAtRaw && Number.isFinite(new Date(updatedAtRaw).getTime())
      ? new Date(updatedAtRaw)
      : null;
    const user = await this.pool.query<{ user_id: string }>(
      `SELECT user_id FROM maxmind_evaluations WHERE minfraud_id=$1::uuid
       UNION ALL
       SELECT user_id FROM provider_checks WHERE provider='maxmind' AND request_id=$1
       LIMIT 1`,
      [minfraudId],
    );
    const userId = user.rows[0]?.user_id ?? null;
    const payload = Object.fromEntries(query.entries());
    await this.pool.query(
      `INSERT INTO maxmind_alerts(
         minfraud_id,user_id,old_risk_score,new_risk_score,reason_code,reason,
         payload,provider_updated_at
       ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,$8)
       ON CONFLICT DO NOTHING`,
      [
        minfraudId,
        userId,
        oldRisk,
        newRisk,
        query.get("reason_code"),
        query.get("reason"),
        JSON.stringify(payload),
        updatedAt,
      ],
    );
    if (userId && newRisk !== null && newRisk >= 75) {
      const subject = await this.pool.query<{ username: string | null }>(
        `SELECT username FROM subjects WHERE user_id=$1`,
        [userId],
      );
      const active = await this.pool.query<{ id: string }>(
        `SELECT id::text FROM cases WHERE user_id=$1 AND status<>'resolved'
          ORDER BY updated_at DESC LIMIT 1`,
        [userId],
      );
      let caseId = active.rows[0]?.id;
      if (caseId) {
        await this.pool.query(
          `UPDATE cases SET score=GREATEST(score,$2),peak_score=GREATEST(peak_score,$2),
             severity=CASE WHEN $2>=90 THEN 'critical' ELSE 'high' END,
             status=CASE WHEN status='open' THEN 'escalated' ELSE status END,
             summary='MaxMind raised this account to a high fraud-risk score.',updated_at=now()
           WHERE id=$1`,
          [caseId, Math.round(newRisk)],
        );
      } else {
        const opened = await this.pool.query<{ id: string }>(
          `INSERT INTO cases(user_id,subject_type,status,severity,score,peak_score,summary)
           VALUES ($1,'user','escalated',$2,$3,$3,
             'MaxMind raised this account to a high fraud-risk score.')
           RETURNING id::text`,
          [userId, newRisk >= 90 ? "critical" : "high", Math.round(newRisk)],
        );
        caseId = opened.rows[0]?.id;
      }
      await this.pool.query(
        `INSERT INTO risk_events(
           case_id,user_id,event_type,source,source_ref,score_delta,score_after,
           title,detail,payload,occurred_at
         ) VALUES ($1,$2,'behavioral_withdrawal_containment','maxmind_alert',$3,
           $4,$4,'MaxMind risk-score escalation',$5,$6::jsonb,now())
         ON CONFLICT (source,source_ref) WHERE source_ref IS NOT NULL DO NOTHING`,
        [
          caseId,
          userId,
          `${minfraudId}:${updatedAt?.toISOString() ?? newRisk}`,
          Math.round(newRisk),
          `MaxMind increased this transaction to ${newRisk.toFixed(2)} risk.`,
          JSON.stringify({
            containmentRequired: true,
            reasonCode: "maxmind_score_alert",
            minfraudId,
            oldRiskScore: oldRisk,
            newRiskScore: newRisk,
            reasonCodeNative: query.get("reason_code"),
            username: subject.rows[0]?.username ?? null,
          }),
        ],
      );
    }
  }
}

export function registerMaxMindAlertRoute(
  app: FastifyInstance,
  service: MaxMindService,
): void {
  app.get("/v1/providers/maxmind/alerts", {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const rawQuery = request.raw.url?.split("?", 2)[1] ?? "";
    if (!service.verifyAlert(rawQuery, request.headers["x-maxmind-alert-hmac-sha256"])) {
      return reply.code(401).send({ error: "invalid_signature" });
    }
    try {
      await service.acceptAlert(rawQuery);
      return { ok: true };
    } catch (error) {
      request.log.warn({ err: error }, "Rejected malformed MaxMind alert");
      return reply.code(400).send({ error: "invalid_alert" });
    }
  });
}
