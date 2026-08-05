import "server-only";

import { cache } from "react";
import { z } from "zod";

import { getExcludedUserIdsStrict } from "@/lib/excluded-users/fetch";
import { isNonActionableRewardEnrollmentSignal } from "@/lib/antifraud/signal-display";

const scoreOptionSchema = z.object({
  key: z.string(),
  label: z.string(),
  points: z.number(),
});

const scoreDefinitionSchema = z.object({
  key: z.string(),
  title: z.string(),
  description: z.string(),
  options: z.array(scoreOptionSchema),
});

const behaviorRuleSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  trigger: z.string(),
  sequence: z.array(z.string()),
  exclude_before: z.array(z.string()),
  window_seconds: z.number(),
  score_delta: z.number(),
  action_type: z.string(),
  priority: z.number(),
  updated_at: z.string(),
});

const monitorEventSchema = z.object({
  key: z.string(),
  name: z.string(),
  category: z.enum([
    "Account",
    "Money",
    "Rewards",
    "Games",
    "Social",
    "Security",
  ]),
  description: z.string(),
  source: z.string(),
  status: z.enum(["live", "planned"]),
});

const scoringConfigSchema = z.object({
  monitorStartScore: z.number(),
  monitorDurationSeconds: z.number(),
  severityBands: z.array(
    z.object({
      key: z.enum(["low", "medium", "high", "critical"]),
      label: z.string(),
      minimum: z.number(),
      maximum: z.number().nullable(),
    }),
  ),
  signupSignals: z.array(scoreDefinitionSchema),
  providerSignals: z.array(scoreDefinitionSchema),
  activitySignals: z.array(scoreDefinitionSchema),
  behaviorRules: z.array(behaviorRuleSchema),
});

export type AntifraudScoringConfig = z.infer<typeof scoringConfigSchema>;
export type AntifraudScoreDefinition = z.infer<typeof scoreDefinitionSchema>;
export type AntifraudBehaviorRule = z.infer<typeof behaviorRuleSchema>;
export type AntifraudMonitorEvent = z.infer<typeof monitorEventSchema>;

const UPSTREAM_TIMEOUT_MS = 8_000;

const runtimeConfigSchema = z.object({
  discord: z.object({
    // Optional, not defaulted: a monitor build that predates the bot-only
    // migration simply omits it, and "unknown" must not render as "off".
    botQueueConfigured: z.boolean().optional(),
    dashboardUrlConfigured: z.boolean(),
    // Recipient ids are deliberately absent. Who gets tagged is per-channel
    // admin-DB configuration now, read directly by the settings page, so the
    // monitor no longer carries a second copy that could drift. Kept optional
    // so a monitor build that still reports them parses instead of failing.
    supportRecipientIds: z.array(z.string()).optional(),
    urgentRecipientIds: z.array(z.string()).optional(),
  }),
  providers: z.object({
    fingerprintConfigured: z.boolean(),
    proxycheckConfigured: z.boolean(),
    abstractIpConfigured: z.boolean(),
    abstractEmailConfigured: z.boolean(),
    maxmindFactorsConfigured: z.boolean(),
    maxmindAlertsConfigured: z.boolean(),
  }),
  providerContracts: z.object({
    fingerprint: z.object({
      model: z.string(),
      version: z.string(),
      endpoint: z.string(),
      method: z.string(),
      requiredDatum: z.string(),
    }),
    proxycheck: z.object({
      model: z.string(),
      version: z.string(),
      endpoint: z.string(),
      method: z.string(),
      requiredDatum: z.string(),
    }),
    abstract_ip: z.object({
      model: z.string(),
      version: z.string(),
      endpoint: z.string(),
      method: z.string(),
      requiredDatum: z.string(),
    }),
    abstract_email: z.object({
      model: z.string(),
      version: z.string(),
      endpoint: z.string(),
      method: z.string(),
      requiredDatum: z.string(),
    }),
    maxmind: z.object({
      model: z.string(),
      version: z.string(),
      endpoint: z.string(),
      method: z.string(),
      requiredDatum: z.string(),
    }),
  }).optional(),
  live: z.object({
    redisConfigured: z.boolean(),
    readTokenConfigured: z.boolean(),
    adminTokenConfigured: z.boolean(),
    exactOriginsConfigured: z.boolean(),
  }),
  ingest: z.object({
    endpointConfigured: z.boolean(),
    secretConfigured: z.boolean(),
  }),
  externalWebappMonitor: z.object({
    endpointConfigured: z.boolean(),
    alertRouteConfigured: z.boolean(),
  }).optional(),
  fiatEligibility: z.object({
    devCredentialConfigured: z.boolean(),
    prodCredentialConfigured: z.boolean(),
    devSourceConfigured: z.boolean(),
    devIpAllowlistConfigured: z.boolean(),
    prodIpAllowlistConfigured: z.boolean(),
  }).optional(),
});

export type AntifraudRuntimeConfig = z.infer<typeof runtimeConfigSchema>;

const fiatAccessControlStatusSchema = z.object({
  configured: z.boolean(),
  existingAccounts: z.object({
    enabled: z.boolean(),
    generation: z.number().int().nonnegative(),
    status: z.enum(["not_started", "queued", "running", "complete", "stalled"]),
    processed: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
    cutoffAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  }),
  newSignups: z.object({
    enabled: z.boolean(),
    generation: z.number().int().nonnegative(),
    effectiveAt: z.string().nullable(),
    processed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
});

export type FiatAccessControlStatus = z.infer<
  typeof fiatAccessControlStatusSchema
>;

export async function getFiatAccessControlStatus(): Promise<{
  configured: boolean;
  data: FiatAccessControlStatus | null;
  error: boolean;
}> {
  const { baseUrl, token } = readToken();
  if (!baseUrl || !token) {
    return { configured: false, data: null, error: false };
  }
  try {
    const response = await fetch(`${baseUrl}/v1/fiat-deposit-access/config`, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Monitor API returned ${response.status}`);
    const payload = z
      .object({ data: fiatAccessControlStatusSchema })
      .parse(await response.json());
    return { configured: true, data: payload.data, error: false };
  } catch (error) {
    console.error("[antifraud-monitor] Fiat access config failed:", error);
    return { configured: true, data: null, error: true };
  }
}

export async function updateFiatAccessControl(input: {
  scope: "existing-accounts" | "new-signups";
  enabled: boolean;
  actorId: string;
}): Promise<FiatAccessControlStatus> {
  const baseUrl = process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, "");
  const token = process.env.ANTIFRAUD_MONITOR_API_ADMIN_TOKEN;
  if (!baseUrl || !token) {
    throw new Error("Fiat access controls are not configured.");
  }
  let response: Response;
  try {
    response = await fetch(
      `${baseUrl}/v1/fiat-deposit-access/config/${input.scope}`,
      {
        method: "PUT",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ enabled: input.enabled, actorId: input.actorId }),
        cache: "no-store",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
  } catch {
    throw new Error("The monitor service did not respond. No access policy changed.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("The monitor rejected the Fiat access credentials.");
  }
  if (!response.ok) {
    throw new Error("The Fiat access policy could not be saved.");
  }
  const parsed = z
    .object({ data: fiatAccessControlStatusSchema })
    .safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new Error("The monitor returned an invalid Fiat access status.");
  }
  return parsed.data.data;
}

const pollerHealthSchema = z.object({
  status: z.enum(["starting", "healthy", "degraded", "standby"]),
  running: z.boolean(),
  leader: z.boolean(),
  lastTickStartedAt: z.string().nullable(),
  lastTickCompletedAt: z.string().nullable(),
  lastSuccessfulTickAt: z.string().nullable(),
  lastTickDurationMs: z.number().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  skippedTicks: z.number().int().nonnegative(),
  signupsProcessed: z.number().int().nonnegative(),
  signupsRecovered: z.number().int().nonnegative(),
  signupFailuresPending: z.number().int().nonnegative(),
  activitiesProcessed: z.number().int().nonnegative(),
  signupBacklogPossible: z.boolean(),
  signupCursorLagMs: z.number().nullable(),
  lastError: z.string().nullable(),
});

export type AntifraudPollerHealth = z.infer<typeof pollerHealthSchema>;

const notificationRoutesSchema = z.object({
  routes: z.array(
    z.object({
      label: z.string(),
      purpose: z.string(),
      eventFamilies: z.array(z.string()),
      configured: z.boolean(),
    }),
  ),
});

export type AntifraudNotificationRoutes = z.infer<
  typeof notificationRoutesSchema
>;

const overviewSessionSchema = z.object({
  session_id: z.string().uuid(),
  case_id: z.string().uuid(),
  user_id: z.string(),
  username: z.string().nullable(),
  status: z.string(),
  started_at: z.string(),
  ends_at: z.string(),
  ended_at: z.string().nullable(),
  current_score: z.number(),
  peak_score: z.number(),
  event_count: z.number(),
  case_status: z.string(),
  severity: z.string(),
});

/**
 * The service degrades per section (`Promise.allSettled` upstream): a failed
 * aggregate arrives as `null` instead of failing the whole overview. Nulls
 * collapse to zero-values here so consumers keep rendering; the service's
 * additive `degraded` map says which sections were affected.
 */
const degradedCount = z
  .number()
  .int()
  .nonnegative()
  .nullish()
  .transform((value) => value ?? 0);

const monitorOverviewSchema = z.object({
  signupReviewsLeft: degradedCount,
  fiatReviewsLeft: degradedCount,
  activeDomainBlacklist: degradedCount,
  blockedIpCatches: degradedCount,
  recentSessions: z
    .array(overviewSessionSchema)
    .max(40)
    .nullish()
    .transform((value) => value ?? []),
  /**
   * Both fiat legs come from the same assessment scope as
   * `/antifraud/fiat-deposits`, so the KPI reconciles with that page. Absent
   * while a monitor build without the split may still be serving, and null
   * when that aggregate degraded.
   */
  fiat: z
    .object({
      legitimateLifetimeCents: z.number().nonnegative(),
      fraudulentLifetimeCents: z.number().nonnegative(),
      legitimateLast24HoursCents: z.number().nonnegative(),
      fraudulentLast24HoursCents: z.number().nonnegative(),
      /**
       * Deposits already refunded. They are excluded from both legs above, so
       * this is separate money, never a subset of the fraud number. Optional
       * while a monitor build without the refunded leg may still be serving.
       */
      refundedLifetimeCents: z.number().nonnegative().optional(),
      fraudulentRefundedLifetimeCents: z.number().nonnegative().optional(),
      days: z
        .array(
          z.object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            legitimateCents: z.number().nonnegative(),
            fraudulentCents: z.number().nonnegative(),
          }),
        )
        .max(30),
    })
    .nullish(),
  // Deliberately NOT zero-filled: null must stay null so the overview merge
  // falls back to the mirror-computed fraud numbers instead of overwriting
  // them with zeros when the service's fiat aggregate is degraded.
  fraudulentFiat: z
    .object({
      lifetimeCents: z.number().nonnegative(),
      last24HoursCents: z.number().nonnegative(),
      days: z
        .array(
          z.object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            amountCents: z.number().nonnegative(),
          }),
        )
        .max(30),
    })
    .nullish()
    .transform((value) => value ?? null),
  degraded: z.record(z.string(), z.boolean()).optional(),
});

export type AntifraudMonitorOverview = z.infer<typeof monitorOverviewSchema>;

/** Read/ticket token — everything except the decision write. */
function readToken(): { baseUrl?: string; token?: string } {
  return {
    baseUrl: process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, ""),
    token: process.env.ANTIFRAUD_MONITOR_API_TOKEN,
  };
}

export const getAntifraudRuntimeConfig = cache(async (): Promise<{
  configured: boolean;
  data: AntifraudRuntimeConfig | null;
  error: boolean;
}> => {
  const { baseUrl, token } = readToken();
  if (!baseUrl || !token) {
    return { configured: false, data: null, error: false };
  }

  try {
    const response = await fetch(`${baseUrl}/v1/operations/config`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Monitor API returned ${response.status}`);
    }
    const payload = z
      .object({ data: runtimeConfigSchema })
      .parse(await response.json());
    return { configured: true, data: payload.data, error: false };
  } catch {
    console.error("[antifraud-monitor] runtime config request failed");
    return { configured: true, data: null, error: true };
  }
});

export const getAntifraudNotificationRoutes = cache(async (): Promise<{
  configured: boolean;
  data: AntifraudNotificationRoutes | null;
  error: boolean;
}> => {
  const { baseUrl, token } = readToken();
  if (!baseUrl || !token) {
    return { configured: false, data: null, error: false };
  }

  try {
    const response = await fetch(`${baseUrl}/v1/operations/notifications`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Monitor API returned ${response.status}`);
    }
    const payload = z
      .object({ data: notificationRoutesSchema })
      .parse(await response.json());
    return { configured: true, data: payload.data, error: false };
  } catch {
    console.error("[antifraud-monitor] notification routes request failed");
    return { configured: true, data: null, error: true };
  }
});

export const getAntifraudPollerHealth = cache(async (): Promise<{
  configured: boolean;
  data: AntifraudPollerHealth | null;
  error: boolean;
}> => {
  const { baseUrl, token } = readToken();
  if (!baseUrl || !token) {
    return { configured: false, data: null, error: false };
  }
  try {
    const response = await fetch(`${baseUrl}/v1/operations/poller`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Monitor API returned ${response.status}`);
    const payload = z
      .object({ data: pollerHealthSchema })
      .parse(await response.json());
    return { configured: true, data: payload.data, error: false };
  } catch {
    console.error("[antifraud-monitor] poller health request failed");
    return { configured: true, data: null, error: true };
  }
});

export const getAntifraudMonitorOverview = cache(async (): Promise<{
  configured: boolean;
  data: AntifraudMonitorOverview | null;
  error: boolean;
}> => {
  const { baseUrl, token } = readToken();
  if (!baseUrl || !token) {
    return { configured: false, data: null, error: false };
  }

  try {
    const response = await fetch(`${baseUrl}/v1/overview`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "x-antifraud-excluded-users": JSON.stringify(
          await getExcludedUserIdsStrict(),
        ),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Monitor API returned ${response.status}`);
    }
    const payload = z
      .object({ data: monitorOverviewSchema })
      .parse(await response.json());
    return { configured: true, data: payload.data, error: false };
  } catch (error) {
    console.error("[antifraud-monitor] overview request failed:", error);
    return { configured: true, data: null, error: true };
  }
});

export async function getAntifraudScoringConfig(): Promise<{
  configured: boolean;
  data: AntifraudScoringConfig | null;
  error: boolean;
}> {
  const { baseUrl, token } = readToken();
  if (!baseUrl || !token) {
    return { configured: false, data: null, error: false };
  }

  try {
    const response = await fetch(`${baseUrl}/v1/scoring`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Monitor API returned ${response.status}`);
    }
    const payload = z.object({ data: scoringConfigSchema }).parse(
      await response.json(),
    );
    return { configured: true, data: payload.data, error: false };
  } catch (error) {
    console.error("[antifraud-monitor] scoring config failed:", error);
    return { configured: true, data: null, error: true };
  }
}

export async function getAntifraudEventCatalog(): Promise<{
  configured: boolean;
  data: AntifraudMonitorEvent[];
  error: boolean;
}> {
  const { baseUrl, token } = readToken();
  if (!baseUrl || !token) {
    return { configured: false, data: [], error: false };
  }
  try {
    const response = await fetch(`${baseUrl}/v1/events`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Monitor API returned ${response.status}`);
    const payload = z
      .object({ data: z.array(monitorEventSchema) })
      .parse(await response.json());
    return {
      configured: true,
      data: payload.data.filter(
        (event) => !isNonActionableRewardEnrollmentSignal(event.key),
      ),
      error: false,
    };
  } catch (error) {
    console.error("[antifraud-monitor] event catalog failed:", error);
    return { configured: true, data: [], error: true };
  }
}

export type AntifraudRuleMutation = {
  name: string;
  description: string;
  enabled: boolean;
  sequence: string[];
  excludeBefore: string[];
  windowSeconds: number;
  scoreDelta: number;
  actionType: "manual_review";
  idempotencyKey: string;
  actorId: string;
  actorUsername?: string;
};

async function mutateAntifraudRule(
  path: string,
  method: "POST" | "PUT",
  input: AntifraudRuleMutation,
): Promise<AntifraudBehaviorRule> {
  const baseUrl = process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, "");
  const token = process.env.ANTIFRAUD_MONITOR_API_ADMIN_TOKEN;
  if (!baseUrl || !token) {
    throw new Error("Antifraud flow editing is not configured.");
  }
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input),
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    throw new Error(
      "The monitor service did not respond. The flow was not changed.",
    );
  }

  const payload = await response.json().catch(() => null);
  if (response.status === 404) throw new Error("That flow no longer exists.");
  if (response.status === 409) {
    throw new Error("That retry key was already used for another flow change.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("The monitor service rejected the flow-edit credentials.");
  }
  if (response.status === 429) {
    throw new Error("Too many flow edits right now. Try again in a minute.");
  }
  if (response.status === 400) {
    const unavailable = z
      .object({
        error: z.enum(["unknown_events", "events_not_live"]),
        events: z.array(z.string()),
      })
      .safeParse(payload);
    if (unavailable.success) {
      const reason =
        unavailable.data.error === "events_not_live"
          ? "not live yet"
          : "not in the event catalog";
      throw new Error(
        `This flow cannot be enabled: ${unavailable.data.events.join(", ")} ${reason}.`,
      );
    }
    throw new Error("The monitor service rejected the flow configuration.");
  }
  if (!response.ok) {
    throw new Error("The monitor service could not save that flow.");
  }
  const parsed = z
    .object({ data: behaviorRuleSchema })
    .safeParse(payload);
  if (!parsed.success) {
    throw new Error("The monitor service returned an unexpected response.");
  }
  return parsed.data.data;
}

export function createAntifraudRule(
  input: AntifraudRuleMutation,
): Promise<AntifraudBehaviorRule> {
  return mutateAntifraudRule("/v1/rules", "POST", input);
}

export function updateAntifraudRule(
  ruleId: string,
  input: AntifraudRuleMutation,
): Promise<AntifraudBehaviorRule> {
  return mutateAntifraudRule(
    `/v1/rules/${encodeURIComponent(ruleId)}`,
    "PUT",
    input,
  );
}

export async function updateAntifraudScoreWeight(input: {
  key: string;
  points: number;
  idempotencyKey: string;
  actorId: string;
  actorUsername?: string;
}): Promise<{ idempotent: boolean }> {
  const baseUrl = process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, "");
  const token = process.env.ANTIFRAUD_MONITOR_API_ADMIN_TOKEN;
  if (!baseUrl || !token) {
    throw new Error("Antifraud score editing is not configured.");
  }

  let response: Response;
  try {
    response = await fetch(
      `${baseUrl}/v1/scoring/${encodeURIComponent(input.key)}`,
      {
        method: "PUT",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          points: input.points,
          idempotencyKey: input.idempotencyKey,
          actorId: input.actorId,
          actorUsername: input.actorUsername,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
  } catch {
    throw new Error(
      "The monitor service did not respond. The point value was not changed.",
    );
  }

  if (response.status === 404) throw new Error("That score check no longer exists.");
  if (response.status === 409) {
    throw new Error("That retry key was already used for another score change.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("The monitor service rejected the score-edit credentials.");
  }
  if (response.status === 429) {
    throw new Error("Too many score edits right now. Try again in a minute.");
  }
  if (!response.ok) {
    throw new Error("The monitor service could not save that point value.");
  }
  const payload = z.object({
    data: z.object({
      idempotent: z.boolean(),
    }),
  }).safeParse(await response.json().catch(() => null));
  if (!payload.success) {
    throw new Error("The monitor service returned an unexpected response.");
  }
  return { idempotent: payload.data.data.idempotent };
}

/** Keep monitor-case state aligned with decisions made in Account Review. */
export async function submitAntifraudCaseDecision(input: {
  caseId: string;
  decision: "in_review" | "resolved_safe" | "resolved_fraud";
  reason: string;
  idempotencyKey: string;
  actorId: string;
  actorUsername?: string;
}): Promise<{ idempotent: boolean }> {
  const baseUrl = process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, "");
  const token = process.env.ANTIFRAUD_MONITOR_API_ADMIN_TOKEN;
  if (!baseUrl) {
    throw new Error("The antifraud monitor service is not configured.");
  }
  if (!token) {
    throw new Error(
      "Case decisions are disabled: the monitor service's admin token is not configured.",
    );
  }

  let response: Response;
  try {
    response = await fetch(
      `${baseUrl}/v1/cases/${encodeURIComponent(input.caseId)}/decision`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          decision: input.decision,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          actorId: input.actorId,
          actorUsername: input.actorUsername,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
  } catch (error) {
    console.error("[antifraud-monitor] decision request failed:", error);
    throw new Error(
      "The monitor service did not respond. The decision was not recorded — try again.",
    );
  }

  if (response.status === 404) throw new Error("That case no longer exists.");
  if (response.status === 409) throw new Error("This case is already resolved.");
  if (response.status === 401 || response.status === 403) {
    throw new Error("The monitor service rejected the decision credentials.");
  }
  if (response.status === 429) {
    throw new Error("Too many decisions right now — try again in a minute.");
  }
  if (!response.ok) {
    console.error(
      "[antifraud-monitor] decision returned",
      response.status,
      await response.text().catch(() => ""),
    );
    throw new Error("The monitor service could not record that decision.");
  }

  const payload = z
    .object({ success: z.literal(true), idempotent: z.boolean().optional() })
    .safeParse(await response.json().catch(() => null));
  if (!payload.success) {
    throw new Error("The monitor service returned an unexpected response.");
  }
  return { idempotent: payload.data.idempotent === true };
}
