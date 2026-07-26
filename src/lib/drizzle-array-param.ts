import { sql } from "drizzle-orm";

/**
 * Bind a JavaScript array as one PostgreSQL parameter.
 *
 * Drizzle treats a bare array interpolated into a tagged `sql` template as a
 * list of SQL chunks, producing `($1, $2, ...)`. PostgreSQL's ANY/ALL and
 * unnest operators require one array value instead. Keep the PostgreSQL cast
 * at the call site so the database retains the exact element type.
 */
export function pgArrayParam<T>(values: readonly T[]) {
  return sql.param([...values]);
}
