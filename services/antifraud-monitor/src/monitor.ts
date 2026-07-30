import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import type { Config } from "./config.js";
import type { Databases } from "./db.js";
import { DiscordAlerts, type DiscordAlert } from "./discord.js";
import {
  EnrichmentService,
  parseAbstractEmailResponse,
  parseAbstractIpResponse,
  parseFingerprintResponse,
  parseOpportifyResponse,
  parseProxycheckResponse,
  reweightFingerprintSignals,
  type EnrichmentResult,
} from "./enrichment.js";
import {
  fetchFiatWithdrawalHolds,
  fiatWithdrawalHoldMarker,
  FIAT_WITHDRAWAL_HOLD_SCORE,
  FIAT_WITHDRAWAL_HOLD_STREAM,
  type FiatWithdrawalHold,
} from "./fiat-withdrawal-holds.js";
import { FiatEmailDomainGuard } from "./fiat-email-domains.js";
import { FiatProblemAlerts } from "./fiat-alerts.js";
import { FreeBattleRiskMonitor } from "./free-battle-risk.js";
import type { LiveBus } from "./live.js";
import { processOrderedBatch } from "./ordered-ingestion.js";
import { drainOutbox } from "./outbox.js";
import { PollerHealth, type PollerHealthSnapshot } from "./poller-health.js";
import {
  assessProfile,
  normalizeSignupSignals,
  type ProviderCoverage,
} from "./profile-risk.js";
import {
  persistProfileAssessment,
  persistProviderEvidence,
  persistSignupIdentitySnapshot,
} from "./profile-store.js";
import { RiskyLocationStore } from "./risky-locations.js";
import { baseSignupSignals, severity } from "./scoring.js";
import { activityScoreFor, type ScoreWeights } from "./score-catalog.js";
import type { ScoreWeightStore } from "./score-weight-store.js";
import {
  HIGH_RISK_SIGNUP_SCORE,
  highRiskSignupMarker,
} from "./signup-alerts.js";
import { parseFailedSignup } from "./signup-failure.js";
import {
  fetchActivity,
  fetchNewSignups,
  signupContext,
  type SourceActivity,
} from "./source.js";
import type {
  ActiveSession,
  LiveEventType,
  Signal,
  Signup,
} from "./types.js";
import { adjustFiatRiskForPaymentMethod } from "./whop-payment-method.js";

export function storedSignals(value: unknown): Signal[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (signal): signal is Signal =>
      signal !== null &&
      typeof signal === "object" &&
      typeof (signal as Signal).key === "string" &&
      typeof (signal as Signal).title === "string" &&
      typeof (signal as Signal).detail === "string" &&
      typeof (signal as Signal).points === "number",
  );
}

type SequenceRule = {
  id: string;
  key: string;
  name: string;
  sequence: string[];
  exclude_before: string[];
  window_seconds: number;
  score_delta: number;
  action_type: string;
};

type RuleSession = Pick<
  ActiveSession,
  "id" | "case_id" | "user_id" | "current_score"
>;

type PreparedSignup = {
  context: Awaited<ReturnType<typeof signupContext>>;
  fingerprint: EnrichmentResult;
  proxycheck: EnrichmentResult;
  abstractIp: EnrichmentResult;
  abstractEmail: EnrichmentResult;
  opportify: EnrichmentResult;
  weights: ScoreWeights;
};

type RuleMatchWrite = {
  ruleId: string;
  caseId: string;
  sessionId: string;
  scoreDelta: number;
  actionType: string;
  evidence: Record<string, unknown>;
  alert: DiscordAlert;
};

type CatchallContainmentWrite = {
  signup: Signup;
  catchallSignal: Signal;
  signals: Signal[];
  score: number;
  durationSeconds: number;
};

type OpenSignupMonitor = (
  client: pg.PoolClient,
  signup: Signup,
  signals: Signal[],
  score: number,
  durationSeconds: number,
) => Promise<{ caseId: string; sessionId: string }>;

/**
 * Durably queue confirmed catch-all containment before unrelated provider
 * failures dead-letter the wider signup assessment.
 */
export async function persistAbstractCatchallContainment(
  pool: pg.Pool,
  input: CatchallContainmentWrite,
  openMonitor: OpenSignupMonitor,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sourceRef = `${input.signup.id}:abstract_email_catchall`;
    const existing = await client.query<{ exists: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM risk_events
          WHERE source = 'abstract_email' AND source_ref = $1
        ) AS exists
      `,
      [sourceRef],
    );
    if (existing.rows[0]?.exists === true) {
      await client.query("COMMIT");
      return;
    }
    const opened = await openMonitor(
      client,
      input.signup,
      input.signals,
      input.score,
      input.durationSeconds,
    );
    const emailDomain =
      input.signup.email?.trim().toLowerCase().split("@").at(-1) ?? null;
    await client.query(
      `
        INSERT INTO risk_events (
          case_id, session_id, user_id, event_type, source, source_ref,
          score_delta, score_after, title, detail, payload, occurred_at
        ) VALUES (
          $1,$2,$3,'abstract_email_catchall','abstract_email',$4,
          0,$5,$6,$7,$8::jsonb,$9
        )
        ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL
        DO NOTHING
      `,
      [
        opened.caseId,
        opened.sessionId,
        input.signup.id,
        sourceRef,
        input.score,
        input.catchallSignal.title,
        input.catchallSignal.detail,
        JSON.stringify({
          containmentRequired: true,
          emailDomain,
          provider: "abstract_email",
          evidence: input.catchallSignal.payload ?? {},
        }),
        input.signup.created_at,
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

/**
 * Persist a first-time rule match and its score/state effects as one unit.
 *
 * The unique match row is the idempotency boundary. It must never commit
 * before the session and case updates, otherwise a crash makes the retry see a
 * duplicate and permanently skip the score/outcome change.
 */
export async function persistRuleMatch(
  pool: pg.Pool,
  input: RuleMatchWrite,
): Promise<number | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const match = await client.query<{ id: string }>(
      `
        INSERT INTO rule_matches(rule_id, case_id, session_id, evidence)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (rule_id, session_id) DO NOTHING
        RETURNING id
      `,
      [
        input.ruleId,
        input.caseId,
        input.sessionId,
        input.evidence,
      ],
    );
    if (match.rowCount === 0) {
      await client.query("COMMIT");
      return null;
    }

    const sessionUpdate = await client.query<{ current_score: number }>(
      `
        UPDATE monitor_sessions
        SET current_score=GREATEST(0,current_score+$2),
            peak_score=GREATEST(
              peak_score,
              GREATEST(0,current_score+$2)
            )
        WHERE id=$1
        RETURNING current_score
      `,
      [input.sessionId, input.scoreDelta],
    );
    const nextScore = Number(sessionUpdate.rows[0]?.current_score);
    if (sessionUpdate.rowCount !== 1 || !Number.isFinite(nextScore)) {
      throw new Error("Rule match session no longer exists");
    }

    const caseUpdate = await client.query(
      `
        UPDATE cases
        SET score=$2, peak_score=GREATEST(peak_score,$2),
            severity=$3,
            status=CASE
              WHEN $4 = 'manual_review' AND status IN ('monitoring','escalated')
                THEN 'in_review'
              ELSE status
            END,
            updated_at=now()
        WHERE id=$1
      `,
      [
        input.caseId,
        nextScore,
        severity(nextScore),
        input.actionType,
      ],
    );
    if (caseUpdate.rowCount !== 1) {
      throw new Error("Rule match case no longer exists");
    }

    await client.query(
      `
        INSERT INTO rule_alert_outbox(rule_match_id, payload)
        VALUES ($1,$2)
        ON CONFLICT (rule_match_id) DO NOTHING
      `,
      [
        match.rows[0]!.id,
        {
          ...input.alert,
          score: nextScore,
          severity: severity(nextScore),
        },
      ],
    );

    await client.query("COMMIT");
    return nextScore;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Grace period for a poller tick during process shutdown. */
const TICK_WATCHDOG_INTERVALS = 10;
/** `rule_definitions` is re-read at most this often instead of per event. */
const RULES_CACHE_TTL_MS = 30_000;
/** Signups per batch processed in parallel (each does 2 provider lookups). */
const SIGNUP_CONCURRENCY = 4;
/** Old failures retry in small, leader-only batches without blocking new input. */
const FAILED_SIGNUP_REPLAY_BATCH_SIZE = 20;
const FAILED_SIGNUP_REPLAY_DELAY_SECONDS = 60;
const FAILED_SIGNUP_REPLAY_MAX_ATTEMPTS = 5;

export class MonitorEngine {
  private running = false;
  private tickFailureRecorded = false;
  private timer: NodeJS.Timeout | null = null;
  private rulesCache: { at: number; rules: SequenceRule[] } | null = null;
  private readonly enrichment: EnrichmentService;
  private readonly discord: DiscordAlerts;
  private readonly fiatEmailDomains: FiatEmailDomainGuard;
  private readonly fiatAlerts: FiatProblemAlerts;
  private readonly freeBattleRisk: FreeBattleRiskMonitor;
  readonly riskyLocations: RiskyLocationStore;
  private readonly health = new PollerHealth();

  constructor(
    private readonly config: Config,
    private readonly db: Databases,
    private readonly live: LiveBus,
    private readonly scoreWeights: ScoreWeightStore,
    private readonly log: FastifyBaseLogger,
    private readonly onSignupAssessed?: (userId: string) => Promise<void>,
  ) {
    this.enrichment = new EnrichmentService(config);
    this.discord = new DiscordAlerts(config, log);
    this.fiatEmailDomains = new FiatEmailDomainGuard(db, log);
    this.fiatAlerts = new FiatProblemAlerts(config, db, log);
    this.freeBattleRisk = new FreeBattleRiskMonitor(config, db, log);
    this.riskyLocations = new RiskyLocationStore(db);
  }

  async start(): Promise<void> {
    await this.ensureCursor();
    await this.fiatEmailDomains.ensureCursor();
    await this.fiatAlerts.ensureCursor();
    await this.freeBattleRisk.ensureCursor();
    await this.tick();
    this.timer = setInterval(
      () => void this.tick(),
      this.config.POLL_INTERVAL_MS,
    );
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    const deadline = Date.now() + this.watchdogBudgetMs();
    while (this.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (this.running) {
      this.log.warn(
        "Antifraud monitor stopped while a tick was still in flight",
      );
    }
  }

  healthSnapshot(): PollerHealthSnapshot {
    return this.health.snapshot(this.config.POLL_STALE_AFTER_MS);
  }

  invalidateRules(): void {
    this.rulesCache = null;
  }

  private watchdogBudgetMs(): number {
    return this.config.POLL_INTERVAL_MS * TICK_WATCHDOG_INTERVALS;
  }

  /** Redacts configured secrets so raw provider errors never reach the logs. */
  private scrub(value: string): string {
    return [
      this.config.FINGERPRINT_SECRET_API_KEY,
      this.config.PROXYCHECK_API_KEY,
      this.config.OPPORTIFY_API_KEY,
      this.config.API_TOKEN,
      this.config.API_ADMIN_TOKEN,
      this.config.SOURCE_DATABASE_URL,
      this.config.ANTIFRAUD_DATABASE_URL,
      this.config.REDIS_URL,
      this.config.ANTIFRAUD_INGEST_SECRET,
    ].filter(
      (secret): secret is string =>
        typeof secret === "string" && secret.length > 0,
    ).reduce(
      (message, secret) =>
        message.replaceAll(secret, "[redacted]"),
      value,
    );
  }

  private safeError(error: unknown): {
    name: string;
    message: string;
    code?: string;
    stack?: string;
  } {
    const details = error as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
      stack?: unknown;
    };
    return {
      name: typeof details.name === "string" ? details.name : "Error",
      message: this.scrub(
        typeof details.message === "string" ? details.message : "unknown error",
      ),
      ...(typeof details.code === "string" ? { code: details.code } : {}),
      ...(typeof details.stack === "string"
        ? { stack: this.scrub(details.stack) }
        : {}),
    };
  }

  /**
   * The antifraud DB row is the system of record; the live broadcast is
   * best-effort. `LiveBus.publish` rejects while Redis is unavailable, so a
   * publish failure must never abort ingestion, rule evaluation or session
   * completion.
   */
  private async broadcast(
    type: LiveEventType,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.live.publish(type, data);
    } catch (error) {
      this.log.warn(
        { err: this.safeError(error), liveEvent: type },
        "Antifraud live broadcast failed",
      );
    }
  }

  private async ensureCursor(): Promise<void> {
    await this.db.antifraud.query(
      `
        INSERT INTO source_cursors(stream, occurred_at, source_id)
        VALUES
          ('signups', now() - interval '2 minutes', ''),
          ($1, now() - interval '10 minutes', '')
        ON CONFLICT (stream) DO NOTHING
      `,
      [FIAT_WITHDRAWAL_HOLD_STREAM],
    );
  }

  /**
   * Each phase runs in its own try/catch: a Redis outage, a poison signup or
   * a failing activity scan must never skip `completeExpiredSessions`, which
   * is what releases the partial unique indexes (`monitor_sessions_one_active_
   * per_user`, `cases_one_live_per_user`) for the next session of that user.
   */
  private async tick(): Promise<void> {
    if (this.running) {
      // Never clear this flag while the original promise is still running.
      // Doing so starts a second tick over the same cursor and defeats both
      // the in-process exclusion and graceful shutdown. `/health` restarts a
      // genuinely wedged leader after POLLER_LIVENESS_TIMEOUT_MS.
      this.health.tickSkipped();
      return;
    }
    this.running = true;
    this.tickFailureRecorded = false;
    this.health.tickStarted();
    let lockClient: pg.PoolClient | null = null;
    let leader = false;
    try {
      lockClient = await this.db.antifraud.connect();
      const lock = await lockClient.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS acquired",
        [841_772_992],
      );
      leader = lock.rows[0]?.acquired === true;
      if (!leader) {
        this.health.standby();
        return;
      }
      // Mark takeover immediately. If the newly elected replica hangs before
      // its first success, `/health` must treat it as the leader and restart it.
      this.health.leaderAcquired();

      const signupMetrics = await this.runPhase("signups", () =>
        this.scanSignups(),
      );
      await this.runPhase("fiat-withdrawal-holds", () =>
        this.scanFiatWithdrawalHolds(),
      );
      await this.runPhase("signup-alerts", () =>
        this.deliverPendingSignupAlerts(),
      );
      await this.runPhase("rule-alerts", () =>
        this.deliverPendingRuleAlerts(),
      );
      await this.runPhase("fiat-email-domains", () =>
        this.fiatEmailDomains.process(),
      );
      await this.runPhase("fiat-withdrawal-hold-alerts", () =>
        this.deliverPendingFiatWithdrawalHoldAlerts(),
      );
      await this.runPhase("fiat-problem-alerts", () =>
        this.fiatAlerts.process(),
      );
      await this.runPhase("free-battle-risk", () =>
        this.freeBattleRisk.process(),
      );
      const activitiesProcessed = await this.runPhase("activity", () =>
        this.scanActiveSessions(),
      );
      const completed = await this.runPhase("completion", async () => {
        await this.completeExpiredSessions();
        return true;
      });

      if (
        !this.tickFailureRecorded &&
        signupMetrics &&
        activitiesProcessed !== null &&
        completed
      ) {
        this.health.tickSucceeded({
          signupsProcessed: signupMetrics.processed,
          signupsRecovered: signupMetrics.recovered,
          signupFailuresPending: signupMetrics.failuresPending,
          activitiesProcessed,
          signupBacklogPossible: signupMetrics.backlogPossible,
          signupCursorLagMs: signupMetrics.cursorLagMs,
        });
      }
    } catch (error) {
      this.recordTickFailure("lease", error);
    } finally {
      if (leader && lockClient) {
        await lockClient
          .query("SELECT pg_advisory_unlock($1)", [841_772_992])
          .catch((error) =>
            this.log.error(
              { err: this.safeError(error) },
              "Failed to release poller leader lock",
            ),
          );
      }
      lockClient?.release();
      this.running = false;
    }
  }

  private async runPhase<T>(
    phase: string,
    run: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      this.recordTickFailure(phase, error);
      return null;
    }
  }

  private recordTickFailure(phase: string, error: unknown): void {
    const safe = this.safeError(error);
    // Every phase is logged, but the health counter takes at most one failure
    // per tick so three independent phase errors cannot inflate the streak.
    if (!this.tickFailureRecorded) {
      this.tickFailureRecorded = true;
      this.health.tickFailed(`${phase}: ${safe.message}`);
    }
    this.log.error(
      { err: safe, phase },
      `Antifraud monitor ${phase} phase failed: ${safe.name} ${safe.code ?? "unknown"} ${safe.message}`,
    );
  }

  private async scanSignups(): Promise<{
    processed: number;
    recovered: number;
    failuresPending: number;
    backlogPossible: boolean;
    cursorLagMs: number | null;
  }> {
    const recovered = await this.replayFailedSignups();
    const cursor = await this.db.antifraud.query<{
      occurred_at: Date;
      source_id: string;
    }>(
      "SELECT occurred_at, source_id FROM source_cursors WHERE stream = 'signups'",
    );
    const current = cursor.rows[0];
    if (!current) {
      return {
        processed: 0,
        recovered,
        failuresPending: await this.countFailedSignups(),
        backlogPossible: false,
        cursorLagMs: null,
      };
    }

    let processed = 0;
    let backlogPossible = false;
    let latestAt = current.occurred_at;
    let latestId = current.source_id;
    for (let batch = 0; batch < this.config.POLL_MAX_SIGNUP_BATCHES; batch += 1) {
      const signups = await fetchNewSignups(
        this.db.source,
        { occurredAt: latestAt, sourceId: latestId },
        this.config.POLL_SIGNUP_BATCH_SIZE,
      );
      if (signups.length === 0) break;

      // Bounded concurrency: a slow provider lookup on one signup must not
      // serialise the whole batch, but the fan-out stays small enough to keep
      // the source pool (max 8) and the provider rate limits intact.
      for (let index = 0; index < signups.length; index += SIGNUP_CONCURRENCY) {
        const chunk = signups.slice(index, index + SIGNUP_CONCURRENCY);
        const result = await processOrderedBatch(
          chunk,
          (signup) => this.prepareSignup(signup),
          (signup, prepared) => this.persistSignup(signup, prepared),
          (signup, error) => this.deadLetterSignup(signup, error),
        );
        processed += result.committed + result.deadLettered;
      }

      // Every committed/dead-lettered row moved the cursor in the SAME
      // transaction as its durable outcome, so this ordered batch tail is safe
      // as the next source boundary.
      const last = signups[signups.length - 1];
      if (last) {
        latestAt = last.created_at;
        latestId = last.id;
      }

      backlogPossible = signups.length === this.config.POLL_SIGNUP_BATCH_SIZE;
      if (!backlogPossible) break;
    }

    return {
      processed,
      recovered,
      failuresPending: await this.countFailedSignups(),
      backlogPossible,
      cursorLagMs: backlogPossible
        ? Math.max(0, Date.now() - latestAt.getTime())
        : 0,
    };
  }

  private async replayFailedSignups(): Promise<number> {
    const failures = await this.db.antifraud.query<{
      user_id: string;
      payload: unknown;
    }>(
      `
        SELECT user_id, payload
        FROM signup_ingestion_failures
        WHERE resolved_at IS NULL
          AND (
            failure_count < $1
            OR error_text LIKE 'Provider enrichment unavailable:%'
          )
          AND last_failed_at <= now() - ($2::text || ' seconds')::interval
        ORDER BY last_failed_at, user_id
        LIMIT $3
      `,
      [
        FAILED_SIGNUP_REPLAY_MAX_ATTEMPTS,
        FAILED_SIGNUP_REPLAY_DELAY_SECONDS,
        FAILED_SIGNUP_REPLAY_BATCH_SIZE,
      ],
    );

    let recovered = 0;
    for (const failure of failures.rows) {
      const signup = parseFailedSignup(failure.payload);
      if (!signup || signup.id !== failure.user_id) {
        await this.db.antifraud.query(
          `
            UPDATE signup_ingestion_failures
            SET failure_count = $2,
                error_text = 'Stored signup payload is invalid',
                last_failed_at = now()
            WHERE user_id = $1
          `,
          [failure.user_id, FAILED_SIGNUP_REPLAY_MAX_ATTEMPTS],
        );
        this.log.error(
          { userId: failure.user_id },
          "Antifraud signup dead letter has an invalid stored payload",
        );
        continue;
      }

      try {
        const prepared = await this.prepareSignup(signup);
        await this.persistSignup(signup, prepared);
        const deleted = await this.db.antifraud.query(
          "DELETE FROM signup_ingestion_failures WHERE user_id = $1",
          [signup.id],
        );
        if ((deleted.rowCount ?? 0) > 0) {
          recovered += 1;
          this.log.info(
            { userId: signup.id },
            "Antifraud signup recovered from the ingestion dead letter",
          );
        }
      } catch (error) {
        await this.deadLetterSignup(signup, error);
      }
    }
    return recovered;
  }

  private async countFailedSignups(): Promise<number> {
    const result = await this.db.antifraud.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM signup_ingestion_failures
        WHERE resolved_at IS NULL`,
    );
    return result.rows[0]?.count ?? 0;
  }

  private async upsertSubject(signup: Signup): Promise<void> {
    await this.db.antifraud.query(
      `
        INSERT INTO subjects (
          user_id, username, email, avatar_url, signup_ip, country, country_code,
          continent_code, state, city, affiliate_code, referred_by,
          source_created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (user_id) DO UPDATE SET
          username = EXCLUDED.username,
          email = EXCLUDED.email,
          avatar_url = EXCLUDED.avatar_url,
          signup_ip = EXCLUDED.signup_ip,
          country = EXCLUDED.country,
          country_code = EXCLUDED.country_code,
          continent_code = EXCLUDED.continent_code,
          state = EXCLUDED.state,
          city = EXCLUDED.city,
          affiliate_code = EXCLUDED.affiliate_code,
          referred_by = EXCLUDED.referred_by,
          updated_at = now()
      `,
      [
        signup.id,
        signup.username,
        signup.email,
        signup.image,
        signup.signup_ip,
        signup.country,
        signup.country_code,
        signup.continent_code,
        signup.state,
        signup.city,
        signup.affiliate_code,
        signup.referred_by,
        signup.created_at,
      ],
    );
    await persistSignupIdentitySnapshot(this.db.antifraud, signup);
  }

  private async prepareSignup(signup: Signup): Promise<PreparedSignup> {
    // Provider checks reference subjects, so establish the mirror row first.
    // The assessment/case/session/events/cursor transaction follows only after
    // enrichment is durably cached.
    await this.upsertSubject(signup);
    // Capture containment before external enrichment. Provider failures must
    // never delay a blacklisted signup's withdrawal lock.
    await this.fiatEmailDomains.captureSignup(signup);
    const [context, weights] = await Promise.all([
      signupContext(this.db.source, signup),
      this.scoreWeights.get(),
    ]);
    const [fingerprint, proxycheck, abstractIp, abstractEmail, opportify] = await Promise.all([
      this.cachedFingerprint(signup, weights),
      this.cachedProxycheck(signup, weights),
      this.cachedAbstractIp(signup, weights),
      this.cachedAbstractEmail(signup, weights),
      this.cachedOpportify(signup, weights),
    ]);
    await Promise.all([
      this.saveProviderCheck(signup.id, fingerprint, signup.created_at),
      this.saveProviderCheck(signup.id, proxycheck, signup.created_at),
      this.saveProviderCheck(signup.id, abstractIp, signup.created_at),
      this.saveProviderCheck(signup.id, abstractEmail, signup.created_at),
      this.saveProviderCheck(signup.id, opportify, signup.created_at),
    ]);
    const unavailable = [
      fingerprint,
      proxycheck,
      abstractIp,
      abstractEmail,
      opportify,
    ]
      .filter((result) => result.status === "failed")
      .map((result) => result.provider);
    if (unavailable.length > 0) {
      const signals = [
        ...baseSignupSignals(signup, context, weights),
        ...fingerprint.signals,
        ...proxycheck.signals,
        ...abstractIp.signals,
        ...abstractEmail.signals,
        ...opportify.signals,
      ];
      const catchallSignal = abstractEmail.signals.find(
        (signal) => signal.key === "abstract_email_catchall",
      );
      if (catchallSignal) {
        const score = Math.max(
          0,
          Math.min(
            100,
            signals.reduce((total, signal) => total + signal.points, 0),
          ),
        );
        await persistAbstractCatchallContainment(
          this.db.antifraud,
          {
            signup,
            catchallSignal,
            signals,
            score,
            durationSeconds: this.config.MONITOR_DURATION_SECONDS,
          },
          (client, containedSignup, containedSignals, containedScore, duration) =>
            this.openMonitor(
              client,
              containedSignup,
              containedSignals,
              containedScore,
              duration,
            ),
        );
      }
      await this.persistIncompleteSignupProfile(signup, signals, [
        fingerprint,
        proxycheck,
        abstractIp,
        abstractEmail,
        opportify,
      ]);
      throw new Error(
        `Provider enrichment unavailable: ${unavailable.join(",")}`,
      );
    }
    return {
      context,
      fingerprint,
      proxycheck,
      abstractIp,
      abstractEmail,
      opportify,
      weights,
    };
  }

  private providerCoverage(
    results: EnrichmentResult[],
  ): ProviderCoverage[] {
    return results.map((result) => ({
      provider: result.provider,
      outcome:
        result.status === "success"
          ? "success"
          : result.status === "failed"
            ? "failed"
            : "unknown",
      required: true,
      ...(result.status === "failed"
        ? { failureKind: "unknown" as const }
        : {}),
    }));
  }

  private async persistIncompleteSignupProfile(
    signup: Signup,
    signals: Signal[],
    providers: EnrichmentResult[],
  ): Promise<void> {
    const assessment = assessProfile({
      signals: normalizeSignupSignals(signals, signup.created_at),
      providers: this.providerCoverage(providers),
      assessedAt: signup.created_at,
      isCreator: signup.is_creator ?? false,
      oauthSignup:
        Boolean(signup.auth_provider)
        && !["credential", "credentials", "email"].includes(
          signup.auth_provider!.toLowerCase(),
        ),
      hasFingerprint: Boolean(
        signup.fingerprint_request_id && signup.visitor_id,
      ),
    });
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      await persistProfileAssessment(client, {
        userId: signup.id,
        sourceRef: `signup:${signup.created_at.toISOString()}`,
        assessment,
        assessedAt: signup.created_at,
      });
      await client.query(
        `
          INSERT INTO signup_assessments (
            user_id, score, severity, signals, assessed_at, raw_score,
            assessment_version, outcome, completeness, confidence,
            provider_status, policy_matches, explanation
          ) VALUES (
            $1,$2,$3,$4,now(),$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb
          )
          ON CONFLICT (user_id) DO UPDATE SET
            score=EXCLUDED.score,
            severity=EXCLUDED.severity,
            signals=EXCLUDED.signals,
            raw_score=EXCLUDED.raw_score,
            assessment_version=EXCLUDED.assessment_version,
            outcome=EXCLUDED.outcome,
            completeness=EXCLUDED.completeness,
            confidence=EXCLUDED.confidence,
            provider_status=EXCLUDED.provider_status,
            policy_matches=EXCLUDED.policy_matches,
            explanation=EXCLUDED.explanation,
            assessed_at=now()
        `,
        [
          signup.id,
          assessment.score,
          assessment.severity,
          JSON.stringify(assessment.signals),
          assessment.rawScore,
          assessment.version,
          assessment.outcome,
          assessment.completeness,
          assessment.confidence,
          JSON.stringify(assessment.providerStatus),
          JSON.stringify(assessment.policyMatches),
          JSON.stringify(assessment.explanation),
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

  private async persistSignup(
    signup: Signup,
    prepared: PreparedSignup,
  ): Promise<void> {
    const {
      context,
      fingerprint,
      proxycheck,
      abstractIp,
      abstractEmail,
      opportify,
      weights,
    } = prepared;
    const locationPolicy = await this.riskyLocations.forCountry(
      signup.country_code,
    );
    const signals = [
      ...baseSignupSignals(signup, context, weights),
      ...fingerprint.signals,
      ...proxycheck.signals,
      ...abstractIp.signals,
      ...abstractEmail.signals,
      ...opportify.signals,
      ...(locationPolicy
        ? [
            {
              key: "risky_location_monitor",
              title: "Risky signup location",
              detail: `${locationPolicy.countryCode} signups are monitored for ${locationPolicy.monitorDurationSeconds / 60} minutes`,
              points: weights.risky_location,
            },
          ]
        : []),
    ];
    const assessment = assessProfile({
      signals: normalizeSignupSignals(signals, signup.created_at),
      providers: this.providerCoverage([
        fingerprint,
        proxycheck,
        abstractIp,
        abstractEmail,
        opportify,
      ]),
      assessedAt: signup.created_at,
      isCreator: signup.is_creator ?? false,
      oauthSignup:
        Boolean(signup.auth_provider)
        && !["credential", "credentials", "email"].includes(
          signup.auth_provider!.toLowerCase(),
        ),
      hasFingerprint: Boolean(signup.fingerprint_request_id && signup.visitor_id),
    });
    const score = assessment.score;
    const scoredSignals = assessment.signals.map((signal) => ({
      ...signal,
      points: signal.effectivePoints,
    }));
    const catchallSignal = abstractEmail.signals.find(
      (signal) => signal.key === "abstract_email_catchall",
    );

    const client = await this.db.antifraud.connect();
    let opened: {
      caseId: string;
      sessionId: string;
      durationSeconds: number;
    } | null = null;
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO signup_assessments (
            user_id, score, severity, signals, assessed_at, raw_score,
            assessment_version, outcome, completeness, confidence,
            provider_status, policy_matches, explanation
          ) VALUES (
            $1,$2,$3,$4,now(),$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb
          )
          ON CONFLICT (user_id) DO UPDATE SET
            score = EXCLUDED.score,
            severity = EXCLUDED.severity,
            signals = EXCLUDED.signals,
            raw_score = EXCLUDED.raw_score,
            assessment_version = EXCLUDED.assessment_version,
            outcome = EXCLUDED.outcome,
            completeness = EXCLUDED.completeness,
            confidence = EXCLUDED.confidence,
            provider_status = EXCLUDED.provider_status,
            policy_matches = EXCLUDED.policy_matches,
            explanation = EXCLUDED.explanation,
            assessed_at = now()
        `,
        [
          signup.id,
          score,
          assessment.severity,
          JSON.stringify(assessment.signals),
          assessment.rawScore,
          assessment.version,
          assessment.outcome,
          assessment.completeness,
          assessment.confidence,
          JSON.stringify(assessment.providerStatus),
          JSON.stringify(assessment.policyMatches),
          JSON.stringify(assessment.explanation),
        ],
      );
      await persistProfileAssessment(client, {
        userId: signup.id,
        sourceRef: `signup:${signup.created_at.toISOString()}`,
        assessment,
        assessedAt: signup.created_at,
      });
      if (
        assessment.monitorDurationSeconds > 0 ||
        score >= HIGH_RISK_SIGNUP_SCORE
      ) {
        const durationSeconds =
          Math.max(
            locationPolicy?.monitorDurationSeconds ?? 0,
            assessment.monitorDurationSeconds,
          );
        opened = {
          ...(await this.openMonitor(
            client,
            signup,
            scoredSignals,
            score,
            durationSeconds,
          )),
          durationSeconds,
        };
      }
      if (assessment.recommendedActions.includes("notify_standard")
        || assessment.recommendedActions.includes("notify_priority")) {
        if (!opened) throw new Error("High-risk signup did not open a case");
        const marker = highRiskSignupMarker({
          userId: signup.id,
          caseId: opened.caseId,
          score,
          signals: scoredSignals,
        });
        await client.query(
          `
            INSERT INTO signup_alert_outbox (
              user_id, case_id, username, score, signals, occurred_at
            ) VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (user_id) DO UPDATE SET
              case_id = EXCLUDED.case_id,
              username = EXCLUDED.username,
              score = GREATEST(signup_alert_outbox.score, EXCLUDED.score),
              signals = EXCLUDED.signals,
              occurred_at = EXCLUDED.occurred_at,
              updated_at = now()
          `,
          [
            signup.id,
            opened.caseId,
            signup.username,
            score,
            JSON.stringify(scoredSignals),
            signup.created_at,
          ],
        );
        await client.query(
          `
            INSERT INTO risk_events (
              case_id, session_id, user_id, event_type, source, source_ref,
              score_delta, score_after, title, detail, payload, occurred_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10::jsonb,$11
            )
            ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL
            DO NOTHING
          `,
          [
            opened.caseId,
            opened.sessionId,
            signup.id,
            marker.eventType,
            marker.source,
            marker.sourceRef,
            score,
            marker.title,
            marker.detail,
            JSON.stringify(marker.payload),
            signup.created_at,
          ],
        );
      }
      if (assessment.recommendedActions.length > 0 && opened) {
        await client.query(
          `
            INSERT INTO risk_events (
              case_id, session_id, user_id, event_type, source, source_ref,
              score_delta, score_after, title, detail, payload, occurred_at
            ) VALUES (
              $1,$2,$3,'signup_policy_recommendation','signup_policy',$4,
              0,$5,'Signup policy recommendation',
              'The versioned signup policy produced auditable recommended actions.',
              $6::jsonb,$7
            )
            ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL
            DO NOTHING
          `,
          [
            opened.caseId,
            opened.sessionId,
            signup.id,
            `${signup.id}:${assessment.version}`,
            score,
            JSON.stringify({
              assessmentVersion: assessment.version,
              actions: assessment.recommendedActions,
              policyMatches: assessment.policyMatches,
              automaticKyc: false,
              automaticBan:
                assessment.recommendedActions.includes("ban"),
            }),
            signup.created_at,
          ],
        );
      }
      if (catchallSignal) {
        if (!opened) {
          throw new Error("Catch-all signup did not open a case");
        }
        const emailDomain =
          signup.email?.trim().toLowerCase().split("@").at(-1) ?? null;
        await client.query(
          `
            INSERT INTO risk_events (
              case_id, session_id, user_id, event_type, source, source_ref,
              score_delta, score_after, title, detail, payload, occurred_at
            ) VALUES (
              $1,$2,$3,'abstract_email_catchall','abstract_email',$4,
              0,$5,$6,$7,$8::jsonb,$9
            )
            ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL
            DO NOTHING
          `,
          [
            opened.caseId,
            opened.sessionId,
            signup.id,
            `${signup.id}:abstract_email_catchall`,
            score,
            catchallSignal.title,
            catchallSignal.detail,
            JSON.stringify({
              containmentRequired: true,
              emailDomain,
              provider: "abstract_email",
              evidence: catchallSignal.payload ?? {},
            }),
            signup.created_at,
          ],
        );
      }
      await this.advanceSignupCursor(client, signup);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    // Broadcast only after the cursor and all authoritative rows commit. A
    // crash cannot cause the same signup to be re-read and re-broadcast.
    await this.broadcast("signup.assessed", {
      userId: signup.id,
      username: signup.username,
      score,
      severity: severity(score),
      signals: assessment.signals,
    });
    if (this.onSignupAssessed) {
      try {
        await this.onSignupAssessed(signup.id);
      } catch (error) {
        this.log.warn(
          { err: this.safeError(error), userId: signup.id },
          "Signup committed but its account-network scan could not be queued",
        );
      }
    }

    if (!opened) return;
    await this.broadcast("monitor.started", {
      caseId: opened.caseId,
      sessionId: opened.sessionId,
      userId: signup.id,
      username: signup.username,
      score,
      severity: severity(score),
      durationSeconds: opened.durationSeconds,
      signals: assessment.signals,
    });
    await this.evaluateRules({
      id: opened.sessionId,
      case_id: opened.caseId,
      user_id: signup.id,
      current_score: score,
    });
  }

  private async deliverPendingSignupAlerts(): Promise<void> {
    type PendingAlert = {
      user_id: string;
      case_id: string | null;
      username: string | null;
      score: number;
      signals: unknown;
      occurred_at: Date;
      discord_delivered_at: Date | null;
      attempt_count: number;
    };

    const pending = await this.db.antifraud.query<PendingAlert>(
      `
        SELECT
          user_id, case_id, username, score, signals, occurred_at,
          discord_delivered_at, attempt_count
        FROM signup_alert_outbox
        WHERE next_attempt_at <= now()
          AND discord_delivered_at IS NULL
        ORDER BY created_at
        LIMIT 25
      `,
    );

    await drainOutbox<PendingAlert>({
      fetchPending: async () => pending.rows,
      attemptCount: (alert) => alert.attempt_count,
      attempt: async (alert) => ({
        delivered: await this.discord.send(
          "antifraud.signup_high_risk",
          `signup:${alert.case_id ?? alert.user_id}:${alert.occurred_at.toISOString()}`,
          {
            title: "High-risk signup detected",
            description:
              "This account crossed the automated signup review threshold and needs a staff decision.",
            userId: alert.user_id,
            username: alert.username,
            caseId: alert.case_id ?? undefined,
            score: alert.score,
            severity: severity(alert.score),
            trigger: "Signup score reached 60+",
            signals: storedSignals(alert.signals),
            occurredAt: alert.occurred_at,
          },
        ),
      }),
      record: async (alert, outcome) => {
        await this.db.antifraud.query(
        `
          UPDATE signup_alert_outbox
          SET
            discord_delivered_at = CASE
              WHEN $2::boolean THEN COALESCE(discord_delivered_at, now())
              ELSE discord_delivered_at
            END,
            attempt_count = $3,
            next_attempt_at = CASE
              WHEN $2::boolean THEN now()
              ELSE now() + ($4::text || ' seconds')::interval
            END,
            last_error = CASE
              WHEN $2::boolean THEN NULL
              ELSE 'Discord delivery failed'
            END,
            updated_at = now()
          WHERE user_id = $1
        `,
        [
          alert.user_id,
          outcome.delivered,
          outcome.attempt,
          outcome.retrySeconds,
        ],
        );
      },
      onRecorded: (alert, outcome) => {
        if (!outcome.delivered) {
          this.log.warn(
          {
            userId: alert.user_id,
            caseId: alert.case_id,
              retrySeconds: outcome.retrySeconds,
          },
          "High-risk signup alert remains pending",
          );
        }
      },
    });
  }

  private async deliverPendingRuleAlerts(): Promise<void> {
    const pending = await this.db.antifraud.query<{
      rule_match_id: string;
      payload: DiscordAlert;
      attempt_count: number;
    }>(
      `
        SELECT rule_match_id, payload, attempt_count
        FROM rule_alert_outbox
        WHERE delivered_at IS NULL
          AND next_attempt_at <= now()
        ORDER BY created_at
        LIMIT 8
      `,
    );

    // Discord has a five-second request timeout. Run this small bounded batch
    // concurrently so an outage cannot consume the poller's liveness budget.
    await drainOutbox({
      fetchPending: async () => pending.rows,
      attemptCount: (alert) => alert.attempt_count,
      attempt: async (alert) => ({
        delivered: await this.discord.send(
        "antifraud.rule_matched",
        `rule:${alert.rule_match_id}`,
        alert.payload,
        ),
      }),
      record: async (alert, outcome) => {
        await this.db.antifraud.query(
        `
          UPDATE rule_alert_outbox
          SET delivered_at = CASE WHEN $2::boolean THEN now() ELSE delivered_at END,
              attempt_count = $3,
              next_attempt_at = CASE
                WHEN $2::boolean THEN now()
                ELSE now() + ($4::text || ' seconds')::interval
              END,
              last_error = CASE WHEN $2::boolean THEN NULL ELSE 'Discord delivery failed' END,
              updated_at = now()
          WHERE rule_match_id = $1
            AND delivered_at IS NULL
        `,
          [
            alert.rule_match_id,
            outcome.delivered,
            outcome.attempt,
            outcome.retrySeconds,
          ],
        );
      },
      onRecorded: (alert, outcome) => {
        if (!outcome.delivered) {
          this.log.warn(
            {
              ruleMatchId: alert.rule_match_id,
              retrySeconds: outcome.retrySeconds,
            },
          "Rule alert delivery deferred",
          );
        }
      },
      concurrent: true,
    });
  }

  private async scanFiatWithdrawalHolds(): Promise<void> {
    const cursor = await this.db.antifraud.query<{
      occurred_at: Date;
      source_id: string;
    }>(
      "SELECT occurred_at, source_id FROM source_cursors WHERE stream = $1",
      [FIAT_WITHDRAWAL_HOLD_STREAM],
    );
    const current = cursor.rows[0];
    if (!current) {
      throw new Error("Fiat withdrawal hold cursor is missing");
    }

    let latestAt = current.occurred_at;
    let latestId = current.source_id;
    for (
      let batch = 0;
      batch < this.config.POLL_MAX_SIGNUP_BATCHES;
      batch += 1
    ) {
      const holds = await fetchFiatWithdrawalHolds(
        this.db.source,
        { occurredAt: latestAt, sourceId: latestId },
        this.config.POLL_SIGNUP_BATCH_SIZE,
      );
      if (holds.length === 0) break;

      for (const hold of holds) {
        await this.persistFiatWithdrawalHold(hold);
      }

      const last = holds.at(-1);
      if (!last) break;
      latestAt = last.locked_at;
      latestId = last.user_id;
      if (holds.length < this.config.POLL_SIGNUP_BATCH_SIZE) break;
    }
  }

  private async persistFiatWithdrawalHold(
    hold: FiatWithdrawalHold,
  ): Promise<void> {
    const marker = fiatWithdrawalHoldMarker(hold);
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO subjects (
            user_id, username, source_created_at
          ) VALUES ($1,$2,$3)
          ON CONFLICT (user_id) DO UPDATE SET
            username = COALESCE(EXCLUDED.username, subjects.username),
            updated_at = now()
        `,
        [hold.user_id, hold.username, hold.source_created_at],
      );
      await client.query(
        `
          INSERT INTO fiat_withdrawal_hold_alert_outbox (
            source_ref, user_id, username, reason, occurred_at
          ) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (source_ref) DO NOTHING
        `,
        [
          marker.sourceRef,
          hold.user_id,
          hold.username,
          hold.reason,
          hold.locked_at,
        ],
      );
      await client.query(
        `
          INSERT INTO risk_events (
            user_id, event_type, source, source_ref, score_delta, score_after,
            title, detail, payload, occurred_at
          ) VALUES ($1,$2,$3,$4,0,$5,$6,$7,$8::jsonb,$9)
          ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL
          DO NOTHING
        `,
        [
          hold.user_id,
          marker.eventType,
          marker.source,
          marker.sourceRef,
          marker.score,
          marker.title,
          marker.detail,
          JSON.stringify(marker.payload),
          hold.locked_at,
        ],
      );
      await client.query(
        `
          UPDATE source_cursors
          SET occurred_at = $2, source_id = $3, updated_at = now()
          WHERE stream = $1
            AND (occurred_at, source_id) < ($2, $3)
        `,
        [FIAT_WITHDRAWAL_HOLD_STREAM, hold.locked_at, hold.user_id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async deliverPendingFiatWithdrawalHoldAlerts(): Promise<void> {
    type PendingAlert = {
      source_ref: string;
      user_id: string;
      username: string | null;
      reason: string;
      occurred_at: Date;
      attempt_count: number;
    };

    const pending = await this.db.antifraud.query<PendingAlert>(
      `
        SELECT
          source_ref, user_id, username, reason, occurred_at, attempt_count
        FROM fiat_withdrawal_hold_alert_outbox
        WHERE next_attempt_at <= now()
          AND discord_delivered_at IS NULL
        ORDER BY created_at
        LIMIT 25
      `,
    );

    await drainOutbox<PendingAlert>({
      fetchPending: async () => pending.rows,
      attemptCount: (alert) => alert.attempt_count,
      attempt: async (alert) => ({
        delivered: await this.discord.sendWithdrawalHold(
        `withdrawal-hold:${alert.source_ref}`,
        {
          title: "Automatic fiat withdrawal hold",
          description:
            "Lifetime fiat deposits crossed the automatic review threshold. Crypto withdrawals and item shipping are locked, and the account is queued for Account Review.",
          userId: alert.user_id,
          username: alert.username,
          score: FIAT_WITHDRAWAL_HOLD_SCORE,
          severity: "high",
          trigger: alert.reason,
          outcome: "withdrawals_locked",
          occurredAt: alert.occurred_at,
          url: new URL(
            "/antifraud/reviews",
            this.config.ANTIFRAUD_DASHBOARD_URL,
          ).toString(),
        },
        ),
      }),
      record: async (alert, outcome) => {
        await this.db.antifraud.query(
        `
          UPDATE fiat_withdrawal_hold_alert_outbox
          SET
            discord_delivered_at = CASE
              WHEN $2::boolean THEN COALESCE(discord_delivered_at, now())
              ELSE discord_delivered_at
            END,
            attempt_count = $3,
            next_attempt_at = CASE
              WHEN $2::boolean THEN now()
              ELSE now() + ($4::text || ' seconds')::interval
            END,
            last_error = CASE
              WHEN $2::boolean THEN NULL
              ELSE 'Discord delivery failed'
            END,
            updated_at = now()
          WHERE source_ref = $1
        `,
          [
            alert.source_ref,
            outcome.delivered,
            outcome.attempt,
            outcome.retrySeconds,
          ],
        );
      },
      onRecorded: (alert, outcome) => {
        if (!outcome.delivered) {
          this.log.warn(
          {
            userId: alert.user_id,
              retrySeconds: outcome.retrySeconds,
          },
          "Fiat withdrawal hold alert remains pending",
          );
        }
      },
    });
  }

  private async cachedFingerprint(
    signup: Signup,
    weights: ScoreWeights,
  ): Promise<EnrichmentResult> {
    if (!signup.fingerprint_request_id) {
      return this.enrichment.fingerprintCheck(signup, weights);
    }
    const cached = await this.db.antifraud.query<{
      score: string | null;
      signals: unknown;
      response: Record<string, unknown> | null;
    }>(
      `
        SELECT score, signals, response
        FROM provider_checks
        WHERE user_id = $1
          AND provider = 'fingerprint'
          AND lookup_key = $2
          AND status = 'success'
        LIMIT 1
      `,
      [signup.id, signup.fingerprint_request_id],
    );
    if (!cached.rows[0]) {
      return this.enrichment.fingerprintCheck(signup, weights);
    }
    const response = cached.rows[0].response ?? {};
    const parsed = Object.hasOwn(response, "products")
      ? parseFingerprintResponse(response, signup, weights)
      : null;
    return {
      provider: "fingerprint",
      status: "success",
      lookupKey: signup.fingerprint_request_id,
      requestId: signup.fingerprint_request_id,
      score: parsed?.score ?? Number(cached.rows[0].score ?? 0),
      response,
      signals:
        parsed?.signals
        ?? reweightFingerprintSignals(
          storedSignals(cached.rows[0].signals),
          weights,
        ),
    };
  }

  private async advanceSignupCursor(
    client: pg.PoolClient,
    signup: Signup,
  ): Promise<void> {
    await client.query(
      `
        UPDATE source_cursors
        SET occurred_at = $1, source_id = $2, updated_at = now()
        WHERE stream = 'signups'
          AND (occurred_at, source_id) < ($1, $2)
      `,
      [signup.created_at, signup.id],
    );
  }

  private async deadLetterSignup(
    signup: Signup,
    error: unknown,
  ): Promise<void> {
    const safe = this.safeError(error);
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO signup_ingestion_failures(
            user_id, source_created_at, payload, error_text
          ) VALUES ($1,$2,$3,$4)
          ON CONFLICT (user_id) DO UPDATE SET
            source_created_at = EXCLUDED.source_created_at,
            payload = EXCLUDED.payload,
            error_text = EXCLUDED.error_text,
            failure_count = signup_ingestion_failures.failure_count + 1,
            last_failed_at = now(),
            resolved_at = NULL,
            resolved_by = NULL,
            resolution_note = NULL
        `,
        [
          signup.id,
          signup.created_at,
          JSON.stringify(signup),
          safe.message.slice(0, 1_000),
        ],
      );
      await this.advanceSignupCursor(client, signup);
      await client.query("COMMIT");
    } catch (deadLetterError) {
      await client.query("ROLLBACK");
      throw deadLetterError;
    } finally {
      client.release();
    }
    this.log.error(
      { err: safe, userId: signup.id },
      "Antifraud signup moved to the ingestion dead letter",
    );
  }

  private async cachedProxycheck(
    signup: Signup,
    weights: ScoreWeights,
  ): Promise<EnrichmentResult> {
    if (!signup.signup_ip) {
      return this.enrichment.proxycheck(signup, weights);
    }
    const cached = await this.db.antifraud.query<{
      score: string | null;
      signals: unknown;
      response: Record<string, unknown> | null;
    }>(
      `
        SELECT score, signals, response
        FROM provider_checks
        WHERE provider = 'proxycheck'
          AND lookup_key = $1
          AND status = 'success'
          AND expires_at > now()
        ORDER BY expires_at DESC
        LIMIT 1
      `,
      [signup.signup_ip],
    );
    if (!cached.rows[0]) return this.enrichment.proxycheck(signup, weights);
    const response = cached.rows[0].response ?? {};
    const parsed = parseProxycheckResponse(
      response,
      signup.signup_ip,
      weights,
    );
    return {
      provider: "proxycheck",
      status: "success",
      lookupKey: signup.signup_ip,
      score: parsed.risk,
      response,
      signals: parsed.signals,
    };
  }

  private async cachedAbstractIp(
    signup: Signup,
    weights: ScoreWeights,
  ): Promise<EnrichmentResult> {
    if (!signup.signup_ip) {
      return this.enrichment.abstractIpCheck(signup, weights);
    }
    const cached = await this.db.antifraud.query<{
      response: Record<string, unknown> | null;
    }>(
      `
        SELECT response
        FROM provider_checks
        WHERE provider = 'abstract_ip'
          AND lookup_key = $1
          AND status = 'success'
          AND expires_at > now()
        ORDER BY expires_at DESC
        LIMIT 1
      `,
      [signup.signup_ip],
    );
    if (!cached.rows[0]) {
      return this.enrichment.abstractIpCheck(signup, weights);
    }
    const response = cached.rows[0].response ?? {};
    const parsed = parseAbstractIpResponse(response, signup, weights);
    return {
      provider: "abstract_ip",
      status: "success",
      lookupKey: signup.signup_ip,
      score: parsed.score,
      response,
      signals: parsed.signals,
    };
  }

  private async cachedAbstractEmail(
    signup: Signup,
    weights: ScoreWeights,
  ): Promise<EnrichmentResult> {
    const email = signup.email?.trim().toLowerCase();
    if (!email) {
      return this.enrichment.abstractEmailCheck(signup, weights);
    }
    const cached = await this.db.antifraud.query<{
      response: Record<string, unknown> | null;
    }>(
      `
        SELECT response
        FROM provider_checks
        WHERE provider = 'abstract_email'
          AND lookup_key = $1
          AND status = 'success'
          AND expires_at > now()
        ORDER BY expires_at DESC
        LIMIT 1
      `,
      [email],
    );
    if (!cached.rows[0]) {
      return this.enrichment.abstractEmailCheck(signup, weights);
    }
    const response = cached.rows[0].response ?? {};
    const parsed = parseAbstractEmailResponse(response, weights);
    return {
      provider: "abstract_email",
      status: "success",
      lookupKey: email,
      score: parsed.score,
      response,
      signals: parsed.signals,
    };
  }

  private async cachedOpportify(
    signup: Signup,
    weights: ScoreWeights,
  ): Promise<EnrichmentResult> {
    const cached = await this.db.antifraud.query<{
      response: Record<string, unknown> | null;
    }>(
      `
        SELECT response
        FROM provider_checks
        WHERE user_id = $1
          AND provider = 'opportify'
          AND status = 'success'
        ORDER BY checked_at DESC
        LIMIT 1
      `,
      [signup.id],
    );
    if (!cached.rows[0]) {
      return this.enrichment.opportifyCheck(signup, weights);
    }
    try {
      const parsed = parseOpportifyResponse(
        cached.rows[0].response ?? {},
        weights,
      );
      return {
        provider: "opportify",
        status: "success",
        lookupKey: `user:${signup.id}`,
        score: parsed.score,
        response: parsed.response,
        signals: parsed.signals,
      };
    } catch {
      return this.enrichment.opportifyCheck(signup, weights);
    }
  }

  private async saveProviderCheck(
    userId: string,
    result: EnrichmentResult,
    assessmentOccurredAt: Date,
  ): Promise<void> {
    await this.db.antifraud.query(
      `
        INSERT INTO provider_checks (
          user_id, provider, lookup_key, request_id, status, score,
          signals, response, error_code, expires_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
          CASE
            WHEN $2 IN ('proxycheck', 'abstract_ip', 'abstract_email')
              THEN now() + interval '24 hours'
            ELSE NULL
          END)
        ON CONFLICT (user_id, provider, lookup_key) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          request_id = EXCLUDED.request_id,
          status = EXCLUDED.status,
          score = EXCLUDED.score,
          signals = EXCLUDED.signals,
          response = EXCLUDED.response,
          error_code = EXCLUDED.error_code,
          checked_at = now(),
          expires_at = EXCLUDED.expires_at
      `,
      [
        userId,
        result.provider,
        result.lookupKey,
        result.requestId ?? null,
        result.status,
        result.score ?? null,
        JSON.stringify(result.signals),
        result.response ? JSON.stringify(result.response) : null,
        result.errorCode ?? null,
      ],
    );
    await persistProviderEvidence(
      this.db.antifraud,
      userId,
      result,
      `signup:${assessmentOccurredAt.toISOString()}`,
    );
  }

  private async openMonitor(
    client: pg.PoolClient,
    signup: Signup,
    signals: Signal[],
    score: number,
    durationSeconds: number,
  ): Promise<{ caseId: string; sessionId: string }> {
    const caseResult = await client.query<{ id: string }>(
        `
          INSERT INTO cases(
            user_id, subject_type, status, severity, score, peak_score, summary
          )
          VALUES ($1, 'account', 'monitoring', $2, $3, $3, $4)
          ON CONFLICT (user_id) WHERE subject_type = 'account'
            AND status IN ('open','monitoring','in_review','escalated')
          DO UPDATE SET
            score = GREATEST(cases.score, EXCLUDED.score),
            peak_score = GREATEST(cases.peak_score, EXCLUDED.peak_score),
            severity = EXCLUDED.severity,
            updated_at = now()
          RETURNING id
        `,
        [
          signup.id,
          severity(score),
          score,
          signals.map((signal) => signal.title).slice(0, 3).join(", "),
        ],
    );
    const caseId = caseResult.rows[0]?.id;
    if (!caseId) throw new Error("Failed to open case");

    const sessionResult = await client.query<{ id: string }>(
        `
          INSERT INTO monitor_sessions (
            case_id, user_id, started_at, ends_at,
            initial_score, current_score, peak_score
          ) VALUES (
            $1, $2, $5::timestamptz,
            $5::timestamptz + ($3::text || ' seconds')::interval,
            $4, $4, $4
          )
          ON CONFLICT (user_id) WHERE status = 'active'
          DO UPDATE SET
            current_score = GREATEST(monitor_sessions.current_score, EXCLUDED.current_score),
            peak_score = GREATEST(monitor_sessions.peak_score, EXCLUDED.peak_score)
          RETURNING id
        `,
        [
          caseId,
          signup.id,
          durationSeconds,
          score,
          signup.created_at,
        ],
    );
    const sessionId = sessionResult.rows[0]?.id;
    if (!sessionId) throw new Error("Failed to open monitor session");

    await client.query(
      `
        INSERT INTO risk_events (
          case_id, session_id, user_id, event_type, source, source_ref,
          score_delta, score_after, title, detail, payload, occurred_at
        ) VALUES (
          $1,$2,$3,'account_signed_up','signup',$4,0,0,
          'Account signed up','The account entered live signup monitoring.',
          '{}'::jsonb,($5::timestamptz - interval '1 millisecond')
        )
        ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL
        DO NOTHING
      `,
      [caseId, sessionId, signup.id, `${signup.id}:account_signed_up`, signup.created_at],
    );

    let runningScore = 0;
    for (const signal of signals) {
      runningScore += signal.points;
      await client.query(
          `
            INSERT INTO risk_events (
              case_id, session_id, user_id, event_type, source, source_ref,
              score_delta, score_after, title, detail, payload, occurred_at
            ) VALUES ($1,$2,$3,$4,'signup',$11,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL
            DO NOTHING
          `,
          [
            caseId,
            sessionId,
            signup.id,
            signal.key,
            signal.points,
            runningScore,
            signal.title,
            signal.detail,
            signal.payload ?? {},
            signup.created_at,
            // Deterministic ref so the partial dedupe index covers signup
            // events too: a replayed batch or a second replica cannot double
            // count them.
            `${signup.id}:${signal.key}`,
          ],
      );
    }
    return { caseId, sessionId };
  }

  private async activeSessions(): Promise<ActiveSession[]> {
    const result = await this.db.antifraud.query<ActiveSession>(
      `
        SELECT
          ms.id, ms.case_id, ms.user_id, ms.current_score, ms.started_at, ms.ends_at,
          COALESCE(mac.occurred_at, ms.started_at - interval '2 seconds') AS activity_cursor_at,
          COALESCE(mac.source, '') AS activity_cursor_source,
          COALESCE(mac.source_ref, '') AS activity_cursor_ref
        FROM monitor_sessions ms
        LEFT JOIN monitor_activity_cursors mac ON mac.session_id = ms.id
        WHERE ms.status = 'active'
      `,
    );
    return result.rows;
  }

  private async scanActiveSessions(): Promise<number> {
    const [sessions, weights] = await Promise.all([
      this.activeSessions(),
      this.scoreWeights.get(),
    ]);
    const activities = await fetchActivity(
      this.db.source,
      sessions,
      this.config.POLL_ACTIVITY_BATCH_SIZE,
      this.config.POLL_ACTIVITY_OVERLAP_MS,
    );
    const byUser = new Map<string, SourceActivity[]>();
    for (const activity of activities) {
      const batch = byUser.get(activity.user_id) ?? [];
      batch.push(activity);
      byUser.set(activity.user_id, batch);
    }
    let processed = 0;
    for (const session of sessions) {
      const batch = byUser.get(session.user_id);
      if (!batch || batch.length === 0) continue;
      batch.sort(
        (left, right) =>
          left.occurred_at.getTime() - right.occurred_at.getTime() ||
          left.source.localeCompare(right.source) ||
          left.source_ref.localeCompare(right.source_ref),
      );
      try {
        processed += await this.recordActivityBatch(session, batch, weights);
      } catch (error) {
        // A poison row rolls back only this user's batch and cannot be skipped
        // by a later cursor update. Other sessions continue independently.
        this.log.error(
          {
            err: this.safeError(error),
            userId: session.user_id,
            sessionId: session.id,
          },
          "Antifraud monitor rolled back an activity batch",
        );
      }
    }
    return processed;
  }

  private pointsFor(
    activity: SourceActivity,
    weights: ScoreWeights,
  ): number {
    return adjustFiatRiskForPaymentMethod(
      activity.event_type,
      activity.payload,
      activityScoreFor(activity.event_type, weights),
    );
  }

  private async recordActivityBatch(
    session: ActiveSession,
    activities: SourceActivity[],
    weights: ScoreWeights,
  ): Promise<number> {
    const broadcasts: Array<{
      activity: SourceActivity;
      delta: number;
      scoreAfter: number;
    }> = [];
    let runningScore = session.current_score;
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      for (const activity of activities) {
        const delta = this.pointsFor(activity, weights);
        const inserted = await client.query<{ id: string; score_after: number }>(
          `
            INSERT INTO risk_events (
              case_id, session_id, user_id, event_type, source, source_ref,
              score_delta, score_after, title, detail, payload, occurred_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7::int,
              GREATEST(0, $8::int + $7::int),$9,$10,$11,$12
            )
            ON CONFLICT (source, source_ref)
              WHERE source_ref IS NOT NULL DO NOTHING
            RETURNING id, score_after
          `,
          [
            session.case_id,
            session.id,
            session.user_id,
            activity.event_type,
            activity.source,
            activity.source_ref,
            delta,
            runningScore,
            activity.title,
            activity.detail,
            activity.payload,
            activity.occurred_at,
          ],
        );
        await this.advanceActivityCursor(client, session.id, activity);
        const row = inserted.rows[0];
        if (!row) continue;
        runningScore = row.score_after;
        broadcasts.push({ activity, delta, scoreAfter: row.score_after });
      }

      if (broadcasts.length > 0) {
        await client.query(
          `
            UPDATE monitor_sessions
            SET current_score = $2,
                peak_score = GREATEST(peak_score, $2),
                event_count = event_count + $3
            WHERE id = $1
          `,
          [session.id, runningScore, broadcasts.length],
        );
        await client.query(
          `
            UPDATE cases
            SET score = $2,
                peak_score = GREATEST(peak_score, $2),
                severity = $3,
                updated_at = now()
            WHERE id = $1
          `,
          [session.case_id, runningScore, severity(runningScore)],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    // Broadcast and rule evaluation run AFTER the transaction is committed and
    // the client is back in the pool — a Redis outage must not roll back or
    // block committed ingestion, and must not prevent rules from firing.
    session.current_score = runningScore;
    for (const event of broadcasts) {
      await this.broadcast("monitor.event", {
        caseId: session.case_id,
        sessionId: session.id,
        userId: session.user_id,
        eventType: event.activity.event_type,
        title: event.activity.title,
        detail: event.activity.detail,
        scoreDelta: event.delta,
        score: event.scoreAfter,
        occurredAt: event.activity.occurred_at,
      });
    }
    if (broadcasts.length > 0) await this.evaluateRules(session);
    return broadcasts.length;
  }

  private async advanceActivityCursor(
    client: pg.PoolClient,
    sessionId: string,
    activity: SourceActivity,
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO monitor_activity_cursors(
          session_id, occurred_at, source, source_ref, updated_at
        ) VALUES ($1,$2,$3,$4,now())
        ON CONFLICT (session_id) DO UPDATE SET
          occurred_at = EXCLUDED.occurred_at,
          source = EXCLUDED.source,
          source_ref = EXCLUDED.source_ref,
          updated_at = now()
        WHERE (
          monitor_activity_cursors.occurred_at,
          monitor_activity_cursors.source,
          monitor_activity_cursors.source_ref
        ) < (EXCLUDED.occurred_at, EXCLUDED.source, EXCLUDED.source_ref)
      `,
      [sessionId, activity.occurred_at, activity.source, activity.source_ref],
    );
  }

  /**
   * `rule_definitions` changes rarely but `evaluateRules` runs per accepted
   * event, so the definition list is cached for a short TTL instead of being
   * re-read on every single risk event.
   */
  private async sequenceRules(): Promise<SequenceRule[]> {
    const now = Date.now();
    const cached = this.rulesCache;
    if (cached && now - cached.at < RULES_CACHE_TTL_MS) return cached.rules;

    const result = await this.db.antifraud.query<SequenceRule>(
      `
        SELECT id, key, name, sequence, exclude_before, window_seconds,
               score_delta, 'manual_review'::text AS action_type
        FROM rule_definitions
        WHERE enabled = true AND trigger = 'sequence'
        ORDER BY priority, key
      `,
    );
    this.rulesCache = { at: now, rules: result.rows };
    return result.rows;
  }

  private async evaluateRules(session: RuleSession): Promise<void> {
    const rules = await this.sequenceRules();

    const events = await this.db.antifraud.query<{
      event_type: string;
      occurred_at: Date;
    }>(
      `
        SELECT event_type, occurred_at
        FROM risk_events
        WHERE session_id = $1
        ORDER BY occurred_at
      `,
      [session.id],
    );

    for (const rule of rules) {
      if (!sequenceMatches(
        events.rows,
        rule.sequence,
        rule.window_seconds,
        rule.exclude_before,
      )) {
        continue;
      }
      const nextScore = await persistRuleMatch(this.db.antifraud, {
        ruleId: rule.id,
        caseId: session.case_id,
        sessionId: session.id,
        scoreDelta: rule.score_delta,
        actionType: rule.action_type,
        evidence: {
          sequence: rule.sequence,
          excludeBefore: rule.exclude_before,
          windowSeconds: rule.window_seconds,
          scoreDelta: rule.score_delta,
          actionType: rule.action_type,
          ruleName: rule.name,
        },
        alert: {
          title: `Rule matched: ${rule.name}`,
          description:
            "A monitored account matched an antifraud rule and needs support review.",
          userId: session.user_id,
          caseId: session.case_id,
          scoreDelta: rule.score_delta,
          trigger: rule.key,
          outcome: rule.action_type,
        },
      });
      if (nextScore === null) continue;

      session.current_score = nextScore;
      await this.broadcast("rule.matched", {
        caseId: session.case_id,
        sessionId: session.id,
        userId: session.user_id,
        ruleKey: rule.key,
        ruleName: rule.name,
        scoreDelta: rule.score_delta,
        score: nextScore,
        actionType: rule.action_type,
      });
    }
  }

  private async completeExpiredSessions(): Promise<void> {
    type ExpiredSession = {
      id: string;
      case_id: string;
      user_id: string;
      current_score: number;
    };
    const client = await this.db.antifraud.connect();
    let sessions: ExpiredSession[] = [];
    try {
      await client.query("BEGIN");
      const expired = await client.query<ExpiredSession>(
        `
          UPDATE monitor_sessions
          SET status='completed', ended_at=now()
          WHERE status='active' AND ends_at <= now()
          RETURNING id, case_id, user_id, current_score
        `,
      );
      sessions = expired.rows;
      for (const session of sessions) {
        await client.query(
          `
            UPDATE cases
            SET status='open', score=$2, severity=$3, updated_at=now()
            WHERE id=$1 AND status='monitoring'
          `,
          [
            session.case_id,
            session.current_score,
            severity(session.current_score),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    for (const session of sessions) {
      await this.broadcast("monitor.completed", {
        caseId: session.case_id,
        sessionId: session.id,
        userId: session.user_id,
        score: session.current_score,
        severity: severity(session.current_score),
      });
    }
  }
}

export function sequenceMatches(
  events: Array<{ event_type: string; occurred_at: Date }>,
  sequence: string[],
  windowSeconds: number,
  excludeBefore: string[] = [],
): boolean {
  if (sequence.length === 0) return false;

  for (let start = 0; start < events.length; start += 1) {
    const first = events[start];
    if (!first) continue;
    if (excludeBefore.includes(first.event_type)) return false;
    if (first.event_type !== sequence[0]) continue;
    if (sequence.length === 1) return true;

    let sequenceIndex = 1;
    for (let index = start + 1; index < events.length; index += 1) {
      const event = events[index];
      if (!event) continue;
      if (excludeBefore.includes(event.event_type)) return false;
      if (
        event.occurred_at.getTime() - first.occurred_at.getTime()
        > windowSeconds * 1000
      ) {
        break;
      }
      if (event.event_type !== sequence[sequenceIndex]) continue;
      sequenceIndex += 1;
      if (sequenceIndex === sequence.length) return true;
    }
  }
  return false;
}
