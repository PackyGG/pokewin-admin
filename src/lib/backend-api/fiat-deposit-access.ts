import "server-only";

import { z } from "zod";

import { backendApi } from "./client";

const fiatDepositAccessSchema = z.object({
  user_id: z.string().min(1),
  enabled: z.boolean(),
});

const fiatDepositAccessResponseSchema = z.object({
  success: z.literal(true),
  data: fiatDepositAccessSchema,
});

export type FiatDepositAccess = z.infer<typeof fiatDepositAccessSchema>;

function parseAccessResponse(
  response: unknown,
  requestedUserId: string,
): FiatDepositAccess {
  const parsed = fiatDepositAccessResponseSchema.safeParse(response);
  if (!parsed.success || parsed.data.data.user_id !== requestedUserId) {
    throw new Error("Backend returned an invalid Fiat deposit access response");
  }
  return parsed.data.data;
}

const pathFor = (userId: string): string =>
  `/admin/users/${encodeURIComponent(userId)}/fiat-deposit-access`;

export async function getFiatDepositAccess(
  userId: string,
): Promise<FiatDepositAccess> {
  const response = await backendApi.get<unknown>(pathFor(userId));
  return parseAccessResponse(response, userId);
}

export async function updateFiatDepositAccess(
  userId: string,
  enabled: boolean,
): Promise<FiatDepositAccess> {
  const response = await backendApi.put<unknown>(pathFor(userId), { enabled });
  return parseAccessResponse(response, userId);
}
