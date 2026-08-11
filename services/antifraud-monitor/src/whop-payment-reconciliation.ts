import type { FastifyBaseLogger } from "fastify";

import type { Config } from "./config.js";
import type { Databases } from "./db.js";
import {
  type ReconciledWhopPayment,
  WhopHistoryAutoBans,
} from "./whop-history-auto-bans.js";

const CURSOR_STREAM = "whop-payment-reconciliation";
const API_BASE_URL = "https://api.whop.com/api/v1";
const PAGE_SIZE = 25;
const RUN_INTERVAL_MS = 5 * 60_000;
const PAGE_CONTINUATION_DELAY_MS = 1_000;
const CURSOR_OVERLAP_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const RETRIEVE_CONCURRENCY = 5;

const SAFE_RISK_SIGNAL_KEYS = new Set([
  "account_age_days",
  "fraud_decline_rate",
  "prior_dispute_count",
  "prior_fraud_declines",
  "prior_purchase_count",
  "prior_refund_count",
  "user_cards_7d",
  "user_payment_methods",
  "user_high_risk_sessions",
  "proxy_level",
]);

type PaymentPage = {
  data: unknown[];
  page_info: {
    end_cursor?: unknown;
    has_next_page?: unknown;
  };
};

type SanitizedPayment = ReconciledWhopPayment & {
  depositIntentId: string | null;
  status: string | null;
  substatus: string | null;
  riskScore: number | null;
  riskSignals: Array<Record<string, unknown>>;
  createdAt: Date | null;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown, max = 160): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : null;
}

function date(value: unknown): Date | null {
  const parsed = typeof value === "string" ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safePrimitive(value: unknown): string | number | boolean | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return typeof value === "string" ? value.slice(0, 80) : null;
}

function paymentData(value: unknown): Record<string, unknown> {
  const body = record(value);
  const nested = record(body.data);
  return typeof nested.id === "string" ? nested : body;
}

export function sanitizeReconciledWhopPayment(
  value: unknown,
  fallbackUpdatedAt = new Date(),
): SanitizedPayment | null {
  const data = paymentData(value);
  const paymentId = string(data.id, 80);
  if (!paymentId || !/^pay_[A-Za-z0-9]+$/.test(paymentId)) return null;

  const metadata = record(data.metadata);
  const rawUserId = string(metadata.internal_user_id, 128);
  const userId = rawUserId && /^[A-Za-z0-9_-]{8,128}$/.test(rawUserId)
    ? rawUserId
    : null;
  const rawIntentId = string(metadata.deposit_intent_id, 80);
  const depositIntentId = rawIntentId
    && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(rawIntentId)
    ? rawIntentId
    : null;
  if (!userId && !depositIntentId) return null;

  const rawSignals = record(data.risk_signals).signals;
  const riskSignals = (Array.isArray(rawSignals) ? rawSignals : [])
    .flatMap((raw) => {
      const signal = record(raw);
      const key = string(signal.key, 80);
      if (!key || !SAFE_RISK_SIGNAL_KEYS.has(key)) return [];
      return [{
        key,
        category: string(signal.category, 40) ?? "provider",
        label: string(signal.label, 100) ?? key.replaceAll("_", " "),
        value: safePrimitive(signal.value),
      }];
    });
  const updatedAt = date(data.updated_at) ?? fallbackUpdatedAt;
  const status = string(data.status, 80);
  const substatus = string(data.substatus, 80);
  const riskScore = number(data.risk_score);
  const payload = {
    data: {
      id: paymentId,
      status,
      substatus,
      created_at: string(data.created_at, 80),
      updated_at: updatedAt.toISOString(),
      refunded_at: string(data.refunded_at, 80),
      dispute_alerted_at: string(data.dispute_alerted_at, 80),
      auto_refunded: data.auto_refunded === true,
      decline_code: string(data.decline_code, 120),
      three_ds_verified:
        typeof data.three_ds_verified === "boolean"
          ? data.three_ds_verified
          : null,
      risk_score: riskScore,
      risk_signals: { signals: riskSignals },
      metadata: {
        internal_user_id: userId,
        deposit_intent_id: depositIntentId,
      },
    },
  };
  return {
    paymentId,
    userId,
    depositIntentId,
    status,
    substatus,
    riskScore,
    riskSignals,
    createdAt: date(data.created_at),
    updatedAt,
    payload,
  };
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= values.length) return;
        output[index] = await worker(values[index]!);
      }
    },
  ));
  return output;
}

/**
 * Bounded API safety net for Whop's short webhook retry window. It polls one
 * cursor page at a time, stores only allowlisted fraud evidence in Antifraud,
 * and feeds confirmed refunds/disputes through the normal idempotent ban path.
 */
export class WhopPaymentReconciler {
  private nextRunAt = 0;

  constructor(
    private readonly config: Config,
    private readonly db: Databases,
    private readonly autoBans: WhopHistoryAutoBans,
    private readonly log: FastifyBaseLogger,
    private readonly send: typeof fetch = fetch,
  ) {}

  async ensureCursor(): Promise<void> {
    if (!this.enabled()) return;
    await this.db.antifraud.query(
      `
        INSERT INTO source_cursors(stream, occurred_at, source_id)
        VALUES ($1, now() - interval '48 hours', '')
        ON CONFLICT (stream) DO NOTHING
      `,
      [CURSOR_STREAM],
    );
  }

  async process(now = new Date(), signal?: AbortSignal): Promise<number> {
    if (!this.enabled() || now.getTime() < this.nextRunAt) return 0;
    this.nextRunAt = now.getTime() + RUN_INTERVAL_MS;
    const cursorResult = await this.db.antifraud.query<{
      occurred_at: Date;
      source_id: string;
    }>(
      `
        UPDATE source_cursors
        SET updated_at=$2
        WHERE stream=$1
          AND (
            source_id<>''
            OR updated_at <= $2 - interval '5 minutes'
          )
        RETURNING occurred_at, source_id
      `,
      [CURSOR_STREAM, now],
    );
    const cursor = cursorResult.rows[0];
    // `updated_at` is a shared due-time claim. It stops a second replica from
    // repeating a completed first page even though each process has its own
    // in-memory cadence. A non-empty page cursor remains immediately eligible
    // so a long backlog can continue one bounded page at a time.
    if (!cursor) return 0;

    const url = new URL(`${API_BASE_URL}/payments`);
    url.searchParams.set("company_id", this.config.WHOP_COMPANY_ID!);
    url.searchParams.set("first", String(PAGE_SIZE));
    url.searchParams.set("updated_after", cursor.occurred_at.toISOString());
    if (cursor.source_id) url.searchParams.set("after", cursor.source_id);
    const page = await this.fetchJson<PaymentPage>(url, signal);
    const summaries = Array.isArray(page.data) ? page.data : [];
    const paymentIds = summaries.flatMap((summary) => {
      const data = paymentData(summary);
      const id = string(data.id, 80);
      const metadata = record(data.metadata);
      const packyBound = string(metadata.internal_user_id, 128)
        || string(metadata.deposit_intent_id, 80);
      return id && /^pay_[A-Za-z0-9]+$/.test(id) && packyBound ? [id] : [];
    });
    const fetched = await mapConcurrent(
      paymentIds,
      RETRIEVE_CONCURRENCY,
      async (paymentId) => this.fetchJson<unknown>(
        new URL(`${API_BASE_URL}/payments/${encodeURIComponent(paymentId)}`),
        signal,
      ),
    );
    const payments = fetched.flatMap((body) => {
      const payment = sanitizeReconciledWhopPayment(body, now);
      return payment ? [payment] : [];
    });

    await this.storeSnapshots(payments);
    const detected = await this.autoBans.storeReconciledPayments(payments);

    const hasNext = page.page_info?.has_next_page === true;
    const endCursor = string(page.page_info?.end_cursor, 500) ?? "";
    if (hasNext && !endCursor) throw new Error("whop_reconciliation_cursor_invalid");
    await this.db.antifraud.query(
      `
        UPDATE source_cursors
        SET occurred_at=$2, source_id=$3, updated_at=now()
        WHERE stream=$1
      `,
      [
        CURSOR_STREAM,
        hasNext
          ? cursor.occurred_at
          : new Date(now.getTime() - CURSOR_OVERLAP_MS),
        hasNext ? endCursor : "",
      ],
    );
    this.nextRunAt = now.getTime()
      + (hasNext ? PAGE_CONTINUATION_DELAY_MS : RUN_INTERVAL_MS);
    this.log.info(
      { fetched: payments.length, detected, hasNext },
      "Whop payment reconciliation completed",
    );
    return detected;
  }

  private enabled(): boolean {
    return Boolean(this.config.WHOP_ADMIN_KEY && this.config.WHOP_COMPANY_ID);
  }

  private async fetchJson<T>(url: URL, signal?: AbortSignal): Promise<T> {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await this.send(url, {
      headers: {
        authorization: `Bearer ${this.config.WHOP_ADMIN_KEY}`,
        accept: "application/json",
      },
      signal: requestSignal,
    });
    if (!response.ok) {
      throw new Error(`whop_api_${response.status}`);
    }
    return await response.json() as T;
  }

  private async storeSnapshots(
    payments: readonly SanitizedPayment[],
  ): Promise<void> {
    if (payments.length === 0) return;
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      for (const payment of payments) {
        await client.query(
          `
            INSERT INTO whop_payment_snapshots (
              payment_id, user_id, deposit_intent_id, status, substatus,
              provider_risk_score, risk_signals, provider_created_at,
              provider_updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
            ON CONFLICT (payment_id) DO UPDATE SET
              user_id=COALESCE(EXCLUDED.user_id, whop_payment_snapshots.user_id),
              deposit_intent_id=COALESCE(
                EXCLUDED.deposit_intent_id,
                whop_payment_snapshots.deposit_intent_id
              ),
              status=EXCLUDED.status,
              substatus=EXCLUDED.substatus,
              provider_risk_score=EXCLUDED.provider_risk_score,
              risk_signals=EXCLUDED.risk_signals,
              provider_created_at=COALESCE(
                EXCLUDED.provider_created_at,
                whop_payment_snapshots.provider_created_at
              ),
              provider_updated_at=EXCLUDED.provider_updated_at,
              last_synced_at=now()
          `,
          [
            payment.paymentId,
            payment.userId,
            payment.depositIntentId,
            payment.status,
            payment.substatus,
            payment.riskScore,
            JSON.stringify(payment.riskSignals),
            payment.createdAt,
            payment.updatedAt,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
