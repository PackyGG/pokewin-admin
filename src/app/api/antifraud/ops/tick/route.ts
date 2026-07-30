import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { enqueueDueReviewReminders } from "@/lib/discord-notifications/review-reminders";
import { syncReviewWorkflowStates } from "@/lib/antifraud/review-workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SKEW_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 4 * 1024;
const BodySchema = z.object({
  schemaVersion: z.literal(1),
  correlationId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
});

function response(body: unknown, status: number, correlationId?: string) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...(correlationId ? { "x-correlation-id": correlationId } : {}),
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.ANTIFRAUD_INGEST_SECRET;
  const timestamp = request.headers.get("x-antifraud-timestamp");
  const signature = request.headers.get("x-antifraud-signature");
  if (!secret) return response({ error: "not_configured" }, 503);
  if (!timestamp || !signature) {
    return response({ error: "missing_signature" }, 401);
  }
  const timestampMs = Number(timestamp);
  if (
    !Number.isFinite(timestampMs) ||
    Math.abs(Date.now() - timestampMs) > MAX_SKEW_MS
  ) {
    return response({ error: "stale_timestamp" }, 401);
  }
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    return response({ error: "payload_too_large" }, 413);
  }
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret)
      .update(`${timestamp}.${body}`)
      .digest("hex")}`,
  );
  const provided = Buffer.from(signature);
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  ) {
    return response({ error: "signature_mismatch" }, 401);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return response({ error: "invalid_json" }, 400);
  }
  const parsed = BodySchema.safeParse(decoded);
  if (!parsed.success) return response({ error: "invalid_request" }, 400);
  if (request.headers.get("x-correlation-id") !== parsed.data.correlationId) {
    return response({ error: "correlation_mismatch" }, 400);
  }

  try {
    const projectedReviews = await syncReviewWorkflowStates();
    const reminders = await enqueueDueReviewReminders();
    return response(
      {
        ok: true,
        correlationId: parsed.data.correlationId,
        projectedReviews,
        reminders,
      },
      200,
      parsed.data.correlationId,
    );
  } catch {
    return response(
      { error: "tick_failed", correlationId: parsed.data.correlationId },
      500,
      parsed.data.correlationId,
    );
  }
}
