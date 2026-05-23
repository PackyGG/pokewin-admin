import "server-only";

import { backendApi } from "./client";

export type UpgraderOutputCard = {
  id: string;
  card_id: string;
  enabled: boolean;
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
