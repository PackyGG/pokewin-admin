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
const DISCORD_DESCRIPTION_LIMIT = 4_096;

export type DiscordAlert = {
  title: string;
  description: string;
  urgent?: boolean;
  userId?: string;
  username?: string | null;
  caseId?: string;
  score?: number;
  trigger?: string;
  occurredAt?: Date;
};

export function discordRuntimeStatus(config: Pick<
  Config,
  | "ANTIFRAUD_DISCORD_WEBHOOK_URL"
  | "ANTIFRAUD_DASHBOARD_URL"
>): {
  webhookConfigured: boolean;
  dashboardUrlConfigured: boolean;
  supportRecipientIds: readonly string[];
  urgentRecipientIds: readonly string[];
} {
  return {
    webhookConfigured: Boolean(config.ANTIFRAUD_DISCORD_WEBHOOK_URL),
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
    : `${withoutMentions.slice(0, maxLength - 1)}…`;
}

function alertUrl(baseUrl: string): string {
  return new URL(baseUrl).toString();
}

export function buildDiscordAlertPayload(
  dashboardUrl: string,
  alert: DiscordAlert,
): DiscordPayload {
  const mentionIds = [
    ...SUPPORT_USER_IDS,
    ...(alert.urgent ? URGENT_USER_IDS : []),
  ];
  const url = alertUrl(dashboardUrl);
  const fields: DiscordPayload["embeds"][number]["fields"] = [];

  if (alert.username || alert.userId) {
    fields.push({
      name: "Account",
      value: clean(
        [alert.username, alert.userId].filter(Boolean).join(" · "),
        1_024,
      ),
      inline: true,
    });
  }
  if (alert.score !== undefined) {
    fields.push({
      name: "Risk score",
      value: String(alert.score),
      inline: true,
    });
  }
  if (alert.trigger) {
    fields.push({
      name: "Trigger",
      value: clean(alert.trigger, 1_024),
      inline: true,
    });
  }
  if (alert.caseId) {
    fields.push({
      name: "Case",
      value: clean(alert.caseId, 1_024),
      inline: true,
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
        color: alert.urgent ? 0xef4444 : 0x5865f2,
        fields,
        footer: {
          text: alert.urgent
            ? "URGENT · PackyGG Fraud"
            : "PackyGG Fraud",
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
            label: "Open Antifraud",
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
    const webhookUrl = this.config.ANTIFRAUD_DISCORD_WEBHOOK_URL;
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
