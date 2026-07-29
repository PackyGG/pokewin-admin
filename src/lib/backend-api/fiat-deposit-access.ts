import "server-only";

import {
  BackendApiError,
  BackendNetworkError,
  type BackendErrorPayload,
} from "./errors";

export type FiatDepositAccess = {
  enabled: boolean;
};

type FiatDepositAccessResponse =
  | FiatDepositAccess
  | boolean
  | {
      data?: FiatDepositAccess | boolean;
      success?: boolean;
    };

function requiredEnv(name: "ADMIN_API_KEY" | "xbypasssecret"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name} for Fiat deposit access control`);
  }
  return value;
}

function headers(): Record<string, string> {
  return {
    "x-admin-api-key": requiredEnv("ADMIN_API_KEY"),
    xbypasssecret: requiredEnv("xbypasssecret"),
    accept: "application/json",
  };
}

function parseAccess(response: FiatDepositAccessResponse): FiatDepositAccess {
  if (typeof response === "boolean") return { enabled: response };
  if (
    response &&
    typeof response === "object" &&
    "enabled" in response &&
    typeof response.enabled === "boolean"
  ) {
    return { enabled: response.enabled };
  }
  const data =
    response && typeof response === "object" && "data" in response
      ? response.data
      : undefined;
  if (typeof data === "boolean") return { enabled: data };
  if (
    data &&
    typeof data === "object" &&
    typeof data.enabled === "boolean"
  ) {
    return { enabled: data.enabled };
  }
  throw new Error("Backend returned an invalid Fiat deposit access response");
}

const FIAT_DEPOSIT_ACCESS_BASE_URL = "https://packy.gg/v1";

const urlFor = (userId: string) =>
  `${FIAT_DEPOSIT_ACCESS_BASE_URL}/admin/users/${encodeURIComponent(userId)}/fiat-deposit-access`;

async function requestFiatDepositAccess(
  userId: string,
  method: "GET" | "PUT",
  enabled?: boolean,
): Promise<FiatDepositAccess> {
  const url = urlFor(userId);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...headers(),
        ...(method === "PUT" ? { "content-type": "application/json" } : {}),
      },
      body: method === "PUT" ? JSON.stringify({ enabled }) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    throw new BackendNetworkError(url, error);
  }

  const body = (await response.json().catch(() => null)) as
    | FiatDepositAccessResponse
    | BackendErrorPayload
    | null;
  if (!response.ok) {
    const payload = (body ?? {}) as BackendErrorPayload;
    throw new BackendApiError(
      response.status,
      payload.message ??
        payload.error ??
        `Fiat access request failed: ${response.status}`,
      payload,
    );
  }
  return parseAccess(body as FiatDepositAccessResponse);
}

export async function getFiatDepositAccess(
  userId: string,
): Promise<FiatDepositAccess> {
  return requestFiatDepositAccess(userId, "GET");
}

export async function updateFiatDepositAccess(
  userId: string,
  enabled: boolean,
): Promise<FiatDepositAccess> {
  return requestFiatDepositAccess(userId, "PUT", enabled);
}
