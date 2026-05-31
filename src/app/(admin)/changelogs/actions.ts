"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";

import { adminDb } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { ensureChangelogSchema } from "@/lib/changelog/ensure-schema";
import {
  CHANGELOG_CATEGORIES,
  CHANGELOG_CHANGE_KINDS,
} from "@/lib/queries/changelog";

// ---------------------------------------------------------------------------
// Zod schemas
//
// The change-row text is bounded to 500 chars so a single bullet stays
// visually compact inside the card. Title (120) and version (60) are
// generous-but-not-absurd display lengths. Summary is bounded to 4 kB —
// the entry is a TL;DR, not a wiki article. published_at is parsed via
// `z.coerce.date()` so the form can send an ISO string from the input.
// ---------------------------------------------------------------------------

const changeRowSchema = z.object({
  kind: z.enum(CHANGELOG_CHANGE_KINDS),
  text: z.string().trim().min(1, "Bullet text is required").max(500),
});

const entryInputSchema = z.object({
  publishedAt: z.coerce.date({
    error: "Published date is required",
  }),
  title: z
    .string()
    .trim()
    .min(1, "Title is required")
    .max(120, "Title must be at most 120 characters"),
  summary: z
    .string()
    .trim()
    .min(1, "Summary is required")
    .max(4000, "Summary must be at most 4000 characters"),
  // Empty string from the form clears the version label; transform to
  // null so the DB stores NULL instead of "".
  version: z
    .string()
    .trim()
    .max(60, "Version must be at most 60 characters")
    .transform((v) => (v.length === 0 ? null : v))
    .nullable()
    .optional(),
  category: z.enum(CHANGELOG_CATEGORIES),
  changes: z
    .array(changeRowSchema)
    .min(1, "Add at least one change")
    .max(40, "At most 40 changes per entry"),
});

export type ChangelogEntryInput = z.input<typeof entryInputSchema>;

function firstError(err: z.ZodError): string {
  return err.issues[0]?.message ?? "Invalid input";
}

// ---------------------------------------------------------------------------
// createChangelogEntry
// ---------------------------------------------------------------------------

export async function createChangelogEntry(
  input: ChangelogEntryInput,
): Promise<{ id: string }> {
  // Page is `requirePageAccess("/changelogs")` for read; writes are
  // admin-only AND require the `__can_manage_changelog` capability so a
  // non-admin role can be granted publishing rights independently.
  const session = await requireAdmin();
  await requireCapability(
    session,
    "__can_manage_changelog",
    "publish changelog entries",
  );

  const parsed = entryInputSchema.safeParse(input);
  if (!parsed.success) throw new Error(firstError(parsed.error));
  const data = parsed.data;

  await ensureChangelogSchema();

  const created = await adminDb.admin_changelog_entries.create({
    data: {
      published_at: data.publishedAt,
      title: data.title.trim(),
      summary: data.summary.trim(),
      version: data.version ?? null,
      category: data.category,
      changes: data.changes,
      author_admin_user_id: session.userId,
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "changelog_entry_created",
    metadata: {
      entry_id: created.id,
      title: data.title.trim(),
      category: data.category,
      version: data.version ?? null,
      change_count: data.changes.length,
    },
  });

  revalidateTag("changelog");
  revalidatePath("/changelogs");
  return { id: created.id };
}

// ---------------------------------------------------------------------------
// updateChangelogEntry
// ---------------------------------------------------------------------------

export async function updateChangelogEntry(
  id: string,
  input: ChangelogEntryInput,
): Promise<void> {
  const session = await requireAdmin();
  await requireCapability(
    session,
    "__can_manage_changelog",
    "update changelog entries",
  );

  if (!id || typeof id !== "string") throw new Error("Entry id is required");

  const parsed = entryInputSchema.safeParse(input);
  if (!parsed.success) throw new Error(firstError(parsed.error));
  const data = parsed.data;

  await ensureChangelogSchema();

  const existing = await adminDb.admin_changelog_entries.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      category: true,
      version: true,
      published_at: true,
    },
  });
  if (!existing) throw new Error("Entry not found");

  await adminDb.admin_changelog_entries.update({
    where: { id },
    data: {
      published_at: data.publishedAt,
      title: data.title.trim(),
      summary: data.summary.trim(),
      version: data.version ?? null,
      category: data.category,
      changes: data.changes,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "changelog_entry_updated",
    metadata: {
      entry_id: id,
      previous: {
        title: existing.title,
        category: existing.category,
        version: existing.version,
        published_at: existing.published_at.toISOString(),
      },
      next: {
        title: data.title.trim(),
        category: data.category,
        version: data.version ?? null,
        published_at: data.publishedAt.toISOString(),
        change_count: data.changes.length,
      },
    },
  });

  revalidateTag("changelog");
  revalidatePath("/changelogs");
}

// ---------------------------------------------------------------------------
// deleteChangelogEntry
// ---------------------------------------------------------------------------

export async function deleteChangelogEntry(id: string): Promise<void> {
  const session = await requireAdmin();
  await requireCapability(
    session,
    "__can_manage_changelog",
    "delete changelog entries",
  );

  if (!id || typeof id !== "string") throw new Error("Entry id is required");

  await ensureChangelogSchema();

  const existing = await adminDb.admin_changelog_entries.findUnique({
    where: { id },
    select: { id: true, title: true, category: true, version: true },
  });
  if (!existing) throw new Error("Entry not found");

  await adminDb.admin_changelog_entries.delete({ where: { id } });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "changelog_entry_deleted",
    metadata: {
      entry_id: id,
      title: existing.title,
      category: existing.category,
      version: existing.version,
    },
  });

  revalidateTag("changelog");
  revalidatePath("/changelogs");
}
