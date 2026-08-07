import "server-only";

import { z } from "zod";

export const identifierBlocklistKindSchema = z.enum(["ip", "fingerprint"]);
export type IdentifierBlocklistKind = z.infer<
  typeof identifierBlocklistKindSchema
>;
const identifierBlocklistEffectSchema = z.enum(["block", "known_vpn"]);
export type IdentifierBlocklistEffect = z.infer<
  typeof identifierBlocklistEffectSchema
>;

const ruleSchema = z.object({
  id: z.string().uuid(),
  kind: identifierBlocklistKindSchema,
  value: z.string(),
  matchMode: z.enum(["exact", "cidr"]),
  reason: z.string(),
  source: z.enum(["manual", "automatic", "legacy"]),
  effect: identifierBlocklistEffectSchema.default("block"),
  enabled: z.boolean(),
  createdBy: z.string(),
  updatedBy: z.string(),
  matchCount: z.number().int(),
  affectedUsers: z.number().int(),
  matches24h: z.number().int(),
  matches7d: z.number().int(),
  matches30d: z.number().int(),
  firstMatchAt: z.string().nullable(),
  lastMatchAt: z.string().nullable(),
  lockReviewCount: z.number().int(),
  reviewOnlyCount: z.number().int(),
  vpnStatus: z.enum(["detected", "unknown"]).default("unknown"),
  vpnProviders: z.array(z.string()).default([]),
  vpnLastDetectedAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string().nullable(),
});
export type IdentifierBlocklistRule = z.infer<typeof ruleSchema>;

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
  if (!configured) throw new Error("The Antifraud monitor API is not configured.");
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

export async function listIdentifierBlocklist(
  kind: IdentifierBlocklistKind,
): Promise<{
  configured: boolean;
  data: IdentifierBlocklistRule[];
  error: boolean;
}> {
  if (!connection(false)) return { configured: false, data: [], error: false };
  try {
    const response = await request(`/v1/blocklists/${kind}`);
    if (!response.ok) throw new Error("request_failed");
    const payload = z.object({ data: z.array(ruleSchema) })
      .parse(await response.json());
    return { configured: true, data: payload.data, error: false };
  } catch (error) {
    console.error(`[antifraud] ${kind} blocklist read failed:`, error);
    return { configured: true, data: [], error: true };
  }
}

type MutationActor = {
  idempotencyKey: string;
  actorId: string;
  actorUsername?: string;
};

async function parseMutation(
  response: Response,
): Promise<IdentifierBlocklistRule & { idempotent: boolean }> {
  const payload = await response.json().catch(() => null);
  if (response.status === 400) {
    throw new Error("The identifier or blocklist settings are invalid.");
  }
  if (response.status === 404) throw new Error("That rule no longer exists.");
  if (response.status === 409) {
    const code = (payload as { error?: unknown } | null)?.error;
    throw new Error(
      code === "idempotency_conflict"
        ? "That retry key was already used for another change."
        : "That identifier is already on the blocklist.",
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("The monitor rejected the blocklist credentials.");
  }
  if (!response.ok) throw new Error("The blocklist change could not be saved.");
  return z
    .object({ data: ruleSchema.extend({ idempotent: z.boolean() }) })
    .parse(payload).data;
}

export async function createIdentifierBlocklistRule(
  input: MutationActor & {
    kind: IdentifierBlocklistKind;
    value: string;
    matchMode: "exact" | "cidr";
    reason: string;
    expiresAt: string | null;
    effect?: IdentifierBlocklistEffect;
  },
) {
  return parseMutation(
    await request(
      `/v1/blocklists/${input.kind}`,
      {
        method: "POST",
        body: JSON.stringify({
          value: input.value,
          matchMode: input.matchMode,
          reason: input.reason,
          expiresAt: input.expiresAt,
          effect: input.effect ?? "block",
          idempotencyKey: input.idempotencyKey,
          actorId: input.actorId,
          actorUsername: input.actorUsername,
        }),
      },
      true,
    ),
  );
}

export async function updateIdentifierBlocklistRule(
  input: MutationActor & {
    kind: IdentifierBlocklistKind;
    id: string;
    enabled: boolean;
    reason: string;
    expiresAt: string | null;
    effect?: IdentifierBlocklistEffect;
  },
) {
  return parseMutation(
    await request(
      `/v1/blocklists/${input.kind}/${encodeURIComponent(input.id)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          enabled: input.enabled,
          reason: input.reason,
          expiresAt: input.expiresAt,
          effect: input.effect ?? "block",
          idempotencyKey: input.idempotencyKey,
          actorId: input.actorId,
          actorUsername: input.actorUsername,
        }),
      },
      true,
    ),
  );
}
