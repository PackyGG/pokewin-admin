import "server-only";

import { z } from "zod";

const scoreOptionSchema = z.object({
  label: z.string(),
  points: z.number(),
});

const scoreDefinitionSchema = z.object({
  key: z.string(),
  title: z.string(),
  description: z.string(),
  options: z.array(scoreOptionSchema),
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
  behaviorRules: z.array(
    z.object({
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
    }),
  ),
});

export type AntifraudScoringConfig = z.infer<typeof scoringConfigSchema>;
export type AntifraudScoreDefinition = z.infer<typeof scoreDefinitionSchema>;

const UPSTREAM_TIMEOUT_MS = 8_000;

export async function getAntifraudScoringConfig(): Promise<{
  configured: boolean;
  data: AntifraudScoringConfig | null;
  error: boolean;
}> {
  const baseUrl = process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, "");
  const token = process.env.ANTIFRAUD_MONITOR_API_TOKEN;
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
