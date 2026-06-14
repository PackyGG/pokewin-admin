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

  // Normalize: strip a single trailing slash so `${base}/v1/...` is clean
  // whether or not the env value ends in "/".
  const normalizedBase = baseUrl.replace(/\/+$/, "");
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

/** Hostname only (no token, no path) for safe diagnostic logging. */
function safeHost(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return "(unparseable)";
  }
}
