"use server";

import { verifySession } from "@/lib/dal";
import { adminDb } from "@/lib/admin-db";
import { buildAuthenticationOptions, checkAuthentication } from "@/lib/webauthn";
import {
  createWebauthnChallenge,
  getWebauthnChallenge,
  deleteWebauthnChallenge,
  createStepUpToken,
} from "@/lib/session";
import { MS_PER_MINUTE } from "@/lib/utils/time";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";

// ---------------------------------------------------------------------------
// Passkey step-up — satisfy an in-app 2FA action gate (require2FA) with a
// registered passkey instead of a TOTP code. This runs for an already-logged-in
// admin (verifySession), NOT the pending-login flow. The ceremony is:
//
//   1. startPasskeyStepUp()  → assertion options scoped to the admin's passkeys
//                              (+ a "stepup" challenge cookie)
//   2. browser signs the challenge with the authenticator
//   3. verifyPasskeyStepUp(response) → verifies + mints a short-lived proof token
//
// The client then hands that token to the privileged action exactly where it
// would have passed the 6-digit code; require2FA accepts either. Every read /
// write is scoped to the acting admin's OWN passkeys — an admin can never assert
// with, or step up via, another admin's credential.
// ---------------------------------------------------------------------------

// Per-admin failure throttle. Same in-memory caveat as the login verifier in
// (auth)/verify-2fa/actions.ts: resets on restart and doesn't cross instances —
// enough to slow a casual brute force. A passkey assertion isn't guessable, but
// the counter still bounds repeated failed attempts (e.g. a wrong/foreign key).
const MAX_FAILED_STEP_UPS = 8;
const STEP_UP_WINDOW_MS = 5 * MS_PER_MINUTE;
const stepUpFailures = new Map<string, { count: number; resetAt: number }>();

function recordStepUpFailure(adminUserId: string): void {
  const now = Date.now();
  const entry = stepUpFailures.get(adminUserId);
  if (!entry || now > entry.resetAt) {
    stepUpFailures.set(adminUserId, {
      count: 1,
      resetAt: now + STEP_UP_WINDOW_MS,
    });
    return;
  }
  entry.count++;
}

function isStepUpRateLimited(adminUserId: string): boolean {
  const entry = stepUpFailures.get(adminUserId);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    stepUpFailures.delete(adminUserId);
    return false;
  }
  return entry.count >= MAX_FAILED_STEP_UPS;
}

function clearStepUpFailures(adminUserId: string): void {
  stepUpFailures.delete(adminUserId);
}

/** Whether the current admin has at least one passkey — drives the client
 * decision to offer the "Use a passkey" control at a 2FA gate. */
export async function hasMyPasskeys(): Promise<boolean> {
  const session = await verifySession();
  const count = await adminDb.admin_passkeys.count({
    where: { admin_user_id: session.userId },
  });
  return count > 0;
}

/** Build assertion options scoped to the current admin's registered passkeys. */
export async function startPasskeyStepUp(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const session = await verifySession();
  const creds = await adminDb.admin_passkeys.findMany({
    where: { admin_user_id: session.userId },
    select: { credential_id: true, transports: true },
  });
  if (creds.length === 0) {
    throw new Error(
      "No passkeys are registered. Add one in your profile to use it here.",
    );
  }
  const options = await buildAuthenticationOptions({
    allowCredentials: creds.map((c) => ({
      credentialId: c.credential_id,
      transports: c.transports,
    })),
  });
  await createWebauthnChallenge({
    challenge: options.challenge,
    type: "stepup",
    adminUserId: session.userId,
  });
  return options;
}

/**
 * Verify a passkey assertion for the current admin and, on success, return a
 * short-lived step-up proof token. The token is passed to the privileged action
 * in place of a TOTP code (require2FA accepts it).
 */
export async function verifyPasskeyStepUp(
  response: AuthenticationResponseJSON,
): Promise<{ token: string }> {
  const session = await verifySession();

  if (isStepUpRateLimited(session.userId)) {
    throw new Error(
      "Too many failed passkey attempts. Try again in a few minutes.",
    );
  }

  const challenge = await getWebauthnChallenge();
  if (
    !challenge ||
    challenge.type !== "stepup" ||
    challenge.adminUserId !== session.userId
  ) {
    throw new Error("Passkey session expired. Please try again.");
  }

  // Resolve the exact credential asserted and make sure it belongs to the
  // acting admin — never trust the client's claimed credential id alone.
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
  if (!stored || stored.admin_user_id !== session.userId) {
    recordStepUpFailure(session.userId);
    await deleteWebauthnChallenge();
    throw new Error("Unrecognized passkey.");
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
    recordStepUpFailure(session.userId);
    throw new Error("Could not verify passkey. Please try again.");
  }

  // Replay guard: persist the authenticator's reported counter + usage time.
  await adminDb.admin_passkeys.update({
    where: { id: stored.id },
    data: { counter: BigInt(newCounter), last_used_at: new Date() },
  });

  clearStepUpFailures(session.userId);
  const token = await createStepUpToken(session.userId);
  return { token };
}
