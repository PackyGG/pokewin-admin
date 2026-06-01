/**
 * Shared changelog types + constants.
 *
 * This file has ZERO server-only dependencies (no `import "server-only"`,
 * no `next/cache`, no Prisma, no Node built-ins) and can be safely
 * imported from both Server Components and Client Components.
 *
 * The previous shape — these types living next to the cached query
 * helpers in `@/lib/queries/changelog` — broke the production build
 * because that file imports `unstable_cache` from `next/cache`, which
 * transitively pulls `node:module` into any bundle that imports the
 * file. The client dialog only needed the constants and types; the
 * client bundler followed the import chain and refused to bundle
 * `node:module`. Splitting the vocabulary out fixes that without
 * forcing every server caller to re-route their imports — the queries
 * file re-exports these symbols so existing call sites keep working.
 */

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

/**
 * One touched file in a commit, for the auto-entry "Files" disclosure.
 * `status` mirrors `git log --name-status` letters (A/M/D/R/C/T/U/X/B)
 * — kept as a free string rather than a union so an unexpected status
 * letter (e.g. `R100` for a 100%-similar rename) can't crash the
 * renderer; the card maps the FIRST letter to a label/color and shows
 * the rest verbatim.
 *
 * Only populated for auto entries derived from the build-time JSON
 * (`scripts/generate-changelog.mjs` captures `--name-status`). The
 * runtime GitHub list-commits path does NOT include per-file data
 * (that would cost one extra API call per commit), so `files` is
 * empty there — the renderer degrades gracefully.
 */
export type ChangelogFile = {
  /** Repo-relative path, e.g. "src/lib/queries/changelog.ts". */
  path: string;
  /** Single-letter git status (A=added, M=modified, D=deleted, R=renamed, …). */
  status: string;
  /** Lines added to this file (`git log --numstat`). `null` for binary
   *  files or when the numstat pass wasn't available. */
  additions?: number | null;
  /** Lines deleted from this file. `null` for binary / unavailable. */
  deletions?: number | null;
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
  /**
   * Number of files touched by this entry. Only populated for auto
   * entries derived from a git commit (see `getAutoChangelogEntries`).
   * `null` for admin-curated DB rows where the concept doesn't apply.
   */
  filesChanged?: number | null;
  /**
   * Conventional-commit scope parsed from the subject — `feat(insights/games): x`
   * → `"insights/games"`. Rendered as an "area" badge next to the
   * category badge. `null` when the subject had no `(scope)` segment
   * (also null for admin-curated DB rows). Distinct from the title's
   * inline `scope:` prefix so the badge stays consistent even when the
   * title is reverted / non-conventional.
   */
  scope?: string | null;
  /**
   * Per-file change list for the auto-entry "Files" disclosure. Capped
   * at ~20 entries upstream to bound the payload. Empty (`[]`) when the
   * source didn't carry file data (runtime GitHub path, or an older
   * committed JSON written before file capture landed). `undefined` for
   * admin-curated DB rows.
   */
  files?: ChangelogFile[];
  /** Lines added across the commit (`--shortstat` rollup / GitHub
   *  `stats.additions`). `null` when unavailable. */
  additions?: number | null;
  /** Lines deleted across the commit. `null` when unavailable. */
  deletions?: number | null;
};

export type ChangelogStats = {
  totalEntries: number;
  thisMonthEntries: number;
  lastPublishedAt: string | null;
};
