import { randomInt } from "node:crypto";

import type pg from "pg";

export type BattleTestEnvironment = "dev" | "prod";

export type BattleTestOutcomeTarget = "loss" | "win" | "any";
export type BattleTestSelectionStrategy =
  | "random"
  | "lowest_profit"
  | "highest_profit"
  | "lowest_multiplier"
  | "highest_multiplier";

export type BattleTestUserRule = {
  target: BattleTestOutcomeTarget;
  strategy: BattleTestSelectionStrategy;
  count: number;
  minMultiplier?: number | null;
  maxMultiplier?: number | null;
};

export type BattleTestUserConfig = {
  environment?: BattleTestEnvironment;
  userId: string;
  username: string | null;
  rules: BattleTestUserRule[];
  currentRuleIndex: number;
  remainingInRule: number;
  persistent: boolean;
  randomized?: boolean;
  enabled: boolean;
  forceLosses: boolean;
  updatedAt: string;
  updatedBy: string | null;
};

export type BattleTestUserInstruction = Pick<
  BattleTestUserRule,
  "target" | "strategy" | "minMultiplier" | "maxMultiplier"
> & {
  source?: "user" | "global";
  mode?: "force_losses";
};

export type BattleTestInstructionContext = {
  hasWin: boolean;
  hasLoss: boolean;
};

export type BattleTestSelectionCandidateAudit = {
  blockNumber: number;
  winningTeam: number;
  creatorTeam: number;
  creatorWonBattle: boolean;
  creatorCost: number;
  creatorProfitLoss: number;
  creatorMultiplier: number | null;
};

export type BattleTestSelectionAudit = {
  battleId: string;
  createdAt: string;
  selectedAt: string;
  version: 1;
  source: "user" | "global" | "random";
  controlKind:
    | "user_rule"
    | "global_rule"
    | "user_force_losses"
    | "global_force_losses"
    | "legacy_global_losses"
    | "random";
  randomBlockNumber: number;
  battleMode: string;
  crazyMode: boolean;
  currency: string;
  requestedTarget: BattleTestOutcomeTarget | null;
  requestedStrategy: BattleTestSelectionStrategy | null;
  requestedMinMultiplier: number | null;
  requestedMaxMultiplier: number | null;
  fallbackReason: "target_unavailable" | "range_unavailable" | null;
  selected: BattleTestSelectionCandidateAudit;
  candidates: BattleTestSelectionCandidateAudit[];
};

export type BattleTestSelectionAuditInput = Omit<
  BattleTestSelectionAudit,
  "battleId" | "createdAt" | "selectedAt"
>;

export type BattleTestOverviewPeriod = {
  period: "24h" | "7d" | "30d";
  currency: "real" | "coin";
  battleCount: number;
  steeredBattles: number;
  matchedBattles: number;
  fallbackBattles: number;
  targetUnavailableBattles: number;
  rangeUnavailableBattles: number;
  forceLossBattles: number;
  creatorWinsAvoided: number;
  selectedWins: number;
  selectedLosses: number;
  selectedCreatorProfitLoss: number;
  randomBaselineCreatorProfitLoss: number;
  estimatedCreatorProfitReduction: number;
};

export type BattleTestOverview = {
  environment: BattleTestEnvironment;
  generatedAt: string;
  trackingStartedAt: string | null;
  periods: BattleTestOverviewPeriod[];
};

export type BattleTestConfig = {
  environment?: BattleTestEnvironment;
  userOnlyLoses: boolean;
  rules?: BattleTestUserRule[];
  currentRuleIndex?: number;
  remainingInRule?: number;
  persistent?: boolean;
  randomized?: boolean;
  enabled?: boolean;
  forceAllLosses?: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

export interface BattleTestConfigSource {
  get(): Promise<BattleTestConfig>;
  set(userOnlyLoses: boolean, actor: string): Promise<BattleTestConfig>;
  setFlow?(
    rules: BattleTestUserRule[],
    persistent: boolean,
    randomized: boolean,
    enabled: boolean,
    actor: string,
    forceAllLosses?: boolean,
  ): Promise<BattleTestConfig>;
  setEnabled?(
    enabled: boolean,
    actor: string,
  ): Promise<BattleTestConfig | null>;
  listUsers?(): Promise<BattleTestUserConfig[]>;
  setUser?(
    userId: string,
    username: string | null,
    rules: BattleTestUserRule[],
    persistent: boolean,
    enabled: boolean,
    actor: string,
  ): Promise<BattleTestUserConfig>;
  setUserFlow?(
    userId: string,
    username: string | null,
    rules: BattleTestUserRule[],
    persistent: boolean,
    randomized: boolean,
    enabled: boolean,
    actor: string,
    forceLosses?: boolean,
  ): Promise<BattleTestUserConfig>;
  setUserForceLosses?(
    userId: string,
    forceLosses: boolean,
    actor: string,
  ): Promise<BattleTestUserConfig | null>;
  setUserEnabled?(
    userId: string,
    enabled: boolean,
    actor: string,
  ): Promise<BattleTestUserConfig | null>;
  listUserSelections?(
    userId: string,
    limit: number,
  ): Promise<BattleTestSelectionAudit[]>;
  getOverview?(): Promise<BattleTestOverview>;
  deleteUser?(userId: string): Promise<void>;
  consumeUserInstruction?(
    userId: string,
    battleId: string,
    context?: BattleTestInstructionContext,
  ): Promise<BattleTestUserInstruction | null>;
  getBattleSelection?(
    userId: string,
    battleId: string,
  ): Promise<Record<string, unknown> | null>;
  saveBattleSelection?(
    userId: string,
    battleId: string,
    response: Record<string, unknown>,
    audit?: BattleTestSelectionAuditInput,
  ): Promise<Record<string, unknown>>;
}

type ConfigRow = {
  user_only_loses: boolean;
  rules: unknown;
  current_rule_index: number;
  remaining_in_rule: number;
  persistent: boolean;
  randomized: boolean;
  enabled: boolean;
  force_all_losses: boolean;
  updated_at: Date | string;
  updated_by: string | null;
};

type UserConfigRow = {
  environment: BattleTestEnvironment;
  user_id: string;
  username: string | null;
  rules: unknown;
  current_rule_index: number;
  remaining_in_rule: number;
  persistent: boolean;
  randomized: boolean;
  enabled: boolean;
  force_losses: boolean;
  updated_at: Date | string;
  updated_by: string | null;
};

const CACHE_MS = 2_000;

function mapRow(
  row: ConfigRow,
  environment: BattleTestEnvironment,
): BattleTestConfig {
  return {
    environment,
    userOnlyLoses: row.user_only_loses,
    rules: parseRules(row.rules),
    currentRuleIndex: row.current_rule_index,
    remainingInRule: row.remaining_in_rule,
    persistent: row.persistent,
    randomized: row.randomized,
    enabled: row.enabled,
    forceAllLosses: row.force_all_losses,
    updatedAt: new Date(row.updated_at).toISOString(),
    updatedBy: row.updated_by,
  };
}

const TARGETS = new Set<BattleTestOutcomeTarget>(["loss", "win", "any"]);
const STRATEGIES = new Set<BattleTestSelectionStrategy>([
  "random",
  "lowest_profit",
  "highest_profit",
  "lowest_multiplier",
  "highest_multiplier",
]);

function parseMultiplier(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "number" && Number.isFinite(value)
      && value >= 0 && value <= 10_000
    ? value
    : undefined;
}

function parseRules(value: unknown): BattleTestUserRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rule) => {
    if (!rule || typeof rule !== "object") return [];
    const candidate = rule as Record<string, unknown>;
    const minMultiplier = parseMultiplier(candidate.minMultiplier);
    const maxMultiplier = parseMultiplier(candidate.maxMultiplier);
    if (
      typeof candidate.target !== "string"
      || !TARGETS.has(candidate.target as BattleTestOutcomeTarget)
      || typeof candidate.strategy !== "string"
      || !STRATEGIES.has(candidate.strategy as BattleTestSelectionStrategy)
      || !Number.isSafeInteger(candidate.count)
      || (candidate.count as number) < 1
      || (candidate.count as number) > 100
      || minMultiplier === undefined
      || maxMultiplier === undefined
      || (minMultiplier !== null && maxMultiplier !== null
        && minMultiplier > maxMultiplier)
    ) return [];
    return [{
      target: candidate.target as BattleTestOutcomeTarget,
      strategy: candidate.strategy as BattleTestSelectionStrategy,
      count: candidate.count as number,
      minMultiplier,
      maxMultiplier,
    }];
  });
}

function mapUserRow(row: UserConfigRow): BattleTestUserConfig {
  return {
    environment: row.environment,
    userId: row.user_id,
    username: row.username,
    rules: parseRules(row.rules),
    currentRuleIndex: row.current_rule_index,
    remainingInRule: row.remaining_in_rule,
    persistent: row.persistent,
    randomized: row.randomized,
    enabled: row.enabled,
    forceLosses: row.force_losses,
    updatedAt: new Date(row.updated_at).toISOString(),
    updatedBy: row.updated_by,
  };
}

export class PgBattleTestConfigStore implements BattleTestConfigSource {
  private cached: { value: BattleTestConfig; expiresAt: number } | null = null;
  private nextSelectionCleanupAt = 0;

  /**
   * Every user-sequence query is scoped to `environment`. It comes from the
   * deployment's own config rather than the request, so a caller can never
   * reach into another environment's marks — and two deployments sharing one
   * antifraud database keep separate rows for the same userID.
   */
  constructor(
    private readonly pool: pg.Pool,
    private readonly environment: BattleTestEnvironment,
  ) {}

  async get(): Promise<BattleTestConfig> {
    if (this.cached && this.cached.expiresAt > Date.now()) {
      return this.cached.value;
    }
    const result = await this.pool.query<ConfigRow>(`
      SELECT user_only_loses, rules, current_rule_index, remaining_in_rule,
             persistent, randomized, enabled, force_all_losses, updated_at, updated_by
      FROM battle_test_config
      WHERE environment = $1
      LIMIT 1
    `, [this.environment]);
    const value: BattleTestConfig = result.rows[0]
      ? mapRow(result.rows[0], this.environment)
      : {
          environment: this.environment,
          userOnlyLoses: false,
          rules: [{
            target: "any", strategy: "random", count: 1,
            minMultiplier: null, maxMultiplier: null,
          }],
          currentRuleIndex: 0,
          remainingInRule: 1,
          persistent: true,
          randomized: false,
          enabled: false,
          forceAllLosses: false,
          updatedAt: null,
          updatedBy: null,
        };
    this.cached = { value, expiresAt: Date.now() + CACHE_MS };
    return value;
  }

  async set(userOnlyLoses: boolean, actor: string): Promise<BattleTestConfig> {
    return this.setFlow(
      [{
        target: userOnlyLoses ? "loss" : "any", strategy: "random", count: 1,
        minMultiplier: null, maxMultiplier: null,
      }],
      true,
      false,
      userOnlyLoses,
      actor,
      false,
    );
  }

  async setFlow(
    rules: BattleTestUserRule[],
    persistent: boolean,
    randomized: boolean,
    enabled: boolean,
    actor: string,
    forceAllLosses = false,
  ): Promise<BattleTestConfig> {
    const normalizedRules = parseRules(rules);
    if (normalizedRules.length === 0 || normalizedRules.length !== rules.length) {
      throw new Error("Invalid battle test global rules");
    }
    if (randomized && !persistent) {
      throw new Error("Randomized battle test flows must repeat");
    }
    const result = await this.pool.query<ConfigRow>(
      `
        INSERT INTO battle_test_config (
          singleton, environment, user_only_loses, rules, current_rule_index,
          remaining_in_rule, persistent, randomized, enabled, force_all_losses,
          updated_at, updated_by
        ) VALUES ($1 = 'dev', $1, false, $2::jsonb, 0, $3, $4, $5, $6, $7, now(), $8)
        ON CONFLICT (environment) DO UPDATE SET
          user_only_loses = false,
          rules = EXCLUDED.rules,
          current_rule_index = 0,
          remaining_in_rule = EXCLUDED.remaining_in_rule,
          persistent = EXCLUDED.persistent,
          randomized = EXCLUDED.randomized,
          enabled = EXCLUDED.enabled,
          force_all_losses = EXCLUDED.force_all_losses,
          updated_at = now(),
          updated_by = EXCLUDED.updated_by
        RETURNING user_only_loses, rules, current_rule_index, remaining_in_rule,
                  persistent, randomized, enabled, force_all_losses, updated_at, updated_by
      `,
      [this.environment, JSON.stringify(normalizedRules), normalizedRules[0]!.count,
       persistent, randomized, enabled, forceAllLosses, actor],
    );
    const value = mapRow(result.rows[0]!, this.environment);
    this.cached = { value, expiresAt: Date.now() + CACHE_MS };
    return value;
  }

  async listUsers(): Promise<BattleTestUserConfig[]> {
    const result = await this.pool.query<UserConfigRow>(
      `
        SELECT environment, user_id::text, username, rules, current_rule_index,
               remaining_in_rule, persistent, randomized, enabled, force_losses,
               updated_at, updated_by
        FROM battle_test_user_sequences
        WHERE environment = $1
        ORDER BY updated_at DESC
        LIMIT 200
      `,
      [this.environment],
    );
    return result.rows.map(mapUserRow);
  }

  async setEnabled(
    enabled: boolean,
    actor: string,
  ): Promise<BattleTestConfig | null> {
    const result = await this.pool.query<ConfigRow>(
      `UPDATE battle_test_config
       SET enabled = $2, updated_at = now(), updated_by = $3
       WHERE environment = $1
       RETURNING user_only_loses, rules, current_rule_index, remaining_in_rule,
                 persistent, randomized, enabled, force_all_losses, updated_at, updated_by`,
      [this.environment, enabled, actor],
    );
    if (!result.rows[0]) return null;
    const value = mapRow(result.rows[0], this.environment);
    this.cached = { value, expiresAt: Date.now() + CACHE_MS };
    return value;
  }

  async setUser(
    userId: string,
    username: string | null,
    rules: BattleTestUserRule[],
    persistent: boolean,
    enabled: boolean,
    actor: string,
  ): Promise<BattleTestUserConfig> {
    return this.setUserFlow(
      userId, username, rules, persistent, false, enabled, actor,
    );
  }

  async setUserFlow(
    userId: string,
    username: string | null,
    rules: BattleTestUserRule[],
    persistent: boolean,
    randomized: boolean,
    enabled: boolean,
    actor: string,
    forceLosses?: boolean,
  ): Promise<BattleTestUserConfig> {
    const normalizedRules = parseRules(rules);
    if (normalizedRules.length === 0 || normalizedRules.length !== rules.length) {
      throw new Error("Invalid battle test user rules");
    }
    if (randomized && !persistent) {
      throw new Error("Randomized battle test flows must repeat");
    }
    const result = await this.pool.query<UserConfigRow>(
      `
        INSERT INTO battle_test_user_sequences (
          environment, user_id, username, rules, current_rule_index,
          remaining_in_rule, persistent, randomized, enabled, force_losses,
          updated_at, updated_by
        ) VALUES ($9, $1, $2, $3::jsonb, 0, $4, $5, $6, $7,
                  COALESCE($10, false), now(), $8)
        ON CONFLICT (environment, user_id) DO UPDATE SET
          username = EXCLUDED.username,
          rules = EXCLUDED.rules,
          current_rule_index = 0,
          remaining_in_rule = EXCLUDED.remaining_in_rule,
          persistent = EXCLUDED.persistent,
          randomized = EXCLUDED.randomized,
          enabled = EXCLUDED.enabled,
          force_losses = COALESCE($10, battle_test_user_sequences.force_losses),
          updated_at = now(),
          updated_by = EXCLUDED.updated_by
        RETURNING environment, user_id::text, username, rules, current_rule_index,
                  remaining_in_rule, persistent, randomized, enabled, force_losses,
                  updated_at, updated_by
      `,
      [
        userId,
        username,
        JSON.stringify(normalizedRules),
        normalizedRules[0]!.count,
        persistent,
        randomized,
        enabled,
        actor,
        this.environment,
        forceLosses ?? null,
      ],
    );
    return mapUserRow(result.rows[0]!);
  }

  async setUserForceLosses(
    userId: string,
    forceLosses: boolean,
    actor: string,
  ): Promise<BattleTestUserConfig | null> {
    const result = await this.pool.query<UserConfigRow>(
      `UPDATE battle_test_user_sequences
       SET force_losses = $3, updated_at = now(), updated_by = $4
       WHERE environment = $1 AND user_id = $2
       RETURNING environment, user_id::text, username, rules, current_rule_index,
                 remaining_in_rule, persistent, randomized, enabled, force_losses,
                 updated_at, updated_by`,
      [this.environment, userId, forceLosses, actor],
    );
    return result.rows[0] ? mapUserRow(result.rows[0]) : null;
  }

  async setUserEnabled(
    userId: string,
    enabled: boolean,
    actor: string,
  ): Promise<BattleTestUserConfig | null> {
    const result = await this.pool.query<UserConfigRow>(
      `UPDATE battle_test_user_sequences
       SET enabled = $3, updated_at = now(), updated_by = $4
       WHERE environment = $1 AND user_id = $2
       RETURNING environment, user_id::text, username, rules, current_rule_index,
                 remaining_in_rule, persistent, randomized, enabled, force_losses,
                 updated_at, updated_by`,
      [this.environment, userId, enabled, actor],
    );
    return result.rows[0] ? mapUserRow(result.rows[0]) : null;
  }

  async deleteUser(userId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM battle_test_user_sequences WHERE environment = $1 AND user_id = $2",
      [this.environment, userId],
    );
  }

  async consumeUserInstruction(
    userId: string,
    battleId = "00000000-0000-0000-0000-000000000000",
    context?: BattleTestInstructionContext,
  ): Promise<BattleTestUserInstruction | null> {
    const client = await this.pool.connect();
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN");
      const reservation = await client.query<{ battle_id: string }>(
        `INSERT INTO battle_test_eos_selections
           (environment, battle_id, user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (environment, battle_id) DO NOTHING
         RETURNING battle_id::text`,
        [this.environment, battleId, userId],
      );
      if (!reservation.rows[0]) {
        const existing = await client.query<{ user_id: string; instruction: unknown }>(
          `SELECT user_id, instruction
           FROM battle_test_eos_selections
           WHERE environment = $1 AND battle_id = $2
           FOR UPDATE`,
          [this.environment, battleId],
        );
        if (existing.rows[0]?.user_id !== userId) {
          throw new Error("EOS battle reservation user mismatch");
        }
        await client.query("COMMIT");
        return parseInstruction(existing.rows[0]?.instruction);
      }
      const result = await client.query<UserConfigRow>(
        `
          SELECT environment, user_id::text, username, rules, current_rule_index,
                 remaining_in_rule, persistent, randomized, enabled, force_losses,
                 updated_at, updated_by
          FROM battle_test_user_sequences
          WHERE environment = $1 AND user_id = $2
          FOR UPDATE
        `,
        [this.environment, userId],
      );
      const row = result.rows[0];
      let instruction: BattleTestUserInstruction | null = null;
      const override = await client.query<{ force_all_losses: boolean }>(
        `SELECT force_all_losses FROM battle_test_config
         WHERE environment = $1`,
        [this.environment],
      );
      if (override.rows[0]?.force_all_losses) {
        instruction = {
          target: "loss",
          strategy: "lowest_profit",
          minMultiplier: null,
          maxMultiplier: null,
          source: "global",
          mode: "force_losses",
        };
      } else if (row?.force_losses) {
        instruction = {
          target: "loss",
          strategy: "lowest_profit",
          minMultiplier: null,
          maxMultiplier: null,
          source: "user",
          mode: "force_losses",
        };
      } else if (row?.enabled) {
        instruction = await consumeFlow(client, {
          environment: this.environment,
          table: "battle_test_user_sequences",
          userId,
          row,
          source: "user",
          context,
        });
      } else {
        const global = await client.query<ConfigRow>(
          `SELECT user_only_loses, rules, current_rule_index, remaining_in_rule,
                  persistent, randomized, enabled, force_all_losses,
                  updated_at, updated_by
           FROM battle_test_config
           WHERE environment = $1
           FOR UPDATE`,
          [this.environment],
        );
        if (global.rows[0]?.enabled) {
          instruction = await consumeFlow(client, {
            environment: this.environment,
            table: "battle_test_config",
            row: global.rows[0],
            source: "global",
            context,
          });
        }
      }
      await saveReservationInstruction(client, this.environment, battleId, instruction);
      await client.query("COMMIT");
      if (instruction?.source === "global") this.cached = null;
      await this.maybeCleanupSelections();
      return instruction;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        // Preserve the operation error that explains why the request failed,
        // but evict a connection that could not reset its transaction state.
        releaseError = rollbackError instanceof Error
          ? rollbackError
          : new Error("EOS battle transaction rollback failed");
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  private async maybeCleanupSelections(): Promise<void> {
    if (this.nextSelectionCleanupAt > Date.now()) return;
    this.nextSelectionCleanupAt = Date.now() + 60 * 60 * 1_000;
    try {
      await this.pool.query(
        `WITH expired AS (
           SELECT ctid FROM battle_test_eos_selections
           WHERE created_at < now() - interval '30 days'
           ORDER BY created_at
           LIMIT 500
         )
         DELETE FROM battle_test_eos_selections
         WHERE ctid IN (SELECT ctid FROM expired)`,
      );
    } catch {
      this.nextSelectionCleanupAt = Date.now() + 5 * 60 * 1_000;
    }
  }

  async getBattleSelection(
    userId: string,
    battleId: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query<{ response: unknown }>(
      `SELECT response FROM battle_test_eos_selections
       WHERE environment = $1 AND battle_id = $2 AND user_id = $3`,
      [this.environment, battleId, userId],
    );
    const response = result.rows[0]?.response;
    return response && typeof response === "object" && !Array.isArray(response)
      ? response as Record<string, unknown>
      : null;
  }

  async listUserSelections(
    userId: string,
    limit: number,
  ): Promise<BattleTestSelectionAudit[]> {
    const result = await this.pool.query<{
      battle_id: string;
      audit: unknown;
      created_at: Date | string;
      selected_at: Date | string;
    }>(
      `SELECT battle_id::text, audit, created_at, selected_at
       FROM battle_test_eos_selections
       WHERE environment = $1 AND user_id = $2
         AND audit IS NOT NULL AND response IS NOT NULL AND selected_at IS NOT NULL
       ORDER BY created_at DESC
       LIMIT $3`,
      [this.environment, userId, Math.max(1, Math.min(50, limit))],
    );
    return result.rows.flatMap((row) => {
      const audit = parseSelectionAudit(row.audit);
      return audit ? [{
        battleId: row.battle_id,
        createdAt: new Date(row.created_at).toISOString(),
        selectedAt: new Date(row.selected_at).toISOString(),
        ...audit,
      }] : [];
    });
  }

  async getOverview(): Promise<BattleTestOverview> {
    const result = await this.pool.query<{
      period: BattleTestOverviewPeriod["period"];
      currency: BattleTestOverviewPeriod["currency"];
      tracking_started_at: Date | string | null;
      battle_count: string;
      steered_battles: string;
      matched_battles: string;
      fallback_battles: string;
      target_unavailable_battles: string;
      range_unavailable_battles: string;
      force_loss_battles: string;
      creator_wins_avoided: string;
      selected_wins: string;
      selected_losses: string;
      selected_creator_profit_loss: string;
      random_baseline_creator_profit_loss: string;
      estimated_creator_profit_reduction: string;
    }>(
      `WITH raw AS (
         SELECT s.selected_at AS occurred_at,
                s.audit->>'controlKind' AS control_kind,
                s.audit->>'currency' AS currency,
                s.audit->>'fallbackReason' AS fallback_reason,
                CASE WHEN jsonb_typeof(s.audit#>'{selected,creatorWonBattle}') = 'boolean'
                  THEN (s.audit#>>'{selected,creatorWonBattle}')::boolean END AS selected_win,
                CASE WHEN jsonb_typeof(s.audit#>'{selected,creatorProfitLoss}') = 'number'
                  THEN (s.audit#>>'{selected,creatorProfitLoss}')::numeric END AS selected_profit,
                CASE WHEN jsonb_typeof(baseline.value->'creatorProfitLoss') = 'number'
                  THEN (baseline.value->>'creatorProfitLoss')::numeric END AS baseline_profit,
                CASE WHEN jsonb_typeof(baseline.value->'creatorWonBattle') = 'boolean'
                  THEN (baseline.value->>'creatorWonBattle')::boolean END AS baseline_win
         FROM battle_test_eos_selections s
         JOIN LATERAL (
           SELECT candidate AS value
           FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(s.audit->'candidates') = 'array'
               THEN s.audit->'candidates' ELSE '[]'::jsonb END
           ) AS candidate
           WHERE jsonb_typeof(candidate->'blockNumber') = 'number'
             AND jsonb_typeof(candidate->'creatorProfitLoss') = 'number'
             AND candidate->'blockNumber' = s.audit->'randomBlockNumber'
           LIMIT 1
         ) baseline ON true
         WHERE s.environment = $1
           AND s.audit IS NOT NULL AND s.response IS NOT NULL
           AND s.selected_at IS NOT NULL
           AND s.selected_at >= now() - interval '30 days'
           AND s.audit->>'version' = '1'
           AND s.audit->>'controlKind' IN (
             'user_rule', 'global_rule', 'user_force_losses',
             'global_force_losses', 'legacy_global_losses', 'random'
           )
           AND s.audit->>'currency' IN ('real', 'coin')
           AND jsonb_typeof(s.audit->'randomBlockNumber') = 'number'
       ), valid AS (
         SELECT * FROM raw
         WHERE selected_win IS NOT NULL
           AND selected_profit IS NOT NULL
           AND baseline_profit IS NOT NULL
           AND baseline_win IS NOT NULL
       ), periods(period, since_at, sort_order) AS (
         VALUES
           ('24h'::text, now() - interval '24 hours', 1),
           ('7d'::text, now() - interval '7 days', 2),
           ('30d'::text, now() - interval '30 days', 3)
       ), currencies(currency) AS (
         VALUES ('real'::text), ('coin'::text)
       )
       SELECT periods.period, currencies.currency,
              (SELECT min(occurred_at) FROM valid) AS tracking_started_at,
              count(valid.occurred_at)::text AS battle_count,
              count(*) FILTER (WHERE valid.control_kind <> 'random')::text AS steered_battles,
              count(*) FILTER (
                WHERE valid.control_kind <> 'random' AND valid.fallback_reason IS NULL
              )::text AS matched_battles,
              count(*) FILTER (
                WHERE valid.control_kind <> 'random'
                  AND valid.fallback_reason IS NOT NULL
              )::text AS fallback_battles,
              count(*) FILTER (
                WHERE valid.control_kind <> 'random'
                  AND valid.fallback_reason = 'target_unavailable'
              )::text AS target_unavailable_battles,
              count(*) FILTER (
                WHERE valid.control_kind <> 'random'
                  AND valid.fallback_reason = 'range_unavailable'
              )::text AS range_unavailable_battles,
              count(*) FILTER (
                WHERE valid.control_kind IN (
                  'user_force_losses', 'global_force_losses', 'legacy_global_losses'
                )
              )::text AS force_loss_battles,
              count(*) FILTER (
                WHERE valid.control_kind <> 'random'
                  AND valid.baseline_win AND NOT valid.selected_win
              )::text AS creator_wins_avoided,
              count(*) FILTER (
                WHERE valid.control_kind <> 'random' AND valid.selected_win
              )::text AS selected_wins,
              count(*) FILTER (
                WHERE valid.control_kind <> 'random' AND NOT valid.selected_win
              )::text AS selected_losses,
              coalesce(sum(valid.selected_profit) FILTER (
                WHERE valid.control_kind <> 'random'
              ), 0)::text AS selected_creator_profit_loss,
              coalesce(sum(valid.baseline_profit) FILTER (
                WHERE valid.control_kind <> 'random'
              ), 0)::text AS random_baseline_creator_profit_loss,
              coalesce(sum(valid.baseline_profit - valid.selected_profit) FILTER (
                WHERE valid.control_kind <> 'random'
              ), 0)::text AS estimated_creator_profit_reduction
       FROM periods
       CROSS JOIN currencies
       LEFT JOIN valid ON valid.occurred_at >= periods.since_at
         AND valid.currency = currencies.currency
       GROUP BY periods.period, periods.sort_order, currencies.currency
       ORDER BY periods.sort_order, currencies.currency`,
      [this.environment],
    );
    const asNumber = (value: string): number => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return {
      environment: this.environment,
      generatedAt: new Date().toISOString(),
      trackingStartedAt: result.rows[0]?.tracking_started_at
        ? new Date(result.rows[0].tracking_started_at).toISOString()
        : null,
      periods: result.rows.map((row) => ({
        period: row.period,
        currency: row.currency,
        battleCount: asNumber(row.battle_count),
        steeredBattles: asNumber(row.steered_battles),
        matchedBattles: asNumber(row.matched_battles),
        fallbackBattles: asNumber(row.fallback_battles),
        targetUnavailableBattles: asNumber(row.target_unavailable_battles),
        rangeUnavailableBattles: asNumber(row.range_unavailable_battles),
        forceLossBattles: asNumber(row.force_loss_battles),
        creatorWinsAvoided: asNumber(row.creator_wins_avoided),
        selectedWins: asNumber(row.selected_wins),
        selectedLosses: asNumber(row.selected_losses),
        selectedCreatorProfitLoss: asNumber(row.selected_creator_profit_loss),
        randomBaselineCreatorProfitLoss: asNumber(row.random_baseline_creator_profit_loss),
        estimatedCreatorProfitReduction: asNumber(
          row.estimated_creator_profit_reduction,
        ),
      })),
    };
  }

  async saveBattleSelection(
    userId: string,
    battleId: string,
    response: Record<string, unknown>,
    audit?: BattleTestSelectionAuditInput,
  ): Promise<Record<string, unknown>> {
    const result = await this.pool.query<{ response: Record<string, unknown> }>(
      `UPDATE battle_test_eos_selections
       SET response = COALESCE(response, $4::jsonb),
           audit = CASE WHEN response IS NULL THEN $5::jsonb ELSE audit END,
           selected_at = COALESCE(selected_at, now())
       WHERE environment = $1 AND battle_id = $2 AND user_id = $3
       RETURNING response`,
      [
        this.environment,
        battleId,
        userId,
        JSON.stringify(response),
        audit ? JSON.stringify(audit) : null,
      ],
    );
    if (!result.rows[0]) throw new Error("EOS battle reservation is missing");
    return result.rows[0].response;
  }
}

function parseSelectionCandidateAudit(
  value: unknown,
): BattleTestSelectionCandidateAudit | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return Number.isSafeInteger(row.blockNumber)
      && Number.isSafeInteger(row.winningTeam)
      && Number.isSafeInteger(row.creatorTeam)
      && typeof row.creatorWonBattle === "boolean"
      && typeof row.creatorCost === "number"
      && Number.isFinite(row.creatorCost)
      && typeof row.creatorProfitLoss === "number"
      && Number.isFinite(row.creatorProfitLoss)
      && (row.creatorMultiplier === null
        || (typeof row.creatorMultiplier === "number"
          && Number.isFinite(row.creatorMultiplier)))
    ? {
        blockNumber: row.blockNumber as number,
        winningTeam: row.winningTeam as number,
        creatorTeam: row.creatorTeam as number,
        creatorWonBattle: row.creatorWonBattle,
        creatorCost: row.creatorCost,
        creatorProfitLoss: row.creatorProfitLoss,
        creatorMultiplier: row.creatorMultiplier as number | null,
      }
    : null;
}

function parseSelectionAudit(value: unknown): BattleTestSelectionAuditInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const selected = parseSelectionCandidateAudit(row.selected);
  const candidates = Array.isArray(row.candidates)
    ? row.candidates.map(parseSelectionCandidateAudit)
    : [];
  const source = row.source === "user" || row.source === "global"
      || row.source === "random"
    ? row.source
    : null;
  const controlKinds = new Set<BattleTestSelectionAuditInput["controlKind"]>([
    "user_rule",
    "global_rule",
    "user_force_losses",
    "global_force_losses",
    "legacy_global_losses",
    "random",
  ]);
  const controlKind = typeof row.controlKind === "string"
      && controlKinds.has(row.controlKind as BattleTestSelectionAuditInput["controlKind"])
    ? row.controlKind as BattleTestSelectionAuditInput["controlKind"]
    : null;
  const target = row.requestedTarget === null
      || (typeof row.requestedTarget === "string"
        && TARGETS.has(row.requestedTarget as BattleTestOutcomeTarget))
    ? row.requestedTarget as BattleTestOutcomeTarget | null
    : undefined;
  const strategy = row.requestedStrategy === null
      || (typeof row.requestedStrategy === "string"
        && STRATEGIES.has(row.requestedStrategy as BattleTestSelectionStrategy))
    ? row.requestedStrategy as BattleTestSelectionStrategy | null
    : undefined;
  const fallbackReason = row.fallbackReason === null
      || row.fallbackReason === "target_unavailable"
      || row.fallbackReason === "range_unavailable"
    ? row.fallbackReason
    : undefined;
  const requestedMinMultiplier = parseMultiplier(row.requestedMinMultiplier);
  const requestedMaxMultiplier = parseMultiplier(row.requestedMaxMultiplier);
  return row.version === 1 && source && controlKind
      && Number.isSafeInteger(row.randomBlockNumber)
      && typeof row.battleMode === "string" && row.battleMode.length <= 50
      && typeof row.crazyMode === "boolean"
      && typeof row.currency === "string" && row.currency.length <= 50
      && target !== undefined && strategy !== undefined
      && requestedMinMultiplier !== undefined
      && requestedMaxMultiplier !== undefined
      && fallbackReason !== undefined && selected
      && candidates.length === 5 && candidates.every(Boolean)
    ? {
        version: 1,
        source,
        controlKind,
        randomBlockNumber: row.randomBlockNumber as number,
        battleMode: row.battleMode,
        crazyMode: row.crazyMode,
        currency: row.currency,
        requestedTarget: target,
        requestedStrategy: strategy,
        requestedMinMultiplier,
        requestedMaxMultiplier,
        fallbackReason,
        selected,
        candidates: candidates as BattleTestSelectionCandidateAudit[],
      }
    : null;
}

function parseInstruction(value: unknown): BattleTestUserInstruction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const minMultiplier = parseMultiplier(record.minMultiplier);
  const maxMultiplier = parseMultiplier(record.maxMultiplier);
  const source = record.source === undefined
    ? undefined
    : record.source === "user" || record.source === "global"
      ? record.source
      : null;
  const mode = record.mode === undefined
    ? undefined
    : record.mode === "force_losses"
      ? record.mode
      : null;
  return typeof record.target === "string"
      && TARGETS.has(record.target as BattleTestOutcomeTarget)
      && typeof record.strategy === "string"
      && STRATEGIES.has(record.strategy as BattleTestSelectionStrategy)
      && minMultiplier !== undefined
      && maxMultiplier !== undefined
      && (minMultiplier === null || maxMultiplier === null
        || minMultiplier <= maxMultiplier)
      && source !== null
      && mode !== null
    ? {
        target: record.target as BattleTestOutcomeTarget,
        strategy: record.strategy as BattleTestSelectionStrategy,
        minMultiplier,
        maxMultiplier,
        ...(source ? { source } : {}),
        ...(mode ? { mode } : {}),
      }
    : null;
}

async function saveReservationInstruction(
  client: pg.PoolClient,
  environment: BattleTestEnvironment,
  battleId: string,
  instruction: BattleTestUserInstruction | null,
): Promise<void> {
  await client.query(
    `UPDATE battle_test_eos_selections SET instruction = $3::jsonb
     WHERE environment = $1 AND battle_id = $2`,
    [environment, battleId, instruction ? JSON.stringify(instruction) : null],
  );
}

type FlowRow = Pick<
  UserConfigRow,
  "rules" | "current_rule_index" | "remaining_in_rule" | "persistent" | "randomized" | "enabled"
>;

function instructionForRule(
  rule: BattleTestUserRule,
  source: "user" | "global",
): BattleTestUserInstruction {
  return {
    target: rule.target,
    strategy: rule.strategy,
    minMultiplier: rule.minMultiplier ?? null,
    maxMultiplier: rule.maxMultiplier ?? null,
    ...(source === "global" ? { source } : {}),
  };
}

async function consumeFlow(
  client: pg.PoolClient,
  input: {
    environment: BattleTestEnvironment;
    table: "battle_test_config" | "battle_test_user_sequences";
    userId?: string;
    row: FlowRow;
    source: "user" | "global";
    context?: BattleTestInstructionContext;
  },
): Promise<BattleTestUserInstruction | null> {
  const rules = parseRules(input.row.rules);
  if (rules.length === 0) return null;

  if (input.row.persistent && rules.length === 1) {
    return instructionForRule(rules[0]!, input.source);
  }

  if (input.row.randomized) {
    const totalWeight = rules.reduce((sum, rule) => sum + rule.count, 0);
    let ticket = randomInt(totalWeight);
    let selected = rules[0]!;
    for (const rule of rules) {
      if (ticket < rule.count) {
        selected = rule;
        break;
      }
      ticket -= rule.count;
    }
    return instructionForRule(selected, input.source);
  }

  const rule = rules[input.row.current_rule_index];
  if (!rule) return null;
  const targetAvailable = rule.target === "any"
    || input.context === undefined
    || (rule.target === "win" ? input.context.hasWin : input.context.hasLoss);
  // Ordered flows describe outcomes, not attempts. Keep an unavailable win or
  // loss at the front of the sequence so the next battle retries it instead
  // of silently consuming the step with the opposite fallback outcome.
  if (!targetAvailable) return instructionForRule(rule, input.source);
  const remaining = input.row.remaining_in_rule > 0
    ? input.row.remaining_in_rule
    : rule.count;
  const ruleComplete = remaining <= 1;
  const atEnd = input.row.current_rule_index >= rules.length - 1;
  const nextIndex = ruleComplete
    ? (atEnd && input.row.persistent ? 0 : input.row.current_rule_index + 1)
    : input.row.current_rule_index;
  const nextRule = rules[nextIndex];
  const nextEnabled = input.row.persistent || !atEnd || !ruleComplete;
  const params = input.table === "battle_test_user_sequences"
    ? [input.environment, input.userId, nextIndex,
       ruleComplete ? (nextRule?.count ?? 0) : remaining - 1, nextEnabled]
    : [input.environment, nextIndex,
       ruleComplete ? (nextRule?.count ?? 0) : remaining - 1, nextEnabled];
  await client.query(
    input.table === "battle_test_user_sequences"
      ? `UPDATE battle_test_user_sequences
         SET current_rule_index = $3, remaining_in_rule = $4, enabled = $5
         WHERE environment = $1 AND user_id = $2`
      : `UPDATE battle_test_config
         SET current_rule_index = $2, remaining_in_rule = $3, enabled = $4
         WHERE environment = $1`,
    params,
  );
  return instructionForRule(rule, input.source);
}
