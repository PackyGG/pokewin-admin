import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import {
  antifraud_review_notes,
  antifraud_reviews,
  antifraud_signals,
} from "@/lib/db-schema/admin/schema";
import { adminDrizzle } from "@/lib/drizzle";
import {
  parseAntifraudEvent,
  SEVERITY_RANK,
  shouldOpenReviewForSignal,
  type AntifraudSignalEvent,
} from "@/lib/antifraud/ws";
import {
  isUsefulReviewSignalTrailEntry,
  reviewSignalLabel,
} from "@/lib/antifraud/signal-display";
import {
  isContainmentOutboxKind,
  markContainmentPending,
  requiresContainmentOutbox,
  runDeferredContainment,
  type ContainmentOutboxKind,
} from "@/lib/antifraud/containment-outbox";
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
 * Normally writes only the ADMIN DB. The eight containment kinds
 * (`fiat_blacklisted_email_domain`, `abstract_email_catchall`,
 * `signup_policy_recommendation`, `risky_free_battle_containment`,
 * `behavioral_withdrawal_containment`, `critical_risk_signup`,
 * `fiat_eligibility_containment`, `fiat_deposit_identity_containment`) are
 * application-authorized containment commands: after signature and payload
 * validation, a first-time (non-duplicate) delivery validates admission
 * inside the ADMIN transaction (pure, no MAIN I/O), marks the signal row
 * `pending` on the containment outbox, and runs MAIN / backend apply work
 * strictly AFTER that transaction commits via `runDeferredContainment`
 * (`@/lib/antifraud/containment-outbox`). Active blocked domains and
 * Abstract-confirmed catch-all domains ban; suspicious clusters and
 * free-battle hard signals lock withdrawals only; a refused Fiat checkout
 * turns Fiat deposits off and locks withdrawals; a critical signup also
 * locks tips. Crashes between commit and apply are retried by
 * `/api/cron/antifraud-containment-retry`.
 *
 * Automated signals never mutate KYC state. Identity findings open Account
 * Review so staff can require KYC when the complete evidence warrants it.
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

/**
 * All eight containment kinds do EXTERNAL work (MAIN-DB write, and sometimes
 * a backend HTTP call). That work must not run inside the open ADMIN ingest
 * transaction below — an external stall would hold ADMIN row locks for
 * however long MAIN or the backend take to respond. Pure admission checks
 * (`*ContainmentTarget`) and MAIN apply helpers live under
 * `@/lib/antifraud/*-containment`; `@/lib/antifraud/containment-outbox` ties
 * them into the ADMIN-only-inside-tx / external-only-after-commit split, with
 * a durable `pending` -> `applied`/`skipped`/`failed` outbox on the signal
 * row so a crash or transient failure between commit and the external call is
 * retried by `/api/cron/antifraud-containment-retry`, not lost.
 */

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
  // Set inside the transaction below when this signal is one of the eight
  // containment kinds whose apply step is external (MAIN-DB write, plus a
  // backend call for identity KYC / critical-signup tips) and validates as
  // requiring containment. `runDeferredContainment` — the actual MAIN /
  // backend work — only runs AFTER the transaction returns/commits, never
  // inside it. See the comment above `IngestResult` for why.
  let deferredContainmentKind: ContainmentOutboxKind | null = null;
  let storedSignalId: string | null = null;

  const result = await adminDrizzle.transaction(async (tx): Promise<IngestResult> => {
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
  storedSignalId = stored.id;

  let lockSkipped = false;
  if (
    signal.payload?.reviewOnly !== true &&
    isContainmentOutboxKind(signal.kind)
  ) {
    // Containment intent AFTER the dedupe check, inside the transaction:
    //  • a duplicate delivery returned above, so a re-sent signal can never
    //    re-apply containment to an account staff already reviewed;
    //  • all eight kinds only VALIDATE here (pure, no MAIN I/O) and mark
    //    the row `pending`; the actual MAIN / backend work happens after
    //    this transaction commits, via `runDeferredContainment` below.
    // Serialize distinct events for the same account so concurrent matches
    // cannot race containment state.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${"antifraud-containment:" + (signal.userId ?? "")}, 0)
      )
    `);
    const kind = signal.kind;
    if (
      requiresContainmentOutbox({
        kind,
        userId: signal.userId,
        riskScore: signal.riskScore,
        payload: signal.payload,
      })
    ) {
      deferredContainmentKind = kind;
      await markContainmentPending(tx, stored.id);
      // Provisional: `lockSkipped` is finalized after the deferred
      // containment attempt runs post-commit, below.
    } else {
      console.error(
        `[antifraud-ingest] skipping invalid ${signal.kind} containment signal`,
        { externalId: signal.id || null, userId: signal.userId ?? null },
      );
      lockSkipped = true;
    }
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
      const trailEntry = signalTrailEntry(signal);
      if (isUsefulReviewSignalTrailEntry(trailEntry)) {
        await tx.insert(antifraud_review_notes).values({
          review_id: live.id,
          kind: "signal",
          body: trailEntry,
        });
      }
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

  // The ADMIN transaction has committed. Only now — never while its row
  // locks were held — does the external containment work run: a MAIN-DB
  // write, and for identity, a backend KYC call on top. A crash or a thrown
  // transient error here is durably recorded on the signal row
  // (`runDeferredContainment` never throws) and retried by
  // `/api/cron/antifraud-containment-retry`, not lost.
  if (result.outcome !== "duplicate" && deferredContainmentKind && storedSignalId) {
    const outcome = await runDeferredContainment({
      kind: deferredContainmentKind,
      userId: signal.userId,
      riskScore: signal.riskScore,
      payload: signal.payload,
      signalRowId: storedSignalId,
    });
    if (outcome === "skipped") {
      console.error(
        `[antifraud-ingest] ${deferredContainmentKind} account no longer exists, skipping containment lock`,
        { externalId: signal.id || null, userId: signal.userId ?? null },
      );
    } else if (outcome === "failed") {
      console.error(
        `[antifraud-ingest] ${deferredContainmentKind} containment failed post-commit; recorded for retry`,
        { externalId: signal.id || null, userId: signal.userId ?? null },
      );
    }
    result.lockSkipped = outcome !== "locked";
  }

  return result;
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
