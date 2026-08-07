import type pg from "pg";

export type BattleTestOutcomeTarget = "loss" | "win" | "any";
export type BattleTestSelectionStrategy =
  | "random"
  | "lowest_profit"
  | "highest_profit";

export type BattleTestUserRule = {
  target: BattleTestOutcomeTarget;
  strategy: BattleTestSelectionStrategy;
  count: number;
};

export type BattleTestUserConfig = {
  userId: string;
  username: string | null;
  rules: BattleTestUserRule[];
  currentRuleIndex: number;
  remainingInRule: number;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
};

export type BattleTestUserInstruction = Pick<
  BattleTestUserRule,
  "target" | "strategy"
>;

export type BattleTestConfig = {
  userOnlyLoses: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

export interface BattleTestConfigSource {
  get(): Promise<BattleTestConfig>;
  set(userOnlyLoses: boolean, actor: string): Promise<BattleTestConfig>;
  listUsers?(): Promise<BattleTestUserConfig[]>;
  setUser?(
    userId: string,
    username: string | null,
    rules: BattleTestUserRule[],
    enabled: boolean,
    actor: string,
  ): Promise<BattleTestUserConfig>;
  deleteUser?(userId: string): Promise<void>;
  consumeUserInstruction?(
    userId: string,
  ): Promise<BattleTestUserInstruction | null>;
}

type ConfigRow = {
  user_only_loses: boolean;
  updated_at: Date | string;
  updated_by: string | null;
};

type UserConfigRow = {
  user_id: string;
  username: string | null;
  rules: unknown;
  current_rule_index: number;
  remaining_in_rule: number;
  enabled: boolean;
  updated_at: Date | string;
  updated_by: string | null;
};

const CACHE_MS = 2_000;

function mapRow(row: ConfigRow): BattleTestConfig {
  return {
    userOnlyLoses: row.user_only_loses,
    updatedAt: new Date(row.updated_at).toISOString(),
    updatedBy: row.updated_by,
  };
}

const TARGETS = new Set<BattleTestOutcomeTarget>(["loss", "win", "any"]);
const STRATEGIES = new Set<BattleTestSelectionStrategy>([
  "random",
  "lowest_profit",
  "highest_profit",
]);

function parseRules(value: unknown): BattleTestUserRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rule) => {
    if (!rule || typeof rule !== "object") return [];
    const candidate = rule as Record<string, unknown>;
    if (
      typeof candidate.target !== "string"
      || !TARGETS.has(candidate.target as BattleTestOutcomeTarget)
      || typeof candidate.strategy !== "string"
      || !STRATEGIES.has(candidate.strategy as BattleTestSelectionStrategy)
      || !Number.isSafeInteger(candidate.count)
      || (candidate.count as number) < 1
      || (candidate.count as number) > 100
    ) return [];
    return [{
      target: candidate.target as BattleTestOutcomeTarget,
      strategy: candidate.strategy as BattleTestSelectionStrategy,
      count: candidate.count as number,
    }];
  });
}

function mapUserRow(row: UserConfigRow): BattleTestUserConfig {
  return {
    userId: row.user_id,
    username: row.username,
    rules: parseRules(row.rules),
    currentRuleIndex: row.current_rule_index,
    remainingInRule: row.remaining_in_rule,
    enabled: row.enabled,
    updatedAt: new Date(row.updated_at).toISOString(),
    updatedBy: row.updated_by,
  };
}

export class PgBattleTestConfigStore implements BattleTestConfigSource {
  private cached: { value: BattleTestConfig; expiresAt: number } | null = null;

  constructor(private readonly pool: pg.Pool) {}

  async get(): Promise<BattleTestConfig> {
    if (this.cached && this.cached.expiresAt > Date.now()) {
      return this.cached.value;
    }
    const result = await this.pool.query<ConfigRow>(`
      SELECT user_only_loses, updated_at, updated_by
      FROM battle_test_config
      WHERE singleton = true
      LIMIT 1
    `);
    const value = result.rows[0]
      ? mapRow(result.rows[0])
      : { userOnlyLoses: false, updatedAt: null, updatedBy: null };
    this.cached = { value, expiresAt: Date.now() + CACHE_MS };
    return value;
  }

  async set(userOnlyLoses: boolean, actor: string): Promise<BattleTestConfig> {
    const result = await this.pool.query<ConfigRow>(
      `
        INSERT INTO battle_test_config (
          singleton, user_only_loses, updated_at, updated_by
        ) VALUES (true, $1, now(), $2)
        ON CONFLICT (singleton) DO UPDATE SET
          user_only_loses = EXCLUDED.user_only_loses,
          updated_at = now(),
          updated_by = EXCLUDED.updated_by
        RETURNING user_only_loses, updated_at, updated_by
      `,
      [userOnlyLoses, actor],
    );
    const value = mapRow(result.rows[0]!);
    this.cached = { value, expiresAt: Date.now() + CACHE_MS };
    return value;
  }

  async listUsers(): Promise<BattleTestUserConfig[]> {
    const result = await this.pool.query<UserConfigRow>(`
      SELECT user_id::text, username, rules, current_rule_index,
             remaining_in_rule, enabled, updated_at, updated_by
      FROM battle_test_user_sequences
      ORDER BY updated_at DESC
      LIMIT 200
    `);
    return result.rows.map(mapUserRow);
  }

  async setUser(
    userId: string,
    username: string | null,
    rules: BattleTestUserRule[],
    enabled: boolean,
    actor: string,
  ): Promise<BattleTestUserConfig> {
    const normalizedRules = parseRules(rules);
    if (normalizedRules.length === 0 || normalizedRules.length !== rules.length) {
      throw new Error("Invalid battle test user rules");
    }
    const result = await this.pool.query<UserConfigRow>(
      `
        INSERT INTO battle_test_user_sequences (
          user_id, username, rules, current_rule_index, remaining_in_rule,
          enabled, updated_at, updated_by
        ) VALUES ($1::uuid, $2, $3::jsonb, 0, $4, $5, now(), $6)
        ON CONFLICT (user_id) DO UPDATE SET
          username = EXCLUDED.username,
          rules = EXCLUDED.rules,
          current_rule_index = 0,
          remaining_in_rule = EXCLUDED.remaining_in_rule,
          enabled = EXCLUDED.enabled,
          updated_at = now(),
          updated_by = EXCLUDED.updated_by
        RETURNING user_id::text, username, rules, current_rule_index,
                  remaining_in_rule, enabled, updated_at, updated_by
      `,
      [
        userId,
        username,
        JSON.stringify(normalizedRules),
        normalizedRules[0]!.count,
        enabled,
        actor,
      ],
    );
    return mapUserRow(result.rows[0]!);
  }

  async deleteUser(userId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM battle_test_user_sequences WHERE user_id = $1::uuid",
      [userId],
    );
  }

  async consumeUserInstruction(
    userId: string,
  ): Promise<BattleTestUserInstruction | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<UserConfigRow>(
        `
          SELECT user_id::text, username, rules, current_rule_index,
                 remaining_in_rule, enabled, updated_at, updated_by
          FROM battle_test_user_sequences
          WHERE user_id = $1::uuid
          FOR UPDATE
        `,
        [userId],
      );
      const row = result.rows[0];
      if (!row || !row.enabled) {
        await client.query("COMMIT");
        return null;
      }
      const rules = parseRules(row.rules);
      const rule = rules[row.current_rule_index];
      if (!rule) {
        await client.query(
          `UPDATE battle_test_user_sequences
           SET enabled = false, remaining_in_rule = 0
           WHERE user_id = $1::uuid`,
          [userId],
        );
        await client.query("COMMIT");
        return null;
      }

      const remaining = row.remaining_in_rule > 0
        ? row.remaining_in_rule
        : rule.count;
      const isRuleComplete = remaining <= 1;
      const nextIndex = isRuleComplete
        ? row.current_rule_index + 1
        : row.current_rule_index;
      const nextRule = rules[nextIndex];
      await client.query(
        `
          UPDATE battle_test_user_sequences
          SET current_rule_index = $2,
              remaining_in_rule = $3,
              enabled = $4
          WHERE user_id = $1::uuid
        `,
        [
          userId,
          nextIndex,
          isRuleComplete ? (nextRule?.count ?? 0) : remaining - 1,
          Boolean(nextRule) || !isRuleComplete,
        ],
      );
      await client.query("COMMIT");
      return { target: rule.target, strategy: rule.strategy };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
