import "server-only";

import { z } from "zod";

const configSchema = z.object({
  userOnlyLoses: z.boolean(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});

export type EosTestConfig = z.infer<typeof configSchema>;

const TIMEOUT_MS = 5_000;
const PATH = "/v1/testing/eos-random-block/config";

function connection(): { baseUrl: string; token: string } {
  const baseUrl = process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, "");
  const token = process.env.ANTIFRAUD_MONITOR_API_ADMIN_TOKEN;
  if (!baseUrl || !token) {
    throw new Error("The EOS test configuration service is not configured.");
  }
  return { baseUrl, token };
}

async function request(init?: RequestInit): Promise<EosTestConfig> {
  const { baseUrl, token } = connection();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${PATH}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error("The EOS test configuration service did not respond.");
  }
  if (!response.ok) {
    throw new Error("The EOS test configuration could not be loaded or saved.");
  }
  return z.object({ data: configSchema }).parse(await response.json()).data;
}

export function getEosTestConfig(): Promise<EosTestConfig> {
  return request();
}

export function updateEosTestConfig(input: {
  userOnlyLoses: boolean;
  actor: string;
}): Promise<EosTestConfig> {
  return request({ method: "PUT", body: JSON.stringify(input) });
}
