import { domainToASCII } from "node:url";

import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";

import type { Databases } from "./db.js";
import { drainOutbox } from "./outbox.js";
import type { Signup } from "./types.js";

const STREAM = "fiat_email_domains";
const GMAIL_PATTERN_STREAM = "fiat_gmail_dot_patterns";
const DEPOSIT_CLUSTER_STREAM = "fiat_suspicious_deposit_clusters_v2";
const BATCH_SIZE = 100;
const CLUSTER_WINDOW_MINUTES = 30;
const CLUSTER_MIN_MEMBERS = 3;

export type CheckoutEmailEvent = {
  source_event_id: string;
  provider_event_id: string;
  deposit_intent_id: string | null;
  provider_payment_id: string | null;
  user_id: string | null;
  username: string | null;
  checkout_email: string;
  payment_method_type: string | null;
  occurred_at: Date;
};

export type DepositClusterMember = CheckoutEmailEvent & {
  account_identity: string;
  currency: string;
  payment_identity: string;
  requested_amount_cents: number;
};

export type DepositClusterCandidate = DepositClusterMember & {
  cluster_members: DepositClusterMember[];
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
  | "gmail_dot_fragmentation"
  | "suspicious_deposit_cluster";

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
    segments.length < 3 ||
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
  const [root = "", codedFragment = "", numericFragment = ""] = segments;
  const hasCodedNumericSuffix =
    segments.length === 3 &&
    /^[a-z]{10,}$/.test(root) &&
    /^[a-z]{1,3}\d{2,4}$/.test(codedFragment) &&
    /^\d{3,4}$/.test(numericFragment);
  const hasHeavyFragmentation =
    segments.length >= 4 && compactLength >= 12 && shortFragments >= 2;
  if (!hasHeavyFragmentation && !hasCodedNumericSuffix) return null;

  return {
    type: "gmail_dot_fragmentation",
    domain,
    reason: hasCodedNumericSuffix
      ? "Gmail local part contains a long undelimited name followed by coded and numeric dot-separated suffixes"
      : "Gmail local part contains four or more dot-separated segments and multiple one- or two-character fragments",
  };
}

export function suspiciousGmailClusterCandidate(
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
    segments.length < 3 ||
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
  if (
    compactLength < 12 ||
    shortFragments < 1 ||
    (segments.length < 4 && shortFragments < 2)
  ) {
    return null;
  }

  return {
    type: "suspicious_deposit_cluster",
    domain,
    reason:
      "Gmail local part has an unusual fragmented structure and belongs to a coordinated same-amount deposit cluster",
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
          COALESCE(
            NULLIF(pwe.payload #>> '{data,payment_method_type}', ''),
            NULLIF(pwe.payload #>> '{data,payment,payment_method_type}', '')
          ) AS payment_method_type,
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
        COALESCE(
          e.payment_method_type,
          NULLIF(fdi.provider_metadata->>'payment_method_type', ''),
          NULLIF(
            fdi.provider_metadata->'payment'->>'payment_method_type',
            ''
          )
        ) AS payment_method_type,
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
          COALESCE(
            NULLIF(pwe.payload #>> '{data,payment_method_type}', ''),
            NULLIF(pwe.payload #>> '{data,payment,payment_method_type}', '')
          ) AS payment_method_type,
          pwe.received_at AS occurred_at
        FROM payment_webhook_events pwe
        WHERE pwe.provider = 'whop'
          AND pwe.event_type = 'payment.created'
          AND lower(btrim(split_part(
            pwe.payload #>> '{data,user,email}', '@', 2
          ))) IN ('gmail.com', 'googlemail.com')
          AND (
            (
              length(split_part(
                pwe.payload #>> '{data,user,email}', '@', 1
              ))
              - length(replace(split_part(
                pwe.payload #>> '{data,user,email}', '@', 1
              ), '.', ''))
            ) >= 3
            OR lower(split_part(
              pwe.payload #>> '{data,user,email}', '@', 1
            )) ~ '^[a-z]{10,}\.[a-z]{1,3}[0-9]{2,4}\.[0-9]{3,4}(\+[^@]*)?$'
          )
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
        COALESCE(
          e.payment_method_type,
          NULLIF(fdi.provider_metadata->>'payment_method_type', ''),
          NULLIF(
            fdi.provider_metadata->'payment'->>'payment_method_type',
            ''
          )
        ) AS payment_method_type,
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

type RawDepositClusterCandidate = Omit<
  DepositClusterCandidate,
  "cluster_members" | "requested_amount_cents"
> & {
  requested_amount_cents: number | string;
  cluster_members: unknown;
};

function parseDepositClusterMember(value: unknown): DepositClusterMember | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const occurredAt = new Date(String(row.occurred_at ?? ""));
  const amount = Number(row.requested_amount_cents);
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    Number.isNaN(occurredAt.getTime())
  ) {
    return null;
  }
  const required = [
    "source_event_id",
    "provider_event_id",
    "provider_payment_id",
    "user_id",
    "checkout_email",
    "account_identity",
    "currency",
    "payment_identity",
  ] as const;
  if (
    required.some(
      (key) => typeof row[key] !== "string" || row[key].trim().length === 0,
    )
  ) {
    return null;
  }
  return {
    source_event_id: String(row.source_event_id),
    provider_event_id: String(row.provider_event_id),
    deposit_intent_id:
      typeof row.deposit_intent_id === "string"
        ? row.deposit_intent_id
        : null,
    provider_payment_id: String(row.provider_payment_id),
    user_id: String(row.user_id),
    username: typeof row.username === "string" ? row.username : null,
    checkout_email: String(row.checkout_email).trim().toLowerCase(),
    payment_method_type:
      typeof row.payment_method_type === "string"
        ? row.payment_method_type
        : null,
    account_identity: String(row.account_identity).trim().toLowerCase(),
    currency: String(row.currency).trim().toUpperCase(),
    payment_identity: String(row.payment_identity).trim().toLowerCase(),
    requested_amount_cents: amount,
    occurred_at: occurredAt,
  };
}

export async function fetchSuspiciousDepositClusterCandidates(
  source: pg.Pool,
  cursor: { occurredAt: Date; sourceId: string },
  limit = BATCH_SIZE,
): Promise<DepositClusterCandidate[]> {
  const result = await source.query<RawDepositClusterCandidate>(
    `
      WITH new_candidates AS (
        SELECT
          pwe.id::text AS source_event_id,
          pwe.provider_event_id,
          fdi.id::text AS deposit_intent_id,
          NULLIF(pwe.payload #>> '{data,id}', '') AS provider_payment_id,
          fdi.user_id,
          u.username,
          lower(btrim(pwe.payload #>> '{data,user,email}')) AS checkout_email,
          COALESCE(
            NULLIF(fdi.provider_metadata ->> 'payment_method_type', ''),
            NULLIF(pwe.payload #>> '{data,payment_method_type}', ''),
            'card'
          ) AS payment_method_type,
          lower(NULLIF(pwe.payload #>> '{data,user,id}', ''))
            AS account_identity,
          upper(fdi.currency) AS currency,
          lower(NULLIF(pwe.payload #>> '{data,id}', ''))
            AS payment_identity,
          fdi.requested_amount_cents,
          pwe.received_at AS occurred_at
        FROM payment_webhook_events pwe
        JOIN fiat_deposit_intents fdi
          ON fdi.id::text = NULLIF(
            pwe.payload #>> '{data,metadata,deposit_intent_id}', ''
          )
        LEFT JOIN "user" u ON u.id = fdi.user_id
        WHERE pwe.provider = 'whop'
          AND pwe.event_type = 'payment.created'
          AND NULLIF(pwe.payload #>> '{data,id}', '') IS NOT NULL
          AND NULLIF(pwe.payload #>> '{data,user,id}', '') IS NOT NULL
          AND fdi.user_id IS NOT NULL
          AND fdi.requested_amount_cents > 0
          AND NULLIF(btrim(fdi.currency), '') IS NOT NULL
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
          ) >= 2
          AND length(replace(split_part(
            pwe.payload #>> '{data,user,email}', '@', 1
          ), '.', '')) >= 12
          AND (pwe.received_at, pwe.id::text) >
            ($1::timestamptz, $2::text)
        ORDER BY pwe.received_at, pwe.id::text
        LIMIT $3
      ),
      bounds AS (
        SELECT
          min(occurred_at) - interval '30 minutes' AS from_at,
          max(occurred_at) AS through_at
        FROM new_candidates
      ),
      candidate_pool AS (
        SELECT
          pwe.id::text AS source_event_id,
          pwe.provider_event_id,
          fdi.id::text AS deposit_intent_id,
          NULLIF(pwe.payload #>> '{data,id}', '') AS provider_payment_id,
          fdi.user_id,
          u.username,
          lower(btrim(pwe.payload #>> '{data,user,email}')) AS checkout_email,
          COALESCE(
            NULLIF(fdi.provider_metadata ->> 'payment_method_type', ''),
            NULLIF(pwe.payload #>> '{data,payment_method_type}', ''),
            'card'
          ) AS payment_method_type,
          lower(NULLIF(pwe.payload #>> '{data,user,id}', ''))
            AS account_identity,
          upper(fdi.currency) AS currency,
          lower(NULLIF(pwe.payload #>> '{data,id}', ''))
            AS payment_identity,
          fdi.requested_amount_cents,
          pwe.received_at AS occurred_at
        FROM payment_webhook_events pwe
        JOIN fiat_deposit_intents fdi
          ON fdi.id::text = NULLIF(
            pwe.payload #>> '{data,metadata,deposit_intent_id}', ''
          )
        LEFT JOIN "user" u ON u.id = fdi.user_id
        CROSS JOIN bounds b
        WHERE b.from_at IS NOT NULL
          AND pwe.provider = 'whop'
          AND pwe.event_type = 'payment.created'
          AND pwe.received_at BETWEEN b.from_at AND b.through_at
          AND NULLIF(pwe.payload #>> '{data,id}', '') IS NOT NULL
          AND NULLIF(pwe.payload #>> '{data,user,id}', '') IS NOT NULL
          AND fdi.user_id IS NOT NULL
          AND fdi.requested_amount_cents > 0
          AND NULLIF(btrim(fdi.currency), '') IS NOT NULL
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
          ) >= 2
          AND length(replace(split_part(
            pwe.payload #>> '{data,user,email}', '@', 1
          ), '.', '')) >= 12
      )
      SELECT
        n.*,
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'source_event_id', p.source_event_id,
              'provider_event_id', p.provider_event_id,
              'deposit_intent_id', p.deposit_intent_id,
              'provider_payment_id', p.provider_payment_id,
              'user_id', p.user_id,
              'username', p.username,
              'checkout_email', p.checkout_email,
              'payment_method_type', p.payment_method_type,
              'account_identity', p.account_identity,
              'currency', p.currency,
              'payment_identity', p.payment_identity,
              'requested_amount_cents', p.requested_amount_cents,
              'occurred_at', p.occurred_at
            )
            ORDER BY p.occurred_at, p.source_event_id
          )
          FROM candidate_pool p
          WHERE p.currency = n.currency
            AND p.requested_amount_cents = n.requested_amount_cents
            AND p.occurred_at BETWEEN
              n.occurred_at - interval '30 minutes'
              AND n.occurred_at
        ), '[]'::jsonb) AS cluster_members
      FROM new_candidates n
      ORDER BY n.occurred_at, n.source_event_id
    `,
    [cursor.occurredAt, cursor.sourceId, limit],
  );
  return result.rows.map((row) => ({
    ...row,
    requested_amount_cents: Number(row.requested_amount_cents),
    cluster_members: Array.isArray(row.cluster_members)
      ? row.cluster_members
          .map(parseDepositClusterMember)
          .filter((member): member is DepositClusterMember => member !== null)
      : [],
  }));
}

export function qualifyingDepositClusterMembers(
  candidate: DepositClusterCandidate,
): DepositClusterMember[] | null {
  const fromAt =
    candidate.occurred_at.getTime() - CLUSTER_WINDOW_MINUTES * 60_000;
  const unique = new Map<string, DepositClusterMember>();
  for (const member of candidate.cluster_members) {
    const occurredAt = member.occurred_at.getTime();
    if (
      member.currency !== candidate.currency ||
      member.requested_amount_cents !== candidate.requested_amount_cents ||
      occurredAt < fromAt ||
      occurredAt > candidate.occurred_at.getTime() ||
      !member.user_id ||
      !member.provider_payment_id ||
      !suspiciousGmailClusterCandidate(member.checkout_email)
    ) {
      continue;
    }
    unique.set(member.source_event_id, member);
  }
  const members = [...unique.values()].sort(
    (left, right) =>
      left.occurred_at.getTime() - right.occurred_at.getTime() ||
      left.source_event_id.localeCompare(right.source_event_id),
  );
  if (members.length < CLUSTER_MIN_MEMBERS) return null;
  const accounts = new Set(
    members.map((member) => member.account_identity),
  );
  const payments = new Set(
    members.map((member) => member.payment_identity),
  );
  const emails = new Set(members.map((member) => member.checkout_email));
  if (
    accounts.size < CLUSTER_MIN_MEMBERS ||
    payments.size < CLUSTER_MIN_MEMBERS ||
    emails.size < CLUSTER_MIN_MEMBERS
  ) {
    return null;
  }
  return members;
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
    await this.db.antifraud.query(
      `
        INSERT INTO source_cursors(stream, occurred_at, source_id)
        VALUES ($1, now() - interval '7 days', '')
        ON CONFLICT (stream) DO NOTHING
      `,
      [DEPOSIT_CLUSTER_STREAM],
    );
  }

  async process(): Promise<void> {
    await this.captureNewEvents();
    await this.backfillSuspiciousGmailPatterns();
    await this.captureSuspiciousDepositClusters();
    await this.backfillOneDomain();
    await this.confirmLocks();
    await this.releaseConfirmedClusterAlerts();
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
        payment_method_type: null,
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

  private async captureSuspiciousDepositClusters(): Promise<void> {
    const cursor = await this.db.antifraud.query<{
      occurred_at: Date;
      source_id: string;
    }>(
      "SELECT occurred_at, source_id FROM source_cursors WHERE stream = $1",
      [DEPOSIT_CLUSTER_STREAM],
    );
    const current = cursor.rows[0];
    if (!current) throw new Error("Fiat deposit-cluster cursor is missing");

    const candidates = await fetchSuspiciousDepositClusterCandidates(
      this.db.source,
      {
        occurredAt: current.occurred_at,
        sourceId: current.source_id,
      },
    );
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      for (const candidate of candidates) {
        const members = qualifyingDepositClusterMembers(candidate);
        if (!members) continue;
        const accountCount = new Set(
          members.map((member) => member.account_identity),
        ).size;
        const paymentCount = new Set(
          members.map((member) => member.payment_identity),
        ).size;
        const reason =
          `${accountCount} distinct Whop accounts and ${paymentCount} ` +
          `distinct payments ` +
          `used unusual Gmail aliases for ${candidate.requested_amount_cents} ` +
          `${candidate.currency} cents within ${CLUSTER_WINDOW_MINUTES} minutes`;
        for (const member of members) {
          await this.persistMatch(
            client,
            { ...member, match_source: "whop_checkout" },
            {
              type: "suspicious_deposit_cluster",
              domain: domainFromEmail(member.checkout_email) ?? "gmail.com",
              reason,
            },
          );
          await client.query(
            `
              UPDATE fiat_email_domain_matches
              SET match_type = 'suspicious_deposit_cluster',
                  updated_at = now()
              WHERE source_event_id = $1
                AND match_type = 'gmail_dot_fragmentation'
            `,
            [member.source_event_id],
          );
        }
        await client.query(
          `
            DELETE FROM fiat_problem_alert_outbox
            WHERE problem_code = 'blacklisted_email_domain'
              AND discord_delivered_at IS NULL
              AND details ->> 'email_risk_type' =
                'gmail_dot_fragmentation'
              AND source_id = ANY($1::text[])
          `,
          [
            members.map(
              (member) =>
                `${member.source_event_id}:blacklisted_email_domain:` +
                `${domainFromEmail(member.checkout_email) ?? "gmail.com"}`,
            ),
          ],
        );

        const existingAlert = await client.query<{ source_id: string }>(
          `
            SELECT source_id
            FROM fiat_problem_alert_outbox
            WHERE problem_code = 'suspicious_deposit_cluster'
              AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(
                  details -> 'cluster_source_event_ids'
                ) AS prior(source_event_id)
                WHERE prior.source_event_id = ANY($1::text[])
              )
              AND occurred_at BETWEEN
                $2::timestamptz - interval '30 minutes'
                AND $2::timestamptz
            ORDER BY occurred_at DESC
            LIMIT 1
          `,
          [
            members.map((member) => member.source_event_id),
            candidate.occurred_at,
          ],
        );
        if (existingAlert.rows.length > 0) continue;

        await client.query(
          `
            INSERT INTO fiat_problem_alert_outbox (
              source_kind, source_id, problem_code, user_id, username,
              details, occurred_at, next_attempt_at
            ) VALUES (
              'payment_webhook',
              $1,
              'suspicious_deposit_cluster',
              $2,
              $3,
              $4::jsonb,
              $5,
              'infinity'::timestamptz
            )
            ON CONFLICT (source_kind, source_id) DO NOTHING
          `,
          [
            `deposit-cluster:${candidate.source_event_id}`,
            candidate.user_id,
            candidate.username,
            {
              provider_event_id: candidate.provider_event_id,
              intent_id: candidate.deposit_intent_id,
              email_risk_type: "suspicious_deposit_cluster",
              email_risk_reason: reason,
              risk_score: 100,
              status: "withdrawals_locked",
              currency: candidate.currency,
              amount_cents: candidate.requested_amount_cents,
              cluster_member_count: members.length,
              cluster_account_count: accountCount,
              cluster_payment_count: paymentCount,
              cluster_window_minutes: CLUSTER_WINDOW_MINUTES,
              cluster_emails: [
                ...new Set(
                  members.map((member) => member.checkout_email),
                ),
              ],
              cluster_source_event_ids: members.map(
                (member) => member.source_event_id,
              ),
            },
            candidate.occurred_at,
          ],
        );
      }
      const last = candidates.at(-1);
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
          DEPOSIT_CLUSTER_STREAM,
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
    const clusterMatch = risk.type === "suspicious_deposit_cluster";
    const title = clusterMatch
      ? "Suspicious Whop deposit cluster member"
      : patternMatch
      ? isSignup
        ? "Suspicious dot-fragmented signup email"
        : "Suspicious dot-fragmented Whop email"
      : isSignup
      ? "Blacklisted signup email"
      : "Blacklisted Whop checkout email";
    const detail = clusterMatch
      ? "Whop checkout belongs to a same-amount cluster with distinct accounts, payment identities, and unusual Gmail aliases. Crypto and item withdrawals must be locked automatically."
      : patternMatch
      ? `${isSignup ? "Signup" : "Whop checkout"} used a suspicious dot-fragmented Gmail address. Crypto and item withdrawals must be locked and KYC required automatically.`
      : `${isSignup ? "Signup" : "Whop checkout"} used blacklisted email domain ${risk.domain}. Crypto and item withdrawals must be locked and KYC required automatically.`;
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
            'providerEventId', $14::text,
            'paymentMethodType', $15::text
          ),
          $16
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
        event.payment_method_type,
        event.occurred_at,
      ],
    );

    if (!clusterMatch) {
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
              'payment_method_type', $13::text,
              'risk_score', 100,
              'status', 'withdrawals_locked'
            ),
            $14, 'infinity'::timestamptz
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
          event.payment_method_type,
          event.occurred_at,
        ],
      );
    }
    return true;
  }

  private async confirmLocks(): Promise<void> {
    let lockedUsers = new Set<string>();
    await drainOutbox<PendingMatch>({
      fetchPending: async () => {
        const pending = await this.db.antifraud.query<PendingMatch>(
          `
            SELECT
              source_event_id, match_source, provider_event_id,
              deposit_intent_id, provider_payment_id, user_id, username,
              checkout_email, domain, match_type, occurred_at, attempt_count
            FROM fiat_email_domain_matches
            WHERE lock_delivered_at IS NULL
              AND next_attempt_at <= now()
            ORDER BY occurred_at
            LIMIT 25
          `,
        );
        if (pending.rows.length === 0) return [];
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
        lockedUsers = new Set(locked.rows.map((row) => row.user_id));
        return pending.rows;
      },
      attemptCount: (match) => match.attempt_count,
      attempt: async (match) => ({
        delivered: lockedUsers.has(match.user_id),
      }),
      record: async (match, outcome) => {
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
            [
              match.source_event_id,
              outcome.delivered,
              outcome.attempt,
              outcome.retrySeconds,
            ],
          );
          if (outcome.delivered) {
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
      },
      onRecorded: (match, outcome) => {
        if (!outcome.delivered) {
          this.log.warn(
          {
            sourceEventId: match.source_event_id,
            domain: match.domain,
              retrySeconds: outcome.retrySeconds,
          },
          "Blacklisted email-domain match is waiting for withdrawal-lock confirmation",
          );
        }
      },
    });
  }

  private async releaseConfirmedClusterAlerts(): Promise<void> {
    await this.db.antifraud.query(
      `
        UPDATE fiat_problem_alert_outbox AS alert
        SET next_attempt_at = now(), updated_at = now()
        WHERE alert.problem_code = 'suspicious_deposit_cluster'
          AND alert.discord_delivered_at IS NULL
          AND alert.next_attempt_at = 'infinity'::timestamptz
          AND jsonb_typeof(
            alert.details -> 'cluster_source_event_ids'
          ) = 'array'
          AND jsonb_array_length(
            alert.details -> 'cluster_source_event_ids'
          ) >= 3
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(
              alert.details -> 'cluster_source_event_ids'
            ) AS member(source_event_id)
            LEFT JOIN fiat_email_domain_matches AS matched
              ON matched.source_event_id = member.source_event_id
            WHERE matched.source_event_id IS NULL
              OR matched.lock_delivered_at IS NULL
          )
      `,
    );
  }
}
