import "server-only";

import { backendApi } from "./client";

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

const pathFor = (userId: string) =>
  `/admin/users/${encodeURIComponent(userId)}/fiat-deposit-access`;

export async function getFiatDepositAccess(
  userId: string,
): Promise<FiatDepositAccess> {
  const response = await backendApi.get<FiatDepositAccessResponse>(
    pathFor(userId),
    { headers: headers() },
  );
  return parseAccess(response);
}

export async function updateFiatDepositAccess(
  userId: string,
  enabled: boolean,
): Promise<FiatDepositAccess> {
  const response = await backendApi.put<FiatDepositAccessResponse>(
    pathFor(userId),
    { enabled },
    { headers: headers() },
  );
  return parseAccess(response);
}
