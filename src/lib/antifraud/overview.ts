import "server-only";

import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";

import {
  antifraud_reviews,
  antifraud_signals,
} from "@/lib/db-schema/admin/schema";
import { adminDrizzle } from "@/lib/drizzle";
import { readDrizzleForEnv } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { pgArrayParam } from "@/lib/drizzle-array-param";
import { getAntifraudMonitorOverview } from "@/lib/antifraud/monitor-api";
import { NON_ACTIONABLE_REWARD_ENROLLMENT_SIGNAL_KINDS } from "@/lib/antifraud/signal-display";

const LIVE_REVIEW_STATUSES = ["open", "in_review"] as const;
const THIRTY_DAY_BUCKETS = 30;

export type AntifraudOverviewMetrics = {
  legitimateFiatDepositCents: number;
  fraudulentFiatDepositCents: number;
  manualKycLocks: number;
  systemKycLocks: number;
  manualBans: number;
  automaticBans: number;
  autoLockReviewsLeft: number;
};

export type AntifraudOverviewDay = {
  date: string;
  legitimateFiatCents: number;
  fraudulentFiatCents: number;
  signups: number;
  bans: number;
  locks: number;
  caught: number;
};

export type AntifraudActionFeedItem = {
  id: string;
  type:
    | "fiat_deposit"
    | "high_risk_signup"
    | "locked"
    | "banned"
    | "kyc_requested"
    | "kyc_reviewed"
    | "signal";
  title: string;
  detail: string;
  occurredAt: string;
  userId: string | null;
  href: string | null;
  amountCents: number | null;
};

export type AntifraudOverviewData = {
  metrics: AntifraudOverviewMetrics;
  live: AntifraudLiveMirrorMetrics;
  days: AntifraudOverviewDay[];
  feed: AntifraudActionFeedItem[];
};

export type AntifraudLiveMirrorMetrics = {
  signups24h: number;
  locks24h: number;
  legitimateFiatCents24h: number;
  fraudulentFiatCents24h: number;
};

/**
 * Everything the dashboard needs except the two lifetime/24h fiat pairs.
 *
 * Those four numbers are the only ones the monitor's own split overwrites, so
 * they are deliberately absent from this shape: the merge in
 * {@link getAntifraudOverviewData} must supply them from exactly one source,
 * and a missing key is a type error rather than a silent zero.
 */
type AntifraudOverviewBase = {
  metrics: Omit<
    AntifraudOverviewMetrics,
    "legitimateFiatDepositCents" | "fraudulentFiatDepositCents"
  >;
  live: Omit<
    AntifraudLiveMirrorMetrics,
    "legitimateFiatCents24h" | "fraudulentFiatCents24h"
  >;
  days: AntifraudOverviewDay[];
  feed: AntifraudActionFeedItem[];
};

/** Mirror-computed fiat legs, read only when the monitor cannot supply them. */
type MirrorFiatTotals = {
  legitimateLifetimeCents: number;
  fraudulentLifetimeCents: number;
  legitimateCents24h: number;
  fraudulentCents24h: number;
};

/**
 * The counters that need no webhook scan at all: seven scalar subqueries over
 * `user`, `user_kyc` and `user_feature_locks`. They used to ride along on the
 * lifetime fiat statement and were therefore hostage to its scan.
 */
type MainCountersRow = {
  manual_kyc_locks: string;
  system_kyc_locks: string;
  manual_bans: string;
  automatic_bans: string;
  auto_lock_reviews_left: string;
  signups_24h: string;
  locks_24h: string;
};

/** The four fiat legs of the lifetime `classified_paid` statement. */
type MainFiatTotalsRow = {
  legitimate_fiat_deposit_cents: string;
  fraudulent_fiat_deposit_cents: string;
  legitimate_fiat_cents_24h: string;
  fraudulent_fiat_cents_24h: string;
};

/**
 * Narrow 24-hour statement for the monitor console. Same four columns and same
 * meaning as its dashboard counterparts — only the surrounding scan is bounded.
 */
type MainLive24hRow = {
  signups_24h: string;
  locks_24h: string;
  legitimate_fiat_cents_24h: string;
  fraudulent_fiat_cents_24h: string;
};

type MainDayRow = {
  bucket: string;
  legitimate_fiat_cents: string;
  fraudulent_fiat_cents: string;
  signups: string;
  bans: string;
  locks: string;
};

type MainFeedRow = {
  id: string;
  kind: string;
  user_id: string | null;
  username: string | null;
  occurred_at: string;
  amount_cents: string | null;
  detail: string | null;
};

function automaticBanSql(): ReturnType<typeof sql> {
  return sql`
    COALESCE(u.banned_reason LIKE 'Automatic % ban:%', FALSE)
  `;
}

function fraudulentAccountSql(
  flaggedUserIds: string[],
): ReturnType<typeof sql> {
  const flagged =
    flaggedUserIds.length > 0
      ? sql`linked.user_id = ANY(${pgArrayParam(flaggedUserIds)}::text[])`
      : sql`FALSE`;
  return sql`(${flagged} OR (u.is_banned AND ${automaticBanSql()}))`;
}

function numeric(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function utcDateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function emptyDays(): AntifraudOverviewDay[] {
  const today = new Date();
  const start = new Date(
    Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() - (THIRTY_DAY_BUCKETS - 1),
    ),
  );
  return Array.from({ length: THIRTY_DAY_BUCKETS }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return {
      date: utcDateKey(date),
      legitimateFiatCents: 0,
      fraudulentFiatCents: 0,
      signups: 0,
      bans: 0,
      locks: 0,
      caught: 0,
    };
  });
}

function feedTitle(kind: string, username: string | null): string {
  const subject = username ? ` · @${username}` : "";
  switch (kind) {
    case "fiat_deposit":
      return `Fiat deposit${subject}`;
    case "account_locked":
      return `Account locked${subject}`;
    case "account_banned":
      return `Account banned${subject}`;
    case "kyc_required":
      return `KYC requested${subject}`;
    case "kyc_admin_reviewed":
    case "kyc_provider_result_received":
      return `KYC reviewed${subject}`;
    default:
      return `${kind.replaceAll("_", " ")}${subject}`;
  }
}

function normalizeMainFeed(row: MainFeedRow): AntifraudActionFeedItem {
  const type: AntifraudActionFeedItem["type"] =
    row.kind === "fiat_deposit"
      ? "fiat_deposit"
      : row.kind === "account_locked"
        ? "locked"
        : row.kind === "account_banned"
          ? "banned"
          : row.kind === "kyc_required"
            ? "kyc_requested"
            : "kyc_reviewed";
  return {
    id: row.id,
    type,
    title: feedTitle(row.kind, row.username),
    detail:
      row.detail ??
      (row.user_id ? `Account ${row.user_id}` : "Operational event"),
    occurredAt: row.occurred_at,
    userId: row.user_id,
    href: row.user_id
      ? `/antifraud/reviews?search=${encodeURIComponent(row.user_id)}`
      : null,
    amountCents:
      row.amount_cents === null ? null : Math.round(numeric(row.amount_cents)),
  };
}

async function computeAntifraudOverviewBase(
  env: DbEnv,
): Promise<AntifraudOverviewBase> {
  const [flaggedAccounts, unresolvedReviews, caughtRows, recentSignals] =
    await Promise.all([
      adminDrizzle
        .selectDistinct({ userId: antifraud_reviews.target_user_id })
        .from(antifraud_reviews)
        .where(eq(antifraud_reviews.status, "flagged")),
      adminDrizzle
        .select({
          id: antifraud_reviews.id,
          userId: antifraud_reviews.target_user_id,
          signals: antifraud_reviews.signals,
        })
        .from(antifraud_reviews)
        .where(inArray(antifraud_reviews.status, [...LIVE_REVIEW_STATUSES])),
      adminDrizzle.execute<{ bucket: string; caught: string }>(sql`
        SELECT
          (resolved_at AT TIME ZONE 'UTC')::date::text AS bucket,
          COUNT(DISTINCT target_user_id)::text AS caught
        FROM antifraud_reviews
        WHERE status = 'flagged'
          AND resolved_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
            - interval '29 days'
          AND resolved_at < date_trunc('day', now() AT TIME ZONE 'UTC')
            + interval '1 day'
        GROUP BY 1
      `),
      adminDrizzle
        .select({
          id: antifraud_signals.id,
          kind: antifraud_signals.kind,
          summary: antifraud_signals.summary,
          receivedAt: antifraud_signals.received_at,
          userId: antifraud_signals.target_user_id,
          username: antifraud_signals.target_username,
          reviewId: antifraud_signals.review_id,
        })
        .from(antifraud_signals)
        .where(
          and(
            sql`${antifraud_signals.received_at} >= now() - interval '30 days'`,
            notInArray(
              antifraud_signals.kind,
              [...NON_ACTIONABLE_REWARD_ENROLLMENT_SIGNAL_KINDS],
            ),
          ),
        )
        .orderBy(desc(antifraud_signals.received_at))
        .limit(20),
    ]);

  const flaggedUserIds = flaggedAccounts.map((account) => account.userId);
  const unresolvedUserIds = [
    ...new Set(unresolvedReviews.map((review) => review.userId)),
  ];
  const fraudPredicate = fraudulentAccountSql(flaggedUserIds);
  const unresolvedScope =
    unresolvedUserIds.length > 0
      ? sql`u.id = ANY(${pgArrayParam(unresolvedUserIds)}::text[])`
      : sql`FALSE`;
  const db = readDrizzleForEnv(env);

  const [countersResult, dayResult, feedResult] = await Promise.all([
    db.execute<MainCountersRow>(sql`
      WITH current_locks AS (
        SELECT u.id
        FROM "user" u
        LEFT JOIN user_feature_locks locks ON locks.user_id = u.id
        WHERE ${unresolvedScope}
          AND (
            (
              u.is_locked
              AND u.locked_by IS NULL
              AND COALESCE(u.locked_reason, '') LIKE 'Automatic fraud lock:%'
            )
            OR (
              (
                'all' = ANY(locks.locked_withdrawals_crypto)
                OR locks.locked_withdrawals_items
              )
              AND locks.locked_withdrawals_by IS NULL
              AND (
                COALESCE(locks.locked_withdrawals_reason, '')
                  LIKE 'Automatic fraud lock:%'
                OR COALESCE(locks.locked_withdrawals_reason, '')
                  LIKE 'Lifetime deposits reached %'
              )
            )
          )
      )
      SELECT
        (
          SELECT COUNT(*) FROM user_kyc
          WHERE kyc_required
            AND COALESCE(kyc_required_by, '') NOT LIKE 'system:%'
        ) AS manual_kyc_locks,
        (
          SELECT COUNT(*) FROM user_kyc
          WHERE kyc_required
            AND kyc_required_by LIKE 'system:%'
        ) AS system_kyc_locks,
        (
          SELECT COUNT(*) FROM "user" u
          WHERE is_banned AND NOT ${automaticBanSql()}
        ) AS manual_bans,
        (
          SELECT COUNT(*) FROM "user" u
          WHERE is_banned AND ${automaticBanSql()}
        ) AS automatic_bans,
        (SELECT COUNT(*) FROM current_locks) AS auto_lock_reviews_left,
        (
          SELECT COUNT(*) FROM "user"
          WHERE created_at >= now() - interval '24 hours'
            AND created_at < now()
        ) AS signups_24h,
        (
          SELECT COUNT(DISTINCT user_id)
          FROM (
            SELECT id AS user_id, locked_at AS at
            FROM "user"
            WHERE locked_at >= now() - interval '24 hours'
              AND locked_at < now()
            UNION ALL
            SELECT user_id, locked_withdrawals_at AS at
            FROM user_feature_locks
            WHERE locked_withdrawals_at >= now() - interval '24 hours'
              AND locked_withdrawals_at < now()
          ) lock_events
        ) AS locks_24h
    `),
    db.execute<MainDayRow>(sql`
      WITH days AS (
        SELECT generate_series(
          date_trunc('day', now() AT TIME ZONE 'UTC') - interval '29 days',
          date_trunc('day', now() AT TIME ZONE 'UTC'),
          interval '1 day'
        )::date AS bucket
      ),
      succeeded_events AS (
        SELECT
          pwe.id,
          pwe.received_at,
          pwe.provider_resource_id,
          pwe.payload #>> '{data,id}' AS payment_id,
          pwe.payload #>> '{data,metadata,deposit_intent_id}'
            AS metadata_intent_id,
          (pwe.payload #>> '{data,paid_at}')::timestamptz
            AS provider_paid_at,
          CASE
            WHEN pwe.payload #>> '{data,usd_total}'
              ~ '^[0-9]+([.][0-9]+)?$'
            THEN (pwe.payload #>> '{data,usd_total}')::numeric
            ELSE NULL
          END AS gross_paid_usd
        FROM payment_webhook_events pwe
        WHERE pwe.provider = 'whop'
          AND pwe.event_type = 'payment.succeeded'
          AND pwe.payload #>> '{data,status}' = 'paid'
          AND pwe.received_at >=
            date_trunc('day', now() AT TIME ZONE 'UTC') - interval '31 days'
          AND NULLIF(pwe.payload #>> '{data,id}', '') IS NOT NULL
          AND NULLIF(pwe.payload #>> '{data,paid_at}', '') IS NOT NULL
      ),
      provider_paid AS (
        SELECT DISTINCT ON (payment_id)
          payment_id,
          provider_resource_id,
          metadata_intent_id,
          provider_paid_at,
          gross_paid_usd
        FROM succeeded_events
        WHERE provider_paid_at >=
            date_trunc('day', now() AT TIME ZONE 'UTC') - interval '29 days'
          AND provider_paid_at <
            date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day'
        ORDER BY payment_id, received_at DESC, id DESC
      ),
      linked_paid AS (
        SELECT paid.*, intent.user_id
        FROM provider_paid paid
        LEFT JOIN LATERAL (
          SELECT i.user_id
          FROM fiat_deposit_intents i
          WHERE i.provider = 'whop'
            AND (
              i.provider_payment_id = paid.payment_id
              OR i.provider_payment_id = paid.provider_resource_id
              OR i.id::text = paid.metadata_intent_id
            )
          ORDER BY
            (i.provider_payment_id = paid.payment_id) DESC,
            (i.id::text = paid.metadata_intent_id) DESC,
            i.updated_at DESC
          LIMIT 1
        ) intent ON TRUE
      ),
      fiat AS (
        SELECT
          (linked.provider_paid_at AT TIME ZONE 'UTC')::date AS bucket,
          SUM(linked.gross_paid_usd) FILTER (
            WHERE NOT ${fraudPredicate}
          ) * 100 AS legitimate_fiat_cents,
          SUM(linked.gross_paid_usd) FILTER (
            WHERE ${fraudPredicate}
          ) * 100 AS fraudulent_fiat_cents
        FROM linked_paid linked
        LEFT JOIN "user" u ON u.id = linked.user_id
        GROUP BY 1
      ),
      signup AS (
        SELECT (created_at AT TIME ZONE 'UTC')::date AS bucket, COUNT(*) AS total
        FROM "user"
        WHERE created_at >=
            date_trunc('day', now() AT TIME ZONE 'UTC') - interval '29 days'
          AND created_at <
            date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day'
        GROUP BY 1
      ),
      banned AS (
        SELECT (banned_at AT TIME ZONE 'UTC')::date AS bucket, COUNT(*) AS total
        FROM "user"
        WHERE banned_at >=
            date_trunc('day', now() AT TIME ZONE 'UTC') - interval '29 days'
          AND banned_at <
            date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day'
        GROUP BY 1
      ),
      locked AS (
        SELECT bucket, COUNT(DISTINCT user_id) AS total
        FROM (
          SELECT id AS user_id, (locked_at AT TIME ZONE 'UTC')::date AS bucket
          FROM "user"
          WHERE locked_at >=
              date_trunc('day', now() AT TIME ZONE 'UTC') - interval '29 days'
            AND locked_at <
              date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day'
          UNION ALL
          SELECT
            user_id,
            (locked_withdrawals_at AT TIME ZONE 'UTC')::date AS bucket
          FROM user_feature_locks
          WHERE locked_withdrawals_at >=
              date_trunc('day', now() AT TIME ZONE 'UTC') - interval '29 days'
            AND locked_withdrawals_at <
              date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day'
        ) rows
        GROUP BY bucket
      )
      SELECT
        days.bucket::text,
        COALESCE(fiat.legitimate_fiat_cents, 0)::text
          AS legitimate_fiat_cents,
        COALESCE(fiat.fraudulent_fiat_cents, 0)::text
          AS fraudulent_fiat_cents,
        COALESCE(signup.total, 0)::text AS signups,
        COALESCE(banned.total, 0)::text AS bans,
        COALESCE(locked.total, 0)::text AS locks
      FROM days
      LEFT JOIN fiat USING (bucket)
      LEFT JOIN signup USING (bucket)
      LEFT JOIN banned USING (bucket)
      LEFT JOIN locked USING (bucket)
      ORDER BY days.bucket
    `),
    db.execute<MainFeedRow>(sql`
      WITH succeeded_events AS (
        SELECT DISTINCT ON (pwe.payload #>> '{data,id}')
          'fiat:' || (pwe.payload #>> '{data,id}') AS id,
          'fiat_deposit'::text AS kind,
          intent.user_id,
          u.username,
          (pwe.payload #>> '{data,paid_at}')::timestamptz AS occurred_at,
          CASE
            WHEN pwe.payload #>> '{data,usd_total}'
              ~ '^[0-9]+([.][0-9]+)?$'
            THEN ROUND((pwe.payload #>> '{data,usd_total}')::numeric * 100)
            ELSE NULL
          END::text AS amount_cents,
          'Completed Whop payment'::text AS detail
        FROM payment_webhook_events pwe
        LEFT JOIN LATERAL (
          SELECT i.user_id
          FROM fiat_deposit_intents i
          WHERE i.provider = 'whop'
            AND (
              i.provider_payment_id = pwe.payload #>> '{data,id}'
              OR i.provider_payment_id = pwe.provider_resource_id
              OR i.id::text =
                pwe.payload #>> '{data,metadata,deposit_intent_id}'
            )
          ORDER BY i.updated_at DESC
          LIMIT 1
        ) intent ON TRUE
        LEFT JOIN "user" u ON u.id = intent.user_id
        WHERE pwe.provider = 'whop'
          AND pwe.event_type = 'payment.succeeded'
          AND pwe.payload #>> '{data,status}' = 'paid'
          AND pwe.received_at >= now() - interval '30 days'
        ORDER BY pwe.payload #>> '{data,id}', pwe.received_at DESC, pwe.id DESC
      ),
      operations AS (
        SELECT
          'audit:' || ae.id AS id,
          ae.event_type::text AS kind,
          ae.user_id,
          u.username,
          ae.created_at AS occurred_at,
          NULL::text AS amount_cents,
          CASE
            WHEN ae.event_type = 'account_locked' THEN 'Account access restricted'
            WHEN ae.event_type = 'account_banned' THEN 'Account access revoked'
            WHEN ae.event_type = 'kyc_required' THEN 'Identity review requested'
            ELSE 'KYC result updated'
          END AS detail
        FROM audit_events ae
        LEFT JOIN "user" u ON u.id = ae.user_id
        WHERE ae.event_type IN (
          'account_locked',
          'account_banned',
          'kyc_required',
          'kyc_admin_reviewed',
          'kyc_provider_result_received'
        )
          AND ae.created_at >= now() - interval '30 days'
      )
      SELECT * FROM (
        SELECT * FROM succeeded_events
        UNION ALL
        SELECT * FROM operations
      ) feed
      ORDER BY occurred_at DESC
      LIMIT 24
    `),
  ]);

  const counters = countersResult.rows[0];
  const caughtByDay = new Map(
    caughtRows.rows.map((row) => [row.bucket, numeric(row.caught)]),
  );
  const daysByKey = new Map(
    emptyDays().map((day) => [day.date, day] as const),
  );
  for (const row of dayResult.rows) {
    const day = daysByKey.get(row.bucket);
    if (!day) continue;
    day.legitimateFiatCents = numeric(row.legitimate_fiat_cents);
    day.fraudulentFiatCents = numeric(row.fraudulent_fiat_cents);
    day.signups = numeric(row.signups);
    day.bans = numeric(row.bans);
    day.locks = numeric(row.locks);
    day.caught = caughtByDay.get(row.bucket) ?? 0;
  }

  const signalFeed: AntifraudActionFeedItem[] = recentSignals.map((signal) => ({
    id: `signal:${signal.id}`,
    type:
      signal.kind === "high_risk_signup" ||
      signal.kind === "critical_risk_signup"
        ? "high_risk_signup"
        : "signal",
    title:
      signal.kind === "critical_risk_signup"
        ? `Critical-risk signup${signal.username ? ` · @${signal.username}` : ""}`
        : signal.kind === "high_risk_signup"
          ? `High-risk signup${signal.username ? ` · @${signal.username}` : ""}`
        : feedTitle(signal.kind, signal.username),
    detail: signal.summary,
    occurredAt: signal.receivedAt,
    userId: signal.userId,
    href: signal.reviewId
      ? `/antifraud/reviews?review=${signal.reviewId}`
      : signal.userId
        ? `/antifraud/reviews?search=${encodeURIComponent(signal.userId)}`
        : null,
    amountCents: null,
  }));
  const feed = [
    ...feedResult.rows.map(normalizeMainFeed),
    ...signalFeed,
  ]
    .sort(
      (left, right) =>
        Date.parse(right.occurredAt) - Date.parse(left.occurredAt),
    )
    .slice(0, 24);

  return {
    metrics: {
      manualKycLocks: numeric(counters?.manual_kyc_locks),
      systemKycLocks: numeric(counters?.system_kyc_locks),
      manualBans: numeric(counters?.manual_bans),
      automaticBans: numeric(counters?.automatic_bans),
      autoLockReviewsLeft: numeric(counters?.auto_lock_reviews_left),
    },
    live: {
      signups24h: numeric(counters?.signups_24h),
      locks24h: numeric(counters?.locks_24h),
    },
    days: [...daysByKey.values()],
    feed,
  };
}

const cachedAntifraudOverviewBase = unstable_cache(
  computeAntifraudOverviewBase,
  ["antifraud-overview-dashboard-v7"],
  {
    revalidate: 60,
    tags: ["antifraud-overview", "fiat-operations"],
  },
);

/**
 * The lifetime fiat legs, as their own statement.
 *
 * `payment_webhook_events` cannot be bounded here the way its 30-day and 24h
 * siblings are: "lifetime" means every webhook ever received, so any
 * `received_at` predicate would move a displayed number. What *can* change is
 * when it runs — see {@link armMirrorFiatTotals}. The CTE chain, the
 * `DISTINCT ON` winner selection, the fraud predicate and the `FILTER`
 * expressions are byte-for-byte the ones this used to share with the counters
 * statement, so the four numbers are unchanged.
 */
async function computeMirrorFiatTotals(
  env: DbEnv,
): Promise<MirrorFiatTotals> {
  const flaggedAccounts = await adminDrizzle
    .selectDistinct({ userId: antifraud_reviews.target_user_id })
    .from(antifraud_reviews)
    .where(eq(antifraud_reviews.status, "flagged"));
  const fraudPredicate = fraudulentAccountSql(
    flaggedAccounts.map((account) => account.userId),
  );
  const db = readDrizzleForEnv(env);

  const result = await db.execute<MainFiatTotalsRow>(sql`
    WITH succeeded_events AS (
      SELECT
        pwe.id,
        pwe.received_at,
        pwe.provider_resource_id,
        pwe.payload #>> '{data,id}' AS payment_id,
        pwe.payload #>> '{data,metadata,deposit_intent_id}'
          AS metadata_intent_id,
        (pwe.payload #>> '{data,paid_at}')::timestamptz
          AS provider_paid_at,
        CASE
          WHEN pwe.payload #>> '{data,usd_total}'
            ~ '^[0-9]+([.][0-9]+)?$'
          THEN (pwe.payload #>> '{data,usd_total}')::numeric
          ELSE NULL
        END AS gross_paid_usd
      FROM payment_webhook_events pwe
      WHERE pwe.provider = 'whop'
        AND pwe.event_type = 'payment.succeeded'
        AND pwe.payload #>> '{data,status}' = 'paid'
        AND NULLIF(pwe.payload #>> '{data,id}', '') IS NOT NULL
        AND NULLIF(pwe.payload #>> '{data,paid_at}', '') IS NOT NULL
    ),
    provider_paid AS (
      SELECT DISTINCT ON (payment_id)
        payment_id,
        provider_resource_id,
        metadata_intent_id,
        provider_paid_at,
        gross_paid_usd
      FROM succeeded_events
      WHERE provider_paid_at <= CURRENT_TIMESTAMP
      ORDER BY payment_id, received_at DESC, id DESC
    ),
    linked_paid AS (
      SELECT paid.*, intent.user_id
      FROM provider_paid paid
      LEFT JOIN LATERAL (
        SELECT i.user_id
        FROM fiat_deposit_intents i
        WHERE i.provider = 'whop'
          AND (
            i.provider_payment_id = paid.payment_id
            OR i.provider_payment_id = paid.provider_resource_id
            OR i.id::text = paid.metadata_intent_id
          )
        ORDER BY
          (i.provider_payment_id = paid.payment_id) DESC,
          (i.id::text = paid.metadata_intent_id) DESC,
          i.updated_at DESC
        LIMIT 1
      ) intent ON TRUE
    ),
    classified_paid AS (
      SELECT
        linked.*,
        ${fraudPredicate} AS is_fraud
      FROM linked_paid linked
      LEFT JOIN "user" u ON u.id = linked.user_id
    )
    SELECT
      COALESCE(SUM(gross_paid_usd) FILTER (WHERE NOT is_fraud), 0)
        * 100 AS legitimate_fiat_deposit_cents,
      COALESCE(SUM(gross_paid_usd) FILTER (WHERE is_fraud), 0)
        * 100 AS fraudulent_fiat_deposit_cents,
      COALESCE(SUM(gross_paid_usd) FILTER (
        WHERE NOT is_fraud
          AND provider_paid_at >= now() - interval '24 hours'
          AND provider_paid_at < now()
      ), 0) * 100 AS legitimate_fiat_cents_24h,
      COALESCE(SUM(gross_paid_usd) FILTER (
        WHERE is_fraud
          AND provider_paid_at >= now() - interval '24 hours'
          AND provider_paid_at < now()
      ), 0) * 100 AS fraudulent_fiat_cents_24h
    FROM classified_paid
  `);

  const row = result.rows[0];
  return {
    legitimateLifetimeCents: numeric(row?.legitimate_fiat_deposit_cents),
    fraudulentLifetimeCents: numeric(row?.fraudulent_fiat_deposit_cents),
    legitimateCents24h: numeric(row?.legitimate_fiat_cents_24h),
    fraudulentCents24h: numeric(row?.fraudulent_fiat_cents_24h),
  };
}

const cachedMirrorFiatTotals = unstable_cache(
  computeMirrorFiatTotals,
  ["antifraud-overview-mirror-fiat-v1"],
  {
    revalidate: 60,
    tags: ["antifraud-overview", "fiat-operations"],
  },
);

/**
 * How long the merge waits for the monitor before starting the scan anyway.
 *
 * A healthy monitor answers in well under a second. Its own upstream timeout
 * is 8s and the page's `safeQuery` budget is 10s, so simply chaining the scan
 * behind a *failing* monitor would push the dashboard past that budget and
 * blank every KPI. Arming at the grace deadline keeps the degraded path at
 * roughly its current latency while the healthy path never touches the scan.
 */
const MIRROR_FIAT_GRACE_MS = 1_500;

type ArmedMirrorFiatTotals = {
  /** Starts the scan if the grace timer has not already, then resolves it. */
  read: () => Promise<MirrorFiatTotals>;
  /** Disarms the grace timer; a no-op once it has fired. */
  release: () => void;
};

function armMirrorFiatTotals(env: DbEnv): ArmedMirrorFiatTotals {
  let started: Promise<MirrorFiatTotals> | null = null;
  const start = (): Promise<MirrorFiatTotals> => {
    if (!started) {
      started =
        env === "prod"
          ? cachedMirrorFiatTotals(env)
          : computeMirrorFiatTotals(env);
      // A speculative start that nobody ends up reading must not surface as an
      // unhandled rejection. `read()` awaits the same promise and still throws.
      void started.catch(() => {});
    }
    return started;
  };
  const timer = setTimeout(start, MIRROR_FIAT_GRACE_MS);
  return {
    read: start,
    release: () => clearTimeout(timer),
  };
}

export async function getAntifraudOverviewData(): Promise<AntifraudOverviewData> {
  const env = await readDbEnv();
  // Armed before the awaits below so a slow monitor cannot stack the scan's
  // latency on top of its own.
  const mirrorFiat = armMirrorFiatTotals(env);
  const [base, monitor] = await Promise.all([
    env === "prod"
      ? cachedAntifraudOverviewBase(env)
      : computeAntifraudOverviewBase(env),
    getAntifraudMonitorOverview(),
  ]);
  // Past this point nothing is waiting on the monitor any more, so the grace
  // timer has done its job either way: it has already armed the scan for a slow
  // monitor, and clearing it here keeps a fast one from ever starting it.
  mirrorFiat.release();

  const split = monitor.data?.fiat;
  if (split) {
    // Both legs come from the same assessment scope, so the KPI adds up and
    // matches /antifraud/fiat-deposits. Never derive one leg by subtracting
    // the other from a MAIN total — the two sources cover different rows and
    // the difference used to clamp "legitimate" to zero.
    const splitByDay = new Map(split.days.map((day) => [day.date, day]));
    return {
      metrics: {
        ...base.metrics,
        legitimateFiatDepositCents: split.legitimateLifetimeCents,
        fraudulentFiatDepositCents: split.fraudulentLifetimeCents,
      },
      live: {
        ...base.live,
        legitimateFiatCents24h: split.legitimateLast24HoursCents,
        fraudulentFiatCents24h: split.fraudulentLast24HoursCents,
      },
      days: base.days.map((day) => ({
        ...day,
        legitimateFiatCents: splitByDay.get(day.date)?.legitimateCents ?? 0,
        fraudulentFiatCents: splitByDay.get(day.date)?.fraudulentCents ?? 0,
      })),
      feed: base.feed,
    };
  }

  // No split: the mirror's own lifetime and 24h legs are the fallback source,
  // so the scan is genuinely needed and has to be read.
  const mirror = await mirrorFiat.read();
  const overview: AntifraudOverviewData = {
    metrics: {
      ...base.metrics,
      legitimateFiatDepositCents: mirror.legitimateLifetimeCents,
      fraudulentFiatDepositCents: mirror.fraudulentLifetimeCents,
    },
    live: {
      ...base.live,
      legitimateFiatCents24h: mirror.legitimateCents24h,
      fraudulentFiatCents24h: mirror.fraudulentCents24h,
    },
    days: base.days,
    feed: base.feed,
  };

  const canonical = monitor.data?.fraudulentFiat;
  if (!canonical) return overview;

  const fraudByDay = new Map(
    canonical.days.map((day) => [day.date, day.amountCents]),
  );

  return {
    ...overview,
    metrics: {
      ...overview.metrics,
      legitimateFiatDepositCents: Math.max(
        0,
        overview.metrics.legitimateFiatDepositCents +
          overview.metrics.fraudulentFiatDepositCents -
          canonical.lifetimeCents,
      ),
      fraudulentFiatDepositCents: canonical.lifetimeCents,
    },
    live: {
      ...overview.live,
      legitimateFiatCents24h: Math.max(
        0,
        overview.live.legitimateFiatCents24h +
          overview.live.fraudulentFiatCents24h -
          canonical.last24HoursCents,
      ),
      fraudulentFiatCents24h: canonical.last24HoursCents,
    },
    days: overview.days.map((day) => {
      const fraudulentFiatCents = fraudByDay.get(day.date) ?? 0;
      return {
        ...day,
        legitimateFiatCents: Math.max(
          0,
          day.legitimateFiatCents +
            day.fraudulentFiatCents -
            fraudulentFiatCents,
        ),
        fraudulentFiatCents,
      };
    }),
  };
}

/**
 * The four 24-hour counters, and nothing else.
 *
 * The live monitor console needs exactly these numbers on first paint. It used
 * to get them by running the whole dashboard computation and throwing away
 * everything but `.live` — four admin-DB queries plus three heavy MAIN-mirror
 * queries, including an unbounded `payment_webhook_events` scan and a 30-day
 * per-day CTE. Outside prod nothing is cached, so that ran in full on every
 * snapshot request; in prod the 60s revalidation still put a console load
 * behind the heaviest chain in the sub-app.
 *
 * A clean extraction from `computeMirrorFiatTotals` is not possible: its
 * lifetime and 24h columns are one statement over one `classified_paid` CTE,
 * and the 24h figures are `FILTER` clauses on that same aggregate. So this is
 * a deliberately separate, narrow statement. It reproduces the original
 * semantics exactly — same CTE chain, same `DISTINCT ON` winner selection,
 * same fraud predicate, same `FILTER` expressions — with two bounds added:
 *
 *   - `provider_paid` is filtered to the 24h window AFTER the `DISTINCT ON`
 *     picks a payment's newest webhook, so the winning row is the same row the
 *     lifetime query would have picked.
 *   - `succeeded_events` is bounded by `received_at` (7 days of slack against
 *     a 24h `paid_at` window; the 30-day chart query uses the same technique
 *     with 2 days of slack) so the LATERAL intent join and the sort run over a
 *     week of webhooks instead of every payment ever recorded.
 */
async function computeAntifraudLive24hMetrics(
  env: DbEnv,
): Promise<AntifraudLiveMirrorMetrics> {
  const flaggedAccounts = await adminDrizzle
    .selectDistinct({ userId: antifraud_reviews.target_user_id })
    .from(antifraud_reviews)
    .where(eq(antifraud_reviews.status, "flagged"));
  const fraudPredicate = fraudulentAccountSql(
    flaggedAccounts.map((account) => account.userId),
  );
  const db = readDrizzleForEnv(env);

  const result = await db.execute<MainLive24hRow>(sql`
    WITH succeeded_events AS (
      SELECT
        pwe.id,
        pwe.received_at,
        pwe.provider_resource_id,
        pwe.payload #>> '{data,id}' AS payment_id,
        pwe.payload #>> '{data,metadata,deposit_intent_id}'
          AS metadata_intent_id,
        (pwe.payload #>> '{data,paid_at}')::timestamptz
          AS provider_paid_at,
        CASE
          WHEN pwe.payload #>> '{data,usd_total}'
            ~ '^[0-9]+([.][0-9]+)?$'
          THEN (pwe.payload #>> '{data,usd_total}')::numeric
          ELSE NULL
        END AS gross_paid_usd
      FROM payment_webhook_events pwe
      WHERE pwe.provider = 'whop'
        AND pwe.event_type = 'payment.succeeded'
        AND pwe.payload #>> '{data,status}' = 'paid'
        AND pwe.received_at >= now() - interval '7 days'
        AND NULLIF(pwe.payload #>> '{data,id}', '') IS NOT NULL
        AND NULLIF(pwe.payload #>> '{data,paid_at}', '') IS NOT NULL
    ),
    provider_paid AS (
      SELECT newest.*
      FROM (
        SELECT DISTINCT ON (payment_id)
          payment_id,
          provider_resource_id,
          metadata_intent_id,
          provider_paid_at,
          gross_paid_usd
        FROM succeeded_events
        WHERE provider_paid_at <= CURRENT_TIMESTAMP
        ORDER BY payment_id, received_at DESC, id DESC
      ) newest
      WHERE newest.provider_paid_at >= now() - interval '24 hours'
        AND newest.provider_paid_at < now()
    ),
    linked_paid AS (
      SELECT paid.*, intent.user_id
      FROM provider_paid paid
      LEFT JOIN LATERAL (
        SELECT i.user_id
        FROM fiat_deposit_intents i
        WHERE i.provider = 'whop'
          AND (
            i.provider_payment_id = paid.payment_id
            OR i.provider_payment_id = paid.provider_resource_id
            OR i.id::text = paid.metadata_intent_id
          )
        ORDER BY
          (i.provider_payment_id = paid.payment_id) DESC,
          (i.id::text = paid.metadata_intent_id) DESC,
          i.updated_at DESC
        LIMIT 1
      ) intent ON TRUE
    ),
    classified_paid AS (
      SELECT
        linked.*,
        ${fraudPredicate} AS is_fraud
      FROM linked_paid linked
      LEFT JOIN "user" u ON u.id = linked.user_id
    )
    SELECT
      (
        SELECT COUNT(*) FROM "user"
        WHERE created_at >= now() - interval '24 hours'
          AND created_at < now()
      ) AS signups_24h,
      (
        SELECT COUNT(DISTINCT user_id)
        FROM (
          SELECT id AS user_id, locked_at AS at
          FROM "user"
          WHERE locked_at >= now() - interval '24 hours'
            AND locked_at < now()
          UNION ALL
          SELECT user_id, locked_withdrawals_at AS at
          FROM user_feature_locks
          WHERE locked_withdrawals_at >= now() - interval '24 hours'
            AND locked_withdrawals_at < now()
        ) lock_events
      ) AS locks_24h,
      COALESCE(SUM(gross_paid_usd) FILTER (WHERE NOT is_fraud), 0)
        * 100 AS legitimate_fiat_cents_24h,
      COALESCE(SUM(gross_paid_usd) FILTER (WHERE is_fraud), 0)
        * 100 AS fraudulent_fiat_cents_24h
    FROM classified_paid
  `);

  const row = result.rows[0];
  return {
    signups24h: numeric(row?.signups_24h),
    locks24h: numeric(row?.locks_24h),
    legitimateFiatCents24h: numeric(row?.legitimate_fiat_cents_24h),
    fraudulentFiatCents24h: numeric(row?.fraudulent_fiat_cents_24h),
  };
}

const cachedAntifraudLive24hMetrics = unstable_cache(
  computeAntifraudLive24hMetrics,
  ["antifraud-live-24h-v1"],
  {
    revalidate: 30,
    tags: ["antifraud-overview", "fiat-operations"],
  },
);

/**
 * Live 24h counters for the monitor console's KPI strip.
 *
 * The fiat overlay is byte-for-byte the same derivation
 * `getAntifraudOverviewData` applies to its own `live` block, so the four
 * numbers mean exactly what they meant when they came out of the full
 * dashboard computation: the monitor's own assessment scope wins when it
 * reports the split, the canonical fraud leg is subtracted from the mirror
 * total when only that is available, and the mirror numbers stand otherwise.
 */
export async function getAntifraudLive24hMetrics(): Promise<AntifraudLiveMirrorMetrics> {
  const env = await readDbEnv();
  const [base, monitor] = await Promise.all([
    env === "prod"
      ? cachedAntifraudLive24hMetrics(env)
      : computeAntifraudLive24hMetrics(env),
    getAntifraudMonitorOverview(),
  ]);

  const split = monitor.data?.fiat;
  if (split) {
    return {
      ...base,
      legitimateFiatCents24h: split.legitimateLast24HoursCents,
      fraudulentFiatCents24h: split.fraudulentLast24HoursCents,
    };
  }

  const canonical = monitor.data?.fraudulentFiat;
  if (!canonical) return base;

  return {
    ...base,
    legitimateFiatCents24h: Math.max(
      0,
      base.legitimateFiatCents24h +
        base.fraudulentFiatCents24h -
        canonical.last24HoursCents,
    ),
    fraudulentFiatCents24h: canonical.last24HoursCents,
  };
}
