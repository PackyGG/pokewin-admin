import "server-only";

import { z } from "zod";

const UPSTREAM_TIMEOUT_MS = 12_000;

function readConfig(admin = false): { baseUrl?: string; token?: string } {
  return {
    baseUrl: process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, ""),
    token: admin
      ? process.env.ANTIFRAUD_MONITOR_API_ADMIN_TOKEN
      : process.env.ANTIFRAUD_MONITOR_API_TOKEN,
  };
}

async function request(
  path: string,
  options: RequestInit & { admin?: boolean } = {},
): Promise<Response> {
  const { baseUrl, token } = readConfig(options.admin);
  if (!baseUrl || !token) {
    throw new Error("The antifraud monitor service is not configured.");
  }
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
}

const signalSchema = z.object({
  key: z.string(),
  title: z.string(),
  detail: z.string(),
  points: z.number(),
  value: z.number(),
  threshold: z.number(),
  category: z.enum(["network", "affiliate", "behavior"]),
});

const snapshotSchema = z.object({
  id: z.string().uuid(),
  root_user_id: z.string(),
  network_key: z.string(),
  status: z.enum(["ready", "partial", "failed"]),
  raw_score: z.number(),
  score: z.number(),
  severity: z.string(),
  signals: z.array(signalSchema),
  node_count: z.number(),
  edge_count: z.number(),
  account_count: z.number(),
  ip_count: z.number(),
  device_count: z.number(),
  truncated: z.boolean(),
  scanned_at: z.string(),
  expires_at: z.string(),
});

const graphNodeSchema = z.object({
  key: z.string(),
  type: z.enum(["account", "ip", "device"]),
  user_id: z.string().nullable(),
  label: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  degree: z.number(),
});

const graphEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  type: z.enum(["shared_ip", "shared_device"]),
});

const paginationSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  pages: z.number(),
});

const graphSchema = z.object({
  data: z.object({
    snapshot: snapshotSchema,
    nodes: z.array(graphNodeSchema),
    edges: z.array(graphEdgeSchema),
  }),
  pagination: paginationSchema,
});

const creatorIdentitySchema = z.object({
  id: z.string(),
  username: z.string().nullable(),
  display_username: z.string().nullable(),
  email: z.string().nullable(),
  image: z.string().nullable(),
  country_code: z.string().nullable(),
}).nullable();

const creatorAssessmentSchema = z.object({
  creator_user_id: z.string(),
  window_key: z.enum(["7d", "30d", "90d", "lifetime"]),
  codes: z.array(z.string()),
  raw_score: z.number(),
  score: z.number(),
  severity: z.string(),
  breakdown: z.object({
    network: z.number(),
    affiliate: z.number(),
    behavior: z.number(),
  }),
  signals: z.array(signalSchema),
  metrics: z.record(z.string(), z.unknown()),
  partial: z.boolean(),
  assessed_at: z.string(),
  creator: creatorIdentitySchema,
});

const analysisRuleSchema = z.object({
  key: z.string(),
  category: z.enum(["network", "creator"]),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  points: z.number(),
  threshold: z.number(),
  updated_by: z.string().nullable(),
  updated_at: z.string(),
});

export type AntifraudNetworkSnapshot = z.infer<typeof snapshotSchema>;
export type AntifraudGraphNode = z.infer<typeof graphNodeSchema>;
export type AntifraudGraphEdge = z.infer<typeof graphEdgeSchema>;
export type CreatorFraudAssessment = z.infer<typeof creatorAssessmentSchema>;
export type AntifraudAnalysisRule = z.infer<typeof analysisRuleSchema>;
export type CreatorWindow = "7d" | "30d" | "90d" | "lifetime";

export async function getAccountNetwork(userId: string): Promise<{
  configured: boolean;
  data: AntifraudNetworkSnapshot | null;
  queued: boolean;
  jobId: string | null;
  notFound: boolean;
  error: boolean;
}> {
  if (!readConfig().baseUrl || !readConfig().token) {
    return {
      configured: false,
      data: null,
      queued: false,
      jobId: null,
      notFound: false,
      error: false,
    };
  }
  try {
    const response = await request(
      `/v1/networks/accounts/${encodeURIComponent(userId)}`,
    );
    if (response.status === 404) {
      return {
        configured: true,
        data: null,
        queued: false,
        jobId: null,
        notFound: true,
        error: false,
      };
    }
    const payload = z.object({
      data: snapshotSchema.nullable(),
      jobId: z.string().uuid().optional(),
      status: z.string().optional(),
    }).parse(await response.json());
    return {
      configured: true,
      data: payload.data,
      queued: response.status === 202,
      jobId: payload.jobId ?? null,
      notFound: false,
      error: false,
    };
  } catch (error) {
    console.error("[antifraud-networks] account network failed:", error);
    return {
      configured: true,
      data: null,
      queued: false,
      jobId: null,
      notFound: false,
      error: true,
    };
  }
}

export async function getNetworkGraph(
  snapshotId: string,
  page = 1,
): Promise<z.infer<typeof graphSchema> | null> {
  try {
    const response = await request(
      `/v1/networks/${encodeURIComponent(snapshotId)}/graph?page=${page}&limit=500`,
    );
    if (!response.ok) throw new Error(`graph returned ${response.status}`);
    return graphSchema.parse(await response.json());
  } catch (error) {
    console.error("[antifraud-networks] graph failed:", error);
    return null;
  }
}

export async function listCreatorFraud(input: {
  window: CreatorWindow;
  page: number;
  search?: string;
}): Promise<{
  configured: boolean;
  data: CreatorFraudAssessment[];
  pagination: z.infer<typeof paginationSchema> | null;
  error: boolean;
}> {
  if (!readConfig().baseUrl || !readConfig().token) {
    return { configured: false, data: [], pagination: null, error: false };
  }
  try {
    const params = new URLSearchParams({
      window: input.window,
      page: String(input.page),
      limit: "50",
    });
    if (input.search) params.set("search", input.search);
    const response = await request(`/v1/creator-fraud?${params}`);
    if (!response.ok) throw new Error(`creator list returned ${response.status}`);
    const payload = z.object({
      data: z.array(creatorAssessmentSchema),
      pagination: paginationSchema,
    }).parse(await response.json());
    return { configured: true, ...payload, error: false };
  } catch (error) {
    console.error("[creator-fraud] list failed:", error);
    return { configured: true, data: [], pagination: null, error: true };
  }
}

export async function getCreatorFraud(
  creatorId: string,
  window: CreatorWindow,
): Promise<{
  configured: boolean;
  data: CreatorFraudAssessment | null;
  queued: boolean;
  error: boolean;
}> {
  if (!readConfig().baseUrl || !readConfig().token) {
    return { configured: false, data: null, queued: false, error: false };
  }
  try {
    const response = await request(
      `/v1/creator-fraud/${encodeURIComponent(creatorId)}?window=${window}`,
    );
    const payload = z.object({
      data: creatorAssessmentSchema.nullable(),
      status: z.string().optional(),
    }).parse(await response.json());
    return {
      configured: true,
      data: payload.data,
      queued: response.status === 202,
      error: false,
    };
  } catch (error) {
    console.error("[creator-fraud] detail failed:", error);
    return { configured: true, data: null, queued: false, error: true };
  }
}

export async function listAnalysisRules(): Promise<{
  configured: boolean;
  data: AntifraudAnalysisRule[];
  error: boolean;
}> {
  if (!readConfig().baseUrl || !readConfig().token) {
    return { configured: false, data: [], error: false };
  }
  try {
    const response = await request("/v1/analysis-rules");
    if (!response.ok) throw new Error(`rules returned ${response.status}`);
    const payload = z.object({
      data: z.array(analysisRuleSchema),
    }).parse(await response.json());
    return { configured: true, data: payload.data, error: false };
  } catch (error) {
    console.error("[antifraud-rules] list failed:", error);
    return { configured: true, data: [], error: true };
  }
}

export async function requestAccountNetworkRescan(input: {
  userId: string;
  actorId: string;
  actorUsername?: string;
}): Promise<string> {
  const response = await request(
    `/v1/networks/accounts/${encodeURIComponent(input.userId)}/rescan`,
    {
      method: "POST",
      admin: true,
      body: JSON.stringify({
        actorId: input.actorId,
        actorUsername: input.actorUsername,
      }),
    },
  );
  if (!response.ok) throw new Error("The account network scan could not be queued.");
  return z.object({
    data: z.object({ jobId: z.string().uuid() }),
  }).parse(await response.json()).data.jobId;
}

export async function requestCreatorFraudRescan(input: {
  creatorId: string;
  window: CreatorWindow;
  actorId: string;
  actorUsername?: string;
}): Promise<string> {
  const response = await request(
    `/v1/creator-fraud/${encodeURIComponent(input.creatorId)}/rescan`,
    {
      method: "POST",
      admin: true,
      body: JSON.stringify({
        window: input.window,
        actorId: input.actorId,
        actorUsername: input.actorUsername,
      }),
    },
  );
  if (!response.ok) throw new Error("The creator assessment could not be queued.");
  return z.object({
    data: z.object({ jobId: z.string().uuid() }),
  }).parse(await response.json()).data.jobId;
}

export async function createNetworkCase(input: {
  snapshotId: string;
  reason: string;
  idempotencyKey: string;
  actorId: string;
  actorUsername?: string;
}): Promise<string> {
  const response = await request("/v1/network-cases", {
    method: "POST",
    admin: true,
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error("The network case could not be opened.");
  return z.object({
    data: z.object({ caseId: z.string().uuid() }),
  }).parse(await response.json()).data.caseId;
}

export async function revealNetworkIp(input: {
  snapshotId: string;
  nodeKey: string;
}): Promise<string> {
  const response = await request(
    `/v1/networks/${encodeURIComponent(input.snapshotId)}/nodes/${encodeURIComponent(input.nodeKey)}/reveal`,
    { admin: true },
  );
  if (!response.ok) throw new Error("The exact IP could not be revealed.");
  return z.object({
    data: z.object({ value: z.string() }),
  }).parse(await response.json()).data.value;
}

export async function updateAnalysisRule(input: {
  key: string;
  enabled: boolean;
  points: number;
  threshold: number;
  actorId: string;
  actorUsername?: string;
}): Promise<void> {
  const response = await request(
    `/v1/analysis-rules/${encodeURIComponent(input.key)}`,
    {
      method: "PUT",
      admin: true,
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) throw new Error("The analysis rule could not be saved.");
}
