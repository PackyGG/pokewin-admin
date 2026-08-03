import "server-only";

import { z } from "zod";

import { backendApi } from "./client";

const FiatDepositAutomaticCreditConfigSchema = z.object({
  fiat_deposit_automatic_credit_enabled: z.boolean(),
});

const ResponseSchema = z.object({
  success: z.literal(true),
  data: FiatDepositAutomaticCreditConfigSchema,
});

export type FiatDepositAutomaticCreditConfig = z.infer<
  typeof FiatDepositAutomaticCreditConfigSchema
>;

function parseResponse(response: unknown): FiatDepositAutomaticCreditConfig {
  const parsed = ResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new Error(
      "Backend returned an invalid Fiat automatic-credit response",
    );
  }
  return parsed.data.data;
}

export async function getFiatDepositAutomaticCreditConfig(): Promise<FiatDepositAutomaticCreditConfig> {
  const response = await backendApi.get<unknown>("/admin/fiat-deposits/config");
  return parseResponse(response);
}

export async function updateFiatDepositAutomaticCreditConfig(
  enabled: boolean,
  adminUserId?: string,
): Promise<FiatDepositAutomaticCreditConfig> {
  const response = await backendApi.put<unknown>(
    "/admin/fiat-deposits/config",
    { fiat_deposit_automatic_credit_enabled: enabled },
    adminUserId ? { headers: { "x-admin-user-id": adminUserId } } : {},
  );
  return parseResponse(response);
}
