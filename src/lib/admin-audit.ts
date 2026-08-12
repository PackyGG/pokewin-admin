import { sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";

export type AdminAuditEventParams = {
  /**
   * null = no human actor. `admin_audit_events.admin_user_id` is nullable (the
   * FK is ON DELETE SET NULL) and every reader already handles it, so an
   * automated origin records honestly instead of being booked against whoever
   * happened to be handy. Such callers put the real origin in `metadata`.
   */
  adminUserId: string | null;
  eventType: string;
  targetUserId?: string;
  ip?: string | null;
  metadata?: Record<string, unknown>;
};

export async function createAdminAuditEvent(params: AdminAuditEventParams) {
  // If the caller didn't pass an explicit IP, try to read it from the
  // current request headers. This is best-effort: `headers()` only works
  // inside a request scope (Server Component / Route Handler / Server
  // Action), and throws elsewhere — we swallow that and fall back to null
  // so the call site doesn't have to care.
  let ip = params.ip;
  if (ip === undefined) {
    try {
      const { headers } = await import("next/headers");
      const h = await headers();
      ip =
        h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        h.get("x-real-ip") ||
        null;
    } catch {
      ip = null;
    }
  }

  const metadata =
    params.metadata === undefined ? null : JSON.stringify(params.metadata);
  await adminDrizzle.execute(sql`
    INSERT INTO admin_audit_events (
      admin_user_id, event_type, target_user_id, ip, metadata
    )
    VALUES (
      ${params.adminUserId ?? null}::uuid,
      ${params.eventType},
      ${params.targetUserId ?? null},
      ${ip ?? null},
      ${metadata}::jsonb
    )
  `);
}

// --- Durable write path -----------------------------------------------
//
// Some callers (e.g. antifraud refund recovery) commit a real, irreversible
// MAIN-DB mutation — a ban, a balance adjustment, a voucher/inventory
// deletion — and the audit event is the only record of *why*. If
// `createAdminAuditEvent` itself fails (a transient ADMIN DB hiccup), the
// mutation must not be allowed to leave zero trace and zero alert.
// `createAdminAuditEventDurable` retries with backoff, then falls back to a
// durable `admin_audit_write_failures` row plus a loud Discord alert via the
// existing antifraud error-routing channel, so nothing is silently dropped.

const AUDIT_RETRY_DELAYS_MS = [200, 1000, 4000];

/**
 * pg-pool reports exhaustion as a local queue timeout, PostgreSQL reports it as
 * 53300. Neither heals inside a 5 s backoff window, and each further attempt
 * parks another `connectionTimeoutMillis` (10 s) before returning: the four
 * attempts burn ~45 s, which on a serverless invocation usually means the
 * durable fallback row and the Discord alert never get their turn at all.
 * Failing over immediately is what actually preserves the trace.
 */
const AUDIT_CAPACITY_FAILURE =
  /timeout exceeded when trying to connect|too many clients|\b53300\b/i;

function isAuditCapacityFailure(error: unknown): boolean {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  // Drizzle wraps driver errors, so the pg message/code can sit one or two
  // `cause` hops down. Bounded and guarded: a hostile getter must not turn
  // failure handling into a second failure.
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current !== "object") break;
    try {
      const message = Reflect.get(current, "message");
      if (typeof message === "string") parts.push(message);
      const code = Reflect.get(current, "code");
      if (typeof code === "string") parts.push(code);
      current = Reflect.get(current, "cause");
    } catch {
      break;
    }
  }
  return AUDIT_CAPACITY_FAILURE.test(parts.join(" "));
}

export type DurableAuditOutcome =
  | { status: "recorded" }
  | { status: "fallback"; fallbackId: string }
  | { status: "lost"; error: unknown };

/**
 * Dependency seams exist only so tests can simulate `createAdminAuditEvent`
 * throwing without a real ADMIN DB connection. Production call sites should
 * never pass `deps`.
 */
export type AdminAuditDurableDeps = {
  write?: (params: AdminAuditEventParams) => Promise<void>;
  writeFallback?: (
    params: AdminAuditEventParams,
    errorMessage: string,
    attemptCount: number,
  ) => Promise<string>;
  notify?: (
    params: AdminAuditEventParams,
    errorMessage: string,
  ) => Promise<void>;
  delay?: (ms: number) => Promise<void>;
};

export async function createAdminAuditEventDurable(
  params: AdminAuditEventParams,
  deps: AdminAuditDurableDeps = {},
): Promise<DurableAuditOutcome> {
  const write = deps.write ?? createAdminAuditEvent;
  const writeFallback = deps.writeFallback ?? writeAuditFallbackRow;
  const notify = deps.notify ?? notifyAuditWriteFailure;
  const delay =
    deps.delay ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastError: unknown;
  let attemptCount = 0;
  for (let attempt = 0; attempt <= AUDIT_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await delay(AUDIT_RETRY_DELAYS_MS[attempt - 1]);
    }
    attemptCount = attempt + 1;
    try {
      await write(params);
      return { status: "recorded" };
    } catch (error) {
      lastError = error;
      if (isAuditCapacityFailure(error)) break;
    }
  }

  const errorMessage =
    lastError instanceof Error ? lastError.message : String(lastError);
  // Loud, not a silent counter: this always hits stderr regardless of what
  // happens next, so it shows up in Vercel/Railway logs even if the fallback
  // write and the Discord alert both also fail.
  console.error(
    "[admin-audit] createAdminAuditEvent failed after retries, writing durable fallback:",
    {
      eventType: params.eventType,
      targetUserId: params.targetUserId,
      error: errorMessage,
    },
  );

  try {
    // Record what was really tried, not the theoretical maximum: a capacity
    // failure short-circuits the loop, and a fallback row claiming four
    // attempts would misdirect whoever reconciles it.
    const fallbackId = await writeFallback(params, errorMessage, attemptCount);
    void notify(params, errorMessage).catch((notifyError) => {
      console.error(
        "[admin-audit] failure alert delivery also failed:",
        notifyError,
      );
    });
    return { status: "fallback", fallbackId };
  } catch (fallbackError) {
    console.error(
      "[admin-audit] CRITICAL: audit event lost — durable fallback write also failed:",
      {
        eventType: params.eventType,
        targetUserId: params.targetUserId,
        error: fallbackError,
      },
    );
    void notify(params, errorMessage).catch(() => {});
    return { status: "lost", error: fallbackError };
  }
}

async function writeAuditFallbackRow(
  params: AdminAuditEventParams,
  errorMessage: string,
  attemptCount: number,
): Promise<string> {
  const metadata =
    params.metadata === undefined ? null : JSON.stringify(params.metadata);
  const result = await adminDrizzle.execute<{ id: string }>(sql`
    INSERT INTO admin_audit_write_failures (
      admin_user_id, event_type, target_user_id, ip, metadata,
      error_message, attempt_count
    )
    VALUES (
      ${params.adminUserId ?? null}::uuid,
      ${params.eventType},
      ${params.targetUserId ?? null},
      ${params.ip ?? null},
      ${metadata}::jsonb,
      ${errorMessage.slice(0, 2000)},
      ${attemptCount}
    )
    RETURNING id
  `);
  const row = result.rows[0];
  if (!row?.id) {
    throw new Error("admin_audit_write_failures insert returned no id");
  }
  return row.id;
}

async function notifyAuditWriteFailure(
  params: AdminAuditEventParams,
  errorMessage: string,
): Promise<void> {
  // Reuse the existing antifraud Discord error-routing channel
  // (`antifraud.error.webapp`) instead of inventing a new alert path.
  // Best-effort: if ADMIN_GUILD_ID isn't configured, the fallback DB row is
  // still there for manual reconciliation.
  const guildId = process.env.ADMIN_GUILD_ID?.trim();
  if (!guildId) return;
  const { enqueueDiscordEvent } = await import(
    "@/lib/discord-notifications/router"
  );
  const hourBucket = new Date().toISOString().slice(0, 13);
  await enqueueDiscordEvent({
    guildId,
    eventKey: "antifraud.error.webapp",
    dedupeKey: `admin-audit-write-failure:${params.eventType}:${params.targetUserId ?? "none"}:${hourBucket}`,
    embed: {
      title: "🚨 Admin audit write failed — fallback row captured",
      description:
        "A real admin-side mutation committed but writing its audit_events row failed after retries. A fallback row was recorded in `admin_audit_write_failures` for manual reconciliation.",
      color: 0xed4245,
      fields: [
        { name: "Event type", value: params.eventType, inline: true },
        {
          name: "Target user",
          value: params.targetUserId ?? "n/a",
          inline: true,
        },
        {
          name: "Error",
          value: errorMessage.slice(0, 500) || "unknown",
          inline: false,
        },
      ],
      timestamp: new Date().toISOString(),
    },
  });
}
