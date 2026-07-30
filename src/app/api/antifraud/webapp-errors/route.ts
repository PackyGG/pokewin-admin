import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { buildCacheKey, rateLimit } from "@/lib/cache/redis";
import { ANTIFRAUD_TEAM_IDS } from "@/lib/discord-notifications/antifraud-policy";
import { enqueueDiscordEvent } from "@/lib/discord-notifications/router";
import { requireAntifraudReadAccess } from "@/lib/require-antifraud-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;
const ReportSchema = z.object({
  source: z.enum([
    "react-boundary",
    "react-component",
    "window-error",
    "unhandled-rejection",
  ]),
  boundary: z.string().trim().min(1).max(80),
  route: z
    .string()
    .trim()
    .regex(/^\/[^?#]{0,299}$/),
  errorName: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/),
  digest: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
    .optional(),
  componentNames: z
    .array(z.string().trim().regex(/^[A-Za-z0-9_.$-]{1,80}$/))
    .max(12)
    .default([]),
});

function response(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  let actorId: string;
  try {
    actorId = (await requireAntifraudReadAccess()).userId;
  } catch {
    return response({ error: "unauthorized" }, 401);
  }

  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return response({ error: "forbidden" }, 403);
  }
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (!origin || origin !== requestUrl.origin) {
    return response({ error: "forbidden" }, 403);
  }
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return response({ error: "unsupported_media_type" }, 415);
  }

  const limit = await rateLimit(
    buildCacheKey("ratelimit:antifraud-webapp-errors", [actorId]),
    30,
    60,
  );
  if (!limit.allowed) {
    return response({ error: "rate_limited" }, 429);
  }

  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return response({ error: "payload_too_large" }, 413);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return response({ error: "invalid_json" }, 400);
  }
  const parsed = ReportSchema.safeParse(json);
  if (!parsed.success) {
    return response({ error: "invalid_request" }, 400);
  }

  const guildId = process.env.ADMIN_GUILD_ID;
  if (!guildId) return response({ error: "not_configured" }, 503);

  const report = parsed.data;
  const correlationId = randomUUID();
  // Repeat crashes stay visible once per hour without flooding Discord on
  // every render retry or reconnect loop.
  const hourBucket = new Date().toISOString().slice(0, 13);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        report.source,
        report.boundary,
        report.route,
        report.errorName,
        report.digest ?? "",
        report.componentNames,
        hourBucket,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  const fields = [
    { name: "Source", value: report.source, inline: true },
    { name: "Boundary", value: report.boundary, inline: true },
    { name: "Route", value: `\`${report.route}\``, inline: false },
    {
      name: "Error",
      value: report.digest
        ? `${report.errorName} · digest \`${report.digest}\``
        : report.errorName,
      inline: false,
    },
  ];
  if (report.componentNames.length > 0) {
    fields.push({
      name: "Components",
      value: report.componentNames.map((name) => `\`${name}\``).join(" → "),
      inline: false,
    });
  }

  try {
    const result = await enqueueDiscordEvent({
      guildId,
      eventKey: "antifraud.error.webapp",
      dedupeKey: `browser:${fingerprint}`,
      content: ANTIFRAUD_TEAM_IDS.support.map((id) => `<@${id}>`).join(" "),
      embed: {
        title: "🚨 Fraud webapp runtime error",
        description:
          "A browser or React boundary caught an error. Raw messages and stack traces were intentionally excluded.",
        url: "https://fraud.packydash.com",
        color: 0xed4245,
        fields,
        footer: { text: `Correlation ${correlationId}` },
        timestamp: new Date().toISOString(),
      },
    });
    return response({ ok: true, correlationId, ...result }, 202);
  } catch (error) {
    console.error("[webapp-errors] enqueue failed:", {
      correlationId,
      error,
    });
    return response({ error: "reporting_unavailable", correlationId }, 503);
  }
}
