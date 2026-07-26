import type pg from "pg";

import {
  defaultScoreWeights,
  isScoreWeightKey,
  type ScoreWeightKey,
  type ScoreWeights,
} from "./score-catalog.js";

const CACHE_TTL_MS = 5_000;

type AuditRow = {
  target_id: string;
  actor_id: string;
  actor_username: string | null;
  request_state: Record<string, unknown> | null;
};

export class ScoreWeightConflictError extends Error {
  constructor() {
    super("idempotency_conflict");
    this.name = "ScoreWeightConflictError";
  }
}

export class ScoreWeightStore {
  private cached: { at: number; weights: ScoreWeights } | null = null;
  private loading: Promise<ScoreWeights> | null = null;

  constructor(private readonly pool: pg.Pool) {}

  async get(force = false): Promise<ScoreWeights> {
    if (
      !force &&
      this.cached &&
      Date.now() - this.cached.at < CACHE_TTL_MS
    ) {
      return this.cached.weights;
    }
    if (!force && this.loading) return this.loading;

    const load = this.load();
    this.loading = load;
    try {
      return await load;
    } finally {
      if (this.loading === load) this.loading = null;
    }
  }

  private async load(): Promise<ScoreWeights> {
    const result = await this.pool.query<{ key: string; points: number }>(
      "SELECT key, points FROM score_weights",
    );
    const weights = defaultScoreWeights();
    for (const row of result.rows) {
      if (isScoreWeightKey(row.key) && Number.isInteger(row.points)) {
        weights[row.key] = row.points;
      }
    }
    this.cached = { at: Date.now(), weights };
    return weights;
  }

  async update(input: {
    key: ScoreWeightKey;
    points: number;
    actorId: string;
    actorUsername: string | null;
    idempotencyKey: string;
  }): Promise<{
    key: ScoreWeightKey;
    points: number;
    updatedAt: string;
    idempotent: boolean;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const duplicate = await client.query<AuditRow>(
        `SELECT target_id, actor_id, actor_username, request_state
           FROM service_audit_events
          WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      const existing = duplicate.rows[0];
      if (existing) {
        const requestPoints = Number(existing.request_state?.points);
        if (
          existing.target_id !== input.key ||
          existing.actor_id !== input.actorId ||
          (existing.actor_username ?? null) !== input.actorUsername ||
          requestPoints !== input.points
        ) {
          await client.query("ROLLBACK");
          throw new ScoreWeightConflictError();
        }
        const current = await client.query<{
          key: ScoreWeightKey;
          points: number;
          updated_at: Date;
        }>(
          "SELECT key, points, updated_at FROM score_weights WHERE key = $1",
          [input.key],
        );
        await client.query("COMMIT");
        const row = current.rows[0];
        if (!row) throw new Error("score_weight_not_found");
        this.cached = null;
        return {
          key: row.key,
          points: row.points,
          updatedAt: row.updated_at.toISOString(),
          idempotent: true,
        };
      }

      const before = await client.query<{
        key: ScoreWeightKey;
        points: number;
        updated_at: Date;
      }>(
        "SELECT key, points, updated_at FROM score_weights WHERE key = $1 FOR UPDATE",
        [input.key],
      );
      const previous = before.rows[0];
      if (!previous) {
        await client.query("ROLLBACK");
        throw new Error("score_weight_not_found");
      }
      const updated = await client.query<{
        key: ScoreWeightKey;
        points: number;
        updated_at: Date;
      }>(
        `UPDATE score_weights
            SET points = $2, updated_by = $3, updated_at = now()
          WHERE key = $1
          RETURNING key, points, updated_at`,
        [input.key, input.points, input.actorId],
      );
      const row = updated.rows[0];
      if (!row) throw new Error("score_weight_not_found");
      await client.query(
        `INSERT INTO service_audit_events(
           idempotency_key, actor_id, actor_username, action, target_type,
           target_id, request_state, before_state, after_state
         ) VALUES (
           $1,$2,$3,'score_weight.update','score_weight',$4,$5::jsonb,$6::jsonb,$7::jsonb
         )`,
        [
          input.idempotencyKey,
          input.actorId,
          input.actorUsername,
          input.key,
          JSON.stringify({ key: input.key, points: input.points }),
          JSON.stringify(previous),
          JSON.stringify(row),
        ],
      );
      await client.query("COMMIT");
      this.cached = null;
      await this.get(true);
      return {
        key: row.key,
        points: row.points,
        updatedAt: row.updated_at.toISOString(),
        idempotent: false,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
