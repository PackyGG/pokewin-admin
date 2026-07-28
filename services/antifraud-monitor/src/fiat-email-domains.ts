import { domainToASCII } from "node:url";

import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";

import type { Databases } from "./db.js";

const STREAM = "fiat_email_domains";
const BATCH_SIZE = 100;

export type CheckoutEmailEvent = {
  source_event_id: string;
  provider_event_id: string;
  deposit_intent_id: string | null;
  provider_payment_id: string | null;
  user_id: string | null;
  username: string | null;
  checkout_email: string;
  occurred_at: Date;
};

type PendingMatch = Omit<CheckoutEmailEvent, "user_id"> & {
  user_id: string;
  domain: string;
  attempt_count: number;
};

export function normalizeEmailDomain(value: string): string | null {
  const trimmed = value.trim().toLowerCase().replace(/^@+/, "");
  if (
    trimmed.length === 0 ||
    trimmed.length > 253 ||
    trimmed.includes("/") ||
    trimmed.includes(":") ||
    trimmed.includes("@")
  ) {
    return null;
  }
  const ascii = domainToASCII(trimmed);
  if (!ascii || ascii.length > 253 || !ascii.includes(".")) return null;
  const labels = ascii.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        label.startsWith("-") ||
        label.endsWith("-") ||
        !/^[a-z0-9-]+$/.test(label),
    )
  ) {
    return null;
  }
  return ascii;
}

export function domainFromEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return normalizeEmailDomain(email.slice(at + 1));
}

export async function fetchCheckoutEmailEvents(
  source: pg.Pool,
  cursor: { occurredAt: Date; sourceId: string },
  limit = BATCH_SIZE,
  domain?: string,
): Promise<CheckoutEmailEvent[]> {
  const result = await source.query<CheckoutEmailEvent>(
    `
      WITH events AS (
        SELECT
          pwe.id::text AS source_event_id,
          pwe.provider_event_id,
          NULLIF(pwe.payload #>> '{data,metadata,deposit_intent_id}', '')
            AS metadata_intent_id,
          NULLIF(pwe.payload #>> '{data,metadata,internal_user_id}', '')
            AS metadata_user_id,
          NULLIF(pwe.payload #>> '{data,id}', '') AS provider_payment_id,
          lower(btrim(pwe.payload #>> '{data,user,email}')) AS checkout_email,
          pwe.received_at AS occurred_at
        FROM payment_webhook_events pwe
        WHERE pwe.provider = 'whop'
          AND pwe.event_type = 'payment.created'
          AND NULLIF(btrim(pwe.payload #>> '{data,user,email}'), '') IS NOT NULL
          AND (pwe.received_at, pwe.id::text) > ($1::timestamptz, $2::text)
          AND (
            $4::text IS NULL
            OR lower(split_part(pwe.payload #>> '{data,user,email}', '@', 2))
              = $4::text
          )
        ORDER BY pwe.received_at, pwe.id::text
        LIMIT $3
      )
      SELECT
        e.source_event_id,
        e.provider_event_id,
        COALESCE(fdi.id::text, e.metadata_intent_id) AS deposit_intent_id,
        e.provider_payment_id,
        COALESCE(fdi.user_id, e.metadata_user_id) AS user_id,
        u.username,
        e.checkout_email,
        e.occurred_at
      FROM events e
      LEFT JOIN fiat_deposit_intents fdi
        ON fdi.id::text = e.metadata_intent_id
      LEFT JOIN "user" u
        ON u.id = COALESCE(fdi.user_id, e.metadata_user_id)
      ORDER BY e.occurred_at, e.source_event_id
    `,
    [cursor.occurredAt, cursor.sourceId, limit, domain ?? null],
  );
  return result.rows;
}

export class FiatEmailDomainGuard {
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

  async process(): Promise<void> {
    await this.captureNewEvents();
    await this.backfillOneDomain();
    await this.confirmLocks();
  }

  private async activeDomains(): Promise<Set<string>> {
    const result = await this.db.antifraud.query<{ domain: string }>(
      "SELECT domain FROM fiat_email_domain_blacklist WHERE enabled",
    );
    return new Set(result.rows.map((row) => row.domain));
  }

  private async captureNewEvents(): Promise<void> {
    const cursor = await this.db.antifraud.query<{
      occurred_at: Date;
      source_id: string;
    }>(
      "SELECT occurred_at, source_id FROM source_cursors WHERE stream = $1",
      [STREAM],
    );
    const current = cursor.rows[0];
    if (!current) throw new Error("Fiat email-domain cursor is missing");

    const events = await fetchCheckoutEmailEvents(this.db.source, {
      occurredAt: current.occurred_at,
      sourceId: current.source_id,
    });
    if (events.length === 0) return;

    const active = await this.activeDomains();
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      for (const event of events) {
        const domain = domainFromEmail(event.checkout_email);
        if (domain && event.user_id && active.has(domain)) {
          await this.persistMatch(client, event, domain);
        }
      }
      const last = events.at(-1);
      if (!last) throw new Error("Fiat email-domain batch was empty");
      await client.query(
        `
          UPDATE source_cursors
          SET occurred_at = $2, source_id = $3, updated_at = now()
          WHERE stream = $1
        `,
        [STREAM, last.occurred_at, last.source_event_id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async backfillOneDomain(): Promise<void> {
    const rule = await this.db.antifraud.query<{
      id: string;
      domain: string;
      backfill_received_at: Date;
      backfill_source_id: string;
    }>(
      `
        SELECT id, domain, backfill_received_at, backfill_source_id
        FROM fiat_email_domain_blacklist
        WHERE enabled AND backfill_completed_at IS NULL
        ORDER BY created_at
        LIMIT 1
      `,
    );
    const current = rule.rows[0];
    if (!current) return;

    const events = await fetchCheckoutEmailEvents(
      this.db.source,
      {
        occurredAt: current.backfill_received_at,
        sourceId: current.backfill_source_id,
      },
      BATCH_SIZE,
      current.domain,
    );

    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      for (const event of events) {
        if (event.user_id) {
          await this.persistMatch(client, event, current.domain);
        }
      }
      const last = events.at(-1);
      await client.query(
        `
          UPDATE fiat_email_domain_blacklist
          SET
            backfill_received_at = COALESCE($2, backfill_received_at),
            backfill_source_id = COALESCE($3, backfill_source_id),
            backfill_completed_at = CASE
              WHEN $4::boolean THEN now()
              ELSE NULL
            END,
            updated_at = now()
          WHERE id = $1
        `,
        [
          current.id,
          last?.occurred_at ?? null,
          last?.source_event_id ?? null,
          events.length < BATCH_SIZE,
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

  private async persistMatch(
    client: pg.PoolClient,
    event: CheckoutEmailEvent,
    domain: string,
  ): Promise<void> {
    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO fiat_email_domain_matches (
          source_event_id, provider_event_id, deposit_intent_id,
          provider_payment_id, user_id, username, checkout_email, domain,
          occurred_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (source_event_id) DO NOTHING
        RETURNING id
      `,
      [
        event.source_event_id,
        event.provider_event_id,
        event.deposit_intent_id,
        event.provider_payment_id,
        event.user_id,
        event.username,
        event.checkout_email,
        domain,
        event.occurred_at,
      ],
    );
    if (inserted.rows.length === 0) return;

    await client.query(
      `
        INSERT INTO subjects (
          user_id, username, source_created_at
        ) VALUES ($1,$2,$3)
        ON CONFLICT (user_id) DO UPDATE SET
          username = COALESCE(EXCLUDED.username, subjects.username),
          updated_at = now()
      `,
      [event.user_id, event.username, event.occurred_at],
    );
    await client.query(
      `
        INSERT INTO risk_events (
          user_id, event_type, source, source_ref, score_delta, score_after,
          title, detail, payload, occurred_at
        ) VALUES (
          $1,
          'fiat_blacklisted_email_domain',
          'whop_checkout',
          $2,
          0,
          100,
          'Blacklisted Whop checkout email',
          $3,
          jsonb_build_object(
            'checkoutEmail', $4::text,
            'emailDomain', $5::text,
            'depositIntentId', $6::text,
            'providerPaymentId', $7::text,
            'providerEventId', $8::text
          ),
          $9
        )
        ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL
        DO NOTHING
      `,
      [
        event.user_id,
        `blacklisted-checkout:${event.source_event_id}`,
        `Whop checkout used blacklisted email domain ${domain}. Crypto and item withdrawals must be locked automatically.`,
        event.checkout_email,
        domain,
        event.deposit_intent_id,
        event.provider_payment_id,
        event.provider_event_id,
        event.occurred_at,
      ],
    );

    await client.query(
      `
        INSERT INTO fiat_problem_alert_outbox (
          source_kind, source_id, problem_code, user_id, username, details,
          occurred_at, next_attempt_at
        ) VALUES (
          'payment_webhook', $1, 'blacklisted_email_domain', $2, $3,
          jsonb_build_object(
            'provider_event_id', $4,
            'intent_id', $5,
            'provider_payment_id', $6,
            'checkout_email', $7,
            'email_domain', $8,
            'risk_score', 100,
            'status', 'withdrawals_locked'
          ),
          $9, 'infinity'::timestamptz
        )
        ON CONFLICT (source_kind, source_id) DO NOTHING
      `,
      [
        `${event.source_event_id}:blacklisted_email_domain:${domain}`,
        event.user_id,
        event.username,
        event.provider_event_id,
        event.deposit_intent_id,
        event.provider_payment_id,
        event.checkout_email,
        domain,
        event.occurred_at,
      ],
    );
  }

  private async confirmLocks(): Promise<void> {
    const pending = await this.db.antifraud.query<PendingMatch>(
      `
        SELECT
          source_event_id, provider_event_id, deposit_intent_id,
          provider_payment_id, user_id, username, checkout_email, domain,
          occurred_at, attempt_count
        FROM fiat_email_domain_matches
        WHERE lock_delivered_at IS NULL
          AND next_attempt_at <= now()
        ORDER BY occurred_at
        LIMIT 25
      `,
    );

    if (pending.rows.length === 0) return;
    const locked = await this.db.source.query<{ user_id: string }>(
      `
        SELECT user_id
        FROM user_feature_locks
        WHERE user_id = ANY($1::text[])
          AND 'all' = ANY(locked_withdrawals_crypto)
          AND locked_withdrawals_items = true
      `,
      [[...new Set(pending.rows.map((match) => match.user_id))]],
    );
    const lockedUsers = new Set(locked.rows.map((row) => row.user_id));

    for (const match of pending.rows) {
      const delivered = lockedUsers.has(match.user_id);
      const attempt = match.attempt_count + 1;
      const retrySeconds = Math.min(300, 2 ** Math.min(attempt, 8));
      const client = await this.db.antifraud.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `
            UPDATE fiat_email_domain_matches
            SET
              lock_delivered_at = CASE
                WHEN $2::boolean THEN COALESCE(lock_delivered_at, now())
                ELSE lock_delivered_at
              END,
              attempt_count = $3,
              next_attempt_at = CASE
                WHEN $2::boolean THEN now()
                ELSE now() + ($4::text || ' seconds')::interval
              END,
              last_error = CASE
                WHEN $2::boolean THEN NULL
              ELSE 'Waiting for the withdrawal lock on the MAIN mirror'
              END,
              updated_at = now()
            WHERE source_event_id = $1
          `,
          [match.source_event_id, delivered, attempt, retrySeconds],
        );
        if (delivered) {
          await client.query(
            `
              UPDATE fiat_problem_alert_outbox
              SET next_attempt_at = now(), updated_at = now()
              WHERE source_kind = 'payment_webhook'
                AND source_id = $1
                AND discord_delivered_at IS NULL
            `,
            [
              `${match.source_event_id}:blacklisted_email_domain:${match.domain}`,
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
      if (!delivered) {
        this.log.warn(
          {
            sourceEventId: match.source_event_id,
            domain: match.domain,
            retrySeconds,
          },
          "Blacklisted Whop email match is waiting for withdrawal-lock confirmation",
        );
      }
    }
  }
}
