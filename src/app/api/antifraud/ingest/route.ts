import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import {
  antifraud_review_notes,
  antifraud_reviews,
  antifraud_signals,
} from "@/lib/db-schema/admin/schema";
import { adminDrizzle } from "@/lib/drizzle";
import { getProdPrimaryDrizzleDb } from "@/lib/db";
import {
  parseAntifraudEvent,
  SEVERITY_RANK,
  shouldOpenReviewForSignal,
  type AntifraudSignalEvent,
} from "@/lib/antifraud/ws";
import {
  abstractCatchallContainmentTarget,
  applyAbstractCatchallContainment,
  type AbstractCatchallContainmentTarget,
} from "@/lib/antifraud/abstract-catchall-containment";
import { reviewSignalLabel } from "@/lib/antifraud/signal-display";
import {
  applyFiatIdentityContainment,
  fiatIdentityContainmentTarget,
} from "@/lib/antifraud/fiat-identity-containment";
import { isPostgresError } from "@/lib/postgres-errors";
import {
  appendAntifraudSecurityAudit,
  antifraudErrorCode,
} from "@/lib/antifraud/security-audit";

/**
 * Durable inbound webhook from the separate antifraud backend service.
 *
 * The monitor stream (`/api/antifraud/monitor/stream`) gives analysts LIVE
 * awareness while they have the workspace open. This route is the system of RECORD: every
 * signal the backend produces is POSTed here, persisted, and — when it is
 * serious enough — turned into a case on the review queue and pushed to the
 * on-call staff's Discord/Telegram. That means a fraud event at 04:00 with
 * nobody watching is still there in the morning.
 *
 * SECURITY MODEL
 *   • HMAC-SHA256 over `${timestamp}.${rawBody}`, keyed by
 *     `ANTIFRAUD_INGEST_SECRET`. Identical construction to the Discord rewards
 *     bot webhook (src/lib/creator-vip/bot-webhook.ts) so there is ONE signing
 *     scheme in this codebase to get right.
 *   • The RAW body bytes are signed and verified — the request text is read
 *     once and only re-parsed after the signature checks out. Re-serialising to
 *     verify would change key order and reject every delivery.
 *   • Constant-time comparison; a length mismatch fails before the compare.
 *   • ±5 minute timestamp window, so a captured delivery can't be replayed
 *     indefinitely.
 *   • Unset secret = the endpoint is CLOSED (503), not open. A missing
 *     credential must never mean "accept anything".
 *
 * Normally writes only the ADMIN DB. The dedicated
 * `fiat_blacklisted_email_domain`, `abstract_email_catchall`,
 * `signup_policy_recommendation`, `risky_free_battle_containment`,
 * `behavioral_withdrawal_containment`, `fiat_eligibility_containment` and
 * `fiat_deposit_identity_containment`
 * signals are also application-authorized containment commands: after
 * signature and payload validation, a first-time (non-duplicate) delivery
 * applies deterministic MAIN containment before acknowledgement. Active
 * blocked domains and Abstract-confirmed catch-all domains ban; suspicious
 * clusters and free-battle hard signals lock withdrawals only; a refused Fiat
 * checkout turns Fiat deposits off and locks withdrawals.
 *
 * KYC: automated signals do NOT mutate KYC state, with exactly one owner-
 * approved exception — `fiat_deposit_identity_containment` also requires KYC,
 * because a payer whose card/email/device stopped matching the identity the
 * account established on its first authorized deposit must re-verify before the
 * money moves again. That exception lives entirely in
 * `@/lib/antifraud/fiat-identity-containment` and is unreachable from the other
 * kinds.
 * Re-sent duplicates deliberately do NOT re-apply containment —
 * staff may have reviewed and unlocked the account in between.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Replay window for the signed timestamp. */
const MAX_SKEW_MS = 5 * 60 * 1000;

/** Cap on one delivery so a malformed batch can't fan out unbounded work. */
const MAX_EVENTS_PER_DELIVERY = 50;

/**
 * Body size ceiling in BYTES. A too-large `Content-Length` is rejected before
 * the body is read; because the header is optional (and spoofable) the
 * buffered body is re-checked with `Buffer.byteLength`, not `String.length`
 * (UTF-16 units would under-count multibyte payloads ~3x).
 */
const MAX_BODY_BYTES = 256 * 1024;

function sign(secret: string, timestamp: string, rawBody: string): string {
  return (
    "sha256=" +
    createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")
  );
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.ANTIFRAUD_INGEST_SECRET;
  if (!secret) {
    // Fail CLOSED. An unconfigured secret means the integration is off.
    return json({ error: "ingest_not_configured" }, 503);
  }

  const timestamp = request.headers.get("x-antifraud-timestamp");
  const signature = request.headers.get("x-antifraud-signature");
  if (!timestamp || !signature) {
    return json({ error: "missing_signature" }, 401);
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
    return json({ error: "stale_timestamp" }, 401);
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large" }, 413);
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large" }, 413);
  }

  if (!safeEqual(sign(secret, timestamp, rawBody), signature)) {
    return json({ error: "signature_mismatch" }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  // Accept either a single event or `{ events: [...] }`.
  const rawEvents: unknown[] = Array.isArray(
    (payload as { events?: unknown })?.events,
  )
    ? ((payload as { events: unknown[] }).events ?? [])
    : [payload];

  if (rawEvents.length > MAX_EVENTS_PER_DELIVERY) {
    return json({ error: "too_many_events" }, 400);
  }

  const signals = rawEvents
    .map(parseAntifraudEvent)
    .filter(
      (event): event is AntifraudSignalEvent =>
        event !== null && event.type === "signal",
    );

  if (signals.length === 0) {
    // Well-formed but nothing actionable — a 200 stops the backend retrying.
    return json({ ok: true, accepted: 0, skipped: rawEvents.length }, 200);
  }

  let accepted = 0;
  let duplicates = 0;
  let reviewsOpened = 0;
  let locksSkipped = 0;
  for (const signal of signals) {
    let correlationId: string;
    try {
      correlationId = await appendAntifraudSecurityAudit({
        actorUsername: "system:antifraud-monitor",
        actorRoles: ["system"],
        sessionRef: `signed-ingest:${timestamp}`,
        eventKind: "action",
        action: `antifraud.automated:${signal.kind}`,
        outcome: "allowed",
        targetType: "user",
        targetId: signal.userId ?? signal.id,
        idempotencyKey: signal.id,
        metadata: {
          severity: signal.severity,
          riskScore: signal.riskScore,
          modelVersion:
            typeof signal.payload?.modelVersion === "string"
              ? signal.payload.modelVersion
              : "unknown",
        },
      });
    } catch {
      return json({ error: "security_audit_unavailable" }, 503);
    }
    let result: IngestResult;
    try {
      result = await ingestOne(signal);
    } catch (err) {
      try {
        await appendAntifraudSecurityAudit({
          correlationId,
          actorUsername: "system:antifraud-monitor",
          actorRoles: ["system"],
          sessionRef: `signed-ingest:${timestamp}`,
          eventKind: "action",
          action: `antifraud.automated:${signal.kind}`,
          outcome: "failed",
          targetType: "user",
          targetId: signal.userId ?? signal.id,
          idempotencyKey: signal.id,
          reasonCode: antifraudErrorCode(err),
        });
      } catch {
        return json({ error: "security_audit_unavailable" }, 503);
      }
      if (isPostgresError(err, "42P01")) {
        return json({ error: "not_provisioned" }, 503);
      }
      console.error("[antifraud-ingest] failed to store signal:", err);
      // 500 so the backend retries this delivery — the external_id unique
      // index makes the retry safe (id-less signals get a deterministic
      // synthetic id, see externalIdForSignal).
      return json({ error: "storage_failed" }, 500);
    }

    if (result.outcome === "duplicate") {
      duplicates += 1;
      await appendAntifraudSecurityAudit({
        correlationId,
        actorUsername: "system:antifraud-monitor",
        actorRoles: ["system"],
        sessionRef: `signed-ingest:${timestamp}`,
        eventKind: "action",
        action: `antifraud.automated:${signal.kind}`,
        outcome: "succeeded",
        targetType: "user",
        targetId: signal.userId ?? signal.id,
        idempotencyKey: signal.id,
        metadata: { duplicate: true },
      });
      continue;
    }
    accepted += 1;
    if (result.outcome === "review_opened") reviewsOpened += 1;
    if (result.lockSkipped) locksSkipped += 1;
    await appendAntifraudSecurityAudit({
      correlationId,
      actorUsername: "system:antifraud-monitor",
      actorRoles: ["system"],
      sessionRef: `signed-ingest:${timestamp}`,
      eventKind: "action",
      action: `antifraud.automated:${signal.kind}`,
      outcome: "succeeded",
      targetType: "user",
      targetId: signal.userId ?? signal.id,
      idempotencyKey: signal.id,
      metadata: {
        result: result.outcome,
        lockSkipped: result.lockSkipped,
      },
    });

  }

  return json(
    { ok: true, accepted, duplicates, reviewsOpened, locksSkipped },
    200,
  );
}

function blacklistDomainFromSignal(
  signal: AntifraudSignalEvent,
): string | null {
  const value = signal.payload?.emailDomain;
  if (typeof value !== "string") return null;
  const domain = value.trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain) &&
    domain.includes(".")
    ? domain
    : null;
}

/**
 * Apply deterministic MAIN containment for one
 * `fiat_blacklisted_email_domain` signal. Active blocked domains ban.
 * Gmail dot-fragment and coordinated cluster signals lock withdrawals only.
 * Automated signals never mutate KYC state.
 *
 * Returns `"skipped"` for PERMANENT conditions (malformed containment fields,
 * account deleted since the signal was produced) instead of throwing: a throw
 * here becomes a 500 `storage_failed`, and the backend would retry the same
 * poison-pill delivery forever, blocking every other signal batched with it.
 * Only genuinely transient errors (DB down, etc.) are allowed to propagate
 * into the 500-retry path.
 */
async function containBlacklistedEmailDomainAccount(
  signal: AntifraudSignalEvent,
): Promise<"banned" | "locked" | "skipped"> {
  const userId = signal.userId;
  const domain = blacklistDomainFromSignal(signal);
  if (!userId || !domain || signal.riskScore !== 100) {
    console.error(
      "[antifraud-ingest] skipping invalid blacklisted email-domain containment signal",
      { externalId: signal.id || null, userId: signal.userId ?? null },
    );
    return "skipped";
  }

  const db = getProdPrimaryDrizzleDb();
  const source =
    signal.payload?.matchSource === "signup" ? "signup" : "Whop checkout";
  const patternMatch =
    signal.payload?.emailRiskType === "gmail_dot_fragmentation";
  const clusterMatch =
    signal.payload?.emailRiskType === "suspicious_deposit_cluster";
  const blockedDomainMatch =
    signal.payload?.emailRiskType === "blacklisted_domain";
  const reason =
    (clusterMatch
      ? `Automatic fraud lock: ${source} belonged to a suspicious coordinated deposit cluster (${domain})`
      : patternMatch
      ? `Automatic fraud lock: ${source} used a suspicious dot-fragmented Gmail address (${domain})`
      : `Automatic fraud ban: ${source} used active blocked email domain ${domain}`)
      .slice(0, 500);
  const contained = await db.transaction(async (tx) => {
    const locked = await tx.execute<{ user_id: string }>(sql`
      INSERT INTO user_feature_locks (
        id,
        user_id,
        locked_withdrawals_crypto,
        locked_withdrawals_items,
        locked_withdrawals_at,
        locked_withdrawals_by,
        locked_withdrawals_reason,
        created_at,
        updated_at
      )
      SELECT
        ${crypto.randomUUID()},
        u.id,
        ARRAY['all']::text[],
        TRUE,
        NOW(),
        NULL,
        ${reason},
        NOW(),
        NOW()
      FROM "user" u
      WHERE u.id = ${userId}
      ON CONFLICT (user_id) DO UPDATE SET
        locked_withdrawals_crypto = ARRAY['all']::text[],
        locked_withdrawals_items = TRUE,
        locked_withdrawals_at = COALESCE(
          user_feature_locks.locked_withdrawals_at,
          EXCLUDED.locked_withdrawals_at
        ),
        locked_withdrawals_reason = COALESCE(
          user_feature_locks.locked_withdrawals_reason,
          EXCLUDED.locked_withdrawals_reason
        ),
        updated_at = NOW()
      RETURNING user_id
    `);
    if (locked.rows.length === 0 || !blockedDomainMatch) {
      return locked.rows.length > 0;
    }

    await tx.execute(sql`
      UPDATE "user"
      SET
        is_banned = TRUE,
        banned_reason = CASE
          WHEN is_banned THEN COALESCE(banned_reason, ${reason})
          ELSE ${reason}
        END,
        banned_at = CASE
          WHEN is_banned THEN COALESCE(banned_at, NOW())
          ELSE NOW()
        END,
        banned_by = CASE WHEN is_banned THEN banned_by ELSE NULL END,
        updated_at = NOW()
      WHERE id = ${userId}
    `);
    await tx.execute(sql`DELETE FROM session WHERE "userId" = ${userId}`);
    return true;
  });
  if (!contained) {
    console.error(
      "[antifraud-ingest] blacklisted email-domain account no longer exists, skipping containment lock",
      { externalId: signal.id || null, userId },
    );
    return "skipped";
  }

  return blockedDomainMatch ? "banned" : "locked";
}

async function containAbstractCatchallAccount(
  signal: AntifraudSignalEvent,
): Promise<"banned" | "skipped"> {
  if (!abstractCatchallContainmentTarget(signal)) {
    console.error(
      "[antifraud-ingest] skipping invalid Abstract catch-all containment signal",
      { externalId: signal.id || null, userId: signal.userId ?? null },
    );
    return "skipped";
  }
  return applyAbstractCatchallContainment(signal, {
    banAccount: async (
      target: AbstractCatchallContainmentTarget,
    ): Promise<boolean> => {
      const db = getProdPrimaryDrizzleDb();
      return db.transaction(async (tx) => {
        const banned = await tx.execute<{ id: string }>(sql`
          UPDATE "user"
          SET
            is_banned = TRUE,
            banned_reason = CASE
              WHEN is_banned THEN COALESCE(banned_reason, ${target.reason})
              ELSE ${target.reason}
            END,
            banned_at = CASE
              WHEN is_banned THEN COALESCE(banned_at, NOW())
              ELSE NOW()
            END,
            banned_by = CASE WHEN is_banned THEN banned_by ELSE NULL END,
            updated_at = NOW()
          WHERE id = ${target.userId}
          RETURNING id
        `);
        if (banned.rows.length === 0) {
          console.error(
            "[antifraud-ingest] Abstract catch-all account no longer exists, skipping containment",
            { externalId: signal.id || null, userId: target.userId },
          );
          return false;
        }
        await tx.execute(
          sql`DELETE FROM session WHERE "userId" = ${target.userId}`,
        );
        return true;
      });
    },
  });
}

function containmentCount(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 10_000
    ? value
    : null;
}

/**
 * Lock withdrawals after at least two distinct free/sponsored battles connect
 * a participant to one or more fraud-flagged creators. Automated containment
 * never mutates KYC state.
 */
async function containRiskyFreeBattleAccount(
  signal: AntifraudSignalEvent,
): Promise<"locked" | "skipped"> {
  const userId = signal.userId;
  const matchCount = containmentCount(signal.payload?.matchCount);
  const battleCount = containmentCount(
    signal.payload?.qualifyingBattleCount,
  );
  const creatorCount = containmentCount(
    signal.payload?.distinctFlaggedCreators,
  );
  if (
    !userId ||
    signal.riskScore == null ||
    signal.riskScore < 80 ||
    signal.payload?.containmentRequired !== true ||
    matchCount == null ||
    matchCount < 2 ||
    battleCount == null ||
    battleCount < 2 ||
    creatorCount == null ||
    creatorCount < 1
  ) {
    console.error(
      "[antifraud-ingest] skipping invalid free-battle containment signal",
      { externalId: signal.id || null, userId: signal.userId ?? null },
    );
    return "skipped";
  }

  const reason = (
    `Automatic fraud lock: joined ${battleCount} free/sponsored battles ` +
    `created by ${creatorCount} flagged fraud account` +
    `${creatorCount === 1 ? "" : "s"}`
  ).slice(0, 500);
  const db = getProdPrimaryDrizzleDb();
  const locked = await db.execute<{ user_id: string }>(sql`
    INSERT INTO user_feature_locks (
      id,
      user_id,
      locked_withdrawals_crypto,
      locked_withdrawals_items,
      locked_withdrawals_at,
      locked_withdrawals_by,
      locked_withdrawals_reason,
      created_at,
      updated_at
    )
    SELECT
      ${crypto.randomUUID()},
      u.id,
      ARRAY['all']::text[],
      TRUE,
      NOW(),
      NULL,
      ${reason},
      NOW(),
      NOW()
    FROM "user" u
    WHERE u.id = ${userId}
    ON CONFLICT (user_id) DO UPDATE SET
      locked_withdrawals_crypto = ARRAY['all']::text[],
      locked_withdrawals_items = TRUE,
      locked_withdrawals_at = COALESCE(
        user_feature_locks.locked_withdrawals_at,
        EXCLUDED.locked_withdrawals_at
      ),
      locked_withdrawals_reason = COALESCE(
        user_feature_locks.locked_withdrawals_reason,
        EXCLUDED.locked_withdrawals_reason
      ),
      updated_at = NOW()
    RETURNING user_id
  `);
  if (locked.rows.length === 0) {
    console.error(
      "[antifraud-ingest] free-battle account no longer exists, skipping containment lock",
      { externalId: signal.id || null, userId },
    );
    return "skipped";
  }

  return "locked";
}

async function containIdentifierBlocklistAccount(
  signal: AntifraudSignalEvent,
): Promise<"locked" | "skipped"> {
  const policies = signal.payload?.policyMatches;
  const matched = Array.isArray(policies)
    && policies.some((policy) =>
      policy === "blocklist.ip" || policy === "blocklist.fingerprint"
    );
  if (!signal.userId || signal.riskScore !== 100 || !matched) {
    console.error(
      "[antifraud-ingest] skipping invalid identifier-blocklist containment signal",
      { externalId: signal.id || null, userId: signal.userId ?? null },
    );
    return "skipped";
  }

  const reason = (
    "Automatic fraud lock: signup matched an active operator-managed " +
    "IP or fingerprint blocklist rule"
  ).slice(0, 500);
  const db = getProdPrimaryDrizzleDb();
  const locked = await db.execute<{ user_id: string }>(sql`
    INSERT INTO user_feature_locks (
      id, user_id, locked_withdrawals_crypto, locked_withdrawals_items,
      locked_withdrawals_at, locked_withdrawals_by,
      locked_withdrawals_reason, created_at, updated_at
    )
    SELECT
      ${crypto.randomUUID()}, u.id, ARRAY['all']::text[], TRUE, NOW(), NULL,
      ${reason}, NOW(), NOW()
    FROM "user" u
    WHERE u.id = ${signal.userId}
    ON CONFLICT (user_id) DO UPDATE SET
      locked_withdrawals_crypto = ARRAY['all']::text[],
      locked_withdrawals_items = TRUE,
      locked_withdrawals_at = COALESCE(
        user_feature_locks.locked_withdrawals_at,
        EXCLUDED.locked_withdrawals_at
      ),
      locked_withdrawals_reason = COALESCE(
        user_feature_locks.locked_withdrawals_reason,
        EXCLUDED.locked_withdrawals_reason
      ),
      updated_at = NOW()
    RETURNING user_id
  `);
  return locked.rows.length > 0 ? "locked" : "skipped";
}

const BEHAVIORAL_CONTAINMENT_REASONS = new Set([
  "cluster.fingerprint_third_account",
  "cluster.exact_ip_third_account",
  "promotion.third_redemption",
  "network.tor",
  "device.confirmed_vm",
  "fingerprint.replayed",
  "fingerprint.identity_mismatch",
  "fingerprint.automation",
  "funds.restricted_downstream_active_use",
  "fresh-third-promo-redemption",
  "fresh_creator_tip",
  "fresh_sponsored_battle",
  "score_priority_policy",
]);

async function containBehavioralRiskAccount(
  signal: AntifraudSignalEvent,
): Promise<"locked" | "skipped"> {
  const userId = signal.userId;
  const reasonCode =
    typeof signal.payload?.reasonCode === "string"
      ? signal.payload.reasonCode
      : null;
  if (
    !userId ||
    signal.riskScore == null ||
    signal.riskScore < 70 ||
    signal.riskScore > 100 ||
    signal.payload?.containmentRequired !== true ||
    !reasonCode ||
    !BEHAVIORAL_CONTAINMENT_REASONS.has(reasonCode)
  ) {
    console.error(
      "[antifraud-ingest] skipping invalid behavioral containment signal",
      { externalId: signal.id || null, userId: signal.userId ?? null },
    );
    return "skipped";
  }

  const reason = (
    `Automatic fraud lock: behavioral policy ${reasonCode} ` +
    `matched at risk ${signal.riskScore}/100`
  ).slice(0, 500);
  const db = getProdPrimaryDrizzleDb();
  const locked = await db.execute<{ user_id: string }>(sql`
    INSERT INTO user_feature_locks (
      id, user_id, locked_withdrawals_crypto, locked_withdrawals_items,
      locked_withdrawals_at, locked_withdrawals_by,
      locked_withdrawals_reason, created_at, updated_at
    )
    SELECT
      ${crypto.randomUUID()}, u.id, ARRAY['all']::text[], TRUE,
      NOW(), NULL, ${reason}, NOW(), NOW()
    FROM "user" u
    WHERE u.id = ${userId}
    ON CONFLICT (user_id) DO UPDATE SET
      locked_withdrawals_crypto = ARRAY['all']::text[],
      locked_withdrawals_items = TRUE,
      locked_withdrawals_at = COALESCE(
        user_feature_locks.locked_withdrawals_at,
        EXCLUDED.locked_withdrawals_at
      ),
      locked_withdrawals_reason = COALESCE(
        user_feature_locks.locked_withdrawals_reason,
        EXCLUDED.locked_withdrawals_reason
      ),
      updated_at = NOW()
    RETURNING user_id
  `);
  return locked.rows.length > 0 ? "locked" : "skipped";
}

/**
 * Containment rules the automatic Fiat-checkout endpoint is allowed to enforce.
 * The monitor decides; this list is the dashboard's independent second opinion,
 * so a bug or a forged payload on the other side cannot invent a new reason to
 * lock an account.
 */
const FIAT_ELIGIBILITY_CONTAINMENT_REASONS = new Set([
  "new_account_checkout_ip_changed",
  "new_account_checkout_device_changed",
  "checkout_identity_changed_with_bad_reputation",
  "repeat_fiat_within_sixty_seconds",
  "blocklist_ip_match",
  "blocklist_fingerprint_match",
  "fingerprint_event_replayed",
  "fingerprint_linked_id_mismatch",
  "fingerprint_bad_bot",
]);

/**
 * Turn Fiat deposits off and lock withdrawals for an account the automatic
 * checkout assessment refused. Deliberately does NOT ban, does not touch
 * `is_locked`, does not kill sessions and never mutates KYC: the account keeps
 * working, its money rails do not, and staff decide the rest from the review
 * this same delivery opens.
 *
 * Both leg sets use COALESCE on `*_at` / `*_reason` so a repeat containment
 * never overwrites the first (or a human's) reason and timestamp.
 */
async function containFiatEligibilityAccount(
  signal: AntifraudSignalEvent,
): Promise<"locked" | "skipped"> {
  const userId = signal.userId;
  const rawReasons = signal.payload?.reasonCodes;
  const reasons = Array.isArray(rawReasons)
    ? rawReasons.filter(
        (reason): reason is string =>
          typeof reason === "string"
          && FIAT_ELIGIBILITY_CONTAINMENT_REASONS.has(reason),
      )
    : [];
  if (
    !userId ||
    signal.payload?.containmentRequired !== true ||
    signal.payload?.environment !== "prod" ||
    signal.riskScore == null ||
    signal.riskScore < 70 ||
    signal.riskScore > 100 ||
    reasons.length === 0
  ) {
    console.error(
      "[antifraud-ingest] skipping invalid Fiat eligibility containment signal",
      { externalId: signal.id || null, userId: signal.userId ?? null },
    );
    return "skipped";
  }

  const reason = (
    "Automatic fraud lock: Fiat checkout assessment matched "
    + reasons.join(", ")
  ).slice(0, 500);
  const db = getProdPrimaryDrizzleDb();
  const locked = await db.execute<{ user_id: string }>(sql`
    INSERT INTO user_feature_locks (
      id, user_id,
      locked_deposits_fiat, locked_deposits_at, locked_deposits_by,
      locked_deposits_reason,
      locked_withdrawals_crypto, locked_withdrawals_items,
      locked_withdrawals_at, locked_withdrawals_by,
      locked_withdrawals_reason,
      created_at, updated_at
    )
    SELECT
      ${crypto.randomUUID()}, u.id,
      ARRAY['all']::text[], NOW(), NULL, ${reason},
      ARRAY['all']::text[], TRUE, NOW(), NULL, ${reason},
      NOW(), NOW()
    FROM "user" u
    WHERE u.id = ${userId}
    ON CONFLICT (user_id) DO UPDATE SET
      locked_deposits_fiat = ARRAY['all']::text[],
      locked_deposits_at = COALESCE(
        user_feature_locks.locked_deposits_at,
        EXCLUDED.locked_deposits_at
      ),
      locked_deposits_reason = COALESCE(
        user_feature_locks.locked_deposits_reason,
        EXCLUDED.locked_deposits_reason
      ),
      locked_withdrawals_crypto = ARRAY['all']::text[],
      locked_withdrawals_items = TRUE,
      locked_withdrawals_at = COALESCE(
        user_feature_locks.locked_withdrawals_at,
        EXCLUDED.locked_withdrawals_at
      ),
      locked_withdrawals_reason = COALESCE(
        user_feature_locks.locked_withdrawals_reason,
        EXCLUDED.locked_withdrawals_reason
      ),
      updated_at = NOW()
    RETURNING user_id
  `);
  if (locked.rows.length === 0) {
    console.error(
      "[antifraud-ingest] Fiat eligibility account no longer exists, skipping containment lock",
      { externalId: signal.id || null, userId },
    );
    return "skipped";
  }
  return "locked";
}

/**
 * Post-authorization Fiat identity drift: lock the rails AND require KYC.
 *
 * The only containment kind that touches KYC state — see
 * `@/lib/antifraud/fiat-identity-containment` for why that exception exists and
 * why it cannot leak into the other kinds. Admission checks live in that module
 * too, so a forged payload cannot reach the lock.
 */
async function containFiatIdentityAccount(
  signal: AntifraudSignalEvent,
): Promise<"locked" | "skipped"> {
  const target = fiatIdentityContainmentTarget(signal);
  if (!target) {
    console.error(
      "[antifraud-ingest] skipping invalid Fiat identity containment signal",
      { externalId: signal.id || null, userId: signal.userId ?? null },
    );
    return "skipped";
  }

  const outcome = await applyFiatIdentityContainment(target);
  if (!outcome.locked) {
    console.error(
      "[antifraud-ingest] Fiat identity account no longer exists, skipping containment lock",
      { externalId: signal.id || null, userId: target.userId },
    );
    return "skipped";
  }
  if (outcome.kyc === "failed") {
    // The lock is applied; only the KYC leg degraded. Acknowledge rather than
    // retry — a retry would re-deliver the lock and risk a second verification
    // cycle. The Discord alert routes an analyst to the one-click requirement.
    console.error(
      "[antifraud-ingest] Fiat identity containment locked but KYC was not required",
      { externalId: signal.id || null, userId: target.userId },
    );
  }
  return "locked";
}

type IngestResult = {
  outcome: "stored" | "review_opened" | "duplicate";
  /** Containment was permanently un-appliable and acked instead of retried. */
  lockSkipped: boolean;
};

/**
 * The idempotency key for the dedupe index. The backend's own event id when it
 * sent one; otherwise a DETERMINISTIC synthetic id derived from the signal's
 * stable fields — an id-less signal must not insert `external_id NULL`,
 * because the partial unique index (`WHERE external_id IS NOT NULL`) ignores
 * NULLs and the 500-retry path would double-store it.
 */
function externalIdForSignal(signal: AntifraudSignalEvent): string {
  if (signal.id) return signal.id;
  return (
    "synthetic:" +
    createHash("sha256")
      .update(
        `${signal.kind}\n${signal.userId ?? ""}\n${signal.summary}\n${signal.at}`,
      )
      .digest("hex")
  );
}

/**
 * Trail line for a signal appended to a live case.
 *
 * The old form led with `[${severity}]` and the raw `snake_case` kind. Both
 * mislead: `severity` and `riskScore` on a signal describe the *running case
 * total* after the event, so once a case is capped every later entry reads
 * `[critical] … 100` — reward bookkeeping written at signup looked exactly as
 * severe as the rule that opened the case. Lead with the readable name and the
 * event's own contribution instead, and keep the running total labelled as
 * such.
 */
function signalTrailEntry(signal: AntifraudSignalEvent): string {
  const rawDelta = signal.payload?.scoreDelta;
  const delta =
    typeof rawDelta === "number" && Number.isFinite(rawDelta) ? rawDelta : null;
  const points =
    delta == null
      ? "unscored"
      : delta > 0
        ? `+${delta} pts`
        : `${delta} pts`;
  const total = signal.riskScore != null ? `, case ${signal.riskScore}` : "";
  return `${reviewSignalLabel(signal.kind)} (${points}${total}) — ${signal.summary}`;
}

/**
 * Persist one signal, then decide whether it deserves a case.
 *
 * A signal at or above the notify floor (`high`) opens a review — or, when the
 * account already has a live case, appends to it. The partial unique index on
 * `antifraud_reviews (target_user_id) WHERE status IN ('open','in_review')`
 * is what makes "one live case per account" true even under concurrent
 * deliveries.
 */
async function ingestOne(signal: AntifraudSignalEvent): Promise<IngestResult> {
  return adminDrizzle.transaction(async (tx) => {
  const [stored] = await tx
    .insert(antifraud_signals)
    .values({
      external_id: externalIdForSignal(signal),
      kind: signal.kind,
      severity: signal.severity,
      risk_score: signal.riskScore ?? null,
      target_user_id: signal.userId ?? null,
      target_username: signal.username ?? null,
      summary: signal.summary,
      payload: signal.payload ?? undefined,
      review_id: null,
    })
    .onConflictDoNothing({
      target: antifraud_signals.external_id,
      where: sql`${antifraud_signals.external_id} IS NOT NULL`,
    })
    .returning({ id: antifraud_signals.id });
  if (!stored) return { outcome: "duplicate", lockSkipped: false };

  let lockSkipped = false;
  if (
    signal.payload?.reviewOnly !== true &&
    (
      signal.kind === "fiat_blacklisted_email_domain" ||
      signal.kind === "abstract_email_catchall" ||
      signal.kind === "signup_policy_recommendation" ||
      signal.kind === "risky_free_battle_containment" ||
      signal.kind === "behavioral_withdrawal_containment" ||
      signal.kind === "fiat_eligibility_containment" ||
      signal.kind === "fiat_deposit_identity_containment"
    )
  ) {
    // Containment lock AFTER the dedupe check, inside the transaction:
    //  • a duplicate delivery returned above, so a re-sent signal can never
    //    re-apply containment to an account staff already reviewed;
    //  • a transient lock failure throws, rolling back the stored signal, so
    //    the backend's retry re-attempts store AND lock together.
    // Serialize distinct events for the same account so concurrent matches
    // cannot race containment state.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${"antifraud-containment:" + (signal.userId ?? "")}, 0)
      )
    `);
    lockSkipped = signal.kind === "fiat_blacklisted_email_domain"
      ? (await containBlacklistedEmailDomainAccount(signal)) === "skipped"
      : signal.kind === "abstract_email_catchall"
        ? (await containAbstractCatchallAccount(signal)) === "skipped"
        : signal.kind === "signup_policy_recommendation"
          ? (await containIdentifierBlocklistAccount(signal)) === "skipped"
        : signal.kind === "risky_free_battle_containment"
          ? (await containRiskyFreeBattleAccount(signal)) === "skipped"
        : signal.kind === "fiat_eligibility_containment"
          ? (await containFiatEligibilityAccount(signal)) === "skipped"
        : signal.kind === "fiat_deposit_identity_containment"
          ? (await containFiatIdentityAccount(signal)) === "skipped"
          : (await containBehavioralRiskAccount(signal)) === "skipped";
  }

  // Idempotency: the backend's own event id. A retried delivery hits the
  // partial unique index and is reported as a duplicate rather than
  // double-opening a case.
  const shouldOpenCase =
    Boolean(signal.userId) &&
    shouldOpenReviewForSignal(signal);

  let reviewId: string | null = null;
  let opened = false;

  if (shouldOpenCase && signal.userId) {
    const [live] = await tx
      .select({
        id: antifraud_reviews.id,
        severity: antifraud_reviews.severity,
        risk_score: antifraud_reviews.risk_score,
        signals: antifraud_reviews.signals,
      })
      .from(antifraud_reviews)
      .where(
        and(
          eq(antifraud_reviews.target_user_id, signal.userId),
          inArray(antifraud_reviews.status, ["open", "in_review"]),
        ),
      )
      .limit(1)
      // The merge below is read-modify-write; lock the row so two concurrent
      // deliveries for the same account can't lose a signal-kind append or a
      // severity escalation.
      .for("update");

    if (live) {
      reviewId = live.id;
      // Merge onto the live case: escalate severity/score if this signal is
      // worse, and record the rule key.
      const worseSeverity =
        SEVERITY_RANK[signal.severity] >
        SEVERITY_RANK[
          (live.severity as AntifraudSignalEvent["severity"]) ?? "medium"
        ];
      await tx
        .update(antifraud_reviews)
        .set({
          severity: worseSeverity ? signal.severity : undefined,
          risk_score:
            signal.riskScore != null &&
            (live.risk_score == null || signal.riskScore > live.risk_score)
              ? signal.riskScore
              : undefined,
          signals: live.signals.includes(signal.kind)
            ? undefined
            : [...live.signals, signal.kind],
          updated_at: new Date().toISOString(),
        })
        .where(eq(antifraud_reviews.id, live.id));
      await tx.insert(antifraud_review_notes).values({
          review_id: live.id,
          kind: "signal",
          body: signalTrailEntry(signal),
      });
    } else {
      try {
        const [created] = await tx
          .insert(antifraud_reviews)
          .values({
            target_user_id: signal.userId,
            target_username: signal.username ?? null,
            status: "open",
            severity: signal.severity,
            source: "signal",
            risk_score: signal.riskScore ?? null,
            reason: signal.summary,
            signals: [signal.kind],
            metadata: signal.payload ?? undefined,
          })
          .onConflictDoNothing()
          .returning({ id: antifraud_reviews.id });
        if (created) {
          reviewId = created.id;
          opened = true;
        } else {
          const [winner] = await tx
            .select({ id: antifraud_reviews.id })
            .from(antifraud_reviews)
            .where(
              and(
                eq(antifraud_reviews.target_user_id, signal.userId),
                inArray(antifraud_reviews.status, ["open", "in_review"]),
              ),
            )
            .limit(1);
          if (!winner) throw new Error("Concurrent live case was not found");
          reviewId = winner.id;
        }
      } catch (err) {
        // Lost a race against a concurrent delivery for the same account —
        // the partial unique index did its job. Attach to the winner.
        if ((err as { code?: string })?.code === "23505") {
          const [winner] = await tx
            .select({ id: antifraud_reviews.id })
            .from(antifraud_reviews)
            .where(
              and(
                eq(antifraud_reviews.target_user_id, signal.userId),
                inArray(antifraud_reviews.status, ["open", "in_review"]),
              ),
            )
            .limit(1);
          reviewId = winner?.id ?? null;
        } else {
          throw err;
        }
      }
    }
  }

  if (reviewId) {
    await tx
      .update(antifraud_signals)
      .set({ review_id: reviewId })
      .where(eq(antifraud_signals.id, stored.id));
  }

  return { outcome: opened ? "review_opened" : "stored", lockSkipped };
  });
}

/**
 * Health probe for the backend team — confirms the route is deployed and
 * whether the shared secret is configured, WITHOUT revealing it.
 */
export async function GET(): Promise<Response> {
  return json(
    {
      ok: true,
      configured: Boolean(process.env.ANTIFRAUD_INGEST_SECRET),
      signature: "sha256=HMAC(secret, `${timestamp}.${rawBody}`)",
      headers: ["x-antifraud-timestamp", "x-antifraud-signature"],
    },
    200,
  );
}
