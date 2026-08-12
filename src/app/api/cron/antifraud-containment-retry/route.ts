import { NextResponse } from "next/server";

import {
  claimCriticalContainmentVerificationRows,
  claimPendingContainmentRows,
  runDeferredContainment,
} from "@/lib/antifraud/containment-outbox";
import { reconcileConfirmedCatchallPromotions } from "@/lib/antifraud/catchall-domain-promotion";
import { enqueueDiscordEvent } from "@/lib/discord-notifications/router";
import {
  applyIdentifierBlockOperation,
  claimPendingIdentifierBlockOperations,
} from "@/lib/antifraud/user-identifier-blocking";

/**
 * Retry sweep for the containment outbox on `antifraud_signals`.
 *
 * `fiat_eligibility_containment` and `fiat_deposit_identity_containment` are
 * the only two signal kinds whose containment applies AFTER the ADMIN ingest
 * transaction commits (see `src/app/api/antifraud/ingest/route.ts` and
 * `@/lib/antifraud/containment-outbox`), because that step is external work —
 * a MAIN-DB write, and for identity, a backend KYC call. That first attempt
 * runs inline in the same request right after commit, so the common case
 * never touches this route. This cron exists for the crash-recovery case:
 * the process died between commit and the post-commit call (row stuck
 * `pending`), or the call threw a transient error (row marked `failed`).
 * Both are durable on the row and safe to retry without a finite attempt
 * ceiling. A two-minute claim lease prevents overlapping cron runs from
 * applying one row concurrently and expires automatically after a crash.
 * Apply functions are idempotent (COALESCE on `*_at`/`*_reason`, and the KYC
 * leg checks `kycRequired` before re-requiring).
 *
 * Auth mirrors `/api/cron/warm`: Vercel sends `Authorization: Bearer
 * $CRON_SECRET` on the scheduled invocation; fail closed in production when
 * the secret is unset instead of leaving a MAIN-write route world-callable.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BATCH_LIMIT = 25;
const CRITICAL_VERIFICATION_LIMIT = 5;
const IDENTIFIER_BLOCK_LIMIT = 10;

async function reportCriticalContainmentFailures(
  failures: Array<{ id: string; targetUserId: string | null }>,
): Promise<void> {
  const guildId = process.env.ADMIN_GUILD_ID?.trim();
  if (!guildId || failures.length === 0) return;
  const hour = new Date().toISOString().slice(0, 13);
  try {
    await enqueueDiscordEvent({
      guildId,
      eventKey: "antifraud.error.general",
      dedupeKey: `critical-containment-watchdog:${hour}`,
      embed: {
        title: "🚨 Critical account lock needs retry",
        description:
          "The containment watchdog could not confirm every required lock. The durable outbox remains active and will keep retrying automatically.",
        color: 0xed4245,
        fields: [
          {
            name: "Affected accounts",
            value: failures
              .slice(0, 10)
              .map((row) => `\`${row.targetUserId ?? "unknown"}\``)
              .join("\n"),
          },
          { name: "Retry policy", value: "Every minute · no attempt limit" },
        ],
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error(
      "[antifraud-containment-watchdog] Discord failure alert enqueue failed",
      error,
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const claimed = await claimPendingContainmentRows(BATCH_LIMIT);

  let locked = 0;
  let skipped = 0;
  let failed = 0;
  const criticalFailures: Array<{
    id: string;
    targetUserId: string | null;
  }> = [];
  for (const row of claimed) {
    const outcome = await runDeferredContainment(
      {
        kind: row.kind,
        userId: row.targetUserId,
        riskScore: row.riskScore,
        payload: row.payload,
        signalRowId: row.id,
      },
      { attemptAlreadyCounted: true },
    );
    if (outcome === "locked") locked += 1;
    else if (outcome === "skipped") skipped += 1;
    else {
      failed += 1;
      if (row.kind === "critical_risk_signup") {
        criticalFailures.push({ id: row.id, targetUserId: row.targetUserId });
      }
    }
  }

  // A successful delivery receipt is not the final authority. While the
  // review remains active, independently re-apply and verify every required
  // critical lock on a five-minute cadence. Any drift becomes a normal failed
  // outbox row and therefore returns to the unlimited retry path above.
  const verificationRows = await claimCriticalContainmentVerificationRows(
    CRITICAL_VERIFICATION_LIMIT,
  );
  let criticalVerified = 0;
  let criticalVerificationFailed = 0;
  for (const row of verificationRows) {
    const outcome = await runDeferredContainment(
      {
        kind: row.kind,
        userId: row.targetUserId,
        riskScore: row.riskScore,
        payload: row.payload,
        signalRowId: row.id,
      },
      { attemptAlreadyCounted: true },
    );
    if (outcome === "locked") criticalVerified += 1;
    else {
      criticalVerificationFailed += 1;
      criticalFailures.push({ id: row.id, targetUserId: row.targetUserId });
    }
  }

  await reportCriticalContainmentFailures(criticalFailures);

  // Account bans never depend on this remote propagation succeeding inline.
  // Every obligation was committed first and is retried without an attempt
  // ceiling until both the IP and fingerprint rules are active.
  const identifierRows = await claimPendingIdentifierBlockOperations(
    IDENTIFIER_BLOCK_LIMIT,
  );
  let identifierBlocksApplied = 0;
  let identifierBlocksPending = 0;
  for (const row of identifierRows) {
    const result = await applyIdentifierBlockOperation(row);
    if (result.deliveryStatus === "applied") identifierBlocksApplied += 1;
    else identifierBlocksPending += 1;
  }

  const catchallPromotions =
    await reconcileConfirmedCatchallPromotions(BATCH_LIMIT);

  return NextResponse.json({
    ok: true,
    claimed: claimed.length,
    locked,
    skipped,
    failed,
    criticalVerificationClaimed: verificationRows.length,
    criticalVerified,
    criticalVerificationFailed,
    identifierBlocksClaimed: identifierRows.length,
    identifierBlocksApplied,
    identifierBlocksPending,
    catchallPromotions,
  });
}
