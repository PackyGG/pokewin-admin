import "server-only";

import { backendApi } from "./client";

type Success<T> = { success: boolean; data: T };

export type ActiveCodeRow = {
  user_id: string;
  affiliate_code: string | null;
  affiliate_code_active: boolean;
};

export type QuickCreateLeaderboardInput = {
  creator_user_id: string;
  affiliate_codes: string[];
  title?: string;
  site_bonus_usd?: number;
  duration_hours?: number;
};

export type QuickCreateLeaderboardResult = {
  id: string;
  creator_user_id: string;
  title: string;
  affiliate_codes: string[];
  site_bonus_usd: string;
  start_date: string;
  end_date: string;
};

export type EndNowResult = {
  id: string;
  end_date: string;
  previous_end_date: string;
};

export type InjectWagerInput = {
  referred_user_id: string;
  code: string;
  wager_amount_usd: number;
};

export type InjectWagerResult = {
  usage_id: string;
  code: string;
  affiliate_user_id: string;
  referred_user_id: string;
  wager_amount_usd: number;
};

export type TestingBattleOutcomeRule = {
  user_id: string;
  rule: "force_loss";
  remaining_battles: number;
};

/**
 * Backend client for the dev-only testing endpoints under /admin/testing.
 * Production builds of the backend return 404 for every method here, so
 * any UI calling these must already be hidden by the dbEnv gate.
 */
export const testingApi = {
  getBattleOutcomeRule: (userId: string) =>
    backendApi
      .get<Success<TestingBattleOutcomeRule>>(
        `/admin/testing/battles/users/${encodeURIComponent(userId)}/force-loss`,
      )
      .then((r) => r.data),

  setBattleOutcomeRule: (userId: string, battleCount: number) =>
    backendApi
      .put<Success<TestingBattleOutcomeRule>>(
        `/admin/testing/battles/users/${encodeURIComponent(userId)}/force-loss`,
        { battle_count: battleCount },
      )
      .then((r) => r.data),

  getActiveCode: (userId: string) =>
    backendApi
      .get<Success<ActiveCodeRow>>(
        `/admin/testing/users/${encodeURIComponent(userId)}/active-code`,
      )
      .then((r) => r.data),

  setActiveCode: (userId: string, code: string | null) =>
    backendApi
      .post<Success<ActiveCodeRow>>(
        `/admin/testing/users/${encodeURIComponent(userId)}/active-code`,
        { code },
      )
      .then((r) => r.data),

  quickCreateLeaderboard: (input: QuickCreateLeaderboardInput) =>
    backendApi
      .post<Success<QuickCreateLeaderboardResult>>(
        "/admin/testing/leaderboards/quick-create",
        input,
      )
      .then((r) => r.data),

  endLeaderboardNow: (id: string) =>
    backendApi
      .post<Success<EndNowResult>>(
        `/admin/testing/leaderboards/${encodeURIComponent(id)}/end-now`,
        {},
      )
      .then((r) => r.data),

  injectWager: (input: InjectWagerInput) =>
    backendApi
      .post<Success<InjectWagerResult>>("/admin/testing/wager/inject", input)
      .then((r) => r.data),
};
