import "server-only";

import { z } from "zod";

/**
 * Backend-monitor service health/overview reader.
 *
 * This is a SEPARATE service from the main game backend (`backendApi` /
 * `client.ts`) — it has its own base URL + bearer token, set ONLY via env:
 *   - MONITOR_API_URL    e.g. https://backend-monitor-production-xxxx.up.railway.app
 *   - MONITOR_API_TOKEN  bearer token (NEVER logged, printed, or sent client-side)
 *
 * The single endpoint we read is `GET {MONITOR_API_URL}/v1/admin/overview`
 * with `Authorization: Bearer ${MONITOR_API_TOKEN}`.
 *
 * Server-only: the token must never cross the RSC boundary. The page fetches
 * here (Server Component) and passes the PARSED, token-free payload to the
 * presentational client component.
 *
 * Defensive by design — the result is a discriminated union so the page can
 * render a clean state for every outcome WITHOUT throwing:
 *   - { status: "unconfigured" }  → env vars missing (show setup empty-state)
 *   - { status: "error", ... }    → fetch failed / non-200 / parse failed
 *   - { status: "ok", data, raw } → success (parsed; `raw` kept for unknown keys)
 */

// Default fetch timeout — caps how long the monitor round-trip can pin the
// Next.js handler. The monitor is a lightweight health endpoint, so 8s is
// comfortably generous.
const MONITOR_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Tolerant schema. Fields may be null/absent and extra keys can appear, so
// every object is `.passthrough()` and most leaves are optional/nullable.
// `freshness` + `dependencies` are open string→string-ish records so unknown
// extra keys still survive into the parsed object and get rendered.
// ---------------------------------------------------------------------------

const cursorSchema = z
  .object({
    created_at: z.string().nullable().optional(),
    id: z.string().nullable().optional(),
  })
  .passthrough()
  .nullable()
  .optional();

const notificationSourceSchema = z
  .object({
    name: z.string().nullable().optional(),
    table: z.string().nullable().optional(),
    filter: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    cursor: cursorSchema,
  })
  .passthrough();

const monitorOverviewSchema = z
  .object({
    service: z
      .object({
        name: z.string().nullable().optional(),
        uptime_seconds: z.number().nullable().optional(),
        poll_interval_ms: z.number().nullable().optional(),
        node: z.string().nullable().optional(),
        ts: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    notifications: z
      .object({
        provider: z.string().nullable().optional(),
        topic: z.string().nullable().optional(),
        server: z.string().nullable().optional(),
        auth: z.boolean().nullable().optional(),
        sources: z.array(notificationSourceSchema).nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    analytics: z
      .object({
        store: z.string().nullable().optional(),
        configured: z.boolean().nullable().optional(),
        reachable: z.boolean().nullable().optional(),
        database: z.string().nullable().optional(),
        // Open record — keys (ledger / rains / …) vary; values are
        // Postgres timestamp strings (or null).
        freshness: z.record(z.string(), z.string().nullable()).nullable().optional(),
        endpoints: z.array(z.string()).nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    // Open record — one entry per dependency (postgres / clickhouse / …);
    // value is a status string like "up" / "down".
    dependencies: z.record(z.string(), z.string()).nullable().optional(),
  })
  .passthrough();

export type MonitorOverview = z.infer<typeof monitorOverviewSchema>;
export type MonitorNotificationSource = z.infer<typeof notificationSourceSchema>;

export type MonitorResult =
  | { status: "unconfigured"; missing: string[] }
  | {
      status: "error";
      /** HTTP status when the response came back non-2xx; null for network/parse failures. */
      httpStatus: number | null;
      /** Safe, human-readable message — never includes the token or full URL. */
      message: string;
    }
  | {
      status: "ok";
      data: MonitorOverview;
      /** The raw JSON body — used to render any keys the schema didn't model. */
      raw: unknown;
      /** True when the body was returned but failed schema validation (raw still shown). */
      parsedLoosely: boolean;
    };

/**
 * Fetch + parse the monitor overview. Never throws — every failure mode maps
 * to a `MonitorResult` variant the page renders cleanly.
 */
export async function getMonitorOverview(): Promise<MonitorResult> {
  const baseUrl = process.env.MONITOR_API_URL?.trim();
  const token = process.env.MONITOR_API_TOKEN?.trim();

  const missing: string[] = [];
  if (!baseUrl) missing.push("MONITOR_API_URL");
  if (!token) missing.push("MONITOR_API_TOKEN");
  if (missing.length > 0 || !baseUrl || !token) {
    return { status: "unconfigured", missing };
  }

  // Normalize: ensure an absolute scheme, then strip a trailing slash, so the
  // result is always a valid absolute URL for fetch(). A bare host like
  // "backend-monitor-x.up.railway.app" (an easy thing to paste into an env var)
  // otherwise makes fetch throw "Failed to parse URL from …".
  let normalizedBase = baseUrl.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(normalizedBase)) {
    normalizedBase = `https://${normalizedBase}`;
  }
  const url = `${normalizedBase}/v1/admin/overview`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      // Live health data — never cache.
      cache: "no-store",
      signal: AbortSignal.timeout(MONITOR_TIMEOUT_MS),
    });
  } catch (err) {
    // DNS / TCP / TLS / timeout. Surface a safe message; the token never
    // appears in the URL or the error text.
    const reason =
      err instanceof Error
        ? err.name === "TimeoutError" || err.name === "AbortError"
          ? `request timed out after ${MONITOR_TIMEOUT_MS / 1000}s`
          : err.message
        : "unknown error";
    // Diagnostic only — host (no token) + reason. console.log so it never
    // hits the browser error overlay.
    console.log(
      `[monitor-api] network failure host=${safeHost(normalizedBase)} reason=${reason}`,
    );
    return {
      status: "error",
      httpStatus: null,
      message: `Couldn't reach the monitor service (${reason}).`,
    };
  }

  if (!res.ok) {
    // Drain a short body for context but never echo it raw to the client.
    let detail = "";
    try {
      const text = await res.text();
      detail = text.slice(0, 200);
    } catch {
      // ignore body read failure
    }
    console.log(
      `[monitor-api] non-200 host=${safeHost(normalizedBase)} status=${res.status} detail=${JSON.stringify(detail)}`,
    );
    const friendly =
      res.status === 401 || res.status === 403
        ? "Authentication was rejected — check MONITOR_API_TOKEN."
        : res.status >= 500
          ? "The monitor service returned a server error."
          : `The monitor service responded with ${res.status} ${res.statusText}.`;
    return { status: "error", httpStatus: res.status, message: friendly };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      status: "error",
      httpStatus: res.status,
      message: "The monitor service returned a response that wasn't valid JSON.",
    };
  }

  const parsed = monitorOverviewSchema.safeParse(body);
  if (!parsed.success) {
    // Body came back but didn't match the expected shape. Don't crash —
    // hand the raw payload through so the page can still render what it has.
    return {
      status: "ok",
      // Best-effort: treat the raw body as the data object (it IS an object
      // on the wire); the view reads defensively from `raw` when fields are
      // absent from the typed `data`.
      data: (typeof body === "object" && body !== null ? body : {}) as MonitorOverview,
      raw: body,
      parsedLoosely: true,
    };
  }

  return { status: "ok", data: parsed.data, raw: body, parsedLoosely: false };
}

// ===========================================================================
// Shared request primitive (used by the antifraud / events / endpoints reads
// below). `getMonitorOverview` predates this and keeps its own inline copy so
// its verified behavior is untouched.
// ===========================================================================

function resolveMonitorBase():
  | { base: string; token: string }
  | { missing: string[] } {
  const baseUrl = process.env.MONITOR_API_URL?.trim();
  const token = process.env.MONITOR_API_TOKEN?.trim();
  const missing: string[] = [];
  if (!baseUrl) missing.push("MONITOR_API_URL");
  if (!token) missing.push("MONITOR_API_TOKEN");
  if (missing.length > 0 || !baseUrl || !token) return { missing };
  let base = baseUrl.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return { base, token };
}

type MonitorRawResult =
  | { status: "unconfigured"; missing: string[] }
  | { status: "error"; httpStatus: number | null; message: string }
  | { status: "ok"; body: unknown };

/** Generic JSON request against the monitor base. Never throws. */
async function monitorRequest(
  path: string,
  init?: { method?: "GET" | "PUT" | "POST"; body?: unknown },
): Promise<MonitorRawResult> {
  const resolved = resolveMonitorBase();
  if ("missing" in resolved) {
    return { status: "unconfigured", missing: resolved.missing };
  }
  const { base, token } = resolved;
  const url = `${base}${path}`;
  const hasBody = init?.body !== undefined;

  let res: Response;
  try {
    res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
      body: hasBody ? JSON.stringify(init?.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(MONITOR_TIMEOUT_MS),
    });
  } catch (err) {
    const reason =
      err instanceof Error
        ? err.name === "TimeoutError" || err.name === "AbortError"
          ? `request timed out after ${MONITOR_TIMEOUT_MS / 1000}s`
          : err.message
        : "unknown error";
    console.log(
      `[monitor-api] network failure host=${safeHost(base)} path=${path} reason=${reason}`,
    );
    return {
      status: "error",
      httpStatus: null,
      message: `Couldn't reach the monitor service (${reason}).`,
    };
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      // ignore body read failure
    }
    console.log(
      `[monitor-api] non-200 host=${safeHost(base)} path=${path} status=${res.status} detail=${JSON.stringify(detail)}`,
    );
    const friendly =
      res.status === 401 || res.status === 403
        ? "Authentication was rejected — check MONITOR_API_TOKEN."
        : res.status >= 500
          ? "The monitor service returned a server error."
          : `The monitor service responded with ${res.status} ${res.statusText}.`;
    return { status: "error", httpStatus: res.status, message: friendly };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      status: "error",
      httpStatus: res.status,
      message: "The monitor service returned a response that wasn't valid JSON.",
    };
  }
  return { status: "ok", body };
}

// ===========================================================================
// Antifraud system rubric (read-only): GET /v1/antifraud/system
// Response is wrapped as { data: { … } }. Advisory scoring config — every
// signal, its points, risk levels, alerting + runtime knobs. No enforcement.
// ===========================================================================

const antifraudSignalSchema = z
  .object({
    key: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    tiered: z.boolean().nullable().optional(),
    conditional: z.string().nullable().optional(),
    // Either a flat point value or a tiered map (e.g. { burst, critical }).
    points: z
      .union([z.number(), z.record(z.string(), z.number())])
      .nullable()
      .optional(),
    description: z.string().nullable().optional(),
  })
  .passthrough();

const antifraudSystemSchema = z
  .object({
    service: z.string().nullable().optional(),
    mode: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    enabled: z.boolean().nullable().optional(),
    scoring: z
      .object({
        maxScore: z.number().nullable().optional(),
        riskLevels: z
          .array(
            z
              .object({
                level: z.string().nullable().optional(),
                minScore: z.number().nullable().optional(),
              })
              .passthrough(),
          )
          .nullable()
          .optional(),
        note: z.string().nullable().optional(),
        signals: z.array(antifraudSignalSchema).nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    alerting: z
      .object({
        minScoreToAlert: z.number().nullable().optional(),
        gating: z.string().nullable().optional(),
        strongSignals: z.array(z.string()).nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    falsePositiveGuards: z.array(z.string()).nullable().optional(),
    burstTiers: z.record(z.string(), z.number()).nullable().optional(),
    runtime: z
      .record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
      .nullable()
      .optional(),
  })
  .passthrough();

export type AntifraudSystem = z.infer<typeof antifraudSystemSchema>;
export type AntifraudSignal = z.infer<typeof antifraudSignalSchema>;

export type AntifraudResult =
  | { status: "unconfigured"; missing: string[] }
  | { status: "error"; httpStatus: number | null; message: string }
  | { status: "ok"; data: AntifraudSystem; raw: unknown; parsedLoosely: boolean };

export async function getAntifraudSystem(): Promise<AntifraudResult> {
  const res = await monitorRequest("/v1/antifraud/system");
  if (res.status !== "ok") return res;
  // Unwrap the { data } envelope; tolerate a bare object too.
  const payload =
    res.body && typeof res.body === "object" && "data" in res.body
      ? (res.body as { data: unknown }).data
      : res.body;
  const parsed = antifraudSystemSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      status: "ok",
      data: (typeof payload === "object" && payload !== null
        ? payload
        : {}) as AntifraudSystem,
      raw: res.body,
      parsedLoosely: true,
    };
  }
  return { status: "ok", data: parsed.data, raw: res.body, parsedLoosely: false };
}

// ===========================================================================
// Event on/off switches: GET /v1/admin/events, PUT /v1/admin/events/{name}
// These are the monitor's notification sources (upgrader / pack / battle /
// deposit / withdrawal / signup). Response is wrapped as { data: [...] }.
// ===========================================================================

const monitorEventSchema = z
  .object({
    name: z.string(),
    enabled: z.boolean(),
  })
  .passthrough();

export type MonitorEvent = z.infer<typeof monitorEventSchema>;

export type MonitorEventsResult =
  | { status: "unconfigured"; missing: string[] }
  | { status: "error"; httpStatus: number | null; message: string }
  | { status: "ok"; events: MonitorEvent[] };

export async function getMonitorEvents(): Promise<MonitorEventsResult> {
  const res = await monitorRequest("/v1/admin/events");
  if (res.status !== "ok") return res;
  const payload =
    res.body && typeof res.body === "object" && "data" in res.body
      ? (res.body as { data: unknown }).data
      : res.body;
  const parsed = z.array(monitorEventSchema).safeParse(payload);
  if (!parsed.success) {
    return {
      status: "error",
      httpStatus: null,
      message: "The monitor returned an unexpected events shape.",
    };
  }
  return { status: "ok", events: parsed.data };
}

/**
 * Toggle a single notification event on/off. Server-only mutation — the
 * caller (a server action) is responsible for auth + audit. Returns the
 * confirmed enabled state when the monitor echoes it back.
 */
export async function setMonitorEvent(
  name: string,
  enabled: boolean,
): Promise<
  | { ok: true; enabled: boolean }
  | { ok: false; message: string }
> {
  const res = await monitorRequest(`/v1/admin/events/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: { enabled },
  });
  if (res.status === "unconfigured") {
    return { ok: false, message: "Monitor connection is not configured." };
  }
  if (res.status === "error") {
    return { ok: false, message: res.message };
  }
  // Best-effort read-back of the confirmed state; fall back to requested.
  const payload =
    res.body && typeof res.body === "object" && "data" in res.body
      ? (res.body as { data: unknown }).data
      : res.body;
  const parsed = monitorEventSchema.safeParse(payload);
  return {
    ok: true,
    enabled: parsed.success ? parsed.data.enabled : enabled,
  };
}

// ===========================================================================
// Full API surface from the OpenAPI document: GET /openapi.json
// The overview's `analytics.endpoints` only lists the ClickHouse-served
// analytics routes — this reads the complete route list (meta / leaderboards
// / stats / antifraud / admin) so the UI can show every endpoint.
// ===========================================================================

export type MonitorApiEndpoint = {
  method: string;
  path: string;
  summary: string | null;
  tags: string[];
  authRequired: boolean;
};

export type MonitorEndpointsResult =
  | { status: "unconfigured"; missing: string[] }
  | { status: "error"; httpStatus: number | null; message: string }
  | { status: "ok"; endpoints: MonitorApiEndpoint[] };

const HTTP_METHODS = ["get", "put", "post", "patch", "delete", "head", "options"];

export async function getMonitorApiEndpoints(): Promise<MonitorEndpointsResult> {
  const res = await monitorRequest("/openapi.json");
  if (res.status !== "ok") return res;

  const doc = res.body as
    | {
        paths?: Record<string, Record<string, unknown>>;
        security?: unknown[];
      }
    | null;
  if (!doc || typeof doc !== "object" || !doc.paths) {
    return {
      status: "error",
      httpStatus: null,
      message: "The OpenAPI document did not contain any paths.",
    };
  }

  const rootSecure = Array.isArray(doc.security) && doc.security.length > 0;
  const endpoints: MonitorApiEndpoint[] = [];

  for (const [path, ops] of Object.entries(doc.paths)) {
    if (!ops || typeof ops !== "object") continue;
    for (const [method, opRaw] of Object.entries(ops)) {
      if (!HTTP_METHODS.includes(method.toLowerCase())) continue;
      const op = (opRaw ?? {}) as {
        summary?: unknown;
        tags?: unknown;
        security?: unknown[];
      };
      const opSecurity = Array.isArray(op.security)
        ? op.security.length > 0
        : null;
      endpoints.push({
        method: method.toUpperCase(),
        path,
        summary: typeof op.summary === "string" ? op.summary : null,
        tags: Array.isArray(op.tags)
          ? op.tags.filter((t): t is string => typeof t === "string")
          : [],
        // An operation can override the root security. `[]` explicitly means
        // public; absent means it inherits the root requirement.
        authRequired: opSecurity ?? rootSecure,
      });
    }
  }

  endpoints.sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
  return { status: "ok", endpoints };
}

/** Hostname only (no token, no path) for safe diagnostic logging. */
function safeHost(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return "(unparseable)";
  }
}
