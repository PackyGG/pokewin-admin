import "server-only";

import { sql } from "drizzle-orm";

import { getReadDrizzleDb } from "@/lib/db";
import { pgArrayParam } from "@/lib/drizzle-array-param";
import { getPackBuildDraftForEdit } from "@/lib/packs/build-requests";
import { scaleToPackBuilderTickets } from "@/lib/packs/builder-edge";
import { shapeWeights } from "@/app/(admin)/insights/edge-calc/risk";
import type {
  PackBuilderDraftCard,
  PackBuilderInitialDraft,
} from "./draft-types";

type DraftCardRow = {
  id: string;
  name: string;
  image_url: string | null;
  price: string;
};

/**
 * Compose one ADMIN draft with its current MAIN card metadata. The databases
 * are queried separately and joined by card id in application code.
 */
export async function loadPackBuilderDraft(input: {
  requestId: string;
  actorId: string;
  canManageAll: boolean;
}): Promise<PackBuilderInitialDraft | null> {
  const draft = await getPackBuildDraftForEdit(input);
  if (!draft) return null;

  const requestedCards = draft.requestPayload.cards;
  if (requestedCards.some((card) => !("cardId" in card))) {
    throw new Error("This saved build contains unsupported value-only cards.");
  }

  const cardIds = requestedCards.map((card) =>
    "cardId" in card ? card.cardId : "",
  );
  const uniqueCardIds = [...new Set(cardIds)];
  const db = await getReadDrizzleDb();
  const result =
    uniqueCardIds.length === 0
      ? { rows: [] as DraftCardRow[] }
      : await db.execute<DraftCardRow>(sql`
          SELECT id, name, image_url, price::text AS price
          FROM cards
          WHERE id = ANY(${pgArrayParam(uniqueCardIds)}::uuid[])
        `);
  const cardById = new Map(result.rows.map((card) => [card.id, card]));
  const missingCardIds = uniqueCardIds.filter((id) => !cardById.has(id));
  if (missingCardIds.length > 0) {
    throw new Error(
      `This saved build contains unavailable cards: ${missingCardIds.join(", ")}`,
    );
  }

  const ticketWeights =
    draft.requestPayload.ticketWeights ??
    scaleToPackBuilderTickets(
      (() => {
        const shaped = shapeWeights({
          cards: requestedCards.map((storedCard) => ({
            value: Number(
              cardById.get("cardId" in storedCard ? storedCard.cardId : "")!
                .price,
            ),
          })),
          price: draft.requestPayload.price,
          targetEdge: draft.requestPayload.targets.targetEdge,
          targetWinRate: draft.requestPayload.targets.targetWinRate,
          maxWinCap: draft.requestPayload.targets.maxWinCap,
          floorRatioMin: draft.requestPayload.targets.floorRatioMin,
          nearMissMin: draft.requestPayload.targets.nearMissMin,
        });
        if ("error" in shaped) {
          throw new Error(`This saved build's odds could not be restored: ${shaped.error}`);
        }
        return shaped.weights;
      })(),
    );
  if (!ticketWeights || ticketWeights.length !== requestedCards.length) {
    throw new Error("This saved build's odds could not be restored.");
  }

  const cards: PackBuilderDraftCard[] = requestedCards.map((storedCard, index) => {
    if (!("cardId" in storedCard)) {
      throw new Error("This saved build contains unsupported value-only cards.");
    }
    const card = cardById.get(storedCard.cardId)!;
    return {
      cardId: card.id,
      name: card.name,
      imageUrl: card.image_url,
      priceUsd: Number(card.price),
      odds: ticketWeights[index]! / 10_000,
      color: storedCard.color ?? null,
      animation: storedCard.animation ?? false,
    };
  });

  return {
    id: draft.id,
    name: draft.requestPayload.name,
    slug: draft.requestPayload.slug,
    description: draft.requestPayload.description ?? null,
    imageUrl: draft.requestPayload.imageUrl ?? null,
    price: draft.requestPayload.price,
    cardsPerOpen: draft.requestPayload.cardsPerOpen ?? null,
    difficulty: draft.requestPayload.difficulty ?? 0,
    cards,
    targets: {
      targetEdge: draft.requestPayload.targets.targetEdge ?? null,
      targetWinRate: draft.requestPayload.targets.targetWinRate,
      maxWinCap: draft.requestPayload.targets.maxWinCap ?? null,
      floorRatioMin: draft.requestPayload.targets.floorRatioMin ?? null,
      nearMissMin: draft.requestPayload.targets.nearMissMin ?? null,
    },
  };
}
