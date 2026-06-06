/**
 * Shape checks for ID-typed route params.
 *
 * Several admin pages take a `[id]` (or `[userId]`) URL segment and feed
 * it straight into a query against a Postgres column typed `@db.Uuid`.
 * If the value isn't UUID-shaped, Postgres raises `invalid input syntax
 * for type uuid` which surfaces as a 500 to the user. Stale bookmarks,
 * crawlers, and copy/paste mishaps all hit this cleanly.
 *
 * Shape-check the param BEFORE any DB call and `notFound()` cleanly when
 * it can't possibly be a real id. Mirrors the inline guard in
 * /users/[id]/page.tsx so every detail route follows the same pattern.
 */

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** better-auth nanoid-style user ids (21–64 alphanumeric chars). */
const USER_ID_REGEX = /^[A-Za-z0-9_-]{21,64}$/;

export function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

/**
 * Shape check for packy.gg end-user primary keys (nanoid-style strings).
 * Usernames cap at 20 chars, so 21+ avoids routing a handle search
 * through the id fast path.
 */
export function isUserId(value: string): boolean {
  return USER_ID_REGEX.test(value);
}
