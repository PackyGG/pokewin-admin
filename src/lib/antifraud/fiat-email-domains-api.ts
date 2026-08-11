import "server-only";

import { z } from "zod";

const ruleSchema = z.object({
  id: z.string().uuid(),
  domain: z.string(),
  reason: z.string(),
  enabled: z.boolean(),
  createdBy: z.string(),
  updatedBy: z.string(),
  backfillComplete: z.boolean(),
  matchCount: z.number(),
  affectedUsers: z.number(),
  pendingLocks: z.number(),
  matches24h: z.number(),
  matches7d: z.number(),
  matches30d: z.number(),
  firstMatchAt: z.string().nullable(),
  lastMatchAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string().nullable(),
});

const matchSchema = z.object({
  intentId: z.string().uuid(),
  checkoutEmail: z.string(),
  domain: z.string(),
  riskType: z.enum([
    "blacklisted_domain",
    "gmail_dot_fragmentation",
    "suspicious_deposit_cluster",
  ]),
  riskScore: z.literal(100),
  severity: z.literal("critical"),
  withdrawalsLocked: z.boolean(),
  occurredAt: z.string(),
});

export type FiatEmailDomainRule = z.infer<typeof ruleSchema>;
export type FiatEmailDomainMatch = z.infer<typeof matchSchema>;

const TIMEOUT_MS = 8_000;

function connection(admin: boolean): { baseUrl: string; token: string } | null {
  const baseUrl = process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, "");
  const token = admin
    ? process.env.ANTIFRAUD_MONITOR_API_ADMIN_TOKEN
    : process.env.ANTIFRAUD_MONITOR_API_TOKEN;
  return baseUrl && token ? { baseUrl, token } : null;
}

async function request(
  path: string,
  init: RequestInit = {},
  admin = false,
): Promise<Response> {
  const configured = connection(admin);
  if (!configured) {
    throw new Error("The Antifraud monitor API is not configured.");
  }
  try {
    return await fetch(`${configured.baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${configured.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error("The Antifraud monitor service did not respond.");
  }
}

export async function listFiatEmailDomains(): Promise<{
  configured: boolean;
  data: FiatEmailDomainRule[];
  error: boolean;
}> {
  if (!connection(false)) return { configured: false, data: [], error: false };
  try {
    const response = await request("/v1/fiat-email-domains");
    if (!response.ok) throw new Error("request_failed");
    const payload = z
      .object({ data: z.array(ruleSchema) })
      .parse(await response.json());
    return { configured: true, data: payload.data, error: false };
  } catch (error) {
    console.error("[antifraud] email-domain blacklist read failed:", error);
    return { configured: true, data: [], error: true };
  }
}

export async function createFiatEmailDomain(input: {
  domain: string;
  reason: string;
  expiresAt: string | null;
  idempotencyKey: string;
  actorId: string;
  actorUsername?: string;
}): Promise<FiatEmailDomainRule & { idempotent: boolean }> {
  const response = await request(
    "/v1/fiat-email-domains",
    { method: "POST", body: JSON.stringify(input) },
    true,
  );
  const payload = await response.json().catch(() => null);
  if (response.status === 409) {
    if ((payload as { error?: unknown } | null)?.error === "idempotency_conflict") {
      throw new Error("That blacklist request key was already used.");
    }
    throw new Error("That email domain is already on the blacklist.");
  }
  if (response.status === 400) {
    throw new Error("Enter a valid email domain.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("The monitor rejected the blacklist credentials.");
  }
  if (!response.ok) {
    throw new Error("The email domain could not be added.");
  }
  return z
    .object({ data: ruleSchema.extend({ idempotent: z.boolean() }) })
    .parse(payload).data;
}

export async function updateFiatEmailDomain(input: {
  id: string;
  enabled: boolean;
  reason: string;
  expiresAt: string | null;
  idempotencyKey: string;
  actorId: string;
  actorUsername?: string;
}): Promise<FiatEmailDomainRule & { idempotent: boolean }> {
  const response = await request(
    `/v1/fiat-email-domains/${encodeURIComponent(input.id)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        enabled: input.enabled,
        reason: input.reason,
        expiresAt: input.expiresAt,
        idempotencyKey: input.idempotencyKey,
        actorId: input.actorId,
        actorUsername: input.actorUsername,
      }),
    },
    true,
  );
  const payload = await response.json().catch(() => null);
  if (
    response.status === 409 &&
    (payload as { error?: unknown } | null)?.error === "idempotency_conflict"
  ) {
    throw new Error("That blacklist request key was already used.");
  }
  if (response.status === 404) {
    throw new Error("That email-domain rule no longer exists.");
  }
  if (response.status === 400) {
    throw new Error("The email-domain rule is invalid.");
  }
  if (!response.ok) {
    throw new Error("The email-domain rule could not be updated.");
  }
  return z
    .object({ data: ruleSchema.extend({ idempotent: z.boolean() }) })
    .parse(payload).data;
}

export async function promoteCatchallEmailDomain(input: {
  domain: string;
  reason: string;
  idempotencyKey: string;
  actorId: string;
  actorUsername?: string;
}): Promise<FiatEmailDomainRule & { idempotent: boolean }> {
  const response = await request(
    "/v1/fiat-email-domains/promote-catchall",
    { method: "POST", body: JSON.stringify(input) },
    true,
  );
  const payload = await response.json().catch(() => null);
  if (response.status === 400) throw new Error("The catch-all domain is not safe to blacklist.");
  if (response.status === 409) throw new Error("That promotion request conflicts with an earlier action.");
  if (!response.ok) throw new Error("The catch-all domain could not be promoted to the blacklist.");
  return z.object({ data: ruleSchema.extend({ idempotent: z.boolean() }) }).parse(payload).data;
}

export async function getFiatEmailDomainMatches(
  intentIds: string[],
): Promise<FiatEmailDomainMatch[]> {
  if (intentIds.length === 0 || !connection(false)) return [];
  try {
    const response = await request(
      `/v1/fiat-email-domain-matches?intentIds=${encodeURIComponent(
        intentIds.join(","),
      )}`,
    );
    if (!response.ok) throw new Error("request_failed");
    return z
      .object({ data: z.array(matchSchema) })
      .parse(await response.json()).data;
  } catch (error) {
    console.error("[antifraud] fiat email risk lookup failed:", error);
    return [];
  }
}
