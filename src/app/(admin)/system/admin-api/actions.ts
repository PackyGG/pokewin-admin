"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { api_keys } from "@/lib/db-schema/admin/schema";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { require2FA } from "@/lib/require-2fa";
import { generateApiKey } from "@/lib/api-auth/token";
import { looksLikeIp, normalizeIp } from "@/lib/api-auth/ip";
import {
  ALL_API_SCOPES,
  FULL_ACCESS_SCOPE,
  hasFullAccess,
  isApiScope,
} from "@/lib/api-auth/scopes";

/**
 * API-key management for the `/api/v1/*` surface.
 *
 * Gate: `requireAdmin()` on EVERY action. Minting a key hands out standing,
 * non-interactive access to platform data, so it sits behind the same gate as
 * the other credential-bearing surfaces — never a plain page-access check.
 *
 * On top of that, the three actions that CREATE or WIDEN a credential
 * (`createApiKeyAction`, `updateApiKeyScopesAction`, `updateApiKeyIpsAction`)
 * also require `__can_manage_api_keys` + a second factor, matching every
 * other credential action in the panel. A minted wildcard key with
 * `allowed_ips` cleared is a durable credential that survives session
 * revocation, so a stolen session must not be enough to produce one.
 *
 * `revokeApiKeyAction` is DELIBERATELY left on `requireAdmin()` alone —
 * killing a leaked key has to stay frictionless.
 *
 * The plaintext token is returned to the caller EXACTLY ONCE, from
 * `createApiKeyAction`, and is never persisted or re-derivable. Losing it
 * means minting a new key.
 */

/**
 * Shared gate for the credential-issuing actions: admin → capability →
 * second factor, in that order, so a denial never reveals more than the
 * previous tier already did.
 *
 * Returns a result rather than throwing so each action can surface the
 * reason as its normal `{ success: false, error }` toast, the same way the
 * dialogs already report validation failures. (`requireAdmin` still
 * redirects an unauthenticated / non-admin caller — that is unchanged.)
 */
async function requireApiKeyIssuer(
  totpCode: string | undefined,
): Promise<
  | { ok: true; session: Awaited<ReturnType<typeof requireAdmin>> }
  | { ok: false; error: string }
> {
  const session = await requireAdmin();
  try {
    await requireCapability(session, "__can_manage_api_keys", "manage API keys");
    await require2FA(session.userId, totpCode);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Verification failed",
    };
  }
  return { ok: true, session };
}

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

/**
 * Narrow an operator-supplied scope list to the registry.
 *
 * Two invariants, shared by create + update so the two can't drift:
 *  - anything not in `API_SCOPES` is DROPPED — a client can never invent a
 *    scope, and a stale one from an older UI build can't be re-attached.
 *  - the wildcard is stored ALONE. It already satisfies every check, so
 *    keeping granular entries alongside it would make the row read as
 *    narrower than the grant actually is.
 */
function parseScopes(
  input: readonly string[],
): { ok: true; value: string[] } | { ok: false; error: string } {
  const known = [...new Set(input.filter(isApiScope))];
  if (known.length === 0) {
    return { ok: false, error: "Select at least one scope" };
  }
  return {
    ok: true,
    value: hasFullAccess(known) ? [FULL_ACCESS_SCOPE] : known,
  };
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
  totpCode?: string;
}): Promise<CreateApiKeyResult> {
  const gate = await requireApiKeyIssuer(input.totpCode);
  if (!gate.ok) return { success: false, error: gate.error };
  const session = gate.session;

  const parsed = CreateSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid input" };
  }

  const parsedScopes = parseScopes(parsed.data.scopes);
  if (!parsedScopes.ok) return { success: false, error: parsedScopes.error };
  const scopes = parsedScopes.value;

  const ips = parseAllowedIps(parsed.data.allowedIps);
  if (!ips.ok) return { success: false, error: ips.error };
  const allowedIps = ips.value;

  const { token, prefix, keyHash } = generateApiKey();
  const expiresAt =
    parsed.data.expiresInDays != null
      ? new Date(Date.now() + parsed.data.expiresInDays * 86_400_000)
      : null;

  const [created] = await adminDrizzle.insert(api_keys).values({
      name: parsed.data.name,
      prefix,
      key_hash: keyHash,
      scopes,
      allowed_ips: allowedIps,
      expires_at: expiresAt?.toISOString() ?? null,
      rate_limit_per_min: parsed.data.rateLimitPerMin,
      created_by: session.userId,
    }).returning({ id: api_keys.id });
  if (!created) throw new Error("API key insert returned no row");

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
  totpCode?: string;
}): Promise<UpdateApiKeyIpsResult> {
  const gate = await requireApiKeyIssuer(input.totpCode);
  if (!gate.ok) return { success: false, error: gate.error };
  const session = gate.session;

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

  const [existing] = await adminDrizzle.select({
    id: api_keys.id, name: api_keys.name, prefix: api_keys.prefix,
    allowed_ips: api_keys.allowed_ips, revoked_at: api_keys.revoked_at,
  }).from(api_keys).where(eq(api_keys.id, parsed.data.keyId)).limit(1);
  if (!existing) return { success: false, error: "Key not found" };
  // A revoked key is already dead; editing it would imply it still works.
  if (existing.revoked_at) {
    return { success: false, error: "Key is revoked" };
  }

  await adminDrizzle.update(api_keys).set({ allowed_ips: ips.value })
    .where(eq(api_keys.id, existing.id));

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

export type UpdateApiKeyScopesResult =
  | { success: true; scopes: string[] }
  | { success: false; error: string };

/**
 * Replace an existing key's scope set (SET semantics, not append) without
 * re-issuing the token — so a live consumer can be granted a newly-added
 * endpoint, or cut back to least privilege, with no redeploy on their side.
 *
 * Takes effect on the NEXT request: `authenticateApiRequest` re-reads the row
 * every time and there is no token/scope cache.
 *
 * Removing a scope is a breaking change for the caller (403 insufficient_scope
 * on the affected endpoints), and adding one is a privilege grant — both
 * directions are audited with the before/after sets.
 */
export async function updateApiKeyScopesAction(input: {
  keyId: string;
  scopes: string[];
  totpCode?: string;
}): Promise<UpdateApiKeyScopesResult> {
  const gate = await requireApiKeyIssuer(input.totpCode);
  if (!gate.ok) return { success: false, error: gate.error };
  const session = gate.session;

  const parsed = z
    .object({
      keyId: z.string().uuid(),
      scopes: z.array(z.string()).max(ALL_API_SCOPES.length),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid input" };
  }

  const scopes = parseScopes(parsed.data.scopes);
  if (!scopes.ok) return { success: false, error: scopes.error };

  const [existing] = await adminDrizzle.select({
    id: api_keys.id, name: api_keys.name, prefix: api_keys.prefix,
    scopes: api_keys.scopes, revoked_at: api_keys.revoked_at,
  }).from(api_keys).where(eq(api_keys.id, parsed.data.keyId)).limit(1);
  if (!existing) return { success: false, error: "Key not found" };
  // A revoked key is already dead; editing it would imply it still works.
  if (existing.revoked_at) {
    return { success: false, error: "Key is revoked" };
  }

  const added = scopes.value.filter((s) => !existing.scopes.includes(s));
  const removed = existing.scopes.filter((s) => !scopes.value.includes(s));
  if (added.length === 0 && removed.length === 0) {
    // Nothing to write — skip the update and the audit noise.
    return { success: true, scopes: scopes.value };
  }

  await adminDrizzle.update(api_keys).set({ scopes: scopes.value })
    .where(eq(api_keys.id, existing.id));

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "api_key_scopes_updated",
    metadata: {
      api_key_id: existing.id,
      name: existing.name,
      prefix: existing.prefix,
      old_scopes: existing.scopes,
      new_scopes: scopes.value,
      // Widening is the security-relevant direction — greppable rather than a
      // diff the reader has to compute.
      added,
      removed,
      granted_full_access:
        hasFullAccess(scopes.value) && !hasFullAccess(existing.scopes),
    },
  });

  revalidatePath("/system/admin-api");
  return { success: true, scopes: scopes.value };
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

  const [existing] = await adminDrizzle.select({
    id: api_keys.id, name: api_keys.name, prefix: api_keys.prefix,
    revoked_at: api_keys.revoked_at,
  }).from(api_keys).where(eq(api_keys.id, keyId)).limit(1);
  if (!existing) return { success: false, error: "Key not found" };
  if (existing.revoked_at) return { success: false, error: "Key already revoked" };

  // Revocation is immediate: authenticate() rejects on is_active=false OR a
  // non-null revoked_at, and it reads the row on every request (no token cache).
  await adminDrizzle.update(api_keys).set({
      is_active: false,
      revoked_at: new Date().toISOString(),
      revoked_by: session.userId,
    }).where(eq(api_keys.id, keyId));

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
