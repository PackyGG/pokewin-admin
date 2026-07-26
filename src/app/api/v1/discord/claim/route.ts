import { z } from "zod";
import { eq } from "drizzle-orm";

import { getProdDrizzleDb } from "@/lib/db";
import { account } from "@/lib/db-schema/main/schema";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { createClaimRequest } from "@/lib/creator-vip/queries";

/**
 * POST /api/v1/discord/claim — file a claim for a creator VIP wager reward.
 *
 * Powers the Claim button behind the rewards bot's `/check`. This endpoint
 * NEVER moves money: it writes one PENDING row in the admin DB for staff to
 * review. Approval (and the balance credit) happens in the dashboard, by a
 * human, behind 2FA.
 *
 * ── WHY THE BOT CAN'T BE TRUSTED, AND DOESN'T NEED TO BE ──────────────────
 * The caller supplies a Discord id and WHICH program — never an amount, never
 * a Packy user id. The server resolves the account itself and recomputes the
 * entitlement from scratch through the same `computeEntitlement` the
 * dashboard uses. So a tampered bot, a replayed request, or a stale number
 * the player saw ten minutes ago all converge on the same answer: whatever is
 * actually true at write time. There is no field an attacker can inflate.
 *
 * Double-claiming is blocked at the database, not in code: a partial unique
 * index allows at most one PENDING claim per (program, user), so two racing
 * requests can only ever produce one row — the loser gets `already_pending`.
 *
 * ── SCOPE ─────────────────────────────────────────────────────────────────
 * `discord:rewards:claim` is a WRITE scope, and it obeys the surface's rule:
 * it writes the ADMIN DB only. Nothing here touches the prod game DB except
 * read-only wager lookups. It is deliberately separate from
 * `discord:rewards:read` so a key can be allowed to SHOW rewards without
 * being allowed to FILE claims.
 *
 * POST for the same reason as its siblings: the Discord id is personal data
 * and a GET would leak it into access, proxy and error logs.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The two claimable id shapes `/discord/rewards` hands out. The PREFIX
 * carries which leg of the program is being claimed — a program can offer
 * both, and they are earned and claimed independently.
 *   vip_<uuid> → wager milestones
 *   ftd_<uuid> → first-deposit lossback
 */
const CLAIMABLE_ID =
  /^(vip|ftd)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

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
  discordUserId: z
    .string()
    .trim()
    .regex(/^\d{15,21}$/, "discordUserId must be a numeric Discord user ID"),
  claimableId: z.string().trim().min(1).max(64),
});

export const POST = withApiKey(
  { scopes: ["discord:rewards:claim"] },
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
          "Expected a JSON body of { discordUserId, claimableId }.",
      );
    }

    const { discordUserId, claimableId } = parsed.data;

    // Only VIP rewards are claimable through the bot. Everything else in the
    // /discord/rewards list (unopened rewards, rakeback) is claimed on-site,
    // and saying so plainly is more useful to a bot author than a generic 400.
    const match = CLAIMABLE_ID.exec(claimableId);
    if (!match?.[1] || !match?.[2]) {
      return apiError(
        400,
        "not_claimable_here",
        "That reward can't be claimed through Discord — it's claimed on the site.",
      );
    }
    const leg = match[1].toLowerCase() === "ftd" ? "ftd_lossback" : "wager";
    const programId = match[2];

    // Same single index probe the sibling routes use. providerId is asserted
    // so a same-valued account on another provider can't resolve to a Packy
    // user.
    const [linkedAccount] = await getProdDrizzleDb()
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

    const result = await createClaimRequest({
      programId,
      leg,
      userId: linkedAccount.userId,
      discordUserId,
    });

    if (!result.ok) {
      // `already_pending` is a CONFLICT, not a client error — the request was
      // well-formed and the player is eligible; there is simply already one in
      // the queue. A 409 lets the bot say "we're already on it" instead of
      // reporting a failure.
      const status =
        result.code === "already_pending"
          ? 409
          : result.code === "program_not_found"
            ? 404
            : 400;
      return apiError(status, result.code, result.error);
    }

    return {
      claimId: result.claimId,
      amount: result.amountUsd,
      currency: "USD",
      units: result.units,
      status: "pending_review",
      message:
        "Your claim has been submitted and is awaiting staff review. You'll be credited once it's approved.",
    };
  },
);
