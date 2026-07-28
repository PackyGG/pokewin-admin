"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import { getPrimaryDrizzleDb } from "@/lib/db";
import { site_config } from "@/lib/db-schema/main/schema";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { refreshSiteConfig } from "@/lib/refresh-site-config";
import { FIAT_CACHE_TAG } from "@/lib/queries/fiat";
import { isWhopFiatDepositLockToken } from "@/lib/fiat-jurisdiction-policy";

const FIAT_METHODS = [
  "credit_card",
  "paypal",
  "paysafecard",
  "pulse",
  "apple_pay",
  "google_pay",
  "cash_app",
  "cashapp",
  "bank_transfer",
] as const;

const updateSchema = z.discriminatedUnion("key", [
  z.object({
    key: z.literal("card_deposit_max_usd"),
    value: z.coerce.number().finite().min(1).max(100_000),
  }),
  z.object({
    key: z.literal("deposit_withdrawal_hold_threshold_usd"),
    value: z.coerce.number().finite().min(0).max(1_000_000),
  }),
  z.object({
    key: z.literal("locked_deposits_fiat"),
    value: z.array(z.enum(FIAT_METHODS)).max(FIAT_METHODS.length),
  }),
]);

export type FiatEditableKey = z.infer<typeof updateSchema>["key"];

function parseFiatMethods(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    throw new Error("The configured fiat lock list is invalid JSON");
  }
}

function globalWhopLockFingerprint(methods: readonly string[]): string {
  return methods.filter(isWhopFiatDepositLockToken).sort().join("|");
}

export async function updateFiatConfigAction(input: unknown): Promise<{
  key: FiatEditableKey;
  value: string;
}> {
  const session = await requireAdmin();
  await requireCapability(
    session,
    "__can_upsert_site_config",
    "update fiat configuration",
  );

  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid fiat setting");
  }

  const normalizedValue =
    parsed.data.key === "locked_deposits_fiat"
      ? JSON.stringify([...new Set(parsed.data.value)].sort())
      : String(parsed.data.value);

  const db = await getPrimaryDrizzleDb();
  const existing = await db
    .select({
      key: site_config.key,
      value: site_config.value,
      description: site_config.description,
    })
    .from(site_config)
    .where(eq(site_config.key, parsed.data.key))
    .limit(1);

  const current = existing[0];
  if (!current) {
    throw new Error(
      `${parsed.data.key} is not configured in this environment. This page will not create a missing money-control key.`,
    );
  }

  if (
    parsed.data.key === "locked_deposits_fiat" &&
    globalWhopLockFingerprint(parseFiatMethods(current.value)) !==
      globalWhopLockFingerprint(parsed.data.value)
  ) {
    throw new Error(
      "Use the global Whop fiat switch to change card and wallet availability so required jurisdiction exclusions stay enforced.",
    );
  }

  if (current.value === normalizedValue) {
    return { key: parsed.data.key, value: normalizedValue };
  }

  const updated = await db
    .update(site_config)
    .set({
      value: normalizedValue,
      updated_at: new Date().toISOString(),
    })
    .where(eq(site_config.key, parsed.data.key))
    .returning({ key: site_config.key, value: site_config.value });

  if (!updated[0]) throw new Error("Fiat setting was not updated");

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "fiat_config_updated",
    metadata: {
      key: parsed.data.key,
      from: current.value,
      to: normalizedValue,
    },
  });

  await refreshSiteConfig();
  revalidateTag(FIAT_CACHE_TAG);
  revalidatePath("/fiat");
  revalidatePath("/security");

  return { key: parsed.data.key, value: normalizedValue };
}
