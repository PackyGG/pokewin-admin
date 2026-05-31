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

// ---------------------------------------------------------------------------
// seedChangelogFromRecentWork
//
// Bulk-insert entries from a hardcoded list (see
// `@/lib/changelog/recent-work`). Idempotent by `(published_at, title)` —
// if a row with the same calendar day + identical title already exists,
// it's skipped instead of inserting a duplicate. This lets the admin
// press the button again after adding new entries to RECENT_WORK_ENTRIES
// without producing duplicates of the ones that already landed.
//
// Equality on `published_at` is at calendar-day granularity (a UTC date
// window) so a re-press tomorrow doesn't get tricked by a millisecond
// drift in the source ISO string.
// ---------------------------------------------------------------------------

const seedEntrySchema = entryInputSchema;

const seedInputSchema = z
  .array(seedEntrySchema)
  .min(1, "No entries to seed")
  .max(200, "Too many entries — split into batches");

export type SeedChangelogResult = {
  seeded: number;
  skipped: number;
};

export async function seedChangelogFromRecentWork(
  entries: ChangelogEntryInput[],
): Promise<SeedChangelogResult> {
  const session = await requireAdmin();
  await requireCapability(
    session,
    "__can_manage_changelog",
    "bulk-seed changelog entries",
  );

  const parsed = seedInputSchema.safeParse(entries);
  if (!parsed.success) throw new Error(firstError(parsed.error));
  const data = parsed.data;

  await ensureChangelogSchema();

  // Pre-flight de-dupe: look up which (day, title) combos already exist
  // and skip those. Querying once with all titles + the broadest date
  // range is cheaper than N round-trips and avoids a TOCTOU race that a
  // single-day window would still have inside the loop.
  const allTitles = [...new Set(data.map((e) => e.title.trim()))];
  const minPublished = new Date(
    Math.min(...data.map((e) => e.publishedAt.getTime())),
  );
  // Expand the upper bound by one day so the broadest range covers
  // any same-day match regardless of hh:mm:ss.
  const maxPublishedRaw = new Date(
    Math.max(...data.map((e) => e.publishedAt.getTime())),
  );
  const maxPublished = new Date(
    Date.UTC(
      maxPublishedRaw.getUTCFullYear(),
      maxPublishedRaw.getUTCMonth(),
      maxPublishedRaw.getUTCDate() + 1,
      0,
      0,
      0,
      0,
    ),
  );
  const minPublishedFloor = new Date(
    Date.UTC(
      minPublished.getUTCFullYear(),
      minPublished.getUTCMonth(),
      minPublished.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );

  const existing = await adminDb.admin_changelog_entries.findMany({
    where: {
      title: { in: allTitles },
      published_at: { gte: minPublishedFloor, lt: maxPublished },
    },
    select: { title: true, published_at: true },
  });

  // Build a key set "YYYY-MM-DD|title" for O(1) duplicate lookup. The
  // calendar-day key sidesteps small TZ / millisecond drift between the
  // seed source and the existing rows.
  function dayKey(d: Date, title: string): string {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}|${title}`;
  }

  const existingKeys = new Set(
    existing.map((r) => dayKey(r.published_at, r.title)),
  );

  const toInsert = data.filter(
    (e) => !existingKeys.has(dayKey(e.publishedAt, e.title.trim())),
  );

  if (toInsert.length === 0) {
    // Still audit the no-op so the trail captures "admin clicked
    // re-seed and nothing was new" — useful for forensics.
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "changelog_bulk_seeded",
      metadata: {
        count: 0,
        skipped: data.length,
      },
    });
    return { seeded: 0, skipped: data.length };
  }

  // Single transaction so a partial failure can't leave the feed with
  // half the release history.
  await adminDb.$transaction(
    toInsert.map((e) =>
      adminDb.admin_changelog_entries.create({
        data: {
          published_at: e.publishedAt,
          title: e.title.trim(),
          summary: e.summary.trim(),
          version: e.version ?? null,
          category: e.category,
          changes: e.changes,
          author_admin_user_id: session.userId,
        },
        select: { id: true },
      }),
    ),
  );

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "changelog_bulk_seeded",
    metadata: {
      count: toInsert.length,
      skipped: data.length - toInsert.length,
    },
  });

  revalidateTag("changelog");
  revalidatePath("/changelogs");
  return { seeded: toInsert.length, skipped: data.length - toInsert.length };
}
