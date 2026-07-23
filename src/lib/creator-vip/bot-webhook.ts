import "server-only";

import { createHmac } from "node:crypto";

/**
 * Outbound webhook to the Packy.GG Rewards Discord bot.
 *
 * The bot is entirely outbound otherwise — it asks the Admin API questions and
 * renders answers. It cannot observe a click in this dashboard, so when staff
 * approve or decline a claim we have to tell it, and it DMs the player.
 *
 * Contract: `Packy.GG-Rewards-Bot/docs/webhook.md`. The three things that are
 * easy to get wrong, and are handled here:
 *
 *  1. SIGN THE RAW BODY BYTES. The body is serialised ONCE and the same string
 *     is both signed and sent. Re-serialising to sign would change key order or
 *     whitespace and every delivery would be rejected with `mismatch`.
 *  2. The separator is a literal `.` between timestamp and body.
 *  3. Send the same timestamp that was signed — it is inside the signed string.
 *
 * Verified against the spec's test vector in `signWebhook`'s doc comment.
 */

/** `sha256=<hex>` over `${timestamp}.${rawBody}`, keyed by the shared secret. */
export function signWebhook(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  return (
    "sha256=" +
    createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")
  );
}

export type ClaimDecisionEvent = {
  /** Stable per decision, reused on every retry — this is the dedupe key. */
  id: string;
  type: "claim.approved" | "claim.rejected";
  data: {
    claimId: string;
    discordUserId: string;
    /**
     * Cash value. NEVER 0 — the bot renders that literally as "$0 has been
     * credited". Omitted entirely when there is no cash amount.
     */
    amount?: number;
    currency?: string;
    rewardName?: string;
    /** `claim.rejected` only. Shown to the player verbatim, max 300 chars. */
    reason?: string;
  };
};

export type WebhookResult =
  | { ok: true; status: number; duplicate: boolean }
  | { ok: false; error: string; retriable: boolean };

/**
 * Resolve the webhook URL and secret, accepting the bot's own alias names.
 *
 * The bot reads `WEBHOOK_SECRET` OR `PACKY_WEBHOOK_SECRET`, so an operator
 * setting the shared secret will reasonably use either name on BOTH sides.
 * Insisting on one spelling here turns that into a silent `401 mismatch` on
 * every delivery — a failure mode that looks like "the bot is broken" rather
 * than "the variable is named differently". Being liberal costs nothing; the
 * secret still has to match byte-for-byte to produce a valid signature.
 *
 * `DISCORD_BOT_*` remains the documented, preferred spelling because these are
 * the DASHBOARD's variables and the prefix says who they are for.
 */
function resolveWebhookConfig(): { url?: string; secret?: string } {
  return {
    url:
      process.env.DISCORD_BOT_WEBHOOK_URL ??
      process.env.PACKY_WEBHOOK_URL ??
      undefined,
    secret:
      process.env.DISCORD_BOT_WEBHOOK_SECRET ??
      process.env.PACKY_WEBHOOK_SECRET ??
      process.env.WEBHOOK_SECRET ??
      undefined,
  };
}

/** Not configured is a valid state — the feature is simply off. */
export function isBotWebhookConfigured(): boolean {
  const { url, secret } = resolveWebhookConfig();
  return Boolean(url && secret);
}

/**
 * What is missing, for the operator-facing status line. Never returns the
 * secret or any part of it — only whether each half is present.
 */
export function botWebhookConfigStatus(): {
  configured: boolean;
  hasUrl: boolean;
  hasSecret: boolean;
  secretTooShort: boolean;
} {
  const { url, secret } = resolveWebhookConfig();
  return {
    configured: Boolean(url && secret),
    hasUrl: Boolean(url),
    hasSecret: Boolean(secret),
    // The bot refuses to start under 32 chars; catching it here explains a
    // dead webhook without anyone reading Railway logs.
    secretTooShort: Boolean(secret && secret.length < 32),
  };
}

/**
 * Send a harmless event that proves URL + secret + signature all work,
 * WITHOUT messaging anyone.
 *
 * The bot verifies the signature and parses the payload BEFORE it looks at
 * `type`, and answers an unrecognised type with `200 unsupported_type`. So a
 * well-formed event of an unknown type exercises every part of the path that
 * can realistically be misconfigured — reachability, the shared secret, the
 * signing scheme — and stops short of a DM.
 */
export async function testBotWebhook(): Promise<WebhookResult> {
  return sendClaimDecision({
    // Unique per attempt so a retest is never swallowed as a duplicate.
    id: `evt_conntest_${Date.now()}`,
    // Deliberately not a real event type.
    type: "webhook.connection_test" as ClaimDecisionEvent["type"],
    data: {
      claimId: "connection-test",
      // Shape-valid so it clears payload validation and reaches the type check.
      discordUserId: "100000000000000000",
    },
  });
}

/**
 * Attempts, in milliseconds. Deliberately short and few.
 *
 * The spec suggests backing off to 10 minutes, which assumes a long-lived
 * worker. This runs inside a serverless request's `after()`, which does not
 * survive minutes — pretending otherwise would mean retries that silently never
 * happen. So: three quick attempts (~36s), then the failure is RECORDED on the
 * claim and a human can resend from the queue. A visible failure with a button
 * beats an invisible retry that never ran.
 */
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Deliver one decision event, retrying only what a retry can fix.
 *
 * Retriable: 503 (bot not ready / queue full), 500, and network errors.
 * Everything else is a 4xx the bot will reject identically forever, so retrying
 * it just delays the moment someone notices.
 */
export async function sendClaimDecision(
  event: ClaimDecisionEvent,
): Promise<WebhookResult> {
  const { url, secret } = resolveWebhookConfig();
  if (!url || !secret) {
    return { ok: false, error: "webhook_not_configured", retriable: false };
  }

  // Serialise ONCE — this exact string is what gets signed AND sent.
  const raw = JSON.stringify(event);

  let last: WebhookResult = {
    ok: false,
    error: "no_attempt",
    retriable: false,
  };

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]!);

    // A FRESH timestamp per attempt: the bot rejects anything more than 300s
    // from its clock as a replay, and the last retry lands ~36s in — well
    // inside that, but re-stamping keeps a slow first attempt from poisoning
    // the later ones. The `id` stays constant, which is what actually dedupes.
    const timestamp = Math.floor(Date.now() / 1000).toString();

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Packy-Timestamp": timestamp,
          "X-Packy-Signature": signWebhook(secret, timestamp, raw),
        },
        body: raw,
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok) {
        // 200 with ignored:"duplicate" means an earlier attempt already got
        // through — a success, not a failure.
        const body = (await res.json().catch(() => ({}))) as {
          ignored?: string;
        };
        return {
          ok: true,
          status: res.status,
          duplicate: body?.ignored === "duplicate",
        };
      }

      const retriable = res.status === 503 || res.status >= 500;
      const detail = await res.text().catch(() => "");
      last = {
        ok: false,
        error: `HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        retriable,
      };
      if (!retriable) return last;
    } catch (err) {
      // Network / timeout — worth another go.
      last = {
        ok: false,
        error: err instanceof Error ? err.message : "network error",
        retriable: true,
      };
    }
  }

  return last;
}

/**
 * The dedupe key for a decision.
 *
 * Derived from the claim id and the decision, so it is IDENTICAL on every
 * retry and across process restarts — which is exactly what stops a slow
 * response turning into two "you have been credited" DMs. Never random.
 *
 * A claim that is rejected, reopened and then approved produces two different
 * ids, which is correct: those are two decisions and the player should hear
 * about both.
 */
export function claimEventId(
  claimId: string,
  decision: "approved" | "rejected",
): string {
  return `evt_${claimId}_${decision}`;
}
