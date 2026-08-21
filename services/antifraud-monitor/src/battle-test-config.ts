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
  updatedAt: string;
  updatedBy: string | null;
};

export type BattleTestUserInstruction = Pick<
  BattleTestUserRule,
  "target" | "strategy" | "minMultiplier" | "maxMultiplier"
> & { source?: "user" | "global" };

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
  ): Promise<BattleTestUserConfig>;
  deleteUser?(userId: string): Promise<void>;
  consumeUserInstruction?(
    userId: string,
    battleId: string,
  ): Promise<BattleTestUserInstruction | null>;
  getBattleSelection?(
    userId: string,
    battleId: string,
  ): Promise<Record<string, unknown> | null>;
  saveBattleSelection?(
    userId: string,
    battleId: string,
    response: Record<string, unknown>,
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
               remaining_in_rule, persistent, randomized, enabled, updated_at, updated_by
        FROM battle_test_user_sequences
        WHERE environment = $1
        ORDER BY updated_at DESC
        LIMIT 200
      `,
      [this.environment],
    );
    return result.rows.map(mapUserRow);
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
          remaining_in_rule, persistent, randomized, enabled, updated_at, updated_by
        ) VALUES ($9, $1, $2, $3::jsonb, 0, $4, $5, $6, $7, now(), $8)
        ON CONFLICT (environment, user_id) DO UPDATE SET
          username = EXCLUDED.username,
          rules = EXCLUDED.rules,
          current_rule_index = 0,
          remaining_in_rule = EXCLUDED.remaining_in_rule,
          persistent = EXCLUDED.persistent,
          randomized = EXCLUDED.randomized,
          enabled = EXCLUDED.enabled,
          updated_at = now(),
          updated_by = EXCLUDED.updated_by
        RETURNING environment, user_id::text, username, rules, current_rule_index,
                  remaining_in_rule, persistent, randomized, enabled, updated_at, updated_by
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
      ],
    );
    return mapUserRow(result.rows[0]!);
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
                 remaining_in_rule, persistent, randomized, enabled, updated_at, updated_by
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
        };
      } else if (row?.enabled) {
        instruction = await consumeFlow(client, {
          environment: this.environment,
          table: "battle_test_user_sequences",
          userId,
          row,
          source: "user",
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

  async saveBattleSelection(
    userId: string,
    battleId: string,
    response: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await this.pool.query<{ response: Record<string, unknown> }>(
      `UPDATE battle_test_eos_selections
       SET response = COALESCE(response, $4::jsonb),
           selected_at = COALESCE(selected_at, now())
       WHERE environment = $1 AND battle_id = $2 AND user_id = $3
       RETURNING response`,
      [this.environment, battleId, userId, JSON.stringify(response)],
    );
    if (!result.rows[0]) throw new Error("EOS battle reservation is missing");
    return result.rows[0].response;
  }
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
  return typeof record.target === "string"
      && TARGETS.has(record.target as BattleTestOutcomeTarget)
      && typeof record.strategy === "string"
      && STRATEGIES.has(record.strategy as BattleTestSelectionStrategy)
      && minMultiplier !== undefined
      && maxMultiplier !== undefined
      && (minMultiplier === null || maxMultiplier === null
        || minMultiplier <= maxMultiplier)
      && source !== null
    ? {
        target: record.target as BattleTestOutcomeTarget,
        strategy: record.strategy as BattleTestSelectionStrategy,
        minMultiplier,
        maxMultiplier,
        ...(source ? { source } : {}),
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
