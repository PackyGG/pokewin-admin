"use server";

import { redirect } from "next/navigation";
import { getDefaultRouteForUser } from "@/lib/dal";
import { headers } from "next/headers";
import { sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
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

  const adminUser = (await adminDrizzle.execute<{
    id: string; email: string; username: string; role: string; totp_enabled: boolean;
  }>(sql`
    SELECT id::text, email, username, role::text AS role, totp_enabled
    FROM admin_users
    WHERE id = ${session.userId}::uuid
    LIMIT 1
  `)).rows[0];
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

  // ── SECURITY (SECURITY_AUDIT.md CRITICAL-1) ────────────────────────────────
  // A pending cookie WITHOUT a setup secret is a VERIFY-flow cookie: it is
  // minted by login() for an ALREADY-ENROLLED admin after only the password
  // check. Such a cookie must never mint a session here — the second factor is
  // proven only in verify-2fa. Without this guard, an enrolled admin's
  // `requires2FA` cookie could be replayed to this action with step=confirm to
  // obtain a full session with no TOTP/passkey. Mirrors the page-render guard.
  if (!pending.totpSecret) {
    return { error: "Please complete two-factor verification to sign in." };
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

    // Explicit projection keeps the returned row minimal and
    // avoids coupling this update to unrelated additive columns.
    await adminDrizzle.execute(sql`
      UPDATE admin_users
      SET totp_secret = ${secret}, totp_enabled = true,
          recovery_codes = ${hashedCodes}, updated_at = NOW()
      WHERE id = ${pending.adminUserId}::uuid
    `);

    return { recoveryCodes };
  }

  // Step 2: User confirmed they saved recovery codes — create session.
  // SECURITY (SECURITY_AUDIT.md CRITICAL-1): only mint the session AFTER step 1
  // actually enrolled the factor. A confirm POST that skips step 1 leaves
  // totp_enabled false → refuse (defense-in-depth on top of the totpSecret
  // guard above). The legit flow enables 2FA in step 1, so this always passes
  // for a real setup; an attacker replaying step=confirm without verifying a
  // code is stopped here.
  const enrolled = (await adminDrizzle.execute<{ totp_enabled: boolean }>(sql`
    SELECT totp_enabled FROM admin_users
    WHERE id = ${pending.adminUserId}::uuid
    LIMIT 1
  `)).rows[0];
  if (!enrolled?.totp_enabled) {
    return { error: "Finish two-factor setup before continuing." };
  }

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
    adminDrizzle.execute(sql`
      INSERT INTO admin_sessions (
        admin_user_id, ip, user_agent, auth_method, expires_at
      ) VALUES (
        ${pending.adminUserId}::uuid, ${ip}, ${userAgent}, 'totp',
        ${new Date(Date.now() + 8 * MS_PER_HOUR)}
      )
    `),
  ]);

  await deletePendingSession();

  redirect(await getDefaultRouteForUser(pending.adminUserId, pending.role));
}
