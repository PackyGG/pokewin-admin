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
