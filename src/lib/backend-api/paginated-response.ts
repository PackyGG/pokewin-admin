export type PaginatedResponse<T> = {
  data: T[];
  total: number;
  offset: number;
  limit: number;
};

/**
 * Validate the backend's `{ success, data: Paginated<T> }` envelope at the
 * HTTP boundary. TypeScript response generics do not validate JSON at runtime;
 * treating a malformed 200 as a valid page only moves the failure into the
 * cache pager, where `slice.data` produces an unrelated TypeError and bypasses
 * the read client's PostgreSQL fallback.
 */
export function parsePaginatedSuccess<T>(
  payload: unknown,
  label: string,
): PaginatedResponse<T> {
  if (payload === null || typeof payload !== "object") {
    throw new TypeError(`${label} returned an invalid response envelope`);
  }

  const envelope = payload as { success?: unknown; data?: unknown };
  if (envelope.success !== true) {
    throw new TypeError(`${label} returned an unsuccessful response`);
  }

  const page = envelope.data;
  if (page === null || typeof page !== "object") {
    throw new TypeError(`${label} returned no paginated data`);
  }

  const candidate = page as Partial<PaginatedResponse<T>>;
  const isNonNegativeInteger = (value: unknown): value is number =>
    Number.isInteger(value) && Number(value) >= 0;
  if (
    !Array.isArray(candidate.data) ||
    !isNonNegativeInteger(candidate.total) ||
    !isNonNegativeInteger(candidate.offset) ||
    !Number.isInteger(candidate.limit) ||
    Number(candidate.limit) <= 0
  ) {
    throw new TypeError(`${label} returned malformed paginated data`);
  }

  return candidate as PaginatedResponse<T>;
}
