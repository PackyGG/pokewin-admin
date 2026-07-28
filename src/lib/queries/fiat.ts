import "server-only";

import { unstable_cache } from "next/cache";
import { sql } from "drizzle-orm";

import { readDrizzleForEnv } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { withTransientPostgresReadRetry } from "@/lib/postgres-read-retry";

export const FIAT_CACHE_TAG = "fiat-operations";

export type FiatOverview = {
  cardDepositMaxUsd: number | null;
  withdrawalHoldThresholdUsd: number | null;
  lockedMethods: string[];
  intents: number;
  customers: number;
  checkoutReady: number;
  completed: number;
  review: number;
  failed: number;
  refunded: number;
  disputed: number;
  completedCreditUsd: number;
  customerPaidUsd: number;
  providerNetUsd: number;
  providerFeesUsd: number;
  last24HoursIntents: number;
  last24HoursCompletedUsd: number;
  latestIntentAt: string | null;
  webhooks: number;
  failedWebhooks: number;
  latestWebhookAt: string | null;
  fiatLockedUsers: number;
  fiatLockedLocations: number;
  kycRequiredUsers: number;
};

export const EMPTY_FIAT_OVERVIEW: FiatOverview = {
  cardDepositMaxUsd: null,
  withdrawalHoldThresholdUsd: null,
  lockedMethods: [],
  intents: 0,
  customers: 0,
  checkoutReady: 0,
  completed: 0,
  review: 0,
  failed: 0,
  refunded: 0,
  disputed: 0,
  completedCreditUsd: 0,
  customerPaidUsd: 0,
  providerNetUsd: 0,
  providerFeesUsd: 0,
  last24HoursIntents: 0,
  last24HoursCompletedUsd: 0,
  latestIntentAt: null,
  webhooks: 0,
  failedWebhooks: 0,
  latestWebhookAt: null,
  fiatLockedUsers: 0,
  fiatLockedLocations: 0,
  kycRequiredUsers: 0,
};

type RawOverview = {
  card_deposit_max_usd: string | null;
  withdrawal_hold_threshold_usd: string | null;
  locked_methods: unknown;
  intents: string;
  customers: string;
  checkout_ready: string;
  completed: string;
  review: string;
  failed: string;
  refunded: string;
  disputed: string;
  completed_credit_cents: string;
  customer_paid_cents: string;
  provider_net_cents: string;
  provider_fees_cents: string;
  last_24_hours_intents: string;
  last_24_hours_completed_cents: string;
  latest_intent_at: string | null;
  webhooks: string;
  failed_webhooks: string;
  latest_webhook_at: string | null;
  fiat_locked_users: string;
  fiat_locked_locations: string;
  kyc_required_users: string;
};

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

async function computeFiatOverview(env: DbEnv): Promise<FiatOverview> {
  const db = readDrizzleForEnv(env);
  const result = await withTransientPostgresReadRetry(
    () =>
      db.execute<RawOverview>(sql`
        WITH intent_stats AS (
      SELECT
        COUNT(*)::text AS intents,
        COUNT(DISTINCT user_id)::text AS customers,
        COUNT(*) FILTER (WHERE status = 'checkout_ready')::text AS checkout_ready,
        COUNT(*) FILTER (WHERE status = 'completed')::text AS completed,
        COUNT(*) FILTER (WHERE status = 'review')::text AS review,
        COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
        COUNT(*) FILTER (
          WHERE status IN ('refunded', 'partially_refunded')
        )::text AS refunded,
        COUNT(*) FILTER (WHERE status = 'disputed')::text AS disputed,
        COALESCE(SUM(credited_amount_cents) FILTER (
          WHERE status = 'completed'
        ), 0)::text AS completed_credit_cents,
        COALESCE(SUM(actual_customer_total_cents) FILTER (
          WHERE status = 'completed'
        ), 0)::text AS customer_paid_cents,
        COALESCE(SUM(provider_net_amount_cents) FILTER (
          WHERE status = 'completed'
        ), 0)::text AS provider_net_cents,
        COUNT(*) FILTER (
          WHERE created_at >=
            (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '24 hours'
        )::text AS last_24_hours_intents,
        COALESCE(SUM(credited_amount_cents) FILTER (
          WHERE status = 'completed'
            AND completed_at >=
              (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '24 hours'
        ), 0)::text AS last_24_hours_completed_cents,
        MAX(created_at)::text AS latest_intent_at
      FROM fiat_deposit_intents
    ),
    webhook_stats AS (
      SELECT
        COUNT(*)::text AS webhooks,
        COUNT(*) FILTER (WHERE processing_status = 'failed')::text AS failed_webhooks,
        MAX(received_at)::text AS latest_webhook_at
      FROM payment_webhook_events
    )
    SELECT
      (
        SELECT value FROM site_config
        WHERE key = 'card_deposit_max_usd'
      ) AS card_deposit_max_usd,
      (
        SELECT value FROM site_config
        WHERE key = 'deposit_withdrawal_hold_threshold_usd'
      ) AS withdrawal_hold_threshold_usd,
      (
        SELECT value::jsonb FROM site_config
        WHERE key = 'locked_deposits_fiat'
          AND value ~ '^[[:space:]]*\\['
      ) AS locked_methods,
      i.*,
      (
        SELECT COALESCE(SUM(amount_cents), 0)::text
        FROM payment_provider_fees
      ) AS provider_fees_cents,
      w.*,
      (
        SELECT COUNT(*)::text
        FROM user_feature_locks
        WHERE cardinality(locked_deposits_fiat) > 0
      ) AS fiat_locked_users,
      (
        SELECT COUNT(*)::text
        FROM country_restrictions
        WHERE cardinality(locked_deposits_fiat) > 0
      ) AS fiat_locked_locations,
      (
        SELECT COUNT(*)::text
        FROM user_kyc
        WHERE kyc_required
      ) AS kyc_required_users
    FROM intent_stats i
    CROSS JOIN webhook_stats w
      `),
    { context: "fiat.overview" },
  );

  const row = result.rows[0];
  if (!row) return EMPTY_FIAT_OVERVIEW;

  return {
    cardDepositMaxUsd: nullableNumber(row.card_deposit_max_usd),
    withdrawalHoldThresholdUsd: nullableNumber(
      row.withdrawal_hold_threshold_usd,
    ),
    lockedMethods: stringArray(row.locked_methods),
    intents: number(row.intents),
    customers: number(row.customers),
    checkoutReady: number(row.checkout_ready),
    completed: number(row.completed),
    review: number(row.review),
    failed: number(row.failed),
    refunded: number(row.refunded),
    disputed: number(row.disputed),
    completedCreditUsd: number(row.completed_credit_cents) / 100,
    customerPaidUsd: number(row.customer_paid_cents) / 100,
    providerNetUsd: number(row.provider_net_cents) / 100,
    providerFeesUsd: number(row.provider_fees_cents) / 100,
    last24HoursIntents: number(row.last_24_hours_intents),
    last24HoursCompletedUsd: number(row.last_24_hours_completed_cents) / 100,
    latestIntentAt: row.latest_intent_at,
    webhooks: number(row.webhooks),
    failedWebhooks: number(row.failed_webhooks),
    latestWebhookAt: row.latest_webhook_at,
    fiatLockedUsers: number(row.fiat_locked_users),
    fiatLockedLocations: number(row.fiat_locked_locations),
    kycRequiredUsers: number(row.kyc_required_users),
  };
}

const cachedFiatOverview = unstable_cache(
  computeFiatOverview,
  ["fiat-overview-v1"],
  { revalidate: 60, tags: [FIAT_CACHE_TAG] },
);

export async function getFiatOverview(): Promise<FiatOverview> {
  return cachedFiatOverview(await readDbEnv());
}

export type FiatConfigRow = {
  key: string;
  value: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

type RawConfigRow = {
  key: string;
  value: string;
  description: string | null;
  created_at: string;
  updated_at: string;
};

async function computeFiatConfig(env: DbEnv): Promise<FiatConfigRow[]> {
  const db = readDrizzleForEnv(env);
  const result = await withTransientPostgresReadRetry(
    () =>
      db.execute<RawConfigRow>(sql`
        SELECT
          key,
          value,
          description,
          created_at::text,
          updated_at::text
        FROM site_config
        WHERE key ILIKE ANY (ARRAY[
                '%fiat%',
                '%card%deposit%',
                '%deposit%card%',
                '%deposit%hold%',
                '%hold%deposit%'
              ])
           OR description ILIKE ANY (ARRAY[
                '%fiat%',
                '%Whop%',
                '%card%deposit%',
                '%deposit%card%',
                '%withdrawal-only account hold%'
              ])
        ORDER BY key
      `),
    { context: "geo-blocking.fiat-config" },
  );

  return result.rows.map((row) => ({
    key: row.key,
    value: row.value,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

const cachedFiatConfig = unstable_cache(computeFiatConfig, ["fiat-config-v1"], {
  revalidate: 60,
  tags: [FIAT_CACHE_TAG],
});

export async function getFiatConfig(): Promise<FiatConfigRow[]> {
  return cachedFiatConfig(await readDbEnv());
}

export type FiatAccess = {
  restrictionRows: number;
  blockedLocations: number;
  fiatLockedLocations: number;
  fiatLockedUsers: number;
  withdrawalLockedUsers: number;
  kycRequiredUsers: number;
  kycPendingUsers: number;
  kycApprovedUsers: number;
  kycRejectedUsers: number;
  siteLockedMethods: string[];
};

export const EMPTY_FIAT_ACCESS: FiatAccess = {
  restrictionRows: 0,
  blockedLocations: 0,
  fiatLockedLocations: 0,
  fiatLockedUsers: 0,
  withdrawalLockedUsers: 0,
  kycRequiredUsers: 0,
  kycPendingUsers: 0,
  kycApprovedUsers: 0,
  kycRejectedUsers: 0,
  siteLockedMethods: [],
};

type RawAccess = {
  restriction_rows: string;
  blocked_locations: string;
  fiat_locked_locations: string;
  fiat_locked_users: string;
  withdrawal_locked_users: string;
  kyc_required_users: string;
  kyc_pending_users: string;
  kyc_approved_users: string;
  kyc_rejected_users: string;
  site_locked_methods: unknown;
};

async function computeFiatAccess(env: DbEnv): Promise<FiatAccess> {
  const db = readDrizzleForEnv(env);
  const result = await withTransientPostgresReadRetry(
    () =>
      db.execute<RawAccess>(sql`
        SELECT
      (SELECT COUNT(*) FROM country_restrictions)::text AS restriction_rows,
      (
        SELECT COUNT(*) FROM country_restrictions WHERE blocked
      )::text AS blocked_locations,
      (
        SELECT COUNT(*) FROM country_restrictions
        WHERE cardinality(locked_deposits_fiat) > 0
      )::text AS fiat_locked_locations,
      (
        SELECT COUNT(*) FROM user_feature_locks
        WHERE cardinality(locked_deposits_fiat) > 0
      )::text AS fiat_locked_users,
      (
        SELECT COUNT(*) FROM user_feature_locks
        WHERE cardinality(locked_withdrawals_crypto) > 0
           OR locked_withdrawals_items
      )::text AS withdrawal_locked_users,
      (
        SELECT COUNT(*) FROM user_kyc WHERE kyc_required
      )::text AS kyc_required_users,
      (
        SELECT COUNT(*) FROM user_kyc WHERE status = 'pending'
      )::text AS kyc_pending_users,
      (
        SELECT COUNT(*) FROM user_kyc WHERE status = 'approved'
      )::text AS kyc_approved_users,
      (
        SELECT COUNT(*) FROM user_kyc WHERE status = 'rejected'
      )::text AS kyc_rejected_users,
      (
        SELECT value::jsonb FROM site_config
        WHERE key = 'locked_deposits_fiat'
          AND value ~ '^[[:space:]]*\\['
      ) AS site_locked_methods
      `),
    { context: "fiat.access" },
  );
  const row = result.rows[0];
  if (!row) return EMPTY_FIAT_ACCESS;
  return {
    restrictionRows: number(row.restriction_rows),
    blockedLocations: number(row.blocked_locations),
    fiatLockedLocations: number(row.fiat_locked_locations),
    fiatLockedUsers: number(row.fiat_locked_users),
    withdrawalLockedUsers: number(row.withdrawal_locked_users),
    kycRequiredUsers: number(row.kyc_required_users),
    kycPendingUsers: number(row.kyc_pending_users),
    kycApprovedUsers: number(row.kyc_approved_users),
    kycRejectedUsers: number(row.kyc_rejected_users),
    siteLockedMethods: stringArray(row.site_locked_methods),
  };
}

const cachedFiatAccess = unstable_cache(computeFiatAccess, ["fiat-access-v1"], {
  revalidate: 60,
  tags: [FIAT_CACHE_TAG],
});

export async function getFiatAccess(): Promise<FiatAccess> {
  return cachedFiatAccess(await readDbEnv());
}

export type FiatWebhookSummary = {
  eventType: string;
  processingStatus: string;
  events: number;
  withError: number;
  latestAt: string | null;
};

export type FiatWebhookFailure = {
  eventType: string;
  attempts: number;
  error: string;
  receivedAt: string;
};

export type FiatWebhooks = {
  summary: FiatWebhookSummary[];
  recentFailures: FiatWebhookFailure[];
};

export const EMPTY_FIAT_WEBHOOKS: FiatWebhooks = {
  summary: [],
  recentFailures: [],
};

type RawWebhookSummary = {
  event_type: string;
  processing_status: string;
  events: string;
  with_error: string;
  latest_at: string | null;
};

type RawWebhookFailure = {
  event_type: string;
  attempt_count: string;
  last_error: string;
  received_at: string;
};

async function computeFiatWebhooks(env: DbEnv): Promise<FiatWebhooks> {
  const db = readDrizzleForEnv(env);
  const [summary, failures] = await Promise.all([
    withTransientPostgresReadRetry(
      () =>
        db.execute<RawWebhookSummary>(sql`
          SELECT
        event_type,
        processing_status,
        COUNT(*)::text AS events,
        COUNT(*) FILTER (
          WHERE COALESCE(last_error, '') <> ''
        )::text AS with_error,
        MAX(received_at)::text AS latest_at
      FROM payment_webhook_events
      GROUP BY event_type, processing_status
      ORDER BY events DESC, event_type, processing_status
        `),
      { context: "fiat.webhooks.summary" },
    ),
    withTransientPostgresReadRetry(
      () =>
        db.execute<RawWebhookFailure>(sql`
          SELECT
        event_type,
        attempt_count::text,
        last_error,
        received_at::text
      FROM payment_webhook_events
      WHERE processing_status = 'failed'
        AND last_error IS NOT NULL
      ORDER BY received_at DESC
      LIMIT 20
        `),
      { context: "fiat.webhooks.failures" },
    ),
  ]);

  return {
    summary: summary.rows.map((row) => ({
      eventType: row.event_type,
      processingStatus: row.processing_status,
      events: number(row.events),
      withError: number(row.with_error),
      latestAt: row.latest_at,
    })),
    recentFailures: failures.rows.map((row) => ({
      eventType: row.event_type,
      attempts: number(row.attempt_count),
      error: row.last_error,
      receivedAt: row.received_at,
    })),
  };
}

const cachedFiatWebhooks = unstable_cache(
  computeFiatWebhooks,
  ["fiat-webhooks-v1"],
  { revalidate: 30, tags: [FIAT_CACHE_TAG] },
);

export async function getFiatWebhooks(): Promise<FiatWebhooks> {
  return cachedFiatWebhooks(await readDbEnv());
}
