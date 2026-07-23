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

/** Not configured is a valid state — the feature is simply off. */
export function isBotWebhookConfigured(): boolean {
  return Boolean(
    process.env.DISCORD_BOT_WEBHOOK_URL &&
      process.env.DISCORD_BOT_WEBHOOK_SECRET,
  );
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
  const url = process.env.DISCORD_BOT_WEBHOOK_URL;
  const secret = process.env.DISCORD_BOT_WEBHOOK_SECRET;
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
