"use server";

import { redirect } from "next/navigation";
import { getDefaultRouteForUser } from "@/lib/dal";
import { headers } from "next/headers";
import { adminDb } from "@/lib/admin-db";
import {
  getSession,
  getPendingSession,
  deletePendingSession,
  createPendingSession,
  createSession,
} from "@/lib/session";
import {
  verifyTOTP,
  generateSecret,
  generateRecoveryCodes,
  hashRecoveryCodes,
} from "@/lib/totp";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { MS_PER_HOUR } from "@/lib/utils/time";

export type SetupState = {
  error?: string;
  recoveryCodes?: string[];
};

/**
 * Phase D mandatory-2FA bridge. When `verifySession` redirects an
 * authenticated-but-NOT-enrolled admin to /setup-2fa, they arrive with a real
 * `admin_session` cookie but NO pending-2FA cookie — so the setup page can't
 * render the QR (the secret normally lives in the pending cookie minted at
 * login). This Server Action mints that pending cookie from the live session
 * (cookie writes are allowed in a Server Action, unlike a Server Component
 * render) with a FRESH secret, then redirects back to /setup-2fa so the QR
 * renders. The setup-form's confirm step then enables 2FA + drops them into a
 * real session as usual.
 *
 * Safe-by-construction: it only mints a pending cookie when the user is truly
 * non-enrolled (`totp_enabled === false`). An already-enrolled user is sent to
 * their dashboard instead (no setup needed). A request with no live session is
 * sent to /login. The secret is server-generated and lives ONLY in the signed
 * pending cookie — never trusted from the client.
 */
export async function bootstrapSetupFromSession(): Promise<void> {
  const session = await getSession();
  if (!session) redirect("/login");

  const adminUser = await adminDb.admin_users.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, username: true, role: true, totp_enabled: true },
  });
  // No row / inactive-handled-elsewhere: fall back to login rather than minting.
  if (!adminUser) redirect("/login");

  // Already enrolled → nothing to set up. Send them to their normal landing
  // route (this is also the guard against an enrolled admin who manually hits
  // /setup-2fa via the middleware exception).
  if (adminUser.totp_enabled) {
    redirect(await getDefaultRouteForUser(adminUser.id, adminUser.role));
  }

  // Non-enrolled: mint a fresh pending-2FA session and bounce back to the setup
  // page, which will now find the pending cookie and render the QR.
  await createPendingSession({
    adminUserId: adminUser.id,
    email: adminUser.email,
    username: adminUser.username,
    role: adminUser.role,
    totpSecret: generateSecret(),
  });
  redirect("/setup-2fa");
}

export async function confirmSetup(
  _prevState: SetupState,
  formData: FormData
): Promise<SetupState> {
  const step = formData.get("step") as string;

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

    // Secret is carried inside the signed pending-session cookie — NOT
    // trusted from the client form body. A client-supplied secret would
    // let an attacker submit one they already knew and bypass 2FA.
    if (!pending.totpSecret) {
      return { error: "Setup session error. Please login again." };
    }
    const secret = pending.totpSecret;

    const isValid = verifyTOTP(secret, code);
    if (!isValid) {
      return { error: "Invalid code. Please try again." };
    }

    // Generate recovery codes and save everything
    const recoveryCodes = generateRecoveryCodes(8);
    const hashedCodes = await hashRecoveryCodes(recoveryCodes);

    // Explicit select — without it, Prisma emits RETURNING * which
    // references every column the generated client knows about
    // (preferences, role_id, display_username, profile_image*). If
    // any of those hasn't been applied to the prod DB yet, the
    // otherwise-valid update throws P2022 and the client sees the
    // generic "Application error: a client-side exception" page
    // exactly when a new admin enters their first TOTP code.
    await adminDb.admin_users.update({
      where: { id: pending.adminUserId },
      data: {
        totp_secret: secret,
        totp_enabled: true,
        recovery_codes: hashedCodes,
      },
      select: { id: true },
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
        expires_at: new Date(Date.now() + 8 * MS_PER_HOUR),
      },
    }),
  ]);

  await deletePendingSession();

  redirect(await getDefaultRouteForUser(pending.adminUserId, pending.role));
}
