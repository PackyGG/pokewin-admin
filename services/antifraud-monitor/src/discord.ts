import type { FastifyBaseLogger } from "fastify";

import type { Config } from "./config.js";
import { sendBotDiscordEvent } from "./discord-events.js";
import { clampRiskScore } from "./scoring.js";

/**
 * This service no longer carries a copy of the Discord recipient ids.
 *
 * It used to duplicate OWNER/MANAGER/DEV/SUPPORT_USER_IDS from
 * `src/lib/discord-notifications/antifraud-policy.ts` with no shared source and
 * no test pinning them equal, so the two could silently drift. Tagging is now
 * resolved once, at enqueue time, from the destination channel's configured
 * mention groups — `ANTIFRAUD_TEAM_IDS` in the admin app is the only place the
 * ids live.
 */

const DISCORD_DESCRIPTION_LIMIT = 1_200;
const DISCORD_FIELD_LIMIT = 1_024;
const MAX_SIGNAL_ROWS = 4;

type AlertSeverity = "low" | "medium" | "high" | "critical";

export type DiscordAlertSignal = {
  title: string;
  detail: string;
  points: number;
};

export type DiscordAlert = {
  title: string;
  description: string;
  urgent?: boolean;
  userId?: string;
  username?: string | null;
  caseId?: string;
  score?: number;
  scoreDelta?: number;
  severity?: AlertSeverity;
  trigger?: string;
  outcome?: string;
  signals?: readonly DiscordAlertSignal[];
  occurredAt?: Date;
  url?: string;
};

export function discordRuntimeStatus(config: Pick<
  Config,
  | "ANTIFRAUD_INGEST_URL"
  | "ANTIFRAUD_INGEST_SECRET"
  | "ADMIN_GUILD_ID"
  | "ANTIFRAUD_DASHBOARD_URL"
>): {
  /**
   * Every antifraud alert goes onto the Discord bot's delivery queue, so there
   * is ONE readiness fact, not one per destination. The old per-webhook flags
   * were five copies of this same boolean and are gone.
   */
  botQueueConfigured: boolean;
  dashboardUrlConfigured: boolean;
} {
  return {
    botQueueConfigured: Boolean(
      config.ANTIFRAUD_INGEST_URL &&
        config.ANTIFRAUD_INGEST_SECRET &&
        config.ADMIN_GUILD_ID,
    ),
    dashboardUrlConfigured: Boolean(config.ANTIFRAUD_DASHBOARD_URL),
  };
}

/**
 * Payload shape shared by every Discord alert producer.
 *
 * There is deliberately no `content` or `allowed_mentions` here. The previous
 * version built both and then dropped them: `sendBotDiscordEvent` forwarded only
 * embed/components/content, the ingest schema had no `allowed_mentions` field,
 * and the jobs table had no column for it — so the mention restriction never
 * reached Discord despite the settings page claiming it did. Mention text and
 * its allowlist are now produced once, per destination channel, by
 * `enqueueDiscordEvent`.
 */
export type DiscordWebhookPayload = {
  username: string;
  embeds: Array<{
    title: string;
    description: string;
    url: string;
    color: number;
    fields: Array<{ name: string; value: string; inline: boolean }>;
    footer: { text: string };
    timestamp: string;
  }>;
  components: Array<{
    type: 1;
    components: Array<{
      type: 2;
      style: 5;
      label: string;
      url: string;
    }>;
  }>;
};

type DiscordPayload = DiscordWebhookPayload;

/**
 * Neutralises Discord mention syntax so user-controlled text can never ping
 * staff or roles. Shared by every alert payload builder.
 */
export function sanitizeDiscordMentions(value: string): string {
  return value
    .replace(/@everyone/gi, "everyone")
    .replace(/@here/gi, "here")
    .replace(/<@!?(\d+)>/g, "user $1")
    .replace(/<@&(\d+)>/g, "role $1");
}

function clean(value: string, maxLength: number): string {
  const withoutMentions = sanitizeDiscordMentions(value);
  return withoutMentions.length <= maxLength
    ? withoutMentions
    : `${withoutMentions.slice(0, maxLength - 3)}...`;
}

function escapeMarkdown(
  value: string,
  maxLength = DISCORD_FIELD_LIMIT,
): string {
  const escaped = clean(value, maxLength).replace(
    /([\\`*_{}[\]()#+\-.!|>~])/g,
    "\\$1",
  );
  return clean(escaped, maxLength);
}

function inlineCode(value: string): string {
  return `\`${clean(value, DISCORD_FIELD_LIMIT - 2).replace(/`/g, "'")}\``;
}

function alertUrl(baseUrl: string, caseId?: string): string {
  const url = new URL(baseUrl);
  if (!caseId) return url.toString();

  const root = url.pathname.replace(/\/+$/, "");
  url.pathname = `${root}/cases/${encodeURIComponent(caseId)}`;
  return url.toString();
}

function severityLabel(severity: AlertSeverity): string {
  return severity.charAt(0).toUpperCase() + severity.slice(1);
}

function humanize(value: string): string {
  const normalized = value.trim().replace(/[_-]+/g, " ");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function riskColor(alert: DiscordAlert): number {
  if (alert.urgent || alert.severity === "critical") return 0xed4245;
  if (alert.severity === "high") return 0xf97316;
  if (alert.severity === "medium") return 0xf59e0b;
  return 0x5865f2;
}

function accountValue(alert: DiscordAlert): string {
  const lines: string[] = [];
  if (alert.username) lines.push(`**${escapeMarkdown(alert.username)}**`);
  if (alert.userId) lines.push(`User ID ${inlineCode(alert.userId)}`);
  return clean(lines.join("\n"), DISCORD_FIELD_LIMIT);
}

function signalValue(signals: readonly DiscordAlertSignal[]): string {
  const ordered = [...signals]
    .filter((signal) => signal.points !== 0)
    .sort((left, right) => Math.abs(right.points) - Math.abs(left.points));
  const visible = ordered.slice(0, MAX_SIGNAL_ROWS);
  const lines = visible.map((signal) => {
    const points = signal.points > 0 ? `+${signal.points}` : String(signal.points);
    return `**${points} | ${escapeMarkdown(signal.title, 96)}**\n${escapeMarkdown(signal.detail, 120)}`;
  });
  const hidden = ordered.length - visible.length;
  if (hidden > 0) {
    lines.push(
      `*+${hidden} more signal${hidden === 1 ? "" : "s"} in the case*`,
    );
  }
  return clean(lines.join("\n"), DISCORD_FIELD_LIMIT);
}

function alertEmoji(alert: DiscordAlert): string {
  if (alert.severity === "critical" || alert.urgent) return "🚨";
  if (alert.severity === "high") return "⚠️";
  if (alert.severity === "medium") return "🔎";
  return "🛡️";
}

export function buildDiscordAlertPayload(
  dashboardUrl: string,
  alert: DiscordAlert,
): DiscordPayload {
  const url = alertUrl(
    alert.url ?? dashboardUrl,
    alert.url ? undefined : alert.caseId,
  );
  const fields: DiscordPayload["embeds"][number]["fields"] = [];

  if (alert.username || alert.userId) {
    fields.push({
      name: "Account",
      value: accountValue(alert),
      inline: true,
    });
  }
  if (alert.score !== undefined) {
    const score = clampRiskScore(alert.score);
    fields.push({
      name: "Risk score",
      value: alert.severity
        ? `**${score} points**\n${severityLabel(alert.severity)} risk`
        : `**${score} points**`,
      inline: true,
    });
  }
  if (alert.trigger) {
    fields.push({
      name: "Trigger",
      value: escapeMarkdown(alert.trigger),
      inline: true,
    });
  }
  if (alert.scoreDelta !== undefined) {
    fields.push({
      name: "Score change",
      value: `**${alert.scoreDelta > 0 ? "+" : ""}${alert.scoreDelta} points**`,
      inline: true,
    });
  }
  if (alert.outcome) {
    fields.push({
      name: "Outcome",
      value: escapeMarkdown(humanize(alert.outcome)),
      inline: true,
    });
  }
  if (alert.signals?.length) {
    fields.push({
      name: "Why it was flagged",
      value: signalValue(alert.signals),
      inline: false,
    });
  }
  if (alert.caseId) {
    fields.push({
      name: "Case ID",
      value: inlineCode(alert.caseId),
      inline: false,
    });
  }

  return {
    username: "PackyGG Fraud",
    embeds: [
      {
        title: clean(`${alertEmoji(alert)} ${alert.title}`, 256),
        description: clean(alert.description, DISCORD_DESCRIPTION_LIMIT),
        url,
        color: riskColor(alert),
        fields,
        footer: {
          text: alert.urgent
            ? "URGENT | PackyGG Fraud"
            : "Automated risk alert | PackyGG Fraud",
        },
        timestamp: (alert.occurredAt ?? new Date()).toISOString(),
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: alert.caseId ? "Review case" : "Open Antifraud",
            url,
          },
        ],
      },
    ],
  };
}

export class DiscordAlerts {
  constructor(
    private readonly config: Config,
    private readonly log: FastifyBaseLogger,
  ) {}

  async send(
    eventKey:
      | "antifraud.signup_low_risk"
      | "antifraud.signup_high"
      | "antifraud.signup_critical"
      | "antifraud.rule_matched",
    dedupeKey: string,
    alert: DiscordAlert,
  ): Promise<boolean> {
    return this.sendTo(eventKey, dedupeKey, alert);
  }

  async sendWithdrawalHold(
    dedupeKey: string,
    alert: DiscordAlert,
  ): Promise<boolean> {
    return this.sendTo("antifraud.withdrawal_hold", dedupeKey, alert);
  }

  async sendSumsubReady(
    dedupeKey: string,
    alert: DiscordAlert,
  ): Promise<boolean> {
    return this.sendTo("antifraud.sumsub_ready", dedupeKey, alert);
  }

  private async sendTo(
    eventKey: string,
    dedupeKey: string,
    alert: DiscordAlert,
  ): Promise<boolean> {
    return sendBotDiscordEvent(this.config, this.log, {
      eventKey,
      dedupeKey,
      payload: buildDiscordAlertPayload(
        this.config.ANTIFRAUD_DASHBOARD_URL,
        alert,
      ),
    });
  }
}
