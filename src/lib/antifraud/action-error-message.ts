/**
 * Shared error-message narrowing for antifraud server actions.
 *
 * Antifraud actions touch Postgres, the Whop SDK and the monitor/backend
 * services. Returning a raw `error.message` to the browser leaks constraint
 * and column names, SDK internals and fetch/DNS details to anyone who can
 * reach the page. This is the house solution (originally local to
 * `refunds/refund-actions.ts`): only messages we deliberately authored for
 * an operator pass through; everything else collapses to a fallback.
 *
 * Two layers, in order:
 *  1. INFRASTRUCTURE_NOISE — a hard denylist. Anything that looks like a
 *     driver / Postgres / network error is replaced even if it happens to
 *     contain an allowlisted word (e.g. a column literally named `reason`).
 *  2. OPERATOR_MESSAGES — the allowlist of phrases that only appear in
 *     messages we wrote for staff, and are safe + useful to show.
 */

/** Shapes only a driver, Postgres, or the network produces. */
const INFRASTRUCTURE_NOISE =
  /(?:violates |constraint "|relation "|column "|table "|syntax error at or near|invalid input syntax|duplicate key value|deadlock detected|SQLSTATE|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|getaddrinfo|socket hang up|fetch failed|self[- ]signed certificate|at [A-Za-z_$][\w$]*\s*\()/i;

/**
 * Phrases that only occur in messages authored for an operator.
 *
 * The first group is the original refund set — kept verbatim so the refunds
 * workspace behaves exactly as before. The rest cover the Fiat deposit
 * review / resolution and the Fiat config toggles.
 */
const OPERATOR_MESSAGES: RegExp[] = [
  // Refunds (verbatim from the original local copy).
  /(?:2FA|passkey|verification|already used|confirmation|reason|select at least|select at most|eligible selection|refundable deposits|already in refund batches|more than [\d,]+ refundable)/i,
  // Fiat deposit review + declined-deposit resolution.
  /already decided this deposit/i,
  /belongs to another company/i,
  /no longer exists/i,
  /no longer active/i,
  /could not be banned/i,
  /refresh and try again/i,
  /can be reviewed here/i,
  // Fiat config toggles (monitor / backend service states).
  /(?:is|are) not configured/i,
  /did not respond/i,
  /rejected the [\w -]*credentials/i,
  /could not be saved/i,
  /returned an invalid/i,
  /too many .* right now/i,
  // Authorization / gate messages.
  /you do not have permission to/i,
  /only owners and admins can/i,
];

export const DEFAULT_ACTION_ERROR =
  "The operation could not be completed. No automatic retry was made.";

/**
 * Narrow an unknown thrown value to a message that is safe to send to the
 * browser. `fallback` is what an unrecognised error becomes.
 */
export function actionErrorMessage(
  error: unknown,
  fallback: string = DEFAULT_ACTION_ERROR,
): string {
  const message = error instanceof Error ? error.message : "";
  if (!message) return fallback;
  if (INFRASTRUCTURE_NOISE.test(message)) return fallback;
  if (OPERATOR_MESSAGES.some((pattern) => pattern.test(message))) {
    return message;
  }
  return fallback;
}
