import "server-only";

import { resolveBackendApiConfig } from "./config";
import {
  BackendApiError,
  BackendNetworkError,
  type BackendErrorPayload,
} from "./errors";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RequestOptions = {
  method?: HttpMethod;
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Extra headers. Merged LAST, so callers can override if needed. */
  headers?: Record<string, string>;
  /** Next.js fetch cache control. Defaults to 'no-store'. */
  cache?: RequestCache;
  /**
   * Optional caller-supplied AbortSignal. Combined with the default 8s
   * timeout via AbortSignal.any so whichever fires first wins. Pass null
   * to opt out of the default timeout entirely (rare — for streams etc.).
   */
  signal?: AbortSignal | null;
  /**
   * Override the default 8s timeout. Use a smaller value for hot paths
   * or a larger one for slow endpoints. Set to 0 to disable.
   */
  timeoutMs?: number;
};

// Default fetch timeout. Caps how long any backend round-trip can pin the
// Next.js handler — without this a stuck upstream would leave admin pages
// hanging until Vercel's maxDuration kills the function. 8s is comfortably
// above p99 backend latency in practice.
const DEFAULT_TIMEOUT_MS = 8000;

// Retry policy for transient upstream pushback (429 rate-limit / 503
// unavailable). Applies to GET ONLY — GETs are idempotent, so replaying
// them is safe; POST/PUT/PATCH/DELETE are never retried (a replay could
// double-apply a mutation). Under concurrent live-route load the
// per-creator backend sessions fan-out gets 429'd; without retries every
// rate-limited leg degraded immediately.
const MAX_GET_RETRIES = 2; // retries AFTER the initial attempt (max 3 tries)
const RETRY_BASE_DELAY_MS = 250; // exponential base: ~250ms, ~500ms (+ jitter)
const MAX_RETRY_DELAY_MS = 4000; // never sleep longer than this between tries

/**
 * Parse a Retry-After response header into milliseconds. Supports both
 * forms from RFC 9110: delay-seconds ("120") and HTTP-date. Returns null
 * when absent or unparseable.
 */
const parseRetryAfterMs = (res: Response): number | null => {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
};

/**
 * Abort-aware sleep. Resolves early (never rejects) if the caller's
 * signal aborts mid-wait — the next fetch attempt then surfaces the
 * abort through the normal BackendNetworkError path.
 */
const sleep = (ms: number, signal?: AbortSignal | null): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const buildQueryString = (
  query: RequestOptions["query"]
): string => {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    params.append(key, String(value));
  }
  const str = params.toString();
  return str ? `?${str}` : "";
};

const safeJson = async (res: Response): Promise<unknown> => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};

/**
 * Central backend fetch wrapper. Pulls env-specific base URL + admin key
 * from config (driven by the `admin_db_env` cookie), attaches the CF
 * Access service token if configured, and maps non-OK responses to
 * `BackendApiError`.
 *
 * Server-only: callers must be in Server Components, Route Handlers, or
 * Server Actions. Never import from a client component.
 */
const resolveServerOrigin = (): string | null => {
  // Backend's CORS plugin rejects no-Origin requests outside an
  // allowlist. Server-side fetch from Next.js never attaches Origin,
  // so we send the admin dashboard's own URL — which the backend has
  // configured as a trusted origin via ADMIN_DASHBOARD_URL. If nothing
  // is configured we send no Origin and rely on the backend's path
  // allowlist (`/v1/admin/`) instead.
  const explicit = (
    process.env.ADMIN_DASHBOARD_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.VERCEL_URL
  )?.trim();
  if (!explicit) return null;
  const candidate = explicit.startsWith("http")
    ? explicit
    : `https://${explicit}`;
  try {
    return new URL(candidate).origin;
  } catch {
    return null;
  }
};

export const backendApiRequest = async <T = unknown>(
  path: string,
  options: RequestOptions = {}
): Promise<T> => {
  const config = await resolveBackendApiConfig();
  const method = options.method ?? "GET";
  const url = `${config.baseUrl}${path}${buildQueryString(options.query)}`;

  // Backend sits behind a Cloudflare bot-protection gate that expects
  // `x-bypass-secret` for trusted server-to-server callers. Same pattern as
  // the user-facing frontend (CF_BYPASS_SECRET → x-bypass-secret); legacy
  // BACKEND_BYPASS_SECRET kept as fallback for envs that haven't been renamed.
  const bypassSecret =
    process.env.CF_BYPASS_SECRET || process.env.BACKEND_BYPASS_SECRET;

  const serverOrigin = resolveServerOrigin();

  const headers: Record<string, string> = {
    "x-api-key": config.adminKey,
    ...config.cfHeaders,
    ...(bypassSecret ? { "x-bypass-secret": bypassSecret } : {}),
    ...(serverOrigin ? { Origin: serverOrigin } : {}),
    ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...options.headers,
  };

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Diagnostic context shared across success/error branches. Includes which
  // env was selected, where the request went, key tail (safe to log; full
  // key never appears) and which side-channel headers were attached.
  const ctx =
    `env=${config.env}` +
    ` method=${method}` +
    ` url=${url}` +
    ` adminKeyTail=...${config.adminKey.slice(-6)}` +
    ` cfHeaders=${Object.keys(config.cfHeaders).length > 0}` +
    ` bypassSecret=${bypassSecret ? "set" : "missing"}`;

  // Bounded retry for transient 429/503 on idempotent GETs only.
  // Mutations (POST/PUT/PATCH/DELETE) get exactly one attempt.
  const maxRetries = method === "GET" ? MAX_GET_RETRIES : 0;

  for (let attempt = 0; ; attempt++) {
    // Combine the (default) 8s timeout with an optional caller-supplied
    // signal. AbortSignal.any() fires as soon as the FIRST of the inputs
    // aborts — so callers can still cancel on user navigation, while the
    // timeout still kicks in on a stuck upstream. Pass `signal: null` or
    // `timeoutMs: 0` to opt out of the default cap. The timeout signal is
    // created fresh PER ATTEMPT so a retry gets the full budget instead
    // of inheriting whatever the first attempt + backoff already burned.
    const signals: AbortSignal[] = [];
    if (options.signal) signals.push(options.signal);
    if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
    const fetchSignal: AbortSignal | undefined =
      signals.length === 0
        ? undefined
        : signals.length === 1
          ? signals[0]
          : AbortSignal.any(signals);

    // Wrap the fetch in try/catch so DNS / TCP / TLS failures throw a
    // structured BackendNetworkError with the URL + underlying cause
    // instead of a bare "fetch failed". Without this every caller just
    // sees the cryptic stock message and ops can't tell whether the
    // host is wrong, the port is wrong, or TLS is broken. Network
    // failures are NOT retried — only 429/503 responses below are.
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body:
          options.body !== undefined ? JSON.stringify(options.body) : undefined,
        cache: options.cache ?? "no-store",
        signal: fetchSignal,
      });
    } catch (err) {
      const networkErr = new BackendNetworkError(url, err);
      console.log(
        `[backend-api] network failure env=${config.env} method=${method} url=${url} code=${networkErr.causeCode ?? "unknown"} cause=${networkErr.causeMessage ?? "(none)"} cfHeaders=${Object.keys(config.cfHeaders).length > 0}`,
      );
      throw networkErr;
    }

    if (res.ok) {
      return ((await safeJson(res)) ?? {}) as T;
    }

    if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
      const retryAfterMs = parseRetryAfterMs(res);
      // Honor Retry-After when present — but if the server asks us to
      // wait longer than the cap, give up now instead of pinning the
      // handler (hammering early would just earn another 429 anyway).
      if (retryAfterMs === null || retryAfterMs <= MAX_RETRY_DELAY_MS) {
        // Exponential backoff with jitter: ~250–500ms, then ~500–1000ms.
        // When Retry-After is present, use it plus a little jitter so
        // concurrent fan-out legs don't all re-fire on the same tick.
        const expo = RETRY_BASE_DELAY_MS * 2 ** attempt;
        const delayMs = Math.min(
          retryAfterMs !== null
            ? retryAfterMs + Math.random() * RETRY_BASE_DELAY_MS
            : expo + Math.random() * expo,
          MAX_RETRY_DELAY_MS,
        );
        // Drain the body so the connection can be reused for the retry.
        await safeJson(res);
        console.log(
          `[backend-api] transient ${res.status} — retrying ${ctx} attempt=${attempt + 1}/${maxRetries + 1} delayMs=${Math.round(delayMs)} retryAfter=${retryAfterMs ?? "none"}`,
        );
        await sleep(delayMs, options.signal);
        continue;
      }
    }

    const payload = ((await safeJson(res)) ?? {}) as BackendErrorPayload;
    const message =
      payload.message ||
      payload.error ||
      `Backend request failed: ${res.status} ${res.statusText}`;
    // Terminal-only diagnostic logs — console.log (not .error) so Next.js
    // doesn't surface them in the browser error overlay. The real error is
    // the thrown BackendApiError below; these lines are for grepability.
    if (res.status === 401 || res.status === 403) {
      console.log(
        `[backend-api] auth rejected ${ctx} status=${res.status} backendMessage="${message}" payload=${JSON.stringify(payload)}`,
      );
    } else if (res.status >= 500) {
      console.log(
        `[backend-api] server error ${ctx} status=${res.status} payload=${JSON.stringify(payload)}`,
      );
    } else {
      // 4xx other than auth — useful to see during validation/logic errors
      console.log(
        `[backend-api] request failed ${ctx} status=${res.status} payload=${JSON.stringify(payload)}`,
      );
    }
    throw new BackendApiError(res.status, message, payload);
  }
};

export const backendApi = {
  get: <T = unknown>(
    path: string,
    opts: Omit<RequestOptions, "method" | "body"> = {}
  ) => backendApiRequest<T>(path, { ...opts, method: "GET" }),

  post: <T = unknown>(
    path: string,
    body: unknown = {},
    opts: Omit<RequestOptions, "method" | "body"> = {}
  ) => backendApiRequest<T>(path, { ...opts, method: "POST", body }),

  put: <T = unknown>(
    path: string,
    body: unknown = {},
    opts: Omit<RequestOptions, "method" | "body"> = {}
  ) => backendApiRequest<T>(path, { ...opts, method: "PUT", body }),

  patch: <T = unknown>(
    path: string,
    body: unknown = {},
    opts: Omit<RequestOptions, "method" | "body"> = {}
  ) => backendApiRequest<T>(path, { ...opts, method: "PATCH", body }),

  delete: <T = unknown>(
    path: string,
    body: unknown = undefined,
    opts: Omit<RequestOptions, "method" | "body"> = {}
  ) => backendApiRequest<T>(path, { ...opts, method: "DELETE", body }),
};
