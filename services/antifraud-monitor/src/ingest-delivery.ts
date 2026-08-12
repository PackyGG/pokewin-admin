import { createHmac } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import * as Sentry from "@sentry/node";

import type { Config } from "./config.js";
import { signedIngestTarget } from "./notification-routes.js";
import { createPromiseCache } from "./promise-cache.js";
import { severity } from "./scoring.js";

const CURSOR = "admin-dashboard";
const LEADER_LOCK = 841_772_993;
// Containment signals perform an idempotent MAIN lock before acknowledgement.
// Keep each signed request below the dashboard's function timeout even when
// an entire batch contains withdrawal-lock commands.
const BATCH_SIZE = 10;
// Containment admission may trigger several bounded downstream lock calls in
// the dashboard. Keep those requests single-account so one slow target cannot
// push an otherwise healthy batch past the end-to-end delivery deadline.
const CONTAINMENT_BATCH_SIZE = 1;
const DELIVERY_INTERVAL_MS = 5_000;
const DELIVERY_TIMEOUT_MS = 10_000;
const DELIVERY_MAX_AGE_SQL = "1 hour";
const MAX_BACKOFF_MS = 60_000;
const MAX_EVIDENCE_PAYLOAD_BYTES = 3 * 1024;
/**
 * Row bound for the operations queue probe. The pending set is tiny in steady
 * state — the one-hour write-off at the top of every flush stamps everything
 * older — but a delivery outage keeps rows pending for as long as it lasts, so
 * the probe reads at most this many and reports whether it hit the bound. An
 * observability read must never be the query that hurts the pool.
 */
const QUEUE_PROBE_LIMIT = 1_000;
/**
 * Memo window for the queue probe, so a dashboard (or several replicas of it)
 * polling the operations route cannot amplify into a per-request aggregate.
 */
const QUEUE_PROBE_TTL_MS = 5_000;

function observe(report: () => void): void {
  try {
    report();
  } catch {
    // Delivery state and retries are authoritative; telemetry is best-effort.
  }
}

export type RiskEventRow = {
  id: string;
  case_id: string | null;
  session_id: string | null;
  user_id: string;
  username: string | null;
  event_type: string;
  source: string;
  source_ref: string | null;
  score_delta: number;
  score_after: number;
  title: string;
  detail: string | null;
  payload: unknown;
  occurred_at: Date;
  recorded_at: Date;
};

type IngestEvent = {
  type: "signal";
  id: string;
  kind: string;
  severity: "low" | "medium" | "high" | "critical";
  riskScore: number;
  userId: string;
  username: string | null;
  summary: string;
  payload: Record<string, unknown>;
  at: string;
};

type IngestResponse = {
  ok?: unknown;
  accepted?: unknown;
  duplicates?: unknown;
  stale?: unknown;
  // Events the dashboard could not parse. Returned on its "nothing actionable"
  // branch; a permanent rejection, not a transient one.
  skipped?: unknown;
  // The dashboard answers HTTP 200 with locksSkipped > 0 when containment
  // validation rejected the command or runDeferredContainment did not return
  // "locked" (including "failed"). Delivery succeeded; the LOCK did not. This
  // must be read, or a lock that never happened gets a lock receipt.
  locksSkipped?: unknown;
};

// Containment signals that are gated purely on `dashboard_delivered_at`.
// `fiat_blacklisted_email_domain` is deliberately absent: it is gated on the
// blacklist match row instead and is read by its own query below.
const DASHBOARD_CONTAINMENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "abstract_email_catchall",
  "behavioral_withdrawal_containment",
  "critical_risk_signup",
  "fiat_deposit_identity_containment",
  "fiat_eligibility_containment",
  "whop_history_auto_ban",
]);

/**
 * Every event type whose delivery carries an automatic containment command,
 * including the blacklist type that the read above deliberately excludes.
 * The expiry report and the operations queue probe both count "containment"
 * from this one list so the two surfaces cannot drift apart.
 */
const CONTAINMENT_EVENT_TYPES: readonly string[] = [
  ...DASHBOARD_CONTAINMENT_EVENT_TYPES,
  "fiat_blacklisted_email_domain",
];

/** Bounded probe of the undelivered risk-event queue. */
export type IngestDeliveryQueue = {
  /** Undelivered events, counted up to `probeLimit`. */
  pending: number;
  /** True when the probe hit its bound, so `pending` is a floor, not a total. */
  pendingCapped: boolean;
  /**
   * Of the probed rows, those still inside the delivery window. The remainder
   * are already past the cutoff and will be written off, not delivered.
   */
  pendingDeliverable: number;
  /** Of the probed rows, those carrying an automatic containment command. */
  pendingContainment: number;
  probeLimit: number;
  /**
   * Oldest probed row by delivery order (`recorded_at`) and by the clock the
   * one-hour cutoff uses (`occurred_at`). Both are taken over the probed
   * prefix, which is the whole queue whenever `pendingCapped` is false.
   */
  oldestPendingRecordedAt: string | null;
  oldestPendingOccurredAt: string | null;
  /** Queue age: how long the oldest probed event has been waiting. */
  oldestPendingAgeMs: number | null;
};

/** Operational view of the delivery loop. Counts and timestamps only. */
export type IngestDeliverySnapshot = {
  running: boolean;
  stopped: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastDeliveredCount: number;
  consecutiveFailures: number;
  /** Retry backlog: when the failure backoff lets the next attempt run. */
  nextAttemptAt: string | null;
  nextAttemptInMs: number | null;
  /** Since-boot totals for the one-hour write-off. */
  expiredTotal: number;
  expiredContainmentTotal: number;
  maxAge: string;
  batchSize: number;
  containmentBatchSize: number;
  intervalMs: number;
  /** null when the bounded queue probe could not run (or after stop()). */
  queue: IngestDeliveryQueue | null;
};

type QueueProbeRow = {
  pending: number;
  pending_deliverable: number;
  pending_containment: number;
  oldest_recorded_at: Date | null;
  oldest_occurred_at: Date | null;
};

/** pg returns timestamptz as Date; anything else is reported as unknown. */
function isoOrNull(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function objectPayload(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const payload = value as Record<string, unknown>;
  if (
    Buffer.byteLength(JSON.stringify(payload), "utf8") <=
    MAX_EVIDENCE_PAYLOAD_BYTES
  ) {
    return payload;
  }

  // Large evidence blobs must not erase the small command envelope that the
  // dashboard validates before applying containment. The former all-or-
  // nothing truncation reduced an otherwise valid Fiat identity command to
  // `{ deliveryPayloadTruncated: true }`, so the dashboard stored the alert
  // but correctly refused to lock the account. Preserve only the reviewed
  // admission fields; bulky provider/network evidence remains available in
  // the Antifraud database and webapp.
  // EVERY key any dashboard containment validator reads must appear here. A
  // missing key does not degrade gracefully: the validator returns null, the
  // dashboard records the alert and skips containment permanently, and no
  // outbox row is written so nothing ever retries. `riskBand`, `reasonCode`
  // (SINGULAR — distinct from the plural `reasonCodes` below) and `actions`
  // were absent, which silently disabled critical-signup containment for
  // exactly the 70-100 score accounts whose evidence is large enough to
  // truncate. Guarded by the CONTAINMENT_PAYLOAD_KEYS fixture.
  const preservedKeys = [
    "containmentRequired",
    "containmentAction",
    "reviewOnly",
    "environment",
    "intentId",
    "reasonCode",
    "reasonCodes",
    "reviewCodes",
    "watchCodes",
    "riskBand",
    "actions",
    "matchSource",
    "matchCount",
    "qualifyingBattleCount",
    "distinctFlaggedCreators",
    "emailRiskType",
    "refundedAmountClusterActiveUntil",
    "provider",
    "paymentId",
    "depositIntentId",
    "priorDisputeCount",
    "priorRefundCount",
  ] as const;
  const compact: Record<string, unknown> = {
    deliveryPayloadTruncated: true,
  };
  for (const key of preservedKeys) {
    if (payload[key] !== undefined) compact[key] = payload[key];
  }
  return compact;
}

export function signIngest(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  return (
    "sha256=" +
    createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")
  );
}

export function ingestEvent(row: RiskEventRow): IngestEvent {
  const summary =
    row.detail && row.detail !== row.title
      ? `${row.title} — ${row.detail}`
      : row.title;
  return {
    type: "signal",
    id: row.id,
    kind: row.event_type,
    severity: severity(row.score_after),
    riskScore: row.score_after,
    userId: row.user_id,
    username: row.username,
    summary: summary.slice(0, 500),
    payload: {
      ...objectPayload(row.payload),
      caseId: row.case_id,
      sessionId: row.session_id,
      source: row.source,
      sourceRef: row.source_ref,
      scoreDelta: row.score_delta,
      scoreAfter: row.score_after,
    },
    at: row.occurred_at.toISOString(),
  };
}

export function deliveryBackoffMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(
    MAX_BACKOFF_MS,
    DELIVERY_INTERVAL_MS * 2 ** Math.min(exponent, 10),
  );
}

function byRecordedOrder(left: RiskEventRow, right: RiskEventRow): number {
  const delta = left.recorded_at.getTime() - right.recorded_at.getTime();
  return delta !== 0 ? delta : left.id.localeCompare(right.id);
}

function byContainmentDeliveryOrder(
  left: RiskEventRow,
  right: RiskEventRow,
): number {
  const leftPriority = left.event_type === "whop_history_auto_ban" ? 0 : 1;
  const rightPriority = right.event_type === "whop_history_auto_ban" ? 0 : 1;
  return leftPriority - rightPriority || byRecordedOrder(left, right);
}

export class IngestDelivery {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = false;
  private consecutiveFailures = 0;
  private nextAttemptAt = 0;
  // Delivery telemetry, read by `snapshot()` and served on
  // GET /v1/operations/delivery. Until that route existed these counters were
  // written and never read: an outage was visible only in the logs.
  private lastAttemptAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastDeliveredCount = 0;
  // Since-boot totals for the one-hour write-off below. They are reported in
  // the log line itself, because a single expiry line cannot show whether the
  // service has been shedding events all day.
  private expiredTotal = 0;
  private expiredContainmentTotal = 0;
  // Single-key memo: the probe is identical for every caller, so a burst of
  // operations requests collapses onto one aggregate. The arrow defers
  // `loadQueue`, so capturing `this` in a field initializer is safe.
  private readonly queueProbe = createPromiseCache<
    "queue",
    IngestDeliveryQueue
  >(() => this.loadQueue(), QUEUE_PROBE_TTL_MS);

  constructor(
    private readonly config: Config,
    private readonly pool: pg.Pool,
    private readonly log: FastifyBaseLogger,
    private readonly send: typeof fetch = fetch,
  ) {}

  /**
   * Operational view of the delivery pipeline for GET /v1/operations/delivery.
   * Everything but `queue` is already in memory; `queue` is one bounded,
   * memoized aggregate over the partial pending index. No user ids, addresses,
   * fingerprints or credentials are exposed — counts and timestamps only.
   */
  async snapshot(now = Date.now()): Promise<IngestDeliverySnapshot> {
    return {
      running: this.running,
      stopped: this.stopped,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastDeliveredCount: this.lastDeliveredCount,
      consecutiveFailures: this.consecutiveFailures,
      // 0 is the "no backoff pending" sentinel, not an epoch timestamp.
      nextAttemptAt:
        this.nextAttemptAt > 0
          ? new Date(this.nextAttemptAt).toISOString()
          : null,
      nextAttemptInMs:
        this.nextAttemptAt > now ? this.nextAttemptAt - now : null,
      expiredTotal: this.expiredTotal,
      expiredContainmentTotal: this.expiredContainmentTotal,
      maxAge: DELIVERY_MAX_AGE_SQL,
      batchSize: BATCH_SIZE,
      containmentBatchSize: CONTAINMENT_BATCH_SIZE,
      intervalMs: DELIVERY_INTERVAL_MS,
      queue: await this.queueSnapshot(),
    };
  }

  /**
   * The queue half degrades to null instead of failing the whole route: the
   * in-memory counters are exactly what an operator needs when the database is
   * the thing that is broken.
   */
  private async queueSnapshot(): Promise<IngestDeliveryQueue | null> {
    if (this.stopped) return null;
    try {
      return await this.queueProbe("queue");
    } catch (error) {
      this.log.warn(
        { err: error },
        "Antifraud delivery queue probe failed; serving counters only",
      );
      return null;
    }
  }

  private async loadQueue(): Promise<IngestDeliveryQueue> {
    // The inner ORDER BY/LIMIT drives risk_events_dashboard_pending_idx —
    // `(recorded_at, id) WHERE dashboard_delivered_at IS NULL` from migration
    // 028 — so the scan is an index prefix bounded to QUEUE_PROBE_LIMIT rows
    // however deep the backlog is. Pool-level query: no client checkout, so it
    // can never sit in front of the delivery loop's leader transaction.
    const result = await this.pool.query<QueueProbeRow>(
      `
        SELECT
          count(*)::int AS pending,
          count(*) FILTER (WHERE deliverable)::int AS pending_deliverable,
          count(*) FILTER (WHERE containment)::int AS pending_containment,
          min(recorded_at) AS oldest_recorded_at,
          min(occurred_at) AS oldest_occurred_at
        FROM (
          SELECT
            recorded_at,
            occurred_at,
            occurred_at >= now() - $2::interval AS deliverable,
            event_type = ANY($3::text[]) AS containment
          FROM risk_events
          WHERE dashboard_delivered_at IS NULL
          ORDER BY recorded_at, id
          LIMIT $1
        ) probed
      `,
      [QUEUE_PROBE_LIMIT, DELIVERY_MAX_AGE_SQL, CONTAINMENT_EVENT_TYPES],
    );
    const row = result.rows[0];
    const pending = Number(row?.pending ?? 0);
    const oldestOccurredAt =
      row?.oldest_occurred_at instanceof Date ? row.oldest_occurred_at : null;
    return {
      pending,
      pendingCapped: pending >= QUEUE_PROBE_LIMIT,
      pendingDeliverable: Number(row?.pending_deliverable ?? 0),
      pendingContainment: Number(row?.pending_containment ?? 0),
      probeLimit: QUEUE_PROBE_LIMIT,
      oldestPendingRecordedAt: isoOrNull(row?.oldest_recorded_at),
      oldestPendingOccurredAt: isoOrNull(oldestOccurredAt),
      oldestPendingAgeMs: oldestOccurredAt
        ? Math.max(0, Date.now() - oldestOccurredAt.getTime())
        : null,
    };
  }

  // `stop()` is terminal — the process owns exactly one IngestDelivery and
  // never restarts it — so `stopped` is only ever set, never cleared here.
  async start(): Promise<void> {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), DELIVERY_INTERVAL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    // Set before the timer is cleared: a `setImmediate` continuation queued by
    // a full batch must not open a fresh connection on a pool that shutdown is
    // already ending, which surfaced as a delivery error on every clean deploy.
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
    while (this.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async flushOnce(): Promise<number> {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      // The leader lease must be transaction-scoped. A session advisory lock
      // can survive an interrupted cleanup while the pg Pool keeps that
      // physical connection alive. Once that poisoned connection goes idle,
      // every other pool checkout sees the lock as held and silently returns
      // without delivering anything. The transaction lock is released by
      // PostgreSQL on COMMIT, ROLLBACK, connection loss, or process exit.
      await client.query("BEGIN");
      transactionOpen = true;
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock($1) AS acquired",
        [LEADER_LOCK],
      );
      if (lock.rows[0]?.acquired !== true) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return 0;
      }

      // Account Review is an operational queue, not a historical event
      // archive. If delivery was unavailable for longer than one hour, close
      // the old dashboard receipts without replaying stale cases or automatic
      // containment. Discord has its own durable receipt and is unaffected.
      //
      // The write-off is deliberate; its SILENCE was not. The result used to be
      // discarded, so an outage longer than the window expired an unknown
      // number of signals — automatic containment commands among them, which
      // means an account lock that never issued — and the very next tick still
      // recorded a clean success. Group the expired rows by type so the log
      // says exactly what was given up on, and keep a since-boot total so a
      // repeated outage is distinguishable from a one-off.
      const expired = await client.query<{
        event_type: string;
        expired: number;
      }>(
        `
          WITH aged_out AS (
            UPDATE risk_events
            SET dashboard_delivered_at = COALESCE(dashboard_delivered_at, now())
            WHERE dashboard_delivered_at IS NULL
              AND occurred_at < now() - $1::interval
            RETURNING event_type
          )
          SELECT event_type, count(*)::int AS expired
          FROM aged_out
          GROUP BY event_type
        `,
        [DELIVERY_MAX_AGE_SQL],
      );
      this.reportExpiredEvents(expired.rows);

      // Split deliberately into two indexable reads instead of one six-branch
      // disjunction over a post-join column. The old shape referenced
      // `match.lock_delivered_at` inside the OR, so the whole predicate had to
      // be evaluated after a join whose ON clause concatenated a literal onto a
      // column — no index could serve it and the planner could not BitmapOr the
      // partial indexes that already exist. Both halves below drive off a
      // partial index and are merged in JS, preserving the original
      // "containment first, then general stream" ordering.
      const dashboardContainment = await client.query<RiskEventRow>(
        `
          SELECT
            re.id, re.case_id, re.session_id, re.user_id, s.username,
            re.event_type, re.source, re.source_ref, re.score_delta,
            re.score_after, re.title, re.detail, re.payload,
            re.occurred_at, re.recorded_at
          FROM risk_events re
          -- LEFT, in all three delivery reads: the subject row is joined only
          -- to decorate the signal with a username, which is nullable the whole
          -- way to the dashboard. An inner join turns a missing subject into an
          -- invisible event that no read ever returns and the one-hour cutoff
          -- silently acks, so the signal never reaches Account Review at all.
          LEFT JOIN subjects s ON s.user_id = re.user_id
          WHERE re.dashboard_delivered_at IS NULL
            AND re.occurred_at >= now() - $2::interval
            AND (
              re.event_type = 'abstract_email_catchall'
              OR re.event_type = 'behavioral_withdrawal_containment'
              OR re.event_type = 'critical_risk_signup'
              OR re.event_type = 'fiat_deposit_identity_containment'
              OR re.event_type = 'fiat_eligibility_containment'
              OR re.event_type = 'whop_history_auto_ban'
            )
          -- A provider-confirmed prior dispute/refund is an account-access
          -- decision, so it must not wait behind historical review/lock
          -- receipts. Preserve FIFO inside each priority band.
          ORDER BY
            CASE WHEN re.event_type = 'whop_history_auto_ban' THEN 0 ELSE 1 END,
            re.recorded_at,
            re.id
          LIMIT $1
        `,
        [CONTAINMENT_BATCH_SIZE, DELIVERY_MAX_AGE_SQL],
      );

      // The blacklist half keeps the original LEFT JOIN and its exact ON
      // predicate — an event whose match row is missing entirely still has to
      // be delivered, which an inner join would silently drop. The added
      // `source_event_id` equality is what makes the join an index probe on the
      // unique key. Source event IDs can themselves contain colons (for
      // example `signup:<user-id>`), so remove only the delivery prefix rather
      // than using split_part(..., 2), which truncates those IDs to `signup`.
      // The concatenation predicate stays as an exact-semantics filter on top.
      const blacklistContainment = await client.query<RiskEventRow>(
        `
          SELECT
            re.id, re.case_id, re.session_id, re.user_id, s.username,
            re.event_type, re.source, re.source_ref, re.score_delta,
            re.score_after, re.title, re.detail, re.payload,
            re.occurred_at, re.recorded_at
          FROM risk_events re
          LEFT JOIN subjects s ON s.user_id = re.user_id
          LEFT JOIN fiat_email_domain_matches match ON
            match.source_event_id = substring(
              re.source_ref FROM position(':' IN re.source_ref) + 1
            )
            AND (
              re.source_ref = 'blacklisted-signup:' || match.source_event_id
              OR re.source_ref =
                'blacklisted-checkout:' || match.source_event_id
            )
          WHERE re.event_type = 'fiat_blacklisted_email_domain'
            AND re.occurred_at >= now() - $2::interval
            -- An event with NO match row can never be ACKed here:
            -- confirmContainmentEvents joins through the same match row, so it
            -- updates zero rows, the lock_delivered_at IS NULL test stays
            -- true, and this branch re-selects the same event forever. Because
            -- containment branch returns before the ordinary stream is reached
            -- and CONTAINMENT_BATCH_SIZE is 1, one unmatched row starved
            -- Account Review delivery completely and spun at the poll rate.
            -- Requiring the match row keeps the fast path to events it can
            -- actually confirm; unmatched ones still deliver (and DO get a
            -- receipt) through the general query below, which filters only on
            -- dashboard_delivered_at and the same one-hour window.
            AND match.source_event_id IS NOT NULL
            -- Gate on the DELIVERY receipt, not the LOCK receipt. These are two
            -- different facts: dashboard_delivered_at means the dashboard
            -- received this event, lock_delivered_at means the withdrawal
            -- lock is provably present on MAIN. Gating delivery on the lock
            -- receipt forced the delivery path to stamp lock_delivered_at just
            -- to stop re-selecting the row — which marked locks the dashboard
            -- had actually SKIPPED as delivered and removed them from
            -- confirmLocks()'s pending set, permanently disabling the only
            -- check that verifies the lock against MAIN.
            AND re.dashboard_delivered_at IS NULL
            AND re.payload ->> 'reviewOnly' IS DISTINCT FROM 'true'
          ORDER BY re.recorded_at, re.id
          LIMIT $1
        `,
        [CONTAINMENT_BATCH_SIZE, DELIVERY_MAX_AGE_SQL],
      );

      // The two reads are disjoint on `event_type` in SQL; re-asserting it in
      // JS keeps the merge correct no matter which half a row came back from.
      const containmentRows = [
        ...dashboardContainment.rows.filter((event) =>
          DASHBOARD_CONTAINMENT_EVENT_TYPES.has(event.event_type),
        ),
        ...blacklistContainment.rows.filter(
          (event) =>
            event.event_type === "fiat_blacklisted_email_domain" &&
            objectPayload(event.payload).reviewOnly !== true,
        ),
      ]
        .sort(byContainmentDeliveryOrder)
        .slice(0, CONTAINMENT_BATCH_SIZE);
      if (containmentRows.length > 0) {
        const containmentDelivery = await this.deliverEvents(containmentRows);
        await this.confirmDashboardEvents(client, containmentRows);
        await this.confirmContainmentEvents(
          client,
          containmentRows,
          containmentDelivery,
        );
        await client.query("COMMIT");
        transactionOpen = false;
        return containmentRows.length;
      }

      const events = await client.query<RiskEventRow>(
        `
          SELECT
            re.id, re.case_id, re.session_id, re.user_id, s.username,
            re.event_type, re.source, re.source_ref, re.score_delta,
            re.score_after, re.title, re.detail, re.payload,
            re.occurred_at, re.recorded_at
          FROM risk_events re
          LEFT JOIN subjects s ON s.user_id = re.user_id
          -- A tuple cursor alone can skip a transaction that started earlier
          -- but committed after the cursor advanced. This receipt is written
          -- only after the dashboard confirms the complete signed batch.
          WHERE re.dashboard_delivered_at IS NULL
            AND re.occurred_at >= now() - $2::interval
          ORDER BY re.recorded_at, re.id
          LIMIT $1
        `,
        [BATCH_SIZE, DELIVERY_MAX_AGE_SQL],
      );
      if (events.rows.length === 0) {
        await client.query("COMMIT");
        transactionOpen = false;
        return 0;
      }

      await this.deliverEvents(events.rows);
      await this.confirmDashboardEvents(client, events.rows);

      const last = events.rows.at(-1);
      // Unreachable while the empty check above returns first, but it must not
      // be the one path that leaves the transaction open: `finally` releases
      // the client either way, handing the pool a connection still inside BEGIN
      // and still holding the leader lease. COMMIT, not ROLLBACK — the batch
      // was already delivered and its receipts written just above.
      if (!last) {
        await client.query("COMMIT");
        transactionOpen = false;
        return 0;
      }
      await client.query(
        `
          UPDATE ingest_delivery_cursors
          SET recorded_at = $2, event_id = $3, updated_at = now()
          WHERE sink = $1
            AND (recorded_at, event_id) < ($2, $3::uuid)
        `,
        [CURSOR, last.recorded_at, last.id],
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return events.rows.length;
    } catch (error) {
      if (transactionOpen) {
        await client
          .query("ROLLBACK")
          .catch((rollbackError) =>
            this.log.warn(
              { err: rollbackError },
              "Antifraud ingest delivery rollback failed",
            ),
          );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Log the events the one-hour cutoff just wrote off. Containment types are
   * counted separately: an expired ordinary signal only costs a queue entry,
   * an expired containment command costs the account lock it was carrying.
   */
  private reportExpiredEvents(
    rows: readonly { event_type: string; expired: number }[],
  ): void {
    if (rows.length === 0) return;
    const byEventType: Record<string, number> = {};
    let total = 0;
    let containment = 0;
    for (const row of rows) {
      const count = Number(row.expired);
      if (!Number.isFinite(count) || count <= 0) continue;
      byEventType[row.event_type] = count;
      total += count;
      if (CONTAINMENT_EVENT_TYPES.includes(row.event_type)) {
        containment += count;
      }
    }
    if (total === 0) return;
    this.expiredTotal += total;
    this.expiredContainmentTotal += containment;
    this.log.error(
      {
        expired: total,
        expiredContainment: containment,
        byEventType,
        expiredSinceBoot: this.expiredTotal,
        expiredContainmentSinceBoot: this.expiredContainmentTotal,
        maxAge: DELIVERY_MAX_AGE_SQL,
      },
      "Antifraud dashboard delivery expired undelivered risk events",
    );
  }

  private async deliverEvents(events: RiskEventRow[]): Promise<{
    locksSkipped: number;
    stale: number;
    skipped: number;
  }> {
    const target = signedIngestTarget(this.config);
    if (!target) {
      throw new Error("Dashboard ingest is not configured");
    }
    const rawBody = JSON.stringify({
      events: events.map(ingestEvent),
    });
    const timestamp = String(Date.now());
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("Dashboard ingest timed out"));
      }, DELIVERY_TIMEOUT_MS);
      timeout.unref();
    });
    let result: IngestResponse;
    try {
      // Race the complete response-body read, not only the initial fetch.
      // Some runtimes resolve fetch after headers and then ignore an abort
      // while a streamed body stalls; the explicit deadline still releases
      // the database lease and lets the durable event retry.
      result = await Promise.race([
        (async () => {
          const response = await this.send(target.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-antifraud-timestamp": timestamp,
              "x-antifraud-signature": signIngest(
                target.secret,
                timestamp,
                rawBody,
              ),
            },
            body: rawBody,
            signal: controller.signal,
          });
          if (!response.ok) {
            throw new Error(
              `Dashboard ingest returned HTTP ${response.status}`,
            );
          }
          return (await response.json()) as IngestResponse;
        })(),
        deadline,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    // `skipped` is the dashboard's count for events it could not parse at all.
    // That verdict is permanent — the same bytes get the same answer on every
    // retry — so excluding it from the arithmetic meant such a batch could
    // never confirm: the transaction rolls back, the identical oldest rows are
    // re-selected on the next poll, and every event behind them waits for the
    // one-hour cutoff. Count it as a dead letter (acked, and reported below)
    // rather than a head-of-line block. NaN is left to fail confirmation, the
    // same as a malformed `accepted`.
    const stale = Number(result.stale ?? 0);
    const skipped = Number(result.skipped ?? 0);
    const confirmed =
      Number(result.accepted ?? 0) +
      Number(result.duplicates ?? 0) +
      stale +
      skipped;
    if (result.ok !== true || confirmed !== events.length) {
      throw new Error(
        `Dashboard ingest confirmed ${confirmed}/${events.length} events`,
      );
    }
    if (stale > 0 || skipped > 0) {
      // Acknowledged but never processed. The worker's age window and the
      // dashboard's are evaluated on different hosts against different clocks,
      // so an event selected just inside the window can be dropped as stale on
      // arrival — including a containment command. Silent until now.
      this.log.warn(
        { stale, skipped, batchSize: events.length },
        "dashboard discarded events from an accepted delivery batch",
      );
    }
    const locksSkipped = Number(result.locksSkipped ?? 0);
    if (Number.isFinite(locksSkipped) && locksSkipped > 0) {
      // Not an error: the batch WAS delivered and is correctly acknowledged.
      // But the lock did not happen, so it must stay visible to confirmLocks()
      // instead of being silently written off.
      this.log.warn(
        { locksSkipped, batchSize: events.length },
        "dashboard accepted delivery but skipped containment locks",
      );
    }
    return {
      locksSkipped: Number.isFinite(locksSkipped) ? locksSkipped : 0,
      stale: Number.isFinite(stale) ? stale : 0,
      skipped: Number.isFinite(skipped) ? skipped : 0,
    };
  }

  private async confirmContainmentEvents(
    client: pg.PoolClient,
    events: RiskEventRow[],
    result: { locksSkipped: number; stale: number; skipped: number },
  ): Promise<void> {
    const eventIds = events
      .filter(
        (event) =>
          event.event_type === "fiat_blacklisted_email_domain" &&
          objectPayload(event.payload).reviewOnly !== true,
      )
      .map((event) => event.id);
    if (eventIds.length === 0) return;
    // Stamping the lock receipt on a CLEAN success is deliberate: confirmLocks()
    // verifies against the MAIN *mirror*, which lags, so waiting for it would
    // leave freshly-locked accounts pending and re-alerting.
    //
    // But the dashboard also answers HTTP 200 when the command was discarded:
    // `locksSkipped` means containment validation/application failed, `stale`
    // means the ingest age gate rejected it, and `skipped` means the event did
    // not parse. Stamping any of those outcomes recorded a lock that never
    // existed and removed the row from confirmLocks()'s pending set — the only
    // code that checks user_feature_locks on MAIN. Containment batches contain
    // exactly one event, so the batch-level counters identify this command
    // without ambiguity. Keep the delivery receipt but withhold the lock
    // receipt, leaving confirmLocks() to prove the state with its own backoff.
    if (result.locksSkipped > 0 || result.stale > 0 || result.skipped > 0) {
      this.log.warn(
        {
          eventIds: eventIds.length,
          locksSkipped: result.locksSkipped,
          stale: result.stale,
          skipped: result.skipped,
        },
        "containment lock receipt withheld; leaving rows for MAIN verification",
      );
      return;
    }
    await client.query(
      `
        WITH confirmed_matches AS (
          UPDATE fiat_email_domain_matches AS match
          SET
            lock_delivered_at = COALESCE(match.lock_delivered_at, now()),
            last_error = NULL,
            updated_at = now()
          FROM risk_events AS event
          WHERE event.id = ANY($1::uuid[])
            AND (
              event.source_ref = 'blacklisted-signup:' || match.source_event_id
              OR event.source_ref =
                'blacklisted-checkout:' || match.source_event_id
            )
          RETURNING match.source_event_id, match.match_source, match.domain
        )
        SELECT count(*) FROM confirmed_matches
      `,
      [eventIds],
    );
  }

  private async confirmDashboardEvents(
    client: pg.PoolClient,
    events: RiskEventRow[],
  ): Promise<void> {
    const eventIds = events.map((event) => event.id);
    if (eventIds.length === 0) return;
    await client.query(
      `
        UPDATE risk_events
        SET dashboard_delivered_at =
          COALESCE(dashboard_delivered_at, now())
        WHERE id = ANY($1::uuid[])
      `,
      [eventIds],
    );
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running || Date.now() < this.nextAttemptAt) return;
    this.running = true;
    this.lastAttemptAt = new Date().toISOString();
    const startedAt = Date.now();
    try {
      const delivered = await this.flushOnce();
      this.lastDeliveredCount = delivered;
      this.lastSuccessAt = new Date().toISOString();
      this.consecutiveFailures = 0;
      this.nextAttemptAt = 0;
      observe(() => {
        Sentry.metrics.gauge("ingest.consecutive_failures", 0);
        if (delivered > 0) {
          Sentry.metrics.count("ingest.delivery_runs", 1, {
            attributes: { status: "ok" },
          });
          Sentry.metrics.count("ingest.events_delivered", delivered);
          Sentry.metrics.distribution(
            "ingest.delivery_duration",
            Date.now() - startedAt,
            { unit: "millisecond", attributes: { status: "ok" } },
          );
        }
      });
      if (delivered > 0 && !this.stopped) {
        setImmediate(() => void this.tick());
      }
    } catch (error) {
      this.consecutiveFailures += 1;
      this.nextAttemptAt =
        Date.now() + deliveryBackoffMs(this.consecutiveFailures);
      this.log.warn(
        {
          err:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : { name: "Error", message: "unknown delivery failure" },
          consecutiveFailures: this.consecutiveFailures,
        },
        "Antifraud dashboard ingest delivery failed",
      );
      observe(() => {
        Sentry.metrics.count("ingest.delivery_runs", 1, {
          attributes: { status: "error" },
        });
        Sentry.metrics.gauge(
          "ingest.consecutive_failures",
          this.consecutiveFailures,
        );
        Sentry.metrics.distribution(
          "ingest.delivery_duration",
          Date.now() - startedAt,
          { unit: "millisecond", attributes: { status: "error" } },
        );
        Sentry.logger.warn("Antifraud dashboard ingest delivery failed", {
          consecutive_failures: this.consecutiveFailures,
        });
      });
    } finally {
      this.running = false;
    }
  }
}
