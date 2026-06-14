"use server";

import bcrypt from "bcryptjs";
import { z } from "zod";
import { adminDb } from "@/lib/admin-db";
import { verifySession } from "@/lib/dal";
import { require2FA } from "@/lib/require-2fa";
import { createAdminAuditEvent } from "@/lib/admin-audit";

// Matches createAdminUser (src/app/(admin)/admin-users/actions.ts) — bcrypt
// cost factor 12 for every admin password hash.
const BCRYPT_COST = 12;

// Self-service password change for the *currently logged-in* admin only.
// The schema never carries a target user id — the action acts on
// `session.userId` exclusively, so no admin can change another admin's
// password through this path. New password must be at least 10 chars and
// differ from the current one; the 2FA code is a 6-digit TOTP string and is
// required (verified before any write — fail closed).
const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z
      .string()
      .min(10, "New password must be at least 10 characters"),
    confirmPassword: z.string().min(1, "Please confirm your new password"),
    twoFactorCode: z
      .string()
      .trim()
      .regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app"),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: "New password and confirmation do not match",
    path: ["confirmPassword"],
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    message: "New password must be different from your current password",
    path: ["newPassword"],
  });

/**
 * Change the acting admin's own password.
 *
 * Security model (every item is load-bearing):
 *  - Acts on `session.userId` ONLY — the client cannot target another user.
 *  - Verifies the supplied current password via bcrypt before anything else.
 *  - Requires a valid TOTP 2FA code (reuses the shared `require2FA` step-up
 *    helper) — the write is gated on it and fails closed for accounts
 *    without 2FA enrolled.
 *  - Writes only `password_hash` (ADMIN-DB runtime app write — allowed).
 *  - Emits an audit event. No password (old/new/hash) or 2FA code is ever
 *    placed in metadata, logs, or the response.
 *
 * On any failure throws an Error with a safe, generic message; the client
 * catches and toasts it. Returns nothing on success.
 */
export async function changeOwnPassword(input: {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  twoFactorCode: string;
}): Promise<void> {
  const session = await verifySession();

  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const { currentPassword, newPassword, twoFactorCode } = parsed.data;

  const admin = await adminDb.admin_users.findUnique({
    where: { id: session.userId },
    select: { password_hash: true, totp_enabled: true, totp_secret: true },
  });
  if (!admin) {
    // verifySession already proved the row exists; treat as auth failure.
    throw new Error("Account not found");
  }

  // Verify the current password. Generic message on mismatch so we don't
  // reveal which field was wrong.
  const currentOk = await bcrypt.compare(currentPassword, admin.password_hash);
  if (!currentOk) {
    throw new Error("Current password is incorrect");
  }

  // Mandatory 2FA step-up. `require2FA` throws if the code is missing,
  // invalid, or the account has no TOTP enrolled — so this fails closed
  // (no password change without a valid code).
  await require2FA(session.userId, twoFactorCode);

  const newHash = await bcrypt.hash(newPassword, BCRYPT_COST);

  await adminDb.admin_users.update({
    where: { id: session.userId },
    data: { password_hash: newHash },
    select: { id: true },
  });

  // Audit trail — never include any password material or the 2FA code.
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_password_changed",
  });
}
