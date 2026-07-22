import { z } from "zod";

import { getProdDb } from "@/lib/db";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";

/**
 * POST /api/v1/discord/linked — is this Discord user linked to a Packy account?
 *
 * Built for the rewards Discord bot: given a Discord user ID, answer yes/no so
 * the bot can decide whether the member is eligible.
 *
 * WHY POST (not GET): the Discord user ID is personal data. A GET would put it
 * in the URL, where it lands in access logs, proxy logs and error trackers. A
 * POST body keeps it out of all of those.
 *
 * PRIVACY: the response is deliberately a BOOLEAN and nothing else. It never
 * returns the Packy user id, username, email or balance — so a leaked bot token
 * cannot be used to enumerate or profile players, only to confirm a link for an
 * ID the caller already knows. Ask before widening this.
 *
 * DATA BOUNDARY: read-only, and explicitly `getProdDb()` rather than `getDb()`.
 * `getDb()` resolves the admin's dev/prod cookie toggle, which is meaningless
 * for a machine caller — a bot must always read prod, never a dev database.
 *
 * COST: `account.accountId` is UNIQUE-indexed, so this is a single index probe
 * (not a scan) against the shared game-DB pool. Combined with the per-key rate
 * limit that keeps the bot's footprint on that pool negligible.
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
const BodySchema = z.object({
  // Discord snowflakes are numeric and currently 17–19 digits; the bounds are
  // deliberately loose so a future-length ID is not rejected, while still
  // refusing obvious junk before it reaches the database.
  discordUserId: z
    .string()
    .trim()
    .regex(/^\d{15,21}$/, "discordUserId must be a numeric Discord user ID"),
});

export const POST = withApiKey({ scopes: ["discord:read"] }, async (request) => {
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

  const db = getProdDb();
  // accountId is globally unique, so this is one index probe. We still assert
  // providerId so a same-valued account on another provider can never be
  // mistaken for a Discord link.
  const account = await db.account.findUnique({
    where: { accountId: discordUserId },
    select: { providerId: true },
  });

  return {
    discordUserId,
    linked: account?.providerId === "discord",
  };
});
