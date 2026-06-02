"use server";

import { redirect } from "next/navigation";
import { getDefaultRouteForUser } from "@/lib/dal";
import { getEffectiveRoles, pickPrimaryRole } from "@/lib/admin-roles";
import { adminDb } from "@/lib/admin-db";
import {
  getPendingSession,
  deletePendingSession,
  createSession,
} from "@/lib/session";
import { verifyTOTP, verifyRecoveryCode } from "@/lib/totp";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { headers } from "next/headers";
import { MS_PER_MINUTE, MS_PER_HOUR } from "@/lib/utils/time";

type VerifyState = {
  error?: string;
};

// Per-admin-user failure counter. Same in-memory caveat as the login
// rate limiter in src/app/(auth)/login/actions.ts: this resets on every
// server restart and doesn't cross instances. Good enough to slow down a
// casual brute-force of a 6-digit TOTP against a single pending session;
// move to a persistent store when the rate-limit infra (see flagged #6)
// is in place.
const MAX_FAILED_VERIFIES = 5;
const VERIFY_WINDOW_MS = 5 * MS_PER_MINUTE;
const verifyFailures = new Map<
  string,
  { count: number; resetAt: number }
>();

function recordVerifyFailure(adminUserId: string): void {
  const now = Date.now();
  const entry = verifyFailures.get(adminUserId);
  if (!entry || now > entry.resetAt) {
    verifyFailures.set(adminUserId, { count: 1, resetAt: now + VERIFY_WINDOW_MS });
    return;
  }
  entry.count++;
}

function isVerifyRateLimited(adminUserId: string): boolean {
  const entry = verifyFailures.get(adminUserId);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    verifyFailures.delete(adminUserId);
    return false;
  }
  return entry.count >= MAX_FAILED_VERIFIES;
}

function clearVerifyFailures(adminUserId: string): void {
  verifyFailures.delete(adminUserId);
}

export async function verify2FA(
  _prevState: VerifyState,
  formData: FormData
): Promise<VerifyState> {
  const mode = formData.get("mode") as string;
  const pending = await getPendingSession();
  if (!pending) {
    return { error: "Session expired. Please login again." };
  }

  if (isVerifyRateLimited(pending.adminUserId)) {
    return {
      error:
        "Too many failed verification attempts. Try again in a few minutes.",
    };
  }

  // Explicit select — same reason as login/actions.ts: a missing column
  // (e.g. `preferences` added in a later migration that prod hasn't run yet)
  // would otherwise throw P2022 and crash the 2FA verify page.
  const adminUser = await adminDb.admin_users.findUnique({
    where: { id: pending.adminUserId },
    select: {
      id: true,
      role: true,
      roles: true,
      totp_secret: true,
      recovery_codes: true,
    },
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
      recordVerifyFailure(pending.adminUserId);
      return { error: "Invalid recovery code." };
    }

    // Remove used recovery code
    const updatedCodes = [...adminUser.recovery_codes];
    updatedCodes.splice(index, 1);
    await adminDb.admin_users.update({
      where: { id: adminUser.id },
      data: { recovery_codes: updatedCodes },
      select: { id: true },
    });
  } else {
    const code = formData.get("code") as string;
    if (!code || code.length !== 6) {
      return { error: "Please enter a valid 6-digit code." };
    }

    const isValid = verifyTOTP(adminUser.totp_secret, code);
    if (!isValid) {
      recordVerifyFailure(pending.adminUserId);
      return { error: "Invalid code. Please try again." };
    }
  }

  // Successful verification — clear the failure counter so the user isn't
  // held back by old failed attempts on subsequent logins.
  clearVerifyFailures(pending.adminUserId);

  // Create real session. Carry the full effective role set from the DB
  // (the pending cookie only held the login-time primary role) so the
  // multi-role hint is correct from the first request; verifySession
  // re-reads it anyway.
  const effectiveRoles = getEffectiveRoles(adminUser.role, adminUser.roles);
  await createSession({
    userId: pending.adminUserId,
    role: pickPrimaryRole(effectiveRoles),
    roles: effectiveRoles,
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
        expires_at: new Date(Date.now() + 8 * MS_PER_HOUR),
      },
    }),
  ]);

  await deletePendingSession();

  redirect(await getDefaultRouteForUser(pending.adminUserId, pending.role));
}
