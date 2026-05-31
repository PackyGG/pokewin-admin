import "server-only";

import { unstable_cache } from "next/cache";

import { adminDb } from "@/lib/admin-db";

// ---------------------------------------------------------------------------
// Public types
//
// Categories + change kinds are exposed as exported string-union types so the
// page component (RSC) and the dialog (client) share one vocabulary without
// importing each other. The Zod schemas in the action file mirror these
// unions exactly.
// ---------------------------------------------------------------------------

export const CHANGELOG_CATEGORIES = [
  "feature",
  "fix",
  "improvement",
  "breaking",
  "infra",
] as const;
export type ChangelogCategory = (typeof CHANGELOG_CATEGORIES)[number];

export const CHANGELOG_CHANGE_KINDS = [
  "feature",
  "fix",
  "improvement",
  "breaking",
  "infra",
] as const;
export type ChangelogChangeKind = (typeof CHANGELOG_CHANGE_KINDS)[number];

export type ChangelogChange = {
  kind: ChangelogChangeKind;
  text: string;
};

export type ChangelogEntry = {
  id: string;
  publishedAt: string;
  title: string;
  summary: string;
  version: string | null;
  category: ChangelogCategory;
  changes: ChangelogChange[];
  author: {
    adminUserId: string | null;
    username: string | null;
  };
  createdAt: string;
  updatedAt: string;
};

export type ChangelogStats = {
  totalEntries: number;
  thisMonthEntries: number;
  lastPublishedAt: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function narrowCategory(value: string): ChangelogCategory {
  return (CHANGELOG_CATEGORIES as readonly string[]).includes(value)
    ? (value as ChangelogCategory)
    : "improvement";
}

/**
 * Narrow the raw JSONB `changes` blob to the typed `ChangelogChange[]`
 * shape. Any row that doesn't have a recognised `kind` is coerced to
 * `"improvement"` so an out-of-band write can't crash the card render.
 * Rows with non-string `text` (or missing text) are dropped silently.
 */
function narrowChanges(raw: unknown): ChangelogChange[] {
  if (!Array.isArray(raw)) return [];
  const out: ChangelogChange[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as { kind?: unknown; text?: unknown };
    if (typeof obj.text !== "string" || obj.text.trim().length === 0) continue;
    const kind: ChangelogChangeKind =
      typeof obj.kind === "string" &&
      (CHANGELOG_CHANGE_KINDS as readonly string[]).includes(obj.kind)
        ? (obj.kind as ChangelogChangeKind)
        : "improvement";
    out.push({ kind, text: obj.text });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Paginated feed of changelog entries — newest first. Default page size
 * of 20 entries; bounded to [1, 100] for safety.
 *
 * Authors are resolved in ONE admin-DB lookup keyed on the de-duped
 * author UUID set instead of N round-trips. A null
 * `author_admin_user_id` (admin row deleted post-publish) falls back
 * to `{ adminUserId: null, username: null }` so the card still renders.
 */
export async function getChangelogEntries(params?: {
  limit?: number;
  offset?: number;
}): Promise<ChangelogEntry[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(params?.limit ?? 20)));
  const offset = Math.max(0, Math.floor(params?.offset ?? 0));

  const rows = await adminDb.admin_changelog_entries.findMany({
    orderBy: { published_at: "desc" },
    take: limit,
    skip: offset,
  });

  const authorIds = [
    ...new Set(
      rows
        .map((r) => r.author_admin_user_id)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  const authorMap = new Map<string, { username: string }>();
  if (authorIds.length > 0) {
    const admins = await adminDb.admin_users.findMany({
      where: { id: { in: authorIds } },
      select: { id: true, username: true, display_username: true },
    });
    for (const a of admins) {
      authorMap.set(a.id, {
        username: a.display_username ?? a.username,
      });
    }
  }

  return rows.map((r) => ({
    id: r.id,
    publishedAt: r.published_at.toISOString(),
    title: r.title,
    summary: r.summary,
    version: r.version,
    category: narrowCategory(r.category),
    changes: narrowChanges(r.changes),
    author: {
      adminUserId: r.author_admin_user_id,
      username: r.author_admin_user_id
        ? (authorMap.get(r.author_admin_user_id)?.username ?? null)
        : null,
    },
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }));
}

/**
 * Single fetch for the edit dialog. Returns null when the entry no
 * longer exists (deleted between list render and dialog open).
 */
export async function getChangelogEntry(
  id: string,
): Promise<ChangelogEntry | null> {
  const row = await adminDb.admin_changelog_entries.findUnique({
    where: { id },
  });
  if (!row) return null;

  let authorUsername: string | null = null;
  if (row.author_admin_user_id) {
    const author = await adminDb.admin_users.findUnique({
      where: { id: row.author_admin_user_id },
      select: { username: true, display_username: true },
    });
    authorUsername = author?.display_username ?? author?.username ?? null;
  }

  return {
    id: row.id,
    publishedAt: row.published_at.toISOString(),
    title: row.title,
    summary: row.summary,
    version: row.version,
    category: narrowCategory(row.category),
    changes: narrowChanges(row.changes),
    author: {
      adminUserId: row.author_admin_user_id,
      username: authorUsername,
    },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * KPI tile data — total entries, count published this calendar month,
 * and the most recent published_at. Wrapped in `unstable_cache` (60s,
 * tag `changelog`) so the page hero strip doesn't re-query on every
 * render; revalidated explicitly by the create/update/delete actions.
 */
async function getChangelogStatsUncached(): Promise<ChangelogStats> {
  // Start of the current calendar month in UTC. Matches the convention
  // used by formatMonthYear / formatDate (en-US, no zone) elsewhere.
  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );

  const [totalEntries, thisMonthEntries, latest] = await Promise.all([
    adminDb.admin_changelog_entries.count(),
    adminDb.admin_changelog_entries.count({
      where: { published_at: { gte: monthStart } },
    }),
    adminDb.admin_changelog_entries.findFirst({
      orderBy: { published_at: "desc" },
      select: { published_at: true },
    }),
  ]);

  return {
    totalEntries,
    thisMonthEntries,
    lastPublishedAt: latest?.published_at.toISOString() ?? null,
  };
}

export const getChangelogStats = unstable_cache(
  getChangelogStatsUncached,
  ["changelog-stats-v1"],
  { revalidate: 60, tags: ["changelog"] },
);
