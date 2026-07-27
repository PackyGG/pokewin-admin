"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { requirePackStudioAccess } from "@/lib/require-pack-studio-access";
import { requireCapability } from "@/lib/require-capability";
import { sessionHasRole } from "@/lib/dal";
import { isOwner } from "@/lib/owners";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { getCards } from "@/lib/queries/cards";
import {
  discardPackBuildDraft,
  submitPackBuildDraftForApproval,
} from "@/lib/packs/build-requests";

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

export type PackBuildDraftActionResult =
  | { ok: true }
  | { ok: false; error: string };

async function requireBuildDraftOperator() {
  const session = await requirePackStudioAccess(
    "Not authorized to manage Pack Builder drafts.",
  );
  await requireCapability(session, "__can_create_pack", "manage pack build drafts");
  return session;
}

function canManageEveryBuildDraft(
  session: Awaited<ReturnType<typeof requireBuildDraftOperator>>,
): boolean {
  return isOwner(session) || sessionHasRole(session, "admin");
}

/**
 * Promote an inactive saved build into the live owner-approval queue.
 * Expected refusals return as data so Next production does not replace them
 * with the generic Server Components error message.
 */
export async function requestPackBuildDraftApproval(
  requestId: string,
): Promise<PackBuildDraftActionResult> {
  try {
    const session = await requireBuildDraftOperator();
    const parsed = z.string().uuid().safeParse(requestId);
    if (!parsed.success) return { ok: false, error: "Invalid build draft id" };

    const submitted = await submitPackBuildDraftForApproval({
      requestId: parsed.data,
      actorId: session.userId,
      canManageAll: canManageEveryBuildDraft(session),
    });
    if (!submitted) {
      return {
        ok: false,
        error: "This build draft is no longer available or belongs to another builder.",
      };
    }

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "pack_build_draft_submitted",
      metadata: { request_id: parsed.data },
    });
    revalidatePath("/pack-studio/builder-drafts");
    revalidatePath("/pack-studio/new-packs");
    revalidateTag("pack-build-drafts");
    return { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not request approval for this build draft.",
    };
  }
}

/**
 * Discard a saved inactive build. This only updates the ADMIN staging row and
 * never touches MAIN.
 */
export async function discardPackBuildDraftAction(
  requestId: string,
): Promise<PackBuildDraftActionResult> {
  try {
    const session = await requireBuildDraftOperator();
    const parsed = z.string().uuid().safeParse(requestId);
    if (!parsed.success) return { ok: false, error: "Invalid build draft id" };

    const discarded = await discardPackBuildDraft({
      requestId: parsed.data,
      actorId: session.userId,
      canManageAll: canManageEveryBuildDraft(session),
    });
    if (!discarded) {
      return {
        ok: false,
        error: "This build draft is no longer available or belongs to another builder.",
      };
    }

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "pack_build_draft_discarded",
      metadata: { request_id: parsed.data },
    });
    revalidatePath("/pack-studio/builder-drafts");
    revalidateTag("pack-build-drafts");
    return { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not discard this build draft.",
    };
  }
}
