import { sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { verifyTOTPWithStep } from "@/lib/totp";
import { getPasskeyGrace, verifyStepUpToken } from "@/lib/session";
import { isPostgresError } from "@/lib/postgres-errors";
import { canUsePasskeyGrace } from "@/lib/admin-guards";
import { PASSKEY_GRACE_CREDENTIAL } from "@/lib/passkey-grace-shared";

/**
 * Second-factor gate for a privileged admin action. The `credential` is the
 * string the client submitted in the "2FA" field and may be EITHER:
 *   • a 6-digit TOTP code (the authenticator app), or
 *   • a step-up proof token minted after a passkey assertion (see
 *     `passkey-step-up-actions.ts` / `createStepUpToken`).
 *
 * A valid passkey proof clears the gate outright; anything else is verified as
 * a TOTP code. Call sites are unchanged — they still pass a single string —
 * so every existing `require2FA(session.userId, code)` transparently gains
 * passkey support.
 */
export async function require2FA(
  adminUserId: string,
  credential: string | undefined
): Promise<void> {
  if (!credential || credential.trim().length === 0) {
    throw new Error("A 2FA code or passkey is required for this action");
  }

  const value = credential.trim();

  // Only a DB-fresh active admin or owner may reuse the signed passkey window.
  // TOTP codes and ordinary one-use passkey proofs retain their prior behavior.
  if (value === PASSKEY_GRACE_CREDENTIAL) {
    const actor = (await adminDrizzle.execute<{
      role: string;
      roles: string[] | null;
      username: string | null;
      is_owner: boolean | null;
    }>(sql`
      SELECT role::text, roles::text[], username, is_owner
      FROM admin_users
      WHERE id = ${adminUserId}::uuid
        AND is_active = true
      LIMIT 1
    `)).rows[0];
    if (
      !actor ||
      !canUsePasskeyGrace({
        role: actor.role,
        roles: actor.roles,
        username: actor.username,
        isOwner: actor.is_owner,
      })
    ) {
      throw new Error("Passkey reuse is available only to admins and owners.");
    }
    if (!(await getPasskeyGrace(adminUserId))) {
      throw new Error(
        "Passkey verification expired. Approve again with a passkey or code.",
      );
    }
    return;
  }

  // Passkey path: a valid step-up proof for THIS admin satisfies the gate.
  // verifyStepUpToken never throws and returns null for a plain TOTP code, so we
  // can try it first and fall through cleanly.
  const stepUp = await verifyStepUpToken(value, adminUserId);
  if (stepUp) {
    // SECURITY (SECURITY_AUDIT.md L-5): single-use. Consume the proof's nonce so
    // one passkey assertion clears exactly ONE action gate — closing the
    // withdrawal/reward double-submit races for passkey users (the TOTP path is
    // already single-use). The PK on jti makes this atomic: two concurrent
    // requests with one token contend on the row and only one INSERT wins.
    if (stepUp.jti) {
      try {
        await adminDrizzle.execute(sql`
          INSERT INTO admin_stepup_used (jti, admin_user_id)
          VALUES (${stepUp.jti}, ${adminUserId}::uuid)
        `);
        // Best-effort prune of rows past the token TTL — keeps the table bounded
        // without a cron. Never awaited into the gate; failure is irrelevant.
        void adminDrizzle
          .execute(sql`
            DELETE FROM admin_stepup_used
            WHERE used_at < ${new Date(Date.now() - 60 * 60 * 1000)}
          `)
          .catch(() => {});
      } catch (err) {
        if (isPostgresError(err, "23505")) {
          throw new Error(
            "That verification was already used — approve again with a fresh passkey or code.",
          );
        }
        // Replay storage is part of the decision. A valid assertion is not
        // enough when its single-use claim cannot be durably recorded.
        console.error("[require2FA] step-up nonce consume failed (denying)");
        throw new Error(
          "Verification replay protection is unavailable. Try again later.",
        );
      }
    }
    return;
  }

  // TOTP path.
  const adminUser = (await adminDrizzle.execute<{
    totp_secret: string | null;
    totp_enabled: boolean;
  }>(sql`
    SELECT totp_secret, totp_enabled
    FROM admin_users
    WHERE id = ${adminUserId}::uuid
    LIMIT 1
  `)).rows[0];

  if (!adminUser) {
    throw new Error("Admin user not found");
  }

  if (!adminUser.totp_enabled || !adminUser.totp_secret) {
    throw new Error("2FA is not enabled for this admin account");
  }

  const step = verifyTOTPWithStep(adminUser.totp_secret, value);
  if (step === null) {
    throw new Error("Invalid 2FA code");
  }

  // SECURITY (SECURITY_AUDIT.md MEDIUM-5): single-use. Atomically claim this
  // code's step so one code can't authorize a second concurrent/duplicate
  // action. The conditional updateMany matches only when this step hasn't been
  // recorded (NULL, or a different value); under READ COMMITTED Postgres
  // re-checks the predicate on a concurrent update, so two racing requests with
  // ONE code contend on the same row and only one wins — which also closes the
  // double-submit money races. A genuine replay (same code → same step) is
  // rejected. Passkey step-up (handled above) is unaffected.
  try {
    const claimed = await adminDrizzle.execute(sql`
      UPDATE admin_users
      SET totp_last_step = ${BigInt(step)}
      WHERE id = ${adminUserId}::uuid
        AND (totp_last_step IS NULL OR totp_last_step <> ${BigInt(step)})
      RETURNING id
    `);
    if (claimed.rows.length !== 1) {
      throw new Error("That 2FA code was already used — enter a fresh code.");
    }
  } catch (err) {
    // Our own "already used" rejection propagates. Any replay-store outage or
    // missing migration fails closed.
    if (err instanceof Error && err.message.includes("already used")) throw err;
    console.error("[require2FA] TOTP single-use claim failed (denying)");
    throw new Error(
      "Verification replay protection is unavailable. Try again later.",
    );
  }
}
