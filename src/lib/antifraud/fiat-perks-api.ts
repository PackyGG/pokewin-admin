import "server-only";

import { z } from "zod";

import { getExcludedUserIdsStrict } from "@/lib/excluded-users/fetch";
import {
  perkCandidateSchema,
  perkAccessBatchSchema,
  perkGrantSchema,
  perkRunSchema,
  type FiatPerkCandidate,
  type FiatPerkAccessBatch,
  type FiatPerkGrant,
  type FiatPerkRun,
  type FiatPerkProviderName,
  type FiatPerkScope,
} from "./fiat-perks-contract";

/**
 * Dashboard client for the Fiat perk screening service.
 *
 * The monitor owns the screening engine, the review queue and the grant table;
 * this module is the only way the workspace talks to it. Reads degrade to an
 * explicit "unavailable" instead of an empty list — an operator must never read
 * a transport failure as "nobody is waiting for review".
 */

export {
  DEFAULT_MIN_ACCOUNT_AGE_DAYS,
  FIAT_PERK_SCOPES,
  FIAT_PERK_SCOPE_LABELS,
  FIAT_PERK_PROVIDERS,
  MAX_PERK_RUN_ACCOUNTS,
  perkCheckSchema,
} from "./fiat-perks-contract";
export type {
  FiatPerkCandidate,
  FiatPerkAccessBatch,
  FiatPerkCheck,
  FiatPerkEvidence,
  FiatPerkGrant,
  FiatPerkRun,
  FiatPerkScope,
} from "./fiat-perks-contract";

export type PerkReadResult<T> = {
  configured: boolean;
  error: boolean;
  data: T;
};

const TIMEOUT_MS = 10_000;
/** A sweep only ever gets acknowledged here; the work continues server-side. */
const RUN_START_TIMEOUT_MS = 20_000;

function connection(admin: boolean): { baseUrl: string; token: string } | null {
  const baseUrl = process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, "");
  const token = admin
    ? process.env.ANTIFRAUD_MONITOR_API_ADMIN_TOKEN
    : process.env.ANTIFRAUD_MONITOR_API_TOKEN;
  return baseUrl && token ? { baseUrl, token } : null;
}

export function fiatPerksConfigured(): boolean {
  return connection(false) !== null;
}

async function request(
  path: string,
  init: RequestInit = {},
  options: { admin?: boolean; timeoutMs?: number } = {},
): Promise<Response> {
  const configured = connection(options.admin ?? false);
  if (!configured) {
    throw new Error("The Antifraud monitor API is not configured.");
  }
  try {
    return await fetch(`${configured.baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${configured.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    });
  } catch {
    throw new Error("The Antifraud monitor service did not respond.");
  }
}

async function read<T>(
  path: string,
  schema: z.ZodType<T>,
  fallback: T,
  label: string,
): Promise<PerkReadResult<T>> {
  if (!connection(false)) {
    return { configured: false, error: false, data: fallback };
  }
  try {
    const response = await request(path);
    if (!response.ok) throw new Error(`request_failed_${response.status}`);
    const payload = z
      .object({ data: schema })
      .parse(await response.json());
    return { configured: true, error: false, data: payload.data };
  } catch (error) {
    console.error(`[antifraud] fiat perk ${label} read failed:`, error);
    return { configured: true, error: true, data: fallback };
  }
}

export function listFiatPerkRuns(limit = 20) {
  return read(
    `/v1/fiat-perks/runs?limit=${limit}`,
    z.array(perkRunSchema),
    [] as FiatPerkRun[],
    "runs",
  );
}

export function getFiatPerkRun(runId: string) {
  return read(
    `/v1/fiat-perks/runs/${encodeURIComponent(runId)}`,
    perkRunSchema,
    null as FiatPerkRun | null,
    "run",
  );
}

export function listFiatPerkCandidates(input: {
  runId: string;
  verdict?: "pass" | "review" | "fail";
  decision?: "pending" | "approved" | "declined";
  accessStatus?: "none" | "unknown" | "syncing" | "enabled" | "disabled" | "error";
  countryCode?: string;
  minRiskScore?: number;
  maxRiskScore?: number;
  maxMindStatus?: "success" | "failed" | "skipped" | "not_checked";
  minMaxMindRisk?: number;
  maxMaxMindRisk?: number;
  maxMindDisposition?: "accept" | "reject" | "manual_review" | "test";
  providerName?: FiatPerkProviderName;
  providerStatus?: "success" | "skipped" | "failed" | "missing";
  providerCompleteness?: "complete" | "partial" | "unknown";
  minProviderScore?: number;
  maxProviderScore?: number;
  providerSignal?: string;
  providerChecked?: boolean;
  minAccountAgeDays?: number;
  maxAccountAgeDays?: number;
  blockingReason?: string;
  minCryptoDepositUsd?: number;
  minFiatDepositUsd?: number;
  minWagerUsd?: number;
  maxRewardUsd?: number;
  search?: string;
  limit?: number;
}) {
  const params = new URLSearchParams();
  if (input.verdict) params.set("verdict", input.verdict);
  if (input.decision) params.set("decision", input.decision);
  for (const [key, value] of Object.entries({
    accessStatus: input.accessStatus,
    countryCode: input.countryCode,
    minRiskScore: input.minRiskScore,
    maxRiskScore: input.maxRiskScore,
    maxMindStatus: input.maxMindStatus,
    minMaxMindRisk: input.minMaxMindRisk,
    maxMaxMindRisk: input.maxMaxMindRisk,
    maxMindDisposition: input.maxMindDisposition,
    providerName: input.providerName,
    providerStatus: input.providerStatus,
    providerCompleteness: input.providerCompleteness,
    minProviderScore: input.minProviderScore,
    maxProviderScore: input.maxProviderScore,
    providerSignal: input.providerSignal,
    providerChecked: input.providerChecked,
    minAccountAgeDays: input.minAccountAgeDays,
    maxAccountAgeDays: input.maxAccountAgeDays,
    blockingReason: input.blockingReason,
    minCryptoDepositUsd: input.minCryptoDepositUsd,
    minFiatDepositUsd: input.minFiatDepositUsd,
    minWagerUsd: input.minWagerUsd,
    maxRewardUsd: input.maxRewardUsd,
  })) {
    if (value !== undefined) params.set(key, String(value));
  }
  if (input.search) params.set("search", input.search);
  params.set("limit", String(input.limit ?? 200));
  return read(
    `/v1/fiat-perks/runs/${encodeURIComponent(input.runId)}/candidates?${params}`,
    z.array(perkCandidateSchema),
    [] as FiatPerkCandidate[],
    "candidates",
  );
}

export function listFiatPerkGrants(input: {
  status?: "granted" | "revoked";
  search?: string;
  limit?: number;
} = {}) {
  const params = new URLSearchParams();
  if (input.status) params.set("status", input.status);
  if (input.search) params.set("search", input.search);
  params.set("limit", String(input.limit ?? 200));
  return read(
    `/v1/fiat-perks/grants?${params}`,
    z.array(perkGrantSchema),
    [] as FiatPerkGrant[],
    "grants",
  );
}

type MutationActor = {
  idempotencyKey: string;
  actorId: string;
  actorUsername?: string | null;
};

async function mutationError(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as
    | { error?: unknown; message?: unknown }
    | null;
  const message = typeof payload?.message === "string" ? payload.message : null;
  if (response.status === 400) {
    return message ?? "The screening request is invalid.";
  }
  if (response.status === 404) {
    return message ?? "That screened account no longer exists.";
  }
  if (response.status === 409) {
    return message ?? "That decision was already recorded.";
  }
  if (response.status === 401 || response.status === 403) {
    return "The monitor rejected the workspace credentials.";
  }
  return message ?? "The Antifraud monitor could not complete the change.";
}

export async function startFiatPerkRun(
  input: MutationActor & {
    scope: FiatPerkScope;
    minAccountAgeDays: number;
    limit: number;
    countryCode: string | null;
    activeWithinDays: number;
    excludeGranted: boolean;
    selectedUserIds: string[];
  },
): Promise<FiatPerkRun> {
  // Accounts the panel already treats as invisible must never be screened into
  // an allowlist — the exclusion list is authoritative, so a read failure here
  // aborts the run instead of silently widening its scope.
  const excludedUserIds = await getExcludedUserIdsStrict();
  const response = await request(
    "/v1/fiat-perks/runs",
    {
      method: "POST",
      body: JSON.stringify({
        scope: input.scope,
        minAccountAgeDays: input.minAccountAgeDays,
        limit: input.limit,
        countryCode: input.countryCode,
        activeWithinDays: input.activeWithinDays,
        excludeGranted: input.excludeGranted,
        selectedUserIds: input.selectedUserIds,
        excludedUserIds,
        idempotencyKey: input.idempotencyKey,
        actorId: input.actorId,
        actorUsername: input.actorUsername ?? undefined,
      }),
    },
    { admin: true, timeoutMs: RUN_START_TIMEOUT_MS },
  );
  if (!response.ok) throw new Error(await mutationError(response));
  return z.object({ data: perkRunSchema }).parse(await response.json()).data;
}

export function listFiatPerkAccessBatches(limit = 20) {
  return read(
    `/v1/fiat-perks/access-batches?limit=${limit}`,
    z.array(perkAccessBatchSchema),
    [] as FiatPerkAccessBatch[],
    "access batches",
  );
}

export async function createFiatPerkAccessBatch(
  input: MutationActor & {
    action: "enable" | "disable";
    candidateIds?: string[];
    userIds?: string[];
    note: string | null;
    filterSnapshot?: Record<string, unknown>;
  },
): Promise<FiatPerkAccessBatch> {
  const response = await request(
    "/v1/fiat-perks/access-batches",
    {
      method: "POST",
      body: JSON.stringify({
        action: input.action,
        candidateIds: input.candidateIds ?? [],
        userIds: input.userIds ?? [],
        note: input.note ?? undefined,
        filterSnapshot: input.filterSnapshot ?? {},
        idempotencyKey: input.idempotencyKey,
        actorId: input.actorId,
        actorUsername: input.actorUsername ?? undefined,
      }),
    },
    { admin: true, timeoutMs: RUN_START_TIMEOUT_MS },
  );
  if (!response.ok) throw new Error(await mutationError(response));
  return z.object({ data: perkAccessBatchSchema }).parse(await response.json()).data;
}

export async function retryFiatPerkAccessBatch(
  input: MutationActor & { batchId: string },
): Promise<FiatPerkAccessBatch> {
  const response = await request(
    `/v1/fiat-perks/access-batches/${encodeURIComponent(input.batchId)}/retry`,
    {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: input.idempotencyKey,
        actorId: input.actorId,
        actorUsername: input.actorUsername ?? undefined,
      }),
    },
    { admin: true, timeoutMs: RUN_START_TIMEOUT_MS },
  );
  if (!response.ok) throw new Error(await mutationError(response));
  return z.object({ data: perkAccessBatchSchema }).parse(await response.json()).data;
}

export async function decideFiatPerkCandidate(
  input: MutationActor & {
    candidateId: string;
    decision: "approved" | "declined";
    note: string | null;
  },
): Promise<FiatPerkCandidate> {
  const response = await request(
    `/v1/fiat-perks/candidates/${encodeURIComponent(input.candidateId)}/decision`,
    {
      method: "POST",
      body: JSON.stringify({
        decision: input.decision,
        note: input.note ?? undefined,
        idempotencyKey: input.idempotencyKey,
        actorId: input.actorId,
        actorUsername: input.actorUsername ?? undefined,
      }),
    },
    { admin: true, timeoutMs: RUN_START_TIMEOUT_MS },
  );
  if (!response.ok) throw new Error(await mutationError(response));
  return z.object({ data: perkCandidateSchema }).parse(await response.json()).data;
}

export async function revokeFiatPerkGrant(
  input: MutationActor & { userId: string; reason: string },
): Promise<FiatPerkGrant> {
  const response = await request(
    `/v1/fiat-perks/grants/${encodeURIComponent(input.userId)}/revoke`,
    {
      method: "POST",
      body: JSON.stringify({
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        actorId: input.actorId,
        actorUsername: input.actorUsername ?? undefined,
      }),
    },
    { admin: true, timeoutMs: RUN_START_TIMEOUT_MS },
  );
  if (!response.ok) throw new Error(await mutationError(response));
  return z.object({ data: perkGrantSchema }).parse(await response.json()).data;
}
