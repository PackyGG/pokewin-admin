import "server-only";

import { z } from "zod";

const configSchema = z.object({
  userOnlyLoses: z.boolean(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});

export const eosUserRuleSchema = z.object({
  target: z.enum(["loss", "win", "any"]),
  strategy: z.enum(["random", "lowest_profit", "highest_profit"]),
  count: z.number().int().min(1).max(100),
});

const userConfigSchema = z.object({
  userId: z.string().min(1).max(100),
  username: z.string().nullable(),
  rules: z.array(eosUserRuleSchema),
  currentRuleIndex: z.number().int().nonnegative(),
  remainingInRule: z.number().int().nonnegative(),
  enabled: z.boolean(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});

export type EosTestConfig = z.infer<typeof configSchema>;
export type EosUserRule = z.infer<typeof eosUserRuleSchema>;
export type EosUserConfig = z.infer<typeof userConfigSchema>;

const TIMEOUT_MS = 5_000;
const PATH = "/v1/testing/eos-random-block/config";
const USERS_PATH = `${PATH}/users`;

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

async function userRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const { baseUrl, token } = connection();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
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
    throw new Error("The EOS user configuration service did not respond.");
  }
  if (!response.ok) {
    throw new Error("The EOS user configuration could not be loaded or saved.");
  }
  return schema.parse(await response.json());
}

export async function listEosUserConfigs(): Promise<EosUserConfig[]> {
  const result = await userRequest(
    USERS_PATH,
    z.object({ data: z.array(userConfigSchema) }),
  );
  return result.data;
}

export async function updateEosUserConfig(input: {
  userId: string;
  username: string | null;
  rules: EosUserRule[];
  enabled: boolean;
  actor: string;
}): Promise<EosUserConfig> {
  const result = await userRequest(
    `${USERS_PATH}/${encodeURIComponent(input.userId)}`,
    z.object({ data: userConfigSchema }),
    {
      method: "PUT",
      body: JSON.stringify({
        username: input.username,
        rules: input.rules,
        enabled: input.enabled,
        actor: input.actor,
      }),
    },
  );
  return result.data;
}

export async function deleteEosUserConfig(userId: string): Promise<void> {
  const { baseUrl, token } = connection();
  let response: Response;
  try {
    response = await fetch(
      `${baseUrl}${USERS_PATH}/${encodeURIComponent(userId)}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch {
    throw new Error("The EOS user configuration service did not respond.");
  }
  if (!response.ok) {
    throw new Error("The EOS user configuration could not be deleted.");
  }
}
