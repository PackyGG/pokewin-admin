import type pg from "pg";

import type { Databases } from "./db.js";
import { canonicalIp, type EnrichmentService } from "./enrichment.js";
import {
  domainFromEmail,
  suspiciousGmailDotPattern,
} from "./fiat-email-domains.js";
import {
  DEFAULT_MIN_ACCOUNT_AGE_DAYS,
  evaluateFiatPerkCandidate,
  perkAccountAgeDays,
  type FiatPerkBehaviour,
  type FiatPerkBlocklistHit,
  type FiatPerkEvaluation,
  type FiatPerkHistory,
  type FiatPerkNetwork,
  type FiatPerkSubject,
} from "./fiat-perk-policy.js";
import type { ScoreWeightStore } from "./score-weight-store.js";
import type { Signup } from "./types.js";

/**
 * Fiat perk screening — the batch half of "who may deposit with a card".
 *
 * A run walks a scope of accounts, judges each one against everything the
 * databases and the identity providers already know, and parks the result in a
 * review queue. Staff approve or decline each account; an approval writes a
 * grant, and the live checkout endpoint refuses anyone without one.
 *
 * Cost discipline, because a scope can be thousands of accounts:
 *   • account ids are selected once, cheaply, and processed in small batches;
 *   • every per-account aggregate rides one batched query, never a loop;
 *   • provider calls only happen for accounts that already cleared every free
 *     check, are bounded to a small concurrency, and are cached per identity
 *     inside the run so one shared IP is never paid for twice.
 *
 * MAIN is only ever read. Nothing in this file writes to the game database.
 */

export const FIAT_PERK_SCOPES = [
  "all",
  "crypto_depositors",
  "prior_fiat",
  "active_players",
  "country",
  "never_screened",
] as const;
export type FiatPerkScope = (typeof FIAT_PERK_SCOPES)[number];

export const MAX_PERK_RUN_ACCOUNTS = 500;
const SUBJECT_BATCH_SIZE = 50;
const PROVIDER_CONCURRENCY = 4;
/** Ledger lookback for the behaviour aggregates, mirroring the checkout gate. */
const BEHAVIOUR_LOOKBACK_DAYS = 365;
/** A run whose process died is failed rather than left spinning forever. */
const INTERRUPTED_RUN_MINUTES = 60;

const GAME_WAGER_TYPES = [
  "pack_opening",
  "battle_bet",
  "battle_sponsorship",
  "keno_bet",
  "upgrader_bet",
];
const GAME_PAYOUT_TYPES = [
  "battle_refund",
  "battle_excess_to_voucher",
  "keno_payout",
  "upgrader_payout",
];
const REWARD_TYPES = [
  "deposit_bonus",
  "rakeback_claim",
  "gift_card_redeemed",
  "promo_code_redeemed",
  "race_prize",
  "rain_win",
  "waitlist_prize",
  "balance_reward_claim",
  "affiliate_claim",
  "affiliate_leaderboard_prize",
];

export type FiatPerkRunRequest = {
  scope: FiatPerkScope;
  minAccountAgeDays: number;
  limit: number;
  countryCode: string | null;
  activeWithinDays: number;
  excludeGranted: boolean;
  excludedUserIds: readonly string[];
  idempotencyKey: string;
  actorId: string;
  actorUsername: string | null;
};

export type FiatPerkRun = {
  id: string;
  scope: FiatPerkScope;
  scopeLabel: string;
  parameters: Record<string, unknown>;
  status: "running" | "completed" | "failed";
  requestedBy: string;
  requestedByUsername: string | null;
  scannedCount: number;
  candidateCount: number;
  passCount: number;
  reviewCount: number;
  failCount: number;
  providerChecks: number;
  pendingCount: number;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type FiatPerkCandidate = {
  id: string;
  runId: string;
  userId: string;
  username: string | null;
  email: string | null;
  avatarUrl: string | null;
  countryCode: string | null;
  accountAgeDays: number;
  verdict: "pass" | "review" | "fail";
  riskScore: number;
  blockingReasons: string[];
  checks: unknown;
  evidence: unknown;
  providerChecked: boolean;
  decision: "pending" | "approved" | "declined";
  decidedBy: string | null;
  decidedByUsername: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  grantStatus: "granted" | "revoked" | null;
  createdAt: string;
};

export type FiatPerkGrant = {
  userId: string;
  username: string | null;
  status: "granted" | "revoked";
  riskScore: number | null;
  grantedBy: string | null;
  grantedByUsername: string | null;
  grantedAt: string | null;
  revokedBy: string | null;
  revokedByUsername: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  updatedAt: string;
};

export class PerkDecisionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PerkDecisionConflictError";
  }
}

export class PerkCandidateNotFoundError extends Error {
  constructor() {
    super("The screened account no longer exists.");
    this.name = "PerkCandidateNotFoundError";
  }
}

type SubjectRow = {
  id: string;
  username: string | null;
  email: string | null;
  image: string | null;
  country: string | null;
  country_code: string | null;
  continent_code: string | null;
  state: string | null;
  city: string | null;
  affiliate_code: string | null;
  referred_by: string | null;
  signup_ip: string | null;
  created_at: Date;
  is_banned: boolean;
  is_locked: boolean;
  is_self_excluded: boolean;
  is_suspected_alt: boolean;
  fiat_locked: boolean;
  withdrawals_locked: boolean;
  lock_reason: string | null;
  country_blocked: boolean;
  country_fiat_locked: boolean;
  kyc_required: boolean;
  kyc_status: string;
  kyc_admin_decision: string;
  fingerprint_request_id: string | null;
  visitor_id: string | null;
  fingerprint_confidence: number | null;
  fingerprint_ip: string | null;
  user_agent: string | null;
  crypto_deposits: number;
  crypto_deposit_usd: string;
  fiat_deposits: number;
  fiat_deposit_usd: string;
  disputed_fiat: number;
  refunded_fiat: number;
  wager_usd: string;
  game_events: number;
  reward_usd: string;
  rain_wins: number;
  withdrawal_requests: number;
  withdrawal_usd: string;
  shared_device_users: number;
  shared_signup_ip_users: number;
};

function usdNumber(value: string | number | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export function scopeLabel(request: FiatPerkRunRequest): string {
  switch (request.scope) {
    case "crypto_depositors":
      return "Accounts with crypto deposits";
    case "prior_fiat":
      return "Accounts with earlier card deposits";
    case "active_players":
      return `Accounts that played in the last ${request.activeWithinDays} days`;
    case "country":
      return `Accounts in ${request.countryCode ?? "an unknown country"}`;
    case "never_screened":
      return "Accounts never screened before";
    default:
      return "All eligible accounts";
  }
}

/**
 * Scope → account ids. One cheap, bounded, index-backed pass over MAIN; every
 * expensive aggregate happens later, on this id set only.
 */
async function selectScopeUserIds(
  source: pg.Pool,
  antifraud: pg.Pool,
  request: FiatPerkRunRequest,
): Promise<string[]> {
  const values: unknown[] = [request.minAccountAgeDays];
  const conditions = [
    `u.created_at <= now() - ($1::numeric * interval '1 day')`,
    `COALESCE(u.role::text, '') <> 'creator'`,
    `'creator' <> ALL(COALESCE(u.roles::text[], ARRAY[]::text[]))`,
    // Restricted accounts would hard-fail every screen; keeping them out of the
    // scope keeps a sweep about accounts staff can actually act on.
    `NOT u.is_banned`,
    `NOT u.is_locked`,
  ];

  if (request.excludedUserIds.length > 0) {
    values.push([...request.excludedUserIds]);
    conditions.push(`u.id <> ALL($${values.length}::text[])`);
  }

  switch (request.scope) {
    case "crypto_depositors":
      conditions.push(`EXISTS (
        SELECT 1 FROM ledger_transactions lt
        LEFT JOIN fiat_deposit_intents fdi ON fdi.completed_ledger_id = lt.id
        WHERE lt.user_id = u.id
          AND lt.type::text = 'deposit'
          AND lt.status::text = 'completed'
          AND fdi.id IS NULL
          AND (
            lt.crypto_asset IS NOT NULL
            OR lt.blockchain_tx_hash IS NOT NULL
            OR lt.fireblocks_tx_id IS NOT NULL
          )
      )`);
      break;
    case "prior_fiat":
      conditions.push(`EXISTS (
        SELECT 1 FROM fiat_deposit_intents fdi
        WHERE fdi.user_id = u.id AND fdi.status::text = 'completed'
      )`);
      break;
    case "active_players": {
      values.push(request.activeWithinDays);
      const days = values.length;
      values.push(GAME_WAGER_TYPES);
      conditions.push(`EXISTS (
        SELECT 1 FROM ledger_transactions lt
        WHERE lt.user_id = u.id
          AND lt.status::text = 'completed'
          AND lt.type::text = ANY($${values.length}::text[])
          AND lt.created_at >= now() - ($${days}::int * interval '1 day')
      )`);
      break;
    }
    case "country":
      values.push(request.countryCode ?? "");
      conditions.push(`UPPER(COALESCE(u.country_code, '')) = UPPER($${values.length})`);
      break;
    default:
      break;
  }

  // "Never screened" and "exclude granted" both filter against the Antifraud
  // database, which MAIN cannot join. Resolve those id sets first and pass them
  // in — both are small and bounded by the operator's own decisions.
  const skipIds = new Set<string>();
  if (request.excludeGranted || request.scope === "never_screened") {
    const granted = await antifraud.query<{ user_id: string }>(
      `SELECT user_id FROM fiat_perk_grants WHERE status = 'granted'`,
    );
    if (request.excludeGranted) {
      for (const row of granted.rows) skipIds.add(row.user_id);
    }
  }
  if (request.scope === "never_screened") {
    const screened = await antifraud.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM fiat_perk_candidates`,
    );
    for (const row of screened.rows) skipIds.add(row.user_id);
  }
  if (skipIds.size > 0) {
    values.push([...skipIds]);
    conditions.push(`u.id <> ALL($${values.length}::text[])`);
  }

  values.push(Math.min(MAX_PERK_RUN_ACCOUNTS, Math.max(1, request.limit)));
  const result = await source.query<{ id: string }>(
    `
      SELECT u.id
      FROM "user" u
      WHERE ${conditions.join("\n        AND ")}
      ORDER BY u.created_at DESC
      LIMIT $${values.length}
    `,
    values,
  );
  return result.rows.map((row) => row.id);
}

/**
 * Everything MAIN can say about one batch of accounts: standing, locks, KYC,
 * country policy, the newest known device, and the funding / play / reward /
 * cash-out aggregates the behaviour rules judge.
 */
async function loadSubjects(
  source: pg.Pool,
  userIds: readonly string[],
): Promise<SubjectRow[]> {
  if (userIds.length === 0) return [];
  const result = await source.query<SubjectRow>(
    `
      SELECT
        u.id, u.username, u.email, u.image, u.country, u.country_code,
        u.continent_code, u.state, u.city, u.affiliate_code, u.referred_by,
        u.signup_ip::text AS signup_ip,
        u.created_at AT TIME ZONE 'UTC' AS created_at,
        u.is_banned, u.is_locked, u.is_self_excluded, u.is_suspected_alt,
        COALESCE(cardinality(ufl.locked_deposits_fiat), 0) > 0 AS fiat_locked,
        (
          COALESCE(cardinality(ufl.locked_withdrawals_crypto), 0) > 0
          OR COALESCE(ufl.locked_withdrawals_items, false)
        ) AS withdrawals_locked,
        COALESCE(
          ufl.locked_deposits_reason,
          ufl.locked_withdrawals_reason
        ) AS lock_reason,
        COALESCE(cr.blocked, false) AS country_blocked,
        COALESCE(cardinality(cr.locked_deposits_fiat), 0) > 0
          AS country_fiat_locked,
        COALESCE(uk.kyc_required, false) AS kyc_required,
        COALESCE(uk.status::text, 'none') AS kyc_status,
        COALESCE(uk.admin_decision::text, 'pending') AS kyc_admin_decision,
        fp.request_id AS fingerprint_request_id,
        fp.visitor_id,
        fp.confidence AS fingerprint_confidence,
        fp.ip::text AS fingerprint_ip,
        ae.user_agent,
        COALESCE(dep.crypto_deposits, 0)::int AS crypto_deposits,
        COALESCE(dep.crypto_deposit_usd, 0)::text AS crypto_deposit_usd,
        COALESCE(dep.fiat_deposits, 0)::int AS fiat_deposits,
        COALESCE(dep.fiat_deposit_usd, 0)::text AS fiat_deposit_usd,
        COALESCE(card.disputed_fiat, 0)::int AS disputed_fiat,
        COALESCE(card.refunded_fiat, 0)::int AS refunded_fiat,
        COALESCE(act.wager_usd, 0)::text AS wager_usd,
        COALESCE(act.game_events, 0)::int AS game_events,
        COALESCE(act.reward_usd, 0)::text AS reward_usd,
        COALESCE(act.rain_wins, 0)::int AS rain_wins,
        COALESCE(cash.withdrawal_requests, 0)::int AS withdrawal_requests,
        COALESCE(cash.withdrawal_usd, 0)::text AS withdrawal_usd,
        COALESCE(net.shared_device_users, 0)::int AS shared_device_users,
        CASE
          WHEN NULLIF(u.signup_ip::text, '') IS NULL THEN 0
          ELSE COALESCE(net.shared_signup_ip_users, 0)
        END::int AS shared_signup_ip_users
      FROM "user" u
      LEFT JOIN user_feature_locks ufl ON ufl.user_id = u.id
      LEFT JOIN user_kyc uk ON uk.user_id = u.id
      LEFT JOIN country_restrictions cr
        ON UPPER(cr.country_code) = UPPER(u.country_code)
      LEFT JOIN LATERAL (
        SELECT request_id, visitor_id, confidence, ip
        FROM fingerprints
        WHERE user_id = u.id
        ORDER BY created_at DESC
        LIMIT 1
      ) fp ON true
      LEFT JOIN LATERAL (
        SELECT user_agent
        FROM audit_events
        WHERE user_id = u.id AND event_type = 'register'
        ORDER BY created_at DESC
        LIMIT 1
      ) ae ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (
            WHERE intent.id IS NULL
              AND (
                lt.crypto_asset IS NOT NULL
                OR lt.blockchain_tx_hash IS NOT NULL
                OR lt.fireblocks_tx_id IS NOT NULL
              )
          ) AS crypto_deposits,
          COALESCE(SUM(ABS(lt.amount::numeric)) FILTER (
            WHERE intent.id IS NULL
              AND (
                lt.crypto_asset IS NOT NULL
                OR lt.blockchain_tx_hash IS NOT NULL
                OR lt.fireblocks_tx_id IS NOT NULL
              )
          ), 0) AS crypto_deposit_usd,
          COUNT(*) FILTER (WHERE intent.id IS NOT NULL) AS fiat_deposits,
          COALESCE(SUM(ABS(lt.amount::numeric)) FILTER (
            WHERE intent.id IS NOT NULL
          ), 0) AS fiat_deposit_usd
        FROM ledger_transactions lt
        LEFT JOIN fiat_deposit_intents intent
          ON intent.completed_ledger_id = lt.id
        WHERE lt.user_id = u.id
          AND lt.type::text = 'deposit'
          AND lt.status::text = 'completed'
          AND lt.created_at >= now() - ($2::int * interval '1 day')
      ) dep ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE f.status::text = 'disputed') AS disputed_fiat,
          COUNT(*) FILTER (
            WHERE f.status::text IN ('refunded', 'partially_refunded')
          ) AS refunded_fiat
        FROM fiat_deposit_intents f
        WHERE f.user_id = u.id
      ) card ON true
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(SUM(ABS(lt.amount::numeric)) FILTER (
            WHERE lt.type::text = ANY($3::text[])
          ), 0) AS wager_usd,
          COUNT(*) FILTER (
            WHERE lt.type::text = ANY($3::text[])
              OR lt.type::text = ANY($4::text[])
          ) AS game_events,
          COALESCE(SUM(ABS(lt.amount::numeric)) FILTER (
            WHERE lt.type::text = ANY($5::text[])
          ), 0) AS reward_usd,
          COUNT(*) FILTER (WHERE lt.type::text = 'rain_win') AS rain_wins
        FROM ledger_transactions lt
        WHERE lt.user_id = u.id
          AND lt.status::text = 'completed'
          AND lt.created_at >= now() - ($2::int * interval '1 day')
          AND (
            lt.type::text = ANY($3::text[])
            OR lt.type::text = ANY($4::text[])
            OR lt.type::text = ANY($5::text[])
          )
      ) act ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS withdrawal_requests,
          COALESCE(SUM(cwr.total_value_usd::numeric), 0) AS withdrawal_usd
        FROM card_withdrawal_requests cwr
        WHERE cwr.user_id = u.id
      ) cash ON true
      LEFT JOIN LATERAL (
        SELECT
          (
            SELECT COUNT(DISTINCT other.user_id)::int
            FROM fingerprints mine
            JOIN fingerprints other
              ON other.visitor_id = mine.visitor_id
             AND other.user_id IS NOT NULL
             AND other.user_id <> mine.user_id
            WHERE mine.user_id = u.id
          ) AS shared_device_users,
          (
            SELECT GREATEST(COUNT(*)::int - 1, 0)
            FROM "user" peer
            WHERE peer.signup_ip = u.signup_ip
          ) AS shared_signup_ip_users
      ) net ON true
      WHERE u.id = ANY($1::text[])
    `,
    [
      [...userIds],
      BEHAVIOUR_LOOKBACK_DAYS,
      GAME_WAGER_TYPES,
      GAME_PAYOUT_TYPES,
      REWARD_TYPES,
    ],
  );
  return result.rows;
}

/** Active operator blacklist rules matching this batch's identities. */
async function loadBlocklistHits(
  antifraud: pg.Pool,
  rows: readonly SubjectRow[],
): Promise<Map<string, FiatPerkBlocklistHit[]>> {
  const hits = new Map<string, FiatPerkBlocklistHit[]>();
  const push = (userId: string, hit: FiatPerkBlocklistHit): void => {
    const existing = hits.get(userId);
    if (existing) existing.push(hit);
    else hits.set(userId, [hit]);
  };

  const domainByUser = new Map<string, string>();
  for (const row of rows) {
    // A dot-fragmented Gmail address is its own fraud pattern; it needs no
    // blacklist row to be disqualifying.
    if (row.email && suspiciousGmailDotPattern(row.email)) {
      push(row.id, {
        kind: "email_domain",
        value: row.email,
        reason: "The Gmail local part is heavily dot-fragmented.",
      });
    }
    const domain = row.email ? domainFromEmail(row.email) : null;
    if (domain) domainByUser.set(row.id, domain);
  }

  const domains = [...new Set(domainByUser.values())];
  if (domains.length > 0) {
    const blacklisted = await antifraud.query<{
      domain: string;
      reason: string;
    }>(
      `
        SELECT lower(domain) AS domain, reason
        FROM fiat_email_domain_blacklist
        WHERE enabled
          AND (expires_at IS NULL OR expires_at > now())
          AND lower(domain) = ANY($1::text[])
      `,
      [domains],
    );
    const byDomain = new Map(
      blacklisted.rows.map((row) => [row.domain, row.reason]),
    );
    for (const [userId, domain] of domainByUser) {
      const reason = byDomain.get(domain);
      if (reason) {
        push(userId, { kind: "email_domain", value: domain, reason });
      }
    }
  }

  const ipByUser = new Map<string, string>();
  const visitorByUser = new Map<string, string>();
  for (const row of rows) {
    const ip = canonicalIp(row.fingerprint_ip) ?? canonicalIp(row.signup_ip);
    if (ip) ipByUser.set(row.id, ip);
    if (row.visitor_id) visitorByUser.set(row.id, row.visitor_id);
  }

  if (ipByUser.size > 0) {
    const matched = await antifraud.query<{ value: string; reason: string }>(
      `
        SELECT DISTINCT ON (t.ip) t.ip AS value, b.reason
        FROM unnest($1::text[]) AS t(ip)
        JOIN identifier_blocklists b
          ON b.kind = 'ip'
         AND b.enabled
         AND (b.expires_at IS NULL OR b.expires_at > now())
         AND pg_input_is_valid(t.ip, 'inet')
         AND t.ip::inet <<= b.ip_network
        ORDER BY t.ip, b.created_at
      `,
      [[...new Set(ipByUser.values())]],
    );
    const byIp = new Map(matched.rows.map((row) => [row.value, row.reason]));
    for (const [userId, ip] of ipByUser) {
      const reason = byIp.get(ip);
      if (reason) push(userId, { kind: "ip", value: ip, reason });
    }
  }

  if (visitorByUser.size > 0) {
    const matched = await antifraud.query<{ value: string; reason: string }>(
      `
        SELECT DISTINCT ON (b.fingerprint_id) b.fingerprint_id AS value, b.reason
        FROM identifier_blocklists b
        WHERE b.kind = 'fingerprint'
          AND b.enabled
          AND (b.expires_at IS NULL OR b.expires_at > now())
          AND b.fingerprint_id = ANY($1::text[])
        ORDER BY b.fingerprint_id, b.created_at
      `,
      [[...new Set(visitorByUser.values())]],
    );
    const byVisitor = new Map(
      matched.rows.map((row) => [row.value, row.reason]),
    );
    for (const [userId, visitorId] of visitorByUser) {
      const reason = byVisitor.get(visitorId);
      if (reason) push(userId, { kind: "fingerprint", value: visitorId, reason });
    }
  }

  return hits;
}

async function loadHistories(
  antifraud: pg.Pool,
  userIds: readonly string[],
): Promise<Map<string, FiatPerkHistory>> {
  if (userIds.length === 0) return new Map();
  const result = await antifraud.query<{
    user_id: string;
    signup_risk_score: number;
    open_case_severity: string | null;
  }>(
    `
      SELECT
        t.user_id,
        COALESCE(sa.score, 0)::int AS signup_risk_score,
        c.severity AS open_case_severity
      FROM unnest($1::text[]) AS t(user_id)
      LEFT JOIN signup_assessments sa ON sa.user_id = t.user_id
      LEFT JOIN LATERAL (
        SELECT severity
        FROM cases
        WHERE user_id = t.user_id AND status <> 'resolved'
        ORDER BY
          CASE severity
            WHEN 'critical' THEN 4
            WHEN 'high' THEN 3
            WHEN 'medium' THEN 2
            ELSE 1
          END DESC,
          updated_at DESC
        LIMIT 1
      ) c ON true
    `,
    [[...userIds]],
  );
  return new Map(
    result.rows.map((row) => [
      row.user_id,
      {
        signupRiskScore: row.signup_risk_score,
        openCaseSeverity: row.open_case_severity,
      },
    ]),
  );
}

function subjectFrom(row: SubjectRow): FiatPerkSubject {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    countryCode: row.country_code,
    createdAt: new Date(row.created_at),
    isBanned: row.is_banned,
    isLocked: row.is_locked,
    isSelfExcluded: row.is_self_excluded,
    isSuspectedAlt: row.is_suspected_alt,
    fiatLocked: row.fiat_locked,
    withdrawalsLocked: row.withdrawals_locked,
    lockReason: row.lock_reason,
    countryBlocked: row.country_blocked,
    countryFiatLocked: row.country_fiat_locked,
    kycRequired: row.kyc_required,
    kycStatus: row.kyc_status,
    kycAdminDecision: row.kyc_admin_decision,
  };
}

function behaviourFrom(row: SubjectRow): FiatPerkBehaviour {
  return {
    cryptoDeposits: row.crypto_deposits,
    cryptoDepositUsd: usdNumber(row.crypto_deposit_usd),
    fiatDeposits: row.fiat_deposits,
    fiatDepositUsd: usdNumber(row.fiat_deposit_usd),
    disputedFiat: row.disputed_fiat,
    refundedFiat: row.refunded_fiat,
    wagerUsd: usdNumber(row.wager_usd),
    gameEvents: row.game_events,
    rewardUsd: usdNumber(row.reward_usd),
    rainWins: row.rain_wins,
    withdrawalRequests: row.withdrawal_requests,
    withdrawalUsd: usdNumber(row.withdrawal_usd),
  };
}

function networkFrom(row: SubjectRow): FiatPerkNetwork {
  return {
    sharedDeviceUsers: row.shared_device_users,
    sharedSignupIpUsers: row.shared_signup_ip_users,
    signupIp: canonicalIp(row.signup_ip) ?? row.signup_ip,
    visitorId: row.visitor_id,
  };
}

/**
 * The provider lookup subject. Providers are asked about the account's MOST
 * RECENT known identity, not its signup one — a two-year-old signup IP says
 * nothing about who is holding the card today.
 */
function providerSubjectFrom(row: SubjectRow): Signup {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    image: row.image,
    signup_ip: canonicalIp(row.fingerprint_ip)
      ?? canonicalIp(row.signup_ip)
      ?? null,
    country: row.country,
    country_code: row.country_code,
    continent_code: row.continent_code,
    state: row.state,
    city: row.city,
    affiliate_code: row.affiliate_code,
    referred_by: row.referred_by,
    is_suspected_alt: row.is_suspected_alt,
    created_at: new Date(row.created_at),
    fingerprint_request_id: row.fingerprint_request_id,
    visitor_id: row.visitor_id,
    fingerprint_confidence: row.fingerprint_confidence,
    fingerprint_ip: row.fingerprint_ip,
    user_agent: row.user_agent,
  };
}

/** Run `worker` over `items`, at most `limit` at a time, preserving order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await worker(items[index]!, index);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

export class FiatPerkService {
  private readonly running = new Set<string>();

  constructor(
    private readonly db: Databases,
    private readonly enrichment: EnrichmentService,
    private readonly scoreWeights: ScoreWeightStore,
  ) {}

  /**
   * A deploy or crash mid-run leaves a row claiming to be running forever.
   * Called at boot so the workspace never shows a phantom sweep.
   */
  async recoverInterruptedRuns(): Promise<number> {
    const result = await this.db.antifraud.query(
      `
        UPDATE fiat_perk_runs
        SET status = 'failed',
            error_code = 'interrupted',
            completed_at = now()
        WHERE status = 'running'
          AND created_at < now() - ($1::int * interval '1 minute')
      `,
      [INTERRUPTED_RUN_MINUTES],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Create the run row and start the sweep. Returns as soon as the row exists —
   * screening keeps going in the background and the workspace polls the run.
   */
  async startRun(request: FiatPerkRunRequest): Promise<FiatPerkRun> {
    const label = scopeLabel(request);
    const parameters = {
      minAccountAgeDays: request.minAccountAgeDays,
      limit: request.limit,
      countryCode: request.countryCode,
      activeWithinDays: request.activeWithinDays,
      excludeGranted: request.excludeGranted,
    };
    const inserted = await this.db.antifraud.query<{ id: string }>(
      `
        INSERT INTO fiat_perk_runs (
          scope, scope_label, parameters, requested_by, requested_by_username,
          idempotency_key
        ) VALUES ($1, $2, $3::jsonb, $4, $5, $6)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id
      `,
      [
        request.scope,
        label,
        JSON.stringify(parameters),
        request.actorId,
        request.actorUsername,
        request.idempotencyKey,
      ],
    );

    const runId = inserted.rows[0]?.id;
    if (!runId) {
      // A retry of the same submission: hand back the run it already started.
      const existing = await this.getRunByIdempotencyKey(request.idempotencyKey);
      if (!existing) throw new Error("fiat_perk_run_persistence_failed");
      return existing;
    }

    this.running.add(runId);
    void this.execute(runId, request)
      .catch(async (error: unknown) => {
        console.error("[fiat-perks] run failed", {
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.db.antifraud
          .query(
            `
              UPDATE fiat_perk_runs
              SET status = 'failed', error_code = $2, completed_at = now()
              WHERE id = $1 AND status = 'running'
            `,
            [
              runId,
              (error instanceof Error ? error.name : "run_failed").slice(0, 80),
            ],
          )
          .catch(() => undefined);
      })
      .finally(() => {
        this.running.delete(runId);
      });

    const run = await this.getRun(runId);
    if (!run) throw new Error("fiat_perk_run_persistence_failed");
    return run;
  }

  private async execute(
    runId: string,
    request: FiatPerkRunRequest,
  ): Promise<void> {
    const now = new Date();
    const userIds = await selectScopeUserIds(
      this.db.source,
      this.db.antifraud,
      request,
    );
    await this.db.antifraud.query(
      `UPDATE fiat_perk_runs SET scanned_count = $2 WHERE id = $1`,
      [runId, userIds.length],
    );

    const weights = await this.scoreWeights.get();
    // One provider answer per identity, reused across accounts inside the run.
    const providerCache = new Map<string, Promise<EnrichmentBundle>>();
    let providerChecks = 0;

    for (let index = 0; index < userIds.length; index += SUBJECT_BATCH_SIZE) {
      const batchIds = userIds.slice(index, index + SUBJECT_BATCH_SIZE);
      const rows = await loadSubjects(this.db.source, batchIds);
      if (rows.length === 0) continue;

      const [blocklistHits, histories] = await Promise.all([
        loadBlocklistHits(this.db.antifraud, rows),
        loadHistories(this.db.antifraud, rows.map((row) => row.id)),
      ]);

      const prepared = rows.map((row) => {
        const base = {
          now,
          minAccountAgeDays: request.minAccountAgeDays,
          subject: subjectFrom(row),
          behaviour: behaviourFrom(row),
          network: networkFrom(row),
          blocklistHits: blocklistHits.get(row.id) ?? [],
          history: histories.get(row.id)
            ?? { signupRiskScore: 0, openCaseSeverity: null },
        };
        // Cheap verdict first: an account that already failed never costs a
        // provider call.
        const dataOnly = evaluateFiatPerkCandidate({
          ...base,
          providers: [],
          providersChecked: false,
        });
        return { row, base, dataOnly };
      });

      const evaluated = await mapWithConcurrency(
        prepared,
        PROVIDER_CONCURRENCY,
        async ({ row, base, dataOnly }) => {
          if (dataOnly.verdict === "fail") {
            return { row, evaluation: dataOnly, providerChecked: false };
          }
          const providerSubject = providerSubjectFrom(row);
          const cacheKey = `${providerSubject.fingerprint_request_id ?? "-"}|${
            providerSubject.signup_ip ?? "-"
          }`;
          let bundle = providerCache.get(cacheKey);
          if (!bundle) {
            providerChecks += 1;
            bundle = loadProviderBundle(
              this.enrichment,
              providerSubject,
              weights,
            );
            providerCache.set(cacheKey, bundle);
          }
          const providers = await bundle;
          return {
            row,
            evaluation: evaluateFiatPerkCandidate({
              ...base,
              providers,
              providersChecked: true,
            }),
            providerChecked: true,
          };
        },
      );

      await this.persistCandidates(runId, now, evaluated);
    }

    await this.db.antifraud.query(
      `
        UPDATE fiat_perk_runs
        SET status = 'completed',
            provider_checks = $2,
            completed_at = now()
        WHERE id = $1 AND status = 'running'
      `,
      [runId, providerChecks],
    );
  }

  private async persistCandidates(
    runId: string,
    now: Date,
    evaluated: readonly {
      row: SubjectRow;
      evaluation: FiatPerkEvaluation;
      providerChecked: boolean;
    }[],
  ): Promise<void> {
    if (evaluated.length === 0) return;
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      for (const { row, evaluation, providerChecked } of evaluated) {
        await client.query(
          `
            INSERT INTO fiat_perk_candidates (
              run_id, user_id, username, email, avatar_url, country_code,
              account_age_days, verdict, risk_score, blocking_reasons,
              checks, evidence, provider_checked
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[],
              $11::jsonb, $12::jsonb, $13
            )
            ON CONFLICT (run_id, user_id) DO NOTHING
          `,
          [
            runId,
            row.id,
            row.username,
            row.email,
            row.image,
            row.country_code,
            perkAccountAgeDays(new Date(row.created_at), now).toFixed(2),
            evaluation.verdict,
            evaluation.riskScore,
            evaluation.blockingReasons,
            JSON.stringify(evaluation.checks),
            JSON.stringify({
              behaviour: behaviourFrom(row),
              network: networkFrom(row),
              lastKnownIp: canonicalIp(row.fingerprint_ip)
                ?? canonicalIp(row.signup_ip)
                ?? null,
              visitorId: row.visitor_id,
            }),
            providerChecked,
          ],
        );
      }
      await client.query(
        `
          UPDATE fiat_perk_runs r
          SET candidate_count = counts.total,
              pass_count = counts.pass,
              review_count = counts.review,
              fail_count = counts.fail
          FROM (
            SELECT
              count(*)::int AS total,
              count(*) FILTER (WHERE verdict = 'pass')::int AS pass,
              count(*) FILTER (WHERE verdict = 'review')::int AS review,
              count(*) FILTER (WHERE verdict = 'fail')::int AS fail
            FROM fiat_perk_candidates
            WHERE run_id = $1
          ) counts
          WHERE r.id = $1
        `,
        [runId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getRun(runId: string): Promise<FiatPerkRun | null> {
    const result = await this.db.antifraud.query<RunRow>(
      `${RUN_SELECT} WHERE r.id = $1`,
      [runId],
    );
    const row = result.rows[0];
    return row ? serializeRun(row) : null;
  }

  private async getRunByIdempotencyKey(
    key: string,
  ): Promise<FiatPerkRun | null> {
    const result = await this.db.antifraud.query<RunRow>(
      `${RUN_SELECT} WHERE r.idempotency_key = $1`,
      [key],
    );
    const row = result.rows[0];
    return row ? serializeRun(row) : null;
  }

  async listRuns(limit = 20): Promise<FiatPerkRun[]> {
    const result = await this.db.antifraud.query<RunRow>(
      `${RUN_SELECT} ORDER BY r.created_at DESC LIMIT $1`,
      [Math.min(100, Math.max(1, limit))],
    );
    return result.rows.map(serializeRun);
  }

  async listCandidates(input: {
    runId: string;
    verdict?: "pass" | "review" | "fail";
    decision?: "pending" | "approved" | "declined";
    search?: string;
    limit: number;
  }): Promise<FiatPerkCandidate[]> {
    const values: unknown[] = [input.runId];
    const conditions = ["c.run_id = $1"];
    if (input.verdict) {
      values.push(input.verdict);
      conditions.push(`c.verdict = $${values.length}`);
    }
    if (input.decision) {
      values.push(input.decision);
      conditions.push(`c.decision = $${values.length}`);
    }
    if (input.search) {
      values.push(`%${input.search.toLowerCase()}%`);
      conditions.push(`(
        lower(c.user_id) LIKE $${values.length}
        OR lower(COALESCE(c.username, '')) LIKE $${values.length}
        OR lower(COALESCE(c.email, '')) LIKE $${values.length}
      )`);
    }
    values.push(Math.min(500, Math.max(1, input.limit)));
    const result = await this.db.antifraud.query<CandidateRow>(
      `
        ${CANDIDATE_SELECT}
        WHERE ${conditions.join(" AND ")}
        ORDER BY
          CASE c.decision WHEN 'pending' THEN 0 ELSE 1 END,
          CASE c.verdict WHEN 'pass' THEN 0 WHEN 'review' THEN 1 ELSE 2 END,
          c.risk_score,
          c.created_at
        LIMIT $${values.length}
      `,
      values,
    );
    return result.rows.map(serializeCandidate);
  }

  /**
   * Approve or decline one screened account. Idempotent on the caller's key, so
   * a retried click can never double-write or flip an already-recorded call.
   */
  async decide(input: {
    candidateId: string;
    decision: "approved" | "declined";
    note: string | null;
    idempotencyKey: string;
    actorId: string;
    actorUsername: string | null;
  }): Promise<FiatPerkCandidate> {
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      const prior = await client.query<{
        candidate_id: string | null;
        actor_id: string;
        action: string;
      }>(
        `
          SELECT candidate_id, actor_id, action
          FROM fiat_perk_audit
          WHERE idempotency_key = $1
        `,
        [input.idempotencyKey],
      );
      const seen = prior.rows[0];
      if (seen) {
        await client.query("ROLLBACK");
        if (
          seen.candidate_id !== input.candidateId
          || seen.actor_id !== input.actorId
          || seen.action !== input.decision
        ) {
          throw new PerkDecisionConflictError(
            "That retry key was already used for a different decision.",
          );
        }
        const current = await this.getCandidate(input.candidateId);
        if (!current) throw new PerkCandidateNotFoundError();
        return current;
      }

      const locked = await client.query<{
        id: string;
        run_id: string;
        user_id: string;
        username: string | null;
        risk_score: number;
        decision: "pending" | "approved" | "declined";
      }>(
        `
          SELECT id, run_id, user_id, username, risk_score, decision
          FROM fiat_perk_candidates
          WHERE id = $1
          FOR UPDATE
        `,
        [input.candidateId],
      );
      const candidate = locked.rows[0];
      if (!candidate) {
        await client.query("ROLLBACK");
        throw new PerkCandidateNotFoundError();
      }
      if (candidate.decision !== "pending") {
        await client.query("ROLLBACK");
        throw new PerkDecisionConflictError(
          `That account was already ${candidate.decision}.`,
        );
      }

      await client.query(
        `
          UPDATE fiat_perk_candidates
          SET decision = $2,
              decided_by = $3,
              decided_by_username = $4,
              decided_at = now(),
              decision_note = $5
          WHERE id = $1
        `,
        [
          input.candidateId,
          input.decision,
          input.actorId,
          input.actorUsername,
          input.note,
        ],
      );

      if (input.decision === "approved") {
        await client.query(
          `
            INSERT INTO fiat_perk_grants (
              user_id, status, candidate_id, run_id, username, risk_score,
              granted_by, granted_by_username, granted_at, granted_note
            ) VALUES ($1, 'granted', $2, $3, $4, $5, $6, $7, now(), $8)
            ON CONFLICT (user_id) DO UPDATE SET
              status = 'granted',
              candidate_id = EXCLUDED.candidate_id,
              run_id = EXCLUDED.run_id,
              username = EXCLUDED.username,
              risk_score = EXCLUDED.risk_score,
              granted_by = EXCLUDED.granted_by,
              granted_by_username = EXCLUDED.granted_by_username,
              granted_at = now(),
              granted_note = EXCLUDED.granted_note,
              revoked_by = NULL,
              revoked_by_username = NULL,
              revoked_at = NULL,
              revoked_reason = NULL,
              updated_at = now()
          `,
          [
            candidate.user_id,
            candidate.id,
            candidate.run_id,
            candidate.username,
            candidate.risk_score,
            input.actorId,
            input.actorUsername,
            input.note,
          ],
        );
      }

      await client.query(
        `
          INSERT INTO fiat_perk_audit (
            candidate_id, user_id, action, actor_id, actor_username, note,
            idempotency_key, before_state, after_state
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
        `,
        [
          candidate.id,
          candidate.user_id,
          input.decision,
          input.actorId,
          input.actorUsername,
          input.note,
          input.idempotencyKey,
          JSON.stringify({ decision: candidate.decision }),
          JSON.stringify({
            decision: input.decision,
            riskScore: candidate.risk_score,
          }),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const updated = await this.getCandidate(input.candidateId);
    if (!updated) throw new PerkCandidateNotFoundError();
    return updated;
  }

  /** Withdraw a live grant. The next checkout is refused immediately. */
  async revokeGrant(input: {
    userId: string;
    reason: string;
    idempotencyKey: string;
    actorId: string;
    actorUsername: string | null;
  }): Promise<FiatPerkGrant> {
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      const prior = await client.query<{ user_id: string; action: string }>(
        `
          SELECT user_id, action FROM fiat_perk_audit
          WHERE idempotency_key = $1
        `,
        [input.idempotencyKey],
      );
      const seen = prior.rows[0];
      if (seen) {
        await client.query("ROLLBACK");
        if (seen.user_id !== input.userId || seen.action !== "revoked") {
          throw new PerkDecisionConflictError(
            "That retry key was already used for a different change.",
          );
        }
        const current = await this.getGrant(input.userId);
        if (!current) throw new PerkCandidateNotFoundError();
        return current;
      }

      const updated = await client.query(
        `
          UPDATE fiat_perk_grants
          SET status = 'revoked',
              revoked_by = $2,
              revoked_by_username = $3,
              revoked_at = now(),
              revoked_reason = $4,
              updated_at = now()
          WHERE user_id = $1 AND status = 'granted'
        `,
        [input.userId, input.actorId, input.actorUsername, input.reason],
      );
      if ((updated.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        throw new PerkDecisionConflictError(
          "That account does not hold a live Fiat perk.",
        );
      }

      await client.query(
        `
          INSERT INTO fiat_perk_audit (
            user_id, action, actor_id, actor_username, note, idempotency_key,
            after_state
          ) VALUES ($1, 'revoked', $2, $3, $4, $5, $6::jsonb)
        `,
        [
          input.userId,
          input.actorId,
          input.actorUsername,
          input.reason,
          input.idempotencyKey,
          JSON.stringify({ status: "revoked" }),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const grant = await this.getGrant(input.userId);
    if (!grant) throw new PerkCandidateNotFoundError();
    return grant;
  }

  async getCandidate(candidateId: string): Promise<FiatPerkCandidate | null> {
    const result = await this.db.antifraud.query<CandidateRow>(
      `${CANDIDATE_SELECT} WHERE c.id = $1`,
      [candidateId],
    );
    const row = result.rows[0];
    return row ? serializeCandidate(row) : null;
  }

  async getGrant(userId: string): Promise<FiatPerkGrant | null> {
    const result = await this.db.antifraud.query<GrantRow>(
      `${GRANT_SELECT} WHERE g.user_id = $1`,
      [userId],
    );
    const row = result.rows[0];
    return row ? serializeGrant(row) : null;
  }

  async listGrants(input: {
    status?: "granted" | "revoked";
    search?: string;
    limit: number;
  }): Promise<FiatPerkGrant[]> {
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (input.status) {
      values.push(input.status);
      conditions.push(`g.status = $${values.length}`);
    }
    if (input.search) {
      values.push(`%${input.search.toLowerCase()}%`);
      conditions.push(`(
        lower(g.user_id) LIKE $${values.length}
        OR lower(COALESCE(g.username, '')) LIKE $${values.length}
      )`);
    }
    values.push(Math.min(500, Math.max(1, input.limit)));
    const result = await this.db.antifraud.query<GrantRow>(
      `
        ${GRANT_SELECT}
        ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
        ORDER BY g.updated_at DESC
        LIMIT $${values.length}
      `,
      values,
    );
    return result.rows.map(serializeGrant);
  }
}

type EnrichmentBundle = Awaited<ReturnType<typeof loadProviderBundle>>;

/**
 * The provider fan-out for one identity. Never rejects: a provider that fails
 * becomes a "could not verify" check, which holds the account for review rather
 * than clearing or failing it on a transport blip.
 */
async function loadProviderBundle(
  enrichment: EnrichmentService,
  subject: Signup,
  weights: Parameters<EnrichmentService["fingerprintCheck"]>[1],
) {
  return Promise.all([
    enrichment.fingerprintCheck(subject, weights),
    enrichment.proxycheck(subject, weights, "signup"),
    enrichment.abstractIpCheck(subject, weights),
    enrichment.opportifyCheck(subject, weights),
  ]);
}

type RunRow = {
  id: string;
  scope: FiatPerkScope;
  scope_label: string;
  parameters: Record<string, unknown>;
  status: "running" | "completed" | "failed";
  requested_by: string;
  requested_by_username: string | null;
  scanned_count: number;
  candidate_count: number;
  pass_count: number;
  review_count: number;
  fail_count: number;
  provider_checks: number;
  pending_count: number;
  error_code: string | null;
  created_at: Date;
  completed_at: Date | null;
};

const RUN_SELECT = `
  SELECT
    r.id, r.scope, r.scope_label, r.parameters, r.status, r.requested_by,
    r.requested_by_username, r.scanned_count, r.candidate_count, r.pass_count,
    r.review_count, r.fail_count, r.provider_checks, r.error_code,
    r.created_at, r.completed_at,
    COALESCE(pending.count, 0)::int AS pending_count
  FROM fiat_perk_runs r
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS count
    FROM fiat_perk_candidates c
    WHERE c.run_id = r.id AND c.decision = 'pending' AND c.verdict <> 'fail'
  ) pending ON true
`;

function serializeRun(row: RunRow): FiatPerkRun {
  return {
    id: row.id,
    scope: row.scope,
    scopeLabel: row.scope_label,
    parameters: row.parameters ?? {},
    status: row.status,
    requestedBy: row.requested_by,
    requestedByUsername: row.requested_by_username,
    scannedCount: row.scanned_count,
    candidateCount: row.candidate_count,
    passCount: row.pass_count,
    reviewCount: row.review_count,
    failCount: row.fail_count,
    providerChecks: row.provider_checks,
    pendingCount: row.pending_count,
    errorCode: row.error_code,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

type CandidateRow = {
  id: string;
  run_id: string;
  user_id: string;
  username: string | null;
  email: string | null;
  avatar_url: string | null;
  country_code: string | null;
  account_age_days: string;
  verdict: "pass" | "review" | "fail";
  risk_score: number;
  blocking_reasons: string[];
  checks: unknown;
  evidence: unknown;
  provider_checked: boolean;
  decision: "pending" | "approved" | "declined";
  decided_by: string | null;
  decided_by_username: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  grant_status: "granted" | "revoked" | null;
  created_at: Date;
};

const CANDIDATE_SELECT = `
  SELECT
    c.id, c.run_id, c.user_id, c.username, c.email, c.avatar_url,
    c.country_code, c.account_age_days, c.verdict, c.risk_score,
    c.blocking_reasons, c.checks, c.evidence, c.provider_checked, c.decision,
    c.decided_by, c.decided_by_username, c.decided_at, c.decision_note,
    c.created_at, g.status AS grant_status
  FROM fiat_perk_candidates c
  LEFT JOIN fiat_perk_grants g ON g.user_id = c.user_id
`;

function serializeCandidate(row: CandidateRow): FiatPerkCandidate {
  return {
    id: row.id,
    runId: row.run_id,
    userId: row.user_id,
    username: row.username,
    email: row.email,
    avatarUrl: row.avatar_url,
    countryCode: row.country_code,
    accountAgeDays: Number(row.account_age_days),
    verdict: row.verdict,
    riskScore: row.risk_score,
    blockingReasons: row.blocking_reasons,
    checks: row.checks,
    evidence: row.evidence,
    providerChecked: row.provider_checked,
    decision: row.decision,
    decidedBy: row.decided_by,
    decidedByUsername: row.decided_by_username,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decisionNote: row.decision_note,
    grantStatus: row.grant_status,
    createdAt: row.created_at.toISOString(),
  };
}

type GrantRow = {
  user_id: string;
  username: string | null;
  status: "granted" | "revoked";
  risk_score: number | null;
  granted_by: string | null;
  granted_by_username: string | null;
  granted_at: Date | null;
  revoked_by: string | null;
  revoked_by_username: string | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
  updated_at: Date;
};

const GRANT_SELECT = `
  SELECT
    g.user_id, g.username, g.status, g.risk_score, g.granted_by,
    g.granted_by_username, g.granted_at, g.revoked_by, g.revoked_by_username,
    g.revoked_at, g.revoked_reason, g.updated_at
  FROM fiat_perk_grants g
`;

function serializeGrant(row: GrantRow): FiatPerkGrant {
  return {
    userId: row.user_id,
    username: row.username,
    status: row.status,
    riskScore: row.risk_score,
    grantedBy: row.granted_by,
    grantedByUsername: row.granted_by_username,
    grantedAt: row.granted_at?.toISOString() ?? null,
    revokedBy: row.revoked_by,
    revokedByUsername: row.revoked_by_username,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    revokedReason: row.revoked_reason,
    updatedAt: row.updated_at.toISOString(),
  };
}

export { DEFAULT_MIN_ACCOUNT_AGE_DAYS };
