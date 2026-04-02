"use server";

import { redirect } from "next/navigation";
import { getDefaultRouteForUser } from "@/lib/dal";
import { headers } from "next/headers";
import { adminDb } from "@/lib/admin-db";
import {
  getPendingSession,
  deletePendingSession,
  createSession,
} from "@/lib/session";
import { verifyTOTP, generateRecoveryCodes, hashRecoveryCodes } from "@/lib/totp";
import { createAdminAuditEvent } from "@/lib/admin-audit";

export type SetupState = {
  error?: string;
  recoveryCodes?: string[];
};

export async function confirmSetup(
  _prevState: SetupState,
  formData: FormData
): Promise<SetupState> {
  const step = formData.get("step") as string;
  const secret = formData.get("secret") as string;

  const pending = await getPendingSession();
  if (!pending) {
    return { error: "Session expired. Please login again." };
  }

  // Step 1: Verify TOTP code, show recovery codes
  if (step !== "confirm") {
    const code = formData.get("code") as string;
    if (!code || code.length !== 6) {
      return { error: "Please enter a valid 6-digit code." };
    }

    if (!secret) {
      return { error: "Setup session error. Please login again." };
    }

    const isValid = verifyTOTP(secret, code);
    if (!isValid) {
      return { error: "Invalid code. Please try again." };
    }

    // Generate recovery codes and save everything
    const recoveryCodes = generateRecoveryCodes(8);
    const hashedCodes = await hashRecoveryCodes(recoveryCodes);

    await adminDb.admin_users.update({
      where: { id: pending.adminUserId },
      data: {
        totp_secret: secret,
        totp_enabled: true,
        recovery_codes: hashedCodes,
      },
    });

    return { recoveryCodes };
  }

  // Step 2: User confirmed they saved recovery codes — create session
  await createSession({
    userId: pending.adminUserId,
    role: pending.role,
    email: pending.email,
    username: pending.username,
  });

  const headersList = await headers();
  const ip = headersList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = headersList.get("user-agent") ?? null;

  await Promise.all([
    createAdminAuditEvent({
      adminUserId: pending.adminUserId,
      eventType: "admin_login",
      ip,
      metadata: { method: "totp_setup" },
    }),
    adminDb.admin_sessions.create({
      data: {
        admin_user_id: pending.adminUserId,
        ip,
        user_agent: userAgent,
        auth_method: "totp",
        expires_at: new Date(Date.now() + 8 * 60 * 60 * 1000),
      },
    }),
  ]);

  await deletePendingSession();

  redirect(await getDefaultRouteForUser(pending.adminUserId, pending.role));
}
