import "server-only";

export type BackendErrorPayload = {
  statusCode?: number;
  error?: string;
  message?: string;
  code?: string;
  [key: string]: unknown;
};

export class BackendApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly payload: BackendErrorPayload;

  constructor(
    status: number,
    message: string,
    payload: BackendErrorPayload = {}
  ) {
    super(message);
    this.name = "BackendApiError";
    this.status = status;
    this.code = typeof payload.code === "string" ? payload.code : null;
    this.payload = payload;
  }

  get isNotFound() {
    return this.status === 404;
  }
  get isConflict() {
    return this.status === 409;
  }
  get isUnauthorized() {
    return this.status === 401;
  }
  get isValidation() {
    return this.status === 400;
  }
}

/**
 * Thrown when fetch() itself fails before any HTTP response — DNS
 * lookup error, TCP connection refused, TLS handshake failure,
 * connection timeout, etc. Distinct from BackendApiError which is
 * for non-2xx responses (the request reached the server, the server
 * didn't like it). UI uses these separately so admins can tell
 * "backend is unreachable from this deploy" apart from "backend said
 * no".
 */
export class BackendNetworkError extends Error {
  readonly url: string;
  readonly causeCode: string | null;
  readonly causeMessage: string | null;

  constructor(url: string, cause: unknown) {
    // Pull diagnostic fields off the cause if it's the Node fetch
    // shape (always wraps the underlying TCP/TLS/DNS error in
    // `cause`). Common cause.code values:
    //   ENOTFOUND        DNS lookup failed (typo in host?)
    //   ECONNREFUSED     TCP refused (firewall / wrong port?)
    //   ECONNRESET       Server closed mid-handshake
    //   ETIMEDOUT        Took too long
    //   CERT_HAS_EXPIRED, UNABLE_TO_VERIFY_LEAF_SIGNATURE — TLS issues
    let code: string | null = null;
    let causeMessage: string | null = null;
    if (cause instanceof Error) {
      causeMessage = cause.message;
      const nestedCause = (cause as { cause?: unknown }).cause;
      if (nestedCause && typeof nestedCause === "object") {
        const c = nestedCause as { code?: unknown; message?: unknown };
        if (typeof c.code === "string") code = c.code;
        if (typeof c.message === "string") causeMessage = c.message;
      } else {
        const ownCode = (cause as { code?: unknown }).code;
        if (typeof ownCode === "string") code = ownCode;
      }
    }
    const detail = code ? `${code}: ${causeMessage ?? "(no detail)"}` : (causeMessage ?? "fetch failed");
    super(`Backend unreachable at ${url} — ${detail}`);
    this.name = "BackendNetworkError";
    this.url = url;
    this.causeCode = code;
    this.causeMessage = causeMessage;
  }
}
