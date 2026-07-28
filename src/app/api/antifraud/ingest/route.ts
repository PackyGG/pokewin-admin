import { createHmac, timingSafeEqual } from "node:crypto";

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
  shouldEscalateSignal,
  type AntifraudSignalEvent,
} from "@/lib/antifraud/ws";
import { isPostgresError } from "@/lib/postgres-errors";
import {
  notifyStaff,
  staffBroadcastRecipients,
} from "@/lib/staff/notifications";

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
 * `fiat_blacklisted_email_domain` signal is also an application-authorized
 * containment command: after signature and payload validation it locks crypto
 * and item withdrawals in MAIN before the signal is acknowledged.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Replay window for the signed timestamp. */
const MAX_SKEW_MS = 5 * 60 * 1000;

/** Cap on one delivery so a malformed batch can't fan out unbounded work. */
const MAX_EVENTS_PER_DELIVERY = 50;

/** Body size ceiling — read before parsing. */
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

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
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
  const notify: AntifraudSignalEvent[] = [];

  for (const signal of signals) {
    try {
      if (signal.kind === "fiat_blacklisted_email_domain") {
        await lockBlacklistedEmailDomainAccount(signal);
      }
      const outcome = await ingestOne(signal);
      if (outcome === "duplicate") duplicates += 1;
      else {
        accepted += 1;
        if (outcome === "review_opened") reviewsOpened += 1;
        if (
          shouldEscalateSignal(signal) &&
          signal.kind !== "fiat_blacklisted_email_domain"
        ) {
          notify.push(signal);
        }
      }
    } catch (err) {
      if (isPostgresError(err, "42P01")) {
        return json({ error: "not_provisioned" }, 503);
      }
      console.error("[antifraud-ingest] failed to store signal:", err);
      // 500 so the backend retries this delivery — the external_id unique
      // index makes the retry safe.
      return json({ error: "storage_failed" }, 500);
    }
  }

  if (notify.length > 0) {
    const recipients = await staffBroadcastRecipients();
    for (const signal of notify) {
      await notifyStaff({
        recipients,
        kind: "fraud_alert",
        title: `${signal.severity.toUpperCase()} — ${signal.kind}`,
        body: signal.summary,
        href: "/antifraud/reviews",
        metadata: {
          kind: signal.kind,
          severity: signal.severity,
          riskScore: signal.riskScore,
          userId: signal.userId,
        },
      });
    }
  }

  return json({ ok: true, accepted, duplicates, reviewsOpened }, 200);
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

async function lockBlacklistedEmailDomainAccount(
  signal: AntifraudSignalEvent,
): Promise<void> {
  const userId = signal.userId;
  const domain = blacklistDomainFromSignal(signal);
  if (!userId || !domain || signal.riskScore !== 100) {
    throw new Error("Invalid blacklisted email-domain containment signal");
  }

  const db = getProdPrimaryDrizzleDb();
  const source =
    signal.payload?.matchSource === "signup" ? "signup" : "Whop checkout";
  const patternMatch =
    signal.payload?.emailRiskType === "gmail_dot_fragmentation";
  const reason =
    (patternMatch
      ? `Automatic fraud lock: ${source} used a suspicious dot-fragmented Gmail address (${domain})`
      : `Automatic fraud lock: ${source} used blacklisted email domain ${domain}`)
      .slice(0, 500);
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
    throw new Error("Blacklisted email-domain account no longer exists");
  }
}

type IngestOutcome = "stored" | "review_opened" | "duplicate";

/**
 * Persist one signal, then decide whether it deserves a case.
 *
 * A signal at or above the notify floor (`high`) opens a review — or, when the
 * account already has a live case, appends to it. The partial unique index on
 * `antifraud_reviews (target_user_id) WHERE status IN ('open','in_review')`
 * is what makes "one live case per account" true even under concurrent
 * deliveries.
 */
async function ingestOne(signal: AntifraudSignalEvent): Promise<IngestOutcome> {
  // Idempotency: the backend's own event id. A retried delivery hits the
  // partial unique index and is reported as a duplicate rather than
  // double-opening a case.
  if (signal.id) {
    const [existing] = await adminDrizzle
      .select({ id: antifraud_signals.id })
      .from(antifraud_signals)
      .where(eq(antifraud_signals.external_id, signal.id))
      .limit(1);
    if (existing) return "duplicate";
  }

  const shouldOpenCase =
    Boolean(signal.userId) &&
    shouldEscalateSignal(signal);

  let reviewId: string | null = null;
  let opened = false;

  if (shouldOpenCase && signal.userId) {
    const [live] = await adminDrizzle
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
      .limit(1);

    if (live) {
      reviewId = live.id;
      // Merge onto the live case: escalate severity/score if this signal is
      // worse, and record the rule key.
      const worseSeverity =
        SEVERITY_RANK[signal.severity] >
        SEVERITY_RANK[
          (live.severity as AntifraudSignalEvent["severity"]) ?? "medium"
        ];
      await adminDrizzle
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
      await adminDrizzle.insert(antifraud_review_notes).values({
          review_id: live.id,
          kind: "signal",
          body: `[${signal.severity}] ${signal.kind} — ${signal.summary}`,
      });
    } else {
      try {
        const [created] = await adminDrizzle
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
          .returning({ id: antifraud_reviews.id });
        reviewId = created.id;
        opened = true;
      } catch (err) {
        // Lost a race against a concurrent delivery for the same account —
        // the partial unique index did its job. Attach to the winner.
        if ((err as { code?: string })?.code === "23505") {
          const [winner] = await adminDrizzle
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

  try {
    await adminDrizzle.insert(antifraud_signals).values({
        external_id: signal.id || null,
        kind: signal.kind,
        severity: signal.severity,
        risk_score: signal.riskScore ?? null,
        target_user_id: signal.userId ?? null,
        target_username: signal.username ?? null,
        summary: signal.summary,
        payload: signal.payload ?? undefined,
        review_id: reviewId,
    });
  } catch (err) {
    // The external-id unique index rejected a concurrent duplicate.
    if ((err as { code?: string })?.code === "23505") return "duplicate";
    throw err;
  }

  return opened ? "review_opened" : "stored";
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
