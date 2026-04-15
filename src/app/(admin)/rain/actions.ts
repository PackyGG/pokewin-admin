"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { toNumber } from "@/lib/utils/decimal";
import { refreshSiteConfig } from "@/lib/refresh-site-config";

/**
 * site_config keys that drive rain defaults for the game backend.
 *
 * These are the SINGLE source of truth on the admin side — change them
 * here if the backend team uses different names. Everything else
 * (query helper, UI component, server action) references these
 * constants so a rename is a one-line change.
 *
 * IMPORTANT: these values only take effect if the game backend is
 * configured to read these keys when creating new rain instances. If
 * the backend still hardcodes the defaults, the admin UI will happily
 * persist new values but nothing downstream will use them. Verify with
 * the backend team before trusting the config.
 */
export const RAIN_CONFIG_KEYS = {
  defaultBaseAmount: "rain_default_base_amount",
  durationMinutes: "rain_duration_minutes",
} as const;

export async function adjustRainBase(rainId: string, newBaseAmount: number) {
  const session = await requirePageAccess("/rain");

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
  const session = await requirePageAccess("/rain");

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

