"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminDb } from "@/lib/admin-db";
import { requirePageAccess } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { ensureIdeaPositionColumns } from "./queries";
import {
  isValidStatus,
  type IdeaStatus,
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  CARD_WIDTH,
  CARD_HEIGHT,
} from "./types";

// ── Validation ─────────────────────────────────────────────────────

const createSchema = z.object({
  title: z.string().trim().min(1, "Title required").max(140),
  description: z.string().trim().max(2000).optional(),
});

const updateSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1, "Title required").max(140).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
});

const statusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["neutral", "green", "red"]),
});

const positionSchema = z.object({
  id: z.string().uuid(),
  x: z.number().finite(),
  y: z.number().finite(),
});

// ── Pre-migration safety ───────────────────────────────────────────

function isMissingSchema(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  if (code === "P2021" || code === "P2022") return true;
  return /(relation .* does not exist|column .* does not exist)/i.test(
    err.message,
  );
}

function isMissingColumn(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  if (code === "P2022") return true;
  return /column .* does not exist/i.test(err.message);
}

const PRE_MIGRATION_MESSAGE =
  "Ideas table or position columns are not enabled yet — run the database migrations.";

// ── Helpers ────────────────────────────────────────────────────────

/** Clamp a single-axis position to the canvas bounds. */
function clampX(x: number): number {
  return Math.max(0, Math.min(CANVAS_WIDTH - CARD_WIDTH, x));
}
function clampY(y: number): number {
  return Math.max(0, Math.min(CANVAS_HEIGHT - CARD_HEIGHT, y));
}

/**
 * Place new cards in a staggered grid near the top-left so they don't
 * all stack at (0, 0). Modulo 8 × 280 per row gives a comfortable
 * spread; after filling a row, we wrap to the next one. Doesn't
 * consider existing positions — just uses card count as a cheap way
 * to keep consecutive additions from overlapping.
 */
function nextInitialPosition(existingCount: number): { x: number; y: number } {
  const COLS = 8;
  const COL_WIDTH = 280;
  const ROW_HEIGHT = 200;
  return {
    x: 200 + (existingCount % COLS) * COL_WIDTH,
    y: 200 + Math.floor(existingCount / COLS) * ROW_HEIGHT,
  };
}

// ── Actions ────────────────────────────────────────────────────────

export async function createIdea(input: {
  title: string;
  description?: string;
}): Promise<{ success: true; id: string } | { success: false; error: string }> {
  const session = await requirePageAccess("/ideas");

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const title = parsed.data.title;
  const description = parsed.data.description || null;
  async function insertOnce() {
    const count = await adminDb.admin_ideas.count();
    const pos = nextInitialPosition(count);
    return adminDb.admin_ideas.create({
      data: {
        title,
        description,
        status: "neutral",
        position_x: pos.x,
        position_y: pos.y,
        created_by_id: session.userId,
      },
      select: { id: true },
    });
  }

  try {
    let row: { id: string };
    try {
      row = await insertOnce();
    } catch (err) {
      // Same self-heal pattern as updateIdeaPosition: if position
      // columns aren't on the DB yet, add them and retry the insert.
      if (!isMissingColumn(err)) throw err;
      await ensureIdeaPositionColumns();
      row = await insertOnce();
    }

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "idea_created",
      metadata: { ideaId: row.id, title },
    });

    revalidatePath("/ideas");
    return { success: true, id: row.id };
  } catch (err) {
    if (isMissingSchema(err)) {
      return { success: false, error: PRE_MIGRATION_MESSAGE };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to create idea",
    };
  }
}

export async function updateIdea(input: {
  id: string;
  title?: string;
  description?: string | null;
}): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess("/ideas");

  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const data: { title?: string; description?: string | null } = {};
  if (parsed.data.title !== undefined) data.title = parsed.data.title;
  if (parsed.data.description !== undefined) {
    data.description = parsed.data.description ?? null;
  }
  if (Object.keys(data).length === 0) {
    return { success: false, error: "Nothing to update" };
  }

  try {
    await adminDb.admin_ideas.update({
      where: { id: parsed.data.id },
      data,
      select: { id: true },
    });

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "idea_updated",
      metadata: { ideaId: parsed.data.id },
    });

    revalidatePath("/ideas");
    return { success: true };
  } catch (err) {
    if (isMissingSchema(err)) {
      return { success: false, error: PRE_MIGRATION_MESSAGE };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to update idea",
    };
  }
}

export async function setIdeaStatus(input: {
  id: string;
  status: IdeaStatus;
}): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess("/ideas");

  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid status",
    };
  }
  if (!isValidStatus(parsed.data.status)) {
    return { success: false, error: "Invalid status" };
  }

  try {
    await adminDb.admin_ideas.update({
      where: { id: parsed.data.id },
      data: { status: parsed.data.status },
      select: { id: true },
    });

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "idea_status_changed",
      metadata: { ideaId: parsed.data.id, status: parsed.data.status },
    });

    revalidatePath("/ideas");
    return { success: true };
  } catch (err) {
    if (isMissingSchema(err)) {
      return { success: false, error: PRE_MIGRATION_MESSAGE };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to update status",
    };
  }
}

/**
 * Persist a card's canvas position after a drag. Positions are clamped
 * to stay within the canvas bounds server-side so a bad client payload
 * can't park a card off-screen.
 *
 * NOT audit-logged — position changes can fire many times per session
 * and would flood the audit feed without telling us anything useful.
 * The card-level created/updated/deleted events remain audited.
 */
export async function updateIdeaPosition(input: {
  id: string;
  x: number;
  y: number;
}): Promise<{ success: true } | { success: false; error: string }> {
  await requirePageAccess("/ideas");

  const parsed = positionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid position",
    };
  }

  try {
    await adminDb.admin_ideas.update({
      where: { id: parsed.data.id },
      data: {
        position_x: clampX(parsed.data.x),
        position_y: clampY(parsed.data.y),
      },
      select: { id: true },
    });
    // No revalidatePath — frequent updates would thrash the cache and
    // the client already has the optimistic position.
    return { success: true };
  } catch (err) {
    if (isMissingColumn(err)) {
      // Columns haven't been added yet — self-heal and retry once.
      // Same safety story as queries.ts: idempotent ADD COLUMN IF NOT
      // EXISTS under an ACCESS EXCLUSIVE lock, no data rewrite.
      try {
        await ensureIdeaPositionColumns();
      } catch (ensureErr) {
        return {
          success: false,
          error:
            ensureErr instanceof Error
              ? `Could not enable position columns: ${ensureErr.message}`
              : "Could not enable position columns",
        };
      }
      try {
        await adminDb.admin_ideas.update({
          where: { id: parsed.data.id },
          data: {
            position_x: clampX(parsed.data.x),
            position_y: clampY(parsed.data.y),
          },
          select: { id: true },
        });
        return { success: true };
      } catch (retryErr) {
        return {
          success: false,
          error:
            retryErr instanceof Error
              ? retryErr.message
              : "Failed to save position",
        };
      }
    }
    if (isMissingSchema(err)) {
      return { success: false, error: PRE_MIGRATION_MESSAGE };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to save position",
    };
  }
}

export async function deleteIdea(
  id: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess("/ideas");

  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return { success: false, error: "Invalid id" };
  }

  try {
    await adminDb.admin_ideas.delete({
      where: { id },
      select: { id: true },
    });

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "idea_deleted",
      metadata: { ideaId: id },
    });

    revalidatePath("/ideas");
    return { success: true };
  } catch (err) {
    if (isMissingSchema(err)) {
      return { success: false, error: PRE_MIGRATION_MESSAGE };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to delete idea",
    };
  }
}
