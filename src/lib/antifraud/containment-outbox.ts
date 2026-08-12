import "server-only";

import { sql } from "drizzle-orm";

import { adminDrizzle, type AdminDrizzleDb } from "@/lib/admin-db";
import {
  applyAbstractCatchallContainment,
  abstractCatchallContainmentTarget,
} from "@/lib/antifraud/abstract-catchall-containment";
import {
  applyBehavioralWithdrawalContainment,
  behavioralWithdrawalContainmentTarget,
} from "@/lib/antifraud/behavioral-withdrawal-containment";
import {
  applyCriticalSignupContainment,
  criticalSignupContainmentTarget,
} from "@/lib/antifraud/critical-signup-containment";
import {
  applyEmailDomainContainment,
  emailDomainContainmentTarget,
} from "@/lib/antifraud/email-domain-containment";
import {
  applyFiatEligibilityContainment,
  fiatEligibilityContainmentTarget,
} from "@/lib/antifraud/fiat-eligibility-containment";
import {
  applyFiatIdentityContainment,
  fiatIdentityContainmentTarget,
} from "@/lib/antifraud/fiat-identity-containment";
import {
  applyIdentifierBlocklistContainment,
  identifierBlocklistContainmentTarget,
} from "@/lib/antifraud/identifier-blocklist-containment";
import {
  applyRiskyFreeBattleContainment,
  riskyFreeBattleContainmentTarget,
} from "@/lib/antifraud/risky-free-battle-containment";
import {
  applyWhopHistoryAutoBan,
  whopHistoryAutoBanTarget,
} from "@/lib/antifraud/whop-history-auto-ban";

/**
 * Durable outbox for every automatic containment kind whose apply step is
 * external work (MAIN-DB write, and sometimes a backend HTTP call) that must
 * run AFTER the ADMIN ingest transaction in
 * `src/app/api/antifraud/ingest/route.ts` commits, not inside it.
 *
 * Shape: the ingest transaction commits the signal row with
 * `containment_outbox_status = 'pending'` when a signal validates as
 * requiring containment (a pure, DB-free decision — see the `*Target`
 * helpers). Right after that transaction commits, `ingestOne` calls
 * `runDeferredContainment` in the same request. If that throws, the row is
 * durably marked `failed` with the error instead of the outcome being
 * swallowed, and `/api/cron/antifraud-containment-retry` sweeps
 * `pending`/`failed` rows and retries them — reconstructing the target purely
 * from columns already stored on the row (`kind`, `target_user_id`,
 * `risk_score`, `payload`), so no extra state needs to survive a crash beyond
 * what the original `INSERT` already committed.
 */

export const CONTAINMENT_OUTBOX_KINDS = [
  "fiat_eligibility_containment",
  "fiat_deposit_identity_containment",
  "fiat_blacklisted_email_domain",
  "abstract_email_catchall",
  "signup_policy_recommendation",
  "risky_free_battle_containment",
  "behavioral_withdrawal_containment",
  "critical_risk_signup",
  "whop_history_auto_ban",
] as const;

export type ContainmentOutboxKind = (typeof CONTAINMENT_OUTBOX_KINDS)[number];

export function isContainmentOutboxKind(
  kind: string,
): kind is ContainmentOutboxKind {
  return (CONTAINMENT_OUTBOX_KINDS as readonly string[]).includes(kind);
}

const CONTAINMENT_CLAIM_LEASE_MINUTES = 2;

export type DeferredContainmentSignal = {
  kind: ContainmentOutboxKind;
  userId: string | null | undefined;
  riskScore: number | null | undefined;
  payload: Record<string, unknown> | null | undefined;
};

/**
 * Pure admission check, safe to run inside the ADMIN ingest transaction: no
 * MAIN I/O. Returns whether this signal requires the deferred containment
 * outbox at all.
 */
export function requiresContainmentOutbox(
  signal: DeferredContainmentSignal,
): boolean {
  switch (signal.kind) {
    case "fiat_eligibility_containment":
      return fiatEligibilityContainmentTarget(signal) !== null;
    case "fiat_deposit_identity_containment":
      return fiatIdentityContainmentTarget(signal) !== null;
    case "fiat_blacklisted_email_domain":
      return emailDomainContainmentTarget(signal) !== null;
    case "abstract_email_catchall":
      return abstractCatchallContainmentTarget(signal) !== null;
    case "signup_policy_recommendation":
      return identifierBlocklistContainmentTarget(signal) !== null;
    case "risky_free_battle_containment":
      return riskyFreeBattleContainmentTarget(signal) !== null;
    case "behavioral_withdrawal_containment":
      return behavioralWithdrawalContainmentTarget(signal) !== null;
    case "critical_risk_signup":
      return criticalSignupContainmentTarget(signal) !== null;
    case "whop_history_auto_ban":
      return whopHistoryAutoBanTarget(signal) !== null;
  }
}

/**
 * `"deferred"` is NOT a failure: the durable lease is held by another worker
 * that will apply and record this row. It exists because returning `"failed"`
 * for a lost race made the ingest route log a containment failure that never
 * happened and was never recorded — the row is simply still `pending` and
 * owned elsewhere.
 */
export type ContainmentOutboxResult =
  | "locked"
  | "skipped"
  | "failed"
  | "deferred";

/**
 * Mark a just-inserted signal row as owing a containment attempt. Called
 * inside the ADMIN ingest transaction, before commit — pure ADMIN-DB write.
 */
export async function markContainmentPending(
  tx: { execute: AdminDrizzleDb["execute"] },
  signalRowId: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE antifraud_signals
    SET containment_outbox_status = 'pending',
        containment_outbox_next_attempt_at = now(),
        containment_outbox_claimed_until = NULL
    WHERE id = ${signalRowId}::uuid
  `);
}

/**
 * Run the actual external containment for one signal and durably record the
 * outcome. Never throws — a failure is recorded on the row and reported back
 * as `"failed"` rather than swallowed or left to bubble into the request.
 *
 * Bumps `containment_outbox_attempts` itself before attempting, exactly like
 * `claimPendingContainmentRows` does for the cron retry path — this is the
 * FIRST attempt, made inline right after the ingest transaction commits, so
 * it never went through that claim query.
 *
 * Outcome mapping: apply results `"banned"` and `"locked"` both count as
 * applied (`"locked"` for the outbox result). `"skipped"` stays skipped.
 * Throws → `"failed"`. Losing the claim race → `"deferred"`, which is not a
 * failure and must not be reported as one.
 */
export async function runDeferredContainment(
  signal: DeferredContainmentSignal & { signalRowId: string },
  options: {
    attemptAlreadyCounted?: boolean;
  } = {},
): Promise<ContainmentOutboxResult> {
  try {
    if (options.attemptAlreadyCounted !== true) {
      const claimed = await adminDrizzle.execute<{ id: string }>(sql`
        UPDATE antifraud_signals
        SET
          containment_outbox_attempts = LEAST(
            containment_outbox_attempts + 1,
            2147483647
          ),
          containment_outbox_claimed_until =
            now() + make_interval(mins => ${CONTAINMENT_CLAIM_LEASE_MINUTES})
        WHERE id = ${signal.signalRowId}::uuid
          AND (
            containment_outbox_claimed_until IS NULL
            OR containment_outbox_claimed_until <= now()
          )
        RETURNING id::text
      `);
      // A retry worker already owns the durable lease. It will record the
      // outcome; the inline path must not race the same external actions.
      // `"deferred"`, never `"failed"`: nothing failed and nothing was
      // recorded here, so reporting a failure would both misstate the outcome
      // and claim a durable write this branch never made.
      if (claimed.rows.length === 0) return "deferred";
    }
    const outcome = await applyContainmentForKind(signal);
    if (signal.kind === "critical_risk_signup" && outcome !== "locked") {
      throw new Error("Critical signup lock target was not found");
    }
    await recordContainmentOutcome(
      signal.signalRowId,
      outcome === "locked" ? "applied" : "skipped",
      null,
    );
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await recordContainmentOutcome(signal.signalRowId, "failed", message);
    } catch (recordError) {
      // Last-resort floor: if even the durable-failure write fails, this must
      // be loud, not silent — the cron sweep can still pick up the row later
      // because it stayed `pending` from the pre-commit write.
      console.error(
        "[antifraud-containment-outbox] FAILED to persist containment failure state",
        { signalRowId: signal.signalRowId, error: message, recordError },
      );
    }
    return "failed";
  }
}

async function applyContainmentForKind(
  signal: DeferredContainmentSignal & { signalRowId?: string },
): Promise<"locked" | "skipped"> {
  switch (signal.kind) {
    case "fiat_eligibility_containment": {
      const target = fiatEligibilityContainmentTarget(signal);
      if (!target) return "skipped";
      return applyFiatEligibilityContainment(target);
    }
    case "fiat_deposit_identity_containment": {
      const target = fiatIdentityContainmentTarget(signal);
      if (!target) return "skipped";
      const result = await applyFiatIdentityContainment(target);
      return result.locked ? "locked" : "skipped";
    }
    case "fiat_blacklisted_email_domain": {
      const target = emailDomainContainmentTarget(signal);
      if (!target) return "skipped";
      const result = await applyEmailDomainContainment(target);
      // `"banned"` and `"locked"` both count as applied.
      return result === "skipped" ? "skipped" : "locked";
    }
    case "abstract_email_catchall": {
      const target = abstractCatchallContainmentTarget(signal);
      if (!target) return "skipped";
      return applyAbstractCatchallContainment(target, signal.signalRowId);
    }
    case "signup_policy_recommendation": {
      const target = identifierBlocklistContainmentTarget(signal);
      if (!target) return "skipped";
      return applyIdentifierBlocklistContainment(target);
    }
    case "risky_free_battle_containment": {
      const target = riskyFreeBattleContainmentTarget(signal);
      if (!target) return "skipped";
      return applyRiskyFreeBattleContainment(target);
    }
    case "behavioral_withdrawal_containment": {
      const target = behavioralWithdrawalContainmentTarget(signal);
      if (!target) return "skipped";
      return applyBehavioralWithdrawalContainment(target);
    }
    case "critical_risk_signup": {
      const target = criticalSignupContainmentTarget(signal);
      if (!target) return "skipped";
      return applyCriticalSignupContainment(target);
    }
    case "whop_history_auto_ban": {
      const target = whopHistoryAutoBanTarget(signal);
      if (!target) return "skipped";
      const result = await applyWhopHistoryAutoBan(target);
      return result === "banned" ? "locked" : "skipped";
    }
  }
}

async function recordContainmentOutcome(
  signalRowId: string,
  status: "applied" | "skipped" | "failed",
  error: string | null,
): Promise<void> {
  await adminDrizzle.execute(sql`
    UPDATE antifraud_signals
    SET
      containment_outbox_status = ${status},
      containment_outbox_error = ${error ? error.slice(0, 2000) : null},
      containment_outbox_claimed_until = NULL,
      containment_outbox_next_attempt_at = CASE
        WHEN ${status} = 'failed' THEN now() + make_interval(
          secs => LEAST(
            300,
            5 * power(
              2,
              LEAST(GREATEST(containment_outbox_attempts - 1, 0), 6)
            )::integer
          )
        )
        ELSE containment_outbox_next_attempt_at
      END,
      -- Write-once. This column is the DISPLAYED action time ("Automatically
      -- contained at" on the review, "Banned <time>" on Auto Bans). The
      -- five-minute verification watchdog re-runs this same success path, so
      -- stamping now() unconditionally advanced the timestamp on every sweep
      -- and the UI showed the last verification instead of the moment
      -- containment actually happened. containment_last_verified_at below
      -- already carries the per-verification time, so nothing is lost.
      containment_applied_at = CASE
        WHEN ${status} = 'applied' THEN COALESCE(containment_applied_at, now())
        ELSE containment_applied_at
      END,
      containment_last_verified_at = CASE
        WHEN ${status} = 'applied' THEN now()
        ELSE containment_last_verified_at
      END
    WHERE id = ${signalRowId}::uuid
  `);
}

/**
 * Claim applied critical locks that still belong to an active review and have
 * not been independently re-applied/verified in the last five minutes. A
 * staff-approved or otherwise closed review is deliberately excluded so the
 * watchdog never fights an intentional release.
 */
export async function claimCriticalContainmentVerificationRows(
  limit: number,
): Promise<PendingContainmentRow[]> {
  const result = await adminDrizzle.execute<{
    id: string;
    kind: string;
    target_user_id: string | null;
    risk_score: number | null;
    payload: Record<string, unknown> | null;
    containment_outbox_attempts: number;
  }>(sql`
    WITH candidates AS (
      SELECT signal.id
      FROM antifraud_signals AS signal
      JOIN antifraud_reviews AS review ON review.id = signal.review_id
      WHERE signal.kind = 'critical_risk_signup'
        AND signal.containment_outbox_status = 'applied'
        AND review.status IN ('open', 'in_review')
        AND (
          signal.containment_last_verified_at IS NULL
          OR signal.containment_last_verified_at <= now() - interval '5 minutes'
        )
        -- A deliberate staff release is TERMINAL for this watchdog. Excluding
        -- only closed reviews was not enough: staff routinely lift a lock while
        -- the case is still open/in_review, and this sweep then silently
        -- re-applied it within five minutes, with no audit row explaining why
        -- the account re-locked. The watchdog exists to repair SILENT drift, so
        -- it must stand down once an explicit, audited unlock exists for this
        -- account after containment was applied. Re-locking still requires a
        -- fresh signal, exactly as before.
        AND NOT EXISTS (
          SELECT 1
          FROM admin_audit_events AS unlocked
          WHERE unlocked.target_user_id = signal.target_user_id
            AND unlocked.event_type IN (
              'antifraud_withdrawals_unlocked',
              'antifraud_critical_signup_restrictions_unlocked',
              'locked_withdrawals_crypto_enabled',
              'locked_withdrawals_items_enabled'
            )
            AND unlocked.created_at > signal.containment_applied_at
        )
        AND (
          signal.containment_outbox_claimed_until IS NULL
          OR signal.containment_outbox_claimed_until <= now()
        )
      ORDER BY signal.containment_last_verified_at NULLS FIRST, signal.received_at
      LIMIT ${limit}
      FOR UPDATE OF signal SKIP LOCKED
    )
    UPDATE antifraud_signals AS row
    SET
      containment_outbox_claimed_until =
        now() + make_interval(mins => ${CONTAINMENT_CLAIM_LEASE_MINUTES}),
      containment_verification_count = LEAST(
        row.containment_verification_count + 1,
        2147483647
      )
    FROM candidates
    WHERE row.id = candidates.id
    RETURNING
      row.id::text,
      row.kind,
      row.target_user_id,
      row.risk_score,
      row.payload,
      row.containment_outbox_attempts
  `);
  return result.rows.map((row) => ({
    id: row.id,
    kind: "critical_risk_signup",
    targetUserId: row.target_user_id,
    riskScore: row.risk_score,
    payload: row.payload,
    attempts: row.containment_outbox_attempts,
  }));
}

export type PendingContainmentRow = {
  id: string;
  kind: ContainmentOutboxKind;
  targetUserId: string | null;
  riskScore: number | null;
  payload: Record<string, unknown> | null;
  attempts: number;
};

/**
 * Claim a batch of rows still owed a containment attempt: freshly `pending`
 * (the process crashed between commit and the post-commit call) or `failed`.
 * One atomic `UPDATE ... FROM (SELECT ... FOR UPDATE
 * SKIP LOCKED)` claims the rows by bumping their attempt count, so
 * overlapping cron runs cannot double-claim the same row — no surrounding
 * transaction required, and the apply functions themselves are also
 * idempotent (COALESCE on `*_at`/`*_reason`) so an at-least-once retry is safe
 * either way.
 */
export async function claimPendingContainmentRows(
  limit: number,
): Promise<PendingContainmentRow[]> {
  const result = await adminDrizzle.execute<{
    id: string;
    kind: string;
    target_user_id: string | null;
    risk_score: number | null;
    payload: Record<string, unknown> | null;
    containment_outbox_attempts: number;
  }>(sql`
    WITH candidates AS (
      SELECT id
      FROM antifraud_signals
      WHERE containment_outbox_status IN ('pending', 'failed')
        AND containment_outbox_next_attempt_at <= now()
        AND (
          containment_outbox_claimed_until IS NULL
          OR containment_outbox_claimed_until <= now()
        )
        AND kind IN (
          'fiat_eligibility_containment',
          'fiat_deposit_identity_containment',
          'fiat_blacklisted_email_domain',
          'abstract_email_catchall',
          'signup_policy_recommendation',
          'risky_free_battle_containment',
          'behavioral_withdrawal_containment',
          'critical_risk_signup',
          'whop_history_auto_ban'
        )
      ORDER BY
        CASE kind
          WHEN 'critical_risk_signup' THEN 0
          WHEN 'behavioral_withdrawal_containment' THEN 1
          WHEN 'abstract_email_catchall' THEN 2
          ELSE 3
        END,
        containment_outbox_next_attempt_at,
        received_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE antifraud_signals AS row
    SET
      containment_outbox_attempts = LEAST(
        row.containment_outbox_attempts + 1,
        2147483647
      ),
      containment_outbox_claimed_until =
        now() + make_interval(mins => ${CONTAINMENT_CLAIM_LEASE_MINUTES})
    FROM candidates
    WHERE row.id = candidates.id
    RETURNING
      row.id::text,
      row.kind,
      row.target_user_id,
      row.risk_score,
      row.payload,
      row.containment_outbox_attempts
  `);
  return result.rows
    .filter((row) => isContainmentOutboxKind(row.kind))
    .map((row) => ({
      id: row.id,
      kind: row.kind as ContainmentOutboxKind,
      targetUserId: row.target_user_id,
      riskScore: row.risk_score,
      payload: row.payload,
      attempts: row.containment_outbox_attempts,
    }));
}
