import "server-only";

import { cache } from "react";
import { z } from "zod";

import { getExcludedUserIdsStrict } from "@/lib/excluded-users/fetch";

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
    supportRecipientIds: z.array(z.string()),
    urgentRecipientIds: z.array(z.string()),
  }),
  providers: z.object({
    fingerprintConfigured: z.boolean(),
    proxycheckConfigured: z.boolean(),
    abstractIpConfigured: z.boolean(),
    abstractEmailConfigured: z.boolean(),
    opportifyConfigured: z.boolean(),
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
    opportify: z.object({
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
    return { configured: true, data: payload.data, error: false };
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

// ─── Case detail ────────────────────────────────────────────────────────
//
// Mirrors `GET /v1/cases/:id` in services/antifraud-monitor/src/server.ts
// field for field. `cases.score` / `peak_score` and every `*_score` on a
// monitor session are `integer`; `provider_checks.score` is `numeric(8,2)`,
// which node-postgres hands back as a STRING — hence `numericLike` rather
// than `z.number()` there.

/** `numeric` arrives as a string over the wire; normalize to a number. */
const numericLike = z
  .union([z.number(), z.string()])
  .nullable()
  .transform((value) => {
    if (value === null) return null;
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  });

const providerSignalSchema = z.object({
  key: z.string(),
  title: z.string(),
  detail: z.string(),
  points: z.number(),
});

const caseRecordSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  status: z.string(),
  severity: z.string(),
  score: z.number(),
  peak_score: z.number(),
  summary: z.string(),
  assigned_to: z.string().nullable(),
  resolution: z.string().nullable(),
  opened_at: z.string(),
  updated_at: z.string(),
  resolved_at: z.string().nullable(),
  subject_type: z.enum(["account", "network"]).default("account"),
  network_key: z.string().nullable().optional(),
  network_snapshot_id: z.string().uuid().nullable().optional(),
  username: z.string().nullable(),
  email: z.string().nullable(),
  signup_ip: z.string().nullable(),
  country_code: z.string().nullable(),
  state: z.string().nullable(),
  city: z.string().nullable(),
  source_created_at: z.string(),
});

const riskEventSchema = z.object({
  id: z.string(),
  session_id: z.string().nullable(),
  event_type: z.string(),
  source: z.string(),
  source_ref: z.string().nullable(),
  score_delta: z.number(),
  score_after: z.number(),
  title: z.string(),
  detail: z.string().nullable(),
  occurred_at: z.string(),
  recorded_at: z.string(),
});

const providerCheckSchema = z.object({
  id: z.string(),
  provider: z.string(),
  request_id: z.string().nullable(),
  status: z.string(),
  score: numericLike,
  signals: z.array(providerSignalSchema).catch([]),
  error_code: z.string().nullable(),
  checked_at: z.string(),
  expires_at: z.string().nullable(),
});

const monitorSessionSchema = z.object({
  id: z.string(),
  status: z.string(),
  started_at: z.string(),
  ends_at: z.string(),
  ended_at: z.string().nullable(),
  initial_score: z.number(),
  current_score: z.number(),
  peak_score: z.number(),
  event_count: z.number(),
});

const staffActionSchema = z.object({
  id: z.string(),
  action_type: z.string(),
  status: z.string(),
  actor_id: z.string(),
  actor_username: z.string().nullable(),
  reason: z.string().nullable(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});

const networkCaseMemberSchema = z.object({
  user_id: z.string(),
  is_root: z.boolean(),
  username: z.string().nullable(),
  avatar_url: z.string().nullable(),
});

const flowMatchSchema = z.object({
  id: z.string().uuid(),
  session_id: z.string().uuid().nullable(),
  rule_key: z.string(),
  rule_name: z.string(),
  score_delta: z.number(),
  action_type: z.string(),
  sequence: z.array(z.string()),
  matched_at: z.string(),
});

const caseDetailSchema = z.object({
  case: caseRecordSchema,
  events: z.array(riskEventSchema),
  providerChecks: z.array(providerCheckSchema),
  sessions: z.array(monitorSessionSchema),
  actions: z.array(staffActionSchema),
  members: z.array(networkCaseMemberSchema).default([]),
  /** Full member count; the service caps the `members` array at 100 rows. */
  membersTotal: z.number().int().nonnegative().optional(),
  matches: z.array(flowMatchSchema).default([]),
});

export type AntifraudMonitorCase = z.infer<typeof caseRecordSchema>;
export type AntifraudMonitorRiskEvent = z.infer<typeof riskEventSchema>;
export type AntifraudMonitorProviderCheck = z.infer<typeof providerCheckSchema>;
export type AntifraudMonitorSession = z.infer<typeof monitorSessionSchema>;
export type AntifraudMonitorStaffAction = z.infer<typeof staffActionSchema>;
export type AntifraudMonitorNetworkMember = z.infer<typeof networkCaseMemberSchema>;
export type AntifraudMonitorFlowMatch = z.infer<typeof flowMatchSchema>;
export type AntifraudMonitorCaseDetail = z.infer<typeof caseDetailSchema>;

/**
 * One monitor case with all of its evidence.
 *
 * Degrades the same way every other monitor read does: an unconfigured
 * service is `configured: false`, an unreachable/malformed one is
 * `error: true`, and a genuinely unknown id is `notFound: true` so the page
 * can render a 404 instead of an "unavailable" state.
 */
export async function getAntifraudCaseDetail(caseId: string): Promise<{
  configured: boolean;
  notFound: boolean;
  data: AntifraudMonitorCaseDetail | null;
  error: boolean;
}> {
  const { baseUrl, token } = readToken();
  if (!baseUrl || !token) {
    return { configured: false, notFound: false, data: null, error: false };
  }

  try {
    const response = await fetch(
      `${baseUrl}/v1/cases/${encodeURIComponent(caseId)}`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
    if (response.status === 404 || response.status === 400) {
      // 400 = the service's own uuid check rejected the id: same user-visible
      // outcome as an unknown case.
      return { configured: true, notFound: true, data: null, error: false };
    }
    if (!response.ok) {
      throw new Error(`Monitor API returned ${response.status}`);
    }
    const payload = z
      .object({ data: caseDetailSchema })
      .parse(await response.json());
    return {
      configured: true,
      notFound: false,
      data: payload.data,
      error: false,
    };
  } catch (error) {
    console.error("[antifraud-monitor] case detail failed:", error);
    return { configured: true, notFound: false, data: null, error: true };
  }
}

// ─── Case decision ──────────────────────────────────────────────────────

export const MONITOR_CASE_DECISIONS = [
  "in_review",
  "resolved_safe",
  "resolved_fraud",
] as const;
export type MonitorCaseDecision = (typeof MONITOR_CASE_DECISIONS)[number];

export const MONITOR_CASE_DECISION_LABELS: Record<MonitorCaseDecision, string> =
  {
    in_review: "Take into review",
    resolved_safe: "Resolve — legitimate",
    resolved_fraud: "Resolve — fraud",
  };

/**
 * `POST /v1/cases/:id/decision` needs the service's ADMIN token — the
 * read token is rejected with 401 by the service's `needsAdminToken` gate.
 * Kept as its own env var on purpose: the read token is already handed to
 * the live-feed proxy, and a write credential should not ride along with it.
 * Server-side only; it is never sent to the browser.
 */
export function antifraudDecisionsConfigured(): boolean {
  return Boolean(
    process.env.ANTIFRAUD_MONITOR_API_URL &&
      process.env.ANTIFRAUD_MONITOR_API_ADMIN_TOKEN,
  );
}

/**
 * Record an analyst's verdict on a monitor case.
 *
 * The idempotency key is generated by the caller and re-sent verbatim on a
 * retry, so a double-click or a retried network error can never produce two
 * `staff_actions` rows — the service answers the second attempt with
 * `{ success: true, idempotent: true }`.
 *
 * The authenticated server action supplies the human actor fields. They never
 * come from the browser, and the monitor service validates and stores them in
 * `staff_actions` so its own trail names the analyst.
 */
export async function submitAntifraudCaseDecision(input: {
  caseId: string;
  decision: MonitorCaseDecision;
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
  if (response.status === 409) {
    throw new Error("This case is already resolved.");
  }
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
