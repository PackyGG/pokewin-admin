"use server";

import { redirect } from "next/navigation";
import { getDefaultRouteForUser } from "@/lib/dal";
import { adminDb } from "@/lib/admin-db";
import {
  getPendingSession,
  deletePendingSession,
  createSession,
} from "@/lib/session";
import { verifyTOTP, verifyRecoveryCode } from "@/lib/totp";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { headers } from "next/headers";

type VerifyState = {
  error?: string;
};

export async function verify2FA(
  _prevState: VerifyState,
  formData: FormData
): Promise<VerifyState> {
  const mode = formData.get("mode") as string;
  const pending = await getPendingSession();
  if (!pending) {
    return { error: "Session expired. Please login again." };
  }

  const adminUser = await adminDb.admin_users.findUnique({
    where: { id: pending.adminUserId },
  });
  if (!adminUser || !adminUser.totp_secret) {
    return { error: "Account error. Please contact an administrator." };
  }

  if (mode === "recovery") {
    const recoveryCode = (formData.get("recoveryCode") as string)?.trim().toUpperCase();
    if (!recoveryCode) {
      return { error: "Please enter a recovery code." };
    }

    const index = await verifyRecoveryCode(recoveryCode, adminUser.recovery_codes);
    if (index === -1) {
      return { error: "Invalid recovery code." };
    }

    // Remove used recovery code
    const updatedCodes = [...adminUser.recovery_codes];
    updatedCodes.splice(index, 1);
    await adminDb.admin_users.update({
      where: { id: adminUser.id },
      data: { recovery_codes: updatedCodes },
    });
  } else {
    const code = formData.get("code") as string;
    if (!code || code.length !== 6) {
      return { error: "Please enter a valid 6-digit code." };
    }

    const isValid = verifyTOTP(adminUser.totp_secret, code);
    if (!isValid) {
      return { error: "Invalid code. Please try again." };
    }
  }

  // Create real session
  await createSession({
    userId: pending.adminUserId,
    role: pending.role,
    email: pending.email,
    username: pending.username,
  });

  // Write login audit event
  const headersList = await headers();
  const ip = headersList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  const userAgent = headersList.get("user-agent") ?? null;

  await Promise.all([
    createAdminAuditEvent({
      adminUserId: pending.adminUserId,
      eventType: "admin_login",
      ip,
      metadata: { method: mode === "recovery" ? "recovery_code" : "totp" },
    }),
    adminDb.admin_sessions.create({
      data: {
        admin_user_id: pending.adminUserId,
        ip,
        user_agent: userAgent,
        auth_method: mode === "recovery" ? "recovery_code" : "totp",
        expires_at: new Date(Date.now() + 8 * 60 * 60 * 1000),
      },
    }),
  ]);

  await deletePendingSession();

  redirect(await getDefaultRouteForUser(pending.adminUserId, pending.role));
}
