import { NextResponse } from "next/server";

import {
  claimPendingContainmentRows,
  runDeferredContainment,
} from "@/lib/antifraud/containment-outbox";
import { reconcileConfirmedCatchallPromotions } from "@/lib/antifraud/catchall-domain-promotion";

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
    else failed += 1;
  }

  const catchallPromotions =
    await reconcileConfirmedCatchallPromotions(BATCH_LIMIT);

  return NextResponse.json({
    ok: true,
    claimed: claimed.length,
    locked,
    skipped,
    failed,
    catchallPromotions,
  });
}
