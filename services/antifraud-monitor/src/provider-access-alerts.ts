import type { FastifyBaseLogger } from "fastify";

import type { Config } from "./config.js";
import {
  buildDiscordAlertPayload,
  type DiscordAlert,
} from "./discord.js";
import { sendBotDiscordEvent } from "./discord-events.js";
import {
  classifyProviderFailure,
  type SignupProvider,
} from "./provider-contracts.js";

export type ProviderAccessIssueKind =
  | "missing_credential"
  | "invalid_credential"
  | "expired_credential"
  | "quota_exhausted"
  | "quota_low"
  | "timeout"
  | "request_failed";

export type ProviderAccessIssue = {
  provider: SignupProvider;
  kind: ProviderAccessIssueKind;
  queriesRemaining?: number;
  fundsRemainingUsd?: number;
};

export const MAXMIND_LOW_QUERIES_THRESHOLD = 1_000;
export const MAXMIND_LOW_FUNDS_USD_THRESHOLD = 10;

const PROVIDER_LABELS: Record<SignupProvider, string> = {
  fingerprint: "Fingerprint",
  proxycheck: "ProxyCheck",
  abstract_ip: "Abstract IP Intelligence",
  abstract_email: "Abstract Email Reputation",
  opportify: "Opportify",
  maxmind: "MaxMind minFraud",
};

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * minFraud Factors returns both values in its successful JSON response. They
 * are account-level operational metadata, not customer evidence.
 */
export function maxmindAccessIssue(response: Record<string, unknown>):
  | ProviderAccessIssue
  | undefined {
  const queriesRemaining = finiteNonNegative(response.queries_remaining);
  const fundsRemainingUsd = finiteNonNegative(response.funds_remaining);
  if (queriesRemaining === 0 || fundsRemainingUsd === 0) {
    return {
      provider: "maxmind",
      kind: "quota_exhausted",
      queriesRemaining,
      fundsRemainingUsd,
    };
  }
  if (
    (queriesRemaining !== undefined
      && queriesRemaining <= MAXMIND_LOW_QUERIES_THRESHOLD)
    || (fundsRemainingUsd !== undefined
      && fundsRemainingUsd <= MAXMIND_LOW_FUNDS_USD_THRESHOLD)
  ) {
    return {
      provider: "maxmind",
      kind: "quota_low",
      queriesRemaining,
      fundsRemainingUsd,
    };
  }
  return undefined;
}

export function providerFailureAccessIssue(
  provider: SignupProvider,
  errorCode: string | undefined,
): ProviderAccessIssue | undefined {
  const code = errorCode?.toLowerCase() ?? "";
  if (/http_402|payment.required|out.of.(queries|credits|funds)|quota.exhausted/.test(code)) {
    return { provider, kind: "quota_exhausted" };
  }
  if (/expired|revoked/.test(code)) {
    return { provider, kind: "expired_credential" };
  }
  if (/http_(401|403)|auth|invalid.*(key|credential)|license.*invalid/.test(code)) {
    return { provider, kind: "invalid_credential" };
  }
  const failure = classifyProviderFailure(errorCode);
  if (failure === "missing_compatible_datum") return undefined;
  if (failure === "timeout") return { provider, kind: "timeout" };
  return { provider, kind: "request_failed" };
}

function issueAlert(issue: ProviderAccessIssue): DiscordAlert {
  const provider = PROVIDER_LABELS[issue.provider];
  const balance = [
    issue.queriesRemaining !== undefined
      ? `${issue.queriesRemaining.toLocaleString("en-US")} queries remaining`
      : null,
    issue.fundsRemainingUsd !== undefined
      ? `$${issue.fundsRemainingUsd.toFixed(2)} remaining`
      : null,
  ].filter((value): value is string => Boolean(value)).join("; ");
  const copy: Record<ProviderAccessIssueKind, {
    title: string;
    description: string;
    outcome: string;
  }> = {
    missing_credential: {
      title: "Third-party API key is missing",
      description: `${provider} has no configured credential. Provider checks cannot run until it is restored.`,
      outcome: "missing credential",
    },
    invalid_credential: {
      title: "Third-party API key is invalid",
      description: `${provider} rejected its configured credential. Replace or re-authorize the key.`,
      outcome: "invalid credential",
    },
    expired_credential: {
      title: "Third-party API key expired",
      description: `${provider} reports that its configured credential expired or was revoked. Replace or re-authorize the key.`,
      outcome: "expired credential",
    },
    quota_exhausted: {
      title: "Third-party API credits are empty",
      description: `${provider} has no usable paid queries or funds remaining${balance ? ` (${balance})` : ""}.`,
      outcome: "credits exhausted",
    },
    quota_low: {
      title: "Third-party API credits are running low",
      description: `${provider} is approaching exhaustion${balance ? ` (${balance})` : ""}. Refill it before provider checks stop.`,
      outcome: "credits low",
    },
    timeout: {
      title: "Third-party API timed out",
      description: `${provider} did not answer within the bounded request window. The failure stays in the third-party API category.`,
      outcome: "provider timeout",
    },
    request_failed: {
      title: "Third-party API failed unexpectedly",
      description: `${provider} returned an invalid, malformed, upstream, or otherwise unexpected failure. Inspect the sanitized provider evidence.`,
      outcome: "unexpected provider failure",
    },
  };
  const selected = copy[issue.kind];
  return {
    ...selected,
    trigger: provider,
    severity:
      issue.kind === "quota_low" || issue.kind === "timeout"
        ? "medium"
        : "high",
    server: "Antifraud monitor · Railway production",
  };
}

function dedupeWindow(issue: ProviderAccessIssue, now: Date): string {
  // Invalid/missing credentials retry hourly so a still-broken key is not
  // forgotten. Balance notices repeat daily while preserving queue dedupe.
  const iso = now.toISOString();
  return issue.kind === "quota_low" || issue.kind === "quota_exhausted"
    ? iso.slice(0, 10)
    : iso.slice(0, 13);
}

export async function sendProviderAccessIssue(
  config: Pick<
    Config,
    | "ADMIN_GUILD_ID"
    | "ANTIFRAUD_INGEST_URL"
    | "ANTIFRAUD_INGEST_SECRET"
    | "ANTIFRAUD_DASHBOARD_URL"
  >,
  log: Pick<FastifyBaseLogger, "warn" | "error">,
  issue: ProviderAccessIssue,
  now = new Date(),
): Promise<boolean> {
  return sendBotDiscordEvent(config, log, {
    eventKey: "antifraud.error.third_party_api",
    dedupeKey: `provider-access:${issue.provider}:${issue.kind}:${dedupeWindow(issue, now)}`,
    payload: buildDiscordAlertPayload(
      config.ANTIFRAUD_DASHBOARD_URL,
      issueAlert(issue),
    ),
  });
}

const REQUIRED_PROVIDER_ENV: ReadonlyArray<{
  provider: SignupProvider;
  keys: readonly string[];
}> = [
  { provider: "fingerprint", keys: ["FINGERPRINT_SECRET_API_KEY"] },
  { provider: "proxycheck", keys: ["PROXYCHECK_API_KEY"] },
  { provider: "abstract_ip", keys: ["ABSTRACT_IP_INTELLIGENCE_API_KEY"] },
  { provider: "abstract_email", keys: ["ABSTRACT_EMAIL_REPUTATION_API_KEY"] },
  { provider: "opportify", keys: ["OPPORTIFY_API_KEY"] },
  { provider: "maxmind", keys: ["MAXMIND_ACCOUNT_ID", "MAXMIND_LICENSE_KEY"] },
];

export function missingProviderCredentials(
  env: Record<string, string | undefined>,
): ProviderAccessIssue[] {
  return REQUIRED_PROVIDER_ENV
    .filter(({ keys }) => keys.some((key) => !env[key]?.trim()))
    .map(({ provider }) => ({ provider, kind: "missing_credential" }));
}

export function bootstrapProviderAccessConfig(
  env: Record<string, string | undefined>,
): Pick<
  Config,
  | "ADMIN_GUILD_ID"
  | "ANTIFRAUD_INGEST_URL"
  | "ANTIFRAUD_INGEST_SECRET"
  | "ANTIFRAUD_DASHBOARD_URL"
> | undefined {
  const guildId = env.ADMIN_GUILD_ID?.trim() || "1483064422778798112";
  const ingestUrl = env.ANTIFRAUD_INGEST_URL?.trim();
  const ingestSecret = env.ANTIFRAUD_INGEST_SECRET?.trim();
  const dashboardUrl = env.ANTIFRAUD_DASHBOARD_URL?.trim()
    || "https://fraud.packydash.com/monitor";
  if (!/^\d{15,21}$/.test(guildId) || !ingestUrl || !ingestSecret) {
    return undefined;
  }
  try {
    return {
      ADMIN_GUILD_ID: guildId,
      ANTIFRAUD_INGEST_URL: new URL(ingestUrl).toString(),
      ANTIFRAUD_INGEST_SECRET: ingestSecret,
      ANTIFRAUD_DASHBOARD_URL: new URL(dashboardUrl).toString(),
    };
  } catch {
    return undefined;
  }
}
