import { z } from "zod";
import { eq } from "drizzle-orm";

import { getProdReadDrizzleDb } from "@/lib/db";
import { account } from "@/lib/db-schema/main/schema";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { checkApiSubjectRateLimit } from "@/lib/api-auth/rate-limit";
import {
  REWARD_QUERY_TIMEOUT_MS,
  safeQueryOrNull,
} from "@/lib/errors/safe-query";
import { getPlayerRewardSummary } from "@/lib/creator-vip/queries";

/**
 * POST /api/v1/discord/info — the player's own summary card.
 *
 * Username, Packy user id, the code they're on and how long is left on it,
 * plus rewards open / awaiting review / claimed to date.
 *
 * ── THIS ONE RETURNS PROFILE DATA, AND THAT IS A DELIBERATE EXCEPTION ─────
 * Every other endpoint on this surface is built so a leaked bot token cannot
 * profile players: `/discord/linked` answers a bare boolean precisely so it
 * can't be used to enumerate. This endpoint breaks that on purpose — it
 * returns a username and the internal user id — so it carries its OWN scope,
 * `discord:info:read`. Grant it only to a bot that genuinely renders a
 * player-facing card, and do NOT fold it into the other Discord scopes; a key
 * that can check links should not automatically be able to read identities.
 *
 * ── EXPIRED ≠ SWITCHED ────────────────────────────────────────────────────
 * `codeSecondsRemaining` / `codeExpired` are INFORMATIONAL. An expired code
 * does not stop anyone claiming what they already earned — the attribution
 * merely lapsed and no new wager books until they re-enter it. Only moving to
 * a DIFFERENT creator's code forfeits rewards, and that rule lives in
 * `computeEntitlement`, not here. Don't let bot copy imply otherwise.
 *
 * Numbers come from the same `computeAllEntitlements` behind `/check`, so the
 * two commands can never quote different figures.
 *
 * DATA BOUNDARY: reads prod read-only (`getProdReadDrizzleDb()`) plus the admin
 * DB for claim totals.
 *
 * NOT write-free, despite the read-only scope. `getPlayerRewardSummary` runs
 * `computeAllEntitlements`, which calls `enforceOfferExpiry` — that materialises
 * `creator_reward_offer_windows` rows and therefore STARTS the offer clock as a
 * side effect of merely looking. It is inherent to how an offer gets an expiry
 * at all (an offer nobody has seen has no deadline to run), but it means a
 * `discord:info:read` key mutates the admin DB. Documented here because this
 * comment previously claimed "Writes nothing", which was false.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deliberately NOT `.strict()`.
 *
 * Rejecting unknown keys sounds like hardening but buys nothing here: fields
 * we don't declare are never read, so ignoring them is exactly as safe as
 * refusing them. What it DOES do is break every caller that sends harmless
 * extra context — a Discord bot forwarding a guild id, an interaction id or a
 * username alongside the payload — turning a working integration into a 400
 * on every request. That is precisely what happened on 2026-07-22: `.strict()`
 * shipped at 23:50 and every endpoint began failing for the live bot.
 *
 * The real validation is below and is unchanged: the Discord id must be a
 * numeric snowflake, and a claim id must be a well-formed prefixed UUID.
 */
const BodySchema = z
  .object({
    discordUserId: z
      .string()
      .trim()
      // 17–20 digits, matching the ONLY caller: the rewards bot validates
      // `^\d{17,20}$` before every request (adminApi.js `fetchInfo`). The old
      // `{15,21}` was looser than anything that can reach here.
      .regex(/^\d{17,20}$/, "discordUserId must be a numeric Discord user ID"),
  });

/**
 * Per-player ceiling for the profile card, ON TOP OF the key's own budget.
 *
 * This is the endpoint that returns a username and the internal user id, so
 * repeat pulls on one id are exactly what shouldn't be cheap. The bot throttles
 * to 4/min per user client-side, which a leaked key doesn't run. NOTE the real
 * shape of the protection: an attacker walking DIFFERENT ids never trips this —
 * enumeration is bounded only by the per-key budget and by not granting
 * `discord:info:read` widely.
 */
const SUBJECT_LIMIT_PER_MIN = 15;

export const POST = withApiKey(
  { scopes: ["discord:info:read"] },
  async (request) => {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return apiError(400, "invalid_json", "Request body must be valid JSON.");
    }

    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return apiError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ??
          "Expected a JSON body of { discordUserId: string }.",
      );
    }

    const { discordUserId } = parsed.data;

    // Before the account probe: an unlinked id must cost the same as a linked
    // one, or the limiter itself becomes a cheap linked/not-linked oracle.
    const subjectRate = await checkApiSubjectRateLimit(
      "discord-info",
      discordUserId,
      SUBJECT_LIMIT_PER_MIN,
    );
    if (!subjectRate.allowed) {
      return apiError(
        429,
        "rate_limited",
        "Too many requests for this Discord account. Try again shortly.",
        subjectRate,
      );
    }

    // Single index probe on the unique accountId. providerId is asserted so a
    // same-valued account on another provider can't resolve to a Packy user.
    const [linkedAccount] = await getProdReadDrizzleDb()
      .select({ providerId: account.providerId, userId: account.userId })
      .from(account)
      .where(eq(account.accountId, discordUserId))
      .limit(1);
    if (!linkedAccount || linkedAccount.providerId !== "discord") {
      return apiError(
        404,
        "not_linked",
        "That Discord account is not linked to a Packy account.",
      );
    }

    // Bounded, and degraded to a clean 503 rather than a hung request.
    // `getPlayerRewardSummary` fans out across both databases via
    // `computeAllEntitlements`, so a slow MAIN read used to hold this
    // connection until the platform killed it — the bot saw a socket error it
    // has no branch for, instead of a retriable status. `/check` already
    // isolates the same subsystem; this endpoint can't degrade partially,
    // because the summary IS the response, so it fails cleanly instead.
    const summary = await safeQueryOrNull(
      () => getPlayerRewardSummary(linkedAccount.userId),
      "api.discord.info.summary",
      REWARD_QUERY_TIMEOUT_MS,
    );
    if (summary.data === null) {
      return apiError(
        503,
        "temporarily_unavailable",
        "Couldn't read reward totals right now. Try again shortly.",
      );
    }

    return { discordUserId, ...summary.data };
  },
);
