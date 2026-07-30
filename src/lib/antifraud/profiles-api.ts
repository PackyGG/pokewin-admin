import "server-only";

import { z } from "zod";

const profileSummarySchema = z.object({
  userId: z.string(),
  username: z.string().nullable(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  countryCode: z.string().nullable(),
  accountCreatedAt: z.string(),
  score: z.number().int().min(0).max(100),
  rawScore: z.number().int(),
  severity: z.string(),
  outcome: z.string(),
  completeness: z.string(),
  confidence: z.number().int().min(0).max(100),
  policyMatches: z.unknown(),
  assessedAt: z.string(),
  updatedAt: z.string(),
});
const paginationSchema = z.object({
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
  pages: z.number().int(),
});
export type AntifraudProfileSummary = z.infer<typeof profileSummarySchema>;

const bannedUserSchema = z.object({
  userId: z.string(),
  username: z.string().nullable(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  countryCode: z.string().nullable(),
  banReason: z.string().nullable(),
  bannedAt: z.string().nullable(),
  accountCreatedAt: z.string(),
});
export type AntifraudBannedUser = z.infer<typeof bannedUserSchema>;

const profileDetailSchema = z.object({
  profile: z.object({
    userId: z.string(),
    username: z.string().nullable(),
    email: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    signupIp: z.string().nullable(),
    country: z.string().nullable(),
    countryCode: z.string().nullable(),
    state: z.string().nullable(),
    city: z.string().nullable(),
    accountCreatedAt: z.string(),
    assessmentVersion: z.string(),
    rawScore: z.number().int(),
    score: z.number().int().min(0).max(100),
    severity: z.string(),
    outcome: z.string(),
    completeness: z.string(),
    confidence: z.number().int().min(0).max(100),
    providerStatus: z.unknown(),
    policyMatches: z.unknown(),
    recommendedActions: z.unknown(),
    explanation: z.unknown(),
    assessedAt: z.string(),
    isBanned: z.boolean().nullable(),
    bannedReason: z.string().nullable(),
    bannedAt: z.string().nullable(),
    isLocked: z.boolean().nullable(),
    lockedReason: z.string().nullable(),
  }),
  assessments: z.array(z.record(z.string(), z.unknown())),
  providers: z.array(z.record(z.string(), z.unknown())),
  relationships: z.array(z.record(z.string(), z.unknown())),
  blocklistMatches: z.array(z.record(z.string(), z.unknown())),
});
export type AntifraudProfileDetail = z.infer<typeof profileDetailSchema>;

const TIMEOUT_MS = 8_000;

function connection() {
  const baseUrl = process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, "");
  const token = process.env.ANTIFRAUD_MONITOR_API_TOKEN;
  return baseUrl && token ? { baseUrl, token } : null;
}

async function get(path: string): Promise<Response> {
  const configured = connection();
  if (!configured) throw new Error("not_configured");
  return fetch(`${configured.baseUrl}${path}`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${configured.token}`,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export async function listAntifraudProfiles(input: {
  page?: number;
  search?: string;
  outcome?: string;
  blocklist?: string;
}) {
  if (!connection()) {
    return {
      configured: false,
      error: false,
      data: [] as AntifraudProfileSummary[],
      pagination: { page: 1, limit: 50, total: 0, pages: 1 },
    };
  }
  try {
    const params = new URLSearchParams({
      page: String(input.page ?? 1),
      limit: "50",
    });
    if (input.search) params.set("search", input.search);
    if (input.outcome) params.set("outcome", input.outcome);
    if (input.blocklist) params.set("blocklist", input.blocklist);
    const response = await get(`/v1/profiles?${params}`);
    if (!response.ok) throw new Error("request_failed");
    const payload = z.object({
      data: z.array(profileSummarySchema),
      pagination: paginationSchema,
    }).parse(await response.json());
    return { configured: true, error: false, ...payload };
  } catch (error) {
    console.error("[antifraud] profiles read failed:", error);
    return {
      configured: true,
      error: true,
      data: [] as AntifraudProfileSummary[],
      pagination: { page: 1, limit: 50, total: 0, pages: 1 },
    };
  }
}

export async function getAntifraudProfile(userId: string): Promise<{
  configured: boolean;
  error: boolean;
  notFound: boolean;
  data: AntifraudProfileDetail | null;
}> {
  if (!connection()) {
    return { configured: false, error: false, notFound: false, data: null };
  }
  try {
    const response = await get(`/v1/profiles/${encodeURIComponent(userId)}`);
    if (response.status === 404) {
      return { configured: true, error: false, notFound: true, data: null };
    }
    if (!response.ok) throw new Error("request_failed");
    const payload = z.object({ data: profileDetailSchema })
      .parse(await response.json());
    return {
      configured: true,
      error: false,
      notFound: false,
      data: payload.data,
    };
  } catch (error) {
    console.error("[antifraud] profile detail read failed:", error);
    return { configured: true, error: true, notFound: false, data: null };
  }
}

export async function listAntifraudBannedUsers(input: {
  page?: number;
  search?: string;
}) {
  if (!connection()) {
    return {
      configured: false,
      error: false,
      data: [] as AntifraudBannedUser[],
      pagination: { page: 1, limit: 50, total: 0, pages: 1 },
    };
  }
  try {
    const params = new URLSearchParams({
      page: String(input.page ?? 1),
      limit: "50",
    });
    if (input.search) params.set("search", input.search);
    const response = await get(`/v1/banned-users?${params}`);
    if (!response.ok) throw new Error("request_failed");
    const payload = z.object({
      data: z.array(bannedUserSchema),
      pagination: paginationSchema,
    }).parse(await response.json());
    return { configured: true, error: false, ...payload };
  } catch (error) {
    console.error("[antifraud] banned users read failed:", error);
    return {
      configured: true,
      error: true,
      data: [] as AntifraudBannedUser[],
      pagination: { page: 1, limit: 50, total: 0, pages: 1 },
    };
  }
}
