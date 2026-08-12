import { createHmac, randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";

import type { Config } from "./config.js";
import { sendBotDiscordEvent } from "./discord-events.js";

const INTERVAL_MS = 60_000;
const TIMEOUT_MS = 8_000;
const OUTAGE_THRESHOLD = 3;
const ALERT_COOLDOWN_MS = 30 * 60_000;

/**
 * Wall-clock window stamped into every alert dedupe key.
 *
 * Dedupe keys are enforced forever by a unique index on
 * `discord_notification_jobs (guild_id, event_key, dedupe_key, channel_id)`,
 * nothing prunes those rows, and a deduped enqueue still answers 200 — so a
 * colliding key drops the alert while the monitor records a successful send.
 * The episode counters below restart at 0 with the process, so every redeploy
 * replayed `webapp_outage_1_1` and the next real outage was swallowed silently.
 * The window is derived from the clock instead, so it survives a restart, and
 * because it advances with the alert cooldown any suppression it does cause is
 * time-bounded rather than permanent.
 */
function alertWindow(now: number): number {
  return Math.floor(now / ALERT_COOLDOWN_MS);
}

/**
 * Webapp health probe + outage alerting.
 *
 * The alert goes out as an `antifraud.error.webapp` event on the Discord bot's
 * delivery queue, the same route every other antifraud alert takes. That queue
 * is reached through the dashboard's signed ingest endpoint, so a TOTAL webapp
 * outage also blocks the alert about it — the probe keeps retrying every minute
 * and the alert lands as soon as ingest answers again. The previous independent
 * raw Discord webhook is gone.
 */
export class DashboardOpsTick {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = false;
  private healthFailures = 0;
  private lastAlertAt = 0;
  private outageOpen = false;
  private lastCheckedAt: string | null = null;
  /** Separates concurrent episodes inside one window; restart safety is the
   * window's job, not this counter's. */
  private episode = 0;
  private episodeAlerts = 0;

  constructor(
    private readonly config: Pick<
      Config,
      | "ANTIFRAUD_INGEST_URL"
      | "ANTIFRAUD_INGEST_SECRET"
      | "ANTIFRAUD_WEBAPP_HEALTH_URL"
      | "ADMIN_GUILD_ID"
    >,
    private readonly log: FastifyBaseLogger,
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule(1_000 + Math.floor(Math.random() * 4_000));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  status(): {
    status: "starting" | "healthy" | "degraded";
    consecutiveFailures: number;
    lastCheckedAt: string | null;
  } {
    return {
      status:
        this.lastCheckedAt === null
          ? "starting"
          : this.outageOpen
            ? "degraded"
            : "healthy",
      consecutiveFailures: this.healthFailures,
      lastCheckedAt: this.lastCheckedAt,
    };
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    const correlationId = randomUUID();
    const body = JSON.stringify({ schemaVersion: 1, correlationId });
    const timestamp = String(Date.now());
    const signature =
      "sha256=" +
      createHmac("sha256", this.config.ANTIFRAUD_INGEST_SECRET)
        .update(`${timestamp}.${body}`)
        .digest("hex");
    try {
      await this.checkWebappHealth(correlationId);
      const response = await fetch(
        new URL("/api/antifraud/ops/tick", this.config.ANTIFRAUD_INGEST_URL),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-antifraud-timestamp": timestamp,
            "x-antifraud-signature": signature,
            "x-correlation-id": correlationId,
          },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        this.log.warn(
          { status: response.status, correlationId },
          "Dashboard operations tick failed",
        );
      }
    } catch (error) {
      this.log.warn(
        { err: error, correlationId },
        "Dashboard operations tick unavailable",
      );
    } finally {
      this.running = false;
      this.schedule(INTERVAL_MS + Math.floor(Math.random() * 5_000));
    }
  }

  private async checkWebappHealth(correlationId: string): Promise<void> {
    this.lastCheckedAt = new Date().toISOString();
    try {
      const response = await fetch(this.config.ANTIFRAUD_WEBAPP_HEALTH_URL, {
        headers: { "x-correlation-id": correlationId },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`health_status_${response.status}`);
      const payload = (await response.json()) as {
        status?: unknown;
        service?: unknown;
        schemaVersion?: unknown;
      };
      if (
        payload.status !== "healthy" ||
        payload.service !== "antifraud-webapp" ||
        payload.schemaVersion !== 1
      ) {
        throw new Error("health_contract_invalid");
      }
      const wasOutage = this.outageOpen;
      // Clear the recovered state BEFORE awaiting the alert: sendAlert can
      // take the full 5s Discord timeout, and until it resolved `status()`
      // kept reporting "degraded" for a webapp that is demonstrably healthy.
      this.healthFailures = 0;
      this.outageOpen = false;
      if (wasOutage) {
        const dedupeKey = `webapp_recovered_${alertWindow(Date.now())}_${this.episode}`;
        const sent = await this.sendAlert(
          correlationId,
          dedupeKey,
          "✅ Antifraud webapp recovered",
          "The Railway probe can reach the antifraud webapp again.",
          0x57f287,
        );
        if (!sent) {
          this.log.warn(
            { correlationId, episode: this.episode, dedupeKey },
            "Antifraud webapp recovery alert was not delivered",
          );
        }
      }
    } catch (error) {
      this.healthFailures += 1;
      this.log.warn(
        { err: error, correlationId, failures: this.healthFailures },
        "Antifraud webapp health probe failed",
      );
      const now = Date.now();
      if (
        this.healthFailures >= OUTAGE_THRESHOLD &&
        (!this.outageOpen || now - this.lastAlertAt >= ALERT_COOLDOWN_MS)
      ) {
        if (!this.outageOpen) {
          this.episode += 1;
          this.episodeAlerts = 0;
        }
        this.episodeAlerts += 1;
        const dedupeKey = `webapp_outage_${alertWindow(now)}_${this.episode}_${this.episodeAlerts}`;
        const sent = await this.sendAlert(
          correlationId,
          dedupeKey,
          "🚨 Antifraud webapp outage",
          "The Railway probe cannot reach the antifraud webapp. Investigate Vercel and webapp runtime health.",
          0xed4245,
        );
        if (sent) {
          this.lastAlertAt = now;
          // A dedupe collision downstream is indistinguishable from a real send
          // (the enqueue answers 200 either way), so record the key we claimed
          // to have sent: this line with no Discord message is the only signal
          // that the alert was dropped at the job table.
          this.log.info(
            { correlationId, episode: this.episode, dedupeKey },
            "Antifraud webapp outage alert dispatched",
          );
        } else {
          this.log.error(
            {
              correlationId,
              episode: this.episode,
              failures: this.healthFailures,
              dedupeKey,
            },
            "Antifraud webapp outage alert was not delivered; retrying next tick",
          );
        }
        this.outageOpen = true;
      }
    }
  }

  /**
   * Queue the alert on the Discord bot route. This producer does not choose who
   * gets tagged: `enqueueDiscordEvent` resolves that from the destination
   * channel's configured mention groups and stores the matching
   * `allowed_mentions` allowlist with the job.
   */
  private async sendAlert(
    correlationId: string,
    dedupeKey: string,
    title: string,
    description: string,
    color: number,
  ): Promise<boolean> {
    const fields = [
      { name: "Webapp", value: "fraud", inline: true },
      {
        name: "Server",
        value: "fraud.packydash.com · Vercel production",
        inline: true,
      },
      {
        name: "Detected by",
        value: "Antifraud monitor · Railway production",
        inline: false,
      },
    ];
    return sendBotDiscordEvent(this.config, this.log, {
      eventKey: "antifraud.error.webapp",
      dedupeKey,
      payload: {
        embeds: [
          {
            title,
            description,
            url: "https://fraud.packydash.com",
            color,
            fields,
            footer: { text: `Correlation ${correlationId}` },
            timestamp: new Date().toISOString(),
          },
        ],
      },
    });
  }
}
