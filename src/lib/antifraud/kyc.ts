import "server-only";

import {
  and,
  desc,
  eq,
  ilike,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { getReadDrizzleDb } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import {
  sumsub_webhook_events,
  user,
  user_kyc,
} from "@/lib/db-schema/main/schema";
import { loadAdminIdentities } from "@/lib/antifraud/admin-identities";
import {
  refreshKycCountryReviews,
  type KycCountryReview,
} from "@/lib/antifraud/sumsub-review-api";

const KYC_FILTERS = ["active", "waiting", "history"] as const;

export type KycFilter = (typeof KYC_FILTERS)[number];

export function isKycFilter(value: unknown): value is KycFilter {
  return (
    typeof value === "string" &&
    (KYC_FILTERS as readonly string[]).includes(value)
  );
}

export type KycAccount = {
  userId: string;
  username: string | null;
  displayUsername: string | null;
  email: string | null;
  countryCode: string | null;
  accountCreatedAt: Date;
  kycRequired: boolean;
  kycRequiredAt: Date | null;
  kycRequiredBy: string | null;
  kycRequiredByLabel: string | null;
  kycRequiredReason: string | null;
  verificationCycle: number;
  adminDecision: "pending" | "safe" | "rejected";
  adminReviewedAt: Date | null;
  adminReviewedBy: string | null;
  adminReviewedByLabel: string | null;
  applicantId: string | null;
  levelName: string | null;
  status: "none" | "pending" | "on_hold" | "approved" | "rejected";
  reviewAnswer: string | null;
  rejectType: string | null;
  moderationComment: string | null;
  lastWebhookCreatedAt: Date | null;
  lastWebhookDigest: string | null;
  createdAt: Date;
  updatedAt: Date;
  countryReview: KycCountryReview | null;
};

type SumsubEventSummary = {
  digest: string;
  applicantId: string | null;
  externalUserId: string | null;
  eventType: string;
  providerCreatedAt: Date;
  receivedAt: Date;
  processedAt: Date | null;
};

export type KycDashboardStats = {
  total: number;
  required: number;
  awaitingReview: number;
  providerPending: number;
  approved: number;
  rejected: number;
  cleared: number;
  withApplicant: number;
  usedLevels: string[];
};

type KycOperationalConfig = {
  env: DbEnv;
  backendUrlConfigured: boolean;
  backendKeyConfigured: boolean;
  cloudflareAccessConfigured: boolean;
  defaultLevelSource: "backend environment";
  provider: "Sumsub";
  automaticUnlock: false;
  rawPayloadExposed: false;
};

export type KycDashboard = {
  accounts: KycAccount[];
  events: SumsubEventSummary[];
  stats: KycDashboardStats;
  config: KycOperationalConfig;
};

export type KycDashboardFilters = {
  status?: KycFilter;
  search?: string;
  limit?: number;
};

/**
 * Rows the workspace lists per view. There is no pagination behind it, so the
 * page MUST say when a view is standing on this cap — a silent 200 under a KPI
 * reading "340 open decisions" reads as "these are all of them".
 */
export const KYC_ACCOUNT_LIMIT = 200;

/**
 * Keep the cross-database boundary explicit: load the currently required user
 * ids from the MAIN read mirror, then pass them into the ADMIN review query.
 * The boolean predicate intentionally uses the planner's sequential scan:
 * `user_kyc` is a tiny one-row-per-enrolled-user relation and the full read
 * completed in under 1 ms during the production-mirror EXPLAIN check.
 */
async function listKycRequiredUserIds(): Promise<string[]> {
  const db = await getReadDrizzleDb();
  const rows = await db
    .select({ userId: user_kyc.user_id })
    .from(user_kyc)
    .where(eq(user_kyc.kyc_required, true));

  return rows.map((row) => row.userId);
}

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function nullableDate(value: Date | string | null): Date | null {
  return value == null ? null : date(value);
}

function integrationConfig(env: DbEnv): KycOperationalConfig {
  const backendUrl =
    env === "dev"
      ? process.env.BACKEND_API_URL_DEV || process.env.DEV_BACKEND_API_URL
      : process.env.BACKEND_API_URL_PROD || process.env.BACKEND_API_URL;
  const backendKey =
    env === "dev"
      ? process.env.BACKEND_ADMIN_KEY_DEV || process.env.DEV_BACKEND_API_KEY
      : process.env.BACKEND_ADMIN_KEY_PROD || process.env.BACKEND_API_KEY;

  return {
    env,
    backendUrlConfigured: Boolean(backendUrl?.trim()),
    backendKeyConfigured: Boolean(backendKey?.trim()),
    cloudflareAccessConfigured: Boolean(
      process.env.CF_ACCESS_CLIENT_ID?.trim() &&
        process.env.CF_ACCESS_CLIENT_SECRET?.trim(),
    ),
    defaultLevelSource: "backend environment",
    provider: "Sumsub",
    automaticUnlock: false,
    rawPayloadExposed: false,
  };
}

/**
 * Required 24h+ ago, still on the provider's default "none" status — the
 * player never started or never finished the Sumsub check. Pulled out of
 * "active" into its own tab so stalled accounts don't spam the review list.
 */
function waitingCondition(): SQL {
  return sql`(
    ${user_kyc.kyc_required} = true
    AND ${user_kyc.admin_decision} = 'pending'
    AND ${user_kyc.status} = 'none'
    AND ${user_kyc.kyc_required_at} IS NOT NULL
    AND ${user_kyc.kyc_required_at} < NOW() - INTERVAL '24 hours'
  )`;
}

function statusCondition(filter: KycFilter): SQL | undefined {
  switch (filter) {
    case "active":
      return sql`(
        (${user_kyc.kyc_required} = true OR ${user_kyc.admin_decision} = 'pending')
        AND NOT ${waitingCondition()}
      )`;
    case "waiting":
      return waitingCondition();
    case "history":
      return or(
        eq(user_kyc.admin_decision, "safe"),
        eq(user_kyc.admin_decision, "rejected"),
      );
  }
}

/**
 * Untouched default rows are not verification activity and must not make the
 * account appear in the review workspace or its totals.
 */
function meaningfulKycRecordCondition(): SQL {
  return sql`(
    ${user_kyc.kyc_required}
    OR ${user_kyc.kyc_required_at} IS NOT NULL
    OR ${user_kyc.kyc_required_by} IS NOT NULL
    OR NULLIF(BTRIM(${user_kyc.kyc_required_reason}), '') IS NOT NULL
    OR ${user_kyc.verification_cycle} > 0
    OR ${user_kyc.admin_decision} <> 'pending'
    OR ${user_kyc.admin_reviewed_at} IS NOT NULL
    OR ${user_kyc.admin_reviewed_by} IS NOT NULL
    OR ${user_kyc.applicant_id} IS NOT NULL
    OR ${user_kyc.status} <> 'none'
    OR ${user_kyc.review_answer} IS NOT NULL
    OR ${user_kyc.reject_type} IS NOT NULL
    OR ${user_kyc.moderation_comment} IS NOT NULL
    OR ${user_kyc.last_webhook_created_at} IS NOT NULL
    OR ${user_kyc.last_webhook_digest} IS NOT NULL
  )`;
}

async function listKycAccounts(
  filters: KycDashboardFilters,
): Promise<KycAccount[]> {
  const db = await getReadDrizzleDb();
  const conditions: SQL[] = [meaningfulKycRecordCondition()];
  const filter = filters.status ?? "active";
  const status = statusCondition(filter);
  if (status) conditions.push(status);

  const search = filters.search?.trim();
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(
        ilike(user_kyc.user_id, pattern),
        ilike(user.username, pattern),
        ilike(user.display_username, pattern),
        ilike(user.email, pattern),
        ilike(user_kyc.applicant_id, pattern),
      )!,
    );
  }

  const rows = await db
    .select({
      userId: user_kyc.user_id,
      username: user.username,
      displayUsername: user.display_username,
      email: user.email,
      countryCode: user.country_code,
      accountCreatedAt: user.created_at,
      kycRequired: user_kyc.kyc_required,
      kycRequiredAt: user_kyc.kyc_required_at,
      kycRequiredBy: user_kyc.kyc_required_by,
      kycRequiredReason: user_kyc.kyc_required_reason,
      verificationCycle: user_kyc.verification_cycle,
      adminDecision: user_kyc.admin_decision,
      adminReviewedAt: user_kyc.admin_reviewed_at,
      adminReviewedBy: user_kyc.admin_reviewed_by,
      applicantId: user_kyc.applicant_id,
      levelName: user_kyc.level_name,
      status: user_kyc.status,
      reviewAnswer: user_kyc.review_answer,
      rejectType: user_kyc.reject_type,
      moderationComment: user_kyc.moderation_comment,
      lastWebhookCreatedAt: user_kyc.last_webhook_created_at,
      lastWebhookDigest: user_kyc.last_webhook_digest,
      createdAt: user_kyc.created_at,
      updatedAt: user_kyc.updated_at,
    })
    .from(user_kyc)
    .innerJoin(user, eq(user.id, user_kyc.user_id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(user_kyc.updated_at))
    .limit(Math.min(Math.max(filters.limit ?? KYC_ACCOUNT_LIMIT, 1), 300));

  const identities = await loadAdminIdentities(
    rows.flatMap((row) => [row.kycRequiredBy, row.adminReviewedBy]),
  );

  return rows.map((row) => ({
    ...row,
    accountCreatedAt: date(row.accountCreatedAt),
    kycRequiredAt: nullableDate(row.kycRequiredAt),
    kycRequiredByLabel: row.kycRequiredBy
      ? identities.get(row.kycRequiredBy)?.label ?? null
      : null,
    adminReviewedAt: nullableDate(row.adminReviewedAt),
    adminReviewedByLabel: row.adminReviewedBy
      ? identities.get(row.adminReviewedBy)?.label ?? null
      : null,
    lastWebhookCreatedAt: nullableDate(row.lastWebhookCreatedAt),
    createdAt: date(row.createdAt),
    updatedAt: date(row.updatedAt),
    countryReview: null,
  }));
}

/**
 * One bounded aggregate over `user_kyc` — nothing else.
 *
 * NO webhook `COUNT(*)` subqueries belong here. Two used to hang off this
 * aggregate (`sumsub_webhook_events` total, and the same filtered on
 * `processed_at IS NOT NULL`). Both were unbounded scans of an append-only
 * webhook table with no covering index, both re-ran on every /antifraud/kyc
 * render — every tab switch, every filter, every search — and NOTHING on the
 * page rendered either number. If a webhook health figure is ever wanted, it
 * belongs on its own bounded, index-backed read, not bolted onto this one.
 */
async function loadKycStats(): Promise<KycDashboardStats> {
  const db = await getReadDrizzleDb();
  const result = await db.execute<{
    total: string;
    required: string;
    awaiting_review: string;
    provider_pending: string;
    approved: string;
    rejected: string;
    cleared: string;
    with_applicant: string;
    used_levels: string[] | null;
  }>(sql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE kyc_required) AS required,
      COUNT(*) FILTER (
        WHERE kyc_required AND admin_decision = 'pending'
      ) AS awaiting_review,
      COUNT(*) FILTER (
        WHERE status IN ('pending', 'on_hold')
      ) AS provider_pending,
      COUNT(*) FILTER (WHERE status = 'approved') AS approved,
      COUNT(*) FILTER (
        WHERE status = 'rejected' OR admin_decision = 'rejected'
      ) AS rejected,
      COUNT(*) FILTER (
        WHERE NOT kyc_required AND admin_decision = 'safe'
      ) AS cleared,
      COUNT(applicant_id) AS with_applicant,
      ARRAY_AGG(DISTINCT level_name ORDER BY level_name)
        FILTER (WHERE level_name IS NOT NULL) AS used_levels
    FROM user_kyc
    WHERE ${meaningfulKycRecordCondition()}
  `);
  const row = result.rows[0];
  const number = (value: string | undefined): number => Number(value ?? 0);

  return {
    total: number(row?.total),
    required: number(row?.required),
    awaitingReview: number(row?.awaiting_review),
    providerPending: number(row?.provider_pending),
    approved: number(row?.approved),
    rejected: number(row?.rejected),
    cleared: number(row?.cleared),
    withApplicant: number(row?.with_applicant),
    usedLevels: row?.used_levels ?? [],
  };
}

async function listSumsubEvents(): Promise<SumsubEventSummary[]> {
  const db = await getReadDrizzleDb();
  const rows = await db
    .select({
      digest: sumsub_webhook_events.digest,
      applicantId: sumsub_webhook_events.applicant_id,
      externalUserId: sumsub_webhook_events.external_user_id,
      eventType: sumsub_webhook_events.event_type,
      providerCreatedAt: sumsub_webhook_events.provider_created_at,
      receivedAt: sumsub_webhook_events.received_at,
      processedAt: sumsub_webhook_events.processed_at,
    })
    .from(sumsub_webhook_events)
    .orderBy(desc(sumsub_webhook_events.received_at))
    .limit(50);

  return rows.map((row) => ({
    ...row,
    providerCreatedAt: date(row.providerCreatedAt),
    receivedAt: date(row.receivedAt),
    processedAt: nullableDate(row.processedAt),
  }));
}

/**
 * Everything the workspace needs from OUR OWN databases — and nothing that
 * leaves the process.
 *
 * The Sumsub country-evidence refresh deliberately does NOT run here. It used
 * to be awaited right after this `Promise.all`, so a single out-of-process POST
 * (up to 100 applicants, `AbortSignal.timeout(8_000)`) held back the table, the
 * KPI strip and every action control — for a per-row badge. It now lives in
 * {@link loadKycCountryReviews}, behind its own Suspense boundary on the page.
 * Accounts come back with `countryReview: null`; the badges fill in after.
 */
export async function getKycDashboard(
  filters: KycDashboardFilters = {},
): Promise<KycDashboard> {
  const env = await readDbEnv();
  const [accounts, stats, events] = await Promise.all([
    listKycAccounts(filters),
    loadKycStats(),
    listSumsubEvents(),
  ]);
  return { accounts, stats, events, config: integrationConfig(env) };
}

/**
 * Second pass over an ALREADY-RENDERED page of accounts: ask the antifraud
 * monitor for saved Sumsub country evidence and hang it on the matching rows.
 *
 * Same rows, same order, same filters — this only fills `countryReview`, which
 * {@link getKycDashboard} leaves null. `refreshKycCountryReviews` swallows its
 * own transport failures and resolves to `[]`, so a dead or slow monitor
 * degrades to "no country evidence" instead of taking the page with it.
 */
export async function loadKycCountryReviews(
  accounts: readonly KycAccount[],
): Promise<KycAccount[]> {
  const countryReviews = await refreshKycCountryReviews(
    accounts
      .filter(
        (account) =>
          account.applicantId !== null &&
          (account.status === "approved" || account.status === "rejected"),
      )
      .slice(0, 100)
      .map((account) => ({
        userId: account.userId,
        applicantId: account.applicantId!,
        accountCountry: account.countryCode?.trim() || null,
      })),
  );
  if (countryReviews.length === 0) return [...accounts];

  const reviewsByApplicant = new Map(
    countryReviews.map((review) => [
      `${review.userId}:${review.applicantId}`,
      review,
    ]),
  );
  return accounts.map((account) => ({
    ...account,
    countryReview: account.applicantId
      ? reviewsByApplicant.get(`${account.userId}:${account.applicantId}`) ??
        null
      : null,
  }));
}
