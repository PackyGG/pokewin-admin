import "server-only";

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

export const upgraderApi = {
  listOutputs: () =>
    backendApi
      .get<Success<UpgraderOutputCard[]>>("/admin/upgrader/outputs")
      .then((r) => r.data),

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
