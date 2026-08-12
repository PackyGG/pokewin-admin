import "server-only";

import { createHash } from "node:crypto";

import { enqueueDiscordEvent } from "@/lib/discord-notifications/router";
import { logError } from "@/lib/errors/logger";
import { safeErrorMessage } from "@/lib/errors/safe-error-message";
import {
  fail,
  ok,
  type ServerActionResult,
} from "@/lib/errors/server-action-result";
import { postgresErrorCode } from "@/lib/postgres-errors";

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
 * Three layers, in order:
 *  0. safeErrorMessage — collapses driver-shaped errors to a SQLSTATE summary
 *     and strips email/IP/URL/token/id shapes from everything else.
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
  /someone else changed/i,
  /already (?:closed|banned|unbanned)/i,
  /only a (?:live|new) review/i,
  /retry key was already used/i,
  /reload and (?:review|try) again/i,
];

export const DEFAULT_ACTION_ERROR =
  "The operation could not be completed. No automatic retry was made.";

/**
 * The single string both layers classify.
 *
 * Layer 0 matters because `DrizzleQueryError.message` is
 * ``Failed query: <SQL>\nparams: <bound values>`` and none of the
 * INFRASTRUCTURE_NOISE shapes appear in it — pg's quoted forms live on the
 * wrapped cause, not the wrapper. So a statement that merely selected a column
 * named `reason` satisfied OPERATOR_MESSAGES and shipped the SQL plus the
 * bound email / user id straight to the browser. Collapsing driver-shaped
 * errors first closes that, and the resulting `SQLSTATE …` summary is then
 * rejected by the denylist exactly like any other database failure.
 */
function classifiableMessage(error: unknown): string {
  if (!(error instanceof Error)) return "";
  return safeErrorMessage(error, "");
}

/**
 * Narrow an unknown thrown value to a message that is safe to send to the
 * browser. `fallback` is what an unrecognised error becomes.
 */
export function actionErrorMessage(
  error: unknown,
  fallback: string = DEFAULT_ACTION_ERROR,
): string {
  const message = classifiableMessage(error);
  if (!message) return fallback;
  if (INFRASTRUCTURE_NOISE.test(message)) return fallback;
  if (OPERATOR_MESSAGES.some((pattern) => pattern.test(message))) {
    return message;
  }
  return fallback;
}

/** Run a client-triggered Fraud mutation without throwing across Next's boundary. */
export async function antifraudActionResult<T>(
  area: string,
  fallback: string,
  run: () => Promise<T>,
): Promise<ServerActionResult<T>> {
  try {
    return ok(await run());
  } catch (error) {
    logError(area, "antifraud action failed", error);
    if (!isExpectedAntifraudActionError(error)) {
      await reportAntifraudActionError(area, error);
    }
    return fail(actionErrorMessage(error, fallback));
  }
}

function isExpectedAntifraudActionError(error: unknown): boolean {
  // Must classify the same string actionErrorMessage does, or a driver error
  // whose SQL happened to contain an allowlisted word counts as "expected" and
  // never reaches the Discord error queue.
  const message = classifiableMessage(error);
  if (!message) return false;
  if (INFRASTRUCTURE_NOISE.test(message)) return false;
  return OPERATOR_MESSAGES.some((pattern) => pattern.test(message));
}

async function reportAntifraudActionError(
  area: string,
  error: unknown,
): Promise<void> {
  const guildId = process.env.ADMIN_GUILD_ID;
  if (!guildId) return;

  const details = error instanceof Error
    ? (error as Error & { digest?: unknown })
    : null;
  const errorName = details?.name?.slice(0, 80) || "UnknownError";
  const digest = typeof details?.digest === "string"
    ? details.digest.slice(0, 128)
    : null;
  const sqlState = postgresErrorCode(error);
  const hourBucket = new Date().toISOString().slice(0, 13);
  const fingerprint = createHash("sha256")
    .update([area, errorName, digest ?? "", sqlState ?? "", hourBucket].join("|"))
    .digest("hex")
    .slice(0, 32);

  try {
    await enqueueDiscordEvent({
      guildId,
      eventKey: "antifraud.error.webapp",
      dedupeKey: `server-action:${fingerprint}`,
      embed: {
        title: "🚨 Fraud Server Action failed",
        description:
          "A staff-triggered Fraud mutation failed unexpectedly. Raw messages, inputs, and stack traces were excluded.",
        color: 0xed4245,
        fields: [
          { name: "Webapp", value: "fraud", inline: true },
          { name: "Source", value: "server-action", inline: true },
          { name: "Area", value: `\`${area.slice(0, 120)}\``, inline: false },
          {
            name: "Error",
            value: [
              errorName,
              sqlState ? `SQLSTATE ${sqlState}` : null,
              digest ? `digest ${digest}` : null,
            ]
              .filter(Boolean)
              .join(" · "),
            inline: false,
          },
        ],
        timestamp: new Date().toISOString(),
      },
    });
  } catch (reportingError) {
    logError(
      "antifraud.serverActionReporting",
      "Discord error enqueue failed",
      reportingError,
    );
  }
}
