"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminDb } from "@/lib/admin-db";
import { requirePageAccess } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { isValidStatus, type IdeaStatus } from "./types";

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

const reorderSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1),
});

const statusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["neutral", "green", "red"]),
});

// ── Pre-migration safety ───────────────────────────────────────────

function isMissingTableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  if (code === "P2021" || code === "P2022") return true;
  return /relation .* does not exist/i.test(err.message);
}

const PRE_MIGRATION_MESSAGE =
  "Ideas table is not enabled yet — run the database migration (npm run admin:migrate).";

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

  try {
    // Append at the end by grabbing max(sort_order) + 1000. The +1000
    // spacing leaves headroom for midpoint inserts without touching the
    // neighbours during drag-reorders.
    const max = await adminDb.admin_ideas.aggregate({
      _max: { sort_order: true },
    });
    const nextOrder = (max._max.sort_order ?? 0) + 1000;

    const row = await adminDb.admin_ideas.create({
      data: {
        title: parsed.data.title,
        description: parsed.data.description || null,
        status: "neutral",
        sort_order: nextOrder,
        created_by_id: session.userId,
      },
      select: { id: true },
    });

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "idea_created",
      metadata: { ideaId: row.id, title: parsed.data.title },
    });

    revalidatePath("/ideas");
    return { success: true, id: row.id };
  } catch (err) {
    if (isMissingTableError(err)) {
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
    if (isMissingTableError(err)) {
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
  // Redundant guard — keeps the type narrow for the enum check at the DB
  // call site and future-proofs if the Zod schema drifts.
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
    if (isMissingTableError(err)) {
      return { success: false, error: PRE_MIGRATION_MESSAGE };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to update status",
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
    if (isMissingTableError(err)) {
      return { success: false, error: PRE_MIGRATION_MESSAGE };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to delete idea",
    };
  }
}

export async function reorderIdeas(
  orderedIds: string[],
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess("/ideas");

  const parsed = reorderSchema.safeParse({ orderedIds });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid order",
    };
  }

  try {
    // Assign sort_order in increments of 1000 so each card has plenty
    // of gap from its neighbours for future midpoint inserts. Batched in
    // a single transaction so a partial failure can't leave the board
    // in a half-sorted state.
    await adminDb.$transaction(
      parsed.data.orderedIds.map((id, idx) =>
        adminDb.admin_ideas.update({
          where: { id },
          data: { sort_order: (idx + 1) * 1000 },
          select: { id: true },
        }),
      ),
    );

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "ideas_reordered",
      metadata: { count: parsed.data.orderedIds.length },
    });

    revalidatePath("/ideas");
    return { success: true };
  } catch (err) {
    if (isMissingTableError(err)) {
      return { success: false, error: PRE_MIGRATION_MESSAGE };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to reorder",
    };
  }
}
