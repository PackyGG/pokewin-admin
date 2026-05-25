"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  BackendApiError,
  upgraderApi,
  type UpgraderOutputCard,
} from "@/lib/backend-api";
import {
  UPGRADER_OUTPUT_COLORS,
  type UpgraderOutputColor,
} from "./colors";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { getCards, getRarities, getSets } from "@/lib/queries/cards";

/**
 * Backend-API-driven upgrader admin actions.
 *
 * Mirrors the creators/backend-actions.ts pattern: each action runs under
 * the logged-in admin's session (`requirePageAccess`), calls the typed
 * `upgraderApi` client against `/v1/admin/upgrader/outputs`, writes a
 * local admin-audit row, then revalidates the affected page. The backend
 * is the source of truth — it owns the output_cards table and the Redis
 * cache invalidation for the user-facing `/v1/upgrader/outputs` route.
 */

const toActionError = (err: unknown): Error => {
  if (err instanceof BackendApiError) {
    return new Error(err.code ? `${err.message} (${err.code})` : err.message);
  }
  return err instanceof Error ? err : new Error("Unknown backend error");
};

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listUpgraderOutputs(): Promise<UpgraderOutputCard[]> {
  await requirePageAccess("/upgrader");
  try {
    return await upgraderApi.listOutputs();
  } catch (err) {
    throw toActionError(err);
  }
}

// ---------------------------------------------------------------------------
// Card picker — reuses the admin-DB cards catalog, scoped to this page
// ---------------------------------------------------------------------------

export type UpgraderCardPickerItem = {
  id: string;
  name: string;
  imageUrl: string;
  priceUsd: number;
  rarity: string | null;
  setName: string | null;
};

export async function searchCardsForUpgraderPicker(params: {
  page?: number;
  perPage?: number;
  search?: string;
  rarity?: string;
  setId?: string;
  minPrice?: string;
  maxPrice?: string;
}) {
  await requirePageAccess("/upgrader");
  const result = await getCards({
    page: params.page,
    perPage: params.perPage,
    search: params.search,
    rarity: params.rarity,
    setId: params.setId,
    minPrice: params.minPrice,
    maxPrice: params.maxPrice,
    sortBy: "name",
    sortOrder: "asc",
  });
  return {
    data: result.data.map<UpgraderCardPickerItem>((c) => ({
      id: c.id,
      name: c.name,
      imageUrl: c.imageUrl,
      priceUsd: c.priceUsd,
      rarity: c.rarity,
      setName: c.setName,
    })),
    total: result.total,
    page: result.page,
    totalPages: result.totalPages,
  };
}

export async function getUpgraderPickerFilters() {
  await requirePageAccess("/upgrader");
  const [sets, rarities] = await Promise.all([getSets(), getRarities()]);
  return {
    sets,
    rarities: rarities.filter((r): r is string => r != null),
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

const AddOutputsSchema = z.object({
  card_ids: z.array(z.string().uuid()).min(1).max(500),
});

export async function addUpgraderOutputs(card_ids: string[]) {
  const session = await requirePageAccess("/upgrader");
  const parsed = AddOutputsSchema.parse({ card_ids });
  await requireCapability(
    session,
    "__can_add_upgrader_output",
    "add upgrader output cards",
  );

  try {
    const result = await upgraderApi.addOutputs(parsed.card_ids);

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "upgrader_output_added",
      metadata: {
        via: "backend_api",
        requested: parsed.card_ids.length,
        inserted: result.inserted,
        skipped: result.skipped,
        card_ids: parsed.card_ids,
      },
    });

    revalidatePath("/upgrader");
    return result;
  } catch (err) {
    throw toActionError(err);
  }
}

export async function setUpgraderOutputEnabled(id: string, enabled: boolean) {
  const session = await requirePageAccess("/upgrader");
  await requireCapability(
    session,
    "__can_toggle_upgrader_output",
    "enable or disable upgrader output cards",
  );

  try {
    await upgraderApi.setEnabled(id, enabled);

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: enabled ? "upgrader_output_enabled" : "upgrader_output_disabled",
      metadata: { via: "backend_api", output_card_id: id },
    });

    revalidatePath("/upgrader");
  } catch (err) {
    throw toActionError(err);
  }
}

/**
 * Validates the caller-supplied color before forwarding to the backend.
 * The frontend UI exposes a select with the 7 named tones, but we treat
 * the parameter as untrusted (server action surface) and reject anything
 * outside the allowlist — that way a stray client cannot persist an
 * arbitrary string the upgrader UI would later fail to theme.
 */
const ColorParamSchema = z
  .union([z.enum(UPGRADER_OUTPUT_COLORS), z.null()])
  .nullable();

export async function setUpgraderOutputColor(
  id: string,
  color: UpgraderOutputColor | null,
) {
  const session = await requirePageAccess("/upgrader");
  await requireCapability(
    session,
    "__can_toggle_upgrader_output",
    "update upgrader output cards",
  );

  const parsedColor = ColorParamSchema.parse(color);

  try {
    await upgraderApi.update(id, { color: parsedColor });

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "upgrader_output_color_changed",
      metadata: {
        via: "backend_api",
        output_card_id: id,
        color: parsedColor,
      },
    });

    revalidatePath("/upgrader");
  } catch (err) {
    throw toActionError(err);
  }
}

export async function removeUpgraderOutput(id: string) {
  const session = await requirePageAccess("/upgrader");
  await requireCapability(
    session,
    "__can_remove_upgrader_output",
    "remove upgrader output cards",
  );

  try {
    await upgraderApi.remove(id);

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "upgrader_output_removed",
      metadata: { via: "backend_api", output_card_id: id },
    });

    revalidatePath("/upgrader");
  } catch (err) {
    throw toActionError(err);
  }
}
