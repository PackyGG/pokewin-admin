import { adminDb } from "@/lib/admin-db";
import { verifyTOTP } from "@/lib/totp";
import { verifyStepUpToken } from "@/lib/session";

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

  // Passkey path: a valid step-up proof for THIS admin satisfies the gate.
  // verifyStepUpToken never throws and returns false for a plain TOTP code,
  // so we can try it first and fall through cleanly.
  if (await verifyStepUpToken(value, adminUserId)) {
    return;
  }

  // TOTP path.
  const adminUser = await adminDb.admin_users.findUnique({
    where: { id: adminUserId },
    select: { totp_secret: true, totp_enabled: true },
  });

  if (!adminUser) {
    throw new Error("Admin user not found");
  }

  if (!adminUser.totp_enabled || !adminUser.totp_secret) {
    throw new Error("2FA is not enabled for this admin account");
  }

  const isValid = verifyTOTP(adminUser.totp_secret, value);
  if (!isValid) {
    throw new Error("Invalid 2FA code");
  }
}
