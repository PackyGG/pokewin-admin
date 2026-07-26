"use server";

import { z } from "zod";
import { and, count, desc, eq } from "drizzle-orm";
import { verifySession } from "@/lib/dal";
import { adminDrizzle } from "@/lib/admin-db";
import { admin_passkeys } from "@/lib/db-schema/admin/schema";
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
//
// Each admin may hold at most MAX_PASSKEYS_PER_ADMIN credentials. The limit is
// enforced server-side both when starting and finishing registration (the
// finish check is authoritative against a start/finish race). The client card
// mirrors the same number for UX, but the server is the source of truth.
// ---------------------------------------------------------------------------

const MAX_PASSKEYS_PER_ADMIN = 2;
const PASSKEY_LIMIT_MESSAGE = `You can have at most ${MAX_PASSKEYS_PER_ADMIN} passkeys. Remove one to add another.`;

export type PasskeySummary = {
  id: string;
  deviceName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  backedUp: boolean;
};

export async function listMyPasskeys(): Promise<PasskeySummary[]> {
  const session = await verifySession();
  const rows = await adminDrizzle.select({
    id: admin_passkeys.id, device_name: admin_passkeys.device_name,
    created_at: admin_passkeys.created_at, last_used_at: admin_passkeys.last_used_at,
    backed_up: admin_passkeys.backed_up,
  }).from(admin_passkeys).where(eq(admin_passkeys.admin_user_id, session.userId))
    .orderBy(desc(admin_passkeys.created_at));
  return rows.map((r) => ({
    id: r.id,
    deviceName: r.device_name,
    createdAt: new Date(r.created_at).toISOString(),
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    backedUp: r.backed_up,
  }));
}

export async function startPasskeyRegistration(): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const session = await verifySession();
  const existing = await adminDrizzle.select({
    credential_id: admin_passkeys.credential_id,
    transports: admin_passkeys.transports,
  }).from(admin_passkeys).where(eq(admin_passkeys.admin_user_id, session.userId));
  if (existing.length >= MAX_PASSKEYS_PER_ADMIN) {
    throw new Error(PASSKEY_LIMIT_MESSAGE);
  }
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

  const [dup] = await adminDrizzle.select({ id: admin_passkeys.id })
    .from(admin_passkeys).where(eq(admin_passkeys.credential_id, credential.id)).limit(1);
  if (dup) {
    throw new Error("This passkey is already registered.");
  }

  // Authoritative cap check: re-count right before insert so a second
  // concurrent registration can't slip past the start-time guard.
  const [owned] = await adminDrizzle.select({ value: count() }).from(admin_passkeys)
    .where(eq(admin_passkeys.admin_user_id, session.userId));
  const ownedCount = owned?.value ?? 0;
  if (ownedCount >= MAX_PASSKEYS_PER_ADMIN) {
    throw new Error(PASSKEY_LIMIT_MESSAGE);
  }

  const cleanName = parsedName.data ? parsedName.data : null;
  const [created] = await adminDrizzle.insert(admin_passkeys).values({
      admin_user_id: session.userId,
      credential_id: credential.id,
      public_key: Buffer.from(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
      device_name: cleanName,
      backed_up: credentialBackedUp,
    }).returning({ id: admin_passkeys.id });
  if (!created) throw new Error("Passkey insert returned no row");

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
  const result = await adminDrizzle.update(admin_passkeys)
    .set({ device_name: name || null })
    .where(and(eq(admin_passkeys.id, id), eq(admin_passkeys.admin_user_id, session.userId)))
    .returning({ id: admin_passkeys.id });
  if (result.length === 0) {
    throw new Error("Passkey not found.");
  }
  return { success: true };
}

export async function deletePasskey(id: string): Promise<{ success: true }> {
  const session = await verifySession();
  const result = await adminDrizzle.delete(admin_passkeys)
    .where(and(eq(admin_passkeys.id, id), eq(admin_passkeys.admin_user_id, session.userId)))
    .returning({ id: admin_passkeys.id });
  if (result.length === 0) {
    throw new Error("Passkey not found.");
  }
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "passkey_removed",
    metadata: { passkeyId: id },
  });
  return { success: true };
}
