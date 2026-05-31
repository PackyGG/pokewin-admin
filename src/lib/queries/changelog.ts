import "server-only";

import { unstable_cache } from "next/cache";

import { adminDb } from "@/lib/admin-db";
import recentPushes from "@/lib/changelog/recent-pushes.json";
import {
  CHANGELOG_CATEGORIES,
  CHANGELOG_CHANGE_KINDS,
  type ChangelogCategory,
  type ChangelogChange,
  type ChangelogChangeKind,
  type ChangelogEntry,
  type ChangelogStats,
} from "@/lib/changelog/types";

// Re-export the shared vocabulary so existing server-side call sites
// that import from `@/lib/queries/changelog` keep working. Client
// components MUST import from `@/lib/changelog/types` directly to avoid
// pulling `next/cache` / `node:module` into the client bundle (this
// file is `import "server-only"` for that reason).
export {
  CHANGELOG_CATEGORIES,
  CHANGELOG_CHANGE_KINDS,
  type ChangelogCategory,
  type ChangelogChange,
  type ChangelogChangeKind,
  type ChangelogEntry,
  type ChangelogStats,
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
 * and the most recent published_at. Counts BOTH the admin-curated DB
 * rows AND the auto-generated commit entries (from
 * `getAutoChangelogEntries()`) so the tiles match what the page renders
 * below. Without this merge the user sees "Total entries 0" even when
 * 80 commit cards are listed underneath.
 *
 * Wrapped in `unstable_cache` (60s, tag `changelog`) so the page hero
 * strip doesn't re-query on every render; revalidated explicitly by
 * the create/update/delete actions. The auto-entry side is a near-zero
 * cost JSON read (Next.js inlines the import at bundle time), so
 * including it inside the cached function is fine.
 */
async function getChangelogStatsUncached(): Promise<ChangelogStats> {
  // Start of the current calendar month in UTC. Matches the convention
  // used by formatMonthYear / formatDate (en-US, no zone) elsewhere.
  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  const monthStartMs = monthStart.getTime();

  const [dbTotal, dbThisMonth, dbLatest, autoEntries] = await Promise.all([
    adminDb.admin_changelog_entries.count(),
    adminDb.admin_changelog_entries.count({
      where: { published_at: { gte: monthStart } },
    }),
    adminDb.admin_changelog_entries.findFirst({
      orderBy: { published_at: "desc" },
      select: { published_at: true },
    }),
    getAutoChangelogEntries(),
  ]);

  // Auto entries are returned already-iso, but published_at order isn't
  // guaranteed by `getAutoChangelogEntries()` — the JSON file is git-log
  // order (newest first) which IS desc, but we treat that as
  // unspecified here and pick the max explicitly so this stays robust
  // if the script ordering ever changes.
  let autoLatestMs = -Infinity;
  let autoThisMonth = 0;
  for (const e of autoEntries) {
    const t = Date.parse(e.publishedAt);
    if (Number.isNaN(t)) continue;
    if (t > autoLatestMs) autoLatestMs = t;
    if (t >= monthStartMs) autoThisMonth += 1;
  }

  const dbLatestMs = dbLatest?.published_at.getTime() ?? -Infinity;
  const lastMs = Math.max(dbLatestMs, autoLatestMs);

  return {
    totalEntries: dbTotal + autoEntries.length,
    thisMonthEntries: dbThisMonth + autoThisMonth,
    lastPublishedAt: lastMs > -Infinity ? new Date(lastMs).toISOString() : null,
  };
}

export const getChangelogStats = unstable_cache(
  getChangelogStatsUncached,
  ["changelog-stats-v1"],
  { revalidate: 60, tags: ["changelog"] },
);

// ---------------------------------------------------------------------------
// Auto entries — one per git commit on the branch
// ---------------------------------------------------------------------------

/**
 * Marker used to distinguish auto-generated entries (one per commit)
 * from admin-curated DB rows. The page checks `id.startsWith(AUTO_ID_PREFIX)`
 * to suppress edit / delete buttons on auto cards — they're owned by
 * git, not by the admin DB.
 */
export const AUTO_ID_PREFIX = "auto-";

const CONVENTIONAL_RE =
  /^(feat|fix|perf|refactor|chore|docs|style|test|build|ci|revert|nav|ux)(\(([^)]*)\))?\s*:\s*(.+)$/i;

const REVERT_RE = /^revert\s+["']?(.+?)["']?$/i;

/**
 * Map a conventional-commit type prefix onto our existing
 * `ChangelogCategory` vocabulary. The 5-value union is intentionally
 * narrow (feature / fix / improvement / breaking / infra) — anything
 * else gets the safe "improvement" default so the badge palette still
 * renders.
 */
function categorizeFromType(type: string): ChangelogCategory {
  const t = type.toLowerCase();
  if (t === "feat") return "feature";
  if (t === "fix") return "fix";
  if (t === "revert") return "breaking";
  if (t === "perf" || t === "refactor" || t === "chore" || t === "build" || t === "ci") {
    return "improvement";
  }
  // docs, style, test, nav, ux — informational tweaks, no user-facing
  // surface change worth flagging. Bucketed as "infra" (gray badge).
  return "infra";
}

/**
 * Strip the conventional-commit prefix and tidy the subject for display.
 * Falls back to the raw subject if cleaning would leave it empty.
 *
 *   "feat(sets): drop language input"        → "drop language input"
 *   "Revert \"feat(foo): bar\""              → "Revert: feat(foo): bar"
 *   "nav: move Promo Codes"                  → "move Promo Codes"
 *   "ec9a61c|...|fix: thing"                 → "thing"
 *
 * Always capped at 100 chars to keep card heights stable.
 */
function cleanSubject(raw: string): {
  title: string;
  scope: string | null;
  category: ChangelogCategory;
} {
  const subject = raw.trim();

  // Revert prefix uses a different shape ("Revert \"...\"") and we want
  // to preserve the wrapped message rather than parse it as its own
  // conventional commit.
  const revertMatch = subject.match(REVERT_RE);
  if (revertMatch) {
    const inner = revertMatch[1]?.trim() ?? "";
    const title = inner ? `Revert: ${inner}` : "Revert";
    return {
      title: title.length > 100 ? title.slice(0, 99) + "…" : title,
      scope: null,
      category: "breaking",
    };
  }

  const match = subject.match(CONVENTIONAL_RE);
  if (!match) {
    // Not a conventional commit — keep the raw subject, default to
    // "improvement" so the badge palette doesn't go gray on unknown.
    const title = subject.length > 100 ? subject.slice(0, 99) + "…" : subject;
    return { title, scope: null, category: "improvement" };
  }

  const [, type, , scope, body] = match;
  const cleanedBody = (body ?? "").trim();
  const title = cleanedBody.length > 100
    ? cleanedBody.slice(0, 99) + "…"
    : cleanedBody;

  return {
    title: title.length > 0 ? title : subject,
    scope: scope?.trim() || null,
    category: categorizeFromType(type),
  };
}

/**
 * Read the build-time JSON dump and surface each commit as a display-only
 * ChangelogEntry. NO database access — the JSON file is regenerated by
 * `scripts/generate-changelog.mjs` (wired as `prebuild`) so every Vercel
 * deploy reflects the latest commits.
 *
 * Returns the same `ChangelogEntry` shape as `getChangelogEntries` so
 * the page can concat both lists and render them through the same card
 * component. The `id` is prefixed with `AUTO_ID_PREFIX` so the page can
 * suppress edit / delete buttons on auto cards.
 *
 * Implementation is synchronous (no IO at request time — Next.js
 * statically inlines the JSON import) but kept `async` to match the
 * shape `safeQuery()` expects and to leave room for a future
 * fs-based variant.
 */
export async function getAutoChangelogEntries(): Promise<ChangelogEntry[]> {
  const data = recentPushes as {
    generatedAt?: string;
    entries?: Array<{ sha: string; iso: string; subject: string }>;
  };
  const raw = Array.isArray(data.entries) ? data.entries : [];

  const entries: ChangelogEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.sha !== "string" || item.sha.length === 0) continue;
    if (typeof item.iso !== "string" || item.iso.length === 0) continue;
    if (typeof item.subject !== "string" || item.subject.length === 0) continue;

    // Skip anything that isn't a valid ISO timestamp — Date parsing
    // returns NaN for garbage, which would break the sort downstream.
    const ms = Date.parse(item.iso);
    if (Number.isNaN(ms)) continue;
    const publishedAt = new Date(ms).toISOString();

    const { title, scope, category } = cleanSubject(item.subject);

    // Scope (when present) shows up as a small monospace prefix on the
    // title — keeps "feat(sets): drop language input" recoverable
    // without bringing the full conventional-commit string into the UI.
    const displayTitle = scope ? `${scope}: ${title}` : title;

    entries.push({
      id: `${AUTO_ID_PREFIX}${item.sha}`,
      publishedAt,
      title: displayTitle,
      summary: "",
      version: item.sha,
      category,
      changes: [],
      author: {
        adminUserId: null,
        // Branch label, not the git user's actual name/email — see the
        // SECURITY note in scripts/generate-changelog.mjs.
        username: "claude/hungry-gould",
      },
      createdAt: publishedAt,
      updatedAt: publishedAt,
    });
  }

  return entries;
}

/**
 * Type-guard used by the page to decide whether to show edit / delete
 * controls on a card. Auto entries are owned by git, not the admin DB.
 */
export function isAutoChangelogEntry(entry: ChangelogEntry): boolean {
  return entry.id.startsWith(AUTO_ID_PREFIX);
}
