import "server-only";

import { unstable_cache } from "next/cache";

import { adminDb } from "@/lib/admin-db";
import recentPushes from "@/lib/changelog/recent-pushes.json";
import {
  getLatestCommitsFromGitHub,
  resolveChangelogBranch,
} from "@/lib/changelog/github";
import {
  CHANGELOG_CATEGORIES,
  CHANGELOG_CHANGE_KINDS,
  type ChangelogCategory,
  type ChangelogChange,
  type ChangelogChangeKind,
  type ChangelogEntry,
  type ChangelogFile,
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
  type ChangelogFile,
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

  const [dbTotal, dbThisMonth, dbLatest, autoResult] = await Promise.all([
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
  for (const e of autoResult.entries) {
    const t = Date.parse(e.publishedAt);
    if (Number.isNaN(t)) continue;
    if (t > autoLatestMs) autoLatestMs = t;
    if (t >= monthStartMs) autoThisMonth += 1;
  }

  const dbLatestMs = dbLatest?.published_at.getTime() ?? -Infinity;
  const lastMs = Math.max(dbLatestMs, autoLatestMs);

  return {
    totalEntries: dbTotal + autoResult.entries.length,
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
 * Result envelope returned by `getAutoChangelogEntries()`. Wraps the
 * usual `ChangelogEntry[]` payload with diagnostic metadata so the
 * page can show the admin which source served the cards and (when
 * applicable) why the GitHub path didn't win.
 *
 * `source` values:
 *   - "github"        — GitHub REST returned at least one entry; cards
 *                       are the live feed (60s cached).
 *   - "json-fallback" — GitHub was attempted but yielded zero entries
 *                       or errored; cards came from the build-time JSON.
 *   - "json"          — `GITHUB_TOKEN` not configured; no API call
 *                       attempted, cards came from the build-time JSON.
 *
 * `lastError` carries a short tag ("HTTP 401" / "Network timeout" /
 * "Empty response" / …) only when GitHub was attempted and went wrong;
 * `null` otherwise.
 *
 * `branch` is `null` only in the "json" no-token state. In the github
 * and json-fallback states it's the resolved branch name (so the admin
 * can confirm the chip is reading the branch they expect).
 *
 * `lastFetchAt` is an ISO timestamp captured at the moment this
 * function ran — useful for the diagnostic panel to confirm requests
 * are reaching the server.
 */
export type AutoChangelogResult = {
  entries: ChangelogEntry[];
  source: "github" | "json" | "json-fallback";
  branch: string | null;
  lastFetchAt: string;
  lastError: string | null;
  tokenConfigured: boolean;
};

/**
 * Surface each git commit as a display-only ChangelogEntry. Tries two
 * sources, in order:
 *
 *   1. The GitHub REST API at REQUEST time, via
 *      `getLatestCommitsFromGitHub()` (cached 60s by `cachedGithubFetch`
 *      below, keyed on branch so a config change invalidates the cache
 *      immediately). This is the preferred path — it reflects commits
 *      pushed AFTER the last Vercel deploy, including commits on a
 *      feature branch that prod isn't deployed from. Requires
 *      `GITHUB_TOKEN` set in the Vercel project env. Optional knobs:
 *        - `CHANGELOG_GIT_BRANCH` (default "main")
 *        - `CHANGELOG_GIT_REPO`   (default "PackyGG/pokewin-admin")
 *
 *   2. The build-time JSON at `src/lib/changelog/recent-pushes.json`,
 *      regenerated by `scripts/generate-changelog.mjs` as the `prebuild`
 *      step. A FALLBACK only — used when:
 *        - `GITHUB_TOKEN` env var isn't set (fresh local clone)
 *        - GitHub API call fails (rate limit, outage, network egress
 *          blocked, branch missing, auth failure)
 *      The JSON path keeps the page functional even with zero
 *      configuration, just at build-time freshness.
 *
 * Returns an `AutoChangelogResult` envelope so the page can surface
 * which source served the data + any error tag to a visible diagnostic
 * chip. The legacy `ChangelogEntry[]` payload lives at `.entries`.
 */
export async function getAutoChangelogEntries(): Promise<AutoChangelogResult> {
  const lastFetchAt = new Date().toISOString();
  // Resolve the branch here so the cached call gets keyed on it (the
  // arg is hashed into the cache key by Next.js, in addition to the
  // explicit key parts on the wrapper below). Without this, switching
  // `CHANGELOG_GIT_BRANCH` would keep returning entries for the
  // previous branch until the 60s revalidate window closed.
  const branch = resolveChangelogBranch();
  const githubRaw = await cachedGithubFetch(branch);

  // No token: never attempted, render the JSON path as "snapshot" not
  // as "fallback after a failure". Tooltip wording on the chip differs.
  if (!githubRaw.tokenConfigured) {
    return {
      entries: loadJsonEntries(),
      source: "json",
      branch: null,
      lastFetchAt,
      lastError: null,
      tokenConfigured: false,
    };
  }

  // Token configured AND the call returned at least one entry — live
  // path. We intentionally do NOT swap to the JSON on non-empty-but-
  // short results: if GitHub returns 3 commits and the JSON has 80,
  // the 3 are still the freshest possible truth, which is what the
  // user asked for.
  if (githubRaw.entries.length > 0) {
    return {
      entries: mapRawCommitsToEntries(githubRaw.entries),
      source: "github",
      branch: githubRaw.branch,
      lastFetchAt,
      lastError: githubRaw.error,
      tokenConfigured: true,
    };
  }

  // Token configured but the call returned zero entries (errored, rate-
  // limited, branch missing, or just an empty list). Fall back to JSON
  // and tell the admin via `source: "json-fallback"` + `lastError`.
  return {
    entries: loadJsonEntries(),
    source: "json-fallback",
    branch: githubRaw.branch,
    lastFetchAt,
    lastError: githubRaw.error ?? "Empty response",
    tokenConfigured: true,
  };
}

/**
 * Parse the build-time JSON dump into the same display-ready entry
 * shape `mapRawCommitsToEntries` emits. Extracted from
 * `getAutoChangelogEntries` so the two fallback branches (no-token,
 * github-failed) share one implementation.
 */
function loadJsonEntries(): ChangelogEntry[] {
  const data = recentPushes as {
    generatedAt?: string;
    entries?: Array<{
      sha: string;
      iso: string;
      subject: string;
      // Everything past sha/iso/subject is optional on disk so an older
      // committed JSON file (from before scripts/generate-changelog.mjs
      // started capturing it) still parses cleanly. The renderer treats
      // each as a graceful-degrade field.
      body?: string;
      filesChanged?: number | null;
      additions?: number | null;
      deletions?: number | null;
      scope?: string | null;
      files?: Array<{
        path?: unknown;
        status?: unknown;
        additions?: unknown;
        deletions?: unknown;
      }>;
    }>;
  };
  const raw = Array.isArray(data.entries) ? data.entries : [];
  return mapRawCommitsToEntries(
    raw.map((r) => ({
      sha: r.sha,
      iso: r.iso,
      subject: r.subject,
      body: r.body ?? "",
      filesChanged: finiteOrNull(r.filesChanged),
      additions: finiteOrNull(r.additions),
      deletions: finiteOrNull(r.deletions),
      scope:
        typeof r.scope === "string" && r.scope.trim().length > 0
          ? r.scope.trim()
          : null,
      files: narrowFiles(r.files),
    })),
  );
}

/** Coerce an unknown to a finite number or null. */
function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Narrow the raw JSON `files[]` blob to typed `ChangelogFile[]`. Drops
 * entries with a missing / non-string path; coerces missing status to
 * "M" (a reasonable default — most touched files are modifications) and
 * non-numeric per-file counts to null. Bounded by MAX_FILES_PER_COMMIT
 * (the generator already caps, this is belt-and-suspenders against a
 * hand-edited JSON).
 */
function narrowFiles(raw: unknown): ChangelogFile[] {
  if (!Array.isArray(raw)) return [];
  const out: ChangelogFile[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as {
      path?: unknown;
      status?: unknown;
      additions?: unknown;
      deletions?: unknown;
    };
    if (typeof obj.path !== "string" || obj.path.length === 0) continue;
    out.push({
      path: obj.path,
      status:
        typeof obj.status === "string" && obj.status.length > 0
          ? obj.status
          : "M",
      additions: finiteOrNull(obj.additions),
      deletions: finiteOrNull(obj.deletions),
    });
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * Internal: shape-normalise raw commit records (from EITHER GitHub or
 * the on-disk JSON) into the display-ready `ChangelogEntry` form. Both
 * sources emit the same intermediate shape (sha / iso / subject / body /
 * filesChanged / additions / deletions / scope / files) so this mapper
 * is source-agnostic and the rendering logic stays in one place.
 *
 * The per-change `changes[]` list — the "explanation for each change" —
 * is derived HERE via `deriveChanges(body, files, summary)`: real body
 * bullets when the commit is itemized, file-area grouping otherwise
 * (a prose-only body stays the card's description, not a bullet). So
 * every auto card carries at least one scannable explanatory bullet
 * without duplicating the description text.
 */
function mapRawCommitsToEntries(
  raw: Array<{
    sha: string;
    iso: string;
    subject: string;
    body: string;
    filesChanged: number | null;
    additions?: number | null;
    deletions?: number | null;
    scope?: string | null;
    files?: ChangelogFile[];
  }>,
): ChangelogEntry[] {
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

    const { title, scope: subjectScope, category } = cleanSubject(item.subject);

    // Scope (when present) shows up as a small monospace prefix on the
    // title — keeps "feat(sets): drop language input" recoverable
    // without bringing the full conventional-commit string into the UI.
    const displayTitle = subjectScope ? `${subjectScope}: ${title}` : title;

    // Prefer the scope captured upstream (generator / GitHub parse);
    // fall back to the one re-derived by cleanSubject so an older JSON
    // without the field still gets an area badge.
    const scope =
      typeof item.scope === "string" && item.scope.trim().length > 0
        ? item.scope.trim()
        : subjectScope;

    // Commit body becomes the entry summary — but strip the trailing
    // Co-Authored-By footer (and similar trailer lines) so the card
    // doesn't lead with admin metadata, and cap at 3 paragraphs so a
    // verbose commit doesn't make one card swallow the feed.
    const summary = normalizeCommitBody(item.body);

    const files = Array.isArray(item.files) ? item.files : [];
    // The per-change explanation — real body bullets when itemized,
    // file-area fallback otherwise. `summary` is passed so a derived
    // bullet can't duplicate the description shown above it on the card.
    // `fromBody` tells the renderer whether the commit was itemized (drop
    // the redundant summary block) or prose (keep it as a description).
    const { changes, fromBody: changesFromBody } = deriveChanges(
      item.body,
      files,
      summary,
    );

    entries.push({
      id: `${AUTO_ID_PREFIX}${item.sha}`,
      publishedAt,
      title: displayTitle,
      summary,
      version: item.sha,
      category,
      changes,
      author: {
        adminUserId: null,
        // Branch label rather than the git user identity — see the
        // SECURITY note in scripts/generate-changelog.mjs + github.ts.
        // We read CHANGELOG_GIT_BRANCH so the label tracks whichever
        // branch the live API path is configured against; the default
        // matches the default in github.ts.
        username:
          process.env.CHANGELOG_GIT_BRANCH?.trim() || "main",
      },
      createdAt: publishedAt,
      updatedAt: publishedAt,
      filesChanged: item.filesChanged,
      scope,
      files,
      additions: typeof item.additions === "number" ? item.additions : null,
      deletions: typeof item.deletions === "number" ? item.deletions : null,
      changesFromBody,
    });
  }
  return entries;
}

/**
 * Cached wrapper for the GitHub fetch. 60s revalidate strikes a
 * balance between "fresh enough that a just-pushed commit shows up
 * within a minute" and "well under GitHub's 5000/hr authenticated
 * rate limit even with heavy admin traffic". Tagged `"changelog"` so
 * the create/update/delete server actions in `actions.ts` invalidate
 * it alongside `getChangelogStats` — keeps the cards + the KPI tile
 * coherent.
 *
 * The cache KEY explicitly includes the branch name (resolved before
 * the call) so changing `CHANGELOG_GIT_BRANCH` from `main` to e.g.
 * `claude/hungry-gould` invalidates the cache IMMEDIATELY — without
 * this, the previous branch's entries would still serve for up to
 * 60 seconds. The branch is also passed as an arg (the inner helper
 * needs it) which Next.js folds into the auto-generated key — both
 * layers together make the per-branch isolation defensive.
 */
function cachedGithubFetch(branch: string) {
  return unstable_cache(
    () => getLatestCommitsFromGitHub(branch),
    ["changelog-github-v1", branch],
    { revalidate: 60, tags: ["changelog"] },
  )();
}

/**
 * Normalise a raw git commit body for display:
 *   - Drop trailer lines like "Co-Authored-By:", "Signed-off-by:",
 *     "Reviewed-by:", etc. (RFC-style trailers at the end of the body).
 *   - Collapse 3+ consecutive blank lines into a paragraph break.
 *   - Cap at 3 paragraphs so a long commit doesn't push subsequent
 *     cards off-screen. A "Show more" disclosure on the renderer side
 *     can still surface the full text on demand.
 *
 * Returns an empty string when the cleaned body is whitespace-only.
 */
function normalizeCommitBody(raw: string): string {
  const cleaned = stripTrailers(raw);
  if (cleaned.length === 0) return "";

  const paragraphs = cleaned.split(/\n\n+/);
  // Cap at 3 paragraphs. A trailing "…" makes the truncation visible
  // so a curator can decide whether to crack open the full git log.
  if (paragraphs.length <= 3) return cleaned;
  return paragraphs.slice(0, 3).join("\n\n") + "\n\n…";
}

/**
 * RFC-style trailer matcher (Co-Authored-By:, Signed-off-by:,
 * Reviewed-by:, Fixes:, Closes:, etc.) — a single capitalised token
 * followed by `:` and a non-space. Used to strip the trailer block off
 * the tail of a commit body before display / change-parsing.
 */
const TRAILER_RE = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*\S/;

/**
 * Strip the contiguous RFC-trailer block (Co-Authored-By, etc.) from the
 * TAIL of a commit body and collapse runs of 3+ blank lines into a
 * single paragraph break. Shared by `normalizeCommitBody` (summary) and
 * `parseChangesFromBody` (per-change bullets) so both views agree on
 * what counts as "the body". Returns "" for a whitespace-only result.
 */
function stripTrailers(raw: string): string {
  if (typeof raw !== "string") return "";
  // Split on any-line-ending so we tolerate CRLF if git ever writes it.
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");

  // Trailers are tail-anchored and contiguous, so we walk the end of the
  // list, dropping trailing blank lines and trailer-shaped lines until we
  // hit real body content.
  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    if (last === "") {
      lines.pop();
      continue;
    }
    if (TRAILER_RE.test(last)) {
      lines.pop();
      continue;
    }
    break;
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------------
// Per-change derivation — the structured "explanation for each change"
// ---------------------------------------------------------------------------

// Hard cap on derived bullets per commit so a 12-item numbered body
// can't make one card swallow the feed. The renderer shows "+N more
// changes" beyond this. Mirrors the 3-paragraph cap on the summary.
const MAX_CHANGES_PER_COMMIT = 8;

// Keyword → change-kind inference table. Ordered by specificity:
// the FIRST matching group wins, so "remove" (breaking) is checked
// before the generic improvement default. Anchored on word-ish
// boundaries via the per-keyword regexes built below.
const KIND_KEYWORDS: Array<{ kind: ChangelogChangeKind; words: string[] }> = [
  { kind: "fix", words: ["fix", "fixes", "fixed", "bug", "bugfix", "correct", "repair", "resolve", "patch"] },
  { kind: "breaking", words: ["remove", "removes", "removed", "drop", "drops", "dropped", "delete", "deletes", "deleted", "breaking", "deprecate"] },
  { kind: "feature", words: ["add", "adds", "added", "new", "introduce", "introduces", "create", "creates", "implement", "implements", "support", "surface", "surfaces"] },
  { kind: "improvement", words: ["perf", "faster", "optimize", "optimise", "optimized", "speed", "improve", "improves", "improved", "tweak", "refine"] },
  { kind: "infra", words: ["refactor", "refactors", "refactored", "chore", "docs", "rename", "renames", "renamed", "move", "moves", "moved", "extract", "extracts", "bump", "wire", "wires", "wired"] },
];

/**
 * Infer a `ChangelogChangeKind` from a change line's text by keyword.
 * Defaults to "improvement" — a neutral positive that still renders a
 * colored bullet (matches the task spec's default). Case-insensitive,
 * matches on whole words so "address" doesn't trip the "add" keyword.
 */
function inferChangeKind(text: string): ChangelogChangeKind {
  const lower = ` ${text.toLowerCase()} `;
  for (const { kind, words } of KIND_KEYWORDS) {
    for (const w of words) {
      // \b word boundaries so "add" matches "add"/"adds" (handled via the
      // explicit plural list) but not the middle of "address" / "padding".
      const re = new RegExp(`\\b${w}\\b`);
      if (re.test(lower)) return kind;
    }
  }
  return "improvement";
}

const BULLET_RE = /^\s*(?:[-*•‣◦]|\d+[.)]|[a-z][.)])\s+/i;

// A derived change bullet longer than this reads as a paragraph, not a
// scannable line. We trim it down to its first sentence/clause so the
// card stays a tidy bullet list rather than a wall of prose.
const MAX_CHANGE_LEN = 140;

/**
 * Trim a change bullet to a scannable length. If the collapsed text is
 * within MAX_CHANGE_LEN it's returned as-is. Otherwise we cut at the
 * first sentence end (". " / "! " / "? ") that lands inside the budget;
 * failing that, at the last word boundary before the cap, with an
 * ellipsis so the truncation is visible. Keeps each bullet to one tidy
 * line instead of letting a hard-wrapped sentence sprawl.
 */
function trimChangeText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_CHANGE_LEN) return collapsed;

  // Prefer a sentence boundary inside the budget.
  const sentenceEnd = collapsed.slice(0, MAX_CHANGE_LEN).search(/[.!?](?:\s|$)/);
  if (sentenceEnd > 30) {
    return collapsed.slice(0, sentenceEnd + 1);
  }

  // Else cut at the last word boundary before the cap.
  const slice = collapsed.slice(0, MAX_CHANGE_LEN);
  const lastSpace = slice.lastIndexOf(" ");
  const base = lastSpace > 30 ? slice.slice(0, lastSpace) : slice;
  return base.replace(/[.,;:]?\s*$/, "") + "…";
}

/**
 * Parse a commit body into per-change bullets — but ONLY when the body
 * is genuinely itemized. A single prose paragraph is NOT a change list:
 * emitting it as one giant "change" just duplicates the summary shown
 * above it (the exact bug this fixes). So:
 *
 *   - Body HAS real bullet markers (`-` / `*` / `•` / `N.` / `N)` /
 *     `a.`) → split on them. Continuation lines (indented / non-marker)
 *     fold into the current bullet so a hard-wrapped bullet stays one
 *     change. Intro lines before the first bullet are context (already
 *     in the summary) and dropped. Each bullet is trimmed to one
 *     scannable line via `trimChangeText`.
 *
 *   - Body has NO bullet markers (one or more prose paragraphs) → return
 *     `[]`. The prose renders ONCE as the card's short description; the
 *     scannable "what changed" list comes from the file-area fallback in
 *     `deriveChanges` instead, so nothing is duplicated.
 *
 * Trailers (Co-Authored-By etc.) are stripped first via `stripTrailers`.
 * Each change's `kind` is inferred from its text via `inferChangeKind`.
 * Capped at MAX_CHANGES_PER_COMMIT (the renderer surfaces the overflow).
 */
function parseChangesFromBody(rawBody: string): ChangelogChange[] {
  const body = stripTrailers(rawBody);
  if (body.length === 0) return [];

  const lines = body.split("\n");
  const hasBullets = lines.some((l) => BULLET_RE.test(l));

  // No real bullets → not an itemized change list. Let the file-area
  // fallback own the "what changed" bullets; the prose stays a one-off
  // description on the card. This is the fix for the single-paragraph
  // body that used to become one giant duplicated bullet.
  if (!hasBullets) return [];

  const rawChanges: string[] = [];
  let current: string | null = null;
  for (const line of lines) {
    if (BULLET_RE.test(line)) {
      if (current !== null) rawChanges.push(current);
      current = line.replace(BULLET_RE, "").trim();
    } else if (current !== null) {
      const trimmed = line.trim();
      // Blank line inside a bullet block ends the current bullet (so a
      // bullet followed by a free paragraph doesn't absorb it).
      if (trimmed === "") {
        rawChanges.push(current);
        current = null;
      } else {
        current = `${current} ${trimmed}`;
      }
    }
    // Non-bullet, non-continuation lines BEFORE the first bullet (an
    // intro sentence like "Three related fixes for …:") are dropped
    // from the change list — they're context, already shown in the
    // summary. The bullets themselves are the per-change explanation.
  }
  if (current !== null) rawChanges.push(current);

  const out: ChangelogChange[] = [];
  for (const text of rawChanges) {
    const collapsed = text.replace(/\s+/g, " ").trim();
    if (collapsed.length === 0) continue;
    const trimmed = trimChangeText(collapsed);
    out.push({ kind: inferChangeKind(trimmed), text: trimmed });
    if (out.length >= MAX_CHANGES_PER_COMMIT) break;
  }
  return out;
}

// Top-level file-area → human label map for the fallback path. Keys are
// matched as path PREFIXES, longest-first, so the most specific area
// wins ("src/lib/queries/" before "src/lib/"). Mirrors the feature-area
// vocabulary used across the admin panel's nav.
const AREA_LABELS: Array<{ prefix: string; label: string }> = [
  { prefix: "src/app/(admin)/", label: "Admin pages" },
  { prefix: "src/app/(auth)/", label: "Auth pages" },
  { prefix: "src/components/data-table/", label: "Data tables" },
  { prefix: "src/components/ui/", label: "UI primitives" },
  { prefix: "src/components/", label: "Components" },
  { prefix: "src/lib/queries/", label: "Queries" },
  { prefix: "src/lib/changelog/", label: "Changelog" },
  { prefix: "src/lib/utils/", label: "Utilities" },
  { prefix: "src/lib/", label: "Library" },
  { prefix: "src/hooks/", label: "Hooks" },
  { prefix: "prisma/admin/", label: "Admin database" },
  { prefix: "prisma/", label: "Database" },
  { prefix: "scripts/", label: "Scripts" },
  { prefix: "public/", label: "Public assets" },
  { prefix: ".github/", label: "CI" },
  { prefix: "src/", label: "App" },
];

/**
 * Turn a path into its human area label. For an `src/app/(admin)/foo/...`
 * path we go one segment DEEPER than the generic "Admin pages" so the
 * fallback reads "Insights / Games" rather than a flat "Admin pages" for
 * everything under the admin tree — that's the level the user actually
 * recognises. Other trees fall back to the flat AREA_LABELS entry.
 */
function areaLabelForPath(path: string): string {
  const adminMatch = path.match(/^src\/app\/\(admin\)\/([^/]+)(?:\/([^/]+))?/);
  if (adminMatch) {
    const top = adminMatch[1];
    const sub = adminMatch[2];
    // Title-case the route segment(s): "insights" → "Insights",
    // "rewards" → "Rewards". Dashes become spaces ("gift-cards" → "Gift cards").
    const titleize = (s: string) =>
      s
        .replace(/-/g, " ")
        .replace(/^\w/, (c) => c.toUpperCase());
    // Skip dynamic segments ("[id]") for the sub-area — they're not a
    // recognisable feature name.
    if (sub && !sub.startsWith("[") && !sub.startsWith("_")) {
      return `${titleize(top)} / ${titleize(sub)}`;
    }
    return titleize(top);
  }
  for (const { prefix, label } of AREA_LABELS) {
    if (path.startsWith(prefix)) return label;
  }
  // Root-level file (e.g. "package.json", "next.config.ts") → "Project".
  return path.includes("/") ? "Other" : "Project";
}

/**
 * Fallback change derivation: when the commit body yields no structured
 * bullets/paragraphs (terse one-liner, or empty), group the touched
 * files by area and emit one change per area so EVERY commit still
 * carries a meaningful explanation. Areas are ordered by descending
 * touched-file count (the area with the most churn leads). Capped at
 * MAX_CHANGES_PER_COMMIT areas. Kind is fixed to "infra" — a file-area
 * summary is descriptive, not a claim about feature/fix intent.
 */
function deriveChangesFromFiles(files: ChangelogFile[]): ChangelogChange[] {
  if (!Array.isArray(files) || files.length === 0) return [];
  const counts = new Map<string, number>();
  for (const f of files) {
    if (!f || typeof f.path !== "string" || f.path.length === 0) continue;
    const label = areaLabelForPath(f.path);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const out: ChangelogChange[] = [];
  for (const [label, n] of ordered) {
    const text = n === 1 ? `Updated ${label}` : `Updated ${label} (${n} files)`;
    out.push({ kind: "infra", text });
    if (out.length >= MAX_CHANGES_PER_COMMIT) break;
  }
  return out;
}

/** Normalise text for the change-vs-summary de-dupe comparison: lower-
 *  case, collapse whitespace, drop trailing punctuation. So a bullet that
 *  only differs from the summary by a final period or casing still counts
 *  as a duplicate and gets dropped. */
function normalizeForDedupe(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?;:]+$/, "")
    .trim();
}

/**
 * Orchestrator: derive the per-change list for one commit.
 *
 *   1. Real body bullets (source A) take priority — an itemized commit
 *      body IS the change list.
 *   2. Otherwise the file-area grouping (source B) gives a scannable
 *      "what changed" list without re-printing the prose body (which the
 *      card already shows as its description). Guarantees every commit —
 *      even a terse subject-only one — gets at least one explanatory line.
 *
 * De-dupe guard: any derived bullet whose normalised text equals the
 * (normalised) summary is dropped, so a card never shows the same
 * sentence as both its description and a lone bullet.
 */
function deriveChanges(
  body: string,
  files: ChangelogFile[],
  summary: string,
): { changes: ChangelogChange[]; fromBody: boolean } {
  const bodyBullets = parseChangesFromBody(body);
  const fromBody = bodyBullets.length > 0;
  const base = fromBody ? bodyBullets : deriveChangesFromFiles(files);

  const summaryKey = normalizeForDedupe(summary);
  const changes =
    summaryKey.length === 0
      ? base
      : base.filter((c) => normalizeForDedupe(c.text) !== summaryKey);
  return { changes, fromBody };
}

/**
 * Type-guard used by the page to decide whether to show edit / delete
 * controls on a card. Auto entries are owned by git, not the admin DB.
 */
export function isAutoChangelogEntry(entry: ChangelogEntry): boolean {
  return entry.id.startsWith(AUTO_ID_PREFIX);
}
