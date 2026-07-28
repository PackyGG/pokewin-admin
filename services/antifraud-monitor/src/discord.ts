import type { FastifyBaseLogger } from "fastify";

import type { Config } from "./config.js";

export const SUPPORT_USER_IDS = [
  "1302882250391818311",
  "976564661820481606",
  "620373461256110112",
] as const;

export const URGENT_USER_IDS = [
  "934854938641715240",
  "660132586630414338",
  "276098533629755392",
  "188051599099297802",
] as const;

const SEND_TIMEOUT_MS = 5_000;
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
  | "ANTIFRAUD_DISCORD_WEBHOOK_URL"
  | "ANTIFRAUD_WITHDRAWAL_HOLD_DISCORD_WEBHOOK_URL"
  | "FIAT_ALERT_DISCORD_WEBHOOK_URL"
  | "ANTIFRAUD_DASHBOARD_URL"
>): {
  webhookConfigured: boolean;
  withdrawalHoldWebhookConfigured: boolean;
  fiatProblemWebhookConfigured: boolean;
  dashboardUrlConfigured: boolean;
  supportRecipientIds: readonly string[];
  urgentRecipientIds: readonly string[];
} {
  return {
    webhookConfigured: Boolean(config.ANTIFRAUD_DISCORD_WEBHOOK_URL),
    withdrawalHoldWebhookConfigured: Boolean(
      config.ANTIFRAUD_WITHDRAWAL_HOLD_DISCORD_WEBHOOK_URL,
    ),
    fiatProblemWebhookConfigured: Boolean(
      config.FIAT_ALERT_DISCORD_WEBHOOK_URL,
    ),
    dashboardUrlConfigured: Boolean(config.ANTIFRAUD_DASHBOARD_URL),
    supportRecipientIds: SUPPORT_USER_IDS,
    urgentRecipientIds: URGENT_USER_IDS,
  };
}

type DiscordPayload = {
  username: string;
  content: string;
  allowed_mentions: {
    parse: [];
    users: string[];
  };
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

function clean(value: string, maxLength: number): string {
  const withoutMentions = value
    .replace(/@everyone/gi, "everyone")
    .replace(/@here/gi, "here")
    .replace(/<@!?(\d+)>/g, "user $1")
    .replace(/<@&(\d+)>/g, "role $1");
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

export function buildDiscordAlertPayload(
  dashboardUrl: string,
  alert: DiscordAlert,
): DiscordPayload {
  const mentionIds = [
    ...SUPPORT_USER_IDS,
    ...(alert.urgent ? URGENT_USER_IDS : []),
  ];
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
    fields.push({
      name: "Risk score",
      value: alert.severity
        ? `**${alert.score} points**\n${severityLabel(alert.severity)} risk`
        : `**${alert.score} points**`,
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
    content: mentionIds.map((id) => `<@${id}>`).join(" "),
    allowed_mentions: { parse: [], users: mentionIds },
    embeds: [
      {
        title: clean(alert.title, 256),
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

  async send(alert: DiscordAlert): Promise<boolean> {
    return this.sendTo(
      this.config.ANTIFRAUD_DISCORD_WEBHOOK_URL,
      alert,
    );
  }

  async sendWithdrawalHold(alert: DiscordAlert): Promise<boolean> {
    return this.sendTo(
      this.config.ANTIFRAUD_WITHDRAWAL_HOLD_DISCORD_WEBHOOK_URL,
      alert,
    );
  }

  private async sendTo(
    webhookUrl: string | undefined,
    alert: DiscordAlert,
  ): Promise<boolean> {
    if (!webhookUrl) return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const deliveryUrl = new URL(webhookUrl);
      deliveryUrl.searchParams.set("with_components", "true");
      const response = await fetch(deliveryUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          buildDiscordAlertPayload(
            this.config.ANTIFRAUD_DASHBOARD_URL,
            alert,
          ),
        ),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.log.error(
          { status: response.status },
          "Discord alert delivery failed",
        );
        return false;
      }
      return true;
    } catch (error) {
      this.log.error({ err: error }, "Discord alert delivery failed");
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
