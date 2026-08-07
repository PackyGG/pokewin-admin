import "server-only";

import { z } from "zod";

const failureSchema = z.object({
  userId: z.string(),
  errorCode: z.string(),
  errorSummary: z.string(),
  failureKind: z.enum([
    "provider_transient",
    "provider_configuration",
    "transient",
    "invalid_payload",
  ]),
  failureCount: z.number().int().nonnegative(),
  nextRetryAt: z.string().nullable(),
  firstFailedAt: z.string(),
  lastFailedAt: z.string(),
  status: z.enum(["pending", "resolved"]),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolutionNote: z.string().nullable(),
});

const mutationResultSchema = z.object({
  data: failureSchema,
  idempotent: z.boolean(),
});

export type SignupIngestionFailure = z.infer<typeof failureSchema>;

type MutationInput = {
  userId: string;
  idempotencyKey: string;
  actorId: string;
  actorUsername?: string;
  reason: string;
};

function adminConfig(): { baseUrl?: string; token?: string } {
  return {
    baseUrl: process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, ""),
    token: process.env.ANTIFRAUD_MONITOR_API_ADMIN_TOKEN,
  };
}

function configuredAdmin(): { baseUrl: string; token: string } {
  const { baseUrl, token } = adminConfig();
  if (!baseUrl || !token) {
    throw new Error("Antifraud monitor admin access is not configured.");
  }
  return { baseUrl, token };
}

export async function getSignupIngestionFailures(): Promise<{
  configured: boolean;
  data: SignupIngestionFailure[];
  error: boolean;
}> {
  const { baseUrl, token } = adminConfig();
  if (!baseUrl || !token) {
    return { configured: false, data: [], error: false };
  }
  try {
    const response = await fetch(
      `${baseUrl}/v1/operations/signup-failures?status=pending&limit=100`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Monitor API returned ${response.status}`);
    }
    return {
      configured: true,
      data: z.object({ data: z.array(failureSchema) }).parse(await response.json())
        .data,
      error: false,
    };
  } catch {
    console.error("[antifraud-monitor] signup failure list request failed");
    return { configured: true, data: [], error: true };
  }
}

async function mutateFailure(
  action: "retry" | "resolve",
  input: MutationInput,
): Promise<SignupIngestionFailure & { idempotent: boolean }> {
  const { baseUrl, token } = configuredAdmin();
  const response = await fetch(
    `${baseUrl}/v1/operations/signup-failures/${encodeURIComponent(input.userId)}/${action}`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        idempotencyKey: input.idempotencyKey,
        actorId: input.actorId,
        actorUsername: input.actorUsername,
        reason: input.reason,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    },
  );
  if (!response.ok) {
    const error = await response
      .json()
      .then((body: unknown) =>
        z.object({ error: z.string() }).safeParse(body).data?.error
      )
      .catch(() => undefined);
    throw new Error(
      error === "not_found"
        ? "This signup failure no longer exists."
        : error === "idempotency_conflict"
          ? "This operation key was already used for a different request."
          : `Signup failure ${action} failed.`,
    );
  }
  const parsed = mutationResultSchema.parse(await response.json());
  return { ...parsed.data, idempotent: parsed.idempotent };
}

export function retrySignupIngestionFailure(
  input: MutationInput,
): Promise<SignupIngestionFailure & { idempotent: boolean }> {
  return mutateFailure("retry", input);
}

export function resolveSignupIngestionFailure(
  input: MutationInput,
): Promise<SignupIngestionFailure & { idempotent: boolean }> {
  return mutateFailure("resolve", input);
}
