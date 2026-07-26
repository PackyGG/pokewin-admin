type ErrorWithPostgresDetails = {
  code?: unknown;
  cause?: unknown;
  message?: unknown;
};

/**
 * Return the SQLSTATE emitted by node-postgres, including errors wrapped by
 * DrizzleQueryError. PostgreSQL SQLSTATE values are always five alphanumeric
 * characters; ignoring other `code` values avoids confusing application error
 * codes with database failures.
 */
export function postgresErrorCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = error;

  while (
    typeof current === "object" &&
    current !== null &&
    !seen.has(current)
  ) {
    seen.add(current);
    const details = current as ErrorWithPostgresDetails;
    if (
      typeof details.code === "string" &&
      /^[0-9A-Z]{5}$/.test(details.code) &&
      !/^P20[0-9]{2}$/.test(details.code)
    ) {
      return details.code;
    }
    current = details.cause;
  }

  return undefined;
}

export function isPostgresError(
  error: unknown,
  ...sqlStates: readonly string[]
): boolean {
  const code = postgresErrorCode(error);
  return code !== undefined && sqlStates.includes(code);
}

export function postgresErrorMessages(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;

  while (
    typeof current === "object" &&
    current !== null &&
    !seen.has(current)
  ) {
    seen.add(current);
    const details = current as ErrorWithPostgresDetails;
    if (typeof details.message === "string") messages.push(details.message);
    current = details.cause;
  }

  return messages.join("\n");
}
