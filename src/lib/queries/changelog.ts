import "server-only";

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
