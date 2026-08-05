import type { FastifyBaseLogger } from "fastify";

import type { Databases } from "./db.js";
import { FiatDepositAccessClient } from "./fiat-deposit-access.js";

const PAGE_SIZE = 100;
const DRAIN_SIZE = 40;
const WORKERS = 8;

type PolicyRow = {
  id: string;
  generation: string;
  enabled: boolean;
  effective_at: Date;
  cutoff_at: Date | null;
  actor_id: string;
};

type OperationRow = {
  id: string;
  policy_id: string;
  user_id: string;
  desired_enabled: boolean;
  attempts: number;
};

export type FiatAccessControlStatus = {
  configured: boolean;
  existingAccounts: {
    enabled: boolean;
    generation: number;
    status: "not_started" | "queued" | "running" | "complete" | "stalled";
    processed: number;
    succeeded: number;
    failed: number;
    lastError: string | null;
    cutoffAt: string | null;
    completedAt: string | null;
  };
  newSignups: {
    enabled: boolean;
    generation: number;
    effectiveAt: string | null;
    processed: number;
    failed: number;
  };
};

export class FiatDepositAccessControl {
  constructor(
    private readonly db: Databases,
    private readonly access: FiatDepositAccessClient,
    private readonly log: FastifyBaseLogger,
    private readonly configured = true,
  ) {}

  async status(): Promise<FiatAccessControlStatus> {
    const [existing, newSignup] = await Promise.all([
      this.db.antifraud.query<{
        enabled: boolean;
        generation: string;
        cutoff_at: Date;
        status: "queued" | "running" | "complete" | "stalled" | "superseded";
        processed_count: string;
        success_count: string;
        failure_count: string;
        last_error: string | null;
        completed_at: Date | null;
      }>(`
        SELECT p.enabled, p.generation, p.cutoff_at, r.status,
          r.processed_count, r.success_count, r.failure_count,
          r.last_error, r.completed_at
        FROM fiat_deposit_access_policies p
        JOIN fiat_deposit_access_rollouts r ON r.policy_id = p.id
        WHERE p.scope = 'existing_accounts'
        ORDER BY p.generation DESC
        LIMIT 1
      `),
      this.db.antifraud.query<{
        id: string;
        enabled: boolean;
        generation: string;
        effective_at: Date;
        processed_count: string;
        failure_count: string;
      }>(`
        SELECT p.id, p.enabled, p.generation, p.effective_at,
          COUNT(o.id) FILTER (WHERE o.status = 'succeeded')::text AS processed_count,
          COUNT(o.id) FILTER (WHERE o.status = 'failed')::text AS failure_count
        FROM fiat_deposit_access_policies p
        LEFT JOIN fiat_deposit_access_operations o ON o.policy_id = p.id
        WHERE p.scope = 'new_signups'
        GROUP BY p.id
        ORDER BY p.generation DESC
        LIMIT 1
      `),
    ]);
    const currentExisting = existing.rows[0];
    const currentNew = newSignup.rows[0];
    return {
      configured: this.configured,
      existingAccounts: currentExisting
        ? {
            enabled: currentExisting.enabled,
            generation: Number(currentExisting.generation),
            status:
              currentExisting.status === "superseded"
                ? "stalled"
                : currentExisting.status,
            processed: Number(currentExisting.processed_count),
            succeeded: Number(currentExisting.success_count),
            failed: Number(currentExisting.failure_count),
            lastError: currentExisting.last_error,
            cutoffAt: currentExisting.cutoff_at.toISOString(),
            completedAt: currentExisting.completed_at?.toISOString() ?? null,
          }
        : {
            enabled: false,
            generation: 0,
            status: "not_started",
            processed: 0,
            succeeded: 0,
            failed: 0,
            lastError: null,
            cutoffAt: null,
            completedAt: null,
          },
      newSignups: currentNew
        ? {
            enabled: currentNew.enabled,
            generation: Number(currentNew.generation),
            effectiveAt: currentNew.effective_at.toISOString(),
            processed: Number(currentNew.processed_count),
            failed: Number(currentNew.failure_count),
          }
        : {
            enabled: false,
            generation: 0,
            effectiveAt: null,
            processed: 0,
            failed: 0,
          },
    };
  }

  async setExistingAccounts(
    enabled: boolean,
    actorId: string,
  ): Promise<FiatAccessControlStatus> {
    if (!this.configured) throw new Error("fiat_deposit_access_not_configured");
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        ["fiat-access:existing-accounts"],
      );
      const active = await client.query<{ policy_id: string }>(
        `SELECT policy_id
           FROM fiat_deposit_access_rollouts
          WHERE status IN ('queued', 'running', 'stalled')
          LIMIT 1
          FOR UPDATE`,
      );
      if (active.rows.length > 0) {
        throw new Error("fiat_deposit_access_rollout_in_progress");
      }
      const generation = await client.query<{ next: string }>(
        `SELECT COALESCE(MAX(generation), 0) + 1 AS next
           FROM fiat_deposit_access_policies
          WHERE scope = 'existing_accounts'`,
      );
      const policy = await client.query<{ id: string }>(
        `INSERT INTO fiat_deposit_access_policies
          (scope, generation, enabled, effective_at, cutoff_at, actor_id)
         VALUES ('existing_accounts', $1, $2, now(), now(), $3)
         RETURNING id`,
        [generation.rows[0]!.next, enabled, actorId],
      );
      await client.query(
        `UPDATE fiat_deposit_access_rollouts
            SET status = 'superseded', updated_at = now()
          WHERE status IN ('queued', 'running', 'stalled')`,
      );
      await client.query(
        `UPDATE fiat_deposit_access_operations
            SET status = 'superseded', updated_at = now()
          WHERE scope = 'existing_accounts'
            AND status IN ('pending', 'failed')`,
      );
      await client.query(
        `INSERT INTO fiat_deposit_access_rollouts(policy_id)
         VALUES ($1)`,
        [policy.rows[0]!.id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.status();
  }

  async setNewSignups(
    enabled: boolean,
    actorId: string,
  ): Promise<FiatAccessControlStatus> {
    if (!this.configured) throw new Error("fiat_deposit_access_not_configured");
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        ["fiat-access:new-signups"],
      );
      const generation = await client.query<{ next: string }>(
        `SELECT COALESCE(MAX(generation), 0) + 1 AS next
           FROM fiat_deposit_access_policies
          WHERE scope = 'new_signups'`,
      );
      const inserted = await client.query<{ effective_at: Date }>(
        `INSERT INTO fiat_deposit_access_policies
          (scope, generation, enabled, effective_at, actor_id)
         VALUES ('new_signups', $1, $2, now(), $3)
         RETURNING effective_at`,
        [generation.rows[0]!.next, enabled, actorId],
      );
      await client.query(
        `INSERT INTO fiat_deposit_access_cursors(stream, occurred_at, source_id)
         VALUES ('new_signups', $1, '')
         ON CONFLICT (stream) DO NOTHING`,
        [inserted.rows[0]!.effective_at],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.status();
  }

  async process(): Promise<void> {
    if (!this.configured) return;
    await this.db.antifraud.query(`
      UPDATE fiat_deposit_access_operations
      SET status = 'failed', last_error = 'interrupted_before_confirmation',
          next_attempt_at = now(), updated_at = now()
      WHERE status = 'processing'
        AND updated_at < now() - interval '2 minutes'
    `);
    await this.enqueueExistingAccounts();
    await this.enqueueNewSignups();
    const policyIds = await this.drainOperations();
    const active = await this.db.antifraud.query<{ policy_id: string }>(`
      SELECT policy_id FROM fiat_deposit_access_rollouts
      WHERE status IN ('queued', 'running', 'stalled')
    `);
    active.rows.forEach((row) => policyIds.add(row.policy_id));
    await Promise.all([...policyIds].map((id) => this.refreshRollout(id)));
  }

  private async enqueueExistingAccounts(): Promise<void> {
    const rollout = await this.db.antifraud.query<{
      policy_id: string;
      enabled: boolean;
      cutoff_at: Date;
      cursor_at: Date;
      cursor_id: string;
    }>(`
      SELECT r.policy_id, p.enabled, p.cutoff_at, r.cursor_at, r.cursor_id
      FROM fiat_deposit_access_rollouts r
      JOIN fiat_deposit_access_policies p ON p.id = r.policy_id
      WHERE r.status IN ('queued', 'running', 'stalled')
        AND r.enqueue_complete = false
      ORDER BY p.generation DESC
      LIMIT 1
    `);
    const current = rollout.rows[0];
    if (!current) return;
    const users = await this.db.source.query<{ id: string; created_at: Date }>(
      `SELECT id, created_at FROM "user"
       WHERE (created_at, id) > ($1, $2)
         AND created_at < $3
       ORDER BY created_at, id
       LIMIT $4`,
      [current.cursor_at, current.cursor_id, current.cutoff_at, PAGE_SIZE],
    );
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      for (const user of users.rows) {
        await client.query(
          `INSERT INTO fiat_deposit_access_operations
            (policy_id, scope, user_id, desired_enabled, source_created_at)
           VALUES ($1, 'existing_accounts', $2, $3, $4)
           ON CONFLICT (policy_id, user_id) DO NOTHING`,
          [current.policy_id, user.id, current.enabled, user.created_at],
        );
      }
      const last = users.rows.at(-1);
      await client.query(
        `UPDATE fiat_deposit_access_rollouts
         SET status = 'running', started_at = COALESCE(started_at, now()),
             cursor_at = COALESCE($2, cursor_at),
             cursor_id = COALESCE($3, cursor_id),
             enqueue_complete = $4,
             updated_at = now()
         WHERE policy_id = $1 AND status <> 'superseded'`,
        [
          current.policy_id,
          last?.created_at ?? null,
          last?.id ?? null,
          users.rows.length === 0,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async enqueueNewSignups(): Promise<void> {
    const cursor = await this.db.antifraud.query<{
      occurred_at: Date;
      source_id: string;
    }>(`SELECT occurred_at, source_id
        FROM fiat_deposit_access_cursors WHERE stream = 'new_signups'`);
    const current = cursor.rows[0];
    if (!current) return;
    const users = await this.db.source.query<{ id: string; created_at: Date }>(
      `SELECT id, created_at FROM "user"
       WHERE (created_at, id) > ($1, $2)
       ORDER BY created_at, id
       LIMIT $3`,
      [current.occurred_at, current.source_id, PAGE_SIZE],
    );
    if (users.rows.length === 0) return;
    const policies = await this.db.antifraud.query<PolicyRow>(`
      SELECT id, generation, enabled, effective_at, cutoff_at, actor_id
      FROM fiat_deposit_access_policies
      WHERE scope = 'new_signups'
      ORDER BY effective_at, generation
    `);
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      for (const user of users.rows) {
        const policy = policies.rows
          .filter((item) => item.effective_at <= user.created_at)
          .at(-1);
        if (!policy) continue;
        await client.query(
          `INSERT INTO fiat_deposit_access_operations
            (policy_id, scope, user_id, desired_enabled, source_created_at)
           VALUES ($1, 'new_signups', $2, $3, $4)
           ON CONFLICT (policy_id, user_id) DO NOTHING`,
          [policy.id, user.id, policy.enabled, user.created_at],
        );
      }
      const last = users.rows.at(-1)!;
      await client.query(
        `UPDATE fiat_deposit_access_cursors
         SET occurred_at = $1, source_id = $2, updated_at = now()
         WHERE stream = 'new_signups'
           AND (occurred_at, source_id) < ($1, $2)`,
        [last.created_at, last.id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async drainOperations(): Promise<Set<string>> {
    const client = await this.db.antifraud.connect();
    let operations: OperationRow[] = [];
    try {
      await client.query("BEGIN");
      const claimed = await client.query<OperationRow>(
        `SELECT id, policy_id, user_id, desired_enabled, attempts
         FROM fiat_deposit_access_operations
         WHERE status IN ('pending', 'failed') AND next_attempt_at <= now()
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [DRAIN_SIZE],
      );
      operations = claimed.rows;
      if (operations.length > 0) {
        await client.query(
          `UPDATE fiat_deposit_access_operations
           SET status = 'processing', attempts = attempts + 1, updated_at = now()
           WHERE id = ANY($1::bigint[])`,
          [operations.map((item) => item.id)],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    let next = 0;
    const policyIds = new Set(operations.map((item) => item.policy_id));
    const workers = Array.from(
      { length: Math.min(WORKERS, operations.length) },
      async () => {
        while (next < operations.length) {
          const operation = operations[next++];
          if (!operation) {
            return;
          }
          try {
            const confirmed = await this.access.update(
              operation.user_id,
              operation.desired_enabled,
            );
            await this.db.antifraud.query(
              `UPDATE fiat_deposit_access_operations
               SET status = 'succeeded', confirmed_enabled = $2,
                   last_error = NULL, completed_at = now(), updated_at = now()
               WHERE id = $1 AND status = 'processing'`,
              [operation.id, confirmed],
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const retrySeconds = Math.min(900, 15 * 2 ** Math.min(operation.attempts, 6));
            await this.db.antifraud.query(
              `UPDATE fiat_deposit_access_operations
               SET status = 'failed', last_error = $2,
                   next_attempt_at = now() + ($3::text || ' seconds')::interval,
                   updated_at = now()
               WHERE id = $1 AND status = 'processing'`,
              [operation.id, message.slice(0, 500), retrySeconds],
            );
            this.log.warn(
              { userId: operation.user_id, policyId: operation.policy_id, err: message },
              "Fiat deposit access update will retry",
            );
          }
        }
      },
    );
    await Promise.all(workers);
    return policyIds;
  }

  private async refreshRollout(policyId: string): Promise<void> {
    await this.db.antifraud.query(
      `UPDATE fiat_deposit_access_rollouts r
       SET processed_count = stats.processed,
           success_count = stats.succeeded,
           failure_count = stats.failed,
           last_error = stats.last_error,
           status = CASE
             WHEN r.status = 'superseded' THEN 'superseded'
             WHEN r.enqueue_complete AND stats.open = 0 THEN 'complete'
             WHEN stats.failed > 0 THEN 'stalled'
             ELSE 'running'
           END,
           completed_at = CASE
             WHEN r.enqueue_complete AND stats.open = 0 THEN COALESCE(r.completed_at, now())
             ELSE NULL
           END,
           updated_at = now()
       FROM (
         SELECT COUNT(*)::bigint AS processed,
           COUNT(*) FILTER (WHERE status = 'succeeded')::bigint AS succeeded,
           COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failed,
           COUNT(*) FILTER (WHERE status IN ('pending', 'processing', 'failed'))::bigint AS open,
           MAX(last_error) FILTER (WHERE status = 'failed') AS last_error
         FROM fiat_deposit_access_operations
         WHERE policy_id = $1
       ) stats
       WHERE r.policy_id = $1`,
      [policyId],
    );
  }
}
