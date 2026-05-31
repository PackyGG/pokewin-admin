/**
 * ServerActionResult — discriminated-union contract for Server Actions.
 *
 * ──────────────────────────────────────────────────────────────────────
 *  THE PATTERN (verbatim — future agents should follow this)
 * ──────────────────────────────────────────────────────────────────────
 *
 * Server-side ("use server"):
 *
 *   import { ok, fail } from "@/lib/errors/server-action-result";
 *
 *   export async function deleteThing(
 *     id: string,
 *   ): Promise<ServerActionResult<{ id: string }>> {
 *     const session = await requirePageAccess("/things");
 *     try {
 *       await db.thing.delete({ where: { id } });
 *     } catch (err) {
 *       logError("things.delete", `delete ${id} failed`, err);
 *       return fail("Couldn't delete this thing — please try again.");
 *     }
 *     revalidatePath("/things");
 *     return ok({ id });
 *   }
 *
 * Client-side ("use client"):
 *
 *   const result = await deleteThing(id);
 *   if (!result.success) {
 *     toast.error(result.error);
 *     return;
 *   }
 *   toast.success("Deleted");
 *
 * ──────────────────────────────────────────────────────────────────────
 *  WHY THIS PATTERN
 * ──────────────────────────────────────────────────────────────────────
 *
 *   1. No thrown errors crossing the RSC boundary. Next.js streams the
 *      error message verbatim to the client in dev and as a digest in
 *      prod — that's a leak risk (raw SQL fragments, internal IDs).
 *   2. The client always knows the shape; no `err instanceof Error`
 *      song and dance at every call site.
 *   3. Server-side, `logError` captures the full stack BEFORE we
 *      sanitize for the client — the on-call still has everything.
 *
 * ──────────────────────────────────────────────────────────────────────
 *  WHAT TO RETURN AS THE error STRING
 * ──────────────────────────────────────────────────────────────────────
 *
 *   • Business errors (invalid state, ownership mismatch, validation):
 *     surface a verbatim user-readable message. The toast will show it.
 *   • Unexpected crashes (DB unreachable, Prisma P-code, fetch fail):
 *     surface a generic "Something went wrong" message — the real
 *     error goes to `logError` so prod doesn't echo internals.
 *
 * NEVER include:
 *   - Raw SQL fragments
 *   - Connection strings
 *   - JWT / TOTP secrets
 *   - User-typed input (XSS risk on echo)
 *   - Stack traces
 *
 * ──────────────────────────────────────────────────────────────────────
 *  MIGRATION (existing throw-style actions)
 * ──────────────────────────────────────────────────────────────────────
 *
 * Don't migrate everything at once — pick the actions that callers
 * already handle defensively and convert them first. For one-off
 * `try/catch` -> result migrations, `tryServerAction` below wraps a
 * legacy thunk so you don't have to re-architect the whole action body.
 */

/**
 * Discriminated-union shape every migrated Server Action returns.
 *
 * `code` is optional but useful for the client when one action can
 * fail several ways and the UI needs to react differently to each
 * (e.g. `"NOT_FOUND"` vs `"FORBIDDEN"` vs `"RATE_LIMITED"`).
 */
export type ServerActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string; code?: string };

/**
 * Success constructor.
 *
 * `ok()` with no argument returns `{ success: true, data: undefined }` —
 * use when the action's return value is the act of completing, not
 * a payload.
 */
export function ok(): ServerActionResult<void>;
export function ok<T>(data: T): ServerActionResult<T>;
export function ok<T>(data?: T): ServerActionResult<T | void> {
  return { success: true, data: data as T };
}

/**
 * Failure constructor.
 *
 * `error` is the user-facing message that the client toasts. Keep it
 * short, actionable, and free of internal details (see "what NEVER
 * to include" above).
 *
 * `code` is an optional machine tag for the client (`"NOT_FOUND"`,
 * `"FORBIDDEN"`, etc.) when one action can fail several ways and the
 * UI needs to branch.
 */
export function fail(error: string, code?: string): ServerActionResult<never> {
  return { success: false, error, code };
}

/**
 * Wrap a legacy throw-style thunk so existing actions migrate
 * incrementally. The thunk is run inside a try/catch; an `Error`
 * surfaces its `.message` (subject to the rules above), anything else
 * falls back to `fallbackMessage`.
 *
 * Use sparingly — prefer rewriting actions to construct the result
 * directly (clearer intent, fewer indirection). This helper exists
 * for the migration phase, not as the long-term style.
 *
 * IMPORTANT: do not pass a thunk that you ALSO want the throw to
 * propagate from — once wrapped, every error becomes a non-throwing
 * `fail`. If the action has paths that must still throw (e.g.
 * `redirect()` / `notFound()`), call those OUTSIDE the wrap.
 */
export async function tryServerAction<T>(
  fn: () => Promise<T>,
  area: string,
  fallbackMessage = "Something went wrong — please try again.",
): Promise<ServerActionResult<T>> {
  try {
    return ok(await fn());
  } catch (err) {
    // Dynamic import keeps server-action-result.ts free of side-effects
    // for the type-only imports the client makes. The logger pulls
    // `console.error` only — no Node-specific APIs — so the dynamic
    // import resolves the same on Edge + Node.
    const { logError } = await import("./logger");
    logError(area, "wrapped action failed", err);
    if (err instanceof Error) {
      // Pass through the message verbatim. Callers that don't trust the
      // upstream message should pass their own try/catch instead of
      // using this wrapper.
      return fail(err.message, (err as { code?: string }).code);
    }
    return fail(fallbackMessage);
  }
}
