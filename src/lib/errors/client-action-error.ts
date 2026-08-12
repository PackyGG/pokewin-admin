const OPAQUE_SERVER_ACTION_ERROR =
  /(?:server components render|server action|error digest|digest:\s*[a-z0-9]+)/i;

/**
 * Keep framework-generated production digests out of operator-facing toasts.
 * Typed ServerActionResult failures should be preferred; this is the final
 * transport guard for legacy actions and genuine network failures.
 */
export function clientActionError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  if (!message || OPAQUE_SERVER_ACTION_ERROR.test(message)) return fallback;
  return message;
}
