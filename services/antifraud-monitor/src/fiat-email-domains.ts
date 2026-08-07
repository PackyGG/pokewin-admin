import { domainToASCII } from "node:url";

import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";

import type { Databases } from "./db.js";
import { drainOutbox } from "./outbox.js";
import type { Signup } from "./types.js";

/**
 * `payment_webhook_events.received_at` and the `fiat_deposit_intents`
 * timestamps are `timestamp without time zone` in the source schema while
 * every cursor in `source_cursors` is `timestamptz`. Pin the naive columns to
 * UTC explicitly — an implicit cast would silently shift by the session
 * timezone, both in the comparison and in the value handed back to Node.
 */
const UTC = "AT TIME ZONE 'UTC'";
const STREAM = "fiat_email_domains";
const GMAIL_PATTERN_STREAM = "fiat_gmail_dot_patterns";
const DEPOSIT_CLUSTER_STREAM = "fiat_suspicious_deposit_clusters_v2";
const REFUNDED_AMOUNT_CLUSTER_STREAM = "fiat_refunded_amount_clusters_v1";
const BATCH_SIZE = 100;
const CLUSTER_WINDOW_MINUTES = 30;
const CLUSTER_MIN_MEMBERS = 3;
const REFUND_CLUSTER_WINDOW_DAYS = 7;
const REFUND_CLUSTER_MIN_MEMBERS = 5;
const REFUND_CLUSTER_MIN_ACCOUNTS = 3;
const REFUND_CLUSTER_MIN_RATIO = 0.5;
/**
 * Past this many failed lock-confirmation attempts the containment almost
 * certainly never landed, so the log line escalates from warn to error.
 */
const LOCK_CONFIRMATION_ALARM_ATTEMPTS = 10;

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

export type RefundedAmountClusterMember = DepositClusterMember & {
  status: "refunded" | "partially_refunded";
  updated_at: Date;
};

export type RefundedAmountClusterCandidate = RefundedAmountClusterMember & {
  total_payment_count: number;
  refunded_members: RefundedAmountClusterMember[];
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
          (pwe.received_at ${UTC}) AS occurred_at
        FROM payment_webhook_events pwe
        WHERE pwe.provider = 'whop'
          AND pwe.event_type = 'payment.created'
          AND NULLIF(btrim(pwe.payload #>> '{data,user,email}'), '') IS NOT NULL
          AND ((pwe.received_at ${UTC}), pwe.id::text)
            > ($1::timestamptz, $2::text)
          AND (
            $4::text IS NULL
            OR lower(split_part(pwe.payload #>> '{data,user,email}', '@', 2))
              = $4::text
          )
        ORDER BY (pwe.received_at ${UTC}), pwe.id::text
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
          (pwe.received_at ${UTC}) AS occurred_at
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
            )) ~ '^[a-z]{10,}\\.[a-z]{1,3}[0-9]{2,4}\\.[0-9]{3,4}(\\+[^@]*)?$'
          )
          AND ((pwe.received_at ${UTC}), pwe.id::text)
            > ($1::timestamptz, $2::text)
        ORDER BY (pwe.received_at ${UTC}), pwe.id::text
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
          (pwe.received_at ${UTC}) AS occurred_at
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
          AND ((pwe.received_at ${UTC}), pwe.id::text) >
            ($1::timestamptz, $2::text)
        ORDER BY (pwe.received_at ${UTC}), pwe.id::text
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
          (pwe.received_at ${UTC}) AS occurred_at
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
          AND (pwe.received_at ${UTC}) BETWEEN b.from_at AND b.through_at
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

type RawRefundedAmountClusterCandidate = Omit<
  RefundedAmountClusterCandidate,
  "requested_amount_cents" | "total_payment_count" | "refunded_members"
> & {
  requested_amount_cents: number | string;
  total_payment_count: number | string;
  refunded_members: unknown;
};

function parseRefundedAmountClusterMember(
  value: unknown,
): RefundedAmountClusterMember | null {
  const base = parseDepositClusterMember(value);
  if (!base || !value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.status !== "refunded" && row.status !== "partially_refunded") {
    return null;
  }
  const updatedAt = row.updated_at instanceof Date
    ? row.updated_at
    : new Date(String(row.updated_at ?? ""));
  if (!Number.isFinite(updatedAt.getTime())) return null;
  return { ...base, status: row.status, updated_at: updatedAt };
}

/**
 * Refunded campaigns are discovered from intent updates, not payment-created
 * cursors: a payment can become fraudulent/refunded days after authorization.
 * The total settled population is returned as the denominator so a common
 * amount such as $20 is never suspicious merely because it is popular.
 */
export async function fetchRefundedAmountClusterCandidates(
  source: pg.Pool,
  cursor: { occurredAt: Date; sourceId: string },
  limit = BATCH_SIZE,
): Promise<RefundedAmountClusterCandidate[]> {
  const result = await source.query<RawRefundedAmountClusterCandidate>(
    `
      WITH new_refunds AS (
        SELECT
          ('refund-amount:' || fdi.id::text) AS source_event_id,
          COALESCE(checkout.provider_event_id, fdi.id::text)
            AS provider_event_id,
          fdi.id::text AS deposit_intent_id,
          COALESCE(fdi.provider_payment_id, checkout.payment_id, fdi.id::text)
            AS provider_payment_id,
          fdi.user_id,
          u.username,
          lower(COALESCE(checkout.checkout_email, u.email, ''))
            AS checkout_email,
          COALESCE(
            NULLIF(fdi.provider_metadata ->> 'payment_method_type', ''),
            checkout.payment_method_type,
            'card'
          ) AS payment_method_type,
          lower(fdi.user_id) AS account_identity,
          upper(fdi.currency) AS currency,
          lower(COALESCE(
            fdi.provider_payment_id,
            checkout.payment_id,
            fdi.id::text
          )) AS payment_identity,
          fdi.requested_amount_cents,
          fdi.status::text AS status,
          (fdi.created_at ${UTC}) AS occurred_at,
          (fdi.updated_at ${UTC}) AS updated_at
        FROM fiat_deposit_intents fdi
        JOIN "user" u ON u.id = fdi.user_id
        LEFT JOIN LATERAL (
          SELECT
            pwe.provider_event_id,
            NULLIF(pwe.payload #>> '{data,id}', '') AS payment_id,
            NULLIF(pwe.payload #>> '{data,user,email}', '') AS checkout_email,
            NULLIF(pwe.payload #>> '{data,payment_method_type}', '')
              AS payment_method_type
          FROM payment_webhook_events pwe
          WHERE pwe.provider = 'whop'
            AND pwe.event_type = 'payment.created'
            AND (
              pwe.payload #>> '{data,metadata,deposit_intent_id}' = fdi.id::text
              OR pwe.provider_resource_id IN (
                fdi.provider_checkout_id,
                fdi.provider_payment_id
              )
            )
          ORDER BY pwe.received_at DESC, pwe.id DESC
          LIMIT 1
        ) checkout ON TRUE
        WHERE fdi.status::text IN ('refunded', 'partially_refunded')
          AND fdi.requested_amount_cents > 0
          AND NULLIF(btrim(fdi.currency), '') IS NOT NULL
          AND ((fdi.updated_at ${UTC}), fdi.id::text) >
            ($1::timestamptz, $2::text)
        ORDER BY (fdi.updated_at ${UTC}), fdi.id::text
        LIMIT $3
      )
      SELECT
        n.*,
        stats.total_payment_count,
        stats.refunded_members
      FROM new_refunds n
      CROSS JOIN LATERAL (
        SELECT
          COUNT(*)::int AS total_payment_count,
          COALESCE(jsonb_agg(jsonb_build_object(
            'source_event_id', 'refund-amount:' || peer.id::text,
            'provider_event_id', COALESCE(
              peer_checkout.provider_event_id,
              peer.id::text
            ),
            'deposit_intent_id', peer.id::text,
            'provider_payment_id', COALESCE(
              peer.provider_payment_id,
              peer_checkout.payment_id,
              peer.id::text
            ),
            'user_id', peer.user_id,
            'username', peer_user.username,
            'checkout_email', lower(COALESCE(
              peer_checkout.checkout_email,
              peer_user.email,
              ''
            )),
            'payment_method_type', COALESCE(
              NULLIF(peer.provider_metadata ->> 'payment_method_type', ''),
              peer_checkout.payment_method_type,
              'card'
            ),
            'account_identity', lower(peer.user_id),
            'currency', upper(peer.currency),
            'payment_identity', lower(COALESCE(
              peer.provider_payment_id,
              peer_checkout.payment_id,
              peer.id::text
            )),
            'requested_amount_cents', peer.requested_amount_cents,
            'status', peer.status::text,
            'occurred_at', (peer.created_at ${UTC}),
            'updated_at', (peer.updated_at ${UTC})
          ) ORDER BY peer.created_at, peer.id::text) FILTER (
            WHERE peer.status::text IN ('refunded', 'partially_refunded')
          ), '[]'::jsonb) AS refunded_members
        FROM fiat_deposit_intents peer
        JOIN "user" peer_user ON peer_user.id = peer.user_id
        LEFT JOIN LATERAL (
          SELECT
            pwe.provider_event_id,
            NULLIF(pwe.payload #>> '{data,id}', '') AS payment_id,
            NULLIF(pwe.payload #>> '{data,user,email}', '') AS checkout_email,
            NULLIF(pwe.payload #>> '{data,payment_method_type}', '')
              AS payment_method_type
          FROM payment_webhook_events pwe
          WHERE pwe.provider = 'whop'
            AND pwe.event_type = 'payment.created'
            AND (
              pwe.payload #>> '{data,metadata,deposit_intent_id}' = peer.id::text
              OR pwe.provider_resource_id IN (
                peer.provider_checkout_id,
                peer.provider_payment_id
              )
            )
          ORDER BY pwe.received_at DESC, pwe.id DESC
          LIMIT 1
        ) peer_checkout ON TRUE
        WHERE upper(peer.currency) = n.currency
          AND peer.requested_amount_cents = n.requested_amount_cents
          AND peer.status::text IN (
            'completed', 'refunded', 'partially_refunded', 'disputed'
          )
          AND (peer.created_at ${UTC}) BETWEEN
            n.occurred_at - interval '3 days 12 hours'
            AND n.occurred_at + interval '3 days 12 hours'
      ) stats
      ORDER BY n.updated_at, n.deposit_intent_id
    `,
    [cursor.occurredAt, cursor.sourceId, limit],
  );
  return result.rows.map((row) => ({
    ...row,
    requested_amount_cents: Number(row.requested_amount_cents),
    total_payment_count: Number(row.total_payment_count),
    refunded_members: Array.isArray(row.refunded_members)
      ? row.refunded_members
          .map(parseRefundedAmountClusterMember)
          .filter((member): member is RefundedAmountClusterMember =>
            member !== null
          )
      : [],
  }));
}

export function qualifyingRefundedAmountCluster(
  candidate: RefundedAmountClusterCandidate,
): {
  members: RefundedAmountClusterMember[];
  refundRatio: number;
  accountCount: number;
  paymentCount: number;
} | null {
  const members = candidate.refunded_members.filter((member) =>
    member.currency === candidate.currency
    && member.requested_amount_cents === candidate.requested_amount_cents
    && Boolean(member.user_id)
    && Boolean(member.payment_identity)
  );
  const unique = [...new Map(
    members.map((member) => [member.source_event_id, member]),
  ).values()];
  const accountCount = new Set(unique.map((member) => member.account_identity))
    .size;
  const paymentCount = new Set(unique.map((member) => member.payment_identity))
    .size;
  const refundRatio = candidate.total_payment_count > 0
    ? unique.length / candidate.total_payment_count
    : 0;
  if (
    unique.length < REFUND_CLUSTER_MIN_MEMBERS
    || accountCount < REFUND_CLUSTER_MIN_ACCOUNTS
    || paymentCount < REFUND_CLUSTER_MIN_MEMBERS
    || refundRatio < REFUND_CLUSTER_MIN_RATIO
  ) {
    return null;
  }
  return { members: unique, refundRatio, accountCount, paymentCount };
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
    await this.db.antifraud.query(
      `
        INSERT INTO source_cursors(stream, occurred_at, source_id)
        VALUES ($1, now() - interval '30 days', '')
        ON CONFLICT (stream) DO NOTHING
      `,
      [REFUNDED_AMOUNT_CLUSTER_STREAM],
    );
  }

  async process(): Promise<void> {
    await this.captureNewEvents();
    await this.backfillSuspiciousGmailPatterns();
    await this.captureSuspiciousDepositClusters();
    await this.captureRefundedAmountClusters();
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
          WHERE enabled
            AND (expires_at IS NULL OR expires_at > now())
            AND domain = $1
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
      `SELECT domain
       FROM fiat_email_domain_blacklist
       WHERE enabled AND (expires_at IS NULL OR expires_at > now())`,
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
            occurred_at = COALESCE(
              $2,
              GREATEST(occurred_at, now() - interval '5 seconds')
            ),
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
            occurred_at = COALESCE(
              $2,
              GREATEST(occurred_at, now() - interval '5 seconds')
            ),
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

  private async captureRefundedAmountClusters(): Promise<void> {
    const cursor = await this.db.antifraud.query<{
      occurred_at: Date;
      source_id: string;
    }>(
      "SELECT occurred_at, source_id FROM source_cursors WHERE stream = $1",
      [REFUNDED_AMOUNT_CLUSTER_STREAM],
    );
    const current = cursor.rows[0];
    if (!current) throw new Error("Fiat refunded-amount cursor is missing");
    const candidates = await fetchRefundedAmountClusterCandidates(
      this.db.source,
      { occurredAt: current.occurred_at, sourceId: current.source_id },
    );
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      for (const candidate of candidates) {
        const cluster = qualifyingRefundedAmountCluster(candidate);
        if (!cluster) continue;
        const ratioPercent = Number((cluster.refundRatio * 100).toFixed(1));
        const reason =
          `${cluster.members.length} of ${candidate.total_payment_count} `
          + `settled payments (${ratioPercent}%) for `
          + `${candidate.requested_amount_cents} ${candidate.currency} cents `
          + `were refunded across ${cluster.accountCount} accounts inside a `
          + `${REFUND_CLUSTER_WINDOW_DAYS}-day payment window`;
        const windowStart = new Date(Math.min(
          ...cluster.members.map((member) => member.occurred_at.getTime()),
        ));
        const windowEnd = new Date(Math.max(
          ...cluster.members.map((member) => member.occurred_at.getTime()),
        ));
        await client.query(
          `
            INSERT INTO fiat_refunded_amount_clusters (
              currency, requested_amount_cents, window_start, window_end,
              total_payment_count, refunded_payment_count, account_count,
              payment_count, refund_ratio, reason, source_event_ids,
              active_until
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,
              now() + interval '7 days'
            )
            ON CONFLICT (currency, requested_amount_cents) DO UPDATE SET
              window_start = LEAST(
                fiat_refunded_amount_clusters.window_start,
                EXCLUDED.window_start
              ),
              window_end = GREATEST(
                fiat_refunded_amount_clusters.window_end,
                EXCLUDED.window_end
              ),
              total_payment_count = EXCLUDED.total_payment_count,
              refunded_payment_count = EXCLUDED.refunded_payment_count,
              account_count = EXCLUDED.account_count,
              payment_count = EXCLUDED.payment_count,
              refund_ratio = EXCLUDED.refund_ratio,
              reason = EXCLUDED.reason,
              source_event_ids = EXCLUDED.source_event_ids,
              active_until = now() + interval '7 days',
              updated_at = now()
          `,
          [
            candidate.currency,
            candidate.requested_amount_cents,
            windowStart,
            windowEnd,
            candidate.total_payment_count,
            cluster.members.length,
            cluster.accountCount,
            cluster.paymentCount,
            cluster.refundRatio,
            reason,
            JSON.stringify(cluster.members.map((member) =>
              member.source_event_id
            )),
          ],
        );
        for (const member of cluster.members) {
          await this.persistMatch(
            client,
            { ...member, match_source: "whop_checkout" },
            {
              type: "suspicious_deposit_cluster",
              domain: domainFromEmail(member.checkout_email)
                ?? "refund-amount-cluster",
              reason,
            },
          );
        }

        const sourceIds = cluster.members.map((member) =>
          member.source_event_id
        );
        const existingAlert = await client.query<{ source_id: string }>(
          `
            SELECT source_id
            FROM fiat_problem_alert_outbox
            WHERE problem_code = 'suspicious_deposit_cluster'
              AND details ->> 'cluster_basis' = 'refunded_amount'
              AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(
                  details -> 'cluster_source_event_ids'
                ) AS prior(source_event_id)
                WHERE prior.source_event_id = ANY($1::text[])
              )
            LIMIT 1
          `,
          [sourceIds],
        );
        if (existingAlert.rows.length > 0) continue;
        await client.query(
          `
            INSERT INTO fiat_problem_alert_outbox (
              source_kind, source_id, problem_code, user_id, username,
              details, occurred_at, next_attempt_at
            ) VALUES (
              'deposit_intent', $1, 'suspicious_deposit_cluster',
              $2, $3, $4::jsonb, $5, 'infinity'::timestamptz
            )
            ON CONFLICT (source_kind, source_id) DO NOTHING
          `,
          [
            `refund-amount-cluster:${candidate.deposit_intent_id}`,
            candidate.user_id,
            candidate.username,
            {
              intent_id: candidate.deposit_intent_id,
              email_risk_type: "suspicious_deposit_cluster",
              email_risk_reason: reason,
              cluster_basis: "refunded_amount",
              risk_score: 100,
              status: "withdrawals_locked",
              currency: candidate.currency,
              amount_cents: candidate.requested_amount_cents,
              cluster_member_count: cluster.members.length,
              cluster_account_count: cluster.accountCount,
              cluster_payment_count: cluster.paymentCount,
              cluster_total_payment_count: candidate.total_payment_count,
              cluster_refund_ratio: cluster.refundRatio,
              cluster_window_days: REFUND_CLUSTER_WINDOW_DAYS,
              cluster_source_event_ids: sourceIds,
            },
            candidate.updated_at,
          ],
        );
      }
      const last = candidates.at(-1);
      await client.query(
        `
          UPDATE source_cursors
          SET
            occurred_at = COALESCE(
              $2,
              GREATEST(occurred_at, now() - interval '5 seconds')
            ),
            source_id = COALESCE($3, ''),
            updated_at = now()
          WHERE stream = $1
        `,
        [
          REFUNDED_AMOUNT_CLUSTER_STREAM,
          last?.updated_at ?? null,
          last?.deposit_intent_id ?? null,
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
        WHERE enabled
          AND (expires_at IS NULL OR expires_at > now())
          AND backfill_completed_at IS NULL
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
            { reviewOnly: true },
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
    options: { reviewOnly?: boolean } = {},
  ): Promise<boolean> {
    // A fragmented Gmail address alone warrants review, not an account lock.
    // A corroborated cross-account cluster remains automatic containment.
    const reviewOnly =
      options.reviewOnly === true || risk.type === "gmail_dot_fragmentation";
    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO fiat_email_domain_matches (
          source_event_id, match_source, provider_event_id, deposit_intent_id,
          provider_payment_id, user_id, username, checkout_email, domain,
          match_type, occurred_at, lock_delivered_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
          CASE WHEN $12::boolean THEN now() ELSE NULL END
        )
        ON CONFLICT (source_event_id) DO UPDATE SET
          match_type = EXCLUDED.match_type,
          lock_delivered_at = NULL,
          attempt_count = 0,
          next_attempt_at = now(),
          last_error = NULL,
          updated_at = now()
        WHERE fiat_email_domain_matches.match_type = 'gmail_dot_fragmentation'
          AND EXCLUDED.match_type = 'suspicious_deposit_cluster'
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
        reviewOnly,
      ],
    );
    if (inserted.rows.length === 0) return false;

    const isSignup = event.match_source === "signup";
    const patternMatch = risk.type === "gmail_dot_fragmentation";
    const clusterMatch = risk.type === "suspicious_deposit_cluster";
    const eventType = "fiat_blacklisted_email_domain";
    // Promotion must create a new dashboard signal. Reusing the earlier
    // review-only source/ref pair would hit risk_events' idempotency key, and
    // the dashboard would correctly reject the replay before containment.
    const eventSource = isSignup
      ? "signup"
      : clusterMatch
        ? "whop_checkout_cluster"
        : "whop_checkout";
    const eventRef = isSignup
      ? `blacklisted-signup:${event.source_event_id}`
      : `blacklisted-checkout:${event.source_event_id}`;
    const title = clusterMatch
      ? "Suspicious Whop deposit cluster member"
      : patternMatch
      ? isSignup
        ? "Suspicious dot-fragmented signup email"
        : "Suspicious dot-fragmented Whop email"
      : isSignup
      ? "Blacklisted signup email"
      : "Blacklisted Whop checkout email";
    const detail = reviewOnly
      ? `${isSignup ? "Existing signup" : "Existing Whop checkout"} matches newly blocked email domain ${risk.domain}. Staff review is required; no automatic account action was taken.`
      : clusterMatch
      ? "Whop checkout belongs to a corroborated same-amount cluster with distinct accounts and payment identities. Crypto and item withdrawals must be locked automatically."
      : patternMatch
      ? `${isSignup ? "Signup" : "Whop checkout"} used a suspicious dot-fragmented Gmail address. Staff review is required; no automatic account action was taken.`
      : `${isSignup ? "Signup" : "Whop checkout"} used active blocked email domain ${risk.domain}. The account must be banned automatically and reviewed by staff.`;
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
            'paymentMethodType', $15::text,
            'reviewOnly', $16::boolean
          ),
          $17
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
        reviewOnly,
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
              'status', CASE
                WHEN $14::boolean THEN 'review_only'
                ELSE 'containment_required'
              END
            ),
            $15,
            CASE
              WHEN $14::boolean THEN now()
              ELSE 'infinity'::timestamptz
            END
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
          reviewOnly,
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
          const details = {
            sourceEventId: match.source_event_id,
            domain: match.domain,
            attempt: outcome.attempt,
            retrySeconds: outcome.retrySeconds,
          };
          if (outcome.attempt > LOCK_CONFIRMATION_ALARM_ATTEMPTS) {
            this.log.error(
              details,
              "Blacklisted email-domain match still has no withdrawal lock after repeated attempts — the containment may never have landed",
            );
          } else {
            this.log.warn(
              details,
              "Blacklisted email-domain match is waiting for withdrawal-lock confirmation",
            );
          }
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
          AND (
            NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(
                alert.details -> 'cluster_source_event_ids'
              ) AS member(source_event_id)
              LEFT JOIN fiat_email_domain_matches AS matched
                ON matched.source_event_id = member.source_event_id
              WHERE matched.source_event_id IS NULL
                OR matched.lock_delivered_at IS NULL
            )
            -- Escape hatch: one member whose withdrawal lock never lands
            -- must not mute the whole campaign alert forever.
            OR alert.occurred_at < now() - interval '30 minutes'
          )
      `,
    );
  }
}
