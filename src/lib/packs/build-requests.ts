import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { adminDrizzle } from "@/lib/admin-db";
import {
  hasExactPackBuilderTicketTotal,
  isPackBuilderEdgeInRange,
  PACK_BUILDER_EDGE_ERROR,
} from "@/lib/packs/builder-edge";
import { isPostgresError } from "@/lib/postgres-errors";

const packCardColorSchema = z.string().trim().min(1).max(32).nullable().optional();

const buildPackCardSchema = z.union([
  z.object({
    cardId: z.string().uuid(),
    color: packCardColorSchema,
    animation: z.boolean().optional(),
  }),
  z.object({ value: z.number().positive() }),
]);

export const PACK_IMAGE_REQUIRED_ERROR =
  "Add a pack image before requesting a live push. Drafts can be saved without one.";

const storedBuildPackRequestSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(60),
  slug: z.string().trim().min(1, "Slug is required").max(60),
  description: z.string().trim().max(2000).optional(),
  imageUrl: z.string().trim().url().optional(),
  price: z.number().positive("Price must be greater than 0"),
  cardsPerOpen: z.number().int().positive().optional(),
  difficulty: z.number().min(0).max(1).optional(),
  activate: z.boolean().optional(),
  cards: z.array(buildPackCardSchema).min(1, "At least one card is required"),
  ticketWeights: z.array(z.number().int().nonnegative()).optional(),
  targets: z.object({
    // Stored rows remain readable if the strict band changes later. Every new
    // submission and final production write is checked by the super-refinement.
    targetEdge: z.number().min(0).lt(1).optional(),
    targetWinRate: z.number().min(0).lt(1),
    maxWinCap: z.number().positive().optional(),
    floorRatioMin: z.number().positive().optional(),
    nearMissMin: z.number().min(0).lt(1).optional(),
  }),
});

export const buildPackRequestSchema = storedBuildPackRequestSchema.superRefine(
  (request, context) => {
    if (
      request.targets.targetEdge !== undefined &&
      !isPackBuilderEdgeInRange(request.targets.targetEdge)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targets", "targetEdge"],
        message: PACK_BUILDER_EDGE_ERROR,
      });
    }
    const cardIds = request.cards.flatMap((card) =>
      "cardId" in card ? [card.cardId] : [],
    );
    if (new Set(cardIds).size !== cardIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cards"],
        message: "Each card may only appear once in a pack build.",
      });
    }
    if (request.activate === true && !request.imageUrl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["imageUrl"],
        message: PACK_IMAGE_REQUIRED_ERROR,
      });
    }
    if (
      request.ticketWeights !== undefined &&
      (request.ticketWeights.length !== request.cards.length ||
        !hasExactPackBuilderTicketTotal(request.ticketWeights) ||
        request.ticketWeights.some((weight) => weight <= 0))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ticketWeights"],
        message: "Pack Builder odds must be above 0% for every card and total exactly 100.0000%.",
      });
    }
  },
);

export type BuildPackInput = z.input<typeof buildPackRequestSchema>;
export type ParsedBuildPackInput = z.output<typeof storedBuildPackRequestSchema>;

export type PackCreationRequestStatus =
  | "pending"
  | "processing"
  | "approved"
  | "declined";

export type PackCreationRequest = {
  id: string;
  status: PackCreationRequestStatus;
  requestedBy: string;
  requesterUsername: string;
  reviewerUsername: string | null;
  name: string;
  slug: string;
  requestedActive: boolean;
  requestPayload: ParsedBuildPackInput;
  previewEdge: number;
  previewWinRate: number;
  previewMaxWin: number | null;
  createdPackId: string | null;
  createdAt: string;
  reviewStartedAt: string | null;
  reviewedAt: string | null;
  revision: number;
  updatedAt: string;
};

type RawPackCreationRequest = {
  id: string;
  status: string;
  requested_by: string;
  requester_username: string;
  reviewer_username: string | null;
  name: string;
  slug: string;
  requested_active: boolean;
  request_payload: unknown;
  preview_edge: string;
  preview_win_rate: string;
  preview_max_win: string | null;
  created_pack_id: string | null;
  created_at: string;
  review_started_at: string | null;
  reviewed_at: string | null;
  revision: number;
  updated_at: string;
};

function parseRequestRow(row: RawPackCreationRequest): PackCreationRequest {
  // Keep old queued rows readable so the owner queue never crashes on legacy
  // image-less requests. New live requests and final materialization use the
  // stricter schema below and fail closed until artwork is supplied.
  const payload = storedBuildPackRequestSchema.safeParse(row.request_payload);
  if (!payload.success) {
    throw new Error(`Pack request ${row.id} has an invalid stored payload`);
  }
  if (
    row.status !== "pending" &&
    row.status !== "processing" &&
    row.status !== "approved" &&
    row.status !== "declined"
  ) {
    throw new Error(`Pack request ${row.id} has an invalid status`);
  }
  return {
    id: row.id,
    status: row.status,
    requestedBy: row.requested_by,
    requesterUsername: row.requester_username,
    reviewerUsername: row.reviewer_username,
    name: row.name,
    slug: row.slug,
    requestedActive: row.requested_active,
    requestPayload: payload.data,
    previewEdge: Number(row.preview_edge),
    previewWinRate: Number(row.preview_win_rate),
    previewMaxWin:
      row.preview_max_win === null ? null : Number(row.preview_max_win),
    createdPackId: row.created_pack_id,
    createdAt: row.created_at,
    reviewStartedAt: row.review_started_at,
    reviewedAt: row.reviewed_at,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

export type PackBuildDraftRevision = {
  revision: number;
  changedByUsername: string | null;
  changeKind: string;
  createdAt: string;
};

async function recordPackBuildDraftRevision(input: {
  requestId: string;
  revision: number;
  changedBy: string;
  changeKind: string;
  payload: ParsedBuildPackInput;
  previewEdge: number;
  previewWinRate: number;
  previewMaxWin: number;
}): Promise<void> {
  await adminDrizzle.execute(sql`
    INSERT INTO pack_build_draft_revisions (
      request_id, revision, changed_by, change_kind, name, slug,
      request_payload, preview_edge, preview_win_rate, preview_max_win
    ) VALUES (
      ${input.requestId}::uuid, ${input.revision}, ${input.changedBy}::uuid,
      ${input.changeKind}, ${input.payload.name}, ${input.payload.slug},
      ${JSON.stringify(input.payload)}::jsonb, ${input.previewEdge},
      ${input.previewWinRate}, ${input.previewMaxWin}
    )
    ON CONFLICT (request_id, revision) DO NOTHING
  `);
}

export async function enqueuePackCreationRequest(input: {
  requestedBy: string;
  payload: ParsedBuildPackInput;
  previewEdge: number;
  previewWinRate: number;
  previewMaxWin: number;
}): Promise<string> {
  try {
    const result = await adminDrizzle.execute<{ id: string }>(sql`
      INSERT INTO pack_creation_requests (
        requested_by,
        name,
        slug,
        requested_active,
        request_payload,
        preview_edge,
        preview_win_rate,
        preview_max_win
      )
      VALUES (
        ${input.requestedBy}::uuid,
        ${input.payload.name},
        ${input.payload.slug},
        ${input.payload.activate === true},
        ${JSON.stringify(input.payload)}::jsonb,
        ${input.previewEdge},
        ${input.previewWinRate},
        ${input.previewMaxWin}
      )
      RETURNING id
    `);
    const row = result.rows[0];
    if (!row) throw new Error("Pack request insert returned no row");
    await recordPackBuildDraftRevision({
      requestId: row.id,
      revision: 1,
      changedBy: input.requestedBy,
      changeKind: "initial",
      payload: input.payload,
      previewEdge: input.previewEdge,
      previewWinRate: input.previewWinRate,
      previewMaxWin: input.previewMaxWin,
    });
    return row.id;
  } catch (error) {
    if (isPostgresError(error, "23505")) {
      throw new Error("A pending pack request already uses this slug");
    }
    throw error;
  }
}

export async function listPackCreationRequests(
  limit = 100,
): Promise<PackCreationRequest[]> {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const result = await adminDrizzle.execute<RawPackCreationRequest>(sql`
    SELECT
      r.id,
      r.status,
      r.requested_by,
      requester.username AS requester_username,
      reviewer.username AS reviewer_username,
      r.name,
      r.slug,
      r.requested_active,
      r.request_payload,
      r.preview_edge::text AS preview_edge,
      r.preview_win_rate::text AS preview_win_rate,
      r.preview_max_win::text AS preview_max_win,
      r.created_pack_id,
      r.created_at::text AS created_at,
      r.review_started_at::text AS review_started_at,
      r.reviewed_at::text AS reviewed_at
      , r.revision
      , r.updated_at::text AS updated_at
    FROM pack_creation_requests r
    JOIN admin_users requester ON requester.id = r.requested_by
    LEFT JOIN admin_users reviewer ON reviewer.id = r.reviewed_by
    ORDER BY
      CASE r.status
        WHEN 'pending' THEN 0
        WHEN 'processing' THEN 1
        ELSE 2
      END,
      r.created_at DESC
    LIMIT ${boundedLimit}
  `);
  return result.rows.map(parseRequestRow);
}

/**
 * Saved Pack Builder drafts. They reuse the existing ADMIN queue row shape,
 * but remain `requested_active = false` and never enter the owner review page.
 */
export async function listPackBuildDrafts(input: {
  limit?: number;
  requestedBy?: string;
} = {}): Promise<PackCreationRequest[]> {
  const boundedLimit = Math.max(
    1,
    Math.min(100, Math.trunc(input.limit ?? 100)),
  );
  const requesterPredicate = input.requestedBy
    ? sql`AND r.requested_by = ${input.requestedBy}::uuid`
    : sql.empty();
  const result = await adminDrizzle.execute<RawPackCreationRequest>(sql`
    SELECT
      r.id,
      r.status,
      r.requested_by,
      requester.username AS requester_username,
      reviewer.username AS reviewer_username,
      r.name,
      r.slug,
      r.requested_active,
      r.request_payload,
      r.preview_edge::text AS preview_edge,
      r.preview_win_rate::text AS preview_win_rate,
      r.preview_max_win::text AS preview_max_win,
      r.created_pack_id,
      r.created_at::text AS created_at,
      r.review_started_at::text AS review_started_at,
      r.reviewed_at::text AS reviewed_at
      , r.revision
      , r.updated_at::text AS updated_at
    FROM pack_creation_requests r
    JOIN admin_users requester ON requester.id = r.requested_by
    LEFT JOIN admin_users reviewer ON reviewer.id = r.reviewed_by
    WHERE r.status = 'pending'
      AND r.requested_active = false
      ${requesterPredicate}
    ORDER BY r.created_at DESC
    LIMIT ${boundedLimit}
  `);
  return result.rows.map(parseRequestRow);
}

/** Load one editable saved build, scoped to its builder unless staff may manage all. */
export async function getPackBuildDraftForEdit(input: {
  requestId: string;
  actorId: string;
  canManageAll: boolean;
}): Promise<PackCreationRequest | null> {
  const result = await adminDrizzle.execute<RawPackCreationRequest>(sql`
    SELECT
      r.id,
      r.status,
      r.requested_by,
      requester.username AS requester_username,
      reviewer.username AS reviewer_username,
      r.name,
      r.slug,
      r.requested_active,
      r.request_payload,
      r.preview_edge::text AS preview_edge,
      r.preview_win_rate::text AS preview_win_rate,
      r.preview_max_win::text AS preview_max_win,
      r.created_pack_id,
      r.created_at::text AS created_at,
      r.review_started_at::text AS review_started_at,
      r.reviewed_at::text AS reviewed_at
      , r.revision
      , r.updated_at::text AS updated_at
    FROM pack_creation_requests r
    JOIN admin_users requester ON requester.id = r.requested_by
    LEFT JOIN admin_users reviewer ON reviewer.id = r.reviewed_by
    WHERE r.id = ${input.requestId}::uuid
      AND r.status = 'pending'
      AND r.requested_active = false
      AND (
        r.requested_by = ${input.actorId}::uuid
        OR ${input.canManageAll}
      )
    LIMIT 1
  `);
  const row = result.rows[0];
  return row ? parseRequestRow(row) : null;
}

/**
 * Replace one saved build in place. The current inactive/pending predicate is
 * the concurrency and ownership guard; `activate:true` atomically moves the
 * edited row into the existing owner queue.
 */
export async function updatePackBuildDraft(input: {
  requestId: string;
  actorId: string;
  canManageAll: boolean;
  payload: ParsedBuildPackInput;
  previewEdge: number;
  previewWinRate: number;
  previewMaxWin: number;
  expectedRevision: number;
}): Promise<"updated" | "stale" | "unavailable"> {
  try {
    const result = await adminDrizzle.execute<{ id: string }>(sql`
      UPDATE pack_creation_requests
      SET
        name = ${input.payload.name},
        slug = ${input.payload.slug},
        requested_active = ${input.payload.activate === true},
        request_payload = ${JSON.stringify(input.payload)}::jsonb,
        preview_edge = ${input.previewEdge},
        preview_win_rate = ${input.previewWinRate},
        preview_max_win = ${input.previewMaxWin},
        revision = revision + 1,
        updated_at = NOW()
      WHERE id = ${input.requestId}::uuid
        AND status = 'pending'
        AND requested_active = false
        AND revision = ${input.expectedRevision}
        AND (
          requested_by = ${input.actorId}::uuid
          OR ${input.canManageAll}
        )
      RETURNING id, revision
    `);
    const updated = result.rows[0] as { id: string; revision: number } | undefined;
    if (updated) {
      await recordPackBuildDraftRevision({
        requestId: updated.id,
        revision: updated.revision,
        changedBy: input.actorId,
        changeKind: input.payload.activate === true ? "submitted" : "saved",
        payload: input.payload,
        previewEdge: input.previewEdge,
        previewWinRate: input.previewWinRate,
        previewMaxWin: input.previewMaxWin,
      });
      return "updated";
    }
    const current = await adminDrizzle.execute<{ revision: number }>(sql`
      SELECT revision FROM pack_creation_requests
      WHERE id = ${input.requestId}::uuid AND status = 'pending'
        AND requested_active = false
        AND (requested_by = ${input.actorId}::uuid OR ${input.canManageAll})
      LIMIT 1
    `);
    return current.rows.length === 1 ? "stale" : "unavailable";
  } catch (error) {
    if (isPostgresError(error, "23505")) {
      throw new Error("A pending pack request already uses this slug");
    }
    throw error;
  }
}

export async function listPackBuildDraftRevisions(input: {
  requestId: string;
  actorId: string;
  canManageAll: boolean;
}): Promise<PackBuildDraftRevision[]> {
  const result = await adminDrizzle.execute<{
    revision: number;
    changed_by_username: string | null;
    change_kind: string;
    created_at: string;
  }>(sql`
    SELECT h.revision, u.username AS changed_by_username, h.change_kind,
      h.created_at::text AS created_at
    FROM pack_build_draft_revisions h
    LEFT JOIN admin_users u ON u.id = h.changed_by
    JOIN pack_creation_requests r ON r.id = h.request_id
    WHERE h.request_id = ${input.requestId}::uuid
      AND (r.requested_by = ${input.actorId}::uuid OR ${input.canManageAll})
    ORDER BY h.revision DESC
    LIMIT 25
  `);
  return result.rows.map((row) => ({
    revision: row.revision,
    changedByUsername: row.changed_by_username,
    changeKind: row.change_kind,
    createdAt: row.created_at,
  }));
}

export async function restorePackBuildDraftRevision(input: {
  requestId: string;
  revision: number;
  expectedRevision: number;
  actorId: string;
  canManageAll: boolean;
}): Promise<"restored" | "stale" | "unavailable"> {
  const result = await adminDrizzle.execute<{ id: string }>(sql`
    WITH snapshot AS (
      SELECT h.* FROM pack_build_draft_revisions h
      JOIN pack_creation_requests owned ON owned.id = h.request_id
      WHERE h.request_id = ${input.requestId}::uuid
        AND h.revision = ${input.revision}
        AND (owned.requested_by = ${input.actorId}::uuid OR ${input.canManageAll})
    )
    UPDATE pack_creation_requests r SET
      name = snapshot.name,
      slug = snapshot.slug,
      request_payload = jsonb_set(snapshot.request_payload, '{activate}', 'false'::jsonb),
      preview_edge = snapshot.preview_edge,
      preview_win_rate = snapshot.preview_win_rate,
      preview_max_win = snapshot.preview_max_win,
      revision = r.revision + 1,
      updated_at = NOW()
    FROM snapshot
    WHERE r.id = snapshot.request_id AND r.status = 'pending'
      AND r.requested_active = false AND r.revision = ${input.expectedRevision}
    RETURNING r.id
  `);
  if (result.rows.length === 1) {
    const current = await getPackBuildDraftForEdit(input);
    if (current) {
      await recordPackBuildDraftRevision({
        requestId: current.id,
        revision: current.revision,
        changedBy: input.actorId,
        changeKind: `restored:${input.revision}`,
        payload: current.requestPayload,
        previewEdge: current.previewEdge,
        previewWinRate: current.previewWinRate,
        previewMaxWin: current.previewMaxWin ?? 0,
      });
    }
    return "restored";
  }
  const current = await getPackBuildDraftForEdit(input);
  return current ? "stale" : "unavailable";
}

/**
 * Move a saved inactive build into the owner queue as a live request.
 * The stored payload is updated with the same intent so approval cannot read
 * a stale `activate:false` value.
 */
export type PackBuildDraftSubmissionOutcome =
  | "submitted"
  | "missing_image"
  | "unavailable";

export async function submitPackBuildDraftForApproval(input: {
  requestId: string;
  actorId: string;
  canManageAll: boolean;
}): Promise<PackBuildDraftSubmissionOutcome> {
  const result = await adminDrizzle.execute<{ id: string }>(sql`
    UPDATE pack_creation_requests
    SET
      requested_active = true,
      request_payload = jsonb_set(request_payload, '{activate}', 'true'::jsonb)
    WHERE id = ${input.requestId}::uuid
      AND status = 'pending'
      AND requested_active = false
      AND NULLIF(BTRIM(request_payload->>'imageUrl'), '') IS NOT NULL
      AND (
        requested_by = ${input.actorId}::uuid
        OR ${input.canManageAll}
      )
    RETURNING id
  `);
  if (result.rows.length === 1) return "submitted";

  const missingImage = await adminDrizzle.execute<{ id: string }>(sql`
    SELECT id
    FROM pack_creation_requests
    WHERE id = ${input.requestId}::uuid
      AND status = 'pending'
      AND requested_active = false
      AND NULLIF(BTRIM(request_payload->>'imageUrl'), '') IS NULL
      AND (
        requested_by = ${input.actorId}::uuid
        OR ${input.canManageAll}
      )
    LIMIT 1
  `);
  return missingImage.rows.length === 1 ? "missing_image" : "unavailable";
}

/** Add or replace artwork on a saved build without making it live. */
export async function updatePackBuildDraftImage(input: {
  requestId: string;
  actorId: string;
  canManageAll: boolean;
  imageUrl: string;
}): Promise<boolean> {
  const result = await adminDrizzle.execute<{ id: string }>(sql`
    UPDATE pack_creation_requests
    SET request_payload = jsonb_set(
      request_payload,
      '{imageUrl}',
      to_jsonb(${input.imageUrl}::text),
      true
    )
    WHERE id = ${input.requestId}::uuid
      AND status = 'pending'
      AND requested_active = false
      AND (
        requested_by = ${input.actorId}::uuid
        OR ${input.canManageAll}
      )
    RETURNING id
  `);
  return result.rows.length === 1;
}

/** Discard a saved build without sending it through owner approval. */
export async function discardPackBuildDraft(input: {
  requestId: string;
  actorId: string;
  canManageAll: boolean;
}): Promise<boolean> {
  const result = await adminDrizzle.execute<{ id: string }>(sql`
    UPDATE pack_creation_requests
    SET
      status = 'declined',
      reviewed_by = ${input.actorId}::uuid,
      review_started_at = NOW(),
      reviewed_at = NOW()
    WHERE id = ${input.requestId}::uuid
      AND status = 'pending'
      AND requested_active = false
      AND (
        requested_by = ${input.actorId}::uuid
        OR ${input.canManageAll}
      )
    RETURNING id
  `);
  return result.rows.length === 1;
}

export async function claimPackCreationRequest(
  requestId: string,
  reviewerId: string,
): Promise<PackCreationRequest | null> {
  const result = await adminDrizzle.execute<RawPackCreationRequest>(sql`
    WITH claimed AS (
      UPDATE pack_creation_requests
      SET
        status = 'processing',
        reviewed_by = ${reviewerId}::uuid,
        review_started_at = NOW()
      WHERE id = ${requestId}::uuid
        AND status = 'pending'
        AND requested_active = true
      RETURNING *
    )
    SELECT
      claimed.id,
      claimed.status,
      claimed.requested_by,
      requester.username AS requester_username,
      reviewer.username AS reviewer_username,
      claimed.name,
      claimed.slug,
      claimed.requested_active,
      claimed.request_payload,
      claimed.preview_edge::text AS preview_edge,
      claimed.preview_win_rate::text AS preview_win_rate,
      claimed.preview_max_win::text AS preview_max_win,
      claimed.created_pack_id,
      claimed.created_at::text AS created_at,
      claimed.review_started_at::text AS review_started_at,
      claimed.reviewed_at::text AS reviewed_at
      , claimed.revision
      , claimed.updated_at::text AS updated_at
    FROM claimed
    JOIN admin_users requester ON requester.id = claimed.requested_by
    LEFT JOIN admin_users reviewer ON reviewer.id = claimed.reviewed_by
  `);
  const row = result.rows[0];
  return row ? parseRequestRow(row) : null;
}

export async function releasePackCreationRequest(
  requestId: string,
  reviewerId: string,
): Promise<void> {
  await adminDrizzle.execute(sql`
    UPDATE pack_creation_requests
    SET
      status = 'pending',
      reviewed_by = NULL,
      review_started_at = NULL
    WHERE id = ${requestId}::uuid
      AND status = 'processing'
      AND reviewed_by = ${reviewerId}::uuid
  `);
}

export async function completePackCreationRequest(
  requestId: string,
  reviewerId: string,
  packId: string,
): Promise<void> {
  const result = await adminDrizzle.execute<{ id: string }>(sql`
    UPDATE pack_creation_requests
    SET
      status = 'approved',
      created_pack_id = ${packId}::uuid,
      reviewed_at = NOW()
    WHERE id = ${requestId}::uuid
      AND status = 'processing'
      AND reviewed_by = ${reviewerId}::uuid
    RETURNING id
  `);
  if (result.rows.length !== 1) {
    throw new Error("Pack request approval state changed unexpectedly");
  }
}

export async function declinePackCreationRequest(
  requestId: string,
  reviewerId: string,
): Promise<boolean> {
  const result = await adminDrizzle.execute<{ id: string }>(sql`
    UPDATE pack_creation_requests
    SET
      status = 'declined',
      reviewed_by = ${reviewerId}::uuid,
      review_started_at = NOW(),
      reviewed_at = NOW()
    WHERE id = ${requestId}::uuid
      AND status = 'pending'
    RETURNING id
  `);
  return result.rows.length === 1;
}
