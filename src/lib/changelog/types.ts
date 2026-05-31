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
};

export type ChangelogStats = {
  totalEntries: number;
  thisMonthEntries: number;
  lastPublishedAt: string | null;
};
