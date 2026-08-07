import "server-only";

import { backendApi } from "./client";

/**
 * Typed client for the backend's challenge admin surface. Mirrors the
 * `multiplierDealsApi` shape — every method maps 1:1 onto a single backend
 * endpoint under `/v1/admin/challenges/*`.
 *
 * IMPORTANT: challenge tables live in the MAIN game DB, which is strictly
 * read-only in this admin panel AND is not modelled in the admin database
 * schema. ALL challenge access — list, get, create, update, archive — MUST
 * go through this backend client. Never reach directly into MAIN for
 * challenges. The admin layer wraps each call with auth + audit in
 * `challenges/actions.ts`; this client only forwards requests.
 */

export type ChallengeGameType = "pack" | "battle" | "upgrader";
type ChallengeType = "pack_pull" | "upgrader";
export type ChallengeStatus = "active" | "inactive" | "archived";

type ChallengeRequirementKind = "pack_pull" | "upgrader";
type ChallengePercentOp = "lte" | "gte" | "eq";

/** A single requirement attached to a challenge (returned by get-one). */
type ChallengeRequirement = {
  id: string;
  kind: ChallengeRequirementKind;
  pack_id: string | null;
  card_id: string | null;
  // legacy upgrader fields (null for new upgrader rows)
  win_percentage: number | null;
  percent_op: ChallengePercentOp | null;
  // upgrader thresholds (new model): bet >= min_bet_usd AND multiplier >= min_multiplier
  min_bet_usd: number | null;
  min_multiplier: number | null;
};

/** Admin serialization of a challenge row. */
export type Challenge = {
  id: string;
  name: string;
  description: string | null;
  game_type: ChallengeGameType;
  type: ChallengeType;
  status: ChallengeStatus;
  prize_amount: number;
  max_claims: number;
  claimed_count: number;
  version: number;
  created_at: string;
  updated_at: string;
};

/** get-one additionally embeds the requirement list. */
export type ChallengeWithRequirements = Challenge & {
  requirements: ChallengeRequirement[];
};

type CreateChallengeRequirementInput = {
  kind: ChallengeRequirementKind;
  // pack_pull REQUIRES pack_id + card_id.
  pack_id?: string;
  card_id?: string;
  // upgrader is card-agnostic and REQUIRES min_bet_usd + min_multiplier
  // (a winning play must bet >= min_bet_usd AND hit a multiplier >= min_multiplier).
  min_bet_usd?: number;
  min_multiplier?: number;
};

export type CreateChallengeInput = {
  name: string;
  description?: string;
  game_type: ChallengeGameType;
  type: ChallengeType;
  prize_amount: number;
  max_claims: number;
  requirement: CreateChallengeRequirementInput;
};

export type UpdateChallengeInput = {
  expected_version: number;
  patch: Partial<{
    prize_amount: number;
    max_claims: number;
    status: ChallengeStatus;
  }>;
};

type Paginated<T> = {
  data: T[];
  total: number;
  offset: number;
  limit: number;
};

type Success<T> = { success: boolean; data: T };

export const challengesApi = {
  list: (
    query: {
      game_type?: ChallengeGameType;
      status?: ChallengeStatus;
      offset?: number;
      limit?: number;
    } = {},
  ) =>
    backendApi
      .get<Success<Paginated<Challenge>>>("/admin/challenges", { query })
      .then((r) => r.data),

  get: (id: string) =>
    backendApi
      .get<Success<ChallengeWithRequirements>>(
        `/admin/challenges/${encodeURIComponent(id)}`,
      )
      .then((r) => r.data),

  create: (input: CreateChallengeInput) =>
    backendApi
      .post<Success<Challenge>>("/admin/challenges", input)
      .then((r) => r.data),

  update: (id: string, input: UpdateChallengeInput) =>
    backendApi
      .patch<Success<Challenge>>(
        `/admin/challenges/${encodeURIComponent(id)}`,
        input,
      )
      .then((r) => r.data),

  archive: (id: string, expectedVersion: number) =>
    backendApi
      .delete<Success<Challenge>>(
        `/admin/challenges/${encodeURIComponent(id)}`,
        { expected_version: expectedVersion },
      )
      .then((r) => r.data),
};
