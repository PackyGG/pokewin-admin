import type pg from "pg";

export type BattleTestConfig = {
  userOnlyLoses: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

export interface BattleTestConfigSource {
  get(): Promise<BattleTestConfig>;
  set(userOnlyLoses: boolean, actor: string): Promise<BattleTestConfig>;
}

type ConfigRow = {
  user_only_loses: boolean;
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
}
