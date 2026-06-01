import {
  AlertTriangle,
  FileText,
  GitCommit,
  Info,
  List,
  Server,
  ScrollText,
  Sparkles,
  Tag,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

import {
  PageHero,
  PageHeroIdentity,
  KpiTile,
  SectionHeading,
  StatPanel,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { requirePageAccess, getUserPermissions } from "@/lib/dal";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import {
  formatDateTime,
  formatNumber,
  formatRelativeStrict,
} from "@/lib/utils/format";
import { ensureChangelogSchema } from "@/lib/changelog/ensure-schema";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  getAutoChangelogEntries,
  getChangelogEntries,
  getChangelogStats,
  isAutoChangelogEntry,
  type ChangelogCategory,
  type ChangelogChangeKind,
  type ChangelogEntry,
} from "@/lib/queries/changelog";
import { cn } from "@/lib/utils";

import {
  EditChangelogEntryButton,
  NewChangelogEntryButton,
} from "./changelog-form-dialog";
import { ChangelogSummary } from "./changelog-summary";
import { DeleteChangelogButton } from "./delete-changelog-button";
import { SeedChangelogButton } from "./seed-changelog-button";

export const metadata = { title: "Changelogs" };

// ---------------------------------------------------------------------------
// Cosmetic helpers — category and change-kind badge + icon mapping. Lives
// alongside the page so the card layout has direct access without crossing
// the RSC / client boundary. House-POV color rule does not apply here:
// changelog is informational, not financial.
//
// Categories follow the rule of thumb agreed in the task description:
//   feature      → emerald (positive, additive)
//   improvement  → blue    (positive, refinement)
//   fix          → amber   (warning-adjacent, drawing attention)
//   breaking     → rose    (loud, action-required signal)
//   infra        → neutral (gray — under-the-hood, not user-facing)
// ---------------------------------------------------------------------------

const CATEGORY_BADGE_CLASS: Record<ChangelogCategory, string> = {
  feature:
    "bg-emerald-500/15 text-emerald-600 border-emerald-500/30 dark:text-emerald-400",
  improvement:
    "bg-blue-500/15 text-blue-600 border-blue-500/30 dark:text-blue-400",
  fix: "bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400",
  breaking:
    "bg-rose-500/15 text-rose-600 border-rose-500/30 dark:text-rose-400",
  infra:
    "bg-muted text-muted-foreground border-border",
};

const CATEGORY_ICON: Record<ChangelogCategory, LucideIcon> = {
  feature: Sparkles,
  improvement: Zap,
  fix: Wrench,
  breaking: AlertTriangle,
  infra: Server,
};

const CATEGORY_LABEL: Record<ChangelogCategory, string> = {
  feature: "Feature",
  improvement: "Improvement",
  fix: "Fix",
  breaking: "Breaking",
  infra: "Infra",
};

const CHANGE_KIND_ICON: Record<ChangelogChangeKind, LucideIcon> = {
  feature: Sparkles,
  improvement: Zap,
  fix: Wrench,
  breaking: AlertTriangle,
  infra: Server,
};

const CHANGE_KIND_COLOR: Record<ChangelogChangeKind, string> = {
  feature: "text-emerald-500",
  improvement: "text-blue-500",
  fix: "text-amber-500",
  breaking: "text-rose-500",
  infra: "text-muted-foreground",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function ChangelogsPage() {
  const session = await requirePageAccess("/changelogs");

  // Self-heal the table on every render — IF-NOT-EXISTS so this is a
  // no-op after the first hit on a given server process. Same pattern as
  // the employee board / salaries surfaces.
  await ensureChangelogSchema();

  const isAdmin = session.role === "admin";
  let canManage = isAdmin;
  if (!isAdmin) {
    const perms = await getUserPermissions(session.userId);
    canManage = hasCapability(perms, "__can_manage_changelog");
  }

  // Fetch admin-curated DB entries + auto-generated commit entries in
  // parallel. Both are wrapped in safeQuery so a failure on one side
  // (e.g. JSON file missing on a fresh clone, admin DB hiccup) doesn't
  // blank the whole page — the working side still renders.
  const [
    { data: dbEntries },
    { data: autoEntries },
    { data: stats },
  ] = await Promise.all([
    safeQuery(
      () => getChangelogEntries({ limit: 100 }),
      [] as ChangelogEntry[],
      "changelogs.db-entries",
    ),
    safeQuery(
      () => getAutoChangelogEntries(),
      [] as ChangelogEntry[],
      "changelogs.auto-entries",
    ),
    safeQuery(
      () => getChangelogStats(),
      { totalEntries: 0, thisMonthEntries: 0, lastPublishedAt: null },
      "changelogs.stats",
    ),
  ]);

  // Merge — DB entries first to match the (rare) ordering tie where an
  // admin publishes a curated entry at the exact same instant as a
  // commit. Sort descending by publishedAt, newest first.
  const entries: ChangelogEntry[] = [...dbEntries, ...autoEntries].sort(
    (a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0),
  );

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ScrollText}
          accent="purple"
          title="Changelogs"
          subtitle="What's new in the admin panel and the platform."
          action={
            canManage ? (
              <div className="flex flex-wrap items-center gap-2">
                <SeedChangelogButton />
                <NewChangelogEntryButton />
              </div>
            ) : null
          }
        />
      </PageHero>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <KpiTile
          label="Total entries"
          value={formatNumber(stats.totalEntries)}
          icon={ScrollText}
          accent="purple"
        />
        <KpiTile
          label="Last published"
          // Lead with the precise absolute timestamp ("Jun 1, 2026 01:46")
          // — the old relative-only display ("about 13 hours ago") read
          // like a broken value because it never resolved into anything
          // an admin could correlate with a commit log. Fine-grained
          // relative moves to the sub line, using the strict variant so
          // there's no fuzzy "about" prefix.
          value={
            stats.lastPublishedAt ? formatDateTime(stats.lastPublishedAt) : "—"
          }
          sub={
            stats.lastPublishedAt
              ? formatRelativeStrict(stats.lastPublishedAt)
              : "No entries yet"
          }
          icon={Sparkles}
          accent="emerald"
          // Auto-generated commit cards are baked into
          // `src/lib/changelog/recent-pushes.json` at BUILD time by
          // `scripts/generate-changelog.mjs` (wired as `prebuild`). A
          // commit pushed after the last Vercel deploy won't appear
          // here until the next deploy refreshes the JSON. The Info
          // chip in the action slot makes that caveat discoverable —
          // same native `title=` pattern as the "auto" pill on each
          // commit card below.
          action={
            <span
              className="inline-flex size-5 items-center justify-center rounded-md border border-border/60 bg-muted/30 text-muted-foreground"
              title="Includes admin-published entries instantly, plus auto-generated commit entries captured at the last Vercel deploy. Commits pushed since then appear after the next build."
              aria-label="Last published includes git commits captured at last deploy"
            >
              <Info className="size-3" />
            </span>
          }
        />
      </div>

      <SectionHeading icon={List} title="Releases" />

      {entries.length === 0 ? (
        <StatPanel title="No entries yet" icon={ScrollText} accent="purple">
          <EmptyState
            icon={ScrollText}
            title="No entries yet"
            description={
              canManage
                ? "Click + New entry to publish your first changelog."
                : "An admin will publish release notes here as the platform ships updates."
            }
            accent="purple"
          />
        </StatPanel>
      ) : (
        <FadeIn>
          <div className="space-y-4">
            {entries.map((entry) => (
              <ChangelogCard
                key={entry.id}
                entry={entry}
                canManage={canManage}
              />
            ))}
          </div>
        </FadeIn>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function ChangelogCard({
  entry,
  canManage,
}: {
  entry: ChangelogEntry;
  canManage: boolean;
}) {
  // Auto entries (one per git commit) use a git icon in place of the
  // category icon, surface the short SHA as the version slot, and have
  // their edit / delete buttons hidden because they're owned by git,
  // not by the admin DB. The category badge palette still applies so
  // feat / fix / etc. stay visually distinguishable.
  const isAuto = isAutoChangelogEntry(entry);
  const CategoryIcon = isAuto ? GitCommit : CATEGORY_ICON[entry.category];
  return (
    <div className="surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/70">
      {/* Hairline top highlight to match the modern-panel family. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent"
      />
      <div className="relative p-4 sm:p-5 space-y-4">
        {/* Top row: date + version + category badge + optional files-changed
            chip + optional auto pill */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {/* Minute-precision absolute timestamp + a strict relative pill
              ("13 hours ago", no fuzzy "about" prefix). The old
              day-precision `formatDate` here lost too much fidelity for
              freshly-shipped commits — two cards from the same morning
              looked identical even when they were hours apart. */}
          <span
            className="font-medium text-muted-foreground"
            title={formatRelativeStrict(entry.publishedAt)}
          >
            {formatDateTime(entry.publishedAt)}
          </span>
          <span className="rounded-md border border-border/60 bg-muted/30 px-2 py-0.5 text-[11px] text-muted-foreground">
            {formatRelativeStrict(entry.publishedAt)}
          </span>
          {entry.version && (
            <span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
              {isAuto ? (
                <GitCommit className="size-3" />
              ) : (
                <Tag className="size-3" />
              )}
              {entry.version}
            </span>
          )}
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider",
              CATEGORY_BADGE_CLASS[entry.category],
            )}
          >
            <CategoryIcon className="size-3" />
            {CATEGORY_LABEL[entry.category]}
          </span>
          {isAuto && typeof entry.filesChanged === "number" &&
            entry.filesChanged > 0 && (
              <span
                className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-2 py-0.5 text-[11px] text-muted-foreground"
                title={`${entry.filesChanged} file${entry.filesChanged === 1 ? "" : "s"} changed in this commit`}
              >
                <FileText className="size-3" />
                {entry.filesChanged}{" "}
                {entry.filesChanged === 1 ? "file" : "files"}
              </span>
            )}
          {isAuto && (
            <span
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
              title="Auto-generated from a git commit. Not editable in the admin panel."
            >
              auto
            </span>
          )}
        </div>

        {/* Title + summary. ChangelogSummary handles the long-text
            collapse / "show more" disclosure client-side; short summaries
            render inline without the toggle. */}
        <div className="space-y-1.5">
          <h3 className="text-lg font-semibold tracking-tight">{entry.title}</h3>
          {entry.summary && <ChangelogSummary text={entry.summary} />}
        </div>

        {/* Bullets */}
        {entry.changes.length > 0 && (
          <ul className="space-y-1.5">
            {entry.changes.map((change, idx) => {
              const Icon = CHANGE_KIND_ICON[change.kind];
              return (
                <li
                  key={idx}
                  className="flex items-start gap-2 text-sm"
                >
                  <Icon
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      CHANGE_KIND_COLOR[change.kind],
                    )}
                  />
                  <span className="min-w-0 flex-1">{change.text}</span>
                </li>
              );
            })}
          </ul>
        )}

        {/* Footer: author + admin actions (only on DB-curated entries) */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-3 text-xs text-muted-foreground">
          <span>
            {entry.author.username
              ? <>by <span className="font-medium text-foreground">{entry.author.username}</span></>
              : "by (unknown admin)"}
          </span>
          {canManage && !isAuto && (
            <div className="flex items-center gap-1">
              <EditChangelogEntryButton entry={entry} />
              <DeleteChangelogButton id={entry.id} title={entry.title} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
