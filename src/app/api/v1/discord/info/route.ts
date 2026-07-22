import { z } from "zod";

import { getProdDb } from "@/lib/db";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
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
 * DATA BOUNDARY: reads prod read-only (`getProdDb()`, never `getDb()`) plus
 * the admin DB for claim totals. Writes nothing.
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
      .regex(/^\d{15,21}$/, "discordUserId must be a numeric Discord user ID"),
  });

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

    // Single index probe on the unique accountId. providerId is asserted so a
    // same-valued account on another provider can't resolve to a Packy user.
    const account = await getProdDb().account.findUnique({
      where: { accountId: discordUserId },
      select: { providerId: true, userId: true },
    });
    if (!account || account.providerId !== "discord") {
      return apiError(
        404,
        "not_linked",
        "That Discord account is not linked to a Packy account.",
      );
    }

    const summary = await getPlayerRewardSummary(account.userId);
    return { discordUserId, ...summary };
  },
);
