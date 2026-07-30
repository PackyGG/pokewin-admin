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

type WeightRow = {
  key: ScoreWeightKey;
  points: number;
  updated_at: Date;
};

/** Last-modified timestamps for keys with a stored row; catalog defaults have none. */
export type ScoreWeightUpdatedAt = Partial<Record<ScoreWeightKey, string>>;

export class ScoreWeightConflictError extends Error {
  constructor() {
    super("idempotency_conflict");
    this.name = "ScoreWeightConflictError";
  }
}

/** The caller's expectedUpdatedAt no longer matches the stored row. */
export class ScoreWeightStaleError extends Error {
  constructor(readonly currentUpdatedAt: string | null) {
    super("stale_weight");
    this.name = "ScoreWeightStaleError";
  }
}

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

function pgErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * Millisecond-truncated equality: `updated_at` is stored with microseconds but
 * every value a client can echo back went through Date/ISO serialization (ms
 * precision), as does the pg driver's parsed Date.
 */
function sameTimestampMs(expectedIso: string, stored: Date | null): boolean {
  if (!stored) return false;
  return Date.parse(expectedIso) === stored.getTime();
}

export class ScoreWeightStore {
  private cached: {
    at: number;
    weights: ScoreWeights;
    updatedAt: ScoreWeightUpdatedAt;
  } | null = null;
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

  /** Per-key last-modified timestamps for the current weight set. */
  async getUpdatedAt(): Promise<ScoreWeightUpdatedAt> {
    await this.get();
    return this.cached?.updatedAt ?? {};
  }

  /** Drop the cache so the next read refetches (e.g. after a bus frame). */
  invalidate(): void {
    this.cached = null;
  }

  private async load(): Promise<ScoreWeights> {
    const result = await this.pool.query<{
      key: string;
      points: number;
      updated_at: Date;
    }>(
      "SELECT key, points, updated_at FROM score_weights",
    );
    const weights = defaultScoreWeights();
    const updatedAt: ScoreWeightUpdatedAt = {};
    for (const row of result.rows) {
      if (isScoreWeightKey(row.key) && Number.isInteger(row.points)) {
        weights[row.key] = row.points;
        updatedAt[row.key] = row.updated_at.toISOString();
      }
    }
    this.cached = { at: Date.now(), weights, updatedAt };
    return weights;
  }

  async update(input: {
    key: ScoreWeightKey;
    points: number;
    actorId: string;
    actorUsername: string | null;
    idempotencyKey: string;
    expectedUpdatedAt?: string;
  }): Promise<{
    key: ScoreWeightKey;
    points: number;
    updatedAt: string;
    idempotent: boolean;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize concurrent retries of the SAME idempotency key: without this
      // two in-flight requests both miss the SELECT and one dies on the unique
      // index. Transaction-scoped, so it releases on COMMIT/ROLLBACK.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        [input.idempotencyKey],
      );
      const replay = await this.replayLookup(client, input);
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }

      const before = await client.query<WeightRow>(
        "SELECT key, points, updated_at FROM score_weights WHERE key = $1 FOR UPDATE",
        [input.key],
      );
      const previous = before.rows[0] ?? null;
      if (input.expectedUpdatedAt !== undefined) {
        const matches = previous
          ? sameTimestampMs(input.expectedUpdatedAt, previous.updated_at)
          : false;
        if (!matches) {
          await client.query("ROLLBACK");
          throw new ScoreWeightStaleError(
            previous ? previous.updated_at.toISOString() : null,
          );
        }
      }
      // Upsert: catalog keys are valid even before a row was seeded for them
      // (006 seeded the original set; later catalog keys may have no row yet).
      const updated = await client.query<WeightRow>(
        `INSERT INTO score_weights(key, points, updated_by, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (key) DO UPDATE
           SET points = EXCLUDED.points,
               updated_by = EXCLUDED.updated_by,
               updated_at = now()
         RETURNING key, points, updated_at`,
        [input.key, input.points, input.actorId],
      );
      const row = updated.rows[0];
      if (!row) throw new Error("score_weight_not_found");
      const beforeState = previous ?? {
        key: input.key,
        points: defaultScoreWeights()[input.key],
        source: "catalog_default",
      };
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
          JSON.stringify(beforeState),
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
      // A concurrent commit of the same idempotency key raced past the lock
      // (e.g. lock hashing collision or historical rows): resolve it as the
      // replay it is instead of surfacing a 500.
      if (error instanceof ScoreWeightStaleError) throw error;
      if (pgErrorCode(error) === UNIQUE_VIOLATION) {
        const replay = await this.replayLookup(client, input);
        if (replay) return replay;
        throw new ScoreWeightConflictError();
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Idempotent-replay resolution for an already-recorded idempotency key.
   * Returns null when the key is unknown; throws ScoreWeightConflictError when
   * the key exists with a different identity.
   */
  private async replayLookup(
    client: pg.PoolClient,
    input: {
      key: ScoreWeightKey;
      points: number;
      actorId: string;
      actorUsername: string | null;
      idempotencyKey: string;
    },
  ): Promise<{
    key: ScoreWeightKey;
    points: number;
    updatedAt: string;
    idempotent: boolean;
  } | null> {
    const duplicate = await client.query<AuditRow>(
      `SELECT target_id, actor_id, actor_username, request_state
         FROM service_audit_events
        WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    );
    const existing = duplicate.rows[0];
    if (!existing) return null;
    const requestPoints = Number(existing.request_state?.points);
    if (
      existing.target_id !== input.key ||
      existing.actor_id !== input.actorId ||
      (existing.actor_username ?? null) !== input.actorUsername ||
      requestPoints !== input.points
    ) {
      throw new ScoreWeightConflictError();
    }
    const current = await client.query<WeightRow>(
      "SELECT key, points, updated_at FROM score_weights WHERE key = $1",
      [input.key],
    );
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
}
