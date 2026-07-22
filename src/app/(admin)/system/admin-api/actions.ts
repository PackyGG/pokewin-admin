"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminDb } from "@/lib/admin-db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { requireAdmin } from "@/lib/dal";
import { generateApiKey } from "@/lib/api-auth/token";
import { looksLikeIp, normalizeIp } from "@/lib/api-auth/ip";
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
  /** Optional IP allowlist. Empty = callable from anywhere. */
  allowedIps: z.array(z.string()).max(20).optional(),
});

/**
 * Normalise + de-dupe + validate an operator-supplied IP list.
 *
 * Normalising BEFORE storing matters: "1.2.3.4 ", "::ffff:1.2.3.4" and
 * "1.2.3.4:80" all mean the same host, and storing them verbatim would produce
 * entries that silently never match at request time (the auth path compares
 * normalised forms). Shared by create + update so the two can't drift.
 */
function parseAllowedIps(
  input: readonly string[] | undefined,
): { ok: true; value: string[] } | { ok: false; error: string } {
  const value = [
    ...new Set((input ?? []).map((entry) => normalizeIp(entry)).filter(Boolean)),
  ];
  const invalid = value.find((entry) => !looksLikeIp(entry));
  if (invalid) {
    return { ok: false, error: `Not a valid IP address: ${invalid}` };
  }
  return { ok: true, value };
}

export type CreateApiKeyResult =
  | { success: true; token: string; prefix: string }
  | { success: false; error: string };

export async function createApiKeyAction(input: {
  name: string;
  scopes: string[];
  expiresInDays?: number | null;
  rateLimitPerMin?: number;
  allowedIps?: string[];
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

  const ips = parseAllowedIps(parsed.data.allowedIps);
  if (!ips.ok) return { success: false, error: ips.error };
  const allowedIps = ips.value;

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
      allowed_ips: allowedIps,
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
      allowed_ips: allowedIps,
      expires_at: expiresAt?.toISOString() ?? null,
      rate_limit_per_min: parsed.data.rateLimitPerMin,
    },
  });

  revalidatePath("/system/admin-api");
  // ONLY time the plaintext token ever leaves this process.
  return { success: true, token, prefix };
}

export type UpdateApiKeyIpsResult =
  | { success: true; allowedIps: string[] }
  | { success: false; error: string };

/**
 * Replace an existing key's IP allowlist (SET semantics, not append) without
 * re-issuing the token — so you can re-point a live bot at a new egress IP, or
 * lock down / open up a key already in production.
 *
 * An empty array clears the restriction and makes the key callable from
 * anywhere again, so the change is audited with both the old and new lists.
 */
export async function updateApiKeyIpsAction(input: {
  keyId: string;
  allowedIps: string[];
}): Promise<UpdateApiKeyIpsResult> {
  const session = await requireAdmin();

  const parsed = z
    .object({
      keyId: z.string().uuid(),
      allowedIps: z.array(z.string()).max(20),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid input" };
  }

  const ips = parseAllowedIps(parsed.data.allowedIps);
  if (!ips.ok) return { success: false, error: ips.error };

  const existing = await adminDb.api_keys.findUnique({
    where: { id: parsed.data.keyId },
    select: {
      id: true,
      name: true,
      prefix: true,
      allowed_ips: true,
      revoked_at: true,
    },
  });
  if (!existing) return { success: false, error: "Key not found" };
  // A revoked key is already dead; editing it would imply it still works.
  if (existing.revoked_at) {
    return { success: false, error: "Key is revoked" };
  }

  await adminDb.api_keys.update({
    where: { id: existing.id },
    data: { allowed_ips: ips.value },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "api_key_ips_updated",
    metadata: {
      api_key_id: existing.id,
      name: existing.name,
      prefix: existing.prefix,
      old_allowed_ips: existing.allowed_ips,
      new_allowed_ips: ips.value,
      // Loosening a restriction is the security-relevant direction — make it
      // greppable in the audit log rather than a diff the reader must compute.
      cleared: existing.allowed_ips.length > 0 && ips.value.length === 0,
    },
  });

  revalidatePath("/system/admin-api");
  return { success: true, allowedIps: ips.value };
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

  revalidatePath("/system/admin-api");
  return { success: true };
}
