"use server";

import { pgArrayParam } from "@/lib/drizzle-array-param";
import { revalidatePath, revalidateTag } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { sql } from "drizzle-orm";
import { getPrimaryDrizzleDb, type MainDrizzleDb } from "@/lib/db";
import { isUuid } from "@/lib/utils/ids";
import { getPackSetAssignment } from "@/lib/queries/pack-set-assignments";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { adminDrizzle } from "@/lib/admin-db";
import {
  requirePageAccess,
  sessionHasRole,
  sessionIsAdmin,
  sessionIsOwner,
} from "@/lib/dal";
import {
  isRepriceOwner,
  isPackStudioRetuneOperator,
  isPackStudioRetuneOperatorNonOwner,
} from "@/lib/reprice-access";
import { requireCapability } from "@/lib/require-capability";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import {
  getPackDetail,
  getPackGames,
  getPackStats,
  getPacksPoolComposition,
  PACK_POOLS,
  type PackSetFilter,
  type PackStats,
} from "@/lib/queries/packs";
import { packRetunePlanTag } from "@/app/(pack-studio)/pack-studio/_actions/retune-cache-tag";
import {
  buildRetuneSearchParams,
  computeCapDroppedCardIds,
  omitZeroWeightRows,
} from "@/app/(admin)/packs/_lib/retune-params";
import { partitionSnapshotRestore } from "@/app/(admin)/packs/_lib/snapshot-restore";
import {
  planPackReprice,
  repriceEdgeWithinHardBand,
  clampRepriceTarget,
  isCurveRepriceTarget,
  isWithinFloorRaiseBand,
  planFloorRaise,
  REPRICE_TARGET_DEFAULT,
  REPRICE_TARGET_MIN,
  REPRICE_TARGET_MAX,
  REPRICE_ACCEPT_TOLERANCE,
  REPRICE_HARD_TOLERANCE,
  type RepriceAction,
  type RepriceTarget,
} from "@/app/(admin)/insights/edge-calc/math";
import { require2FA } from "@/lib/require-2fa";
import {
  signRepriceToken,
  verifyRepriceToken,
  signRetuneToken,
  verifyRetuneToken,
} from "@/lib/reprice-token";
import { getPackCardValues } from "@/lib/queries/pack-card-values";
import {
  shapeWeights,
  searchBestPriceForCleanSnap,
  computePackRisk,
  computePackRiskFromAggregates,
  TAGGED_WINRATE_TOLERANCE,
  ONE_SIDED_EDGE_EXCESS_TOL,
  type PackRisk,
} from "@/app/(admin)/insights/edge-calc/risk";
import { TARGET_HOUSE_EDGE } from "@/app/(admin)/insights/edge-calc/math";
import { z } from "zod";
import { safeQuery } from "@/lib/errors/safe-query";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { getCards, getRarities, getSets } from "@/lib/queries/cards";
import { reloadPacks } from "@/app/(admin)/rewards/actions";
import {
  autoRetuneTargets,
  resolveIntendedHitRate,
  TAGGED_WRITE_WINRATE_TOLERANCE,
  TAGGED_NEAR_MISS_MIN,
  autoTargetEdge,
  buildPackCompliance,
  DEFAULT_EDGE_CURVE,
  EDIT_EDGE_FLOOR,
  readEdgeCurveConfig,
  readMaxWinCap,
  readMaxMultCeiling,
  readRetunePriceBudgetPct,
  type EdgeCurveConfig,
  type ResolvedAutoTargetCfg,
} from "@/app/(admin)/packs/_lib/risk-config";
import {
  capturePackSnapshot,
  getPackSnapshot,
  type SnapshotCard,
} from "@/app/(admin)/packs/_lib/pack-history";
import { computePoolFingerprint } from "@/app/(admin)/packs/_lib/pool-fingerprint";
import {
  buildPackRequestSchema,
  claimPackCreationRequest,
  completePackCreationRequest,
  declinePackCreationRequest,
  enqueuePackCreationRequest,
  releasePackCreationRequest,
  type BuildPackInput,
  type ParsedBuildPackInput,
} from "@/lib/packs/build-requests";
import { getPackBuilderEdgeError } from "@/lib/packs/builder-edge";

const pack_tag = {
  pct1: "pct1",
  pct5: "pct5",
  pct10: "pct10",
  fifty50: "fifty50",
  onepiece: "onepiece",
} as const;
type pack_tag = (typeof pack_tag)[keyof typeof pack_tag];

function packTagDbValues(tags: pack_tag[]): string[] {
  return tags.map((tag) => {
    if (tag === pack_tag.pct1) return "%1";
    if (tag === pack_tag.pct5) return "%5";
    if (tag === pack_tag.pct10) return "%10";
    if (tag === pack_tag.fifty50) return "50/50";
    return "onepiece";
  });
}

async function replacePackState(
  db: MainDrizzleDb,
  packId: string,
  rows: Array<{
    card_id: string;
    weight: number;
    color: string | null;
    animation: boolean;
    order: number;
  }>,
  options?: { price?: number | string; tags?: pack_tag[] },
): Promise<void> {
  await db.transaction(async (tx) => {
    const tagsUpdate =
      options?.tags !== undefined
        ? sql`, tags = ${pgArrayParam(packTagDbValues(options.tags))}::pack_tag[]`
        : sql``;
    const priceUpdate =
      options?.price !== undefined ? sql`, price = ${options.price}` : sql``;
    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE packs
      SET updated_at = NOW() ${priceUpdate} ${tagsUpdate}
      WHERE id = ${packId}::uuid
      RETURNING id
    `);
    if (updated.rows.length === 0) throw new Error("Pack not found");
    await tx.execute(sql`DELETE FROM pack_cards WHERE pack_id = ${packId}::uuid`);
    if (rows.length > 0) {
      await tx.execute(sql`
        INSERT INTO pack_cards (
          pack_id, card_id, weight, color, animation, "order"
        )
        SELECT ${packId}::uuid, *
        FROM unnest(
          ${pgArrayParam(rows.map((r) => r.card_id))}::uuid[],
          ${pgArrayParam(rows.map((r) => r.weight))}::int[],
          ${pgArrayParam(rows.map((r) => r.color))}::text[],
          ${pgArrayParam(rows.map((r) => r.animation))}::boolean[],
          ${pgArrayParam(rows.map((r) => r.order))}::int[]
        )
      `);
    }
  });
}

export type CardPickerItem = {
  id: string;
  name: string;
  imageUrl: string;
  priceUsd: number;
  rarity: string | null;
  setName: string | null;
};

export async function searchCardsForPicker(params: {
  page?: number;
  perPage?: number;
  search?: string;
  rarity?: string;
  setId?: string;
  minPrice?: string;
  maxPrice?: string;
}) {
  await requirePageAccess("/packs");
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
    })),
    total: result.total,
    page: result.page,
    totalPages: result.totalPages,
  };
}

export async function getCardPickerFilters() {
  await requirePageAccess("/packs");
  const [sets, rarities] = await Promise.all([getSets(), getRarities()]);
  return {
    sets,
    rarities: rarities.filter((r): r is string => r != null),
  };
}

export async function togglePackActive(packId: string, active: boolean) {
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/packs");
  await requireCapability(session, "__can_toggle_pack_active", "toggle pack active state");
  if (
    active &&
    sessionHasRole(session, "pack_creator") &&
    !sessionIsAdmin(session) &&
    !sessionIsOwner(session)
  ) {
    throw new Error(
      "Pack Builders must request a live push through Pack Studio for owner approval.",
    );
  }

  const result = await db.execute<{ id: string }>(sql`
    UPDATE packs SET active = ${active}, updated_at = NOW()
    WHERE id = ${packId}::uuid
    RETURNING id
  `);
  if (result.rows.length === 0) throw new Error("Pack not found");

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: active ? "pack_activated" : "pack_deactivated",
    metadata: { pack_id: packId },
  });

  reloadPacks();

  revalidatePath("/packs");
  revalidatePath(`/packs/${packId}`);
}

export type PackCardInput = {
  cardId: string;
  weight: number;
  color: string | null;
  animation: boolean;
  order: number;
};

const MANAGEABLE_PACK_TYPES = new Set([
  "official",
  "custom",
  "promo",
  "reward",
]);

function assertManageablePackType(packType: string): void {
  if (!MANAGEABLE_PACK_TYPES.has(packType)) {
    throw new Error("Unsupported pack type");
  }
}

export async function createPack(data: {
  name: string;
  slug: string;
  description: string;
  price: number;
  cardsPerOpen: number;
  packType: string;
  imageUrl: string | null;
  tags: pack_tag[];
  difficulty: number | null;
  cards: PackCardInput[];
}): Promise<string> {
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/packs");

  if (!data.name.trim()) throw new Error("Name is required");
  if (!data.slug.trim()) throw new Error("Slug is required");
  if (data.price <= 0) throw new Error("Price must be greater than 0");

  assertManageablePackType(data.packType);

  await requireCapability(session, "__can_create_pack", "create packs");

  const pack = await db.transaction(async (tx) => {
    const packResult = await tx.execute<{ id: string }>(sql`
      INSERT INTO packs (
        name, slug, description, image_url, price, cards_per_open,
        pack_type, tags, difficulty, active
      ) VALUES (
        ${data.name.trim()}, ${data.slug.trim()},
        ${data.description.trim() || null}, ${data.imageUrl}, ${data.price},
        ${data.cardsPerOpen}, ${data.packType},
        ${pgArrayParam(packTagDbValues(data.tags))}::pack_tag[], ${data.difficulty}, false
      )
      RETURNING id
    `);
    const pack = packResult.rows[0];
    if (!pack) throw new Error("Pack insert returned no row");

    if (data.cards.length > 0) {
      await tx.execute(sql`
        INSERT INTO pack_cards (
          pack_id, card_id, weight, color, animation, "order"
        )
        SELECT ${pack.id}::uuid, *
        FROM unnest(
          ${pgArrayParam(data.cards.map((c) => c.cardId))}::uuid[],
          ${pgArrayParam(data.cards.map((c) => c.weight))}::int[],
          ${pgArrayParam(data.cards.map((c) => c.color))}::text[],
          ${pgArrayParam(data.cards.map((c) => c.animation))}::boolean[],
          ${pgArrayParam(data.cards.map((c) => c.order))}::int[]
        )
      `);
    }

    return pack;
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "pack_created",
    metadata: { pack_id: pack.id, name: data.name, card_count: data.cards.length },
  });

  reloadPacks();

  revalidatePath("/packs");
  return pack.id;
}

export async function updatePack(
  id: string,
  data: {
    name: string;
    slug: string;
    description: string;
    price: number;
    cardsPerOpen: number;
    packType: string;
    imageUrl: string | null;
    tags: pack_tag[];
    difficulty: number | null;
    cards: PackCardInput[];
  },
): Promise<void> {
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/packs");

  if (!data.name.trim()) throw new Error("Name is required");
  if (!data.slug.trim()) throw new Error("Slug is required");
  if (data.price <= 0) throw new Error("Price must be greater than 0");

  assertManageablePackType(data.packType);

  await requireCapability(session, "__can_update_pack", "update packs");

  // Pack creators can iterate on their demo packs (active=false) but
  // are blocked from editing packs already live in production —
  // unless they've been granted the `__can_edit_live_packs`
  // capability. The capability is the explicit per-user opt-in for
  // changing card pool / price / house edge on an in-production
  // pack; without it the previous "demo-only" behaviour is kept.
  // Admin / support / marketing with __can_update_pack still edit
  // anything as before — this gate is pack_creator-specific. Applies to
  // ANY user holding the pack_creator role (primary OR secondary in a
  // multi-role set) so the demo-only restriction can't be sidestepped by
  // stacking pack_creator under a higher-priority primary role. A real
  // admin short-circuits earlier in requireCapability, so this branch is
  // never reached for admins.
  let editedLivePackUnderCapability = false;
  if (sessionHasRole(session, "pack_creator")) {
    const target = (
      await db.execute<{ active: boolean }>(sql`
        SELECT active FROM packs WHERE id = ${id}::uuid LIMIT 1
      `)
    ).rows[0];
    if (!target) throw new Error("Pack not found");
    if (target.active) {
      // Look up the admin user's allowed_pages once — same shape the
      // rest of the codebase uses for capability checks against
      // non-admin roles.
      const perms = (
        await adminDrizzle.execute<{ allowed_pages: string[] }>(sql`
          SELECT allowed_pages FROM admin_users
          WHERE id = ${session.userId}::uuid
        `)
      ).rows[0];
      const canEditLive = perms
        ? hasCapability(perms.allowed_pages, "__can_edit_live_packs")
        : false;
      if (!canEditLive) {
        throw new Error(
          "Live packs can only be edited by full admins or pack creators with the 'Edit Live Packs' capability. Ask an admin to grant the capability, or deactivate the pack first.",
        );
      }
      editedLivePackUnderCapability = true;
    }
  }

  // Capture the PRIOR state (price + every card weight) into the ADMIN change
  // history BEFORE the MAIN write below replaces it — so this snapshot is the
  // state the owner can revert TO. Best-effort: a snapshot failure must NOT
  // fail the committed edit (the helper swallows + logs its own errors).
  await capturePackSnapshot({ packId: id, action: "edit", capturedBy: session.userId });

  await db.transaction(async (tx) => {
    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE packs
      SET name = ${data.name.trim()},
          slug = ${data.slug.trim()},
          description = ${data.description.trim() || null},
          image_url = ${data.imageUrl},
          price = ${data.price},
          cards_per_open = ${data.cardsPerOpen},
          pack_type = ${data.packType},
          tags = ${pgArrayParam(packTagDbValues(data.tags))}::pack_tag[],
          difficulty = ${data.difficulty},
          updated_at = NOW()
      WHERE id = ${id}::uuid
      RETURNING id
    `);
    if (updated.rows.length === 0) throw new Error("Pack not found");

    await tx.execute(sql`DELETE FROM pack_cards WHERE pack_id = ${id}::uuid`);

    if (data.cards.length > 0) {
      await tx.execute(sql`
        INSERT INTO pack_cards (
          pack_id, card_id, weight, color, animation, "order"
        )
        SELECT ${id}::uuid, *
        FROM unnest(
          ${pgArrayParam(data.cards.map((c) => c.cardId))}::uuid[],
          ${pgArrayParam(data.cards.map((c) => c.weight))}::int[],
          ${pgArrayParam(data.cards.map((c) => c.color))}::text[],
          ${pgArrayParam(data.cards.map((c) => c.animation))}::boolean[],
          ${pgArrayParam(data.cards.map((c) => c.order))}::int[]
        )
      `);
    }
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "pack_updated",
    metadata: {
      pack_id: id,
      name: data.name,
      card_count: data.cards.length,
      // Flag the rare case: a pack_creator edited an ACTIVE pack via
      // the explicit `__can_edit_live_packs` capability. Lets audit
      // reviews answer "who changed the house edge on a live pack?"
      // without re-deriving from role + pack.active at the time.
      ...(editedLivePackUnderCapability && {
        edited_live_pack_under_capability: true,
      }),
    },
  });

  reloadPacks();

  revalidatePath("/packs");
  revalidatePath(`/packs/${id}`);
}

export async function deletePack(packId: string): Promise<void> {
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/packs");
  await requireCapability(session, "__can_delete_pack", "delete packs");

  const pack = (
    await db.execute<{ name: string }>(sql`
      SELECT name FROM packs WHERE id = ${packId}::uuid LIMIT 1
    `)
  ).rows[0];
  if (!pack) throw new Error("Pack not found");

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM pack_cards WHERE pack_id = ${packId}::uuid
    `);
    const deleted = await tx.execute<{ id: string }>(sql`
      DELETE FROM packs WHERE id = ${packId}::uuid RETURNING id
    `);
    if (deleted.rows.length === 0) throw new Error("Pack not found");
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "pack_deleted",
    metadata: { pack_id: packId, name: pack.name },
  });

  reloadPacks();

  revalidatePath("/packs");
}

export async function fetchPackGames(
  packId: string,
  page: number,
  perPage: number,
  filters?: {
    dateFrom?: string;
    dateTo?: string;
    search?: string;
    sortBy?: string;
    sortOrder?: string;
    type?: string;
  }
) {
  await requirePageAccess("/packs");
  return getPackGames(packId, page, perPage, filters);
}

const MODAL_DETAIL_TIMEOUT_MS = 12_000;
const MODAL_STATS_TIMEOUT_MS = 15_000;
const MODAL_GAMES_TIMEOUT_MS = 15_000;

const EMPTY_GAMES_PAGE = {
  data: [] as Awaited<ReturnType<typeof getPackGames>>["data"],
  total: 0,
  page: 1,
  perPage: 20,
  totalPages: 0,
};

/** Lightweight identity read for modal header when the pack isn't on the list page. */
export async function fetchPackListSeed(packId: string) {
  await requirePageAccess("/packs");
  const db = await getPrimaryDrizzleDb();
  const result = await db.execute<{
    id: string; name: string; slug: string; image_url: string | null;
    price: string; active: boolean; pack_type: string;
  }>(sql`
    SELECT id, name, slug, image_url, price::text AS price, active, pack_type
    FROM packs WHERE id = ${packId}::uuid
  `);
  const pack = result.rows[0];
  if (!pack) return null;
  return {
    id: pack.id,
    name: pack.name,
    slug: pack.slug,
    imageUrl: pack.image_url,
    priceUsd: Number(pack.price),
    active: pack.active,
    packType: pack.pack_type as string | null,
  };
}

export async function fetchPackDetailCore(packId: string) {
  await requirePageAccess("/packs");
  const { data } = await safeQuery(
    () => getPackDetail(packId),
    null,
    "packs.modal.detail",
    MODAL_DETAIL_TIMEOUT_MS,
  );
  return data;
}

export async function fetchPackDetailStats(
  packId: string,
  detail: NonNullable<Awaited<ReturnType<typeof getPackDetail>>>,
): Promise<PackStats | null> {
  await requirePageAccess("/packs");
  const { data } = await safeQuery(
    () =>
      getPackStats(packId, detail.priceUsd, {
        totalPayout: detail.totalPayout,
        actualRtp: detail.actualRtp,
      }),
    null,
    "packs.modal.stats",
    MODAL_STATS_TIMEOUT_MS,
  );
  return data;
}

export async function fetchPackGamesSafe(
  packId: string,
  page: number,
  perPage: number,
) {
  await requirePageAccess("/packs");
  const { data, error } = await safeQuery(
    () => getPackGames(packId, page, perPage),
    EMPTY_GAMES_PAGE,
    "packs.modal.games",
    MODAL_GAMES_TIMEOUT_MS,
  );
  if (error) throw new Error("Games query timed out or failed");
  return data;
}

/** Full detail payload for the centered pack modal opened from the list. */
export type PackFullDetail = {
  /** The same shape the /packs/[id] page renders from `getPackDetail`. */
  detail: NonNullable<Awaited<ReturnType<typeof getPackDetail>>>;
  /**
   * Below-the-fold chart stats (the same `getPackStats` the page defers behind
   * <PackStatsLazy>). `null` when the two heavy JSON scans timed out / failed —
   * the modal then shows a stats-error tile while detail + card pool still
   * render. Never blocks the detail.
   */
  stats: PackStats | null;
};

/**
 * Assign a pack to a /packs pool tab (Pokemon / One Piece / Meme / Rewards)
 * WITHOUT touching any of its cards. A pack's pool is normally derived from
 * the sets of its cards; this override is stored in the ADMIN DB (the prod
 * game DB is read-only and has no pack-level set column) and wins over the
 * derived classification on /packs. Passing the pack's current derived pool
 * is fine — it just persists that choice explicitly.
 */
export async function setPackSet(
  packId: string,
  set: string,
): Promise<{ set: PackSetFilter }> {
  const session = await requirePageAccess("/packs");
  await requireCapability(session, "__can_update_pack", "update packs");

  if (!isUuid(packId)) throw new Error("Invalid pack id");
  if (!(PACK_POOLS as readonly string[]).includes(set)) {
    throw new Error("Invalid set");
  }
  const pool = set as PackSetFilter;

  // Validate the pack exists (read-only main DB) so we don't persist an
  // assignment for a deleted/typo'd id.
  const db = await getPrimaryDrizzleDb();
  const result = await db.execute<{ id: string; name: string }>(sql`
    SELECT id, name FROM packs WHERE id = ${packId}::uuid
  `);
  const pack = result.rows[0];
  if (!pack) throw new Error("Pack not found");

  await adminDrizzle.execute(sql`
    INSERT INTO pack_set_assignments
      (pack_id, pack_set, set_by_admin_id)
    VALUES (${packId}::uuid, ${pool}, ${session.userId}::uuid)
    ON CONFLICT (pack_id) DO UPDATE
    SET pack_set = EXCLUDED.pack_set,
        set_by_admin_id = EXCLUDED.set_by_admin_id,
        updated_at = NOW()
  `);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "pack_set_assigned",
    metadata: { packId: pack.id, packName: pack.name, set: pool },
  });

  // Pool membership changed → evict the cached pool KPI stats + re-render.
  revalidateTag("packs-list-stats");
  revalidatePath("/packs");
  revalidatePath(`/packs/${packId}`);

  return { set: pool };
}

/** The pack's explicit set override (null = none → card-derived). */
export async function getPackSetForEdit(
  packId: string,
): Promise<PackSetFilter | null> {
  await requirePageAccess("/packs");
  if (!isUuid(packId)) return null;
  return getPackSetAssignment(packId);
}

// ─── Global re-price to a target house edge (default 10.99%) ──────────
//
// Scope: ACTIVE, OFFICIAL packs only (never inactive, never promo / custom /
// reward). The tool ONLY ever adjusts a pack's `price` — it NEVER
// touches card odds (the pack_cards pool is read to compute EV, never written).
// The single most dangerous action in the panel; deliberately defensive:
//   1. `planRepriceAllPacks(target)` is a READ-ONLY dry-run — computes the full
//      before/after plan and writes NOTHING. Owner-only (no 2FA: it can't
//      change anything).
//   2. `authorizeReprice(totp)` verifies the owner's 2FA ONCE and mints a
//      short-lived signed token for the run.
//   3. `repricePackToTargetEdge(packId, token, target)` writes ONE pack at a
//      time (the client loops for live progress), requires a valid 2FA token,
//      re-derives the price server-side from fresh DB truth (never a
//      client-supplied price), and HARD-asserts the resulting edge is within
//      the hard tolerance of the target before persisting.
// The target + band rule live in the dep-free math module (`planPackReprice`)
// so the dry-run and the write share one implementation.

/**
 * Pack types eligible for the single-pack re-price write AND the retune tools:
 * `official` only. There is no `custom` pack type — every cash pack is an
 * `official` pack — so this matches the query module's
 * `REPRICE_INCLUDED_PACK_TYPES` (which scopes the GLOBAL dry-run/loop). Reward /
 * promo stays excluded.
 */
const REPRICE_OR_RETUNE_PACK_TYPES: readonly string[] = ["official"];

/**
 * Refresh ONE pack's ADMIN-side risk row from an already-computed {@link PackRisk}
 * (ADMIN write only — never touches MAIN). The Pack Studio Doctor grid + Overview
 * read their risk/compliance from the ADMIN `pack_risk_scores` snapshot table, so
 * after a MAIN odds/price write we mirror the SAME row shape the snapshot writer
 * persists (`buildPackCompliance` + the same resolved `maxWinCap`) and bust the
 * overview cache — otherwise the change wouldn't surface until the next full
 * snapshot run. Shared by `applyPackRetune` (post-weight-write) and
 * `repricePackToTargetEdge` (post-price-write).
 *
 * BEST-EFFORT BY CONTRACT: the MAIN write has already committed when this is
 * called, so an ADMIN-side failure must NOT fail the caller — it's swallowed and
 * logged, and the next snapshot run reconciles the row.
 */
async function refreshPackRiskScore(
  packId: string,
  risk: PackRisk,
  maxWinCap: number,
  // TRUE for a pct-tagged lottery pack — zero near-miss is the genre there,
  // never a compliance defect. Optional; omitted = legacy untagged judgment
  // (the next snapshot run reconciles the flag with full tag context).
  tagged?: boolean,
): Promise<void> {
  try {
    const riskRow = {
      edge: risk.edge,
      cv: risk.cv,
      win_rate: risk.winRate,
      near_miss: risk.nearMiss,
      max_win: risk.maxWin,
      max_mult: risk.maxMult,
      risk_score: risk.riskScore0to100,
      tier: risk.tier,
      compliance: buildPackCompliance(risk, maxWinCap, { tagged }),
      computed_at: new Date(),
    };
    await adminDrizzle.execute(sql`
      INSERT INTO pack_risk_scores
        (pack_id, edge, cv, win_rate, near_miss, max_win, max_mult,
         risk_score, tier, compliance, computed_at)
      VALUES (
        ${packId}, ${riskRow.edge}, ${riskRow.cv}, ${riskRow.win_rate},
        ${riskRow.near_miss}, ${riskRow.max_win}, ${riskRow.max_mult},
        ${riskRow.risk_score}, ${riskRow.tier},
        ${JSON.stringify(riskRow.compliance)}::jsonb, NOW()
      )
      ON CONFLICT (pack_id) DO UPDATE SET
        edge = EXCLUDED.edge, cv = EXCLUDED.cv,
        win_rate = EXCLUDED.win_rate, near_miss = EXCLUDED.near_miss,
        max_win = EXCLUDED.max_win, max_mult = EXCLUDED.max_mult,
        risk_score = EXCLUDED.risk_score, tier = EXCLUDED.tier,
        compliance = EXCLUDED.compliance, computed_at = EXCLUDED.computed_at
    `);

    // Bust the caches that READ this row, here rather than at each call site.
    // The Pack Doctor grid, the Overview KPIs and the Retune rail all serve
    // from 60s `unstable_cache` entries tagged "pack-studio-overview". Two of
    // the three callers (re-price and applyPackRetune) refreshed the row and
    // never invalidated that tag, so those surfaces kept showing the PRE-write
    // numbers for up to a minute while claiming to update immediately — and
    // the Doctor hero's candidate count stayed at the old value, so a second
    // run looked like it had done nothing. Invalidating inside the writer
    // makes it impossible for a future caller to forget.
    revalidateTag("pack-studio-overview");
  } catch (err) {
    console.error("refreshPackRiskScore: pack_risk_scores refresh failed", err);
  }
}

/** Validate + normalize a target edge fraction; throws on out-of-range input. */
function resolveRepriceTarget(target: number | undefined): number {
  const t = target ?? REPRICE_TARGET_DEFAULT;
  if (!Number.isFinite(t) || t < REPRICE_TARGET_MIN || t > REPRICE_TARGET_MAX) {
    throw new Error(
      `Target edge must be between ${(REPRICE_TARGET_MIN * 100).toFixed(0)}% and ${(REPRICE_TARGET_MAX * 100).toFixed(0)}%.`,
    );
  }
  return clampRepriceTarget(t);
}

/**
 * Resolve the actual target edge for ONE pack. For an explicit number it's the
 * validated/clamped flat target (unchanged behavior). For `"per-pack"` it's the
 * pack's curve target — `autoTargetEdge({ price, maxWin })` clamped into the
 * re-price band — using the pack's FRESH price + max obtainable card value
 * (`maxValue` from its aggregate composition) and the edge-curve config resolved
 * once per run. For `"floor-raise-only"` it's the curve's FLOOR — the same
 * 10.99% source of truth, with no per-pack risk premium on top. `clampRepriceTarget`
 * keeps it inside the tool's [1%, 50%] band; the curve already caps at 11.50% so
 * this is a defensive no-op for the curve.
 */
function resolvePerPackOrFlatTarget(
  target: RepriceTarget,
  pack: { price: number; maxWin: number },
  edgeCurve: EdgeCurveConfig,
): number {
  if (target === "per-pack") {
    return clampRepriceTarget(
      autoTargetEdge({ price: pack.price, maxWin: pack.maxWin }, edgeCurve),
    );
  }
  if (target === "floor-raise-only") {
    return clampRepriceTarget(edgeCurve.edgeFloor);
  }
  return resolveRepriceTarget(target);
}

export type RepricePlanRow = {
  packId: string;
  name: string;
  slug: string;
  packType: string;
  active: boolean;
  priceBefore: number;
  priceAfter: number | null;
  /** House-edge fractions (0.1099 = 10.99%). */
  edgeBefore: number;
  edgeAfter: number | null;
  action: RepriceAction;
  reason: string;
};

export type RepricePlanSummary = {
  /** Which game DB the writes would hit — surfaced so the operator can't
   *  confuse a prod run with a dev run. */
  dbEnv: DbEnv;
  /** The target edge this plan was computed for (fraction). */
  target: number;
  acceptMin: number;
  acceptMax: number;
  hardMin: number;
  hardMax: number;
  counts: {
    total: number;
    toReprice: number;
    unchanged: number;
    skipped: number;
  };
  /** Packs that WILL change, sorted by largest absolute price swing first so
   *  the scariest moves surface at the top of the preview. */
  toReprice: RepricePlanRow[];
  unchanged: RepricePlanRow[];
  skipped: RepricePlanRow[];
};

/**
 * READ-ONLY dry-run for the global re-price at `targetEdge` (default 10.99%).
 * Computes every in-scope (active, official) pack's current→new price and edge
 * and buckets them. Writes nothing — safe to run even against prod. Owner-only.
 */
export async function planRepriceAllPacks(
  targetEdge?: number,
): Promise<RepricePlanSummary> {
  const session = await requirePageAccess("/packs");
  if (!isRepriceOwner(session)) {
    throw new Error("The global re-price tool is restricted to the owner.");
  }
  const target = resolveRepriceTarget(targetEdge);

  const dbEnv = await readDbEnv();
  const packs = await getPacksPoolComposition(); // scoped: active official, price > 0

  const rows: RepricePlanRow[] = packs.map((p) => {
    const plan = planPackReprice({
      currentPrice: p.price,
      cardsPerOpen: p.cardsPerOpen,
      totalWeight: p.totalWeight,
      weightedPriceSum: p.weightedPriceSum,
      targetEdge: target,
      // Same one-sided-up rounding the write (`repricePackToTargetEdge`) uses, so
      // the dry-run preview reflects exactly what would be written — edge ≥ target,
      // never below — with no drift between preview and write.
      roundingMode: "up",
    });
    return {
      packId: p.id,
      name: p.name,
      slug: p.slug,
      packType: p.packType,
      active: p.active,
      priceBefore: p.price,
      priceAfter: plan.newPrice,
      edgeBefore: plan.currentEdge,
      edgeAfter: plan.newEdge,
      action: plan.action,
      reason: plan.reason,
    };
  });

  const toReprice = rows
    .filter((r) => r.action === "reprice")
    .sort(
      (a, b) =>
        Math.abs((b.priceAfter ?? b.priceBefore) - b.priceBefore) -
        Math.abs((a.priceAfter ?? a.priceBefore) - a.priceBefore),
    );
  const unchanged = rows.filter((r) => r.action === "unchanged");
  const skipped = rows.filter((r) => r.action === "skip");

  return {
    dbEnv,
    target,
    acceptMin: target - REPRICE_ACCEPT_TOLERANCE,
    acceptMax: target + REPRICE_ACCEPT_TOLERANCE,
    hardMin: target - REPRICE_HARD_TOLERANCE,
    hardMax: target + REPRICE_HARD_TOLERANCE,
    counts: {
      total: rows.length,
      toReprice: toReprice.length,
      unchanged: unchanged.length,
      skipped: skipped.length,
    },
    toReprice,
    unchanged,
    skipped,
  };
}

/**
 * Verify the owner's 2FA ONCE and mint a short-lived token authorizing a
 * re-price run. The client passes this token to each per-pack write so TOTP
 * isn't re-prompted per pack (and a long run can't expire mid-way).
 *
 * Open to owners and to the hard-coded Pack-Studio retune operator allowlist
 * (`isPackStudioRetuneOperator`). Operators on that allowlist bypass the TOTP
 * verification (mint a valid token without proving 2FA) — the audit event for
 * this mint records `via_no_2fa_allowlist: true` so the bypass is traceable.
 * Owners stay on the 2FA path.
 */
export async function authorizeReprice(
  totpCode: string,
): Promise<{ token: string }> {
  const session = await requirePageAccess("/packs");
  if (!isPackStudioRetuneOperator(session)) {
    throw new Error("The re-price tool is restricted to authorized operators.");
  }
  const bypass2fa = isPackStudioRetuneOperatorNonOwner(session);
  if (!bypass2fa) {
    // Throws "Invalid TOTP code" / "2FA not enabled" / "code required" verbatim.
    await require2FA(session.userId, totpCode);
  }
  // Audit the mint either way so every authorization is on record; flag the
  // bypass when it applied so a review can separate operator no-2FA mints from
  // owner-with-2FA mints. Best-effort: never block the mint on an audit-write
  // failure (the mint is intentionally observable + the per-pack write itself
  // is also audited).
  try {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "pack_reprice_authorized",
      metadata: bypass2fa
        ? { via_no_2fa_allowlist: true }
        : { via_2fa: true },
    });
  } catch {
    /* swallow — mint must not depend on audit availability */
  }
  return { token: await signRepriceToken(session.userId) };
}

export type RepriceResult = {
  packId: string;
  name: string;
  status: "repriced" | "unchanged" | "skipped" | "failed";
  priceBefore: number;
  priceAfter: number | null;
  edgeBefore: number;
  edgeAfter: number | null;
  reason: string;
};

/**
 * Re-price ONE pack to its target edge. The client loops over the dry-run's
 * `toReprice` ids, calling this per pack so the run is visible, stoppable, and
 * each pack is its own audited write.
 *
 * `targetEdge` selects the target:
 *   • a number — an explicit owner-chosen FLAT edge (the global re-price-all
 *     tool: every pack to the SAME edge the owner typed). Default 10.99%.
 *   • `"per-pack"` — derive each pack's target from the per-pack edge CURVE
 *     ({@link autoTargetEdge}: floor 10.99% + a gentle risk premium driven by the
 *     pack's max-win $ exposure + price). The Pack-Doctor "re-pin to target edge"
 *     flow passes this so each pack lands on ITS curve target, not a flat one.
 *
 * Authoritative & paranoid:
 *   - Owner-only, AND requires a valid 2FA token from `authorizeReprice`.
 *   - Re-fetches the pack's pool FRESH from the DB — the client supplies only an
 *     id + the token + the target SELECTOR, never a price (and, in per-pack mode,
 *     never the curve edge — it's derived here from fresh price + max-win).
 *   - Re-validates scope server-side (active / official / price) independently
 *     of the dry-run filter.
 *   - HARD-asserts the resulting edge is within the hard tolerance of the target
 *     and THROWS otherwise, so a logic regression fails closed (no write).
 *   - Writes ONLY `price` (+ updated_at); never touches realized stats / pool.
 */
export async function repricePackToTargetEdge(
  packId: string,
  token: string,
  targetEdge: RepriceTarget = REPRICE_TARGET_DEFAULT,
): Promise<RepriceResult> {
  const session = await requirePageAccess("/packs");
  if (!isPackStudioRetuneOperator(session)) {
    throw new Error("The re-price tool is restricted to authorized operators.");
  }
  await requireCapability(session, "__can_update_pack", "update packs");
  // 2FA gate: the run must carry a valid token minted by `authorizeReprice`.
  // Auth/token/target failures stay THROWS — they abort the whole run.
  if (!(await verifyRepriceToken(token, session.userId))) {
    throw new Error("2FA authorization expired or missing — re-confirm to continue.");
  }
  // For an explicit flat target, validate it UP FRONT (a bad owner override must
  // abort the whole run, not silently per-pack-skip). The per-pack curve target
  // is derived inside the try, once the pack's fresh price + max-win are known.
  const edgeCurve = isCurveRepriceTarget(targetEdge)
    ? await readEdgeCurveConfig()
    : DEFAULT_EDGE_CURVE;
  if (!isCurveRepriceTarget(targetEdge)) resolveRepriceTarget(targetEdge);

  // Everything pack-specific is wrapped so ONE pack's failure surfaces its REAL
  // message — a value returned from a server action is NOT masked the way a
  // thrown error is in production ("An error occurred in the Server Components
  // render…") — and the client can keep going through the rest of the batch.
  let comp: Awaited<ReturnType<typeof getPacksPoolComposition>>[number] | undefined;
  try {
    const db = await getPrimaryDrizzleDb();
    [comp] = await getPacksPoolComposition({ packIds: [packId] });
    if (!comp) {
      return {
        packId,
        name: packId,
        status: "failed",
        priceBefore: 0,
        priceAfter: null,
        edgeBefore: 0,
        edgeAfter: null,
        reason: "Pack not found.",
      };
    }

    // Defense-in-depth scope re-check (independent of the dry-run's WHERE):
    // active official packs only.
    const skip = (reason: string): RepriceResult => ({
      packId,
      name: comp!.name,
      status: "skipped",
      priceBefore: comp!.price,
      priceAfter: null,
      edgeBefore: 0,
      edgeAfter: null,
      reason,
    });
    // Scope: official packs only (there is no custom pack type — every cash pack
    // is an official pack whose price is a house-edge lever). Every other type
    // (reward / promo) is excluded. Every other guard (owner, token,
    // price>0, hard-band) is unchanged.
    if (!REPRICE_OR_RETUNE_PACK_TYPES.includes(comp.packType)) {
      return skip(`Out of scope: only official packs are re-priced (this is '${comp.packType}').`);
    }
    if (!comp.active) {
      return skip("Out of scope: only active packs are re-priced.");
    }
    if (!(comp.price > 0)) {
      return skip("Out of scope: pack has no price.");
    }

    // Resolve THIS pack's target now that its fresh price + max-win are known:
    // an explicit flat edge stays flat; `"per-pack"` derives the curve target
    // from the pack's own price + max obtainable card value (`maxValue`).
    const target = resolvePerPackOrFlatTarget(
      targetEdge,
      { price: comp.price, maxWin: comp.maxValue },
      edgeCurve,
    );

    const plan =
      targetEdge === "floor-raise-only"
        ? // BAND planner: the cheapest cent landing anywhere in [10.99%, 11.50%].
          // Aiming at the floor as a POINT (±0.05pp) would skip a pack whose next
          // cent lands at e.g. 11.48% — inside the owner's band, so not an
          // overshoot at all. This is what keeps "skipped" down to the packs a 1¢
          // step genuinely cannot fix.
          planFloorRaise({
            currentPrice: comp.price,
            cardsPerOpen: comp.cardsPerOpen,
            totalWeight: comp.totalWeight,
            weightedPriceSum: comp.weightedPriceSum,
            floor: target,
            ceiling: edgeCurve.edgeCeiling,
          })
        : planPackReprice({
            currentPrice: comp.price,
            cardsPerOpen: comp.cardsPerOpen,
            totalWeight: comp.totalWeight,
            weightedPriceSum: comp.weightedPriceSum,
            targetEdge: target,
            // One-sided-up rounding: the chosen cent's edge is ALWAYS ≥ the pack's
            // target — never the marginal under-target a "nearest" round could land
            // within the ±ACCEPT tolerance. This enforces the owner's floor (a
            // re-priced pack's edge is at or above target, never below). If no
            // whole-cent price hits target without overshooting beyond ACCEPT, "up"
            // returns skip (we never overcharge to force it). The dry-run preview uses
            // the SAME mode, so there's no drift between what's shown and what's written.
            roundingMode: "up",
          });

    if (plan.action !== "reprice" || plan.newPrice === null || plan.newEdge === null) {
      return {
        packId,
        name: comp.name,
        status: plan.action === "unchanged" ? "unchanged" : "skipped",
        priceBefore: comp.price,
        priceAfter: plan.newPrice,
        edgeBefore: plan.currentEdge,
        edgeAfter: plan.newEdge,
        reason: plan.reason,
      };
    }

    if (targetEdge === "floor-raise-only") {
      // ── RAISE-ONLY BACKSTOPS (owner rule: "only the price, up, to 10.99% or a
      // bit higher, max 11.5%"). Asserted HERE, on fresh DB truth, so a pack
      // that drifted since the preview fails closed instead of being written
      // off-rule. `planFloorRaise` already guarantees both by construction —
      // these exist so a future change to it cannot silently break the rule.
      if (plan.newPrice <= comp.price) {
        return skip(
          `Left alone: reaching ${(target * 100).toFixed(2)}% would need the price to go from ${comp.price.toFixed(2)} to ${plan.newPrice.toFixed(2)} — this action only raises prices.`,
        );
      }
      if (!isWithinFloorRaiseBand(plan.newEdge, target, edgeCurve.edgeCeiling)) {
        return {
          packId,
          name: comp.name,
          status: "failed",
          priceBefore: comp.price,
          priceAfter: null,
          edgeBefore: plan.currentEdge,
          edgeAfter: plan.newEdge,
          reason: `Refused: ${(plan.newEdge * 100).toFixed(2)}% is outside the allowed ${(target * 100).toFixed(2)}%–${(edgeCurve.edgeCeiling * 100).toFixed(2)}% band for a price-raise.`,
        };
      }
    } else if (!repriceEdgeWithinHardBand(plan.newEdge, target)) {
      // HARD BACKSTOP for the POINT-targeted modes — never persist a price whose
      // edge escapes the hard tolerance of the target. Deliberately NOT applied
      // to the band mode: ±0.2pp around 10.99% stops at 11.19%, which would
      // reject a perfectly legal 11.48% landing inside the owner's band. The
      // band check above is that mode's equivalent guard.
      return {
        packId,
        name: comp.name,
        status: "failed",
        priceBefore: comp.price,
        priceAfter: null,
        edgeBefore: plan.currentEdge,
        edgeAfter: plan.newEdge,
        reason: `Refused: resulting edge ${(plan.newEdge * 100).toFixed(2)}% is outside the hard band around ${(target * 100).toFixed(2)}%.`,
      };
    }

    // Capture the PRIOR state (price + every card weight) into the ADMIN change
    // history BEFORE the price write below — so this snapshot is the state the
    // owner can revert TO. Best-effort: a snapshot failure must NOT fail the
    // committed reprice (the helper swallows + logs its own errors).
    await capturePackSnapshot({
      packId,
      action: "reprice",
      capturedBy: session.userId,
    });

    // ONLY the price is written (+ updated_at). Card odds (pack_cards) are never
    // touched — re-pricing moves the sticker price, nothing else.
    const updated = await db.execute<{ id: string }>(sql`
      UPDATE packs
      SET price = ${plan.newPrice}, updated_at = NOW()
      WHERE id = ${packId}::uuid
      RETURNING id
    `);
    if (updated.rows.length === 0) {
      return {
        packId,
        name: comp.name,
        status: "failed",
        priceBefore: comp.price,
        priceAfter: null,
        edgeBefore: plan.currentEdge,
        edgeAfter: null,
        reason: "Pack not found.",
      };
    }

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "pack_updated",
      metadata: {
        pack_id: packId,
        name: comp.name,
        via: "reprice_to_target_edge",
        target_edge: target,
        price_before: comp.price,
        price_after: plan.newPrice,
        edge_before: plan.currentEdge,
        edge_after: plan.newEdge,
      },
    });

    // ── Refresh the pack's ADMIN-side risk row from the new price (ADMIN write) ──
    // The re-price moved ONLY the sticker price; card odds (weights/values) are
    // unchanged. So the pack's new risk is the SAME fresh aggregate composition
    // (`comp`, just read read-only from MAIN) scored at the NEW price — exactly
    // what the snapshot writer computes via `computePackRiskFromAggregates`. We
    // recompute it here and upsert the ADMIN `pack_risk_scores` row through the
    // shared `refreshPackRiskScore` helper (same row shape + `buildPackCompliance`
    // + the same `readMaxWinCap` the snapshot uses) so the Doctor grid + Overview
    // reflect the new edge instantly instead of showing a stale row until the next
    // snapshot run. Best-effort by contract: the MAIN price write has already
    // committed, so an ADMIN-side failure must NOT fail this reprice.
    const repricedRisk = computePackRiskFromAggregates({
      price: plan.newPrice,
      totalWeight: comp.totalWeight,
      weightedPriceSum: comp.weightedPriceSum,
      weightedSqSum: comp.weightedSqSum,
      winWeight: comp.winWeight,
      nearMissWeight: comp.nearMissWeight,
      maxValue: comp.maxValue,
      floorValue: comp.floorValue,
    });
    await refreshPackRiskScore(packId, repricedRisk, await readMaxWinCap());

    reloadPacks();
    // Re-price changes a pack's price → the V2 retune plan shapes off that
    // price, so invalidate it. Per-pack: ONLY this pack's plan is busted
    // (never the other 182).
    revalidateTag(packRetunePlanTag(packId));
    revalidatePath("/packs");
    revalidatePath(`/packs/${packId}`);

    return {
      packId,
      name: comp.name,
      status: "repriced",
      priceBefore: comp.price,
      priceAfter: plan.newPrice,
      edgeBefore: plan.currentEdge,
      edgeAfter: plan.newEdge,
      reason: "",
    };
  } catch (err) {
    // The REAL cause (DB error, audit write, etc.) — returned as data so prod
    // doesn't mask it behind the generic digest message.
    return {
      packId,
      name: comp?.name ?? packId,
      status: "failed",
      priceBefore: comp?.price ?? 0,
      priceAfter: null,
      edgeBefore: 0,
      edgeAfter: null,
      reason: err instanceof Error ? err.message : "Write failed.",
    };
  }
}

// ─── Pack retune (rewrite per-card WEIGHTS to a target edge + win-rate) ─
//
// Scope & danger: retune rewrites a pack's odds (the pack_cards WEIGHTS), the
// single most consequential mutation after a global re-price. It mirrors
// `repricePackToTargetEdge`'s paranoia exactly, with one difference: it carries
// its OWN 2FA token scope (`retune`, via signRetuneToken) so a re-price token
// can never authorize a retune. Three steps:
//   1. planPackRetune(packId, targets)  — READ-ONLY dry-run (owner-gated, no
//      2FA, can't change anything). Returns before/after risk + the weight diff.
//   2. authorizePackRetune(totp)        — verify owner 2FA ONCE → mint a retune
//      token (owner + __can_update_pack gated).
//   3. applyPackRetune(packId, token, targets) — re-fetch FRESH pool + price,
//      re-run shapeWeights SERVER-SIDE (never trust client weights), FAIL-CLOSED
//      asserts, then write the new weights via the SAME delete-all-then-
//      createMany pack_cards transaction `updatePack` uses.

/**
 * The retune levers (mirror `ShapeWeightsInput`'s tunable knobs). EVERY field is
 * optional: any field the caller omits is filled from `autoRetuneTargets(price)`
 * (the house edge target, the default win-rate + near-miss floors, and the
 * auto-resolved jackpot cap derived from the pack price). So the per-pack drawer
 * can pass `{}` for a fully-automatic re-tune, or override just the knobs it
 * cares about — it no longer has to supply a max-win cap by hand.
 */
export type PackRetuneTargets = {
  /** Target house edge (0..1). Defaults to the house knob (10.99%). */
  targetEdge?: number;
  /** Desired probability mass on win+grail cards (value ≥ price). */
  targetWinRate?: number;
  /** Drop any card whose value exceeds this cap (jackpot ceiling). */
  maxWinCap?: number;
  /** If set, pin the floor (modal) card so floorValue/price ≥ this. */
  floorRatioMin?: number;
  /** Minimum probability mass on near-miss cards. */
  nearMissMin?: number;
  /**
   * When TRUE, run `searchBestPriceForCleanSnap` around the live ticket price
   * (the shared ±60% retune band, `RETUNE_MAX_PRICE_CHANGE_PCT` — same band
   * the planner preview searched) and pick the candidate whose `shapeWeights`
   * result lands every card on a clean ladder rung. When the operator nudged the
   * edge target UP via the chip-strip (`targetEdge` > pack baseline), the
   * search ALSO extends the upward band so the ticket can RISE as far as
   * needed to simultaneously hit (raised edge + clean odds + win-rate).
   * The chosen price becomes the FINAL `priceAfter` written to `packs.price`.
   * Defaults to FALSE — legacy behavior preserved for callers that don't opt
   * in (so the pack-detail drawer's direct retune still holds price fixed).
   */
  allowPriceSearch?: boolean;
  /**
   * Upward price-search extension as a fraction of the live ticket price
   * (e.g. `2.0` = up to 3× base) — only used when `allowPriceSearch` is true.
   * Owner's chip-strip path passes a non-zero value when the edge floor is
   * nudged above baseline so the solver can climb past the +60% ceiling.
   * Defaults to 0 (use only the symmetric ±60% retune band).
   */
  upwardPriceExtensionPct?: number;
  /**
   * Operator-pinned target ticket price (USD) — ANCHOR for the clean-snap
   * price search. When set (non-null, > 0), the search re-centers around this
   * absolute USD anchor rather than the pack's live price, so the operator
   * can opt: "shape this pack to a $X ticket". The chosen `priceAfter` will
   * cluster near the anchor (still nudged ±60% / +200% in the chip-strip-
   * nudged case to land a clean snap that satisfies edge + win-rate). Only
   * meaningful when `allowPriceSearch` is true; ignored otherwise. Null /
   * undefined = use the live `packs.price` (default).
   *
   * SAFETY: when an anchor is active, the search runs in `preferHigherEdge`
   * mode so an anchor that lowers the price doesn't silently give up house
   * edge (the scorer ranks higher achieved edge above cleaner snap).
   */
  priceOverride?: number | null;
  /**
   * RC1 approved-artifact contract — the previewed `priceAfter` the operator
   * approved (`PlanAllProposal.priceAfter`, or the Adjust panel's re-solve).
   * When set, the write REFUSES (no write) if its own re-solve lands on ANY
   * other price (tolerance 0): with `approvedPoolFingerprint` verified fresh,
   * a differing price can only be a preview↔write parameter skew or a
   * nondeterminism bug — surfaced honestly instead of silently writing a
   * price/odds the operator never saw (the audit's fleet mirror measured 112/
   * 183 price and 175/183 weight divergences before the band/anchor share).
   * Optional — legacy callers (doctor drawer/bulk) are unaffected.
   */
  approvedPriceAfter?: number | null;
  /**
   * RC1 pool-freshness token — `PlanAllProposal.poolFingerprint`, the
   * fingerprint of the LIVE pool (price + sorted (cardId, weight) pairs) the
   * approved proposal was solved from. When set, the write recomputes the
   * fingerprint over the FRESH pool and REFUSES on mismatch ("pool changed
   * since the preview — refresh") instead of silently re-solving different
   * inputs. Optional — legacy callers are unaffected.
   */
  approvedPoolFingerprint?: string | null;
};

/** Target set with the auto-defaults applied (used internally by plan/apply). */
type ResolvedRetuneTargets = {
  targetWinRate: number;
  nearMissMin: number;
  maxWinCap: number;
  floorRatioMin?: number;
  /**
   * The INTENDED hit-rate parsed from the pack NAME (its leading `X%` tag), or
   * `null` for an untagged pack. When the caller didn't override `targetWinRate`,
   * the resolved `targetWinRate` equals this (a tagged pack targets its tag).
   */
  intendedHitRate: number | null;
};

/**
 * Fill any target field the caller omitted from the auto-defaults for `price`.
 * `cfg` is resolved ONCE per call (via `readMaxWinCap()` + `readMaxMultCeiling()`)
 * so the drawer can fire a fully-automatic retune (`{}`) and still get a sane,
 * price-relative jackpot cap. Explicit caller values always win; `floorRatioMin`
 * has no auto-default (it's an opt-in floor pin), so it passes through as-is.
 *
 * TAG-AWARE WIN-RATE: `name` is the pack name — a pack whose name starts with
 * `X%` (e.g. "10% Divine Order") gets THAT hit-rate as its auto win-rate
 * (`parsePackHitRate`); an untagged pack keeps the default 20%. An explicit
 * `targets.targetWinRate` still overrides the tag.
 */
function resolveRetuneTargets(
  price: number,
  cfg: ResolvedAutoTargetCfg,
  targets: PackRetuneTargets,
  // The pack name (parsed for a leading "X%" tag) OR a pre-resolved intended
  // hit-rate fraction (callers resolve the DB `tags` column first via
  // `resolveIntendedHitRate` and pass the number through).
  nameOrHitRate?: string | number,
): ResolvedRetuneTargets {
  const auto = autoRetuneTargets(price, cfg, nameOrHitRate);
  return {
    targetWinRate: targets.targetWinRate ?? auto.targetWinRate,
    nearMissMin: targets.nearMissMin ?? auto.nearMissMin,
    maxWinCap: targets.maxWinCap ?? auto.maxWinCap,
    floorRatioMin: targets.floorRatioMin,
    intendedHitRate: auto.intendedHitRate,
  };
}

export type PackRetunePlan = {
  feasible: boolean;
  error?: string;
  /** Risk of the pack AS IT IS NOW. */
  before: PackRisk;
  /** Risk the pack WOULD have after the retune (null when infeasible). */
  after: PackRisk | null;
  /** Per-card weight change (only cards whose weight would change). */
  weightDiff: { cardId: string; from: number; to: number }[];
  /**
   * The INTENDED hit-rate parsed from the pack NAME (its leading `X%` tag, e.g.
   * "10% Divine Order" → 0.10), or `null` for an untagged pack — so the UI can
   * show "1% pack → targeting 1% win-rate".
   */
  intendedHitRate: number | null;
  /** The win-rate this retune was shaped to (the tag hit-rate, or the default). */
  targetWinRate: number;
};

/**
 * Resolve the target edge for a retune from the optional override, reusing the
 * SAME band the global re-price enforces so the two tools can't drift. Throws on
 * an out-of-range override; falls back to the house knob (10.99%).
 */
function resolveRetuneTargetEdge(targetEdge: number | undefined): number {
  if (targetEdge === undefined) return TARGET_HOUSE_EDGE;
  return resolveRepriceTarget(targetEdge);
}

/**
 * The pack_creator live-pack carve-out, shared by `applyPackRetune` (and
 * mirroring `updatePack` / `quickUpdatePack`): a pack_creator may iterate on
 * demo (inactive) packs but is blocked from rewriting an ACTIVE pack's odds
 * unless granted `__can_edit_live_packs`. A real admin short-circuits earlier in
 * `requireCapability`, so this is only reached for non-admins. Returns true iff
 * an active pack was edited under the explicit capability (for the audit flag).
 */
async function enforcePackCreatorLiveGate(
  _db: MainDrizzleDb,
  session: Awaited<ReturnType<typeof requirePageAccess>>,
  packId: string,
  active: boolean,
): Promise<boolean> {
  if (!sessionHasRole(session, "pack_creator")) return false;
  if (!active) return false;
  const perms = (
    await adminDrizzle.execute<{ allowed_pages: string[] }>(sql`
      SELECT allowed_pages FROM admin_users
      WHERE id = ${session.userId}::uuid
    `)
  ).rows[0];
  const canEditLive = perms
    ? hasCapability(perms.allowed_pages, "__can_edit_live_packs")
    : false;
  if (!canEditLive) {
    throw new Error(
      "Live packs can only be edited by full admins or pack creators with the 'Edit Live Packs' capability. Ask an admin to grant the capability, or deactivate the pack first.",
    );
  }
  return true;
}

/**
 * READ-ONLY dry-run: compute the before/after risk and per-card weight diff a
 * retune to `targets` would produce, WITHOUT writing anything. Owner-only (it
 * can't change anything, so no 2FA here). Reads fresh price + pool, runs
 * `shapeWeights` server-side, and returns either a feasible plan or the solver's
 * error verbatim.
 */
export async function planPackRetune(
  packId: string,
  targets: PackRetuneTargets,
): Promise<PackRetunePlan> {
  const session = await requirePageAccess("/packs");
  if (!isPackStudioRetuneOperator(session)) {
    throw new Error("The pack retune tool is restricted to authorized operators.");
  }
  if (!isUuid(packId)) throw new Error("Invalid pack id");

  const targetEdge = resolveRetuneTargetEdge(targets.targetEdge);

  const db = await getPrimaryDrizzleDb();
  const result = await db.execute<{
    price: string; name: string; tags: string[];
  }>(sql`
    SELECT price::text AS price, name, tags::text[] AS tags
    FROM packs WHERE id = ${packId}::uuid
  `);
  const pack = result.rows[0];
  if (!pack) throw new Error("Pack not found");
  const price = Number(pack.price.toString());

  // Resolve the auto-target config ONCE, then fill any field the caller omitted
  // (so the drawer can fire a fully-automatic retune without a hand-set cap).
  // The pack NAME makes the auto win-rate TAG-AWARE (a "10%" pack targets 10%).
  const cfg: ResolvedAutoTargetCfg = {
    globalCap: await readMaxWinCap(),
    maxMultCeiling: await readMaxMultCeiling(),
  };
  const resolved = resolveRetuneTargets(
    price,
    cfg,
    targets,
    // DB `tags` column first (authoritative), name-prefix tag as fallback —
    // a "%1"-tagged pack whose name lacks the "1%" prefix must NOT fall back
    // to the untagged 20% default.
    resolveIntendedHitRate(pack.name, pack.tags) ?? undefined,
  );

  const pool = await getPackCardValues(packId);
  const before = computePackRisk({
    cards: pool.map((c) => ({ value: c.value, weight: c.weight })),
    price,
  });

  const shaped = shapeWeights({
    cards: pool.map((c) => ({ value: c.value })),
    price,
    targetEdge,
    targetWinRate: resolved.targetWinRate,
    maxWinCap: resolved.maxWinCap,
    floorRatioMin: resolved.floorRatioMin,
    nearMissMin: resolved.nearMissMin,
  });

  if ("error" in shaped) {
    return {
      feasible: false,
      error: shaped.error,
      before,
      after: null,
      weightDiff: [],
      intendedHitRate: resolved.intendedHitRate,
      targetWinRate: resolved.targetWinRate,
    };
  }

  const weightDiff = pool
    .map((c, i) => ({ cardId: c.cardId, from: c.weight, to: shaped.weights[i]! }))
    .filter((d) => d.from !== d.to);

  return {
    feasible: true,
    before,
    after: shaped.risk,
    weightDiff,
    intendedHitRate: resolved.intendedHitRate,
    targetWinRate: resolved.targetWinRate,
  };
}

/**
 * Verify the owner's 2FA ONCE and mint a short-lived RETUNE token.
 * `__can_update_pack`-gated; the token's scope is `retune` (distinct from the
 * re-price scope) so it can only authorize `applyPackRetune`.
 *
 * Open to owners and to the hard-coded Pack-Studio retune operator allowlist
 * (`isPackStudioRetuneOperator`). Operators on that allowlist bypass the TOTP
 * verification (mint a valid token without proving 2FA) — the audit event for
 * this mint records `via_no_2fa_allowlist: true` so the bypass is traceable.
 * Owners stay on the 2FA path.
 */
export async function authorizePackRetune(
  totpCode: string,
): Promise<{ token: string }> {
  const session = await requirePageAccess("/packs");
  if (!isPackStudioRetuneOperator(session)) {
    throw new Error("The pack retune tool is restricted to authorized operators.");
  }
  await requireCapability(session, "__can_update_pack", "retune packs");
  const bypass2fa = isPackStudioRetuneOperatorNonOwner(session);
  if (!bypass2fa) {
    // Throws "Invalid TOTP code" / "2FA not enabled" / "code required" verbatim.
    await require2FA(session.userId, totpCode);
  }
  // Audit the mint either way; flag the bypass when it applied. Best-effort
  // (the per-pack apply is itself audited; the mint audit is a belt-and-
  // suspenders trail for an operator-no-2FA review).
  try {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "pack_retune_authorized",
      metadata: bypass2fa
        ? { via_no_2fa_allowlist: true }
        : { via_2fa: true },
    });
  } catch {
    /* swallow — mint must not depend on audit availability */
  }
  return { token: await signRetuneToken(session.userId) };
}

/**
 * Mint a RETUNE token for the Pack Studio retune REVIEW flow with NO TOTP/2FA.
 *
 * The retune review/approve flow lives entirely in admin-staging — the operator
 * tinder-swipes through pre-computed proposals and approves what looks right.
 * The owner found the per-session 2FA prompt annoying enough that the friction
 * outweighed the (already weak) security justification — the underlying writes
 * are still operator/capability/scope-gated and audit-logged, and a malicious
 * client can't bypass any of those guards.
 *
 * Behaviour vs. `authorizePackRetune`:
 *   • SAME operator allowlist (`isPackStudioRetuneOperator`) check.
 *   • SAME `__can_update_pack` capability check.
 *   • SAME `signRetuneToken` mint (so the token verifies identically against
 *     `verifyRetuneToken` in `applyPackRetune` / `applyPackEdit` /
 *     `applyStagedPackEditAndRetune` / `revertPackToSnapshot`).
 *   • NO TOTP — `require2FA` is not called.
 *   • Audit-event still fires with `via_no_2fa_review: true` so a refusal /
 *     bypass is traceable.
 *
 * Other callers (history-timeline revert, doctor drawer, bulk-retune button)
 * continue to use `authorizePackRetune` and its TOTP gate untouched.
 */
export async function authorizePackRetuneForReview(): Promise<{ token: string }> {
  const session = await requirePageAccess("/packs");
  if (!isPackStudioRetuneOperator(session)) {
    throw new Error("The pack retune tool is restricted to authorized operators.");
  }
  await requireCapability(session, "__can_update_pack", "retune packs");
  // Audit the mint — flagged so a review can split no-2FA review-flow mints
  // from owner-with-2FA mints. Best-effort: the per-pack apply audits its own
  // write, this trail is belt-and-suspenders.
  try {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "pack_retune_authorized",
      metadata: { via_no_2fa_review: true },
    });
  } catch {
    /* swallow — mint must not depend on audit availability */
  }
  return { token: await signRetuneToken(session.userId) };
}

export type PackRetuneResult = {
  packId: string;
  name: string;
  status: "retuned";
  /** Ticket price BEFORE the retune (USD). */
  priceBefore: number;
  /**
   * Ticket price AFTER the retune (USD). Equal to `priceBefore` unless the
   * caller opted into `allowPriceSearch` AND the clean-snap search picked a
   * different price (typically a small upward nudge for clean odds, or a
   * larger upward push when the operator raised the edge target via the
   * chip-strip). When `priceAfter !== priceBefore`, `packs.price` was
   * REWRITTEN inside the same transaction as the weights.
   */
  priceAfter: number;
  before: { edge: number; winRate: number; maxWin: number };
  after: { edge: number; winRate: number; maxWin: number };
};

/**
 * Apply a retune: rewrite the pack's per-card WEIGHTS so it hits `targets`.
 * Authoritative & paranoid (mirrors `repricePackToTargetEdge`):
 *   - Owner-only AND requires a valid RETUNE token from `authorizePackRetune`.
 *   - `__can_update_pack` capability + the pack_creator live-pack carve-out.
 *   - RE-FETCHES fresh pool + price from the DB — the client supplies only an
 *     id + the token + the targets, never weights or a price.
 *   - Re-runs `shapeWeights` SERVER-SIDE and FAILS CLOSED (throws) if the result
 *     is the error arm, the edge slips below target, the cap is exceeded, or the
 *     win-rate misses tolerance — so a logic regression never writes.
 *   - Writes the new weights via the SAME delete-all-then-createMany pack_cards
 *     transaction `updatePack` uses, preserving each surviving card's
 *     color / animation / order from the existing rows.
 *
 * REFUSALS ARE DATA, NOT THROWS (incident 2026-07-11): Next.js prod masks
 * server-action throws ("Server Components render" text), which broke the
 * workspace's string-matched refusal routing (token re-mint, drift rebase,
 * skew, invariant). The exported action catches the inner throw and returns
 * `{ refusedMessage }`; the inner implementation keeps its throw-based flow.
 */
export async function applyPackRetune(
  ...args: Parameters<typeof applyPackRetuneInner>
): Promise<PackRetuneResult | { refusedMessage: string }> {
  try {
    return await applyPackRetuneInner(...args);
  } catch (err) {
    unstable_rethrow(err);
    return {
      refusedMessage:
        err instanceof Error ? err.message : "The write failed unexpectedly.",
    };
  }
}

async function applyPackRetuneInner(
  packId: string,
  token: string,
  targets: PackRetuneTargets,
): Promise<PackRetuneResult> {
  const session = await requirePageAccess("/packs");
  if (!isPackStudioRetuneOperator(session)) {
    throw new Error("The pack retune tool is restricted to authorized operators.");
  }
  await requireCapability(session, "__can_update_pack", "retune packs");
  if (!(await verifyRetuneToken(token, session.userId))) {
    throw new Error("2FA authorization expired or missing — re-confirm to continue.");
  }
  if (!isUuid(packId)) throw new Error("Invalid pack id");

  const targetEdge = resolveRetuneTargetEdge(targets.targetEdge);
  const winRateTol = 0.02; // matches shapeWeights' default winRateTol

  const db = await getPrimaryDrizzleDb();

  // Fresh pack row (price + scope + the existing pack_cards for color/anim/order).
  const packResult = await db.execute<{
    price: string; active: boolean; pack_type: string; name: string;
    tags: string[];
    pack_cards: Array<{
      card_id: string; color: string | null; animation: boolean; order: number;
    }>;
  }>(sql`
    SELECT p.price::text AS price, p.active, p.pack_type, p.name,
           p.tags::text[] AS tags,
           COALESCE(jsonb_agg(jsonb_build_object(
             'card_id', pc.card_id, 'color', pc.color,
             'animation', pc.animation, 'order', pc."order"
           ) ORDER BY pc."order") FILTER (WHERE pc.id IS NOT NULL), '[]'::jsonb)
             AS pack_cards
    FROM packs p
    LEFT JOIN pack_cards pc ON pc.pack_id = p.id
    WHERE p.id = ${packId}::uuid
    GROUP BY p.id
  `);
  const pack = packResult.rows[0];
  if (!pack) throw new Error("Pack not found");

  if (!REPRICE_OR_RETUNE_PACK_TYPES.includes(pack.pack_type)) {
    throw new Error(
      `Out of scope: only official packs can be retuned (this is '${pack.pack_type}').`,
    );
  }
  const price = Number(pack.price.toString());
  if (!(price > 0)) throw new Error("Out of scope: pack has no price.");

  // Resolve the auto-target config ONCE, then fill any target field the caller
  // omitted (the drawer sends no max-win cap → it's auto-set from the price).
  const cfg: ResolvedAutoTargetCfg = {
    globalCap: await readMaxWinCap(),
    maxMultCeiling: await readMaxMultCeiling(),
  };
  // The DEFAULT retune price budget (±10% unless configured) — resolved at
  // WRITE time and threaded into the shared builder so the write re-solves the
  // SAME band the plan previewed (the tolerance-0 approvedPriceAfter pin
  // catches any band-induced divergence).
  const priceBudgetPct = await readRetunePriceBudgetPct();
  const resolved = resolveRetuneTargets(
    price,
    cfg,
    targets,
    // DB `tags` column first (authoritative), name-prefix tag as fallback —
    // a "%1"-tagged pack whose name lacks the "1%" prefix must NOT fall back
    // to the untagged 20% default.
    resolveIntendedHitRate(pack.name, pack.tags) ?? undefined,
  );

  // A pct-tagged pack's win-rate is a design CONTRACT — refuse a pinned
  // target that contradicts the tag. The doctor bulk dialog used to pin a
  // flat 20% over every selected pack (a "1%" pack was empirically written to
  // ~20% winners); the drawer seeded its lever from the DRIFTED current
  // win-rate. Operators who truly want a different rate must untag the pack
  // (name prefix + tags column) first.
  // Tolerance 1e-6 (ruleset §0): the tag is exact — any real divergence is a
  // contradiction, not a rounding allowance; float round-trips of the tag
  // itself are lossless.
  if (
    resolved.intendedHitRate !== null &&
    Math.abs(resolved.targetWinRate - resolved.intendedHitRate) > 1e-6
  ) {
    throw new Error(
      `Refused: this pack is tagged ${(resolved.intendedHitRate * 100).toFixed(2)}% — the requested win-rate ${(resolved.targetWinRate * 100).toFixed(2)}% contradicts the tag. Leave the win-rate on auto (tag-aware), or untag the pack first.`,
    );
  }

  // pack_creator live-pack carve-out (same gate updatePack enforces).
  const editedLivePackUnderCapability = await enforcePackCreatorLiveGate(
    db,
    session,
    packId,
    pack.active,
  );

  // FRESH pool — never trust client weights.
  const pool = await getPackCardValues(packId);
  if (pool.length === 0) throw new Error("Pack has no cards to retune.");

  // ── RC1 pool-freshness gate (fail closed BEFORE solving) ────────────────
  // The review client stamps its Approve with the fingerprint of the pool the
  // approved proposal was solved from (`PlanAllProposal.poolFingerprint`).
  // The proposal blob is cached up to 60s and the operator can sit on a card
  // far longer — if ANOTHER edit landed in between (price change, card
  // added/removed, weights rewritten), this write would silently re-solve
  // DIFFERENT inputs than the operator approved. Refuse instead; the operator
  // refreshes and re-reviews. Absent for legacy callers (doctor drawer/bulk).
  const approvedPoolFingerprint =
    typeof targets.approvedPoolFingerprint === "string" &&
    targets.approvedPoolFingerprint.length > 0
      ? targets.approvedPoolFingerprint
      : null;
  if (
    approvedPoolFingerprint !== null &&
    computePoolFingerprint(price, pool) !== approvedPoolFingerprint
  ) {
    throw new Error(
      "Refused: this pack's pool or price changed since the approved proposal was computed — refresh the proposals and re-review this pack before approving.",
    );
  }

  const before = computePackRisk({
    cards: pool.map((c) => ({ value: c.value, weight: c.weight })),
    price,
  });

  // TAGGED near-miss seed (ruleset §1.2) for callers that left nearMissMin on
  // auto: no default floor — a lottery is binary — but a live pool that
  // GENUINELY carries near-miss mass keeps its designed band. The V2 client
  // threads the plan's seeded value explicitly, so this only fires for legacy
  // callers (doctor drawer) and keeps them consistent with the plan.
  if (targets.nearMissMin === undefined && resolved.intendedHitRate !== null) {
    resolved.nearMissMin = Math.max(TAGGED_NEAR_MISS_MIN, before.nearMiss);
  }

  // Price-search lever (chip-strip path opts in):
  //   • allowPriceSearch off → legacy: hold price fixed, raw `shapeWeights`.
  //   • allowPriceSearch on  → route through `searchBestPriceForCleanSnap`.
  //     The owner explicitly asked for this:
  //       "u can change the price of the pack to keep the edge better or
  //        chances … none of these odds is clean, all dirty shit numbers"
  //     The band is the SHARED ±60% retune band (`RETUNE_MAX_PRICE_CHANGE_PCT`)
  //     — the same band `planAllRetunes` / `planSingleRetune` searched to
  //     produce the preview the operator approved, so this write re-runs the
  //     SAME search and lands on the SAME price/odds. When the operator raised
  //     the edge target via the chip-strip (`upwardPriceExtensionPct` > 0),
  //     the search also extends UPWARD past the band so the ticket can RISE as
  //     far as needed to simultaneously hit (raised edge target + clean ladder
  //     odds + tag/default win-rate).
  //     The chosen price becomes the FINAL `priceAfter` written below.
  const allowPriceSearch = targets.allowPriceSearch === true;
  const upwardExtension = Math.max(0, targets.upwardPriceExtensionPct ?? 0);
  // Operator-pinned absolute price anchor (USD). When set + > 0, the search
  // re-centers around this anchor instead of `price`. Only meaningful when
  // `allowPriceSearch` is true. Activating an anchor also flips the search
  // into `preferHigherEdge` mode so an anchor that lowers the price doesn't
  // silently give up edge (owner-reported $1.25 → $1.00 regression).
  const priceAnchor =
    targets.priceOverride != null &&
    Number.isFinite(targets.priceOverride) &&
    targets.priceOverride > 0
      ? targets.priceOverride
      : null;
  // Same `preferHigherEdge` gate as `planAllRetunes`: on whenever the operator
  // pushed the edge target up via the chip strip (upwardExtension > 0) OR
  // pinned an explicit price anchor. Keeps the write's chosen price in sync
  // with the on-screen preview produced by `planAllRetunes`.
  const preferHigherEdge = upwardExtension > 0 || priceAnchor !== null;
  // Tagged lottery packs get the strict 0.01pp win-rate accuracy gate (the
  // tag IS the contract). The gate now lives INSIDE `buildRetuneSearchParams`
  // (active whenever the RESOLVED targetWinRate value-equals the tag), so the
  // write's tagged mode matches the plan's by construction — gating on
  // `targets.targetWinRate === undefined` would silently turn tagged mode OFF
  // at write time while the approved preview ran WITH it (preview ≠ write).
  // An operator who adjusts the win-rate AWAY from the tag still disables the
  // gate via the value mismatch.

  let priceAfter = price;
  let shaped;
  if (allowPriceSearch) {
    const searchBasePrice = priceAnchor ?? price;
    // params come from buildRetuneSearchParams — the tolerance-0
    // approvedPriceAfter pin depends on all four sites sharing it.
    const search = searchBestPriceForCleanSnap({
      ...buildRetuneSearchParams("live", {
        cards: pool.map((c) => ({ value: c.value })),
        basePrice: searchBasePrice,
        targetEdge,
        targetWinRate: resolved.targetWinRate,
        maxWinCap: resolved.maxWinCap,
        nearMissMin: resolved.nearMissMin,
        winRateTol,
        // Anti-inflation anchor: the pack's CURRENT weights (pool order), same
        // as the planner preview passes — no win/grail card's odds may exceed
        // its current odds, so the WRITTEN odds match the anchored preview
        // instead of falling back to the legacy value-only shape.
        currentWeights: pool.map((c) => c.weight),
        intendedHitRate: resolved.intendedHitRate,
        priceBudgetPct,
      }),
      // Legacy chip-strip levers (old review route / doctor drawer only) —
      // spread AFTER the builder so a caller that sends none (V2 sends
      // upwardPriceExtensionPct 0 and no anchor) gets the builder's shared
      // params byte-identically.
      ...(upwardExtension > 0 ? { upwardPriceExtensionPct: upwardExtension } : {}),
      ...(preferHigherEdge ? { preferHigherEdge: true } : {}),
    });
    shaped = search.bestResult;
    priceAfter = search.bestPrice;
  } else {
    // Search-off solve (legacy drawer path). EVERY tagged path — search on or
    // off — carries the hard-tag contract (winRateIsHard + the strict 0.01pp
    // solver tolerance + the live-weight anchor), mirroring what the shared
    // builder bakes into the search branch (ruleset: no tagged path may run
    // soft).
    const taggedHere =
      resolved.intendedHitRate !== null &&
      Math.abs(resolved.intendedHitRate - resolved.targetWinRate) < 1e-9;
    shaped = shapeWeights({
      cards: pool.map((c) => ({ value: c.value })),
      price,
      targetEdge,
      targetWinRate: resolved.targetWinRate,
      maxWinCap: resolved.maxWinCap,
      floorRatioMin: resolved.floorRatioMin,
      nearMissMin: resolved.nearMissMin,
      winRateTol: taggedHere ? TAGGED_WINRATE_TOLERANCE : winRateTol,
      ...(taggedHere
        ? {
            winRateIsHard: true,
            currentWeights: pool.map((c) => c.weight),
          }
        : {}),
    });
  }

  // ── FAIL-CLOSED asserts (throw → no write) ──────────────────────────
  if ("error" in shaped) {
    throw new Error(`Retune infeasible: ${shaped.error}`);
  }
  // RC1 approved-artifact gate: the write must land EXACTLY the price the
  // operator approved. Preview and write now solve the SAME problem (shared
  // band/anchor/tagged gate) over a fingerprint-verified pool, so the
  // re-solved price can only differ on a preview↔write parameter skew or a
  // nondeterminism bug — surface it honestly (tolerance 0), never write it.
  const approvedPriceAfter =
    targets.approvedPriceAfter != null && Number.isFinite(targets.approvedPriceAfter)
      ? targets.approvedPriceAfter
      : null;
  if (approvedPriceAfter !== null && priceAfter !== approvedPriceAfter) {
    throw new Error(
      `Refused: this write would set the price to $${priceAfter.toFixed(2)}, but the approved preview showed $${approvedPriceAfter.toFixed(2)}${
        approvedPoolFingerprint !== null
          ? " even though the pool is unchanged — this is a preview/write parameter-skew or nondeterminism bug; please report it"
          : " — the proposal is likely stale"
      }. Refresh the proposals and re-review before approving.`,
    );
  }
  const after = shaped.risk;
  if (after.edge < targetEdge - 1e-9) {
    throw new Error(
      `Refused: resulting edge ${(after.edge * 100).toFixed(2)}% is below the target ${(targetEdge * 100).toFixed(2)}%.`,
    );
  }
  // TAGGED upper band (ruleset write assert): the one-sided-up acceptance may
  // legally land a pinned pool up to 0.25pp ABOVE the target — beyond that is
  // a solver/param anomaly, refused fail-closed. Untagged packs keep their
  // float-up semantics (no upper assert).
  if (
    resolved.intendedHitRate !== null &&
    after.edge > targetEdge + ONE_SIDED_EDGE_EXCESS_TOL + 1e-9
  ) {
    throw new Error(
      `Refused: resulting edge ${(after.edge * 100).toFixed(3)}% sits more than ${(ONE_SIDED_EDGE_EXCESS_TOL * 100).toFixed(2)}pp above the ${(targetEdge * 100).toFixed(2)}% target — outside the accepted one-sided band for a tagged pack.`,
    );
  }
  if (after.maxWin > resolved.maxWinCap + 1e-9) {
    throw new Error(
      `Refused: resulting max win $${after.maxWin.toFixed(2)} exceeds the cap $${resolved.maxWinCap.toFixed(2)}.`,
    );
  }
  if (Math.abs(after.winRate - resolved.targetWinRate) > winRateTol + 1e-9) {
    throw new Error(
      `Refused: resulting win-rate ${(after.winRate * 100).toFixed(2)}% misses target ${(resolved.targetWinRate * 100).toFixed(2)}% (±${(winRateTol * 100).toFixed(2)}%).`,
    );
  }
  // Tagged packs get a 20x tighter acceptance vs their TAG (0.1pp): the flat
  // ±2pp tolerance above would let a "1%" pack legally ship anywhere in
  // [0%, 3%] — 3x its designed winner share.
  if (
    resolved.intendedHitRate !== null &&
    Math.abs(after.winRate - resolved.intendedHitRate) >
      TAGGED_WRITE_WINRATE_TOLERANCE + 1e-9
  ) {
    throw new Error(
      `Refused: resulting win-rate ${(after.winRate * 100).toFixed(3)}% misses the pack tag ${(resolved.intendedHitRate * 100).toFixed(2)}% by more than ${(TAGGED_WRITE_WINRATE_TOLERANCE * 100).toFixed(1)}pp.`,
    );
  }
  // Belt-and-suspenders: `shapeWeights` already fails closed below `targetEdge`,
  // and `targetEdge` is clamped to ≥ the edge-curve floor — so in practice this
  // can only trip if a future refactor weakens those guards. Cheap explicit
  // backstop that matches the `applyPackEdit` floor exactly, and audited the
  // same way so a refusal here is on record.
  if (after.edge < EDIT_EDGE_FLOOR) {
    try {
      await createAdminAuditEvent({
        adminUserId: session.userId,
        eventType: "pack_edit_refused_edge_floor",
        metadata: {
          pack_id: packId,
          name: pack.name,
          source: "applyPackRetune",
          attempted_edge: after.edge,
          floor: EDIT_EDGE_FLOOR,
          attempted_max_win: after.maxWin,
          target_edge: targetEdge,
        },
      });
    } catch {
      /* best-effort — never block the refusal */
    }
    throw new Error(
      `Refused: edited pool produces ${(after.edge * 100).toFixed(2)}% house edge, below the ${(EDIT_EDGE_FLOOR * 100).toFixed(0)}% safety floor. Adjust the odds so the house keeps at least ${(EDIT_EDGE_FLOOR * 100).toFixed(0)}% margin, then re-approve.`,
    );
  }

  // Pair each pool card with its shaped weight + preserved row metadata.
  const metaByCard = new Map(
    pack.pack_cards.map((pc) => [
      pc.card_id,
      { color: pc.color, animation: pc.animation, order: pc.order },
    ]),
  );
  // Cap removals (owner rule, 2026-07-03): slots the solver's cap pre-filter
  // dropped carry a shaped weight of 0 — those rows are OMITTED, so the card
  // is truly removed from the pack instead of persisting as a dead 0%-odds
  // row (recoverable via the History snapshot revert captured below).
  const rows = omitZeroWeightRows(
    pool.map((c, i) => {
      const meta = metaByCard.get(c.cardId);
      return {
        pack_id: packId,
        card_id: c.cardId,
        weight: shaped.weights[i]!,
        color: meta?.color ?? null,
        animation: meta?.animation ?? false,
        order: meta?.order ?? i,
      };
    }),
  );
  // Audit trace of the omission — the engine predicate over the solve pool.
  const capRemovedCardIds = computeCapDroppedCardIds(
    pool.map((c) => ({ cardId: c.cardId, value: c.value })),
    resolved.maxWinCap,
  );

  // Capture the PRIOR state (price + every card weight) into the ADMIN change
  // history BEFORE the weight write below — so this snapshot is the state the
  // owner can revert TO. Best-effort: a snapshot failure must NOT fail the
  // committed retune (the helper swallows + logs its own errors).
  await capturePackSnapshot({
    packId,
    action: "retune",
    capturedBy: session.userId,
  });

  // SAME delete-all-then-createMany pattern updatePack uses. When the price-
  // search lever picked a different price, write `packs.price` in the SAME
  // transaction so weights + price always commit atomically.
  const priceChanged = Math.abs(priceAfter - price) > 1e-9;
  await replacePackState(
    await getPrimaryDrizzleDb(),
    packId,
    rows,
    priceChanged ? { price: priceAfter.toFixed(2) } : undefined,
  );

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "pack_retuned",
    metadata: {
      pack_id: packId,
      name: pack.name,
      target: {
        targetEdge,
        targetWinRate: resolved.targetWinRate,
        maxWinCap: resolved.maxWinCap,
        floorRatioMin: resolved.floorRatioMin ?? null,
        nearMissMin: resolved.nearMissMin,
      },
      // Whether the cap/win-rate were auto-derived (caller omitted them) — so an
      // audit review can tell an auto-tune from a hand-tuned one.
      auto_targets: {
        maxWinCap: targets.maxWinCap === undefined,
        targetWinRate: targets.targetWinRate === undefined,
        nearMissMin: targets.nearMissMin === undefined,
      },
      before: { edge: before.edge, winRate: before.winRate, maxWin: before.maxWin },
      after: { edge: after.edge, winRate: after.winRate, maxWin: after.maxWin },
      // Cap removals (owner rule, 2026-07-03): pool cards whose value
      // exceeded the resolved max-win cap — their rows were OMITTED from the
      // write (true removal). Absent when none were dropped.
      ...(capRemovedCardIds.length > 0 && {
        cap_removed_card_ids: capRemovedCardIds,
      }),
      // Price-search trace — present only when the lever actually moved the
      // ticket. Lets an audit review distinguish a fixed-price retune from a
      // chip-strip nudge that raised the price for clean odds.
      ...(priceChanged && {
        price_search: {
          before: price,
          after: priceAfter,
          allowed_extension_pct: upwardExtension,
        },
      }),
      // RC1 trace: which approved-artifact guards this write passed (absent
      // on legacy calls) — lets an audit review split fingerprint-verified
      // approves from unguarded ones.
      ...((approvedPoolFingerprint !== null || approvedPriceAfter !== null) && {
        approved_artifact: {
          pool_fingerprint_verified: approvedPoolFingerprint !== null,
          price_after_verified: approvedPriceAfter !== null,
        },
      }),
      ...(editedLivePackUnderCapability && { edited_live_pack_under_capability: true }),
      // Flag operator-allowlist 2FA-bypass writes so an audit review can split
      // operator no-2FA retunes from owner-with-2FA retunes (the token mint
      // also audits the same flag — this is the per-pack write's mirror).
      ...(isPackStudioRetuneOperatorNonOwner(session) && {
        via_no_2fa_allowlist: true,
      }),
    },
  });

  // ── Refresh the pack's ADMIN-side risk row from the re-tune (ADMIN write) ──
  // The MAIN weight write above is the source of truth for odds; the Pack
  // Studio Doctor grid + Overview read their risk/compliance from the ADMIN
  // `pack_risk_scores` snapshot table. Without this, a re-tune wouldn't surface
  // until the next full snapshot run. `after` IS `computePackRisk` of the FRESH
  // pool values + the NEW shaped weights (it's `shaped.risk`), so it's exactly
  // the per-card risk the snapshot writer would compute — we reuse it and upsert
  // the SAME row shape through the shared `refreshPackRiskScore` helper
  // (`buildPackCompliance`, cap via the resolved `maxWinCap`). Best-effort by
  // contract: the MAIN odds change has already committed, so an ADMIN-side
  // failure must NOT fail this retune — the helper swallows + logs it and the
  // next snapshot run reconciles the row.
  await refreshPackRiskScore(
    packId,
    after,
    resolved.maxWinCap,
    resolved.intendedHitRate !== null,
  );

  reloadPacks();
  // Invalidate this pack's cached V2 plan so the next `planPackTune` reflects
  // this retune instead of a 60s-stale solve. Per-pack: ONLY this pack's plan
  // is busted (never the other 182).
  revalidateTag(packRetunePlanTag(packId));
  // The persistent "Tuned: X / N" workspace counter reads the distinct
  // edit/retune snapshot count — this retune just captured one, so bust it.
  revalidateTag("pack-studio-tuned-count");
  revalidatePath("/packs");
  revalidatePath(`/packs/${packId}`);

  return {
    packId,
    name: pack.name,
    status: "retuned",
    priceBefore: price,
    priceAfter,
    before: { edge: before.edge, winRate: before.winRate, maxWin: before.maxWin },
    after: { edge: after.edge, winRate: after.winRate, maxWin: after.maxWin },
  };
}

// ─── Revert a pack to a captured change-history snapshot ───────────────
//
// Owner-gated + 2FA-token-guarded restore of a pack's price + per-card WEIGHTS
// to an earlier `pack_state_snapshots` row. It is a WEIGHT + PRICE write to MAIN
// (the same blast radius as a retune), so it mirrors applyPackRetune's paranoia:
//   - Owner-only AND requires a valid RETUNE token (`verifyRetuneToken`).
//   - `__can_update_pack` capability + the pack_creator live-pack carve-out.
//   - Loads the snapshot from ADMIN; FIRST captures a "revert" snapshot of the
//     CURRENT state (so the revert is itself undoable), then writes the
//     snapshot's price + weights back via the SAME delete-all-then-createMany
//     pack_cards transaction updatePack/applyPackRetune use.
//   - Re-creates every snapshot card that still exists in the CARDS CATALOG
//     (the pack_cards FK target) with a positive captured weight — including
//     cards no longer in the live pool. That is the point of the revert: a
//     retune push truly REMOVES cap-dropped cards (owner rule, 2026-07-03),
//     and the snapshot is the recovery path. Catalog-deleted cards and legacy
//     weight-0 snapshot rows are skipped and reported (never silently
//     dropped, never guessed).
//   - Audits "pack_reverted"; refreshes the ADMIN risk row. FAIL-CLOSED.

export type RevertPackResult = {
  packId: string;
  name: string;
  status: "reverted";
  /** Snapshot the pack was reverted TO. */
  snapshotId: string;
  priceBefore: number;
  priceAfter: number;
  /** Cards from the snapshot that were restored (exist in the cards catalog). */
  restoredCardCount: number;
  /**
   * Card ids in the snapshot that were NOT restored: the card no longer
   * exists in the cards catalog (FK target gone), or the snapshot row carried
   * a legacy weight ≤ 0 (odds-identical to omission; never re-written).
   */
  skippedCardIds: string[];
};

/**
 * Revert a pack's price + per-card weights to an earlier captured snapshot.
 * Owner-only AND requires a valid RETUNE token from `authorizePackRetune`
 * (the same 2FA scope a retune carries — a revert is a weight write).
 *
 * Fail-closed: every auth/scope/integrity failure THROWS before any MAIN write.
 * Restores every snapshot card that still exists in the CARDS CATALOG with a
 * positive captured weight — including cards a retune push removed from the
 * pool (cap removals, owner rule 2026-07-03: the snapshot revert is their
 * recovery path). Catalog-deleted cards + legacy weight-0 snapshot rows are
 * skipped and returned in `skippedCardIds`.
 */
export async function revertPackToSnapshot(
  snapshotId: string,
  token: string,
): Promise<RevertPackResult> {
  const session = await requirePageAccess("/packs");
  if (!isPackStudioRetuneOperator(session)) {
    throw new Error("The pack revert tool is restricted to authorized operators.");
  }
  await requireCapability(session, "__can_update_pack", "revert packs");
  if (!(await verifyRetuneToken(token, session.userId))) {
    throw new Error("2FA authorization expired or missing — re-confirm to continue.");
  }
  if (!isUuid(snapshotId)) throw new Error("Invalid snapshot id");

  // Load the revert target from the ADMIN change history.
  const snapshot = await getPackSnapshot(snapshotId);
  if (!snapshot) throw new Error("Snapshot not found.");
  const packId = snapshot.packId;
  if (!isUuid(packId)) throw new Error("Snapshot references an invalid pack id.");

  const db = await getPrimaryDrizzleDb();

  // Fresh pack row: scope + name + price (drift detection since capture).
  const packResult = await db.execute<{
    price: string; active: boolean; pack_type: string; name: string;
  }>(sql`
    SELECT price::text AS price, active, pack_type, name
    FROM packs WHERE id = ${packId}::uuid
  `);
  const pack = packResult.rows[0];
  if (!pack) throw new Error("Pack not found.");

  if (!REPRICE_OR_RETUNE_PACK_TYPES.includes(pack.pack_type)) {
    throw new Error(
      `Out of scope: only official packs can be reverted (this is '${pack.pack_type}').`,
    );
  }

  const snapshotPrice = snapshot.price;
  if (!(snapshotPrice > 0)) {
    throw new Error("Refused: snapshot has no valid price to restore.");
  }

  // pack_creator live-pack carve-out (same gate updatePack / applyPackRetune use).
  const editedLivePackUnderCapability = await enforcePackCreatorLiveGate(
    db,
    session,
    packId,
    pack.active,
  );

  // Restore every snapshot card that still exists in the CARDS CATALOG (the
  // pack_cards.card_id FK target — indexed PK read) with a positive captured
  // weight. Membership in the LIVE pool is deliberately NOT required: a
  // retune push truly removes cap-dropped cards (owner rule, 2026-07-03) and
  // this revert is their recovery path — the old live-pool filter would have
  // silently skipped exactly the card being recovered. Catalog-deleted cards
  // + legacy weight-0 rows are skipped + reported (pure partition, harness-
  // pinned in packs/__checks__/).
  const snapshotCards: SnapshotCard[] = Array.isArray(snapshot.cards)
    ? snapshot.cards
    : [];
  const snapshotCardIds = [
    ...new Set(snapshotCards.map((c) => c.card_id).filter((id) => isUuid(id))),
  ];
  const existingCards =
    snapshotCardIds.length > 0
      ? (
          await db.execute<{ id: string }>(sql`
            SELECT id FROM cards WHERE id = ANY(${pgArrayParam(snapshotCardIds)}::uuid[])
          `)
        ).rows
      : [];
  const { restorable, skippedCardIds } = partitionSnapshotRestore(
    snapshotCards,
    new Set(existingCards.map((c) => c.id)),
  );

  if (restorable.length === 0) {
    throw new Error(
      "Refused: none of the snapshot's cards still exist in the cards catalog (or every captured weight was 0) — nothing to restore.",
    );
  }

  const priceBefore = Number(pack.price.toString());

  // FIRST capture the CURRENT state so the revert is itself undoable, noting the
  // snapshot it reverts TO. Best-effort by contract (must not block the write).
  await capturePackSnapshot({
    packId,
    action: "revert",
    capturedBy: session.userId,
    note: `Revert to snapshot ${snapshotId}`,
  });

  // Rebuild the pack_cards rows from the snapshot (only restorable cards),
  // preserving each card's captured weight / color / animation / order.
  const rows = restorable.map((c, i) => ({
    pack_id: packId,
    card_id: c.card_id,
    weight: c.weight,
    color: c.color ?? null,
    animation: c.animation ?? false,
    order: typeof c.order === "number" ? c.order : i,
  }));

  // Tag revert (tag control, 2026-07-04): a snapshot taken AFTER the tag column
  // shipped carries the pack's tags at capture time (enum-name strings, e.g.
  // ["pct5"]). Restore them so a tag-control change is undoable. Null (legacy
  // snapshots) ⇒ leave the live tag untouched (we can't fabricate a prior tag
  // we never captured). Only known enum members are written (fail-closed).
  const validTagNames = new Set<string>(Object.values(pack_tag));
  const restoreTags =
    Array.isArray(snapshot.tags) &&
    snapshot.tags.every((t) => validTagNames.has(t))
      ? (snapshot.tags as pack_tag[])
      : null;

  // SAME delete-all-then-createMany pattern updatePack / applyPackRetune use,
  // plus the snapshot price.
  await replacePackState(await getPrimaryDrizzleDb(), packId, rows, {
    price: snapshotPrice,
    ...(restoreTags !== null ? { tags: restoreTags } : {}),
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "pack_reverted",
    metadata: {
      pack_id: packId,
      name: pack.name,
      snapshot_id: snapshotId,
      snapshot_action: snapshot.action,
      snapshot_captured_at: snapshot.capturedAt,
      price_before: priceBefore,
      price_after: snapshotPrice,
      restored_card_count: rows.length,
      skipped_card_ids: skippedCardIds,
      // Tag revert (tag control): the snapshot's tags this revert restored,
      // absent when the snapshot recorded none (legacy) — nothing was touched.
      ...(restoreTags !== null && { tags_restored: restoreTags }),
      ...(editedLivePackUnderCapability && { edited_live_pack_under_capability: true }),
      ...(isPackStudioRetuneOperatorNonOwner(session) && {
        via_no_2fa_allowlist: true,
      }),
    },
  });

  // Refresh the ADMIN risk row from the reverted (fresh) pool + price. Best-effort
  // by contract: the MAIN write already committed. Read the pool back read-only
  // and score it the same way the snapshot writer does.
  try {
    const pool = await getPackCardValues(packId);
    if (pool.length > 0) {
      const revertedRisk = computePackRisk({
        cards: pool.map((c) => ({ value: c.value, weight: c.weight })),
        price: snapshotPrice,
      });
      await refreshPackRiskScore(packId, revertedRisk, await readMaxWinCap());
    }
  } catch (err) {
    console.error("revertPackToSnapshot: risk refresh failed", err);
  }

  reloadPacks();
  // Revert-gap fix (Retune V2): a revert rewrites price + weights but used to
  // revalidate NO retune/overview tag — the rail snapshot cache and this
  // pack's V2 plan kept serving pre-revert numbers for up to 60s. Bust both
  // (per-pack plan tag + the doctor/rail snapshot tag).
  revalidateTag(packRetunePlanTag(packId));
  revalidateTag("pack-studio-overview");
  revalidatePath("/packs");
  revalidatePath(`/packs/${packId}`);

  return {
    packId,
    name: pack.name,
    status: "reverted",
    snapshotId,
    priceBefore,
    priceAfter: snapshotPrice,
    restoredCardCount: rows.length,
    skippedCardIds,
  };
}

// ─── Pack builder (create a NEW pack from shaped weights) ──────────────
//
// buildPack designs a brand-new pack: given a name/slug/price + a set of card
// VALUES (or card ids whose values are read fresh), it shapes the per-card
// weights to a target edge + win-rate via `shapeWeights`, and ONLY creates the
// pack if the shape is feasible. The pack is created INACTIVE (active:false),
// reusing createPack's transaction shape. No price/odds ever come from the
// client unverified: card values are re-read from the DB when card ids are
// given.

async function insertBuiltPack(
  tx: Pick<MainDrizzleDb, "execute">,
  input: {
    data: {
      name: string;
      slug: string;
      description: string | null;
      image_url: string | null;
      price: number;
      cards_per_open: number;
      difficulty: number | null;
      pack_type: string;
      active: boolean;
    };
  },
): Promise<{ id: string }> {
  const d = input.data;
  const result = await tx.execute<{ id: string }>(sql`
    INSERT INTO packs (
      name, slug, description, image_url, price, cards_per_open,
      difficulty, pack_type, active, tags
    ) VALUES (
      ${d.name}, ${d.slug}, ${d.description}, ${d.image_url}, ${d.price},
      ${d.cards_per_open}, ${d.difficulty}, ${d.pack_type}, ${d.active},
      ARRAY[]::pack_tag[]
    )
    RETURNING id
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Pack insert returned no row");
  return row;
}

async function insertBuiltPackCards(
  tx: Pick<MainDrizzleDb, "execute">,
  input: {
    data: Array<{
      pack_id: string;
      card_id: string;
      weight: number;
      color: string | null;
      animation: boolean;
      order: number;
    }>;
  },
): Promise<void> {
  const rows = input.data;
  if (rows.length === 0) return;
  await tx.execute(sql`
    INSERT INTO pack_cards (
      pack_id, card_id, weight, color, animation, "order"
    )
    SELECT *
    FROM unnest(
      ${pgArrayParam(rows.map((r) => r.pack_id))}::uuid[],
      ${pgArrayParam(rows.map((r) => r.card_id))}::uuid[],
      ${pgArrayParam(rows.map((r) => r.weight))}::int[],
      ${pgArrayParam(rows.map((r) => r.color))}::text[],
      ${pgArrayParam(rows.map((r) => r.animation))}::boolean[],
      ${pgArrayParam(rows.map((r) => r.order))}::int[]
    )
  `);
}

export type BuildPackResult =
  | {
      ok: true;
      requestId: string;
      edge: number;
      winRate: number;
      requestedActive: boolean;
    }
  | { ok: false; error: string };

type MaterializedPackResult =
  | { ok: true; packId: string; edge: number; winRate: number; active: boolean }
  | { ok: false; error: string };

/**
 * Materialize an owner-approved pack whose card weights are shaped to a target
 * edge + win-rate. Validates input with Zod, resolves each card's VALUE (read fresh
 * from `cards.price` when a cardId is given), runs `shapeWeights` for
 * feasibility (returns `{ok:false,error}` and creates NOTHING if infeasible),
 * then creates the pack (`official` — the type every Pack-Studio tool scopes to)
 * reusing createPack's transaction shape.
 *
 * The pack is created INACTIVE by default. When `activate:true`, the owner's
 * approval creates and activates it in the same transaction. `difficulty` sets
 * the player-facing on-site risk bar (0 → null, no bar).
 */
async function materializeApprovedPack(
  input: BuildPackInput,
): Promise<MaterializedPackResult> {
  const session = await requirePageAccess("/packs");
  if (
    !isPackStudioRetuneOperator(session) &&
    !sessionHasRole(session, "pack_creator")
  ) {
    throw new Error("The pack builder is restricted to authorized operators.");
  }
  await requireCapability(session, "__can_create_pack", "create packs");

  const parsed = buildPackRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid pack input");
  }
  const data = parsed.data;
  const targetEdge = resolveRetuneTargetEdge(data.targets.targetEdge);

  // Going live instantly is the same privileged act as activating an existing
  // pack — require the toggle-active capability on top of create when activating.
  const activate = data.activate === true;
  if (activate) {
    await requireCapability(
      session,
      "__can_toggle_pack_active",
      "activate packs",
    );
  }
  // On-site risk bar: 0/undefined ships null (no bar), same as create/edit forms.
  const difficulty = data.difficulty && data.difficulty > 0 ? data.difficulty : null;

  const db = await getPrimaryDrizzleDb();
  const readDb = db;

  // Resolve each card slot to a {cardId, value}. Card ids → read fresh prices
  // from `cards` (never trust a client-supplied value for a real card); bare
  // values → synthetic slots with no cardId (a value-only design pass).
  const cardIds = data.cards
    .filter((c): c is { cardId: string } => "cardId" in c)
    .map((c) => c.cardId);

  const priceByCard = new Map<string, number>();
  if (cardIds.length > 0) {
    const cardResult = await readDb.execute<{ id: string; price: string }>(sql`
      SELECT id, price::text AS price
      FROM cards
      WHERE id = ANY(${pgArrayParam(cardIds)}::uuid[])
    `);
    for (const row of cardResult.rows) priceByCard.set(row.id, Number(row.price));
    const missing = cardIds.filter((id) => !priceByCard.has(id));
    if (missing.length > 0) {
      return { ok: false, error: `Unknown card id(s): ${missing.join(", ")}` };
    }
  }

  const slots: {
    cardId: string | null;
    value: number;
    color: string | null;
    animation: boolean;
  }[] = data.cards.map((c) => {
    if ("cardId" in c) {
      return {
        cardId: c.cardId,
        value: priceByCard.get(c.cardId)!,
        color: c.color ?? null,
        animation: c.animation ?? false,
      };
    }
    return {
      cardId: null,
      value: c.value,
      color: null,
      animation: false,
    };
  });

  const shaped = shapeWeights({
    cards: slots.map((s) => ({ value: s.value })),
    price: data.price,
    targetEdge,
    targetWinRate: data.targets.targetWinRate,
    maxWinCap: data.targets.maxWinCap,
    floorRatioMin: data.targets.floorRatioMin,
    nearMissMin: data.targets.nearMissMin,
  });
  if ("error" in shaped) {
    return { ok: false, error: shaped.error };
  }
  const edgeError = getPackBuilderEdgeError(shaped.risk.edge);
  if (edgeError) {
    return { ok: false, error: edgeError };
  }

  // Only real cards (a cardId) can be persisted into pack_cards. A value-only
  // slot can't be written — surface it rather than silently dropping it.
  const persistable = slots.map((s, i) => ({ ...s, weight: shaped.weights[i]! }));
  const valueOnly = persistable.filter((s) => s.cardId === null && s.weight > 0);
  if (valueOnly.length > 0) {
    return {
      ok: false,
      error:
        "Pack builder needs real card ids to create a pack — value-only slots carried weight and cannot be persisted.",
    };
  }
  // No weight-0 rows (owner rule, 2026-07-03): a slot the shaper zeroed (cap
  // pre-filter / non-positive value) is omitted — same rule as both retune
  // write arms; a dead 0%-odds row must never be persisted.
  const cardRows = persistable
    .filter(
      (s): s is {
        cardId: string;
        value: number;
        color: string | null;
        animation: boolean;
        weight: number;
      } =>
        s.cardId !== null && s.weight > 0,
    )
    .map((s, i) => ({
      pack_id: "", // filled per-tx below
      card_id: s.cardId,
      weight: s.weight,
      color: s.color,
      animation: s.animation,
      order: i,
    }));

  const pack = await db.transaction(async (tx) => {
    const created = await insertBuiltPack(tx, {
      data: {
        name: data.name,
        slug: data.slug,
        description: data.description?.trim() || null,
        image_url: data.imageUrl ?? null,
        price: data.price,
        cards_per_open: data.cardsPerOpen ?? 1,
        // Player-facing on-site risk bar level (null → no bar shown).
        difficulty,
        // "official" — the entire cash-pack tooling scope (reprice, retune,
        // Doctor risk scoring, Overview KPIs) covers pack_type "official" only
        // (REPRICE_INCLUDED_PACK_TYPES / REPRICE_OR_RETUNE_PACK_TYPES /
        // PACK_STUDIO_CASH_PACK_TYPES); any other type would orphan the new
        // pack from all of it. `active` is the operator's push choice: false =
        // draft (default), true = live on-site instantly.
        pack_type: "official",
        active: activate,
      },
    });
    if (cardRows.length > 0) {
      await insertBuiltPackCards(tx, {
        data: cardRows.map((r) => ({ ...r, pack_id: created.id })),
      });
    }
    return created;
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "pack_created",
    metadata: {
      pack_id: pack.id,
      name: data.name,
      via: "pack_builder",
      card_count: cardRows.length,
      active: activate,
      difficulty,
      target: {
        targetEdge,
        targetWinRate: data.targets.targetWinRate,
        maxWinCap: data.targets.maxWinCap ?? null,
        floorRatioMin: data.targets.floorRatioMin ?? null,
        nearMissMin: data.targets.nearMissMin ?? null,
      },
      edge: shaped.risk.edge,
      winRate: shaped.risk.winRate,
    },
  });

  // Mirror `togglePackActive`: a build-and-activate also emits the dedicated
  // activation event so anything tracking "when did this pack go live?" catches
  // packs pushed live straight from the builder, not just toggled-on later.
  if (activate) {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "pack_activated",
      metadata: { pack_id: pack.id, via: "pack_builder" },
    });
  }

  reloadPacks();
  revalidatePath("/packs");
  revalidatePath(`/packs/${pack.id}`);

  return {
    ok: true,
    packId: pack.id,
    edge: shaped.risk.edge,
    winRate: shaped.risk.winRate,
    active: activate,
  };
}

async function previewPackBuildRequest(
  input: ParsedBuildPackInput,
): Promise<{ ok: true; edge: number; winRate: number } | { ok: false; error: string }> {
  const db = await getPrimaryDrizzleDb();
  const existing = await db.execute<{ id: string }>(sql`
    SELECT id FROM packs WHERE slug = ${input.slug} LIMIT 1
  `);
  if (existing.rows.length > 0) {
    return { ok: false, error: "A pack already uses this slug" };
  }

  const cardIds = input.cards
    .filter((card): card is { cardId: string } => "cardId" in card)
    .map((card) => card.cardId);
  const prices = new Map<string, number>();
  if (cardIds.length > 0) {
    const result = await db.execute<{ id: string; price: string }>(sql`
      SELECT id, price::text AS price
      FROM cards
      WHERE id = ANY(${pgArrayParam(cardIds)}::uuid[])
    `);
    for (const row of result.rows) prices.set(row.id, Number(row.price));
    const missing = cardIds.filter((id) => !prices.has(id));
    if (missing.length > 0) {
      return { ok: false, error: `Unknown card id(s): ${missing.join(", ")}` };
    }
  }

  const slots = input.cards.map((card) =>
    "cardId" in card
      ? { cardId: card.cardId, value: prices.get(card.cardId)! }
      : { cardId: null, value: card.value },
  );
  const shaped = shapeWeights({
    cards: slots.map((slot) => ({ value: slot.value })),
    price: input.price,
    targetEdge: resolveRetuneTargetEdge(input.targets.targetEdge),
    targetWinRate: input.targets.targetWinRate,
    maxWinCap: input.targets.maxWinCap,
    floorRatioMin: input.targets.floorRatioMin,
    nearMissMin: input.targets.nearMissMin,
  });
  if ("error" in shaped) return { ok: false, error: shaped.error };
  const edgeError = getPackBuilderEdgeError(shaped.risk.edge);
  if (edgeError) return { ok: false, error: edgeError };

  const valueOnlyWithWeight = slots.some(
    (slot, index) => slot.cardId === null && shaped.weights[index]! > 0,
  );
  if (valueOnlyWithWeight) {
    return {
      ok: false,
      error:
        "Pack builder needs real card ids to create a pack — value-only slots carried weight and cannot be persisted.",
    };
  }

  return {
    ok: true,
    edge: shaped.risk.edge,
    winRate: shaped.risk.winRate,
  };
}

/**
 * Validate a Pack Studio build and place it in the ADMIN approval queue.
 * This action never mutates MAIN. Pack Builders may request an inactive build
 * or a live push; both require one owner decision on System → New Packs.
 */
export async function buildPack(input: BuildPackInput): Promise<BuildPackResult> {
  const session = await requirePageAccess("/packs");
  if (
    !isPackStudioRetuneOperator(session) &&
    !sessionHasRole(session, "pack_creator")
  ) {
    throw new Error("The pack builder is restricted to authorized operators.");
  }
  await requireCapability(session, "__can_create_pack", "create packs");

  const parsed = buildPackRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid pack input");
  }
  const preview = await previewPackBuildRequest(parsed.data);
  if (!preview.ok) return preview;

  const requestId = await enqueuePackCreationRequest({
    requestedBy: session.userId,
    payload: parsed.data,
    previewEdge: preview.edge,
    previewWinRate: preview.winRate,
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "pack_creation_requested",
    metadata: {
      request_id: requestId,
      name: parsed.data.name,
      slug: parsed.data.slug,
      requested_active: parsed.data.activate === true,
      card_count: parsed.data.cards.length,
      preview_edge: preview.edge,
      preview_win_rate: preview.winRate,
    },
  });

  revalidatePath("/pack-studio/new-packs");
  return {
    ok: true,
    requestId,
    edge: preview.edge,
    winRate: preview.winRate,
    requestedActive: parsed.data.activate === true,
  };
}

export type ApprovePackCreationResult = {
  packId: string;
  active: boolean;
};

/** Owner-only, one-click approval. No 2FA token is requested or accepted. */
export async function approvePackCreationRequest(
  requestId: string,
): Promise<ApprovePackCreationResult> {
  const session = await requirePageAccess("/system/new-packs");
  if (!sessionIsOwner(session)) {
    throw new Error("Only an owner can approve new packs");
  }
  const parsedId = z.string().uuid().safeParse(requestId);
  if (!parsedId.success) throw new Error("Invalid pack request id");

  const request = await claimPackCreationRequest(parsedId.data, session.userId);
  if (!request) {
    throw new Error("This pack request is no longer pending");
  }

  const result = await materializeApprovedPack(request.requestPayload);
  if (!result.ok) {
    await releasePackCreationRequest(request.id, session.userId);
    throw new Error(result.error);
  }

  await completePackCreationRequest(request.id, session.userId, result.packId);
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "pack_creation_approved",
    metadata: {
      request_id: request.id,
      requested_by: request.requestedBy,
      pack_id: result.packId,
      active: result.active,
    },
  });

  revalidatePath("/pack-studio/new-packs");
  return { packId: result.packId, active: result.active };
}

/** Owner-only, one-click decline. No note or 2FA ceremony is required. */
export async function declinePackCreationRequestAction(
  requestId: string,
): Promise<void> {
  const session = await requirePageAccess("/system/new-packs");
  if (!sessionIsOwner(session)) {
    throw new Error("Only an owner can decline new packs");
  }
  const parsedId = z.string().uuid().safeParse(requestId);
  if (!parsedId.success) throw new Error("Invalid pack request id");

  const declined = await declinePackCreationRequest(parsedId.data, session.userId);
  if (!declined) {
    throw new Error("This pack request is no longer pending");
  }
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "pack_creation_declined",
    metadata: { request_id: parsedId.data },
  });
  revalidatePath("/pack-studio/new-packs");
}
