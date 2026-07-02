"use server";

import { redirect } from "next/navigation";
import { getDefaultRouteForUser } from "@/lib/dal";
import { getEffectiveRoles, pickPrimaryRole } from "@/lib/admin-roles";
import { readAdminUserWithRoles } from "@/lib/admin-user-roles";
import { adminDb } from "@/lib/admin-db";
import {
  getPendingSession,
  deletePendingSession,
  createSession,
  createWebauthnChallenge,
  getWebauthnChallenge,
  deleteWebauthnChallenge,
} from "@/lib/session";
import { verifyTOTP, verifyRecoveryCode } from "@/lib/totp";
import { buildAuthenticationOptions, checkAuthentication } from "@/lib/webauthn";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { headers } from "next/headers";
import { MS_PER_MINUTE, MS_PER_HOUR } from "@/lib/utils/time";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";

type VerifyState = {
  error?: string;
  redirectTo?: string;
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
  // would otherwise throw P2022 and crash the 2FA verify page. The additive
  // `roles` column is read resiliently: if its migration hasn't run, the
  // read degrades to `roles: []` (→ effective `[role]`).
  const adminUser = await readAdminUserWithRoles(
    () =>
      adminDb.admin_users.findUnique({
        where: { id: pending.adminUserId },
        select: {
          id: true,
          role: true,
          roles: true,
          totp_secret: true,
          recovery_codes: true,
        },
      }),
    () =>
      adminDb.admin_users.findUnique({
        where: { id: pending.adminUserId },
        select: {
          id: true,
          role: true,
          totp_secret: true,
          recovery_codes: true,
        },
      }),
  );
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

// ── Passkey (WebAuthn) — alternative second factor ──────────────────────────
//
// A passkey clears the SAME 2FA step a TOTP code does: it only runs AFTER a
// valid password produced a pending-2FA session (the same precondition the
// TOTP/recovery paths require). On success it mints the IDENTICAL session via
// the shared finalizer below — same audit event + admin_sessions row (with
// auth_method "passkey") + landing redirect. Password and TOTP enrollment are
// untouched; this is purely an additional way to satisfy the existing gate.

/** Build assertion options scoped to the pending user's registered passkeys. */
export async function startPasskeyLogin(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const pending = await getPendingSession();
  if (!pending) {
    throw new Error("Session expired. Please login again.");
  }
  const creds = await adminDb.admin_passkeys.findMany({
    where: { admin_user_id: pending.adminUserId },
    select: { credential_id: true, transports: true },
  });
  if (creds.length === 0) {
    throw new Error("No passkeys are registered for this account.");
  }
  const options = await buildAuthenticationOptions({
    allowCredentials: creds.map((c) => ({
      credentialId: c.credential_id,
      transports: c.transports,
    })),
  });
  await createWebauthnChallenge({
    challenge: options.challenge,
    type: "auth",
    adminUserId: pending.adminUserId,
  });
  return options;
}

export async function verifyPasskeyLogin(
  response: AuthenticationResponseJSON,
): Promise<VerifyState> {
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

  const challenge = await getWebauthnChallenge();
  if (
    !challenge ||
    challenge.type !== "auth" ||
    challenge.adminUserId !== pending.adminUserId
  ) {
    return { error: "Passkey session expired. Please try again." };
  }

  // Resolve the exact credential the authenticator asserted with, and make sure
  // it actually belongs to the account that passed the password step.
  const stored = await adminDb.admin_passkeys.findUnique({
    where: { credential_id: response.id },
    select: {
      id: true,
      admin_user_id: true,
      credential_id: true,
      public_key: true,
      counter: true,
      transports: true,
    },
  });
  if (!stored || stored.admin_user_id !== pending.adminUserId) {
    recordVerifyFailure(pending.adminUserId);
    await deleteWebauthnChallenge();
    return { error: "Unrecognized passkey." };
  }

  let verified = false;
  let newCounter = Number(stored.counter);
  try {
    const result = await checkAuthentication({
      response,
      expectedChallenge: challenge.challenge,
      credential: {
        credentialId: stored.credential_id,
        publicKey: new Uint8Array(stored.public_key),
        counter: Number(stored.counter),
        transports: stored.transports,
      },
    });
    verified = result.verified;
    newCounter = result.authenticationInfo.newCounter;
  } catch {
    verified = false;
  } finally {
    // One-time challenge — burn it whatever the outcome.
    await deleteWebauthnChallenge();
  }

  if (!verified) {
    recordVerifyFailure(pending.adminUserId);
    return { error: "Could not verify passkey. Please try again." };
  }

  // Replay guard: persist the authenticator's reported counter + usage time.
  await adminDb.admin_passkeys.update({
    where: { id: stored.id },
    data: { counter: BigInt(newCounter), last_used_at: new Date() },
  });

  clearVerifyFailures(pending.adminUserId);
  const redirectTo = await finalizePasskeyLogin(
    pending.adminUserId,
    pending.email,
    pending.username,
    pending.role,
  );
  // Return the landing route so the client navigates. We deliberately do NOT
  // call redirect() here: this action is invoked imperatively from a click
  // handler (not a form action / useActionState), where a server-side
  // redirect() throws NEXT_REDIRECT that surfaces to the client try/catch as
  // an error instead of navigating. Mirrors the login flow (router.push).
  return { redirectTo };
}

/**
 * Mint the real admin session for a passkey-verified login and return the
 * user's landing route. Mirrors the TOTP success tail in verify2FA: re-reads the
 * effective role set from the DB, writes the `admin_login` audit event + an
 * `admin_sessions` row (auth_method "passkey"), clears the pending cookie.
 */
async function finalizePasskeyLogin(
  adminUserId: string,
  email: string,
  username: string,
  fallbackRole: string,
): Promise<string> {
  const adminUser = await readAdminUserWithRoles(
    () =>
      adminDb.admin_users.findUnique({
        where: { id: adminUserId },
        select: { role: true, roles: true },
      }),
    () =>
      adminDb.admin_users.findUnique({
        where: { id: adminUserId },
        select: { role: true },
      }),
  );

  const effectiveRoles = getEffectiveRoles(adminUser?.role ?? fallbackRole, adminUser?.roles);
  await createSession({
    userId: adminUserId,
    role: pickPrimaryRole(effectiveRoles),
    roles: effectiveRoles,
    email,
    username,
  });

  const headersList = await headers();
  const ip = headersList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = headersList.get("user-agent") ?? null;

  await Promise.all([
    createAdminAuditEvent({
      adminUserId,
      eventType: "admin_login",
      ip,
      metadata: { method: "passkey" },
    }),
    adminDb.admin_sessions.create({
      data: {
        admin_user_id: adminUserId,
        ip,
        user_agent: userAgent,
        auth_method: "passkey",
        expires_at: new Date(Date.now() + 8 * MS_PER_HOUR),
      },
    }),
  ]);

  await deletePendingSession();

  return getDefaultRouteForUser(adminUserId, fallbackRole);
}
