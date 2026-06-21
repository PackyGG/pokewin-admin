"use server";

import { requirePackStudioAccess } from "@/lib/require-pack-studio-access";
import { getCards } from "@/lib/queries/cards";

/**
 * Pack-Studio Builder server actions.
 *
 * These mirror the `/packs` card-picker reads (`searchCardsForPicker` /
 * `getCardPickerFilters` in `src/app/(admin)/packs/actions.ts`) but are gated by
 * `requirePackStudioAccess` instead of `requirePageAccess("/packs")` — the
 * builder lives under the Pack-Studio access surface, so a pack_creator with
 * Pack-Studio toggled on (but no `/packs` page access) can still load the
 * picker. They additionally surface each card's `inPacks` usage count (how many
 * packs already reference the card) so the operator can judge liability/reuse
 * before adding it.
 *
 * All reads are MAIN-DB read-only (`getCards` → indexed paginated cards query).
 * No MAIN writes happen here; the actual pack creation goes through the
 * owner-gated `buildPack` server action in `packs/actions.ts`, which re-shapes
 * the weights server-side and creates the pack `active:false`.
 */

/** A pool card surfaced to the builder picker. */
export type BuilderCardItem = {
  id: string;
  name: string;
  imageUrl: string;
  priceUsd: number;
  rarity: string | null;
  setName: string | null;
  /** How many existing packs already reference this card. */
  inPacks: number;
};

export type BuilderCardPage = {
  data: BuilderCardItem[];
  total: number;
  page: number;
  totalPages: number;
};

export async function searchBuilderCards(params: {
  page?: number;
  perPage?: number;
  search?: string;
  rarity?: string;
  setId?: string;
  minPrice?: string;
  maxPrice?: string;
}): Promise<BuilderCardPage> {
  await requirePackStudioAccess();
  const result = await getCards({
    page: params.page,
    perPage: params.perPage,
    search: params.search,
    rarity: params.rarity,
    setId: params.setId,
    minPrice: params.minPrice,
    maxPrice: params.maxPrice,
    sortBy: "name",
    sortOrder: "asc",
  });
  return {
    data: result.data.map((c) => ({
      id: c.id,
      name: c.name,
      imageUrl: c.imageUrl,
      priceUsd: c.priceUsd,
      rarity: c.rarity,
      setName: c.setName,
      inPacks: c.inPacks,
    })),
    total: result.total,
    page: result.page,
    totalPages: result.totalPages,
  };
}
