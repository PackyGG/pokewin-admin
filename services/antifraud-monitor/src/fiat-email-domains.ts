import { domainToASCII } from "node:url";

import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";

import type { Databases } from "./db.js";
import type { Signup } from "./types.js";

const STREAM = "fiat_email_domains";
const GMAIL_PATTERN_STREAM = "fiat_gmail_dot_patterns";
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
  match_type: CheckoutEmailRiskType;
  attempt_count: number;
  match_source: "whop_checkout" | "signup";
};

type EmailDomainMatchEvent = CheckoutEmailEvent & {
  match_source: "whop_checkout" | "signup";
};

export type CheckoutEmailRiskType =
  | "blacklisted_domain"
  | "gmail_dot_fragmentation";

export type CheckoutEmailRisk = {
  type: CheckoutEmailRiskType;
  domain: string;
  reason: string;
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

export function suspiciousGmailDotPattern(
  value: string,
): CheckoutEmailRisk | null {
  const email = value.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const domain = normalizeEmailDomain(email.slice(at + 1));
  if (domain !== "gmail.com" && domain !== "googlemail.com") return null;

  const local = email.slice(0, at).split("+", 1)[0] ?? "";
  const segments = local.split(".");
  if (
    segments.length < 4 ||
    segments.some((segment) => !/^[a-z0-9]+$/.test(segment))
  ) {
    return null;
  }
  const compactLength = segments.reduce(
    (length, segment) => length + segment.length,
    0,
  );
  const shortFragments = segments.filter(
    (segment) => segment.length <= 2,
  ).length;
  if (compactLength < 12 || shortFragments < 2) return null;

  return {
    type: "gmail_dot_fragmentation",
    domain,
    reason:
      "Gmail local part contains four or more dot-separated segments and multiple one- or two-character fragments",
  };
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

export async function fetchSuspiciousGmailEvents(
  source: pg.Pool,
  cursor: { occurredAt: Date; sourceId: string },
  limit = BATCH_SIZE,
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
          AND lower(btrim(split_part(
            pwe.payload #>> '{data,user,email}', '@', 2
          ))) IN ('gmail.com', 'googlemail.com')
          AND (
            length(split_part(
              pwe.payload #>> '{data,user,email}', '@', 1
            ))
            - length(replace(split_part(
              pwe.payload #>> '{data,user,email}', '@', 1
            ), '.', ''))
          ) >= 3
          AND (pwe.received_at, pwe.id::text) > ($1::timestamptz, $2::text)
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
    [cursor.occurredAt, cursor.sourceId, limit],
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
    await this.db.antifraud.query(
      `
        INSERT INTO source_cursors(stream, occurred_at, source_id)
        VALUES ($1, now() - interval '7 days', '')
        ON CONFLICT (stream) DO NOTHING
      `,
      [GMAIL_PATTERN_STREAM],
    );
  }

  async process(): Promise<void> {
    await this.captureNewEvents();
    await this.backfillSuspiciousGmailPatterns();
    await this.backfillOneDomain();
    await this.confirmLocks();
  }

  async persistSignupMatch(
    client: pg.PoolClient,
    signup: Signup,
  ): Promise<boolean> {
    if (!signup.email) return false;
    const domain = domainFromEmail(signup.email);
    if (!domain) return false;
    const active = await client.query<{ active: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM fiat_email_domain_blacklist
          WHERE enabled AND domain = $1
        ) AS active
      `,
      [domain],
    );
    const risk =
      active.rows[0]?.active === true
        ? {
            type: "blacklisted_domain" as const,
            domain,
            reason: `Email domain ${domain} is blacklisted`,
          }
        : suspiciousGmailDotPattern(signup.email);
    if (!risk) return false;
    return this.persistMatch(
      client,
      {
        match_source: "signup",
        source_event_id: `signup:${signup.id}`,
        provider_event_id: `signup:${signup.id}`,
        deposit_intent_id: null,
        provider_payment_id: null,
        user_id: signup.id,
        username: signup.username,
        checkout_email: signup.email.trim().toLowerCase(),
        occurred_at: signup.created_at,
      },
      risk,
    );
  }

  async captureSignup(signup: Signup): Promise<boolean> {
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      const matched = await this.persistSignupMatch(client, signup);
      await client.query("COMMIT");
      return matched;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
        const risk =
          domain && active.has(domain)
            ? {
                type: "blacklisted_domain" as const,
                domain,
                reason: `Email domain ${domain} is blacklisted`,
              }
            : suspiciousGmailDotPattern(event.checkout_email);
        if (risk && event.user_id) {
          await this.persistMatch(
            client,
            { ...event, match_source: "whop_checkout" },
            risk,
          );
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

  private async backfillSuspiciousGmailPatterns(): Promise<void> {
    const cursor = await this.db.antifraud.query<{
      occurred_at: Date;
      source_id: string;
    }>(
      "SELECT occurred_at, source_id FROM source_cursors WHERE stream = $1",
      [GMAIL_PATTERN_STREAM],
    );
    const current = cursor.rows[0];
    if (!current) throw new Error("Fiat Gmail-pattern cursor is missing");

    const events = await fetchSuspiciousGmailEvents(this.db.source, {
      occurredAt: current.occurred_at,
      sourceId: current.source_id,
    });
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      for (const event of events) {
        const risk = suspiciousGmailDotPattern(event.checkout_email);
        if (risk && event.user_id) {
          await this.persistMatch(
            client,
            { ...event, match_source: "whop_checkout" },
            risk,
          );
        }
      }
      const last = events.at(-1);
      await client.query(
        `
          UPDATE source_cursors
          SET
            occurred_at = COALESCE($2, GREATEST(occurred_at, now())),
            source_id = COALESCE($3, ''),
            updated_at = now()
          WHERE stream = $1
        `,
        [
          GMAIL_PATTERN_STREAM,
          last?.occurred_at ?? null,
          last?.source_event_id ?? null,
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
          await this.persistMatch(
            client,
            { ...event, match_source: "whop_checkout" },
            {
              type: "blacklisted_domain",
              domain: current.domain,
              reason: `Email domain ${current.domain} is blacklisted`,
            },
          );
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
    event: EmailDomainMatchEvent,
    risk: CheckoutEmailRisk,
  ): Promise<boolean> {
    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO fiat_email_domain_matches (
          source_event_id, match_source, provider_event_id, deposit_intent_id,
          provider_payment_id, user_id, username, checkout_email, domain,
          match_type, occurred_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (source_event_id) DO NOTHING
        RETURNING id
      `,
      [
        event.source_event_id,
        event.match_source,
        event.provider_event_id,
        event.deposit_intent_id,
        event.provider_payment_id,
        event.user_id,
        event.username,
        event.checkout_email,
        risk.domain,
        risk.type,
        event.occurred_at,
      ],
    );
    if (inserted.rows.length === 0) return false;

    const isSignup = event.match_source === "signup";
    const eventType = "fiat_blacklisted_email_domain";
    const eventSource = isSignup ? "signup" : "whop_checkout";
    const eventRef = isSignup
      ? `blacklisted-signup:${event.source_event_id}`
      : `blacklisted-checkout:${event.source_event_id}`;
    const patternMatch = risk.type === "gmail_dot_fragmentation";
    const title = patternMatch
      ? isSignup
        ? "Suspicious dot-fragmented signup email"
        : "Suspicious dot-fragmented Whop email"
      : isSignup
      ? "Blacklisted signup email"
      : "Blacklisted Whop checkout email";
    const detail = patternMatch
      ? `${isSignup ? "Signup" : "Whop checkout"} used a suspicious dot-fragmented Gmail address. Crypto and item withdrawals must be locked automatically.`
      : `${isSignup ? "Signup" : "Whop checkout"} used blacklisted email domain ${risk.domain}. Crypto and item withdrawals must be locked automatically.`;
    const alertSource = isSignup ? "signup" : "payment_webhook";

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
          $2,
          $3,
          $4,
          0,
          100,
          $5,
          $6,
          jsonb_build_object(
            'email', $7::text,
            'checkoutEmail', CASE WHEN $8::text = 'whop_checkout' THEN $7::text ELSE NULL END,
            'emailDomain', $9::text,
            'matchSource', $8::text,
            'emailRiskType', $10::text,
            'emailRiskReason', $11::text,
            'depositIntentId', $12::text,
            'providerPaymentId', $13::text,
            'providerEventId', $14::text
          ),
          $15
        )
        ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL
        DO NOTHING
      `,
      [
        event.user_id,
        eventType,
        eventSource,
        eventRef,
        title,
        detail,
        event.checkout_email,
        event.match_source,
        risk.domain,
        risk.type,
        risk.reason,
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
          $1, $2, 'blacklisted_email_domain', $3, $4,
          jsonb_build_object(
            'provider_event_id', $5::text,
            'intent_id', $6::text,
            'provider_payment_id', $7::text,
            'email', $8::text,
            'checkout_email', CASE WHEN $9::text = 'whop_checkout' THEN $8::text ELSE NULL END,
            'email_domain', $10::text,
            'match_source', $9,
            'email_risk_type', $11::text,
            'email_risk_reason', $12::text,
            'risk_score', 100,
            'status', 'withdrawals_locked'
          ),
          $13, 'infinity'::timestamptz
        )
        ON CONFLICT (source_kind, source_id) DO NOTHING
      `,
      [
        alertSource,
        `${event.source_event_id}:blacklisted_email_domain:${risk.domain}`,
        event.user_id,
        event.username,
        event.provider_event_id,
        event.deposit_intent_id,
        event.provider_payment_id,
        event.checkout_email,
        event.match_source,
        risk.domain,
        risk.type,
        risk.reason,
        event.occurred_at,
      ],
    );
    return true;
  }

  private async confirmLocks(): Promise<void> {
    const pending = await this.db.antifraud.query<PendingMatch>(
      `
        SELECT
          source_event_id, match_source, provider_event_id, deposit_intent_id,
          provider_payment_id, user_id, username, checkout_email, domain,
          match_type, occurred_at, attempt_count
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
              WHERE source_kind = $2
                AND source_id = $1
                AND discord_delivered_at IS NULL
            `,
            [
              `${match.source_event_id}:blacklisted_email_domain:${match.domain}`,
              match.match_source === "signup" ? "signup" : "payment_webhook",
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
          "Blacklisted email-domain match is waiting for withdrawal-lock confirmation",
        );
      }
    }
  }
}
