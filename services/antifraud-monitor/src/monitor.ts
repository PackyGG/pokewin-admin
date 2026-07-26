import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import type { Config } from "./config.js";
import type { Databases } from "./db.js";
import { DiscordAlerts } from "./discord.js";
import { EnrichmentService, type EnrichmentResult } from "./enrichment.js";
import type { LiveBus } from "./live.js";
import { PollerHealth, type PollerHealthSnapshot } from "./poller-health.js";
import { baseSignupSignals, severity } from "./scoring.js";
import { activityScoreFor } from "./score-catalog.js";
import {
  fetchActivity,
  fetchNewSignups,
  signupContext,
  type SourceActivity,
} from "./source.js";
import type { ActiveSession, Signal, Signup } from "./types.js";

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

export class MonitorEngine {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly enrichment: EnrichmentService;
  private readonly discord: DiscordAlerts;
  private readonly health = new PollerHealth();

  constructor(
    private readonly config: Config,
    private readonly db: Databases,
    private readonly live: LiveBus,
    private readonly log: FastifyBaseLogger,
  ) {
    this.enrichment = new EnrichmentService(config);
    this.discord = new DiscordAlerts(config, log);
  }

  async start(): Promise<void> {
    await this.ensureCursor();
    await this.tick();
    this.timer = setInterval(
      () => void this.tick(),
      this.config.POLL_INTERVAL_MS,
    );
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  healthSnapshot(): PollerHealthSnapshot {
    return this.health.snapshot(this.config.POLL_STALE_AFTER_MS);
  }

  private async ensureCursor(): Promise<void> {
    await this.db.antifraud.query(
      `
        INSERT INTO source_cursors(stream, occurred_at, source_id)
        VALUES ('signups', now() - interval '2 minutes', '')
        ON CONFLICT (stream) DO NOTHING
      `,
    );
  }

  private async tick(): Promise<void> {
    if (this.running) {
      this.health.tickSkipped();
      return;
    }
    this.running = true;
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

      const signupMetrics = await this.scanSignups();
      const activitiesProcessed = await this.scanActiveSessions();
      await this.completeExpiredSessions();
      this.health.tickSucceeded({
        signupsProcessed: signupMetrics.processed,
        activitiesProcessed,
        signupBacklogPossible: signupMetrics.backlogPossible,
        signupCursorLagMs: signupMetrics.cursorLagMs,
      });
    } catch (error) {
      const details = error as {
        name?: unknown;
        message?: unknown;
        code?: unknown;
      };
      const rawMessage =
        typeof details.message === "string" ? details.message : "unknown error";
      const safeMessage = [
        this.config.FINGERPRINT_SECRET_API_KEY,
        this.config.PROXYCHECK_API_KEY,
        this.config.API_TOKEN,
        this.config.API_ADMIN_TOKEN,
      ].reduce(
        (message, secret) => message.replaceAll(secret, "[redacted]"),
        rawMessage,
      );
      this.health.tickFailed(safeMessage);
      this.log.error(
        { err: error },
        `Antifraud monitor tick failed: ${String(details.name ?? "Error")} ${String(details.code ?? "unknown")} ${safeMessage}`,
      );
    } finally {
      if (leader && lockClient) {
        await lockClient
          .query("SELECT pg_advisory_unlock($1)", [841_772_992])
          .catch((error) => this.log.error({ err: error }, "Failed to release poller leader lock"));
      }
      lockClient?.release();
      this.running = false;
    }
  }

  private async scanSignups(): Promise<{
    processed: number;
    backlogPossible: boolean;
    cursorLagMs: number | null;
  }> {
    const cursor = await this.db.antifraud.query<{
      occurred_at: Date;
      source_id: string;
    }>(
      "SELECT occurred_at, source_id FROM source_cursors WHERE stream = 'signups'",
    );
    const current = cursor.rows[0];
    if (!current) {
      return { processed: 0, backlogPossible: false, cursorLagMs: null };
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

      for (const signup of signups) {
        await this.processSignup(signup);
        await this.db.antifraud.query(
          `
            UPDATE source_cursors
            SET occurred_at = $1, source_id = $2, updated_at = now()
            WHERE stream = 'signups'
          `,
          [signup.created_at, signup.id],
        );
        latestAt = signup.created_at;
        latestId = signup.id;
        processed += 1;
      }

      backlogPossible = signups.length === this.config.POLL_SIGNUP_BATCH_SIZE;
      if (!backlogPossible) break;
    }

    return {
      processed,
      backlogPossible,
      cursorLagMs: Math.max(0, Date.now() - latestAt.getTime()),
    };
  }

  private async processSignup(signup: Signup): Promise<void> {
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

    const context = await signupContext(this.db.source, signup);
    const [fingerprint, proxycheck] = await Promise.all([
      this.enrichment.fingerprintCheck(signup),
      this.cachedProxycheck(signup),
    ]);
    await Promise.all([
      this.saveProviderCheck(signup.id, fingerprint),
      this.saveProviderCheck(signup.id, proxycheck),
    ]);

    const signals = [
      ...baseSignupSignals(signup, context),
      ...fingerprint.signals,
      ...proxycheck.signals,
    ];
    const score = Math.max(
      0,
      signals.reduce((total, signal) => total + signal.points, 0),
    );

    await this.db.antifraud.query(
      `
        INSERT INTO signup_assessments (
          user_id, score, severity, signals, assessed_at
        ) VALUES ($1,$2,$3,$4,now())
        ON CONFLICT (user_id) DO UPDATE SET
          score = EXCLUDED.score,
          severity = EXCLUDED.severity,
          signals = EXCLUDED.signals,
          assessed_at = now()
      `,
      [signup.id, score, severity(score), JSON.stringify(signals)],
    );

    await this.live.publish("signup.assessed", {
      userId: signup.id,
      username: signup.username,
      score,
      severity: severity(score),
      signals,
    });

    if (score < this.config.MONITOR_START_SCORE) return;
    await this.openMonitor(signup, signals, score);
  }

  private async cachedProxycheck(signup: Signup): Promise<EnrichmentResult> {
    if (!signup.signup_ip) return this.enrichment.proxycheck(signup);
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
    if (!cached.rows[0]) return this.enrichment.proxycheck(signup);
    return {
      provider: "proxycheck",
      status: "success",
      lookupKey: signup.signup_ip,
      score: Number(cached.rows[0].score ?? 0),
      response: cached.rows[0].response ?? {},
      signals: storedSignals(cached.rows[0].signals),
    };
  }

  private async saveProviderCheck(
    userId: string,
    result: EnrichmentResult,
  ): Promise<void> {
    await this.db.antifraud.query(
      `
        INSERT INTO provider_checks (
          user_id, provider, lookup_key, request_id, status, score,
          signals, response, error_code, expires_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
          CASE WHEN $2 = 'proxycheck' THEN now() + interval '24 hours' ELSE NULL END)
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
  }

  private async openMonitor(
    signup: Signup,
    signals: Signal[],
    score: number,
  ): Promise<void> {
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      const caseResult = await client.query<{ id: string }>(
        `
          INSERT INTO cases(user_id, status, severity, score, peak_score, summary)
          VALUES ($1, 'monitoring', $2, $3, $3, $4)
          ON CONFLICT (user_id) WHERE status IN ('open','monitoring','in_review','escalated')
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
            case_id, user_id, ends_at, initial_score, current_score, peak_score
          ) VALUES (
            $1, $2, now() + ($3::text || ' seconds')::interval, $4, $4, $4
          )
          ON CONFLICT (user_id) WHERE status = 'active'
          DO UPDATE SET
            current_score = GREATEST(monitor_sessions.current_score, EXCLUDED.current_score),
            peak_score = GREATEST(monitor_sessions.peak_score, EXCLUDED.peak_score)
          RETURNING id
        `,
        [caseId, signup.id, this.config.MONITOR_DURATION_SECONDS, score],
      );
      const sessionId = sessionResult.rows[0]?.id;
      if (!sessionId) throw new Error("Failed to open monitor session");

      let runningScore = 0;
      for (const signal of signals) {
        runningScore += signal.points;
        await client.query(
          `
            INSERT INTO risk_events (
              case_id, session_id, user_id, event_type, source, source_ref,
              score_delta, score_after, title, detail, payload, occurred_at
            ) VALUES ($1,$2,$3,$4,'signup',NULL,$5,$6,$7,$8,$9,$10)
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
          ],
        );
      }
      await client.query("COMMIT");

      await this.live.publish("monitor.started", {
        caseId,
        sessionId,
        userId: signup.id,
        username: signup.username,
        score,
        durationSeconds: this.config.MONITOR_DURATION_SECONDS,
        signals,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
        WHERE ms.status = 'active' AND ms.ends_at > now()
      `,
    );
    return result.rows;
  }

  private async scanActiveSessions(): Promise<number> {
    const sessions = await this.activeSessions();
    const activities = await fetchActivity(
      this.db.source,
      sessions,
      this.config.POLL_ACTIVITY_BATCH_SIZE,
      this.config.POLL_ACTIVITY_OVERLAP_MS,
    );
    const byUser = new Map(sessions.map((session) => [session.user_id, session]));

    for (const activity of activities) {
      const session = byUser.get(activity.user_id);
      if (!session) continue;
      await this.recordActivity(session, activity);
    }
    return activities.length;
  }

  private pointsFor(activity: SourceActivity): number {
    return activityScoreFor(activity.event_type);
  }

  private async recordActivity(
    session: ActiveSession,
    activity: SourceActivity,
  ): Promise<void> {
    const delta = this.pointsFor(activity);
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string; score_after: number }>(
        `
          INSERT INTO risk_events (
            case_id, session_id, user_id, event_type, source, source_ref,
            score_delta, score_after, title, detail, payload, occurred_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,GREATEST(0,$8 + $7),$9,$10,$11,$12
          )
          ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING
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
          session.current_score,
          activity.title,
          activity.detail,
          activity.payload,
          activity.occurred_at,
        ],
      );
      const row = inserted.rows[0];
      if (!row) {
        await this.advanceActivityCursor(client, session.id, activity);
        await client.query("COMMIT");
        return;
      }

      await client.query(
        `
          UPDATE monitor_sessions
          SET current_score = $2,
              peak_score = GREATEST(peak_score, $2),
              event_count = event_count + 1
          WHERE id = $1
        `,
        [session.id, row.score_after],
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
        [session.case_id, row.score_after, severity(row.score_after)],
      );
      await this.advanceActivityCursor(client, session.id, activity);
      await client.query("COMMIT");
      session.current_score = row.score_after;

      await this.live.publish("monitor.event", {
        caseId: session.case_id,
        sessionId: session.id,
        userId: session.user_id,
        eventType: activity.event_type,
        title: activity.title,
        detail: activity.detail,
        scoreDelta: delta,
        score: row.score_after,
        occurredAt: activity.occurred_at,
      });
      await this.evaluateRules(session);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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

  private async evaluateRules(session: ActiveSession): Promise<void> {
    const rules = await this.db.antifraud.query<{
      id: string;
      key: string;
      name: string;
      sequence: string[];
      exclude_before: string[];
      window_seconds: number;
      score_delta: number;
      action_type: string;
    }>(
      `
        SELECT id, key, name, sequence, exclude_before, window_seconds, score_delta, action_type
        FROM rule_definitions
        WHERE enabled = true AND trigger = 'sequence'
        ORDER BY priority, key
      `,
    );

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

    for (const rule of rules.rows) {
      if (!sequenceMatches(
        events.rows,
        rule.sequence,
        rule.window_seconds,
        rule.exclude_before,
      )) {
        continue;
      }
      const match = await this.db.antifraud.query(
        `
          INSERT INTO rule_matches(rule_id, case_id, session_id, evidence)
          VALUES ($1,$2,$3,$4)
          ON CONFLICT (rule_id, session_id) DO NOTHING
          RETURNING id
        `,
        [rule.id, session.case_id, session.id, { sequence: rule.sequence }],
      );
      if (match.rowCount === 0) continue;

      const nextScore = Math.max(0, session.current_score + rule.score_delta);
      await Promise.all([
        this.db.antifraud.query(
          `
            UPDATE monitor_sessions
            SET current_score=$2, peak_score=GREATEST(peak_score,$2)
            WHERE id=$1
          `,
          [session.id, nextScore],
        ),
        this.db.antifraud.query(
          `
            UPDATE cases
            SET score=$2, peak_score=GREATEST(peak_score,$2),
                severity=$3, updated_at=now()
            WHERE id=$1
          `,
          [session.case_id, nextScore, severity(nextScore)],
        ),
      ]);
      session.current_score = nextScore;
      await this.live.publish("rule.matched", {
        caseId: session.case_id,
        sessionId: session.id,
        userId: session.user_id,
        ruleKey: rule.key,
        ruleName: rule.name,
        scoreDelta: rule.score_delta,
        score: nextScore,
        actionType: rule.action_type,
      });
      await this.discord.send({
        title: `Rule matched: ${rule.name}`,
        description:
          "A monitored account matched an antifraud rule and needs support review.",
        userId: session.user_id,
        caseId: session.case_id,
        score: nextScore,
        trigger: rule.key,
      });
    }
  }

  private async completeExpiredSessions(): Promise<void> {
    const expired = await this.db.antifraud.query<{
      id: string;
      case_id: string;
      user_id: string;
      current_score: number;
    }>(
      `
        UPDATE monitor_sessions
        SET status='completed', ended_at=now()
        WHERE status='active' AND ends_at <= now()
        RETURNING id, case_id, user_id, current_score
      `,
    );

    for (const session of expired.rows) {
      await this.db.antifraud.query(
        `
          UPDATE cases
          SET status='open', score=$2, severity=$3, updated_at=now()
          WHERE id=$1 AND status='monitoring'
        `,
        [session.case_id, session.current_score, severity(session.current_score)],
      );
      await this.live.publish("monitor.completed", {
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
