import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { adminDrizzle } from "@/lib/admin-db";
import {
  PACK_BUILDER_EDGE_ERROR,
  PACK_BUILDER_EDGE_MAX,
  PACK_BUILDER_EDGE_MIN,
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

export const buildPackRequestSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(60),
  slug: z.string().trim().min(1, "Slug is required").max(60),
  description: z.string().trim().max(2000).optional(),
  imageUrl: z.string().trim().url().optional(),
  price: z.number().positive("Price must be greater than 0"),
  cardsPerOpen: z.number().int().positive().optional(),
  difficulty: z.number().min(0).max(1).optional(),
  activate: z.boolean().optional(),
  cards: z.array(buildPackCardSchema).min(1, "At least one card is required"),
  targets: z.object({
    targetEdge: z
      .number()
      .min(PACK_BUILDER_EDGE_MIN, PACK_BUILDER_EDGE_ERROR)
      .max(PACK_BUILDER_EDGE_MAX, PACK_BUILDER_EDGE_ERROR)
      .optional(),
    targetWinRate: z.number().min(0).lt(1),
    maxWinCap: z.number().positive().optional(),
    floorRatioMin: z.number().positive().optional(),
    nearMissMin: z.number().min(0).lt(1).optional(),
  }),
});

export type BuildPackInput = z.input<typeof buildPackRequestSchema>;
export type ParsedBuildPackInput = z.output<typeof buildPackRequestSchema>;

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
  createdPackId: string | null;
  createdAt: string;
  reviewStartedAt: string | null;
  reviewedAt: string | null;
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
  created_pack_id: string | null;
  created_at: string;
  review_started_at: string | null;
  reviewed_at: string | null;
};

function parseRequestRow(row: RawPackCreationRequest): PackCreationRequest {
  const payload = buildPackRequestSchema.safeParse(row.request_payload);
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
    createdPackId: row.created_pack_id,
    createdAt: row.created_at,
    reviewStartedAt: row.review_started_at,
    reviewedAt: row.reviewed_at,
  };
}

export async function enqueuePackCreationRequest(input: {
  requestedBy: string;
  payload: ParsedBuildPackInput;
  previewEdge: number;
  previewWinRate: number;
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
        preview_win_rate
      )
      VALUES (
        ${input.requestedBy}::uuid,
        ${input.payload.name},
        ${input.payload.slug},
        ${input.payload.activate === true},
        ${JSON.stringify(input.payload)}::jsonb,
        ${input.previewEdge},
        ${input.previewWinRate}
      )
      RETURNING id
    `);
    const row = result.rows[0];
    if (!row) throw new Error("Pack request insert returned no row");
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
      r.created_pack_id,
      r.created_at::text AS created_at,
      r.review_started_at::text AS review_started_at,
      r.reviewed_at::text AS reviewed_at
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
export async function listPackBuildDrafts(
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
      r.created_pack_id,
      r.created_at::text AS created_at,
      r.review_started_at::text AS review_started_at,
      r.reviewed_at::text AS reviewed_at
    FROM pack_creation_requests r
    JOIN admin_users requester ON requester.id = r.requested_by
    LEFT JOIN admin_users reviewer ON reviewer.id = r.reviewed_by
    WHERE r.status = 'pending'
      AND r.requested_active = false
    ORDER BY r.created_at DESC
    LIMIT ${boundedLimit}
  `);
  return result.rows.map(parseRequestRow);
}

/**
 * Move a saved inactive build into the owner queue as a live request.
 * The stored payload is updated with the same intent so approval cannot read
 * a stale `activate:false` value.
 */
export async function submitPackBuildDraftForApproval(input: {
  requestId: string;
  actorId: string;
  canManageAll: boolean;
}): Promise<boolean> {
  const result = await adminDrizzle.execute<{ id: string }>(sql`
    UPDATE pack_creation_requests
    SET
      requested_active = true,
      request_payload = jsonb_set(request_payload, '{activate}', 'true'::jsonb)
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
      claimed.created_pack_id,
      claimed.created_at::text AS created_at,
      claimed.review_started_at::text AS review_started_at,
      claimed.reviewed_at::text AS reviewed_at
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
