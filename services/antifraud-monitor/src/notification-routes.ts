import type { Config } from "./config.js";

export const NOTIFICATION_ROUTE_KEYS = [
  "antifraud_risk",
  "fiat_operations",
  "high_risk_supplemental",
  "email_blacklist",
  "withdrawal_hold",
  "signed_ingest",
] as const;

export type NotificationRouteKey = (typeof NOTIFICATION_ROUTE_KEYS)[number];
export type DiscordNotificationRouteKey = Exclude<
  NotificationRouteKey,
  "signed_ingest"
>;

type NotificationConfig = Partial<
  Pick<
    Config,
    | "ANTIFRAUD_DISCORD_WEBHOOK_URL"
    | "ANTIFRAUD_WITHDRAWAL_HOLD_DISCORD_WEBHOOK_URL"
    | "FIAT_ALERT_DISCORD_WEBHOOK_URL"
    | "FIAT_HIGH_RISK_DISCORD_WEBHOOK_URL"
    | "FIAT_EMAIL_BLACKLIST_DISCORD_WEBHOOK_URL"
    | "ANTIFRAUD_INGEST_URL"
    | "ANTIFRAUD_INGEST_SECRET"
  >
>;

type NotificationRouteDefinition = {
  label: string;
  purpose: string;
  eventFamilies: readonly string[];
  configured: (config: NotificationConfig) => boolean;
};

const ROUTES = {
  antifraud_risk: {
    label: "Antifraud risk",
    purpose: "Primary Discord alerts that need fraud-team review.",
    eventFamilies: [
      "High-risk signups",
      "Matched behavior rules",
      "Canonical high-risk fiat verdicts",
      "Fiat deposits on locked accounts",
    ],
    configured: (config) => Boolean(config.ANTIFRAUD_DISCORD_WEBHOOK_URL),
  },
  fiat_operations: {
    label: "Fiat operations",
    purpose: "Routine Discord alerts for fiat payment lifecycle problems.",
    eventFamilies: [
      "Failed payments",
      "Provider reviews and disputes",
      "Partial and full refunds",
      "Stale checkout and pending payments",
      "Failed payment webhooks",
    ],
    configured: (config) => Boolean(config.FIAT_ALERT_DISCORD_WEBHOOK_URL),
  },
  high_risk_supplemental: {
    label: "High-risk fiat supplemental",
    purpose: "A separate Discord copy of canonical high-risk fiat verdicts.",
    eventFamilies: ["Canonical high-risk fiat verdicts"],
    configured: (config) =>
      Boolean(config.FIAT_HIGH_RISK_DISCORD_WEBHOOK_URL),
  },
  email_blacklist: {
    label: "Email containment",
    purpose: "Discord alerts for email and deposit-cluster containment.",
    eventFamilies: [
      "Blacklisted signup email domains",
      "Blacklisted Whop checkout domains",
      "Suspicious same-amount deposit clusters",
    ],
    configured: (config) =>
      Boolean(config.FIAT_EMAIL_BLACKLIST_DISCORD_WEBHOOK_URL),
  },
  withdrawal_hold: {
    label: "Withdrawal holds",
    purpose: "Discord alerts for automatic account-level withdrawal holds.",
    eventFamilies: ["Automatic lifetime-fiat withdrawal holds"],
    configured: (config) =>
      Boolean(config.ANTIFRAUD_WITHDRAWAL_HOLD_DISCORD_WEBHOOK_URL),
  },
  signed_ingest: {
    label: "Signed dashboard ingest",
    purpose: "Signed delivery of committed risk events to the admin dashboard.",
    eventFamilies: [
      "Committed antifraud risk events",
      "Score-60 signup review markers",
      "Email-containment withdrawal locks",
      "Automatic fiat withdrawal-hold review signals",
    ],
    configured: (config) =>
      Boolean(config.ANTIFRAUD_INGEST_URL && config.ANTIFRAUD_INGEST_SECRET),
  },
} satisfies Record<NotificationRouteKey, NotificationRouteDefinition>;

const DISCORD_CONFIG_KEYS = {
  antifraud_risk: "ANTIFRAUD_DISCORD_WEBHOOK_URL",
  fiat_operations: "FIAT_ALERT_DISCORD_WEBHOOK_URL",
  high_risk_supplemental: "FIAT_HIGH_RISK_DISCORD_WEBHOOK_URL",
  email_blacklist: "FIAT_EMAIL_BLACKLIST_DISCORD_WEBHOOK_URL",
  withdrawal_hold: "ANTIFRAUD_WITHDRAWAL_HOLD_DISCORD_WEBHOOK_URL",
} as const satisfies Record<
  DiscordNotificationRouteKey,
  keyof NotificationConfig
>;

export function notificationWebhookUrl(
  config: NotificationConfig,
  route: DiscordNotificationRouteKey,
): string | undefined {
  return config[DISCORD_CONFIG_KEYS[route]];
}

export function signedIngestTarget(
  config: NotificationConfig,
): { url: string; secret: string } | null {
  if (!config.ANTIFRAUD_INGEST_URL || !config.ANTIFRAUD_INGEST_SECRET) {
    return null;
  }
  return {
    url: config.ANTIFRAUD_INGEST_URL,
    secret: config.ANTIFRAUD_INGEST_SECRET,
  };
}

export function notificationRouteStatuses(config: NotificationConfig): Array<{
  label: string;
  purpose: string;
  eventFamilies: readonly string[];
  configured: boolean;
}> {
  return NOTIFICATION_ROUTE_KEYS.map((key) => {
    const route = ROUTES[key];
    return {
      label: route.label,
      purpose: route.purpose,
      eventFamilies: route.eventFamilies,
      configured: route.configured(config),
    };
  });
}

type FiatProblemCode =
  | "high_risk"
  | "fiat_locked_account"
  | "failed"
  | "review"
  | "disputed"
  | "partially_refunded"
  | "refunded"
  | "checkout_creating_stale"
  | "pending_stale"
  | "webhook_failed"
  | "blacklisted_email_domain"
  | "suspicious_deposit_cluster";

export type FiatNotificationRouteKey = Extract<
  DiscordNotificationRouteKey,
  | "antifraud_risk"
  | "fiat_operations"
  | "high_risk_supplemental"
  | "email_blacklist"
>;

export function notificationRoutesForFiatProblem(
  problemCode: FiatProblemCode,
): readonly FiatNotificationRouteKey[] {
  if (
    problemCode === "blacklisted_email_domain" ||
    problemCode === "suspicious_deposit_cluster"
  ) {
    return ["email_blacklist"];
  }
  if (problemCode === "high_risk") {
    return ["antifraud_risk", "high_risk_supplemental"];
  }
  if (problemCode === "fiat_locked_account") {
    return ["antifraud_risk"];
  }
  return ["fiat_operations"];
}
