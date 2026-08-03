import type pg from "pg";

import type { Databases } from "./db.js";
import type { FiatDepositAccessClient } from "./fiat-deposit-access.js";

const ACCESS_CONCURRENCY = 4;
const MAX_BATCH_SIZE = 100;

export type FiatPerkAccessAction = "enable" | "disable";
export type FiatPerkAccessBatchStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed";

export type FiatPerkAccessBatch = {
  id: string;
  action: FiatPerkAccessAction;
  status: FiatPerkAccessBatchStatus;
  requestedCount: number;
  succeededCount: number;
  failedCount: number;
  note: string | null;
  requestedBy: string;
  requestedByUsername: string | null;
  createdAt: string;
  completedAt: string | null;
  failures: Array<{ userId: string; errorCode: string | null }>;
};

export class PerkAccessSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PerkAccessSyncError";
  }
}

type BatchRow = {
  id: string;
  action: FiatPerkAccessAction;
  status: FiatPerkAccessBatchStatus;
  requested_count: number;
  succeeded_count: number;
  failed_count: number;
  note: string | null;
  requested_by: string;
  requested_by_username: string | null;
  created_at: Date;
  completed_at: Date | null;
  failures: Array<{ userId: string; errorCode: string | null }>;
};

const BATCH_SELECT = `
  SELECT b.id::text,b.action,b.status,b.requested_count,b.succeeded_count,
         b.failed_count,b.note,b.requested_by,b.requested_by_username,
         b.created_at,b.completed_at,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'userId', failed.user_id,
             'errorCode', failed.error_code
           ) ORDER BY failed.created_at)
           FROM (
             SELECT o.user_id,o.error_code,o.created_at
               FROM fiat_perk_access_operations o
              WHERE o.batch_id=b.id AND o.status='failed'
              ORDER BY o.created_at
              LIMIT 20
           ) failed
         ), '[]'::jsonb) AS failures
    FROM fiat_perk_access_batches b
`;

type OperationRow = {
  id: string;
  batch_id: string;
  candidate_id: string | null;
  user_id: string;
  desired_enabled: boolean;
};

function serializeBatch(row: BatchRow): FiatPerkAccessBatch {
  return {
    id: row.id,
    action: row.action,
    status: row.status,
    requestedCount: row.requested_count,
    succeededCount: row.succeeded_count,
    failedCount: row.failed_count,
    note: row.note,
    requestedBy: row.requested_by,
    requestedByUsername: row.requested_by_username,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    failures: row.failures ?? [],
  };
}

function safeErrorCode(error: unknown): string {
  const raw = error instanceof Error
    ? `${error.name}:${error.message}`
    : "unknown_error";
  return raw.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 160);
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, Math.max(1, items.length)) },
    async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        await worker(items[index]!);
      }
    },
  );
  await Promise.all(runners);
}

/**
 * Durable bridge between a reviewed Fiat candidate and the backend-owned
 * per-user access switch. The operation row is committed before the network
 * call. A crash can therefore resume safely, and a local grant is never marked
 * live until the backend confirms the exact requested value.
 */
export class FiatPerkAccessService {
  private readonly running = new Set<string>();

  constructor(
    private readonly db: Databases,
    private readonly upstream: FiatDepositAccessClient,
  ) {}

  async recoverPendingBatches(): Promise<number> {
    await this.db.antifraud.query(
      `UPDATE fiat_perk_access_operations
          SET status='queued', error_code='interrupted'
        WHERE status='applying'`,
    );
    const pending = await this.db.antifraud.query<{ id: string }>(
      `SELECT id::text FROM fiat_perk_access_batches
        WHERE status IN ('queued','running')
        ORDER BY created_at`,
    );
    for (const row of pending.rows) this.startInBackground(row.id);
    return pending.rows.length;
  }

  async listBatches(limit = 20): Promise<FiatPerkAccessBatch[]> {
    const result = await this.db.antifraud.query<BatchRow>(
      `${BATCH_SELECT} ORDER BY b.created_at DESC LIMIT $1`,
      [Math.min(100, Math.max(1, limit))],
    );
    return result.rows.map(serializeBatch);
  }

  async getBatch(batchId: string): Promise<FiatPerkAccessBatch | null> {
    const result = await this.db.antifraud.query<BatchRow>(
      `${BATCH_SELECT} WHERE b.id=$1`,
      [batchId],
    );
    return result.rows[0] ? serializeBatch(result.rows[0]) : null;
  }

  async queueEnable(input: {
    candidateIds: readonly string[];
    userIds?: readonly string[];
    note: string | null;
    filterSnapshot?: Record<string, unknown>;
    idempotencyKey: string;
    actorId: string;
    actorUsername: string | null;
    background?: boolean;
  }): Promise<FiatPerkAccessBatch> {
    const existing = await this.getBatchByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (existing.action !== "enable" || existing.requestedBy !== input.actorId) {
        throw new PerkAccessSyncError("That retry key belongs to another access change.");
      }
      if (input.background === false) await this.executeBatch(existing.id);
      else this.startInBackground(existing.id);
      return (await this.getBatch(existing.id)) ?? existing;
    }
    const ids = [...new Set(input.candidateIds)];
    const userIds = [...new Set(input.userIds ?? [])];
    if (ids.length + userIds.length < 1 || ids.length + userIds.length > MAX_BATCH_SIZE) {
      throw new PerkAccessSyncError("Select between 1 and 100 accounts.");
    }
    const candidates = await this.db.antifraud.query<{
      id: string;
      user_id: string;
      decision: string;
    }>(
      `SELECT id::text,user_id,decision FROM fiat_perk_candidates
        WHERE id=ANY($1::uuid[])`,
      [ids],
    );
    if (candidates.rows.length !== ids.length) {
      throw new PerkAccessSyncError("One or more screened accounts no longer exist.");
    }
    const unavailable = candidates.rows.find((row) => row.decision !== "pending");
    if (unavailable) {
      throw new PerkAccessSyncError("One or more selected accounts already have a decision.");
    }

    const grantTargets = userIds.length === 0
      ? []
      : (await this.db.antifraud.query<{
        user_id: string;
        candidate_id: string | null;
      }>(
        `SELECT user_id,candidate_id::text FROM fiat_perk_grants
          WHERE user_id=ANY($1::text[]) AND status='granted'`,
        [userIds],
      )).rows;
    if (grantTargets.length !== userIds.length) {
      throw new PerkAccessSyncError("One or more accounts do not hold a live Fiat grant.");
    }
    const targetsByUser = new Map<
      string,
      { candidateId: string | null; userId: string }
    >(
      candidates.rows.map((row) => [row.user_id, {
        candidateId: row.id,
        userId: row.user_id,
      }]),
    );
    for (const row of grantTargets) {
      targetsByUser.set(row.user_id, {
        candidateId: row.candidate_id,
        userId: row.user_id,
      });
    }
    const batch = await this.createBatch({
      action: "enable",
      targets: [...targetsByUser.values()],
      ...input,
    });
    if (input.background === false) await this.executeBatch(batch.id);
    else this.startInBackground(batch.id);
    return (await this.getBatch(batch.id)) ?? batch;
  }

  async queueDisable(input: {
    userIds: readonly string[];
    note: string;
    filterSnapshot?: Record<string, unknown>;
    idempotencyKey: string;
    actorId: string;
    actorUsername: string | null;
    background?: boolean;
  }): Promise<FiatPerkAccessBatch> {
    const existing = await this.getBatchByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (existing.action !== "disable" || existing.requestedBy !== input.actorId) {
        throw new PerkAccessSyncError("That retry key belongs to another access change.");
      }
      if (input.background === false) await this.executeBatch(existing.id);
      else this.startInBackground(existing.id);
      return (await this.getBatch(existing.id)) ?? existing;
    }
    const ids = [...new Set(input.userIds)];
    if (ids.length < 1 || ids.length > MAX_BATCH_SIZE) {
      throw new PerkAccessSyncError("Select between 1 and 100 accounts.");
    }
    const grants = await this.db.antifraud.query<{ user_id: string }>(
      `SELECT user_id FROM fiat_perk_grants
        WHERE user_id=ANY($1::text[]) AND status='granted'`,
      [ids],
    );
    if (grants.rows.length !== ids.length) {
      throw new PerkAccessSyncError("One or more accounts do not hold a live Fiat grant.");
    }
    const batch = await this.createBatch({
      action: "disable",
      targets: grants.rows.map((row) => ({
        candidateId: null,
        userId: row.user_id,
      })),
      ...input,
    });
    if (input.background === false) await this.executeBatch(batch.id);
    else this.startInBackground(batch.id);
    return (await this.getBatch(batch.id)) ?? batch;
  }

  async retryBatch(batchId: string): Promise<FiatPerkAccessBatch> {
    const result = await this.db.antifraud.query(
      `UPDATE fiat_perk_access_operations SET status='queued',error_code=NULL
        WHERE batch_id=$1 AND status='failed'`,
      [batchId],
    );
    if ((result.rowCount ?? 0) === 0) {
      const current = await this.getBatch(batchId);
      if (!current) throw new PerkAccessSyncError("That access batch no longer exists.");
      return current;
    }
    await this.db.antifraud.query(
      `UPDATE fiat_perk_access_batches
          SET status='queued',completed_at=NULL,failed_count=0
        WHERE id=$1`,
      [batchId],
    );
    await this.db.antifraud.query(
      `UPDATE fiat_perk_grants g SET access_status='syncing',
              access_error_code=NULL,updated_at=now()
        FROM fiat_perk_access_operations o
       WHERE o.batch_id=$1 AND o.status='queued' AND o.user_id=g.user_id`,
      [batchId],
    );
    this.startInBackground(batchId);
    const batch = await this.getBatch(batchId);
    if (!batch) throw new PerkAccessSyncError("That access batch no longer exists.");
    return batch;
  }

  private async createBatch(input: {
    action: FiatPerkAccessAction;
    targets: readonly { candidateId: string | null; userId: string }[];
    note: string | null;
    filterSnapshot?: Record<string, unknown>;
    idempotencyKey: string;
    actorId: string;
    actorUsername: string | null;
  }): Promise<FiatPerkAccessBatch> {
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO fiat_perk_access_batches(
           action,requested_count,note,filter_snapshot,requested_by,
           requested_by_username,idempotency_key
         ) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)
         ON CONFLICT(idempotency_key) DO NOTHING RETURNING id::text`,
        [
          input.action,
          input.targets.length,
          input.note,
          JSON.stringify(input.filterSnapshot ?? {}),
          input.actorId,
          input.actorUsername,
          input.idempotencyKey,
        ],
      );
      let batchId = inserted.rows[0]?.id;
      if (!batchId) {
        const existing = await client.query<{ id: string }>(
          `SELECT id::text FROM fiat_perk_access_batches
            WHERE idempotency_key=$1`,
          [input.idempotencyKey],
        );
        batchId = existing.rows[0]?.id;
      } else {
        for (const target of input.targets) {
          await client.query(
            `INSERT INTO fiat_perk_access_operations(
               batch_id,candidate_id,user_id,desired_enabled
             ) VALUES($1,$2,$3,$4)`,
            [batchId, target.candidateId, target.userId, input.action === "enable"],
          );
        }
        await client.query(
          `UPDATE fiat_perk_grants SET access_status='syncing',
                  access_error_code=NULL,updated_at=now()
            WHERE user_id=ANY($1::text[])`,
          [input.targets.map((target) => target.userId)],
        );
      }
      if (!batchId) throw new Error("fiat_perk_batch_persistence_failed");
      await client.query("COMMIT");
      const batch = await this.getBatch(batchId);
      if (!batch) throw new Error("fiat_perk_batch_persistence_failed");
      return batch;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async getBatchByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<FiatPerkAccessBatch | null> {
    const result = await this.db.antifraud.query<BatchRow>(
      `${BATCH_SELECT} WHERE b.idempotency_key=$1`,
      [idempotencyKey],
    );
    return result.rows[0] ? serializeBatch(result.rows[0]) : null;
  }

  private startInBackground(batchId: string): void {
    if (this.running.has(batchId)) return;
    this.running.add(batchId);
    void this.executeBatch(batchId)
      .catch((error) => {
        console.error("[fiat-perks] access batch failed", {
          batchId,
          error: safeErrorCode(error),
        });
      })
      .finally(() => this.running.delete(batchId));
  }

  private async executeBatch(batchId: string): Promise<void> {
    await this.db.antifraud.query(
      `UPDATE fiat_perk_access_batches SET status='running',
              started_at=COALESCE(started_at,now()),completed_at=NULL
        WHERE id=$1 AND status IN ('queued','running','partial','failed')`,
      [batchId],
    );
    const pending = await this.db.antifraud.query<{ id: string }>(
      `SELECT id::text FROM fiat_perk_access_operations
        WHERE batch_id=$1 AND status='queued' ORDER BY created_at`,
      [batchId],
    );
    await mapWithConcurrency(
      pending.rows,
      ACCESS_CONCURRENCY,
      async (row) => this.applyOperation(row.id),
    );
    await this.refreshBatch(batchId);
  }

  private async applyOperation(operationId: string): Promise<void> {
    const claimed = await this.db.antifraud.query<OperationRow>(
      `UPDATE fiat_perk_access_operations
          SET status='applying',attempts=attempts+1,started_at=now(),error_code=NULL
        WHERE id=$1 AND status='queued'
        RETURNING id::text,batch_id::text,candidate_id::text,user_id,desired_enabled`,
      [operationId],
    );
    const operation = claimed.rows[0];
    if (!operation) return;

    try {
      const confirmed = await this.upstream.update(
        operation.user_id,
        operation.desired_enabled,
      );
      if (confirmed.enabled !== operation.desired_enabled) {
        throw new Error("fiat_deposit_access_confirmation_mismatch");
      }
      await this.commitSuccess(operation);
    } catch (error) {
      const code = safeErrorCode(error);
      await this.db.antifraud.query(
        `UPDATE fiat_perk_access_operations
            SET status='failed',error_code=$2,completed_at=now()
          WHERE id=$1`,
        [operation.id, code],
      );
      await this.db.antifraud.query(
        `UPDATE fiat_perk_grants SET access_status='error',access_error_code=$2,
                updated_at=now()
          WHERE user_id=$1`,
        [operation.user_id, code],
      );
    }
  }

  private async commitSuccess(operation: OperationRow): Promise<void> {
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      const batch = await client.query<{
        requested_by: string;
        requested_by_username: string | null;
        note: string | null;
      }>(
        `SELECT requested_by,requested_by_username,note
           FROM fiat_perk_access_batches WHERE id=$1 FOR UPDATE`,
        [operation.batch_id],
      );
      const actor = batch.rows[0];
      if (!actor) throw new Error("fiat_perk_batch_missing");

      if (operation.desired_enabled) {
        if (!operation.candidate_id) {
          const updated = await client.query(
            `UPDATE fiat_perk_grants SET access_status='enabled',
                    access_error_code=NULL,access_confirmed_at=now(),updated_at=now()
              WHERE user_id=$1 AND status='granted'`,
            [operation.user_id],
          );
          if ((updated.rowCount ?? 0) === 0) throw new Error("fiat_perk_grant_missing");
          await this.insertAudit(client, {
            candidateId: null,
            userId: operation.user_id,
            action: "reinstated",
            operationId: operation.id,
            actor,
            after: { status: "granted", accessEnabled: true },
          });
        } else {
          const candidate = await client.query<{
            id: string;
            run_id: string;
            user_id: string;
            username: string | null;
            risk_score: number;
            decision: string;
          }>(
            `SELECT id::text,run_id::text,user_id,username,risk_score,decision
               FROM fiat_perk_candidates WHERE id=$1 FOR UPDATE`,
            [operation.candidate_id],
          );
          const row = candidate.rows[0];
          if (!row || row.user_id !== operation.user_id) {
            throw new Error("fiat_perk_candidate_missing");
          }
          if (row.decision !== "pending" && row.decision !== "approved") {
            throw new Error("fiat_perk_candidate_already_decided");
          }
          await client.query(
            `UPDATE fiat_perk_candidates SET decision='approved',decided_by=$2,
                  decided_by_username=$3,decided_at=now(),decision_note=$4
              WHERE id=$1`,
            [row.id, actor.requested_by, actor.requested_by_username, actor.note],
          );
          await client.query(
            `INSERT INTO fiat_perk_grants(
             user_id,status,candidate_id,run_id,username,risk_score,
             granted_by,granted_by_username,granted_at,granted_note,
             access_status,access_error_code,access_confirmed_at
           ) VALUES($1,'granted',$2,$3,$4,$5,$6,$7,now(),$8,'enabled',NULL,now())
           ON CONFLICT(user_id) DO UPDATE SET status='granted',
             candidate_id=EXCLUDED.candidate_id,run_id=EXCLUDED.run_id,
             username=EXCLUDED.username,risk_score=EXCLUDED.risk_score,
             granted_by=EXCLUDED.granted_by,
             granted_by_username=EXCLUDED.granted_by_username,
             granted_at=now(),granted_note=EXCLUDED.granted_note,
             revoked_by=NULL,revoked_by_username=NULL,revoked_at=NULL,
             revoked_reason=NULL,access_status='enabled',access_error_code=NULL,
             access_confirmed_at=now(),updated_at=now()`,
            [
              row.user_id,
              row.id,
              row.run_id,
              row.username,
              row.risk_score,
              actor.requested_by,
              actor.requested_by_username,
              actor.note,
            ],
          );
          await this.insertAudit(client, {
            candidateId: row.id,
            userId: row.user_id,
            action: "approved",
            operationId: operation.id,
            actor,
            after: { decision: "approved", accessEnabled: true, riskScore: row.risk_score },
          });
        }
      } else {
        const updated = await client.query(
          `UPDATE fiat_perk_grants SET status='revoked',revoked_by=$2,
                  revoked_by_username=$3,revoked_at=now(),revoked_reason=$4,
                  access_status='disabled',access_error_code=NULL,
                  access_confirmed_at=now(),updated_at=now()
            WHERE user_id=$1 AND status='granted'`,
          [operation.user_id, actor.requested_by, actor.requested_by_username, actor.note],
        );
        if ((updated.rowCount ?? 0) === 0) {
          throw new Error("fiat_perk_grant_missing");
        }
        await this.insertAudit(client, {
          candidateId: null,
          userId: operation.user_id,
          action: "revoked",
          operationId: operation.id,
          actor,
          after: { status: "revoked", accessEnabled: false },
        });
      }

      await client.query(
        `UPDATE fiat_perk_access_operations SET status='succeeded',
                confirmed_enabled=$2,error_code=NULL,completed_at=now()
          WHERE id=$1`,
        [operation.id, operation.desired_enabled],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertAudit(
    client: pg.PoolClient,
    input: {
      candidateId: string | null;
      userId: string;
      action: "approved" | "revoked" | "reinstated";
      operationId: string;
      actor: {
        requested_by: string;
        requested_by_username: string | null;
        note: string | null;
      };
      after: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO fiat_perk_audit(
         candidate_id,user_id,action,actor_id,actor_username,note,
         idempotency_key,after_state
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT(idempotency_key) DO NOTHING`,
      [
        input.candidateId,
        input.userId,
        input.action,
        input.actor.requested_by,
        input.actor.requested_by_username,
        input.actor.note,
        input.operationId,
        JSON.stringify(input.after),
      ],
    );
  }

  private async refreshBatch(batchId: string): Promise<void> {
    await this.db.antifraud.query(
      `UPDATE fiat_perk_access_batches b SET
         succeeded_count=s.succeeded,
         failed_count=s.failed,
         status=CASE
           WHEN s.pending > 0 THEN 'running'
           WHEN s.failed = 0 THEN 'completed'
           WHEN s.succeeded = 0 THEN 'failed'
           ELSE 'partial'
         END,
         completed_at=CASE WHEN s.pending=0 THEN now() ELSE NULL END
       FROM (
         SELECT count(*) FILTER(WHERE status='succeeded')::int succeeded,
                count(*) FILTER(WHERE status='failed')::int failed,
                count(*) FILTER(WHERE status IN ('queued','applying'))::int pending
           FROM fiat_perk_access_operations WHERE batch_id=$1
       ) s WHERE b.id=$1`,
      [batchId],
    );
  }
}
