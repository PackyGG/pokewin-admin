import "server-only";

import { backendApi } from "./client";

/**
 * Live Keno configuration owned by the game backend.
 *
 * Source of truth:
 *   PackyGG/backend/src/routes/v1/admin/keno-config.ts
 *
 * `backendApi` already includes `/v1`, so these calls target
 * GET/PUT `/v1/admin/keno-config`.
 */
export type KenoConfig = {
  max_bet_usd: number;
};

export type UpdateKenoConfigInput = {
  max_bet_usd: number;
};

type Success<T> = { success: boolean; data: T };

export const getKenoConfig = () =>
  backendApi
    .get<Success<KenoConfig>>("/admin/keno-config")
    .then((response) => response.data);

export const updateKenoConfig = (input: UpdateKenoConfigInput) =>
  backendApi
    .put<Success<KenoConfig>>("/admin/keno-config", input)
    .then((response) => response.data);
