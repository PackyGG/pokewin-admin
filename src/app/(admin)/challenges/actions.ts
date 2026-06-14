"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { toNumber } from "@/lib/utils/decimal";
import {
  challengesApi,
  BackendApiError,
  type Challenge,
  type ChallengeStatus,
} from "@/lib/backend-api";
import {
  expectedOpeningsFromProbabilityPercent,
  probabilityPercentFromWeight,
  theoreticalHouseProfitUsd,
} from "./challenge-card-math";

// Challenge mutations return their error as a value instead of throwing.
// Next.js masks all thrown Server Action errors in production — the client
// receives a digest-only message with the real message stripped. Returning
// { success: false, error } lets the real message survive the RSC payload and
// surface in a toast. Matches the pattern used by raffles/actions.ts.
//
// NOTE: challenge data lives in the MAIN game DB and is NOT in the admin
// Prisma schema — every challenge read/write goes through challengesApi
// (backend admin API). The only Prisma read here is `searchItems`, which
// resolves pack/card pickers against MAIN (a read, which is allowed).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SearchItem = {
  id: string;
  type: "pack" | "card";
  name: string;
  imageUrl: string | null;
  priceUsd: number;
  /** Card-in-pack picker only: per-slot drop chance (0–100). */
  probabilityPercent?: number;
  /** Card-in-pack picker only: 1 / (probabilityPercent / 100). */
  expectedOpenings?: number | null;
};

export type ChallengeCardSummary = {
  cardId: string;
  cardName: string;
  cardImageUrl: string | null;
  cardPriceUsd: number;
  packId: string;
  packName: string;
  packPriceUsd: number;
  probabilityPercent: number;
  expectedOpenings: number | null;
  /** expectedOpenings × packPrice × 10.99% (planning house edge). */
  theoreticalProfitUsd: number;
  cardPullCount: number;
  packOpenCount: number;
};

export async function searchItems(
  query: string,
  type: "pack" | "card",
  opts: {
    // Card-hit target card → restrict to the cards inside this pack's pool.
    // The card must be pullable from the chosen pack, else it's unwinnable.
    packId?: string;
  } = {},
): Promise<SearchItem[]> {
  const db = await getDb();
  await requirePageAccess("/challenges");
  const isUuid = UUID_RE.test(query);

  if (type === "pack") {
    const or: Record<string, unknown>[] = [];
    if (query) {
      or.push({ name: { contains: query, mode: "insensitive" } });
      or.push({ slug: { contains: query, mode: "insensitive" } });
      if (isUuid) or.push({ id: query });
    }
    // Only active packs can be a challenge target.
    const where: Record<string, unknown> = { active: true };
    if (or.length > 0) where.OR = or;
    const packs = await db.packs.findMany({
      where,
      select: { id: true, name: true, image_url: true, price: true },
      orderBy: { name: "asc" },
      take: 20,
    });
    return packs.map((p) => ({
      id: p.id,
      type: "pack" as const,
      name: p.name,
      imageUrl: p.image_url,
      priceUsd: toNumber(p.price),
    }));
  }

  // Card-hit target card → scope to the chosen pack's pool (pack_cards).
  const or: Record<string, unknown>[] = [];
  if (query) {
    or.push({ name: { contains: query, mode: "insensitive" } });
    if (isUuid) or.push({ id: query });
  }
  const where: Record<string, unknown> = {};
  if (opts.packId) where.pack_cards = { some: { pack_id: opts.packId } };
  if (or.length > 0) where.OR = or;

  let totalWeight = 0;
  if (opts.packId) {
    const weights = await db.pack_cards.findMany({
      where: { pack_id: opts.packId },
      select: { weight: true },
    });
    totalWeight = weights.reduce((sum, row) => sum + row.weight, 0);
  }

  const cards = await db.cards.findMany({
    where: Object.keys(where).length > 0 ? where : undefined,
    select: {
      id: true,
      name: true,
      image_url: true,
      price: true,
      ...(opts.packId
        ? {
            pack_cards: {
              where: { pack_id: opts.packId },
              select: { weight: true },
              take: 1,
            },
          }
        : {}),
    },
    orderBy: { name: "asc" },
    take: 20,
  });
  return cards.map((c) => {
    const weight =
      opts.packId && "pack_cards" in c && Array.isArray(c.pack_cards)
        ? (c.pack_cards[0]?.weight ?? 0)
        : 0;
    const probabilityPercent = opts.packId
      ? probabilityPercentFromWeight(weight, totalWeight)
      : undefined;
    const expectedOpenings =
      probabilityPercent != null
        ? expectedOpeningsFromProbabilityPercent(probabilityPercent)
        : undefined;
    return {
      id: c.id,
      type: "card" as const,
      name: c.name,
      imageUrl: c.image_url,
      priceUsd: toNumber(c.price),
      ...(probabilityPercent != null ? { probabilityPercent } : {}),
      ...(expectedOpenings !== undefined ? { expectedOpenings } : {}),
    };
  });
}

/** Historical stats + odds for the card/pack pair shown in the create dialog. */
export async function getChallengeCardSummary(
  packId: string,
  cardId: string,
): Promise<ChallengeCardSummary | null> {
  const db = await getDb();
  await requirePageAccess("/challenges");

  if (!UUID_RE.test(packId) || !UUID_RE.test(cardId)) {
    return null;
  }

  const packCard = await db.pack_cards.findUnique({
    where: { pack_id_card_id: { pack_id: packId, card_id: cardId } },
    select: {
      weight: true,
      packs: {
        select: {
          name: true,
          price: true,
          total_openings: true,
        },
      },
      cards: {
        select: {
          name: true,
          image_url: true,
          price: true,
        },
      },
    },
  });
  if (!packCard) return null;

  const allWeights = await db.pack_cards.findMany({
    where: { pack_id: packId },
    select: { weight: true },
  });
  const totalWeight = allWeights.reduce((sum, row) => sum + row.weight, 0);
  const probabilityPercent = probabilityPercentFromWeight(
    packCard.weight,
    totalWeight,
  );
  const expectedOpenings =
    expectedOpeningsFromProbabilityPercent(probabilityPercent);
  const packPriceUsd = toNumber(packCard.packs.price);

  const pullRows = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
    FROM user_inventory ui
    WHERE ui.card_id = ${cardId}::uuid
      AND (
        (
          ui.source_type = 'pack'
          AND EXISTS (
            SELECT 1
            FROM game_sessions gs
            WHERE gs.id = ui.source_id
              AND gs.game_type = 'pack'
              AND gs.game_id = ${packId}::uuid
          )
        )
        OR (
          ui.source_type = 'battle'
          AND EXISTS (
            SELECT 1
            FROM battle_participants bp
            JOIN battles b ON b.id = bp.battle_id
            WHERE bp.game_session_id = ui.source_id
              AND ${packId}::uuid = ANY(b.pack_ids::uuid[])
          )
        )
      )
  `;
  const cardPullCount = Number(pullRows[0]?.count ?? 0);

  return {
    cardId,
    cardName: packCard.cards.name,
    cardImageUrl: packCard.cards.image_url,
    cardPriceUsd: toNumber(packCard.cards.price),
    packId,
    packName: packCard.packs.name,
    packPriceUsd,
    probabilityPercent,
    expectedOpenings,
    theoreticalProfitUsd: expectedOpenings
      ? theoreticalHouseProfitUsd(expectedOpenings, packPriceUsd)
      : 0,
    cardPullCount,
    packOpenCount: Number(packCard.packs.total_openings),
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

// Two creatable kinds drive game_type + type + requirement.kind together.
// "card" → pack_pull (game_type pack), "upgrader" → upgrader.
const createChallengeSchema = z
  .object({
    kind: z.enum(["card", "upgrader"]),
    name: z.string().trim().min(1, "Name is required").max(120, "Name is too long"),
    description: z.string().trim().max(500, "Description is too long").optional(),
    prizeAmount: z
      .number()
      .positive("Prize must be greater than 0")
      .max(100000, "Prize is too large")
      // whole-cent: at most 2 decimal places
      .refine((v) => Math.round(v * 100) / 100 === v, {
        message: "Prize can have at most 2 decimal places",
      }),
    maxClaims: z
      .number()
      .int("Max claims must be a whole number")
      .positive("Max claims must be at least 1")
      .max(100000, "Max claims is too large"),
    // card-hit (pack_pull)
    packId: z.string().regex(UUID_RE, "Select a valid pack").optional(),
    cardId: z.string().regex(UUID_RE, "Select a valid card").optional(),
    // upgrader-hit (card-agnostic): bet >= minBetUsd AND multiplier >= minMultiplier.
    // Exact bounds are enforced by the backend; keep client checks loose.
    minBetUsd: z
      .number()
      .positive("Min bet must be greater than 0")
      .refine((v) => Math.round(v * 100) / 100 === v, {
        message: "Min bet can have at most 2 decimal places",
      })
      .optional(),
    minMultiplier: z
      .number()
      .positive("Min multiplier must be greater than 0")
      .refine((v) => Math.round(v * 10000) / 10000 === v, {
        message: "Min multiplier can have at most 4 decimal places",
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "card") {
      if (!v.packId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Select a pack", path: ["packId"] });
      }
      if (!v.cardId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Select a card", path: ["cardId"] });
      }
    } else {
      if (v.minBetUsd == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Min bet is required",
          path: ["minBetUsd"],
        });
      }
      if (v.minMultiplier == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Min multiplier is required",
          path: ["minMultiplier"],
        });
      }
    }
  });

export type CreateChallengeData = {
  kind: "card" | "upgrader";
  name: string;
  description?: string;
  prizeAmount: number;
  maxClaims: number;
  packId?: string;
  cardId?: string;
  minBetUsd?: number;
  minMultiplier?: number;
};

export async function createChallenge(
  data: CreateChallengeData,
): Promise<{ success: true; challengeId: string } | { success: false; error: string }> {
  const session = await requirePageAccess("/challenges");

  const parseResult = createChallengeSchema.safeParse(data);
  if (!parseResult.success) {
    return {
      success: false,
      error: parseResult.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const parsed = parseResult.data;

  await requireCapability(session, "__can_create_challenge", "create challenges");

  let created: Challenge;
  try {
    created = await challengesApi.create(
      parsed.kind === "card"
        ? {
            name: parsed.name,
            description: parsed.description,
            game_type: "pack",
            type: "pack_pull",
            prize_amount: parsed.prizeAmount,
            max_claims: parsed.maxClaims,
            requirement: {
              kind: "pack_pull",
              pack_id: parsed.packId,
              card_id: parsed.cardId,
            },
          }
        : {
            name: parsed.name,
            description: parsed.description,
            game_type: "upgrader",
            type: "upgrader",
            prize_amount: parsed.prizeAmount,
            max_claims: parsed.maxClaims,
            // upgrader is card-agnostic — only the bet + multiplier thresholds.
            requirement: {
              kind: "upgrader",
              min_bet_usd: parsed.minBetUsd,
              min_multiplier: parsed.minMultiplier,
            },
          },
    );
  } catch (err) {
    if (err instanceof BackendApiError) {
      console.error(
        `[createChallenge] backend error status=${err.status} message="${err.message}"`,
      );
      return { success: false, error: err.message };
    }
    const message = err instanceof Error ? err.message : "Unknown network error";
    console.error(`[createChallenge] failed to reach backend: ${message}`, err);
    return { success: false, error: `Failed to reach backend: ${message}` };
  }

  try {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "challenge_created",
      metadata: {
        challenge_id: created.id,
        name: created.name,
        kind: parsed.kind,
      },
    });
  } catch (err) {
    console.error("[createChallenge] Audit logging failed:", err);
  }

  revalidatePath("/challenges");
  return { success: true, challengeId: created.id };
}

// ---------------------------------------------------------------------------
// Update — only prize / cap / status are editable
// ---------------------------------------------------------------------------

const updateChallengeSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    prizeAmount: z
      .number()
      .positive("Prize must be greater than 0")
      .max(100000, "Prize is too large")
      .refine((v) => Math.round(v * 100) / 100 === v, {
        message: "Prize can have at most 2 decimal places",
      })
      .optional(),
    maxClaims: z
      .number()
      .int("Max claims must be a whole number")
      .positive("Max claims must be at least 1")
      .max(100000, "Max claims is too large")
      .optional(),
    status: z.enum(["active", "inactive", "archived"]).optional(),
  })
  .refine(
    (v) => v.prizeAmount != null || v.maxClaims != null || v.status != null,
    { message: "Nothing to update" },
  );

export type UpdateChallengeData = {
  expectedVersion: number;
  prizeAmount?: number;
  maxClaims?: number;
  status?: ChallengeStatus;
};

export async function updateChallenge(
  id: string,
  data: UpdateChallengeData,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess("/challenges");

  const parseResult = updateChallengeSchema.safeParse(data);
  if (!parseResult.success) {
    return {
      success: false,
      error: parseResult.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const parsed = parseResult.data;

  await requireCapability(session, "__can_update_challenge", "update challenges");

  try {
    await challengesApi.update(id, {
      expected_version: parsed.expectedVersion,
      patch: {
        ...(parsed.prizeAmount != null ? { prize_amount: parsed.prizeAmount } : {}),
        ...(parsed.maxClaims != null ? { max_claims: parsed.maxClaims } : {}),
        ...(parsed.status != null ? { status: parsed.status } : {}),
      },
    });
  } catch (err) {
    if (err instanceof BackendApiError) {
      console.error(
        `[updateChallenge] backend error status=${err.status} message="${err.message}"`,
      );
      return { success: false, error: err.message };
    }
    const message = err instanceof Error ? err.message : "Unknown network error";
    console.error(`[updateChallenge] failed to reach backend: ${message}`, err);
    return { success: false, error: `Failed to reach backend: ${message}` };
  }

  try {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "challenge_updated",
      metadata: {
        challenge_id: id,
        prize_amount: parsed.prizeAmount,
        max_claims: parsed.maxClaims,
        status: parsed.status,
      },
    });
  } catch (err) {
    console.error("[updateChallenge] Audit logging failed:", err);
  }

  revalidatePath("/challenges");
  return { success: true };
}

// ---------------------------------------------------------------------------
// Archive (soft-delete → status=archived)
// ---------------------------------------------------------------------------

export async function archiveChallenge(
  id: string,
  expectedVersion: number,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess("/challenges");

  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return { success: false, error: "Invalid version" };
  }

  await requireCapability(session, "__can_archive_challenge", "archive challenges");

  try {
    await challengesApi.archive(id, expectedVersion);
  } catch (err) {
    if (err instanceof BackendApiError) {
      console.error(
        `[archiveChallenge] backend error status=${err.status} message="${err.message}"`,
      );
      return { success: false, error: err.message };
    }
    const message = err instanceof Error ? err.message : "Unknown network error";
    console.error(`[archiveChallenge] failed to reach backend: ${message}`, err);
    return { success: false, error: `Failed to reach backend: ${message}` };
  }

  try {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "challenge_archived",
      metadata: { challenge_id: id },
    });
  } catch (err) {
    console.error("[archiveChallenge] Audit logging failed:", err);
  }

  revalidatePath("/challenges");
  return { success: true };
}
