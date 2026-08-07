import "server-only";

import { createHash, createHmac, randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { sql } from "drizzle-orm";
import { antifraudSecurityAuditActorVisibilityPredicate } from "@/lib/audit-visibility";

import { adminDrizzle } from "@/lib/admin-db";

type AntifraudAuditKind = "view" | "search" | "export" | "action";
type AntifraudAuditOutcome =
  | "allowed"
  | "denied"
  | "succeeded"
  | "failed"
  | "rate_limited";

const SECRET_KEY_PATTERN =
  /(?:secret|token|password|credential|authorization|cookie|api[-_]?key|private[-_]?key|totp|session)/i;
const PII_KEY_PATTERN =
  /(?:email|ip(?:address)?|user[-_]?agent|phone|address|document|birth|name|reason|note|query|search)/i;
const MAX_METADATA_DEPTH = 4;
const MAX_ARRAY_ITEMS = 25;
const MAX_STRING_LENGTH = 300;
const DEFAULT_ACTION_LIMIT = 30;

type AuditInput = {
  correlationId?: string;
  actorAdminUserId?: string | null;
  actorUsername?: string | null;
  actorRoles?: readonly string[];
  sessionRef?: string | null;
  modelVersion?: string;
  eventKind: AntifraudAuditKind;
  action: string;
  outcome: AntifraudAuditOutcome;
  targetType?: string | null;
  targetId?: string | null;
  reasonCode?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
};

function auditKey(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error("Antifraud audit hashing is unavailable");
  }
  return value;
}

function hashSensitive(value: string): string {
  return createHmac("sha256", auditKey()).update(value).digest("hex");
}

function sanitizeValue(
  value: unknown,
  depth = 0,
): unknown {
  if (depth > MAX_METADATA_DEPTH) return "[truncated]";
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return value.slice(0, MAX_STRING_LENGTH);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value !== "object") return String(value).slice(0, 80);

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value).slice(0, 50)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      output[key] = "[redacted]";
    } else if (PII_KEY_PATTERN.test(key)) {
      output[`${key}Hash`] =
        nested == null ? null : hashSensitive(String(nested));
    } else {
      output[key] = sanitizeValue(nested, depth + 1);
    }
  }
  return output;
}

function safeIdentifier(value: string | null | undefined, max: number) {
  if (!value) return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}

async function requestContext(): Promise<{
  path: string | null;
  method: string | null;
  ipHash: string | null;
  userAgentHash: string | null;
}> {
  try {
    const values = await headers();
    const ip =
      values.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      values.get("x-real-ip");
    const userAgent = values.get("user-agent");
    return {
      path: safeIdentifier(
        values.get("x-antifraud-path") ?? values.get("next-url"),
        500,
      ),
      method: safeIdentifier(values.get("x-antifraud-method"), 12),
      ipHash: ip ? hashSensitive(ip) : null,
      userAgentHash: userAgent ? hashSensitive(userAgent) : null,
    };
  } catch {
    return { path: null, method: null, ipHash: null, userAgentHash: null };
  }
}

export function antifraudErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `AF-${createHash("sha256")
    .update(message)
    .digest("hex")
    .slice(0, 12)
    .toUpperCase()}`;
}

export async function appendAntifraudSecurityAudit(
  input: AuditInput,
): Promise<string> {
  const correlationId = input.correlationId ?? randomUUID();
  const request = await requestContext();
  const metadata = sanitizeValue(input.metadata ?? {}) as Record<
    string,
    unknown
  >;
  const idempotencyHash = input.idempotencyKey
    ? hashSensitive(input.idempotencyKey)
    : null;

  await adminDrizzle.execute(sql`
    INSERT INTO antifraud_security_audit_events (
      correlation_id,
      actor_admin_user_id,
      actor_username,
      actor_roles,
      session_hash,
      model_version,
      event_kind,
      action,
      outcome,
      target_type,
      target_id,
      reason_code,
      request_path,
      request_method,
      ip_hash,
      user_agent_hash,
      idempotency_key_hash,
      metadata
    ) VALUES (
      ${correlationId}::uuid,
      ${input.actorAdminUserId ?? null}::uuid,
      ${safeIdentifier(input.actorUsername, 120)},
      ARRAY(
        SELECT jsonb_array_elements_text(
          ${JSON.stringify(
            input.actorRoles
              ? [...new Set(input.actorRoles)].slice(0, 20)
              : [],
          )}::jsonb
        )
      ),
      ${input.sessionRef ? hashSensitive(input.sessionRef) : null},
      ${safeIdentifier(input.modelVersion ?? "security-boundary-v1", 80)},
      ${input.eventKind},
      ${safeIdentifier(input.action, 160)},
      ${input.outcome},
      ${safeIdentifier(input.targetType, 80)},
      ${safeIdentifier(input.targetId, 200)},
      ${safeIdentifier(input.reasonCode, 100)},
      ${request.path},
      ${request.method},
      ${request.ipHash},
      ${request.userAgentHash},
      ${idempotencyHash},
      ${JSON.stringify(metadata)}::jsonb
    )
    ON CONFLICT (
      action,
      outcome,
      idempotency_key_hash
    ) WHERE idempotency_key_hash IS NOT NULL
      AND outcome IN ('succeeded', 'failed')
    DO NOTHING
  `);
  return correlationId;
}

export async function beginAntifraudAction(input: {
  actorAdminUserId: string;
  actorUsername?: string | null;
  actorRoles?: readonly string[];
  sessionRef?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
  limitPerMinute?: number;
}): Promise<string> {
  const correlationId = randomUUID();
  const limit = Math.max(
    1,
    Math.min(input.limitPerMinute ?? DEFAULT_ACTION_LIMIT, 120),
  );
  const request = await requestContext();
  const metadata = sanitizeValue(input.metadata ?? {}) as Record<
    string,
    unknown
  >;
  const idempotencyHash = input.idempotencyKey
    ? hashSensitive(input.idempotencyKey)
    : null;

  const rateLimited = await adminDrizzle.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.actorAdminUserId}:${input.action}`}))`,
    );
    const count = await tx.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count
      FROM antifraud_security_audit_events
      WHERE actor_admin_user_id = ${input.actorAdminUserId}::uuid
        AND action = ${input.action}
        AND event_kind = 'action'
        AND outcome = 'allowed'
        AND created_at >= now() - interval '1 minute'
    `);
    const limited = Number(count.rows[0]?.count ?? 0) >= limit;
    await tx.execute(sql`
      INSERT INTO antifraud_security_audit_events (
        correlation_id, actor_admin_user_id, actor_username,
        actor_roles, session_hash, model_version, event_kind,
        action, outcome, target_type, target_id, reason_code, request_path,
        request_method, ip_hash, user_agent_hash, idempotency_key_hash, metadata
      ) VALUES (
        ${correlationId}::uuid,
        ${input.actorAdminUserId}::uuid,
        ${safeIdentifier(input.actorUsername, 120)},
        ARRAY(
          SELECT jsonb_array_elements_text(
            ${JSON.stringify(
              input.actorRoles
                ? [...new Set(input.actorRoles)].slice(0, 20)
                : [],
            )}::jsonb
          )
        ),
        ${input.sessionRef ? hashSensitive(input.sessionRef) : null},
        'security-boundary-v1',
        'action',
        ${safeIdentifier(input.action, 160)},
        ${limited ? "rate_limited" : "allowed"},
        ${safeIdentifier(input.targetType, 80)},
        ${safeIdentifier(input.targetId, 200)},
        ${limited ? "rate_limit_exceeded" : null},
        ${request.path},
        ${request.method},
        ${request.ipHash},
        ${request.userAgentHash},
        ${idempotencyHash},
        ${JSON.stringify(metadata)}::jsonb
      )
    `);
    return limited;
  });
  if (rateLimited) {
    throw new Error(
      `Too many Antifraud requests. Try again shortly. Correlation: ${correlationId}`,
    );
  }
  return correlationId;
}

export async function finishAntifraudAction(input: {
  correlationId: string;
  actorAdminUserId: string;
  actorUsername?: string | null;
  actorRoles?: readonly string[];
  sessionRef?: string | null;
  action: string;
  outcome: "succeeded" | "failed";
  targetType?: string | null;
  targetId?: string | null;
  idempotencyKey?: string | null;
  error?: unknown;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await appendAntifraudSecurityAudit({
    ...input,
    eventKind: "action",
    reasonCode:
      input.outcome === "failed"
        ? antifraudErrorCode(input.error)
        : undefined,
    metadata: {
      ...(input.metadata ?? {}),
      ...(input.outcome === "failed"
        ? { errorType: input.error instanceof Error ? input.error.name : "Error" }
        : {}),
    },
  });
}

type AntifraudSecurityAuditEvent = {
  id: string;
  correlationId: string;
  actorUsername: string | null;
  actorRoles: string[];
  eventKind: AntifraudAuditKind;
  action: string;
  outcome: AntifraudAuditOutcome;
  targetType: string | null;
  targetId: string | null;
  reasonCode: string | null;
  requestPath: string | null;
  requestMethod: string | null;
  modelVersion: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

const AUDIT_KINDS = new Set<AntifraudAuditKind>([
  "view",
  "search",
  "export",
  "action",
]);
const AUDIT_OUTCOMES = new Set<AntifraudAuditOutcome>([
  "allowed",
  "denied",
  "succeeded",
  "failed",
  "rate_limited",
]);

async function listAntifraudSecurityAuditEvents(input: {
  action?: string;
  kind?: string;
  outcome?: string;
  correlationId?: string;
  before?: string;
  limit?: number;
  canViewProtectedActors?: boolean;
}): Promise<{
  events: AntifraudSecurityAuditEvent[];
  nextCursor: string | null;
}> {
  const action = input.action?.trim().slice(0, 160) || null;
  const kind =
    input.kind && AUDIT_KINDS.has(input.kind as AntifraudAuditKind)
      ? (input.kind as AntifraudAuditKind)
      : null;
  const outcome =
    input.outcome && AUDIT_OUTCOMES.has(input.outcome as AntifraudAuditOutcome)
      ? (input.outcome as AntifraudAuditOutcome)
      : null;
  const correlationId = /^[0-9a-f-]{36}$/i.test(input.correlationId ?? "")
    ? input.correlationId!
    : null;
  const before = input.before ? new Date(input.before) : null;
  const validBefore =
    before && Number.isFinite(before.getTime()) ? before.toISOString() : null;
  const limit = Math.max(1, Math.min(input.limit ?? 100, 200));

  const result = await adminDrizzle.execute<{
    id: string;
    correlation_id: string;
    actor_username: string | null;
    actor_roles: string[];
    event_kind: AntifraudAuditKind;
    action: string;
    outcome: AntifraudAuditOutcome;
    target_type: string | null;
    target_id: string | null;
    reason_code: string | null;
    request_path: string | null;
    request_method: string | null;
    model_version: string;
    metadata: Record<string, unknown>;
    created_at: string;
  }>(sql`
    SELECT
      id::text,
      correlation_id::text,
      actor_username,
      actor_roles,
      event_kind,
      action,
      outcome,
      target_type,
      target_id,
      reason_code,
      request_path,
      request_method,
      model_version,
      metadata,
      created_at::text
    FROM antifraud_security_audit_events
    WHERE ${antifraudSecurityAuditActorVisibilityPredicate(
      input.canViewProtectedActors === true,
    )}
      AND (${action}::text IS NULL OR action ILIKE '%' || ${action} || '%')
      AND (${kind}::text IS NULL OR event_kind = ${kind})
      AND (${outcome}::text IS NULL OR outcome = ${outcome})
      AND (
        ${correlationId}::uuid IS NULL
        OR correlation_id = ${correlationId}::uuid
      )
      AND (
        ${validBefore}::timestamptz IS NULL
        OR created_at < ${validBefore}::timestamptz
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}
  `);

  const rows = result.rows.slice(0, limit);
  return {
    events: rows.map((row) => ({
      id: row.id,
      correlationId: row.correlation_id,
      actorUsername: row.actor_username,
      actorRoles: row.actor_roles,
      eventKind: row.event_kind,
      action: row.action,
      outcome: row.outcome,
      targetType: row.target_type,
      targetId: row.target_id,
      reasonCode: row.reason_code,
      requestPath: row.request_path,
      requestMethod: row.request_method,
      modelVersion: row.model_version,
      metadata: row.metadata,
      createdAt: row.created_at,
    })),
    nextCursor:
      result.rows.length > limit ? (rows.at(-1)?.created_at ?? null) : null,
  };
}
