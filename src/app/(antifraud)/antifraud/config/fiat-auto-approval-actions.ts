"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import { actionErrorMessage } from "@/lib/antifraud/action-error-message";
import { resolveBackendApiConfig } from "@/lib/backend-api/config";
import {
  getFiatDepositAutomaticCreditConfig,
  updateFiatDepositAutomaticCreditConfig,
  type FiatDepositAutomaticCreditConfig,
} from "@/lib/backend-api/fiat-deposit-review";
import { readDbEnvFromCookie, type DbEnv } from "@/lib/db-env";
import { requireAntifraudManager } from "@/lib/require-antifraud-access";

const InputSchema = z.object({ enabled: z.boolean() });

type EnvResolution =
  | { ok: true; env: DbEnv }
  | { ok: false; error: string };

/**
 * This action flips global Fiat automatic credit — a live money rail.
 *
 * `resolveBackendApiConfig` silently falls back to whichever env IS configured
 * when the requested one is not (`resolveEffectiveEnv` in
 * `@/lib/backend-api/config`), so an admin sitting in dev could write the
 * PRODUCTION backend without any signal. Refuse on mismatch rather than warn,
 * matching `requireDevEnv` in `src/app/(admin)/test/creator/actions.ts`.
 *
 * Returns the resolved env on success so the audit row records which backend
 * was actually changed.
 */
async function resolveTargetEnv(): Promise<EnvResolution> {
  const requested = await readDbEnvFromCookie();
  let resolved: DbEnv;
  try {
    resolved = (await resolveBackendApiConfig()).env;
  } catch (error) {
    return {
      ok: false,
      // Narrowed: MissingBackendApiConfigError spells out env var names and
      // their set/missing state.
      error: actionErrorMessage(
        error,
        "The backend API is not configured, so the environment could not be resolved.",
      ),
    };
  }
  if (resolved !== requested) {
    return {
      ok: false,
      error: `Refusing to change global Fiat automatic credit: you are on the ${requested} environment but the backend API resolves to ${resolved}, so this would change the ${resolved} backend. Fix the ${requested} backend credentials or switch environments first.`,
    };
  }
  return { ok: true, env: resolved };
}

export async function updateFiatAutomaticCreditAction(input: {
  enabled: boolean;
}): Promise<
  | { success: true; data: FiatDepositAutomaticCreditConfig }
  | { success: false; error: string }
> {
  const session = await requireAntifraudManager(
    "Only owners and admins can change global Fiat approval.",
  );

  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid setting",
    };
  }

  const target = await resolveTargetEnv();
  if (!target.ok) {
    return { success: false, error: target.error };
  }

  let previous: FiatDepositAutomaticCreditConfig | null = null;
  try {
    previous = await getFiatDepositAutomaticCreditConfig();
  } catch {
    previous = null;
  }

  let updated: FiatDepositAutomaticCreditConfig;
  try {
    updated = await updateFiatDepositAutomaticCreditConfig(
      parsed.data.enabled,
      session.userId,
    );
  } catch (error) {
    return {
      success: false,
      // Narrowed: backend-fetch errors carry URLs/DNS/status internals.
      error: actionErrorMessage(
        error,
        "Fiat automatic-credit service is unavailable",
      ),
    };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "fiat_deposit_automatic_credit_updated",
    metadata: {
      old: previous?.fiat_deposit_automatic_credit_enabled ?? null,
      new: updated.fiat_deposit_automatic_credit_enabled,
      // Which backend this actually landed on. Without it the trail cannot
      // distinguish a prod policy change from a dev one.
      backendEnv: target.env,
    },
  });

  revalidatePath("/antifraud/config");
  revalidatePath("/antifraud/fiat-deposits");
  revalidatePath("/transactions/deposits");
  return { success: true, data: updated };
}
