export class PostgresResultError extends TypeError {
  constructor(
    readonly path: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`Invalid PostgreSQL result at ${path}: ${message}`, options);
    this.name = "PostgresResultError";
  }
}

export type PostgresDecoder<T> = (value: unknown, path: string) => T;

type DecodedShape<T extends Record<string, unknown>> = {
  readonly [K in keyof T]: PostgresDecoder<T[K]>;
};

const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const INTEGER_PATTERN = /^[+-]?\d+$/;

function fail(path: string, expected: string, value: unknown): never {
  const actual =
    value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : typeof value;
  throw new PostgresResultError(path, `expected ${expected}, received ${actual}`);
}

export function postgresTimestamp(
  value: unknown,
  path = "value",
): Date {
  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) return new Date(value.getTime());
    throw new PostgresResultError(path, "received an invalid Date");
  }
  if (typeof value !== "string" || value.trim() === "") {
    return fail(path, "a timestamp string or Date", value);
  }

  // PostgreSQL `timestamp without time zone` values have no offset. The app
  // stores and reads them as UTC, so make that contract explicit instead of
  // letting the server's local timezone affect parsing.
  const normalized = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value)
    ? value
    : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new PostgresResultError(path, `invalid timestamp ${JSON.stringify(value)}`);
  }
  return parsed;
}

export function postgresTimestampIso(
  value: unknown,
  path = "value",
): string {
  return postgresTimestamp(value, path).toISOString();
}

/** Preserve PostgreSQL NUMERIC exactly. Convert to number only at a display boundary. */
export function postgresNumeric(
  value: unknown,
  path = "value",
): string {
  if (typeof value === "string" && DECIMAL_PATTERN.test(value.trim())) {
    return value.trim();
  }
  if (typeof value === "bigint") return value.toString();
  // Accepting a JS number here would certify a value after precision may
  // already have been lost. Raw NUMERIC must remain text end-to-end.
  return fail(path, "an exact PostgreSQL numeric string", value);
}

/** Parse PostgreSQL integer/count values without silently losing precision. */
export function postgresSafeInteger(
  value: unknown,
  path = "value",
): number {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  } else if (typeof value === "string" && INTEGER_PATTERN.test(value.trim())) {
    parsed = BigInt(value.trim());
  } else {
    return fail(path, "a safe integer", value);
  }

  const numberValue = Number(parsed);
  if (!Number.isSafeInteger(numberValue)) {
    throw new PostgresResultError(
      path,
      `integer ${parsed.toString()} exceeds JavaScript's safe range`,
    );
  }
  return numberValue;
}

export function postgresBigInt(
  value: unknown,
  path = "value",
): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && INTEGER_PATTERN.test(value.trim())) {
    return BigInt(value.trim());
  }
  return fail(path, "an integer", value);
}

export function postgresJson<T>(
  value: unknown,
  decoder: PostgresDecoder<T>,
  path = "value",
): T {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (error) {
      throw new PostgresResultError(path, "invalid JSON text", { cause: error });
    }
  }
  return decoder(parsed, path);
}

export function nullable<T>(
  decoder: PostgresDecoder<T>,
): PostgresDecoder<T | null> {
  return (value, path) => (value == null ? null : decoder(value, path));
}

export function postgresString(value: unknown, path = "value"): string {
  return typeof value === "string" ? value : fail(path, "a string", value);
}

export function postgresBoolean(value: unknown, path = "value"): boolean {
  return typeof value === "boolean" ? value : fail(path, "a boolean", value);
}

export function postgresArray<T>(
  itemDecoder: PostgresDecoder<T>,
): PostgresDecoder<T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) return fail(path, "an array", value);
    return value.map((item, index) => itemDecoder(item, `${path}[${index}]`));
  };
}

export function postgresObject<T extends Record<string, unknown>>(
  shape: DecodedShape<T>,
): PostgresDecoder<T> {
  return (value, path) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return fail(path, "an object", value);
    }

    const source = value as Record<string, unknown>;
    const decoded = {} as T;
    for (const key of Object.keys(shape) as Array<keyof T>) {
      decoded[key] = shape[key](source[String(key)], `${path}.${String(key)}`);
    }
    return decoded;
  };
}

export function decodePostgresRows<T>(
  rows: readonly unknown[],
  decoder: PostgresDecoder<T>,
): T[] {
  return rows.map((row, index) => decoder(row, `rows[${index}]`));
}
