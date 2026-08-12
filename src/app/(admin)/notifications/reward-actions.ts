"use server";

import { inArray } from "drizzle-orm";

import { getPrimaryDrizzleDb } from "@/lib/db";
import { promo_codes, user } from "@/lib/db-schema/main/schema";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { readDbEnvFromCookie } from "@/lib/db-env";
import { BackendApiError } from "@/lib/backend-api/errors";
import { getDirectNotificationAvailability } from "@/lib/backend-api/user-notifications-availability";
import { sendBulkNotifications } from "@/lib/backend-api/user-notifications";
import {
  deriveRewardCode,
  hashRewardCode,
  regionForContinent,
  resolveCodePepper,
} from "@/lib/reward-campaign-codes";
import {
  dedupeKeyFor,
  validateCampaignSlug,
  BULK_MAX_ITEMS,
  REWARD_MAX_VALUE_USD,
} from "@/lib/user-notification";
import {
  depositWindowLabel,
  validateRewardTiers,
  type RewardTier,
} from "@/lib/reward-campaign-tiers";

/**
 * Reward campaigns: mint one single-use promo code per recipient, bound to
 * that recipient, and deliver it into their notification feed.
 *
 * Minting and sending happen in ONE action per chunk on purpose. Two separate
 * calls could get out of sync — codes created but never delivered, or a
 * notification promising a code that was never minted. Here a chunk either
 * gets both or is retried as a unit.
 *
 * Idempotent end to end. Codes are derived (see `@/lib/reward-campaign-codes`)
 * so a retry re-derives the same code, finds the row already present and skips
 * it; the notification carries the same `dedupe_key` and comes back `deduped`.
 * Re-sending a chunk verbatim is always safe and never mints a second code.
 *
 * ── Writes to the game DB ────────────────────────────────────────────────
 * This is the one action here that writes to the MAIN game database
 * (`promo_codes` rows carry real money). The notification backend and primary
 * database must resolve to the same environment before anything is minted.
 * That prevents a fallback backend config from delivering production codes
 * backed by development rows, or the reverse.
 */

const PAGE_KEY = "/notifications";
const CAPABILITY = "__can_send_user_notifications";

/** Fixed for this flow — the site template that renders a copyable code. */
const REWARD_NOTIFICATION_TYPE = "promo_code_granted";

export type RewardChunkResult =
  | {
      success: true;
      requested: number;
      created: number;
      deduped: number;
      unknownUsers: string[];
      codesMinted: number;
      codesReused: number;
    }
  | { success: false; error: string };

export type SendRewardChunkInput = {
  campaign: string;
  valueUsd: number;
  userIds: string[];
  expiresInDays: number | null;
  chunkIndex: number;
  chunkCount: number;
  tier?: RewardTier;
};

export async function sendRewardCampaignChunkAction(
  input: SendRewardChunkInput,
): Promise<RewardChunkResult> {
  const session = await requirePageAccess(PAGE_KEY);
  await requireCapability(session, CAPABILITY, "send reward campaigns");

  // Gate 1 — the backend the notification would reach.
  const availability = await getDirectNotificationAvailability();
  if (!availability.ready) {
    return {
      success: false,
      error: availability.reason ?? "Sending is not available.",
    };
  }
  // Gate 2 — resolve the database independently, then require an exact match
  // with the backend target before creating money-bearing rows.
  const dbEnv = await readDbEnvFromCookie();
  if (!availability.backendEnv || availability.backendEnv !== dbEnv) {
    return {
      success: false,
      error: `Reward campaigns are blocked because the notification backend (${availability.backendEnv ?? "unconfigured"}) and game database (${dbEnv}) do not match.`,
    };
  }

  const slugError = validateCampaignSlug(input.campaign);
  if (slugError) return { success: false, error: slugError };
  const campaign = input.campaign.trim();

  if (!Number.isFinite(input.valueUsd) || input.valueUsd <= 0) {
    return { success: false, error: "Reward amount must be greater than zero" };
  }
  // Normalise to whole cents ONCE, up front, and use this value everywhere
  // below. `promo_codes.value` is Decimal(20,2), so Postgres would quietly
  // round 5.005 to 5.00 — while the notification payload carried the
  // unrounded 5.005, telling the recipient an amount their code is not
  // actually worth. Rounding here keeps the row, the payload and the audit
  // entry describing the same money.
  const valueUsd = Math.round(input.valueUsd * 100) / 100;
  if (valueUsd <= 0) {
    return {
      success: false,
      error: "Reward amount rounds to $0.00 — raise it above one cent",
    };
  }
  if (valueUsd > REWARD_MAX_VALUE_USD) {
    // Policy ceiling, not a backend limit. This is the boundary — the
    // composer checks the same number, but a server action is callable
    // directly, so the cap has to hold here regardless of what the form did.
    return {
      success: false,
      error: `Reward amount is capped at $${REWARD_MAX_VALUE_USD} per code (got $${valueUsd}).`,
    };
  }
  if (input.tier) {
    const tierError = validateRewardTiers([input.tier]);
    if (tierError) return { success: false, error: tierError };
    if (Math.round(input.tier.rewardUsd * 100) / 100 !== valueUsd) {
      return {
        success: false,
        error: "Tier reward does not match this chunk's code value",
      };
    }
  }

  const userIds = [
    ...new Set(input.userIds.map((id) => id.trim()).filter(Boolean)),
  ];
  if (userIds.length === 0) return { success: false, error: "Chunk is empty" };
  // The composer never builds a chunk above BULK_MAX_ITEMS, but a server
  // action is callable directly — an unbounded array would drive an unbounded
  // IN() lookup, promo_codes insert and bulk delivery. The cap has to hold
  // here regardless of what the form did (same boundary as direct-actions).
  if (userIds.length > BULK_MAX_ITEMS) {
    return {
      success: false,
      error: `Chunk has ${userIds.length} recipients — the limit is ${BULK_MAX_ITEMS}`,
    };
  }

  const db = await getPrimaryDrizzleDb();

  // Only mint for accounts that exist. Primary-key `IN` lookup — index-served.
  // Unknown ids are reported, not fatal, mirroring the bulk endpoint.
  let users: { id: string; continent_code: string | null }[];
  try {
    users = await db
      .select({ id: user.id, continent_code: user.continent_code })
      .from(user)
      .where(inArray(user.id, userIds));
  } catch (err) {
    return {
      success: false,
      error: `Couldn't read the recipient list: ${err instanceof Error ? err.message : "database error"}`,
    };
  }
  const known = new Map(users.map((u) => [u.id, u.continent_code]));
  const unknownUsers = userIds.filter((id) => !known.has(id));
  if (users.length === 0) {
    return {
      success: true,
      requested: userIds.length,
      created: 0,
      deduped: 0,
      unknownUsers,
      codesMinted: 0,
      codesReused: 0,
    };
  }

  // Peppered for the environment we are writing to — see resolveCodePepper.
  // Throws (rather than defaulting to "") if the env's secret is missing, so a
  // misconfiguration surfaces here instead of as thousands of codes that hash
  // to something the backend can never resolve.
  //
  // Caught, NOT allowed to propagate: Next redacts an uncaught server-action
  // throw to an opaque `digest` in production, so letting this escape turns a
  // precise "GIFT_CARD_PEPPER_DEV is not set" into a blank screen and a hash
  // in the console. A misconfiguration has to be readable by the operator who
  // can fix it.
  let pepper: string;
  try {
    pepper = await resolveCodePepper();
  } catch (err) {
    return {
      success: false,
      error:
        err instanceof Error ? err.message : "Code pepper is not configured",
    };
  }

  const planned = users.map((u) => {
    const code = deriveRewardCode(campaign, u.id, pepper);
    return {
      userId: u.id,
      code,
      codeHash: hashRewardCode(code, pepper),
      region: regionForContinent(u.continent_code),
    };
  });

  // Which codes already exist from an earlier attempt. `code_hash` is indexed
  // (promo_codes_code_hash_idx), so this stays an index scan as the table
  // grows with campaign rows.
  let toMint: typeof planned;
  try {
    const existing = await db
      .select({
        code_hash: promo_codes.code_hash,
        value: promo_codes.value,
        metadata: promo_codes.metadata,
      })
      .from(promo_codes)
      .where(
        inArray(
          promo_codes.code_hash,
          planned.map((p) => p.codeHash),
        ),
      );
    const plannedByHash = new Map(planned.map((item) => [item.codeHash, item]));
    for (const code of existing) {
      const expected = plannedByHash.get(code.code_hash);
      const metadata = code.metadata as Record<string, unknown> | null;
      if (
        expected &&
        (Math.round(Number(code.value) * 100) / 100 !== valueUsd ||
          metadata?.bound_user_id !== expected.userId ||
          metadata?.campaign !== campaign)
      ) {
        return {
          success: false,
          error: `Campaign ${campaign} was already used with different reward settings. Use a new campaign name rather than changing a user's existing code.`,
        };
      }
    }
    const existingHashes = new Set(existing.map((e) => e.code_hash));
    toMint = planned.filter((p) => !existingHashes.has(p.codeHash));
  } catch (err) {
    return {
      success: false,
      error: `Couldn't check for existing codes: ${err instanceof Error ? err.message : "database error"}`,
    };
  }

  const expiresAt =
    input.expiresInDays && input.expiresInDays > 0
      ? new Date(Date.now() + input.expiresInDays * 86_400_000)
      : null;

  let codesMinted = 0;
  if (toMint.length > 0) {
    try {
      const minted = await db
        .insert(promo_codes)
        .values(
          toMint.map((p) => ({
            code_hash: p.codeHash,
            value: String(valueUsd),
            region: p.region,
            // Single use, and bound to the one account it was minted for —
            // `metadata.bound_user_id` is enforced at redeem by the backend
            // (PackyGG/backend#462). max_uses alone would let anyone who learns
            // the code burn it before its owner.
            max_uses: 1,
            // A granted reward must not be gated behind linking Discord.
            requires_discord: false,
            expires_at: expiresAt?.toISOString() ?? null,
            metadata: {
              code: p.code,
              bound_user_id: p.userId,
              campaign,
              ...(input.tier
                ? {
                    reward_tier_id: input.tier.id,
                    reward_tier_label: input.tier.label,
                    deposit_min_usd: input.tier.minDepositUsd,
                    deposit_max_usd: input.tier.maxDepositUsd,
                    deposit_window: input.tier.window,
                  }
                : {}),
            },
          })),
        )
        .onConflictDoNothing()
        .returning({ code_hash: promo_codes.code_hash });
      codesMinted = minted.length;
    } catch (err) {
      // Nothing was delivered yet, so no recipient has been promised a code
      // that doesn't exist. Retrying re-derives the same codes.
      return {
        success: false,
        error: `Couldn't mint the codes: ${err instanceof Error ? err.message : "database error"}`,
      };
    }
  }

  // Deliver. Same dedupe convention as every other send here, so a replay of
  // this chunk reports `deduped` instead of double-delivering.
  let result;
  try {
    result = await sendBulkNotifications({
      category: "rewards",
      type: REWARD_NOTIFICATION_TYPE,
      items: planned.map((p) => ({
        user_id: p.userId,
        payload: { code: p.code, value: valueUsd },
        dedupe_key: dedupeKeyFor(campaign, p.userId),
      })),
    });
  } catch (err) {
    // The codes are already minted at this point. That is fine and is exactly
    // why derivation is deterministic: retrying this chunk reuses them rather
    // than minting a second set.
    return {
      success: false,
      error: `${
        err instanceof BackendApiError || err instanceof Error
          ? err.message
          : "Delivery failed"
      } — ${codesMinted} code(s) were already created; retrying this chunk reuses them.`,
    };
  }

  // The codes are minted and the notifications are delivered. An audit write
  // that fails now must not be reported as a failed batch: the operator would
  // read "batch 4 failed", retry, and be told nothing happened (it dedupes) —
  // while the real money movement already succeeded. Logged and swallowed, so
  // the result stays truthful about what actually happened to the users.
  try {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "reward_campaign_chunk_sent",
      metadata: {
        env: availability.backendEnv,
        campaign,
        valueUsd,
        tier: input.tier
          ? {
              id: input.tier.id,
              label: input.tier.label,
              minDepositUsd: input.tier.minDepositUsd,
              maxDepositUsd: input.tier.maxDepositUsd,
              depositWindow: depositWindowLabel(input.tier.window),
            }
          : null,
        expiresAt: expiresAt?.toISOString() ?? null,
        chunkIndex: input.chunkIndex,
        chunkCount: input.chunkCount,
        requested: userIds.length,
        codesMinted,
        codesReused: planned.length - codesMinted,
        created: result.created,
        deduped: result.deduped,
        unknownUsers: [...new Set([...unknownUsers, ...result.unknown_users])],
        trackingItems: planned.map((item) => ({
          userId: item.userId,
          dedupeKey: dedupeKeyFor(campaign, item.userId),
        })),
        // Money moved per recipient — the number an audit reader needs most.
        totalValueUsd: Number((codesMinted * valueUsd).toFixed(2)),
      },
    });
  } catch (err) {
    console.log(
      `[reward-campaign] audit write failed campaign=${campaign} chunk=${input.chunkIndex} minted=${codesMinted} err=${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  return {
    success: true,
    requested: userIds.length,
    created: result.created,
    deduped: result.deduped,
    unknownUsers: [...new Set([...unknownUsers, ...result.unknown_users])],
    codesMinted,
    codesReused: planned.length - codesMinted,
  };
}
