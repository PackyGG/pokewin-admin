import "server-only";

import { desc, eq } from "drizzle-orm";

import { getDrizzleDb } from "@/lib/db";
import {
  cards,
  upgrader_output_cards,
} from "@/lib/db-schema/main/schema";
import { backendApi } from "./client";
import type { UpgraderOutputColor } from "@/app/(admin)/upgrader/colors";

export type { UpgraderOutputColor };

export type UpgraderOutputCard = {
  id: string;
  card_id: string;
  enabled: boolean;
  // Color override stored on upgrader_output_cards.color. NULL = no
  // override; the upgrader UI renders the card with a neutral theme.
  color: string | null;
  name: string;
  image_url: string;
  price: number;
  rarity: string | null;
  created_at: string;
  updated_at: string;
};

export type AddUpgraderOutputsResult = {
  inserted: number;
  skipped: number;
};

type Success<T> = { success: boolean; data: T };
type SuccessMessage = { success: boolean; message: string };

/**
 * Partial-update payload for PATCH /admin/upgrader/outputs/:id. At least
 * one field must be provided — backend rejects an empty body. Send
 * `color: null` to explicitly clear an existing override.
 */
export type UpdateUpgraderOutputBody = {
  enabled?: boolean;
  color?: UpgraderOutputColor | null;
};

async function listOutputsFromPostgres(): Promise<UpgraderOutputCard[]> {
  const db = await getDrizzleDb();
  const rows = await db
    .select({
      id: upgrader_output_cards.id,
      card_id: upgrader_output_cards.card_id,
      enabled: upgrader_output_cards.enabled,
      color: upgrader_output_cards.color,
      name: cards.name,
      image_url: cards.image_url,
      price: cards.price,
      rarity: cards.rarity,
      created_at: upgrader_output_cards.created_at,
      updated_at: upgrader_output_cards.updated_at,
    })
    .from(upgrader_output_cards)
    .innerJoin(cards, eq(cards.id, upgrader_output_cards.card_id))
    .orderBy(desc(upgrader_output_cards.created_at));

  return rows.map((row) => ({
    ...row,
    price: Number(row.price),
  }));
}

export const upgraderApi = {
  listOutputs: async (): Promise<UpgraderOutputCard[]> => {
    try {
      return await backendApi
        .get<Success<UpgraderOutputCard[]>>("/admin/upgrader/outputs")
        .then((r) => r.data);
    } catch (error) {
      console.warn(
        "[upgrader-api] backend output read failed; using PostgreSQL",
        error,
      );
      return listOutputsFromPostgres();
    }
  },

  addOutputs: (card_ids: string[]) =>
    backendApi
      .post<Success<AddUpgraderOutputsResult>>("/admin/upgrader/outputs", {
        card_ids,
      })
      .then((r) => r.data),

  /**
   * Patch a single output card. The backend body is { enabled?, color? }
   * with the constraint that at least one is present, so callers should
   * provide only the field they want to change.
   */
  update: (id: string, body: UpdateUpgraderOutputBody) =>
    backendApi.patch<SuccessMessage>(
      `/admin/upgrader/outputs/${encodeURIComponent(id)}`,
      body,
    ),

  /** Convenience wrapper preserved for callers that only flip enabled. */
  setEnabled: (id: string, enabled: boolean) =>
    backendApi.patch<SuccessMessage>(
      `/admin/upgrader/outputs/${encodeURIComponent(id)}`,
      { enabled },
    ),

  remove: (id: string) =>
    backendApi.delete<SuccessMessage>(
      `/admin/upgrader/outputs/${encodeURIComponent(id)}`,
    ),
};
