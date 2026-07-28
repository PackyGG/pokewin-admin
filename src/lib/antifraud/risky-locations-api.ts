import { z } from "zod";

const riskyLocationSchema = z.object({
  countryCode: z.string().length(2),
  monitorDurationMinutes: z.number().int().min(1).max(60),
  enabled: z.boolean(),
  createdBy: z.string(),
  updatedBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type RiskyLocation = z.infer<typeof riskyLocationSchema>;

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

export async function listRiskyLocations(): Promise<{
  configured: boolean;
  data: RiskyLocation[];
  error: boolean;
}> {
  if (!connection(false)) return { configured: false, data: [], error: false };
  try {
    const response = await request("/v1/risky-locations");
    if (!response.ok) throw new Error("request_failed");
    const payload = z
      .object({ data: z.array(riskyLocationSchema) })
      .parse(await response.json());
    return { configured: true, data: payload.data, error: false };
  } catch (error) {
    console.error("[antifraud] risky locations read failed:", error);
    return { configured: true, data: [], error: true };
  }
}

type MutationInput = {
  monitorDurationMinutes: number;
  idempotencyKey: string;
  actorId: string;
  actorUsername?: string;
};

async function parseMutationResponse(
  response: Response,
): Promise<RiskyLocation & { idempotent: boolean }> {
  const payload = await response.json().catch(() => null);
  if (response.status === 400) {
    throw new Error("Choose a valid country and a duration from 1 to 60 minutes.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("The monitor rejected the risky-location credentials.");
  }
  if (response.status === 404) {
    throw new Error("That risky location no longer exists.");
  }
  if (response.status === 409) {
    throw new Error("That country is already configured.");
  }
  if (!response.ok) {
    throw new Error("The risky-location setting could not be saved.");
  }
  return z
    .object({ data: riskyLocationSchema.extend({ idempotent: z.boolean() }) })
    .parse(payload).data;
}

export async function createRiskyLocation(
  input: MutationInput & { countryCode: string },
): Promise<RiskyLocation & { idempotent: boolean }> {
  return parseMutationResponse(
    await request(
      "/v1/risky-locations",
      { method: "POST", body: JSON.stringify(input) },
      true,
    ),
  );
}
export async function updateRiskyLocation(
  input: MutationInput & { countryCode: string; enabled: boolean },
): Promise<RiskyLocation & { idempotent: boolean }> {
  const { countryCode, ...body } = input;
  return parseMutationResponse(
    await request(
      `/v1/risky-locations/${encodeURIComponent(countryCode)}`,
      { method: "PUT", body: JSON.stringify(body) },
      true,
    ),
  );
}
