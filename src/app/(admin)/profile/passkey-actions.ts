"use server";

import { z } from "zod";
import { verifySession } from "@/lib/dal";
import { adminDb } from "@/lib/admin-db";
import { buildRegistrationOptions, checkRegistration } from "@/lib/webauthn";
import {
  createWebauthnChallenge,
  getWebauthnChallenge,
  deleteWebauthnChallenge,
} from "@/lib/session";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import type {
  RegistrationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
} from "@simplewebauthn/server";

// ---------------------------------------------------------------------------
// Self-service passkey management for the currently-logged-in admin. A passkey
// registered here can be used as an ALTERNATIVE to the TOTP code at the 2FA
// verification step (see (auth)/verify-2fa). Every action re-derives the acting
// admin from the session and scopes its reads/writes to that admin's OWN
// passkeys — an admin can never touch another admin's credentials.
// ---------------------------------------------------------------------------

export type PasskeySummary = {
  id: string;
  deviceName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  backedUp: boolean;
};

export async function listMyPasskeys(): Promise<PasskeySummary[]> {
  const session = await verifySession();
  const rows = await adminDb.admin_passkeys.findMany({
    where: { admin_user_id: session.userId },
    orderBy: { created_at: "desc" },
    select: {
      id: true,
      device_name: true,
      created_at: true,
      last_used_at: true,
      backed_up: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    deviceName: r.device_name,
    createdAt: r.created_at.toISOString(),
    lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
    backedUp: r.backed_up,
  }));
}

export async function startPasskeyRegistration(): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const session = await verifySession();
  const existing = await adminDb.admin_passkeys.findMany({
    where: { admin_user_id: session.userId },
    select: { credential_id: true, transports: true },
  });
  const options = await buildRegistrationOptions({
    userId: session.userId,
    userName: session.email,
    userDisplayName: session.username,
    existing: existing.map((e) => ({
      credentialId: e.credential_id,
      transports: e.transports,
    })),
  });
  await createWebauthnChallenge({
    challenge: options.challenge,
    type: "register",
    adminUserId: session.userId,
  });
  return options;
}

const deviceNameSchema = z
  .string()
  .trim()
  .max(60, "Device name is too long")
  .optional();

export async function finishPasskeyRegistration(
  response: RegistrationResponseJSON,
  deviceName?: string,
): Promise<{ success: true }> {
  const session = await verifySession();
  const parsedName = deviceNameSchema.safeParse(deviceName);
  if (!parsedName.success) {
    throw new Error(parsedName.error.issues[0].message);
  }

  const challenge = await getWebauthnChallenge();
  if (
    !challenge ||
    challenge.type !== "register" ||
    challenge.adminUserId !== session.userId
  ) {
    throw new Error("Registration session expired. Please try again.");
  }

  let verification;
  try {
    verification = await checkRegistration({
      response,
      expectedChallenge: challenge.challenge,
    });
  } finally {
    // One-time challenge — always burn it, success or failure.
    await deleteWebauthnChallenge();
  }

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Could not verify the passkey. Please try again.");
  }

  const { credential, credentialBackedUp } = verification.registrationInfo;

  const dup = await adminDb.admin_passkeys.findUnique({
    where: { credential_id: credential.id },
    select: { id: true },
  });
  if (dup) {
    throw new Error("This passkey is already registered.");
  }

  const cleanName = parsedName.data ? parsedName.data : null;
  const created = await adminDb.admin_passkeys.create({
    data: {
      admin_user_id: session.userId,
      credential_id: credential.id,
      public_key: Buffer.from(credential.publicKey),
      counter: BigInt(credential.counter),
      transports: credential.transports ?? [],
      device_name: cleanName,
      backed_up: credentialBackedUp,
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "passkey_registered",
    metadata: { passkeyId: created.id, deviceName: cleanName },
  });

  return { success: true };
}

export async function renamePasskey(
  id: string,
  deviceName: string,
): Promise<{ success: true }> {
  const session = await verifySession();
  const name = deviceName.trim().slice(0, 60);
  // updateMany with both the id AND the owner so it can only ever hit the
  // caller's own credential.
  const result = await adminDb.admin_passkeys.updateMany({
    where: { id, admin_user_id: session.userId },
    data: { device_name: name || null },
  });
  if (result.count === 0) {
    throw new Error("Passkey not found.");
  }
  return { success: true };
}

export async function deletePasskey(id: string): Promise<{ success: true }> {
  const session = await verifySession();
  const result = await adminDb.admin_passkeys.deleteMany({
    where: { id, admin_user_id: session.userId },
  });
  if (result.count === 0) {
    throw new Error("Passkey not found.");
  }
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "passkey_removed",
    metadata: { passkeyId: id },
  });
  return { success: true };
}
