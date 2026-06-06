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

  // Combine the (default) 8s timeout with an optional caller-supplied
  // signal. AbortSignal.any() fires as soon as the FIRST of the inputs
  // aborts — so callers can still cancel on user navigation, while the
  // timeout still kicks in on a stuck upstream. Pass `signal: null` or
  // `timeoutMs: 0` to opt out of the default cap.
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
  // host is wrong, the port is wrong, or TLS is broken.
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
    // eslint-disable-next-line no-console
    console.log(
      `[backend-api] network failure env=${config.env} method=${method} url=${url} code=${networkErr.causeCode ?? "unknown"} cause=${networkErr.causeMessage ?? "(none)"} cfHeaders=${Object.keys(config.cfHeaders).length > 0}`,
    );
    throw networkErr;
  }

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

  if (!res.ok) {
    const payload = ((await safeJson(res)) ?? {}) as BackendErrorPayload;
    const message =
      payload.message ||
      payload.error ||
      `Backend request failed: ${res.status} ${res.statusText}`;
    // Terminal-only diagnostic logs — console.log (not .error) so Next.js
    // doesn't surface them in the browser error overlay. The real error is
    // the thrown BackendApiError below; these lines are for grepability.
    if (res.status === 401 || res.status === 403) {
      // eslint-disable-next-line no-console
      console.log(
        `[backend-api] auth rejected ${ctx} status=${res.status} backendMessage="${message}" payload=${JSON.stringify(payload)}`,
      );
    } else if (res.status >= 500) {
      // eslint-disable-next-line no-console
      console.log(
        `[backend-api] server error ${ctx} status=${res.status} payload=${JSON.stringify(payload)}`,
      );
    } else {
      // 4xx other than auth — useful to see during validation/logic errors
      // eslint-disable-next-line no-console
      console.log(
        `[backend-api] request failed ${ctx} status=${res.status} payload=${JSON.stringify(payload)}`,
      );
    }
    throw new BackendApiError(res.status, message, payload);
  }

  return ((await safeJson(res)) ?? {}) as T;
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
