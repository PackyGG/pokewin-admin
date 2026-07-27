"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { eq, inArray, sql } from "drizzle-orm";

import { getPrimaryDrizzleDb } from "@/lib/db";
import { rains, site_config } from "@/lib/db-schema/main/schema";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { toNumber } from "@/lib/utils/decimal";
import { refreshSiteConfig } from "@/lib/refresh-site-config";
import { RAIN_CONFIG_KEYS } from "./config-keys";

export async function adjustRainBase(rainId: string, newBaseAmount: number) {
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/rain");
  await requireCapability(session, "__can_adjust_rain_base", "adjust rain base");

  // SECURITY (SECURITY_AUDIT.md LOW): NaN/Infinity slip past a bare `< 0` check
  // (NaN<0 and Infinity<0 are both false) and would corrupt the MAIN rain pool.
  if (!Number.isFinite(newBaseAmount) || newBaseAmount < 0) {
    throw new Error("Base amount must be a valid non-negative number");
  }

  const result = await db.transaction(async (tx) => {
    const [rain] = await tx
      .select({
        status: rains.status,
        base_amount_usd: rains.base_amount_usd,
        tip_amount_usd: rains.tip_amount_usd,
      })
      .from(rains)
      .where(eq(rains.id, rainId))
      .limit(1)
      .for("update");
    if (!rain) throw new Error("Rain not found");
    if (rain.status !== "active") throw new Error("Can only adjust active rains");

    const totalPool = newBaseAmount + toNumber(rain.tip_amount_usd);
    await tx
      .update(rains)
      .set({
        base_amount_usd: String(newBaseAmount),
        total_pool_usd: String(totalPool),
        updated_at: new Date().toISOString(),
      })
      .where(eq(rains.id, rainId));
    return { rain, totalPool };
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "rain_base_adjusted",
    metadata: {
      rain_id: rainId,
      old_base: toNumber(result.rain.base_amount_usd),
      new_base: newBaseAmount,
      new_total: result.totalPool,
    },
  });

  // Bust the cached detail header/tips (unstable_cache, tag "rain-detail")
  // so the adjusted base + total pool surface immediately instead of
  // stale-while-revalidate. See src/lib/queries/rain-detail-cache.ts.
  revalidateTag("rain-detail");
  // The rain LIST now lives under the merged /rewards page (Rain tab); the
  // standalone /rain list route was removed. Revalidate /rewards so the
  // instances table refreshes, plus the surviving /rain/[id] detail route.
  revalidatePath("/rewards");
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
  liveBaseAmountUsd?: number;
  durationMinutes?: number;
  frequencyMs?: number;
}) {
  const db = await getPrimaryDrizzleDb();
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
    toUpsert.push({
      key: RAIN_CONFIG_KEYS.defaultBaseAmount,
      // Store as a plain-decimal string — the backend is expected to
      // parse this with its own Decimal/number type.
      value: String(input.defaultBaseAmountUsd),
      description: "Default base_amount_usd applied to newly created rain instances",
      oldValue: null,
    });
  }

  if (input.liveBaseAmountUsd !== undefined) {
    if (
      !Number.isFinite(input.liveBaseAmountUsd) ||
      input.liveBaseAmountUsd < 0
    ) {
      throw new Error("Live base amount must be a non-negative number");
    }
    toUpsert.push({
      key: RAIN_CONFIG_KEYS.liveBaseAmount,
      value: String(input.liveBaseAmountUsd),
      description: "Base rain amount",
      oldValue: null,
    });
  }

  if (input.durationMinutes !== undefined) {
    if (
      !Number.isInteger(input.durationMinutes) ||
      input.durationMinutes <= 0
    ) {
      throw new Error("Duration minutes must be a positive integer");
    }
    toUpsert.push({
      key: RAIN_CONFIG_KEYS.durationMinutes,
      value: String(input.durationMinutes),
      description: "Duration in minutes between rain starts_at and ends_at",
      oldValue: null,
    });
  }

  if (input.frequencyMs !== undefined) {
    if (
      !Number.isInteger(input.frequencyMs) ||
      input.frequencyMs < 60000 ||
      input.frequencyMs > 86400000
    ) {
      throw new Error(
        "Frequency must be an integer between 60000 ms (1 min) and 86400000 ms (24h)",
      );
    }
    toUpsert.push({
      key: RAIN_CONFIG_KEYS.frequencyMs,
      value: String(input.frequencyMs),
      description: "How frequent rains are. Default is each hour 3600000ms",
      oldValue: null,
    });
  }

  if (toUpsert.length === 0) {
    throw new Error("No config fields provided");
  }

  const existing = await db
    .select({ key: site_config.key, value: site_config.value })
    .from(site_config)
    .where(
      inArray(
        site_config.key,
        toUpsert.map((entry) => entry.key),
      ),
    );
  const existingByKey = new Map(existing.map((row) => [row.key, row.value]));
  for (const entry of toUpsert) {
    entry.oldValue = existingByKey.get(entry.key) ?? null;
  }

  // Run the upserts in a transaction so a partial write never leaves
  // the config half-updated. Site_config is a tiny table, this is cheap.
  await db
    .insert(site_config)
    .values(
      toUpsert.map((entry) => ({
        key: entry.key,
        value: entry.value,
        description: entry.description,
      })),
    )
    .onConflictDoUpdate({
      target: site_config.key,
      set: {
        value: sql`excluded.value`,
        updated_at: new Date().toISOString(),
      },
    });

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

  // Rain config is edited from the /rewards Rain → Config sub-tab now.
  revalidatePath("/rewards");
}

