"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminDb } from "@/lib/admin-db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { requireAdmin } from "@/lib/dal";
import { generateApiKey } from "@/lib/api-auth/token";
import { ALL_API_SCOPES, isApiScope } from "@/lib/api-auth/scopes";

/**
 * API-key management for the `/api/v1/*` surface.
 *
 * Gate: `requireAdmin()` on EVERY action. Minting a key hands out standing,
 * non-interactive access to platform data, so it sits behind the same gate as
 * the other credential-bearing surfaces — never a plain page-access check.
 *
 * The plaintext token is returned to the caller EXACTLY ONCE, from
 * `createApiKeyAction`, and is never persisted or re-derivable. Losing it
 * means minting a new key.
 */

const CreateSchema = z.object({
  name: z.string().trim().min(2).max(60),
  scopes: z.array(z.string()).max(ALL_API_SCOPES.length),
  /** Optional lifetime bound, in days. Null/omitted = no expiry. */
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
  rateLimitPerMin: z.number().int().min(1).max(10_000).default(120),
});

export type CreateApiKeyResult =
  | { success: true; token: string; prefix: string }
  | { success: false; error: string };

export async function createApiKeyAction(input: {
  name: string;
  scopes: string[];
  expiresInDays?: number | null;
  rateLimitPerMin?: number;
}): Promise<CreateApiKeyResult> {
  const session = await requireAdmin();

  const parsed = CreateSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid input" };
  }

  // Drop anything not in the registry — a client can never invent a scope.
  const scopes = [...new Set(parsed.data.scopes.filter(isApiScope))];
  if (scopes.length === 0) {
    return { success: false, error: "Select at least one scope" };
  }

  const { token, prefix, keyHash } = generateApiKey();
  const expiresAt =
    parsed.data.expiresInDays != null
      ? new Date(Date.now() + parsed.data.expiresInDays * 86_400_000)
      : null;

  const created = await adminDb.api_keys.create({
    data: {
      name: parsed.data.name,
      prefix,
      key_hash: keyHash,
      scopes,
      expires_at: expiresAt,
      rate_limit_per_min: parsed.data.rateLimitPerMin,
      created_by: session.userId,
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "api_key_created",
    metadata: {
      api_key_id: created.id,
      name: parsed.data.name,
      prefix,
      scopes,
      expires_at: expiresAt?.toISOString() ?? null,
      rate_limit_per_min: parsed.data.rateLimitPerMin,
    },
  });

  revalidatePath("/system/api-keys");
  // ONLY time the plaintext token ever leaves this process.
  return { success: true, token, prefix };
}

export type RevokeApiKeyResult =
  | { success: true }
  | { success: false; error: string };

export async function revokeApiKeyAction(
  keyId: string,
): Promise<RevokeApiKeyResult> {
  const session = await requireAdmin();

  if (!z.string().uuid().safeParse(keyId).success) {
    return { success: false, error: "Invalid key id" };
  }

  const existing = await adminDb.api_keys.findUnique({
    where: { id: keyId },
    select: { id: true, name: true, prefix: true, revoked_at: true },
  });
  if (!existing) return { success: false, error: "Key not found" };
  if (existing.revoked_at) return { success: false, error: "Key already revoked" };

  // Revocation is immediate: authenticate() rejects on is_active=false OR a
  // non-null revoked_at, and it reads the row on every request (no token cache).
  await adminDb.api_keys.update({
    where: { id: keyId },
    data: {
      is_active: false,
      revoked_at: new Date(),
      revoked_by: session.userId,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "api_key_revoked",
    metadata: {
      api_key_id: existing.id,
      name: existing.name,
      prefix: existing.prefix,
    },
  });

  revalidatePath("/system/api-keys");
  return { success: true };
}
