import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { enqueueDiscordEvent } from "@/lib/discord-notifications/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SKEW_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

const BodySchema = z.object({
  schemaVersion: z.literal(1),
  correlationId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  guildId: z.string().trim().regex(/^\d{15,21}$/),
  eventKey: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]{2,79}$/),
  dedupeKey: z.string().trim().min(1).max(200),
  embed: z.record(z.string(), z.unknown()),
  components: z.array(z.record(z.string(), z.unknown())).max(5).default([]),
  content: z.string().trim().max(2000).optional(),
});

function json(body: unknown, status: number, correlationId?: string): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(correlationId ? { "x-correlation-id": correlationId } : {}),
    },
  });
}

function expectedSignature(
  secret: string,
  timestamp: string,
  body: string,
): Buffer {
  return Buffer.from(
    `sha256=${createHmac("sha256", secret)
      .update(`${timestamp}.${body}`)
      .digest("hex")}`,
  );
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.ANTIFRAUD_INGEST_SECRET;
  if (!secret) return json({ error: "not_configured" }, 503);

  const timestamp = request.headers.get("x-antifraud-timestamp");
  const signature = request.headers.get("x-antifraud-signature");
  if (!timestamp || !signature) return json({ error: "missing_signature" }, 401);
  const parsedTimestamp = Number(timestamp);
  if (
    !Number.isFinite(parsedTimestamp) ||
    Math.abs(Date.now() - parsedTimestamp) > MAX_SKEW_MS
  ) {
    return json({ error: "stale_timestamp" }, 401);
  }

  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large" }, 413);
  }
  const expected = expectedSignature(secret, timestamp, body);
  const provided = Buffer.from(signature);
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  ) {
    return json({ error: "signature_mismatch" }, 401);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        error: "invalid_request",
        message: parsed.error.issues[0]?.message ?? "Invalid event payload.",
      },
      400,
    );
  }
  if (request.headers.get("x-correlation-id") !== parsed.data.correlationId) {
    return json({ error: "correlation_mismatch" }, 400);
  }
  const configuredGuildId = process.env.ADMIN_GUILD_ID;
  if (!configuredGuildId) return json({ error: "not_configured" }, 503);
  if (parsed.data.guildId !== configuredGuildId) {
    return json({ error: "guild_not_allowed" }, 403);
  }

  try {
    const result = await enqueueDiscordEvent(parsed.data);
    return json(
      { ok: true, correlationId: parsed.data.correlationId, ...result },
      200,
      parsed.data.correlationId,
    );
  } catch (error) {
    console.error("[discord-events] enqueue failed:", error);
    return json({ error: "storage_failed" }, 500);
  }
}
