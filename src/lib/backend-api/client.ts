import "server-only";

import { resolveBackendApiConfig } from "./config";
import {
  BackendApiError,
  BackendNetworkError,
  type BackendErrorPayload,
} from "./errors";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type RequestOptions = {
  method?: HttpMethod;
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Extra headers. Merged LAST, so callers can override if needed. */
  headers?: Record<string, string>;
  /** Next.js fetch cache control. Defaults to 'no-store'. */
  cache?: RequestCache;
};

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
export const backendApiRequest = async <T = unknown>(
  path: string,
  options: RequestOptions = {}
): Promise<T> => {
  const config = await resolveBackendApiConfig();
  const method = options.method ?? "GET";
  const url = `${config.baseUrl}${path}${buildQueryString(options.query)}`;

  const headers: Record<string, string> = {
    "x-api-key": config.adminKey,
    ...config.cfHeaders,
    ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...options.headers,
  };

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
    });
  } catch (err) {
    const networkErr = new BackendNetworkError(url, err);
    // eslint-disable-next-line no-console
    console.log(
      `[backend-api] network failure env=${config.env} method=${method} url=${url} code=${networkErr.causeCode ?? "unknown"} cause=${networkErr.causeMessage ?? "(none)"} cfHeaders=${Object.keys(config.cfHeaders).length > 0}`,
    );
    throw networkErr;
  }

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
        `[backend-api] auth rejected env=${config.env} method=${method} url=${url} status=${res.status} adminKeyTail=...${config.adminKey.slice(-6)} cfHeaders=${Object.keys(config.cfHeaders).length > 0}`,
      );
    } else if (res.status >= 500) {
      // eslint-disable-next-line no-console
      console.log(
        `[backend-api] server error env=${config.env} method=${method} url=${url} status=${res.status} payload=${JSON.stringify(payload)}`,
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

  patch: <T = unknown>(
    path: string,
    body: unknown = {},
    opts: Omit<RequestOptions, "method" | "body"> = {}
  ) => backendApiRequest<T>(path, { ...opts, method: "PATCH", body }),

  delete: <T = unknown>(
    path: string,
    opts: Omit<RequestOptions, "method" | "body"> = {}
  ) => backendApiRequest<T>(path, { ...opts, method: "DELETE" }),
};
