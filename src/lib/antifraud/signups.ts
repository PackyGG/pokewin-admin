import "server-only";

import { z } from "zod";

const signalSchema = z.object({
  key: z.string(),
  title: z.string(),
  detail: z.string(),
  points: z.number(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const signupSchema = z.object({
  user_id: z.string(),
  username: z.string().nullable(),
  email: z.string().nullable(),
  avatar_url: z.string().nullable(),
  signup_ip: z.string().nullable(),
  country: z.string().nullable(),
  country_code: z.string().nullable(),
  state: z.string().nullable(),
  city: z.string().nullable(),
  affiliate_code: z.string().nullable(),
  referred_by: z.string().nullable(),
  source_created_at: z.string(),
  score: z.number(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  signals: z.array(signalSchema),
  assessed_at: z.string().nullable(),
  fingerprint_status: z.string().nullable(),
  fingerprint_score: z.number().nullable(),
  fingerprint_signals: z.array(signalSchema),
  proxycheck_status: z.string().nullable(),
  proxycheck_score: z.number().nullable(),
  proxycheck_signals: z.array(signalSchema),
  case_id: z.string().uuid().nullable(),
  case_status: z.string().nullable(),
  case_severity: z.string().nullable(),
  monitor_status: z.string().nullable(),
  monitor_ends_at: z.string().nullable(),
});

const responseSchema = z.object({
  data: z.array(signupSchema),
  pagination: z.object({
    page: z.number(),
    limit: z.number(),
    total: z.number(),
    pages: z.number(),
  }),
  summary: z.object({
    total: z.number(),
    assessed: z.number(),
    attention: z.number(),
    monitoring: z.number(),
  }),
});

const countResponseSchema = z.object({
  data: z.object({
    count: z.number().int().nonnegative(),
  }),
});

export type AntifraudSignup = z.infer<typeof signupSchema>;
export type AntifraudSignupsResponse = z.infer<typeof responseSchema>;

const UPSTREAM_TIMEOUT_MS = 8_000;

export async function listAntifraudSignups(
  page: number,
): Promise<{
  configured: boolean;
  data: AntifraudSignupsResponse | null;
  error: boolean;
}> {
  const baseUrl = process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, "");
  const token = process.env.ANTIFRAUD_MONITOR_API_TOKEN;
  if (!baseUrl || !token) {
    return { configured: false, data: null, error: false };
  }

  try {
    const response = await fetch(
      `${baseUrl}/v1/signups?page=${page}&limit=50`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(`Monitor API returned ${response.status}`);
    }
    return {
      configured: true,
      data: responseSchema.parse(await response.json()),
      error: false,
    };
  } catch (error) {
    console.error("[antifraud-monitor] signups failed:", error);
    return { configured: true, data: null, error: true };
  }
}

export async function countAntifraudSignupsSince(
  since: Date,
): Promise<number | null> {
  const baseUrl = process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, "");
  const token = process.env.ANTIFRAUD_MONITOR_API_TOKEN;
  if (!baseUrl || !token) return null;

  try {
    const query = new URLSearchParams({ since: since.toISOString() });
    const response = await fetch(
      `${baseUrl}/v1/signups/unseen-count?${query.toString()}`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(`Monitor API returned ${response.status}`);
    }
    return countResponseSchema.parse(await response.json()).data.count;
  } catch (error) {
    console.error("[antifraud-monitor] signup unseen count failed:", error);
    return null;
  }
}
