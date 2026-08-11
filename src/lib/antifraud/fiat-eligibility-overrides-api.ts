import "server-only";

import { z } from "zod";

const overrideSchema = z.object({
  environment: z.enum(["dev", "prod"]),
  userId: z.string().min(1),
  enabled: z.boolean(),
  reason: z.string().nullable(),
  updatedBy: z.string().nullable(),
  updatedByUsername: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

const TIMEOUT_MS = 8_000;

export type FiatEligibilityOverride = z.infer<typeof overrideSchema>;

function connection(admin: boolean): { baseUrl: string; token: string } {
  const baseUrl = process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, "");
  const token = admin
    ? process.env.ANTIFRAUD_MONITOR_API_ADMIN_TOKEN
    : process.env.ANTIFRAUD_MONITOR_API_TOKEN;
  if (!baseUrl || !token) {
    throw new Error("The Antifraud monitor API is not configured.");
  }
  return { baseUrl, token };
}

async function request(
  userId: string,
  init: RequestInit = {},
  admin = false,
): Promise<Response> {
  const configured = connection(admin);
  try {
    return await fetch(
      `${configured.baseUrl}/v1/fiat-eligibility/overrides/`
        + `${encodeURIComponent(userId)}`,
      {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${configured.token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch {
    throw new Error("The Antifraud monitor service did not respond.");
  }
}

async function parse(response: Response): Promise<FiatEligibilityOverride> {
  const payload = await response.json().catch(() => null);
  if (response.status === 409) throw new Error("The override retry conflicted.");
  if (response.status === 401 || response.status === 403) {
    throw new Error("The monitor rejected the override credentials.");
  }
  if (!response.ok) throw new Error("The pre-Fiat override could not be saved.");
  return z.object({ data: overrideSchema }).parse(payload).data;
}

export async function getFiatEligibilityOverride(
  userId: string,
): Promise<FiatEligibilityOverride> {
  return parse(await request(userId));
}

export async function updateFiatEligibilityOverride(input: {
  userId: string;
  enabled: boolean;
  reason: string;
  actorId: string;
  actorUsername?: string;
  idempotencyKey: string;
}): Promise<FiatEligibilityOverride> {
  return parse(await request(
    input.userId,
    {
      method: "PUT",
      body: JSON.stringify({
        environment: "prod",
        enabled: input.enabled,
        reason: input.reason,
        actorId: input.actorId,
        actorUsername: input.actorUsername,
        idempotencyKey: input.idempotencyKey,
      }),
    },
    true,
  ));
}
