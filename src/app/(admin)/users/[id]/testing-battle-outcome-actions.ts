"use server";

import { z } from "zod";

import { BackendApiError } from "@/lib/backend-api/errors";
import { resolveBackendApiConfig } from "@/lib/backend-api/config";
import {
  testingApi,
  type TestingBattleOutcomeRule,
} from "@/lib/backend-api/testing";
import { requirePageAccess } from "@/lib/dal";
import { readDbEnv } from "@/lib/db-env";
import { canManageTestingBattleOutcomes } from "@/lib/testing-battle-outcome-access";

const InputSchema = z.object({
  userId: z.string().trim().min(1, "Invalid user id"),
  battleCount: z.number().int().min(0).max(1000),
});

export async function setTestingBattleOutcomeRuleAction(input: {
  userId: string;
  battleCount: number;
}): Promise<
  | { success: true; data: TestingBattleOutcomeRule }
  | { success: false; error: string }
> {
  const session = await requirePageAccess("/users");
  const activeEnv = await readDbEnv();
  const backendConfig = await resolveBackendApiConfig().catch(() => null);

  if (
    activeEnv !== "dev" ||
    backendConfig?.env !== "dev" ||
    !canManageTestingBattleOutcomes(session.username)
  ) {
    return { success: false, error: "This testing control is not available" };
  }

  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid battle count",
    };
  }

  try {
    const data = await testingApi.setBattleOutcomeRule(
      parsed.data.userId,
      parsed.data.battleCount,
    );
    return { success: true, data };
  } catch (error) {
    if (error instanceof BackendApiError) {
      if (error.isNotFound) {
        return {
          success: false,
          error: "The dev backend testing endpoint is not enabled",
        };
      }
      return { success: false, error: error.message };
    }
    return { success: false, error: "Could not update the testing rule" };
  }
}
