"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { toNumber } from "@/lib/utils/decimal";
import { refreshSiteConfig } from "@/lib/refresh-site-config";
import { RAIN_CONFIG_KEYS } from "./config-keys";

export async function adjustRainBase(rainId: string, newBaseAmount: number) {
  const db = await getDb();
  const session = await requirePageAccess("/rain");
  await requireCapability(session, "__can_adjust_rain_base", "adjust rain base");

  if (newBaseAmount < 0) throw new Error("Base amount cannot be negative");

  const rain = await db.rains.findUnique({ where: { id: rainId } });
  if (!rain) throw new Error("Rain not found");
  if (rain.status !== "active") throw new Error("Can only adjust active rains");

  const totalPool = newBaseAmount + toNumber(rain.tip_amount_usd);

  await db.rains.update({
    where: { id: rainId },
    data: {
      base_amount_usd: newBaseAmount,
      total_pool_usd: totalPool,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "rain_base_adjusted",
    metadata: {
      rain_id: rainId,
      old_base: toNumber(rain.base_amount_usd),
      new_base: newBaseAmount,
      new_total: totalPool,
    },
  });

  revalidatePath("/rain");
  revalidatePath(`/rain/${rainId}`);
}

/**
 * Upsert the rain defaults stored in site_config.
 *
 * Only fields the admin actually changed are written (undefined fields
 * are skipped) so auditing stays accurate. After the writes the game
 * backend is pinged via refreshSiteConfig so its in-memory cache picks
 * up the new values.
 */
export async function updateRainConfig(input: {
  defaultBaseAmountUsd?: number;
  durationMinutes?: number;
}) {
  const db = await getDb();
  const session = await requirePageAccess("/rain");
  await requireCapability(session, "__can_update_rain_config", "update rain config");

  const toUpsert: {
    key: string;
    value: string;
    description: string;
    oldValue: string | null;
  }[] = [];

  if (input.defaultBaseAmountUsd !== undefined) {
    if (
      !Number.isFinite(input.defaultBaseAmountUsd) ||
      input.defaultBaseAmountUsd < 0
    ) {
      throw new Error("Default base amount must be a non-negative number");
    }
    const existing = await db.site_config.findUnique({
      where: { key: RAIN_CONFIG_KEYS.defaultBaseAmount },
      select: { value: true },
    });
    toUpsert.push({
      key: RAIN_CONFIG_KEYS.defaultBaseAmount,
      // Store as a plain-decimal string — the backend is expected to
      // parse this with its own Decimal/number type.
      value: String(input.defaultBaseAmountUsd),
      description: "Default base_amount_usd applied to newly created rain instances",
      oldValue: existing?.value ?? null,
    });
  }

  if (input.durationMinutes !== undefined) {
    if (
      !Number.isInteger(input.durationMinutes) ||
      input.durationMinutes <= 0
    ) {
      throw new Error("Duration minutes must be a positive integer");
    }
    const existing = await db.site_config.findUnique({
      where: { key: RAIN_CONFIG_KEYS.durationMinutes },
      select: { value: true },
    });
    toUpsert.push({
      key: RAIN_CONFIG_KEYS.durationMinutes,
      value: String(input.durationMinutes),
      description: "Duration in minutes between rain starts_at and ends_at",
      oldValue: existing?.value ?? null,
    });
  }

  if (toUpsert.length === 0) {
    throw new Error("No config fields provided");
  }

  // Run the upserts in a transaction so a partial write never leaves
  // the config half-updated. Site_config is a tiny table, this is cheap.
  await db.$transaction(
    toUpsert.map((entry) =>
      db.site_config.upsert({
        where: { key: entry.key },
        create: {
          key: entry.key,
          value: entry.value,
          description: entry.description,
        },
        update: { value: entry.value },
      }),
    ),
  );

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "rain_config_updated",
    metadata: Object.fromEntries(
      toUpsert.map((e) => [e.key, { old: e.oldValue, new: e.value }]),
    ),
  });

  // Fire-and-forget ping so the backend reloads its cache. If this
  // fails we still want the new DB value to stick — refreshSiteConfig
  // already logs errors internally.
  await refreshSiteConfig();

  revalidatePath("/rain");
}

