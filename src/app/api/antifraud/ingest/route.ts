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
 * containment command: after signature and payload validation, a first-time
 * (non-duplicate) delivery locks crypto and item withdrawals in MAIN before
 * the signal is acknowledged. Re-sent duplicates deliberately do NOT re-lock —
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
  let recipients: string[] | null = null;

  for (const signal of signals) {
    let result: IngestResult;
    try {
      result = await ingestOne(signal);
    } catch (err) {
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
      continue;
    }
    accepted += 1;
    if (result.outcome === "review_opened") reviewsOpened += 1;
    if (result.lockSkipped) locksSkipped += 1;

    if (
      shouldEscalateSignal(signal) &&
      signal.kind !== "fiat_blacklisted_email_domain"
    ) {
      // Notify IMMEDIATELY after the durable store, not after the whole
      // batch: if a later signal 500s the delivery, the retry dedupes this
      // one to 'duplicate' and it would never notify again. Notification
      // failure itself is logged, not thrown — turning it into a 500 would
      // create exactly that dedupe-and-lose-the-ping path.
      try {
        recipients ??= await staffBroadcastRecipients();
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
      } catch (err) {
        console.error("[antifraud-ingest] failed to notify staff:", err);
      }
    }
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
 * Apply the MAIN-DB containment lock for one `fiat_blacklisted_email_domain`
 * signal.
 *
 * Returns `"skipped"` for PERMANENT conditions (malformed containment fields,
 * account deleted since the signal was produced) instead of throwing: a throw
 * here becomes a 500 `storage_failed`, and the backend would retry the same
 * poison-pill delivery forever, blocking every other signal batched with it.
 * Only genuinely transient errors (DB down, etc.) are allowed to propagate
 * into the 500-retry path.
 */
async function lockBlacklistedEmailDomainAccount(
  signal: AntifraudSignalEvent,
): Promise<"locked" | "skipped"> {
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
  const reason =
    (clusterMatch
      ? `Automatic fraud lock: ${source} belonged to a suspicious coordinated deposit cluster (${domain})`
      : patternMatch
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
    console.error(
      "[antifraud-ingest] blacklisted email-domain account no longer exists, skipping containment lock",
      { externalId: signal.id || null, userId },
    );
    return "skipped";
  }
  return "locked";
}

type IngestResult = {
  outcome: "stored" | "review_opened" | "duplicate";
  /** A containment lock was permanently un-appliable and acked instead of retried. */
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
  if (signal.kind === "fiat_blacklisted_email_domain") {
    // Containment lock AFTER the dedupe check, inside the transaction:
    //  • a duplicate delivery returned above, so a re-sent signal can never
    //    re-lock an account staff already reviewed and unlocked;
    //  • a transient lock failure throws, rolling back the stored signal, so
    //    the backend's retry re-attempts store AND lock together.
    lockSkipped = (await lockBlacklistedEmailDomainAccount(signal)) === "skipped";
  }

  // Idempotency: the backend's own event id. A retried delivery hits the
  // partial unique index and is reported as a duplicate rather than
  // double-opening a case.
  const shouldOpenCase =
    Boolean(signal.userId) &&
    shouldEscalateSignal(signal);

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
          body: `[${signal.severity}] ${signal.kind} — ${signal.summary}`,
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
