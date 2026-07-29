/**
 * Escape LIKE/ILIKE metacharacters (`\`, `%`, `_`) so user input matches
 * literally instead of widening the pattern — an unescaped "%" search
 * otherwise pattern-scans the whole table (LIMIT bounds the payload, not
 * the scan). PostgreSQL's default LIKE escape character is backslash, so
 * patterns built from this output work with plain Drizzle `ilike()`; raw
 * SQL sites may still spell `ESCAPE '\'` explicitly. Same convention as
 * buildUserListWhereClause (src/lib/queries/users-list.ts) and
 * searchMainSiteUsers (admin-users/[id]/actions.ts).
 */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`);
}
