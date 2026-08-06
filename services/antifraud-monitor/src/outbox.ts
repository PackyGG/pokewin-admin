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
  /**
   * False when the delivery was never put on the wire (an open circuit
   * breaker, for instance). Such a pass must NOT consume an attempt: a 60s
   * open circuit at a 1s poll tick would otherwise inflate `attempt_count` by
   * ~60 and push the row to the 300s backoff ceiling, delaying the alert by
   * minutes after the provider had already recovered. Defaults to true, so
   * existing outboxes keep counting every pass as an attempt.
   */
  attempted?: boolean;
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
    // A throw out of attempt() used to escape drainOutbox entirely, so
    // record() never ran: the row kept its attempt_count and next_attempt_at
    // and retried at the full poll rate forever, blocking the rest of the
    // batch behind it. An unexpected throw is just a failed delivery.
    let result: OutboxAttemptResult;
    try {
      result = await config.attempt(row);
    } catch {
      result = { delivered: false };
    }
    const attempted = result.attempted !== false;
    // An unattempted pass keeps the row's attempt count where it was, so the
    // backoff curve reflects real delivery attempts only.
    const attempt = config.attemptCount(row) + (attempted ? 1 : 0);
    const outcome: OutboxOutcome = {
      delivered: result.delivered,
      attempt,
      retrySeconds:
        result.retryAfterSeconds ??
        outboxRetrySeconds(attempted ? attempt : attempt + 1),
    };
    // record()'s own throw still propagates: a DB failure genuinely should
    // fail the phase rather than be swallowed as a delivery outcome.
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
