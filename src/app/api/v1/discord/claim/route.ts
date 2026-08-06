import { z } from "zod";
import { eq } from "drizzle-orm";

import { getProdReadDrizzleDb } from "@/lib/db";
import { account } from "@/lib/db-schema/main/schema";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { checkApiSubjectRateLimit } from "@/lib/api-auth/rate-limit";
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
    // 17–20 digits, matching the ONLY caller: the bot validates `^\d{17,20}$`
    // in `submitClaim` and parses the same bound out of the button custom id.
    .regex(/^\d{17,20}$/, "discordUserId must be a numeric Discord user ID"),
  // 80 is the widest value that can physically arrive: the claim button's
  // custom id is capped at Discord's 100 chars and the bot's own id pattern is
  // `[A-Za-z0-9_:.-]{1,80}`. The `max(64)` this replaces was a THIRD limit for
  // one field and disagreed with both. It costs nothing to accept up to the
  // caller's ceiling — CLAIMABLE_ID below is the load-bearing check, and every
  // id we actually issue is ~40 chars, so nothing legitimate changes. What
  // does change: an over-64 on-site id now gets the accurate
  // `not_claimable_here` instead of a misleading shape error.
  claimableId: z.string().trim().min(1).max(80),
});

/**
 * Per-player ceiling for filing claims, ON TOP OF the key's own budget.
 *
 * The bot allows 2/min per user, client-side — which a leaked
 * `discord:rewards:claim` key simply doesn't run, leaving the whole key budget
 * pointable at one account. No money moves here (every row is staff-reviewed),
 * but unbounded filing is queue spam and a review-fatigue attack. Set above the
 * bot's default so nothing legitimate 429s.
 */
const SUBJECT_LIMIT_PER_MIN = 10;

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

    // Gated on the SUBJECT, before any lookup: the write path (and the review
    // queue behind it) is the thing worth protecting, so the budget is spent
    // whether or not the id turns out to be linked or the shape valid.
    const subjectRate = await checkApiSubjectRateLimit(
      "discord-claim",
      discordUserId,
      SUBJECT_LIMIT_PER_MIN,
    );
    if (!subjectRate.allowed) {
      return apiError(
        429,
        "rate_limited",
        "Too many claim attempts for this Discord account. Try again shortly.",
        subjectRate,
      );
    }

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
      //
      // `offer_expired` is the same shape: the claim transaction aborted
      // because the offer windows it needed were consumed or lapsed between
      // the eligibility read and the write. Nothing about the REQUEST is wrong,
      // so a 400 would send the bot author hunting a payload bug that doesn't
      // exist. It is a transient state conflict, and re-running `/check`
      // produces a fresh offer.
      const status =
        result.code === "already_pending"
          ? 409
          : result.code === "not_eligible"
            ? 409
            : result.code === "offer_expired"
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
