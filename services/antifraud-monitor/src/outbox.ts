/**
 * Shared drain loop for the durable alert outboxes.
 *
 * Every outbox keeps its own SQL — tables, key columns and delivery
 * mechanics all differ — but the lifecycle is identical: read the due rows,
 * attempt each delivery, then record the outcome with an exponential
 * backoff. Centralising the loop keeps the backoff curve and attempt
 * accounting identical across all alert streams.
 */

/**
 * Exponential retry backoff shared by every outbox: 2s, 4s, 8s, … capped at
 * 300s. The exponent cap of 9 (512s) exists so the 300s ceiling is actually
 * reachable — a cap of 8 silently topped out at 256s.
 */
export function outboxRetrySeconds(attempt: number): number {
  return Math.min(300, 2 ** Math.min(attempt, 9));
}

export type OutboxAttemptResult = {
  delivered: boolean;
  /** Provider-supplied retry hint (e.g. Discord retry-after), if any. */
  retryAfterSeconds?: number | null;
};

export type OutboxOutcome = {
  delivered: boolean;
  attempt: number;
  retrySeconds: number;
};

export type OutboxDrainConfig<Row> = {
  /** Due rows, already bounded by the caller's own LIMIT. */
  fetchPending(): Promise<Row[]>;
  attemptCount(row: Row): number;
  /** One delivery attempt. Routine failures return delivered=false. */
  attempt(row: Row): Promise<OutboxAttemptResult>;
  /** Persist the outcome (delivered flag, attempt count, next retry). */
  record(row: Row, outcome: OutboxOutcome): Promise<void>;
  /** Optional post-record hook (logging, follow-up state). */
  onRecorded?(row: Row, outcome: OutboxOutcome): Promise<void> | void;
  /**
   * Attempt the fetched rows concurrently. Only safe when rows never share
   * an underlying outbox record (the fetch LIMIT bounds the fan-out).
   */
  concurrent?: boolean;
};

export async function drainOutbox<Row>(
  config: OutboxDrainConfig<Row>,
): Promise<void> {
  const pending = await config.fetchPending();
  const drainRow = async (row: Row): Promise<void> => {
    const result = await config.attempt(row);
    const attempt = config.attemptCount(row) + 1;
    const outcome: OutboxOutcome = {
      delivered: result.delivered,
      attempt,
      retrySeconds: result.retryAfterSeconds ?? outboxRetrySeconds(attempt),
    };
    await config.record(row, outcome);
    await config.onRecorded?.(row, outcome);
  };

  if (config.concurrent) {
    await Promise.all(pending.map((row) => drainRow(row)));
    return;
  }
  for (const row of pending) {
    await drainRow(row);
  }
}
